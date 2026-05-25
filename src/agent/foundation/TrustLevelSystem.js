// ============================================================
// GENESIS — TrustLevelSystem.js (Phase 11 — Extended Agency)
//
// PROBLEM: CapabilityGuard is binary — allow or block.
// For increasing autonomy, Genesis needs graduated trust:
//
//   Level 0 — SUPERVISED
//     Everything needs user approval. Training wheels.
//
//   Level 1 — AUTONOMOUS
//     Everything auto-executes EXCEPT:
//     - Critical actions (deploy, external API, email)
//     The "ask only for critical" default.
//
//   Level 2 — FULL AUTONOMY
//     Everything auto-executes. Only hard safety invariants
//     (kernel integrity, hash-locked files) still block.
//     Requires explicit user opt-in + success rate >90%.
//
// v7.9.7: ASSISTED ("ask for risky") removed. The four-level system
// had two middle tiers that confused users — ASSISTED auto-approved
// only 'safe' while AUTONOMOUS auto-approved everything except
// 'critical'. Real-world usage showed users picking AUTONOMOUS to
// avoid constant approval prompts, making ASSISTED dead UX. Now
// three clear options: always ask / only critical / never ask.
//
// Trust can auto-upgrade: if MetaLearning shows >90% success
// rate for a specific action type over 50+ attempts, the system
// suggests promoting that action to the next trust level.
//
// Integration:
//   AgentLoop._executeStep()  → TrustLevelSystem.checkApproval()
//   CapabilityGuard.issueToken() → checks trust level
//   Settings → trust.level (persisted)
//   MetaLearning → trust auto-upgrade suggestions
// ============================================================

const { NullBus } = require('../core/EventBus');
const { createLogger } = require('../core/Logger');
const _log = createLogger('TrustLevelSystem');

const TRUST_LEVELS = Object.freeze({
  SUPERVISED: 0,
  AUTONOMOUS: 1,
  FULL_AUTONOMY: 2,
});

// ── Action risk classification ───────────────────────────
const ACTION_RISK = {
  // Safe actions (always auto-execute except at SUPERVISED)
  'ANALYZE':       'safe',
  'SEARCH':        'safe',
  'ASK_USER':      'safe',
  'read-file':     'safe',
  'read':          'safe',
  'list-files':    'safe',

  // Medium risk (auto-execute at AUTONOMOUS+)
  'CODE_GENERATE': 'medium',
  'WRITE_FILE':    'medium',
  'RUN_TESTS':     'medium',
  'GIT_SNAPSHOT':  'medium',
  'DELEGATE':      'medium',
  // AgentLoop step-limit gate. ApprovalGate.request('continue', …) fires
  // when a goal has reached its per-goal step limit and Genesis asks
  // whether to keep going. Classified as 'medium' so AUTONOMOUS+ auto-
  // approve the simple "keep going" decision.
  'continue':      'medium',

  // High risk (auto-execute at AUTONOMOUS+)
  'SHELL_EXEC':    'high',
  'SELF_MODIFY':   'high',

  // Critical (always needs approval, except at FULL_AUTONOMY)
  'DEPLOY':        'critical',
  'EXTERNAL_API':  'critical',
  'EMAIL_SEND':    'critical',

  // v7.9.3: Blocking — auto-approved at AUTONOMOUS+ now. Previously this
  // tier was excluded from every level (v7.7.8 design: "structural concerns
  // must always pause"), but that contradicted the UI promise that
  // FULL_AUTONOMY never asks and that AUTONOMOUS only asks for critical.
  // A structurally broken plan surfaces through execution failure anyway;
  // an extra approval modal at the supposedly-autonomous levels was a
  // UX bug, not a safeguard. SUPERVISED still gates it.
  'plan-has-issues': 'blocking',
};

