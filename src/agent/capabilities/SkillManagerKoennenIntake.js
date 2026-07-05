'use strict';
// ─────────────────────────────────────────────────────────────
// SkillManagerKoennenIntake — skill acquisition threads into the
// Koennen maturation pipeline (v7.9.31, AP-1).
//
// Both forge callers — the autonomous capability-gap builder and
// the chat create-skill command — now persist their product as a
// PENDING CANDIDATE under koennenDir, the exact manifest shape the
// SkillCrystallizer writes, where it rehearses, earns promotion,
// and only then becomes a registered tool. Nothing forged installs
// straight into the live registry anymore.
//
// Prototype mixin for SkillManager plus one shared free function:
//   hasSkillOrCandidate(name)      coverage predicate — pending,
//                                  rehearsing and promoted count;
//                                  quarantined/discarded reopen
//   _candidateStatus(name)         manifest status probe
//   _candidateCollisionResponse()  name-collision rule at intake
//   _retireForGeneration(name)     archive a failed generation,
//                                  bump generation, reset stats
//   _installCandidateSkill(...)    the candidate installer
//   recordRehearsalOutcome(...)    the ONE rehearsal-bump vocabulary,
//                                  shared with the rehearsal activity
// ─────────────────────────────────────────────────────────────

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { safeJsonParse, atomicWriteFileSync } = require('../core/utils');
const { createLogger } = require('../core/Logger');

const _log = createLogger('SkillManager');

/**
 * The one shared vocabulary for "a rehearsal ran": bump the counter,
 * record the distinct-input hash (sha256/16, capped at 50 entries),
 * flip pending → rehearsing on the first run, persist atomically.
 * Lifted from the rehearsal activity so a user-driven run and an
 * autonomous rehearsal mature a candidate identically — no second
 * bump path may ever exist.
 * Returns { rehearsalCount, distinctInputs, status } or null.
 */
function recordRehearsalOutcome(manifestPath, input) {
  try {
    const fresh = safeJsonParse(fs.readFileSync(manifestPath, 'utf-8'), null, 'SkillManager');
    if (!fresh) return null;

    fresh.koennen = fresh.koennen || {};
    fresh.koennen.rehearsalCount = (fresh.koennen.rehearsalCount || 0) + 1;

    const inputHash = crypto.createHash('sha256')
      .update(JSON.stringify(input))
      .digest('hex')
      .slice(0, 16);
    if (!Array.isArray(fresh.koennen.rehearsedInputHashes)) {
      fresh.koennen.rehearsedInputHashes = [];
    }
    if (!fresh.koennen.rehearsedInputHashes.includes(inputHash)) {
      fresh.koennen.rehearsedInputHashes.push(inputHash);
      if (fresh.koennen.rehearsedInputHashes.length > 50) {
        fresh.koennen.rehearsedInputHashes = fresh.koennen.rehearsedInputHashes.slice(-50);
      }
    }

    if (fresh.status === 'pending' && fresh.koennen.rehearsalCount === 1) {
      fresh.status = 'rehearsing';
    }

    atomicWriteFileSync(manifestPath, JSON.stringify(fresh, null, 2), 'utf-8');
    return {
      rehearsalCount: fresh.koennen.rehearsalCount,
      distinctInputs: fresh.koennen.rehearsedInputHashes.length,
      status: fresh.status,
    };
  } catch (err) {
    _log.warn(`[KOENNEN] rehearsal outcome update failed: ${err.message}`);
    return null;
  }
}

