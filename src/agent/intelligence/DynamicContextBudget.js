// @ts-checked-v5.6
// ============================================================
// GENESIS — DynamicContextBudget.js (Phase 10 — Persistent Agency)
//
// PROBLEM: ContextManager uses fixed token budgets:
//   system: 800, memory: 600, code: 2500, conversation: 1500
// But a code-gen task needs 90% code context and almost no
// conversation. A chat needs the opposite. Fixed budgets
// waste tokens on irrelevant context.
//
// SOLUTION: Intent-based budget profiles that adapt the
// allocation per task type. MetaLearning feedback adjusts
// profiles over time (which allocation leads to success).
//
// Integration:
//   ContextManager.build()  → asks DynamicContextBudget for profile
//   MetaLearning.record()   → DynamicContextBudget learns
//   IntentRouter.classify() → provides intent for profile selection
// ============================================================

const { NullBus } = require('../core/EventBus');
const { createLogger } = require('../core/Logger');
const _log = createLogger('DynamicContextBudget');

// ── Default profiles (proportional weights, normalized to totalBudget) ──
const DEFAULT_PROFILES = {
  'code-gen': {
    system: 0.10, memory: 0.05, code: 0.55, conversation: 0.15, tools: 0.05, selfNarrative: 0.05, reserved: 0.05,
  },
  'self-modify': {
    system: 0.10, memory: 0.05, code: 0.55, conversation: 0.10, tools: 0.05, selfNarrative: 0.10, reserved: 0.05,
  },
  'analysis': {
    system: 0.10, memory: 0.10, code: 0.40, conversation: 0.20, tools: 0.05, selfNarrative: 0.05, reserved: 0.10,
  },
  'chat': {
    system: 0.12, memory: 0.15, code: 0.10, conversation: 0.40, tools: 0.05, selfNarrative: 0.08, reserved: 0.10,
  },
  'planning': {
    system: 0.10, memory: 0.15, code: 0.20, conversation: 0.20, tools: 0.10, selfNarrative: 0.10, reserved: 0.15,
  },
  'reasoning': {
    system: 0.10, memory: 0.15, code: 0.25, conversation: 0.25, tools: 0.10, selfNarrative: 0.05, reserved: 0.10,
  },
  'research': {
    system: 0.10, memory: 0.10, code: 0.10, conversation: 0.20, tools: 0.15, selfNarrative: 0.05, reserved: 0.30,
  },
  'general': {
    system: 0.12, memory: 0.10, code: 0.25, conversation: 0.25, tools: 0.08, selfNarrative: 0.05, reserved: 0.15,
  },
};

class DynamicContextBudget {
  constructor({ bus, storage, config }) {
    this.bus = bus || NullBus;
    this.storage = storage || null;
    this.metaLearning = null; // lateBinding

    const cfg = config || {};
    this._totalBudget = cfg.maxContextTokens || 6000;

    // ── Profiles ─────────────────────────────────────────
    this._profiles = { ...DEFAULT_PROFILES };
    this._learnedAdjustments = {}; // intent → { slot: deltaWeight }

    // ── Stats ────────────────────────────────────────────
    this._stats = {
      allocations: 0,
      adjustments: 0,
    };
  }

  async asyncLoad() {
    try {
      const saved = await this.storage?.readJSON('context-budget-adjustments.json');
      if (saved && typeof saved === 'object') {
        this._learnedAdjustments = saved;
      }
    } catch (_e) { _log.debug('[catch] no saved adjustments:', _e.message); }
  }

  // ════════════════════════════════════════════════════════
  // PUBLIC API
  // ════════════════════════════════════════════════════════

