// @ts-checked-v5.9
// ============================================================
// GENESIS — TaskOutcomeTracker.js (v5.9.7)
//
// V6-11 SelfModel — Data Collection Layer
//
// PROBLEM: Genesis has no empirical record of its own
// performance. ReasoningTracer captures *decisions*,
// LessonsStore captures *learnings*, but neither records
// structured *outcomes* (success/fail, cost, duration) per
// task type and backend. Without this data, the future
// SelfModel cannot calibrate confidence or detect biases.
//
// SOLUTION: Listen to task-completion events, extract
// structured outcome records, persist them, and expose
// aggregate statistics. Every day this runs is training
// data the SelfModel will use.
//
// Architecture:
//   agent-loop:complete   ──┐
//   chat:completed        ──┼─→ _recordOutcome() → storage
//   selfmod:success       ──┤     ↓
//   shell:complete        ──┘   emit task-outcome:recorded
//                               emit task-outcome:stats-updated
//
// Data format per outcome:
//   { taskType, backend, success, tokenCost, durationMs,
//     errorCategory, intent, timestamp }
//
// Aggregates (computed on read, not stored):
//   Per taskType: successRate, avgTokenCost, avgDuration, count
//   Per backend:  successRate, avgTokenCost, count
//
// Storage: ~/.genesis/task-outcomes.json (append-only, capped)
// ============================================================

'use strict';

const { createLogger } = require('../core/Logger');

const _log = createLogger('TaskOutcomeTracker');

const MAX_OUTCOMES = 2000;
const PRUNE_TO = 1500;
const PERSIST_DEBOUNCE_MS = 10_000; // batch writes every 10s

// ── Task type classification from intent ────────────────────
const INTENT_TO_TASK_TYPE = {
  'code-gen':       'code-gen',
  'self-modify':    'self-modify',
  'self-repair':    'self-repair',
  'self-inspect':   'analysis',
  'analyze-code':   'analysis',
  'explain':        'chat',
  'chat':           'chat',
  'search':         'research',
  'research':       'research',
  'planning':       'planning',
  'reasoning':      'reasoning',
  'run-skill':      'skill-exec',
  'shell':          'shell-exec',
  'refactor':       'refactoring',
  'test':           'testing',
  'deploy':         'deployment',
};

class TaskOutcomeTracker {
  /**
   * @param {{ bus: *, storage?: * }} deps
   */
  constructor({ bus, storage }) {
    /** @type {import('../core/EventBus').EventBus} */
    this.bus = bus;
    this.storage = storage || null;

    /** @type {Array<OutcomeRecord>} */
    this._outcomes = [];

    /** @type {boolean} */
    this._dirty = false;

    /** @type {ReturnType<typeof setTimeout> | null} */
    this._persistTimer = null;

    /** @type {Array<Function>} */
    this._unsubs = [];

    /** @type {{ recorded: number, persisted: number, pruned: number }} */
    this.stats = { recorded: 0, persisted: 0, pruned: 0 };
  }

  static containerConfig = {
    name: 'taskOutcomeTracker',
    phase: 9,
    deps: ['bus'],
    lateBindings: [
      { prop: 'storage', service: 'storage', optional: true },
    ],
    tags: ['cognitive', 'learning', 'selfmodel'],
  };

  // ── Lifecycle ───────────────────────────────────────────

  async asyncLoad() {
    if (this.storage) {
      try {
        const data = await this.storage.read('task-outcomes');
        if (Array.isArray(data)) {
          this._outcomes = data;
          _log.info(`loaded ${data.length} historical outcomes`);
        }
      } catch (_e) {
        _log.debug('no prior outcomes found — starting fresh');
      }
    }
  }

  boot() {
    this._unsubs.push(
      this.bus.on('agent-loop:complete', (data) => this._onAgentLoopComplete(data)),
      this.bus.on('chat:completed', (data) => this._onChatCompleted(data)),
      this.bus.on('selfmod:success', (data) => this._onSelfModSuccess(data)),
      this.bus.on('shell:complete', (data) => this._onShellComplete(data)),
    );
  }

  stop() {
    for (const unsub of this._unsubs) unsub();
    this._unsubs.length = 0;
    if (this._persistTimer) {
      clearTimeout(this._persistTimer);
      this._persistTimer = null;
    }
    // Sync persist on shutdown
    this._persistSync();
  }

