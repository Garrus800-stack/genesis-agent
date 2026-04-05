// @ts-checked-v5.6
// ============================================================
// GENESIS — FailureTaxonomy.js (Phase 10 — Persistent Agency)
//
// PROBLEM: AgentLoop treats all errors equally. A timeout
// gets the same response as a syntax error. This wastes
// retries on deterministic failures and gives up too early
// on transient ones.
//
// SOLUTION: Categorize every failure into one of four types,
// each with its own recovery strategy:
//
//   TRANSIENT     — Timeout, Ollama overload, rate limit
//                   → Retry with exponential backoff
//
//   DETERMINISTIC — Syntax error, import not found, type error
//                   → Replan immediately (same approach won't work)
//
//   ENVIRONMENTAL — File not found, permission denied, disk full
//                   → Update WorldState, then replan
//
//   CAPABILITY    — Model can't do the task (hallucination, quality)
//                   → Escalate to larger model via ModelRouter
//
// Integration:
//   AgentLoop catches error → FailureTaxonomy.classify(error)
//   → returns { category, strategy, retryConfig }
//   AgentLoop uses strategy instead of generic retry
//   FailureAnalyzer.analyze() feeds into taxonomy learning
// ============================================================

const { NullBus } = require('../core/EventBus');

const CATEGORY = Object.freeze({
  TRANSIENT: 'transient',
  DETERMINISTIC: 'deterministic',
  ENVIRONMENTAL: 'environmental',
  CAPABILITY: 'capability',
  UNKNOWN: 'unknown',
});

const STRATEGY = Object.freeze({
  RETRY_BACKOFF: 'retry_backoff',
  REPLAN: 'replan',
  UPDATE_WORLD_REPLAN: 'update_world_replan',
  ESCALATE_MODEL: 'escalate_model',
  ASK_USER: 'ask_user',
  ABORT: 'abort',
});

// ── Pattern Database ─────────────────────────────────────
const TRANSIENT_PATTERNS = [
  /timeout/i, /ETIMEDOUT/i, /ECONNRESET/i, /ECONNREFUSED/i,
  /socket hang up/i, /network error/i, /rate limit/i,
  /429/i, /503/i, /502/i, /overloaded/i, /busy/i,
  /semaphore starvation/i, /EBUSY/i,
  /Could not connect to Ollama/i,
  /model is loading/i,
];

const DETERMINISTIC_PATTERNS = [
  /SyntaxError/i, /ReferenceError/i, /TypeError: .*is not a function/i,
  /Unexpected token/i, /Cannot find module/i, /Module not found/i,
  /is not defined/i, /Cannot read propert/i,
  /Unexpected identifier/i, /Invalid or unexpected token/i,
  /Duplicate declaration/i, /has already been declared/i,
  /circular dependency/i,
  /assertion.*fail/i, /expected.*but got/i,
  /test.*fail.*\d+/i,
];

const ENVIRONMENTAL_PATTERNS = [
  /ENOENT/i, /no such file/i, /file not found/i,
  /EACCES/i, /permission denied/i, /EPERM/i,
  /ENOSPC/i, /disk.*full/i, /no space left/i,
  /ENOMEM/i, /out of memory/i, /heap/i,
  /not installed/i, /command not found/i,
  /EEXIST/i, /already exists/i,
  /git.*conflict/i, /merge conflict/i,
];

const CAPABILITY_PATTERNS = [
  /hallucin/i, /made up/i, /incorrect.*api/i,
  /quality.*low/i, /ambiguous.*result/i,
  /could not.*understand/i, /unable to.*generate/i,
  /invalid.*json/i, /failed.*parse.*json/i,
  /empty.*response/i, /no.*output/i,
  /verification.*fail.*ambiguous/i,
];

class FailureTaxonomy {
  static containerConfig = {
    name: 'failureTaxonomy',
    phase: 2,
    deps: ['eventStore'],
    tags: ['intelligence', 'error-handling'],
    lateBindings: [
      { prop: 'modelRouter', service: 'modelRouter', optional: true },
      { prop: 'worldState', service: 'worldState', optional: true },
    ],
  };