// ── What each level auto-approves ────────────────────────
//
// v7.9.7: Three trust levels (ASSISTED removed — was redundant middle tier).
//   SUPERVISED    [] — every gated decision asks (only 'plan-has-issues',
//     'continue', and 'EXTERNAL_API' are actually gated in code today;
//     this is the level for "I watch every step")
//   AUTONOMOUS    ['safe', 'medium', 'high', 'blocking'] — only the three
//     real externally-consequential actions ask: DEPLOY, EXTERNAL_API,
//     EMAIL_SEND (the UI's definition of "critical")
//   FULL_AUTONOMY all five — never asks
const LEVEL_AUTO_APPROVE = {
  [TRUST_LEVELS.SUPERVISED]:    [],
  [TRUST_LEVELS.AUTONOMOUS]:    ['safe', 'medium', 'high', 'blocking'],
  [TRUST_LEVELS.FULL_AUTONOMY]: ['safe', 'medium', 'high', 'critical', 'blocking'],
};

const AUTO_UPGRADE_MIN_SAMPLES = 50;
const AUTO_UPGRADE_MIN_SUCCESS = 0.90;

class TrustLevelSystem {
  constructor({ bus, storage, settings, config }) {
    this.bus = bus || NullBus;
    this.storage = storage;
    this.settings = settings || null;
    this.metaLearning = null; // lateBinding

    const cfg = config || {};
    // FIX v7.0.8: Use ?? instead of || — level 0 (SUPERVISED) is valid.
    // v7.9.8: fresh installs default to SUPERVISED (was AUTONOMOUS).
    // v7.9.9 (A): cfg.level in the valid 3-level range (0..2) is trusted
    // as-is. _migrateLevel is for STORED 4-level values (asyncLoad path),
    // not for caller-supplied config — callers pass TRUST_LEVELS.* constants
    // which are already in the new system. Out-of-range / corrupt cfg.level
    // still routes through _migrateLevel (which clamps to SUPERVISED).
    const cfgLevel = cfg.level;
    if (typeof cfgLevel === 'number' && cfgLevel >= 0 && cfgLevel <= 2) {
      this._level = cfgLevel;
    } else if (cfgLevel === undefined || cfgLevel === null) {
      this._level = TRUST_LEVELS.SUPERVISED;
    } else {
      this._level = TrustLevelSystem._migrateLevel(cfgLevel);
    }
    this._actionOverrides = {}; // Per-action trust overrides

    // ── Upgrade suggestions (pending user confirmation) ──
    this._pendingUpgrades = [];

    // ── Audit log ────────────────────────────────────────
    this._auditLog = [];
    this._maxAuditEntries = 500;

    // ── Stats ────────────────────────────────────────────
    this._stats = {
      approvalChecks: 0,
      autoApproved: 0,
      userApproved: 0,
      blocked: 0,
      upgradesSuggested: 0,
      upgradesAccepted: 0,
    };
  }

  /**
   * v7.9.7: Migrate a stored 4-level trust value to the new 3-level system.
   * v7.9.9 (A): ASSISTED users move to SUPERVISED (was AUTONOMOUS in v7.9.7).
   * Re-bucketing toward the safer default — "ask for risky" no longer exists
   * as a level, so users who chose that explicitly now ask for everything,
   * not the opposite of what they wanted.
   *
   *   Old 0 SUPERVISED → New 0 SUPERVISED       (unchanged)
   *   Old 1 ASSISTED   → New 0 SUPERVISED       (v7.9.9: safer-default rebucket)
   *   Old 2 AUTONOMOUS → New 1 AUTONOMOUS       (same behaviour, new index)
   *   Old 3 FULL       → New 2 FULL_AUTONOMY    (same behaviour, new index)
   *
   * Values already in 0..2 pass through. Invalid/corrupt/out-of-range
   * values clamp to SUPERVISED (v7.9.8 — was AUTONOMOUS; SUPERVISED is
   * the safer default when the stored state is untrustworthy).
   *
   * @param {number} level
   * @returns {number} migrated level in 0..2
   */
  static _migrateLevel(level) {
    if (typeof level !== 'number' || !Number.isFinite(level)) return TRUST_LEVELS.SUPERVISED;
    if (level === 0) return TRUST_LEVELS.SUPERVISED;
    if (level === 1) return TRUST_LEVELS.SUPERVISED;       // v7.9.9 (A): was ASSISTED → SUPERVISED (safer rebucket)
    if (level === 2) return TRUST_LEVELS.AUTONOMOUS;       // was AUTONOMOUS → still AUTONOMOUS (new index)
    if (level === 3) return TRUST_LEVELS.FULL_AUTONOMY;    // was FULL → FULL (new index)
    // Out of range — clamp to safest default (v7.9.8)
    return TRUST_LEVELS.SUPERVISED;
  }