  // ── Event Handlers ──────────────────────────────────────

  /** @param {*} data */
  _onAgentLoopComplete(data) {
    if (!data) return;
    this._recordOutcome({
      taskType: this._classifyTaskType(data.intent || data.title || ''),
      backend: data.backend || 'unknown',
      success: data.success !== false,
      tokenCost: data.tokenCost || data.tokens || 0,
      durationMs: data.durationMs || data.duration || 0,
      errorCategory: data.success === false ? (data.error || 'unknown') : null,
      intent: data.intent || null,
    });
  }

  /** @param {*} data */
  _onChatCompleted(data) {
    if (!data) return;
    this._recordOutcome({
      taskType: this._classifyTaskType(data.intent || 'chat'),
      backend: data.backend || 'unknown',
      success: data.success !== false,
      tokenCost: data.tokenCost || data.tokens || 0,
      durationMs: data.durationMs || 0,
      errorCategory: data.success === false ? (data.error || 'unknown') : null,
      intent: data.intent || 'chat',
    });
  }

  /** @param {*} data */
  _onSelfModSuccess(data) {
    if (!data) return;
    this._recordOutcome({
      taskType: 'self-modify',
      backend: data.backend || 'unknown',
      success: true,
      tokenCost: data.tokenCost || data.tokens || 0,
      durationMs: data.durationMs || 0,
      errorCategory: null,
      intent: 'self-modify',
    });
  }

  /** @param {*} data */
  _onShellComplete(data) {
    if (!data) return;
    this._recordOutcome({
      taskType: 'shell-exec',
      backend: data.backend || 'unknown',
      success: data.exitCode != null ? data.exitCode === 0 : data.success !== false,
      tokenCost: data.tokenCost || 0,
      durationMs: data.durationMs || 0,
      errorCategory: data.exitCode !== 0 ? `exit-${data.exitCode || 'unknown'}` : null,
      intent: 'shell',
    });
  }

  // ── Core Logic ──────────────────────────────────────────

  /**
   * @param {Partial<OutcomeRecord>} record
   */
  _recordOutcome(record) {
    /** @type {OutcomeRecord} */
    const outcome = {
      taskType: record.taskType || 'unknown',
      backend: record.backend || 'unknown',
      success: record.success !== false,
      tokenCost: record.tokenCost || 0,
      durationMs: record.durationMs || 0,
      errorCategory: record.errorCategory || null,
      intent: record.intent || null,
      timestamp: Date.now(),
    };

    this._outcomes.push(outcome);
    this.stats.recorded++;
    this._dirty = true;

    this.bus.emit('task-outcome:recorded', outcome);

    // Prune if over cap
    if (this._outcomes.length > MAX_OUTCOMES) {
      this._outcomes = this._outcomes.slice(-PRUNE_TO);
      this.stats.pruned += MAX_OUTCOMES - PRUNE_TO;
    }

    // Debounced persist
    this._schedulePersist();

    // Emit aggregate stats periodically (every 10 records)
    if (this.stats.recorded % 10 === 0) {
      this.bus.emit('task-outcome:stats-updated', this.getAggregateStats());
    }
  }

  /**
   * Classify an intent string into a normalized task type.
   * @param {string} intentOrTitle
   * @returns {string}
   */
  _classifyTaskType(intentOrTitle) {
    const lower = (intentOrTitle || '').toLowerCase().trim();
    if (INTENT_TO_TASK_TYPE[lower]) return INTENT_TO_TASK_TYPE[lower];

    // Fuzzy match for compound intents
    for (const [pattern, taskType] of Object.entries(INTENT_TO_TASK_TYPE)) {
      if (lower.includes(pattern)) return taskType;
    }
    return 'general';
  }

  // ── Aggregate Statistics ────────────────────────────────

