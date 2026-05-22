// @ts-check
// ============================================================
// GENESIS — SkillPromotionEvaluator.js
// v7.9.4 Phase 3 — Können promotion / quarantine / discard-suggestion
//
// PURPOSE:
//   Reads pending and rehearsing Können skills from .genesis/koennen/skills-pending/,
//   evaluates each against four conjunctive promotion criteria, the Wilson-LB
//   quarantine threshold, and the languishing-skill discard-suggestion heuristic.
//
// PROMOTION CRITERIA (all four required):
//   • rehearsalCount      ≥ cognitive.koennen.promotion.minInvocations    (default 8)
//   • wilsonLB            ≥ cognitive.koennen.promotion.minWilsonLB       (default 0.70)
//   • distinctInputCount  ≥ cognitive.koennen.promotion.minDistinctInputs (default 3)
//   • ageMs               ≥ cognitive.koennen.promotion.minAgeMs          (default 48h)
//
// Trust-Level is NOT a promotion criterion. Promotion is an internal
// reflective act — the skill's outward use is gated separately at the
// agent-loop level. Blocking promotion on trust-level would prevent
// Genesis from maturing his own skills under SUPERVISED mode while
// providing no real safety benefit.
//
// QUARANTINE: wilsonLB < 0.30 AND total ≥ 5
//
// DISCARD-SUGGESTION: age ≥ 14 days, rehearsalCount < 3, wilsonLB in [0.30, 0.70].
// Rate-limited to one suggestion per evaluate() call so we don't flood the
// dashboard when many skills age at once.
//
// PIPELINE:
//   _loadAllSkillsByStatus(['pending', 'rehearsing'])
//     → for each: check promotion → check quarantine → check discard-suggest
//     → fire skill:promoted (+selfnarrative:skill-acquired) per promotion
//     → fire skill:quarantined per quarantine
//     → fire skill:discard-suggested per suggestion (capped at 1)
//     → if any promotions: skillManager.loadSkills() + toolRegistry.refreshSkills()
//
// INTEGRATION:
//   DreamCycle.js runs this as a phase after _dreamPhaseCrystallize.
//   Manifest-driven via phase9-cognitive-koennen.js.
// ============================================================

'use strict';

const fs = require('fs');
const path = require('path');
const { NullBus } = require('../core/EventBus');
const { atomicWriteFileSync, safeJsonParse } = require('../core/utils');
const { createLogger } = require('../core/Logger');
const _log = createLogger('SkillPromotionEvaluator');

const DEFAULTS = Object.freeze({
  minInvocations:             8,
  minWilsonLB:                0.70,
  minDistinctInputs:          3,
  minAgeMs:                   48 * 60 * 60 * 1000,
  quarantineThreshold:        0.30,
  quarantineMinTotal:         5,
  discardSuggestionAfterDays: 14,
  discardSuggestionMaxRehearsals: 3,
});

class SkillPromotionEvaluator {
  /**
   * @param {{
   *   bus?: any,
   *   genesisDir?: string,
   *   skillManager?: any,
   *   effectivenessTracker?: any,
   *   toolRegistry?: any,
   *   settings?: any,
   *   clock?: () => number,
   * }} deps
   */
  constructor({ bus, genesisDir, settings, clock } = {}) {
    this.bus = bus || NullBus;
    this._genesisDir = genesisDir || '.genesis';
    this.settings = settings || null;
    this._clock = clock || (() => Date.now());

    // Late-bound via DI in phase9-cognitive-koennen.js
    this.skillManager = null;
    this.effectivenessTracker = null;
    this.toolRegistry = null;

    this._stats = {
      runs: 0,
      promoted: 0,
      quarantined: 0,
      discardSuggested: 0,
    };
  }

  /** No subscriptions, no intervals, no shutdown work needed. */