  async asyncLoad() {
    let storageHadSchema = false;
    let needsStorageWriteback = false;
    try {
      const saved = await this.storage?.readJSON('trust-level.json');
      if (saved) {
        // v7.9.8 NODOUBLE: if schemaVersion >= 3 the value was written by
        // a 3-level-system boot and must be trusted as-is. Migration would
        // re-translate the 2 (FULL_AUTONOMY in 3-level world) into 1
        // (AUTONOMOUS by the 4→3 mapping for old-AUTONOMOUS=2), silently
        // downgrading the user's setting on every subsequent boot.
        if (typeof saved.schemaVersion === 'number' && saved.schemaVersion >= 3) {
          if (typeof saved.level === 'number' && saved.level >= 0 && saved.level <= 2) {
            this._level = saved.level;
            storageHadSchema = true;
          } else {
            // schemaVersion claims 3-level but level is corrupt → SUPERVISED.
            this._level = TRUST_LEVELS.SUPERVISED;
            needsStorageWriteback = true;
            _log.warn(`[TRUST-MIGRATION] schemaVersion=${saved.schemaVersion} but level=${saved.level} is invalid; falling back to SUPERVISED`);
          }
        } else {
          // No schema marker → pre-v7.9.8 storage. Apply 4-to-3 migration.
          // v7.9.8: corrupt saved.level (not a number) → SUPERVISED.
          // The file exists but its level field is broken — safer to drop
          // back to ask-before-acting than assume the user's intent.
          const rawLevel = typeof saved.level === 'number' ? saved.level : TRUST_LEVELS.SUPERVISED;
          const migrated = TrustLevelSystem._migrateLevel(rawLevel);
          if (migrated !== rawLevel) {
            _log.info(`[TRUST-MIGRATION] stored level ${rawLevel} → ${migrated} (4-level system → 3-level)`);
          }
          this._level = migrated;
          // Always writeback so the schemaVersion marker is set, even if
          // the level itself didn't change — prevents re-migration loops.
          needsStorageWriteback = true;
        }
        this._actionOverrides = saved.overrides || {};
        this._pendingUpgrades = saved.pendingUpgrades || [];
      }
    } catch (_e) { _log.debug('[catch] use defaults:', _e.message); }

    // v7.9.8 Fix 1: persist storage-side migration once so the next boot
    // sees a clean value and doesn't re-migrate. Wrapped in try so a
    // write-failure (read-only fs, permission denied) never blocks boot.
    if (needsStorageWriteback) {
      try { await this._save(); }
      catch (_e) { _log.warn('[TRUST-MIGRATION] storage writeback failed:', _e.message); }
    }

    // Settings: only consulted as a secondary source. If storage already
    // had a schemaVersion=3 marker, that value is authoritative and
    // settings will be synced to match. Otherwise, settings can supply
    // (or migrate) the level if storage was empty/corrupt.
    if (this.settings) {
      const settingsLevel = this.settings.get('trust.level');
      if (typeof settingsLevel === 'number') {
        if (storageHadSchema) {
          // Storage wins (was already migrated). Settings sync to storage.
          if (settingsLevel !== this._level) {
            try { this.settings.set('trust.level', this._level); }
            catch (_e) { _log.warn('[TRUST-MIGRATION] settings sync to storage failed:', _e.message); }
          }
        } else {
          // No schemaVersion on storage side → settings can still inform/
          // override the level (preserves pre-v7.9.8 behaviour where
          // settings was the dominant source).
          const migrated = TrustLevelSystem._migrateLevel(settingsLevel);
          this._level = migrated;
          if (migrated !== settingsLevel) {
            try { this.settings.set('trust.level', migrated); }
            catch (_e) { _log.warn('[TRUST-MIGRATION] settings writeback failed:', _e.message); }
            // Re-save storage so the migrated value + schemaVersion are
            // persisted on the storage side too.
            try { await this._save(); }
            catch (_e) { _log.warn('[TRUST-MIGRATION] post-settings storage writeback failed:', _e.message); }
          }
        }
      }
    }
  }

