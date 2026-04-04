// @ts-check
// ============================================================
// GENESIS — CostGuard.js (v6.0.1)
//
// Session and daily LLM cost cap. Prevents autonomous systems
// (IdleMind, DreamCycle, Colony, Consolidation) from burning
// unbounded tokens. User chat is never blocked — only warned.
//
// Architecture:
//   LLMPort.chat() → CostGuard.checkBudget(taskType, tokens)
//   CostGuard tracks cumulative token usage per session + per day
//   At 80% → llm:cost-warning event
//   At 100% → autonomous calls blocked, user chat warned
//   Daily reset at midnight (local time)
//
// Configuration (settings.json → llm.costGuard):
//   sessionTokenLimit:  500000   (500k tokens per session)
//   dailyTokenLimit:    2000000  (2M tokens per day)
//   warnThreshold:      0.8      (warn at 80%)
//   enabled:            true
//
// CLI: /budget — show current usage and remaining budget
// IPC: agent:get-cost-budget — Dashboard panel data
// ============================================================

const { createLogger } = require('../core/Logger');
const _log = createLogger('CostGuard');

const DEFAULTS = {
  sessionTokenLimit: 500000,
  dailyTokenLimit: 2000000,
  warnThreshold: 0.8,
  enabled: true,
};

class CostGuard {
  /**
   * @param {{ bus?: *, settings?: *, config?: Partial<typeof DEFAULTS> }} opts
   */
  constructor({ bus, settings, config } = {}) {
    this.bus = bus || { emit() {}, fire() {} };
    this._settings = settings || null;

    const cfg = { ...DEFAULTS, ...config };
    this._sessionLimit = cfg.sessionTokenLimit;
    this._dailyLimit = cfg.dailyTokenLimit;
    this._warnThreshold = cfg.warnThreshold;
    this._enabled = cfg.enabled;

    // Counters
    this._sessionTokens = 0;
    this._dailyTokens = 0;
    this._sessionCalls = 0;
    this._dailyCalls = 0;
    this._blockedCalls = 0;
    this._lastResetDate = this._todayKey();
    this._sessionStart = Date.now();

    // Warning state (avoid spam)
    this._sessionWarned = false;
    this._dailyWarned = false;
    this._sessionBlocked = false;
    this._dailyBlocked = false;
  }

  // ════════════════════════════════════════════════════════════
  // LIFECYCLE
  // ════════════════════════════════════════════════════════════

  start() {
    // Load config from settings if available
    if (this._settings) {
      const cfg = this._settings.get?.('llm.costGuard') || {};
      if (typeof cfg.sessionTokenLimit === 'number') this._sessionLimit = cfg.sessionTokenLimit;
      if (typeof cfg.dailyTokenLimit === 'number') this._dailyLimit = cfg.dailyTokenLimit;
      if (typeof cfg.warnThreshold === 'number') this._warnThreshold = cfg.warnThreshold;
      if (typeof cfg.enabled === 'boolean') this._enabled = cfg.enabled;
    }
    _log.info(`[COST-GUARD] Active — session: ${this._fmtTokens(this._sessionLimit)}, daily: ${this._fmtTokens(this._dailyLimit)}`);
  }

  stop() { /* stateless — no persistence needed */ }

  // ════════════════════════════════════════════════════════════
  // CORE: BUDGET CHECK
  // ════════════════════════════════════════════════════════════