  /**
   * Run one evaluation pass over all pending and rehearsing skills.
   * Called by DreamCycle.
   *
   * @returns {Promise<{
   *   skipped?: string,
   *   results?: { promoted: string[], quarantined: string[], discardSuggested: string[] }
   * }>}
   */
  async evaluate() {
    this._stats.runs++;
    if (!this._isEnabled()) return { skipped: 'disabled' };
    if (!this.skillManager) return { skipped: 'no-skill-manager' };
    if (!this.effectivenessTracker) return { skipped: 'no-tracker' };

    const koennenDir = this.skillManager.koennenDir;
    if (!koennenDir) return { skipped: 'no-koennen-dir' };
    if (!fs.existsSync(koennenDir)) return { results: { promoted: [], quarantined: [], discardSuggested: [] } };

    const skills = this._loadAllSkillsByStatus(koennenDir, ['pending', 'rehearsing']);
    if (skills.length === 0) {
      return { results: { promoted: [], quarantined: [], discardSuggested: [] } };
    }

    const now = this._clock();
    const promoted = [];
    const quarantined = [];
    const discardSuggested = [];

    for (const skill of skills) {
      // 1. Check promotion
      const promCheck = this._isPromotable(skill, now);
      if (promCheck.ok) {
        this._setStatus(skill, 'promoted', { promotedAt: now });
        const wilsonLB = this.effectivenessTracker.getWilsonLB(skill.name);
        const stats = this.effectivenessTracker.getStats(skill.name) || {};
        this.bus.fire('skill:promoted', {
          skillName: skill.name,
          wilsonLB,
          rehearsalCount: skill.koennen.rehearsalCount || 0,
        }, { source: 'SkillPromotionEvaluator' });
        this.bus.fire('selfnarrative:skill-acquired', {
          skillName: skill.name,
          acquisitionContext: skill.koennen.acquisitionContext || null,
          description: skill.description || '',
        }, { source: 'SkillPromotionEvaluator' });
        promoted.push(skill.name);
        this._stats.promoted++;
        continue;
      }

      // 2. Check quarantine
      if (this._shouldQuarantine(skill)) {
        this._setStatus(skill, 'quarantined');
        const wilsonLB = this.effectivenessTracker.getWilsonLB(skill.name);
        this.bus.fire('skill:quarantined', {
          skillName: skill.name,
          reason: 'wilson-below-threshold',
          details: [`wilsonLB=${wilsonLB.toFixed(2)}`],
        }, { source: 'SkillPromotionEvaluator' });
        quarantined.push(skill.name);
        this._stats.quarantined++;
        continue;
      }

      // 3. Check discard-suggestion (rate-limited)
      if (discardSuggested.length === 0 && this._shouldSuggestDiscard(skill, now)) {
        const ageDays = Math.floor((now - (skill.koennen.crystallizedAt || now)) / (24 * 60 * 60 * 1000));
        const wilsonLB = this.effectivenessTracker.getWilsonLB(skill.name);
        this.bus.fire('skill:discard-suggested', {
          skillName: skill.name,
          reason: 'languishing',
          ageDays,
          rehearsalCount: skill.koennen.rehearsalCount || 0,
          wilsonLB,
        }, { source: 'SkillPromotionEvaluator' });
        discardSuggested.push(skill.name);
        this._stats.discardSuggested++;
      }
    }

    // After promotions: reload SkillManager so promoted skills move into
    // loadedSkills, and refresh ToolRegistry so they're callable as tools.
    if (promoted.length > 0) {
      try {
        this.skillManager.loadSkills();
      } catch (err) {
        _log.warn(`[PROMOTE] loadSkills failed: ${err.message}`);
      }
      if (this.toolRegistry && typeof this.toolRegistry.refreshSkills === 'function') {
        try {
          this.toolRegistry.refreshSkills(this.skillManager);
        } catch (err) {
          _log.warn(`[PROMOTE] toolRegistry.refreshSkills failed: ${err.message}`);
        }
      }
      this.bus.fire('skills:reloaded', {}, { source: 'SkillPromotionEvaluator' });
    }

    return { results: { promoted, quarantined, discardSuggested } };
  }

  getStats() { return { ...this._stats }; }

