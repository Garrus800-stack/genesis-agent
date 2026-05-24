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
    // Previously, cfg.level=0 was falsy → fell back to default.
    // v7.9.7: default is AUTONOMOUS (was ASSISTED, now removed).
    this._level = TrustLevelSystem._migrateLevel(cfg.level ?? TRUST_LEVELS.AUTONOMOUS);
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
   *
   *   Old 0 SUPERVISED → New 0 SUPERVISED       (unchanged)
   *   Old 1 ASSISTED   → New 1 AUTONOMOUS       (slightly more autonomy)
   *   Old 2 AUTONOMOUS → New 1 AUTONOMOUS       (same behaviour, new index)
   *   Old 3 FULL       → New 2 FULL_AUTONOMY   (same behaviour, new index)
   *
   * Values already in 0..2 pass through. Invalid values clamp to AUTONOMOUS.
   *
   * @param {number} level
   * @returns {number} migrated level in 0..2
   */
  static _migrateLevel(level) {
    if (typeof level !== 'number' || !Number.isFinite(level)) return TRUST_LEVELS.AUTONOMOUS;
    if (level === 0) return TRUST_LEVELS.SUPERVISED;
    if (level === 1) return TRUST_LEVELS.AUTONOMOUS;       // was ASSISTED → AUTONOMOUS
    if (level === 2) return TRUST_LEVELS.AUTONOMOUS;       // was AUTONOMOUS → still AUTONOMOUS (new index)
    if (level === 3) return TRUST_LEVELS.FULL_AUTONOMY;    // was FULL → FULL (new index)
    // Out of range — clamp to safe default
    return TRUST_LEVELS.AUTONOMOUS;
  }

  async asyncLoad() {
    try {
      const saved = await this.storage?.readJSON('trust-level.json');
      if (saved) {
        const rawLevel = typeof saved.level === 'number' ? saved.level : TRUST_LEVELS.AUTONOMOUS;
        const migrated = TrustLevelSystem._migrateLevel(rawLevel);
        if (migrated !== rawLevel) {
          _log.info(`[TRUST-MIGRATION] stored level ${rawLevel} → ${migrated} (4-level system → 3-level)`);
        }
        this._level = migrated;
        this._actionOverrides = saved.overrides || {};
        this._pendingUpgrades = saved.pendingUpgrades || [];
      }
    } catch (_e) { _log.debug('[catch] use defaults:', _e.message); }

    // Also check Settings
    if (this.settings) {
      const settingsLevel = this.settings.get('trust.level');
      if (typeof settingsLevel === 'number') {
        this._level = TrustLevelSystem._migrateLevel(settingsLevel);
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
   * @param {number} level - 0-3
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