  // ════════════════════════════════════════════════════════
  // PUBLIC API
  // ════════════════════════════════════════════════════════

  /**
   * Check if an action needs user approval.
   *
   * @param {string} actionType - FormalPlanner action type
   * @param {object} context - { description, risk, goalId }
   * @returns {{ approved: boolean, reason: string, needsUserApproval: boolean }}
   */
  checkApproval(actionType, context = {}) {
    this._stats.approvalChecks++;

    const risk = this._getActionRisk(actionType);
    const level = this._level;
    const autoApproveRisks = LEVEL_AUTO_APPROVE[level] || [];
    const isAutoApproved = autoApproveRisks.includes(risk);

    // Check per-action overrides
    const override = this._actionOverrides[actionType];
    if (override !== undefined) {
      const overrideApproved = override <= level;
      this._audit(actionType, risk, overrideApproved ? 'auto (override)' : 'needs-approval (override)');
      if (overrideApproved) this._stats.autoApproved++;
      return {
        approved: overrideApproved,
        reason: overrideApproved
          ? `Action "${actionType}" auto-approved (override at level ${override})`
          : `Action "${actionType}" needs approval (override requires level ${override}, current: ${level})`,
        needsUserApproval: !overrideApproved,
      };
    }

    this._audit(actionType, risk, isAutoApproved ? 'auto' : 'needs-approval');

    if (isAutoApproved) {
      this._stats.autoApproved++;
      return {
        approved: true,
        reason: `Action "${actionType}" (${risk} risk) auto-approved at trust level ${level}`,
        needsUserApproval: false,
      };
    }

    return {
      approved: false,
      reason: `Action "${actionType}" (${risk} risk) needs user approval at trust level ${level}`,
      needsUserApproval: true,
    };
  }

  /**
   * Get current trust level.
   */
  getLevel() { return this._level; }

  /**
   * Set trust level (user action).
   * @param {number} level - 0-2 (SUPERVISED, AUTONOMOUS, FULL_AUTONOMY)
   */
  async setLevel(level) {
    if (level < 0 || level > 2) throw new Error(`Invalid trust level: ${level} (valid range: 0..2)`);
    const prev = this._level;
    this._level = level;
    await this._save();

    this.bus.fire('trust:level-changed', { from: prev, to: level }, { source: 'TrustLevelSystem' });
    return { from: prev, to: level };
  }