  /**
   * Get token budget allocation for a given intent.
   *
   * @param {string} intent — From IntentRouter: 'code-gen', 'chat', etc.
   * @param {object} options — { totalBudget, activeGoals, hasCode }
   * @returns {Record<string, number>}
   */
  allocate(intent, options = {}) {
    this._stats.allocations++;
    const total = options.totalBudget || this._totalBudget;
    const profileName = this._profiles[intent] ? intent : 'general';
    let weights = { ...this._profiles[profileName] };

    // ── Apply learned adjustments ───────────────────────
    const adj = this._learnedAdjustments[profileName];
    if (adj) {
      for (const [slot, delta] of Object.entries(adj)) {
        if (weights[slot] !== undefined) {
          weights[slot] = Math.max(0.02, Math.min(0.80, weights[slot] + delta));
        }
      }
    }

    // ── Context-sensitive adjustments ───────────────────
    // If there are active persisted goals, allocate more to memory
    if (options.activeGoals && options.activeGoals > 0) {
      weights.memory += 0.05;
      weights.code -= 0.03;
      weights.reserved -= 0.02;
    }

    // If no code context is relevant, redistribute to conversation
    if (options.hasCode === false) {
      weights.conversation += weights.code * 0.5;
      weights.memory += weights.code * 0.3;
      weights.selfNarrative += weights.code * 0.2;
      weights.code = 0.02;
    }

    // ── Normalize weights to sum to 1.0 ─────────────────
    const sum = Object.values(weights).reduce((a, b) => a + b, 0);
    const budgets = /** @type {Record<string, number>} */ ({});
    for (const [slot, w] of Object.entries(weights)) {
      budgets[slot] = Math.round((w / sum) * total);
    }

    // Ensure minimum allocations
    budgets.system = Math.max(budgets.system, 200);
    budgets.reserved = Math.max(budgets.reserved, 100);

    return budgets;
  }

  /**
   * Record outcome and adjust profile weights.
   * Called by MetaLearning integration.
   *
   * @param {string} intent
   * @param {object} budgetsUsed — actual token counts per slot
   * @param {boolean} success — did the task succeed?
   * @param {object} details — { truncated: ['code'], unused: ['tools'] }
   */
  recordOutcome(intent, budgetsUsed, success, details = {}) {
    const profileName = this._profiles[intent] ? intent : 'general';

    if (!success) return; // Only learn from successes

    // ── Adjust toward successful allocation ─────────────
    if (!this._learnedAdjustments[profileName]) {
      this._learnedAdjustments[profileName] = {};
    }
    const adj = this._learnedAdjustments[profileName];

    const total = Object.values(budgetsUsed).reduce((a, b) => a + b, 1);
    const baseProfile = this._profiles[profileName];

    for (const [slot, used] of Object.entries(budgetsUsed)) {
      if (baseProfile[slot] === undefined) continue;
      const actualWeight = used / total;
      const baseWeight = baseProfile[slot];
      const delta = (actualWeight - baseWeight) * 0.05; // Small learning rate

      adj[slot] = (adj[slot] || 0) + delta;
      // Clamp adjustments
      adj[slot] = Math.max(-0.15, Math.min(0.15, adj[slot]));
    }

    this._stats.adjustments++;

    // Persist periodically
    if (this._stats.adjustments % 20 === 0) {
      this._save().catch(() => { /* best effort */ });
    }
  }

  /**
   * Get current profiles (for diagnostics).
   */
  getProfiles() {
    const result = {};
    for (const [intent, base] of Object.entries(this._profiles)) {
      const adj = this._learnedAdjustments[intent] || {};
      result[intent] = {};
      for (const [slot, weight] of Object.entries(base)) {
        result[intent][slot] = Math.round((weight + (adj[slot] || 0)) * 1000) / 1000;
      }
    }
    return result;
  }

  getStats() { return { ...this._stats }; }

  // ════════════════════════════════════════════════════════
  // INTERNAL
  // ════════════════════════════════════════════════════════

  async _save() {
    try {
      await this.storage?.writeJSON('context-budget-adjustments.json', this._learnedAdjustments);
    } catch (err) {
      _log.warn('[CONTEXT-BUDGET] Save failed:', err.message);
    }
  }
}

module.exports = { DynamicContextBudget, DEFAULT_PROFILES };