  /**
   * Check if a call is within budget. Records the tokens.
   * Returns { allowed, reason, usage } — caller decides action.
   *
   * @param {string} taskType - 'chat', 'code', 'analysis', 'idle', etc.
   * @param {number} estimatedTokens - Estimated prompt + completion tokens
   * @param {{ priority?: number }} [options] - options.priority >= 10 = user chat
   * @returns {{ allowed: boolean, reason?: string, usage: ReturnType<CostGuard['getUsage']> }}
   */
  checkBudget(taskType, estimatedTokens, options = {}) {
    if (!this._enabled) return { allowed: true, usage: this.getUsage() };

    // Daily reset check
    this._checkDailyReset();

    const isUserChat = (options.priority || 0) >= 10;

    // Record the call
    this._sessionTokens += estimatedTokens;
    this._dailyTokens += estimatedTokens;
    this._sessionCalls++;
    this._dailyCalls++;

    // Check session limit
    const sessionPct = this._sessionTokens / this._sessionLimit;
    if (sessionPct >= 1.0 && !isUserChat) {
      this._blockedCalls++;
      if (!this._sessionBlocked) {
        this._sessionBlocked = true;
        this.bus.emit('llm:cost-cap-reached', {
          scope: 'session', used: this._sessionTokens,
          limit: this._sessionLimit, taskType,
        }, { source: 'CostGuard' });
        _log.warn(`[COST-GUARD] Session token limit reached (${this._fmtTokens(this._sessionTokens)}/${this._fmtTokens(this._sessionLimit)}) — blocking autonomous calls`);
      }
      return { allowed: false, reason: `Session token budget exhausted (${this._fmtTokens(this._sessionLimit)})`, usage: this.getUsage() };
    }

    // Check daily limit
    const dailyPct = this._dailyTokens / this._dailyLimit;
    if (dailyPct >= 1.0 && !isUserChat) {
      this._blockedCalls++;
      if (!this._dailyBlocked) {
        this._dailyBlocked = true;
        this.bus.emit('llm:cost-cap-reached', {
          scope: 'daily', used: this._dailyTokens,
          limit: this._dailyLimit, taskType,
        }, { source: 'CostGuard' });
        _log.warn(`[COST-GUARD] Daily token limit reached (${this._fmtTokens(this._dailyTokens)}/${this._fmtTokens(this._dailyLimit)}) — blocking autonomous calls`);
      }
      return { allowed: false, reason: `Daily token budget exhausted (${this._fmtTokens(this._dailyLimit)})`, usage: this.getUsage() };
    }

    // Warnings at threshold
    if (sessionPct >= this._warnThreshold && !this._sessionWarned) {
      this._sessionWarned = true;
      this.bus.emit('llm:cost-warning', {
        scope: 'session', pct: Math.round(sessionPct * 100),
        used: this._sessionTokens, limit: this._sessionLimit,
      }, { source: 'CostGuard' });
      _log.info(`[COST-GUARD] Session budget at ${Math.round(sessionPct * 100)}%`);
    }

    if (dailyPct >= this._warnThreshold && !this._dailyWarned) {
      this._dailyWarned = true;
      this.bus.emit('llm:cost-warning', {
        scope: 'daily', pct: Math.round(dailyPct * 100),
        used: this._dailyTokens, limit: this._dailyLimit,
      }, { source: 'CostGuard' });
      _log.info(`[COST-GUARD] Daily budget at ${Math.round(dailyPct * 100)}%`);
    }

    return { allowed: true, usage: this.getUsage() };
  }

  // ════════════════════════════════════════════════════════════
  // STATUS
  // ════════════════════════════════════════════════════════════

  getUsage() {
    this._checkDailyReset();
    return {
      session: {
        tokens: this._sessionTokens,
        limit: this._sessionLimit,
        pct: Math.round((this._sessionTokens / this._sessionLimit) * 100),
        calls: this._sessionCalls,
        remaining: Math.max(0, this._sessionLimit - this._sessionTokens),
      },
      daily: {
        tokens: this._dailyTokens,
        limit: this._dailyLimit,
        pct: Math.round((this._dailyTokens / this._dailyLimit) * 100),
        calls: this._dailyCalls,
        remaining: Math.max(0, this._dailyLimit - this._dailyTokens),
      },
      blocked: this._blockedCalls,
      enabled: this._enabled,
      sessionUptime: Math.round((Date.now() - this._sessionStart) / 60000),
    };
  }

  /** Reset session counters (e.g. on restart) */
  resetSession() {
    this._sessionTokens = 0;
    this._sessionCalls = 0;
    this._blockedCalls = 0;
    this._sessionWarned = false;
    this._sessionBlocked = false;
    this._sessionStart = Date.now();
    _log.info('[COST-GUARD] Session budget reset');
  }

  // ════════════════════════════════════════════════════════════
  // INTERNALS
  // ════════════════════════════════════════════════════════════

  _checkDailyReset() {
    const today = this._todayKey();
    if (today !== this._lastResetDate) {
      _log.info(`[COST-GUARD] Daily reset — yesterday: ${this._fmtTokens(this._dailyTokens)} tokens in ${this._dailyCalls} calls`);
      this._dailyTokens = 0;
      this._dailyCalls = 0;
      this._dailyWarned = false;
      this._dailyBlocked = false;
      this._lastResetDate = today;
    }
  }

  _todayKey() {
    return new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  }

  _fmtTokens(n) {
    if (n >= 1000000) return `${(n / 1000000).toFixed(1)}M`;
    if (n >= 1000) return `${(n / 1000).toFixed(0)}k`;
    return String(n);
  }
}

module.exports = { CostGuard };