  /**
   * Check MetaLearning data for auto-upgrade candidates.
   * Call periodically (e.g., after MetaLearning recalculates).
   * @returns {Array} upgrade suggestions
   */
  checkAutoUpgrades() {
    if (!this.metaLearning) return [];

    const suggestions = [];

    for (const [actionType, risk] of Object.entries(ACTION_RISK)) {
      // Only suggest upgrades for actions that currently need approval
      const autoApproveRisks = LEVEL_AUTO_APPROVE[this._level] || [];
      if (autoApproveRisks.includes(risk)) continue;

      // Check MetaLearning success rate
      const stats = this.metaLearning.getActionTypeStats?.(actionType);
      if (!stats || stats.total < AUTO_UPGRADE_MIN_SAMPLES) continue;

      const successRate = stats.success / stats.total;
      if (successRate >= AUTO_UPGRADE_MIN_SUCCESS) {
        const suggestion = {
          actionType,
          currentRisk: risk,
          successRate: Math.round(successRate * 100),
          samples: stats.total,
          suggestedLevel: this._level, // Override to current level
          timestamp: Date.now(),
        };

        // Avoid duplicate suggestions
        if (!this._pendingUpgrades.find(u => u.actionType === actionType)) {
          this._pendingUpgrades.push(suggestion);
          suggestions.push(suggestion);
          this._stats.upgradesSuggested++;
        }
      }
    }

    if (suggestions.length > 0) {
      this.bus.fire('trust:upgrades-available', {
        count: suggestions.length,
        actions: suggestions.map(s => s.actionType),
      }, { source: 'TrustLevelSystem' });
    }

    return suggestions;
  }

  /**
   * Accept an auto-upgrade suggestion.
   * @param {string} actionType
   */
  async acceptUpgrade(actionType) {
    const idx = this._pendingUpgrades.findIndex(u => u.actionType === actionType);
    if (idx === -1) return false;

    const upgrade = this._pendingUpgrades[idx];
    this._actionOverrides[actionType] = this._level;
    this._pendingUpgrades.splice(idx, 1);
    this._stats.upgradesAccepted++;

    await this._save();

    this.bus.fire('trust:upgrade-accepted', {
      actionType,
      newLevel: this._level,
    }, { source: 'TrustLevelSystem' });

    return true;
  }

  /**
   * Get pending upgrade suggestions.
   */
  getPendingUpgrades() { return [...this._pendingUpgrades]; }

  /**
   * Get full trust status for UI.
   */
  getStatus() {
    return {
      level: this._level,
      levelName: Object.entries(TRUST_LEVELS).find(([, v]) => v === this._level)?.[0] || 'UNKNOWN',
      autoApproves: LEVEL_AUTO_APPROVE[this._level] || [],
      overrides: { ...this._actionOverrides },
      pendingUpgrades: this._pendingUpgrades.length,
      stats: { ...this._stats },
    };
  }

  getStats() { return { ...this._stats }; }

  // ════════════════════════════════════════════════════════
  // INTERNAL
  // ════════════════════════════════════════════════════════

  _getActionRisk(actionType) {
    return ACTION_RISK[actionType] || 'high'; // Unknown actions are high risk
  }

  _audit(actionType, risk, decision) {
    this._auditLog.push({
      actionType, risk, decision, level: this._level, timestamp: Date.now(),
    });
    if (this._auditLog.length > this._maxAuditEntries) {
      this._auditLog = this._auditLog.slice(-this._maxAuditEntries);
    }
  }

  async _save() {
    try {
      await this.storage?.writeJSON('trust-level.json', {
        // v7.9.8 Fix 1 + NODOUBLE-protection: schemaVersion: 3 marker so
        // subsequent boots can distinguish "already-migrated 3-level value"
        // from "raw 4-level value still needing migration". Without this
        // marker, a stored level=2 is ambiguous (could be old-AUTONOMOUS=2
        // wanting migration to new-1, or new-FULL_AUTONOMY=2 wanting to
        // stay put). Garrus' Win-trace symptom — FULL stays as FULL after
        // first boot then quietly drops to AUTONOMOUS on every subsequent
        // boot — came from re-migrating a 2 that was already in the new
        // schema.
        schemaVersion: 3,
        level: this._level,
        overrides: this._actionOverrides,
        pendingUpgrades: this._pendingUpgrades,
      });
    } catch (err) {
      _log.warn('[TRUST] Save failed:', err.message);
    }
  }
}

module.exports = { TrustLevelSystem, TRUST_LEVELS, ACTION_RISK };