const mixin = {
  /**
   * Coverage predicate: a capability counts as covered when a skill is
   * loaded under that name OR a candidate for it is maturing
   * (pending | rehearsing | promoted). Quarantined and discarded do NOT
   * cover — those names reopen through the generation path.
   */
  hasSkillOrCandidate(name) {
    if (!name) return false;
    if (this.loadedSkills.has(name)) return true;
    const status = this._candidateStatus(name);
    return status === 'pending' || status === 'rehearsing' || status === 'promoted';
  },

  /** Read a candidate manifest's status by name; null when absent. @private */
  _candidateStatus(name) {
    if (!this.koennenDir || !name) return null;
    try {
      const manifestPath = path.join(this.koennenDir, name, 'skill-manifest.json');
      if (!fs.existsSync(manifestPath)) return null;
      const m = safeJsonParse(fs.readFileSync(manifestPath, 'utf-8'), null, 'SkillManager');
      return m ? (m.status || 'pending') : null;
    } catch { return null; }
  },

  /**
   * Name-collision rule at intake. Returns a user-facing message when the
   * name is already taken (no rebuild), or null when the forge may proceed.
   * pending|rehearsing → point at the maturing candidate; promoted or
   * loaded → point at the existing tool; quarantined|discarded → archive
   * the failed generation (stats reset) and let the forge proceed.
   * @private
   */
  _candidateCollisionResponse(name) {
    if (!name) return null;
    if (this.loadedSkills.has(name)) {
      return `✅ Skill "${name}" already exists as a registered tool — no rebuild needed. Run it with \`/run-skill ${name}\`.`;
    }
    const status = this._candidateStatus(name);
    if (status === 'pending' || status === 'rehearsing') {
      return `✅ Skill "${name}" is already maturing as a candidate. Run it with \`/run-skill ${name}\` — each run counts toward promotion. \`/skills-pending\` shows its progress.`;
    }
    if (status === 'promoted') {
      return `✅ Skill "${name}" is already promoted. Run it with \`/run-skill ${name}\`.`;
    }
    if (status === 'quarantined' || status === 'discarded') {
      this._retireForGeneration(name); // archive + stats reset; forge proceeds
    }
    return null;
  },

  /**
   * Generation path: archive the failed generation's directory as
   * <name>.retired.<timestamp> (history is kept), remember the next
   * generation number for the rebuild, and reset the effectiveness stats
   * so the new generation starts statistically unburdened — the lesson
   * against hasty rebuilding lives in the daemon lockout, not the stats.
   * Returns the generation number the NEW candidate must carry.
   * @private
   */
  _retireForGeneration(name) {
    let nextGeneration = 1;
    try {
      const dir = path.join(this.koennenDir, name);
      const manifestPath = path.join(dir, 'skill-manifest.json');
      if (fs.existsSync(manifestPath)) {
        const m = safeJsonParse(fs.readFileSync(manifestPath, 'utf-8'), null, 'SkillManager');
        nextGeneration = ((m && m.koennen && m.koennen.generation) || 1) + 1;
      }
      if (fs.existsSync(dir)) {
        fs.renameSync(dir, path.join(this.koennenDir, `${name}.retired.${Date.now()}`));
      }
      if (this.effectivenessTracker && typeof this.effectivenessTracker.forget === 'function') {
        this.effectivenessTracker.forget(name);
      }
      if (!this._pendingGeneration) this._pendingGeneration = new Map();
      this._pendingGeneration.set(name, nextGeneration);
    } catch (err) {
      _log.warn(`[KOENNEN] generation retire failed for ${name}: ${err.message}`);
    }
    return nextGeneration;
  },

  /**
   * Candidate installer: persist the forged skill as a PENDING candidate
   * under koennenDir, mirroring the SkillCrystallizer's manifest shape
   * exactly — koennen.crystallizedAt MUST be written (seven consumers key
   * on it; a missing field reads as decades old to the promotion age
   * criterion and sorts permanently first in the rehearsal queue) — plus
   * the two intake fields: koennen.origin (routing: 'daemon-gap' |
   * 'user-slash') and koennen.generation. acquisitionContext stays a
   * first-person biography: the lister quotes it verbatim and core
   * memories record it on promotion, so it must read as lived history,
   * never as a routing token. Does NOT load the skill into the registry;
   * fires skill:candidate-created.
   * @private
   */
  _installCandidateSkill(manifest, skillCode, skillName, { origin, description, attempts }) {
    if (!this.koennenDir) {
      return { ok: false, lastError: 'koennenDir is not configured — cannot persist a candidate', lastCode: skillCode };
    }

    const collision = this._candidateCollisionResponse(skillName);
    if (collision) return { ok: true, skillName, message: collision };

    const safeEntry = path.basename(manifest.entry || 'index.js');
    const skillDir = path.join(this.koennenDir, skillName);
    const manifestPath = path.join(skillDir, 'skill-manifest.json');
    const codePath = path.join(skillDir, safeEntry);

    // Path containment against koennenDir — same rule the live installer used.
    const koennenResolved = path.resolve(this.koennenDir);
    if (!path.resolve(manifestPath).startsWith(koennenResolved + path.sep)
      || !path.resolve(codePath).startsWith(koennenResolved + path.sep)) {
      return { ok: false, lastError: `path traversal blocked: ${skillName}`, lastCode: skillCode };
    }
    if (this.guard) {
      try {
        this.guard.validateWrite(manifestPath);
        this.guard.validateWrite(codePath);
      } catch (err) {
        return { ok: false, lastError: `SafeGuard blocked: ${err.message}`, lastCode: skillCode };
      }
    }

    const generation = (this._pendingGeneration && this._pendingGeneration.get(skillName)) || 1;
    if (this._pendingGeneration) this._pendingGeneration.delete(skillName);

    const note = String(description || '').replace(/\s+/g, ' ').trim().slice(0, 140);
    const biography = origin === 'user-slash'
      ? `I created this on direct request: ${note}`
      : `I built this autonomously to close a capability gap: ${note}`;

    const enrichedManifest = {
      ...manifest,
      status: 'pending',
      koennen: {
        crystallizedAt: Date.now(),
        sourceCandidateIds: [],
        patternSignature: null,
        acquisitionContext: biography,
        origin: origin === 'user-slash' ? 'user-slash' : 'daemon-gap',
        generation,
        rehearsalCount: 0,
        rehearsedInputHashes: [],
        promotedAt: null,
        discardedAt: null,
        discardedReason: null,
      },
    };

    try {
      fs.mkdirSync(skillDir, { recursive: true });
      atomicWriteFileSync(manifestPath, JSON.stringify(enrichedManifest, null, 2), 'utf-8');
      atomicWriteFileSync(codePath, skillCode, 'utf-8');
    } catch (err) {
      return { ok: false, lastError: `candidate write failed: ${err.message}`, lastCode: skillCode };
    }

    this.bus?.fire?.('skill:candidate-created', {
      skillName,
      origin: enrichedManifest.koennen.origin,
      generation,
    }, { source: 'SkillManager' });

    const attemptNote = attempts > 1 ? `\n**Attempts:** ${attempts}` : '';
    const genNote = generation > 1 ? ` (generation ${generation})` : '';
    return {
      ok: true,
      skillName,
      message: `✅ Skill "${skillName}" created as a maturing candidate${genNote}.\n\n**Description:** ${manifest.description}${attemptNote}\n\nIt is usable right away — \`/run-skill ${skillName}\` executes it, and every run counts toward promotion. \`/skills-pending\` shows its maturation state.`,
    };
  },

  /** Thin method wrapper over the shared rehearsal-outcome vocabulary. */
  recordRehearsalOutcome(manifestPath, input) {
    return recordRehearsalOutcome(manifestPath, input);
  },
};

module.exports = { mixin, recordRehearsalOutcome };