  // ── Promotion checks ─────────────────────────────────────────

  /**
   * Check all four promotion criteria. Returns { ok: true } if all pass,
   * or { ok: false, reason, need, have } if any fail.
   *
   * @private
   */
  _isPromotable(skill, now) {
    const cfg = this._getCfg();

    const stats = this.effectivenessTracker.getStats(skill.name);
    if (!stats) {
      return { ok: false, reason: 'not-tracked' };
    }

    if (stats.total < cfg.minInvocations) {
      return { ok: false, reason: 'too-few-invocations', need: cfg.minInvocations, have: stats.total };
    }

    if (stats.wilsonLB < cfg.minWilsonLB) {
      return { ok: false, reason: 'wilson-too-low', need: cfg.minWilsonLB, have: stats.wilsonLB };
    }

    const distinctCount = new Set(skill.koennen.rehearsedInputHashes || []).size;
    if (distinctCount < cfg.minDistinctInputs) {
      return { ok: false, reason: 'too-few-distinct-inputs', need: cfg.minDistinctInputs, have: distinctCount };
    }

    const ageMs = now - (skill.koennen.crystallizedAt || 0);
    if (ageMs < cfg.minAgeMs) {
      return { ok: false, reason: 'too-young', need: cfg.minAgeMs, have: ageMs };
    }

    return { ok: true };
  }

  /**
   * Quarantine: wilsonLB below threshold with enough evidence.
   *
   * @private
   */
  _shouldQuarantine(skill) {
    const cfg = this._getCfg();
    const stats = this.effectivenessTracker.getStats(skill.name);
    if (!stats) return false;
    if (stats.total < cfg.quarantineMinTotal) return false;
    return stats.wilsonLB < cfg.quarantineThreshold;
  }

  /**
   * Discard suggestion: old, rarely rehearsed, ambiguous Wilson-LB.
   * "Languishing" skill that isn't getting attention and isn't clearly
   * good or bad — Genesis (or user) should decide explicitly.
   *
   * @private
   */
  _shouldSuggestDiscard(skill, now) {
    const cfg = this._getCfg();
    const ageMs = now - (skill.koennen.crystallizedAt || 0);
    if (ageMs < cfg.discardSuggestionAfterDays * 24 * 60 * 60 * 1000) return false;

    const stats = this.effectivenessTracker.getStats(skill.name);
    const rehearsals = stats?.total ?? 0;
    if (rehearsals >= cfg.discardSuggestionMaxRehearsals) return false;

    const wilsonLB = stats?.wilsonLB ?? 0.5;
    if (wilsonLB >= cfg.minWilsonLB) return false;          // good enough to wait
    if (wilsonLB < cfg.quarantineThreshold) return false;   // will be quarantined first

    return true;
  }

  // ── Manifest I/O ─────────────────────────────────────────────

  /**
   * Load all skill manifests from koennenDir whose status is in statusFilter.
   *
   * @param {string} koennenDir
   * @param {string[]} statusFilter
   * @returns {Array<{name: string, dir: string, status: string, koennen: object, description: string}>}
   * @private
   */
  _loadAllSkillsByStatus(koennenDir, statusFilter) {
    const out = [];
    let entries;
    try {
      entries = fs.readdirSync(koennenDir, { withFileTypes: true });
    } catch {
      return out;
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const skillDir = path.join(koennenDir, entry.name);
      const manifestPath = path.join(skillDir, 'skill-manifest.json');
      if (!fs.existsSync(manifestPath)) continue;

      try {
        const raw = fs.readFileSync(manifestPath, 'utf-8');
        const manifest = safeJsonParse(raw, null, 'SkillPromotionEvaluator');
        if (!manifest) continue;

        // v7.9.4: legacy manifest migration. Older skills (from v7.9.0
        // through v7.9.3) lack status/rehearsalCount/etc. Add them with
        // defaults so they participate normally going forward.
        const migrated = this._migrateLegacyManifest(manifest);
        if (migrated) {
          atomicWriteFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf-8');
        }

        if (!statusFilter.includes(manifest.status)) continue;

        out.push({
          name: manifest.name,
          dir: skillDir,
          status: manifest.status,
          description: manifest.description || '',
          koennen: manifest.koennen || {},
          manifestPath,
          manifest,
        });
      } catch (err) {
        _log.warn(`[PROMOTE] failed to load manifest in ${skillDir}: ${err.message}`);
      }
    }

    return out;
  }