  constructor({ bus, eventStore, config }) {
    this.bus = bus || NullBus;
    this.eventStore = eventStore || null;
    this.modelRouter = null; // lateBinding
    this.worldState = null;  // lateBinding

    const cfg = config || {};
    this._maxRetries = cfg.maxRetries || { transient: 3, deterministic: 0, environmental: 1, capability: 1 };
    this._backoffBaseMs = cfg.backoffBaseMs || 2000;
    this._backoffMaxMs = cfg.backoffMaxMs || 30000;

    // ── Learning: track failure patterns per action type ──
    this._history = []; // { category, actionType, error, timestamp }
    this._maxHistory = 500;

    // ── Stats ────────────────────────────────────────────
    this._stats = {
      classified: 0,
      categories: { transient: 0, deterministic: 0, environmental: 0, capability: 0, unknown: 0 },
      strategiesApplied: {},
    };
  }

  // ════════════════════════════════════════════════════════
  // PUBLIC API
  // ════════════════════════════════════════════════════════

  /**
   * Classify an error and return recovery strategy.
   *
   * @param {Error & {code?: string}|string} error - The caught error
   * @param {object} context - { actionType, stepIndex, goalId, model, attempt }
   * @returns {{
   *   category: string,
   *   strategy: string,
   *   retryConfig: { maxRetries, backoffMs, shouldRetry },
   *   worldStateUpdates: object|null,
   *   escalation: object|null,
   *   explanation: string,
   * }}
   */
  classify(error, context = {}) {
    this._stats.classified++;
    const errorStr = typeof error === 'string' ? error : (error?.message || String(error));
    const stack = typeof error === 'string' ? '' : (error?.stack || '');
    const combined = `${errorStr} ${stack}`;

    // ── Pattern matching ────────────────────────────────
    /** @type {string} */
    let category = CATEGORY.UNKNOWN;
    let confidence = 0;

    const checks = [
      { cat: CATEGORY.TRANSIENT, patterns: TRANSIENT_PATTERNS },
      { cat: CATEGORY.DETERMINISTIC, patterns: DETERMINISTIC_PATTERNS },
      { cat: CATEGORY.ENVIRONMENTAL, patterns: ENVIRONMENTAL_PATTERNS },
      { cat: CATEGORY.CAPABILITY, patterns: CAPABILITY_PATTERNS },
    ];

    for (const { cat, patterns } of checks) {
      const matchCount = patterns.filter(p => p.test(combined)).length;
      if (matchCount > 0) {
        const score = Math.min(1.0, matchCount * 0.3 + 0.4);
        if (score > confidence) {
          category = cat;
          confidence = score;
        }
      }
    }

    // ── Exit code heuristic ─────────────────────────────
    const errCode = typeof error === 'string' ? null : error?.code;
    if (errCode) {
      if (['ETIMEDOUT', 'ECONNRESET', 'ECONNREFUSED', 'EBUSY'].includes(errCode)) {
        category = CATEGORY.TRANSIENT;
        confidence = Math.max(confidence, 0.9);
      } else if (['ENOENT', 'EACCES', 'EPERM', 'ENOSPC', 'ENOMEM'].includes(errCode)) {
        category = CATEGORY.ENVIRONMENTAL;
        confidence = Math.max(confidence, 0.9);
      }
    }

    // ── Build strategy ──────────────────────────────────
    const result = this._buildStrategy(category, confidence, errorStr, context);

    // ── Record ──────────────────────────────────────────
    this._stats.categories[category] = (this._stats.categories[category] || 0) + 1;
    this._stats.strategiesApplied[result.strategy] = (this._stats.strategiesApplied[result.strategy] || 0) + 1;

    this._history.push({
      category,
      confidence,
      actionType: context.actionType,
      error: errorStr.slice(0, 200),
      strategy: result.strategy,
      timestamp: Date.now(),
    });
    if (this._history.length > this._maxHistory) {
      this._history = this._history.slice(-this._maxHistory);
    }

    this.bus.emit('failure:classified', {
      category,
      strategy: result.strategy,
      confidence,
      actionType: context.actionType,
      goalId: context.goalId,
    }, { source: 'FailureTaxonomy' });

    return result;
  }

  /**
   * Get failure statistics for a specific action type.
   * Useful for ExpectationEngine calibration.
   */
  getActionStats(actionType) {
    const relevant = this._history.filter(h => h.actionType === actionType);
    if (relevant.length === 0) return null;

    const categories = {};
    for (const h of relevant) {
      categories[h.category] = (categories[h.category] || 0) + 1;
    }

    return {
      total: relevant.length,
      categories,
      dominantFailure: Object.entries(categories).sort((a, b) => b[1] - a[1])[0]?.[0],
      transientRate: (categories.transient || 0) / relevant.length,
    };
  }