  /**
   * Get per-taskType and per-backend aggregate statistics.
   * @param {{ windowMs?: number }} [opts] Only consider outcomes within this time window
   * @returns {{ byTaskType: Record<string, TaskTypeStats>, byBackend: Record<string, BackendStats>, total: number }}
   */
  getAggregateStats(opts = {}) {
    const cutoff = opts.windowMs ? Date.now() - opts.windowMs : 0;
    const relevant = cutoff > 0
      ? this._outcomes.filter(o => o.timestamp >= cutoff)
      : this._outcomes;

    /** @type {Record<string, TaskTypeStats>} */
    const byTaskType = {};
    /** @type {Record<string, BackendStats>} */
    const byBackend = {};

    for (const o of relevant) {
      // ── By task type ──
      if (!byTaskType[o.taskType]) {
        byTaskType[o.taskType] = { count: 0, successes: 0, totalTokens: 0, totalDurationMs: 0, errors: {} };
      }
      const tt = byTaskType[o.taskType];
      tt.count++;
      if (o.success) tt.successes++;
      tt.totalTokens += o.tokenCost;
      tt.totalDurationMs += o.durationMs;
      if (o.errorCategory) {
        tt.errors[o.errorCategory] = (tt.errors[o.errorCategory] || 0) + 1;
      }

      // ── By backend ──
      if (!byBackend[o.backend]) {
        byBackend[o.backend] = { count: 0, successes: 0, totalTokens: 0 };
      }
      const be = byBackend[o.backend];
      be.count++;
      if (o.success) be.successes++;
      be.totalTokens += o.tokenCost;
    }

    // Compute rates
    for (const stats of Object.values(byTaskType)) {
      stats.successRate = stats.count > 0 ? stats.successes / stats.count : 0;
      stats.avgTokenCost = stats.count > 0 ? Math.round(stats.totalTokens / stats.count) : 0;
      stats.avgDurationMs = stats.count > 0 ? Math.round(stats.totalDurationMs / stats.count) : 0;
    }
    for (const stats of Object.values(byBackend)) {
      stats.successRate = stats.count > 0 ? stats.successes / stats.count : 0;
      stats.avgTokenCost = stats.count > 0 ? Math.round(stats.totalTokens / stats.count) : 0;
    }

    return { byTaskType, byBackend, total: relevant.length };
  }

  /**
   * Get raw outcomes (for SelfModel consumption).
   * @param {{ taskType?: string, backend?: string, limit?: number }} [filter]
   * @returns {OutcomeRecord[]}
   */
  getOutcomes(filter = {}) {
    let results = this._outcomes;
    if (filter.taskType) results = results.filter(o => o.taskType === filter.taskType);
    if (filter.backend) results = results.filter(o => o.backend === filter.backend);
    if (filter.limit) results = results.slice(-filter.limit);
    return results;
  }

  // ── Persistence ─────────────────────────────────────────

  _schedulePersist() {
    if (this._persistTimer) return;
    this._persistTimer = setTimeout(() => {
      this._persistTimer = null;
      this._persistAsync();
    }, PERSIST_DEBOUNCE_MS);
  }

  async _persistAsync() {
    if (!this._dirty || !this.storage) return;
    try {
      await this.storage.write('task-outcomes', this._outcomes);
      this._dirty = false;
      this.stats.persisted++;
    } catch (e) {
      _log.debug('persist failed:', e.message);
    }
  }

  _persistSync() {
    if (!this._dirty || !this.storage) return;
    try {
      if (typeof this.storage.writeSync === 'function') {
        this.storage.writeSync('task-outcomes', this._outcomes);
      } else if (typeof this.storage.write === 'function') {
        // Best-effort async in sync context
        this.storage.write('task-outcomes', this._outcomes).catch(() => {});
      }
      this._dirty = false;
      this.stats.persisted++;
    } catch (e) {
      _log.debug('sync persist failed:', e.message);
    }
  }
}

module.exports = { TaskOutcomeTracker };

/**
 * @typedef {object} OutcomeRecord
 * @property {string} taskType
 * @property {string} backend
 * @property {boolean} success
 * @property {number} tokenCost
 * @property {number} durationMs
 * @property {string|null} errorCategory
 * @property {string|null} intent
 * @property {number} timestamp
 */

/**
 * @typedef {object} TaskTypeStats
 * @property {number} count
 * @property {number} successes
 * @property {number} successRate
 * @property {number} totalTokens
 * @property {number} avgTokenCost
 * @property {number} totalDurationMs
 * @property {number} avgDurationMs
 * @property {Record<string, number>} errors
 */

/**
 * @typedef {object} BackendStats
 * @property {number} count
 * @property {number} successes
 * @property {number} successRate
 * @property {number} totalTokens
 * @property {number} avgTokenCost
 */