  /**
   * v7.9.4: idempotent migration of legacy pending manifests.
   * Returns true if the manifest was modified.
   *
   * @private
   */
  _migrateLegacyManifest(manifest) {
    let changed = false;
    if (!manifest.status) {
      manifest.status = 'pending';
      changed = true;
    }
    if (!manifest.koennen) {
      manifest.koennen = {};
      changed = true;
    }
    if (manifest.koennen.rehearsalCount === undefined) {
      manifest.koennen.rehearsalCount = 0;
      changed = true;
    }
    if (!Array.isArray(manifest.koennen.rehearsedInputHashes)) {
      manifest.koennen.rehearsedInputHashes = [];
      changed = true;
    }
    if (manifest.koennen.acquisitionContext === undefined) {
      manifest.koennen.acquisitionContext = null;  // legacy = no biography
      changed = true;
    }
    if (manifest.koennen.promotedAt === undefined) {
      manifest.koennen.promotedAt = null;
      changed = true;
    }
    if (manifest.koennen.discardedAt === undefined) {
      manifest.koennen.discardedAt = null;
      changed = true;
    }
    if (manifest.koennen.discardedReason === undefined) {
      manifest.koennen.discardedReason = null;
      changed = true;
    }
    if (!manifest.koennen.crystallizedAt) {
      manifest.koennen.crystallizedAt = Date.now();  // best effort for very old
      changed = true;
    }
    return changed;
  }

  /**
   * Atomically update a skill's manifest with new status + optional fields.
   *
   * @private
   */
  _setStatus(skill, newStatus, extraKoennenFields = {}) {
    skill.manifest.status = newStatus;
    skill.manifest.koennen = { ...skill.manifest.koennen, ...extraKoennenFields };
    try {
      atomicWriteFileSync(skill.manifestPath, JSON.stringify(skill.manifest, null, 2), 'utf-8');
    } catch (err) {
      _log.warn(`[PROMOTE] _setStatus write failed for ${skill.name}: ${err.message}`);
    }
  }

  // ── Settings helpers ─────────────────────────────────────────

  _isEnabled() {
    return this._setting('cognitive.koennen.enabled', true)
        && this._setting('cognitive.koennen.promotion.enabled', true);
  }

  _setting(p, fallback) {
    if (!this.settings || typeof this.settings.get !== 'function') return fallback;
    try {
      const v = this.settings.get(p);
      return v == null ? fallback : v;
    } catch {
      return fallback;
    }
  }

  _getCfg() {
    return {
      minInvocations:                  this._setting('cognitive.koennen.promotion.minInvocations',    DEFAULTS.minInvocations),
      minWilsonLB:                     this._setting('cognitive.koennen.promotion.minWilsonLB',       DEFAULTS.minWilsonLB),
      minDistinctInputs:               this._setting('cognitive.koennen.promotion.minDistinctInputs', DEFAULTS.minDistinctInputs),
      minAgeMs:                        this._setting('cognitive.koennen.promotion.minAgeMs',          DEFAULTS.minAgeMs),
      quarantineThreshold:             DEFAULTS.quarantineThreshold,
      quarantineMinTotal:              DEFAULTS.quarantineMinTotal,
      discardSuggestionAfterDays:      this._setting('cognitive.koennen.promotion.discardSuggestionAfterDays', DEFAULTS.discardSuggestionAfterDays),
      discardSuggestionMaxRehearsals:  DEFAULTS.discardSuggestionMaxRehearsals,
    };
  }
}

module.exports = { SkillPromotionEvaluator, DEFAULTS };