  getStats() { return { ...this._stats, historySize: this._history.length }; }

  // ════════════════════════════════════════════════════════
  // INTERNAL
  // ════════════════════════════════════════════════════════

  _buildStrategy(category, confidence, errorStr, context) {
    const attempt = context.attempt || 0;

    switch (category) {
      case CATEGORY.TRANSIENT: {
        const maxRetries = this._maxRetries.transient;
        const shouldRetry = attempt < maxRetries;
        const backoffMs = Math.min(
          this._backoffBaseMs * Math.pow(2, attempt),
          this._backoffMaxMs
        );
        return {
          category,
          strategy: shouldRetry ? STRATEGY.RETRY_BACKOFF : STRATEGY.ASK_USER,
          retryConfig: { maxRetries, backoffMs, shouldRetry },
          worldStateUpdates: null,
          escalation: null,
          explanation: shouldRetry
            ? `Transient error (attempt ${attempt + 1}/${maxRetries}). Retrying in ${Math.round(backoffMs / 1000)}s.`
            : `Transient error persists after ${maxRetries} retries. Asking user.`,
        };
      }

      case CATEGORY.DETERMINISTIC:
        return {
          category,
          strategy: STRATEGY.REPLAN,
          retryConfig: { maxRetries: 0, backoffMs: 0, shouldRetry: false },
          worldStateUpdates: null,
          escalation: null,
          explanation: `Deterministic error: "${errorStr.slice(0, 100)}". Same approach will fail again. Replanning with error context.`,
          replanContext: { error: errorStr, failedAction: context.actionType, step: context.stepIndex },
        };

      case CATEGORY.ENVIRONMENTAL: {
        // Build WorldState updates based on error
        const updates = this._inferWorldStateUpdates(errorStr);
        return {
          category,
          strategy: STRATEGY.UPDATE_WORLD_REPLAN,
          retryConfig: { maxRetries: 1, backoffMs: 0, shouldRetry: attempt < 1 },
          worldStateUpdates: updates,
          escalation: null,
          explanation: `Environmental error: "${errorStr.slice(0, 100)}". Updating WorldState and replanning.`,
          replanContext: { error: errorStr, environmentalFix: updates },
        };
      }

      case CATEGORY.CAPABILITY:
        return {
          category,
          strategy: STRATEGY.ESCALATE_MODEL,
          retryConfig: { maxRetries: 1, backoffMs: 0, shouldRetry: attempt < 1 },
          worldStateUpdates: null,
          escalation: {
            reason: 'Model capability insufficient',
            currentModel: context.model,
            suggestedTaskType: context.actionType,
          },
          explanation: `Model capability issue. Escalating to a more capable model if available.`,
        };

      default:
        return {
          category: CATEGORY.UNKNOWN,
          strategy: attempt < 1 ? STRATEGY.RETRY_BACKOFF : STRATEGY.ASK_USER,
          retryConfig: { maxRetries: 1, backoffMs: this._backoffBaseMs, shouldRetry: attempt < 1 },
          worldStateUpdates: null,
          escalation: null,
          explanation: `Unclassified error: "${errorStr.slice(0, 100)}". Attempting one retry.`,
        };
    }
  }

  _inferWorldStateUpdates(errorStr) {
    const updates = {};

    // File not found → update project structure
    const fileMatch = errorStr.match(/(?:ENOENT|no such file).*?['"](.+?)['"]/i);
    if (fileMatch) {
      updates.missingFile = fileMatch[1];
      updates.refreshProjectStructure = true;
    }

    // Permission denied → note restricted path
    const permMatch = errorStr.match(/(?:EACCES|permission denied).*?['"](.+?)['"]/i);
    if (permMatch) {
      updates.restrictedPath = permMatch[1];
    }

    // Disk full
    if (/ENOSPC|disk.*full|no space left/i.test(errorStr)) {
      updates.diskFull = true;
    }

    // Command not found
    const cmdMatch = errorStr.match(/(?:command not found|not installed).*?['"]?(\w+)['"]?/i);
    if (cmdMatch) {
      updates.missingCommand = cmdMatch[1];
    }

    return Object.keys(updates).length > 0 ? updates : null;
  }
}

module.exports = { FailureTaxonomy, CATEGORY, STRATEGY };
