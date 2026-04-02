// @ts-checked-v5.8
// ============================================================
// GENESIS — LLMPort.js (v3.5.0 — Rate-Limited + Better Tokens)
//
// Port interface + adapter for LLM access.
// Consumers depend on LLMPort, not ModelBridge directly.
//
// v3.5.0 UPGRADES:
// - TokenBucket burst limiter — prevents autonomous systems
//   from flooding the LLM with rapid-fire calls
// - HourlyBudget per priority class — chat gets 200/hr,
//   autonomous gets 80/hr, idle gets 40/hr
// - Improved token estimation — accounts for German text,
//   code, punctuation (was: naive chars/4)
// - User chat (priority >= CHAT) bypasses rate limits
//
// Usage in Container:
//   c.register('llm', (ct) => new ModelBridgeAdapter(ct.resolve('model')));
// ============================================================

const { NullBus } = require('../core/EventBus');
const { RATE_LIMIT } = require('../core/Constants');

// ── Token Bucket Rate Limiter ───────────────────────────
// Controls burst rate. Refills at a steady rate so
// autonomous systems can't flood the model.

class TokenBucket {
  /**
   * @param {number} capacity - Max tokens (burst limit)
   * @param {number} refillPerMinute - Tokens added per minute
   */
  constructor(capacity, refillPerMinute) {
    this.capacity = capacity;
    this.tokens = capacity;
    this.refillRate = refillPerMinute / 60000; // tokens per ms
    this._lastRefill = Date.now();
  }

  /** Try to consume one token. Returns true if allowed. */
  tryConsume() {
    this._refill();
    if (this.tokens >= 1) { this.tokens -= 1; return true; }
    return false;
  }

  /** Current fill level (0.0–1.0) */
  fillLevel() {
    this._refill();
    return this.tokens / this.capacity;
  }

  _refill() {
    const now = Date.now();
    this.tokens = Math.min(this.capacity, this.tokens + (now - this._lastRefill) * this.refillRate);
    this._lastRefill = now;
  }

  getStatus() {
    this._refill();
    return {
      tokens: Math.round(this.tokens * 10) / 10,
      capacity: this.capacity,
      fillPct: Math.round(this.fillLevel() * 100),
    };
  }
}

// ── Hourly Budget Tracker ───────────────────────────────
// Per-priority-class rolling-hour call budgets.

class HourlyBudget {
  constructor(budgets) {
    this._budgets = budgets; // { chat: 200, autonomous: 80, idle: 40 }
    this._calls = {};
    for (const key of Object.keys(budgets)) this._calls[key] = [];
  }

  /**
   * Record a call and check if budget allows it.
   * @param {string} bucket - Budget key (chat, autonomous, idle)
   * @returns {{ allowed: boolean, used: number, budget: number }}
   */
  tryConsume(bucket) {
    if (!this._budgets[bucket]) return { allowed: true, used: 0, budget: Infinity };
    const now = Date.now();
    const hourAgo = now - 3600000;
    this._calls[bucket] = this._calls[bucket].filter(ts => ts > hourAgo);
    const used = this._calls[bucket].length;
    const budget = this._budgets[bucket];
    if (used >= budget) return { allowed: false, used, budget };
    this._calls[bucket].push(now);
    return { allowed: true, used: used + 1, budget };
  }

  getStatus() {
    const now = Date.now();
    const hourAgo = now - 3600000;
    const status = {};
    for (const [key, budget] of Object.entries(this._budgets)) {
      this._calls[key] = this._calls[key].filter(ts => ts > hourAgo);
      status[key] = { used: this._calls[key].length, budget, remaining: Math.max(0, budget - this._calls[key].length) };
    }
    return status;
  }

  reset() {
    for (const key of Object.keys(this._calls)) this._calls[key] = [];
  }
}

// ── Token Estimation ────────────────────────────────────
// Better heuristic than raw chars/4. Accounts for:
// - German/multi-byte text (higher bytes-per-token with BPE)
// - Code (more single-char tokens: brackets, operators)
// - Punctuation (usually 1 token per symbol)

function estimateTokens(text, taskType) {
  if (!text) return 0;
  const len = text.length;
  if (len === 0) return 0;
  const punctuation = (text.match(/[^\w\s]/g) || []).length;
  const nonAscii = (text.match(/[^\x00-\x7F]/g) || []).length;
  let charsPerToken = 4.0;
  if (nonAscii > len * 0.05) charsPerToken = 3.2;  // German avg with BPE
  if (taskType === 'code') charsPerToken = 3.5;
  return Math.ceil((len - punctuation) / charsPerToken) + punctuation;
}

// ── Port Interface ────────────────────────────────────────
// Documents the contract. Consumers code against this shape.

class LLMPort {
  async chat(systemPrompt, messages = [], taskType = 'chat', options = {}) {
    throw new Error('LLMPort.chat() not implemented');
  }

  async streamChat(systemPrompt, messages = [], onChunk, abortSignal, taskType = 'chat', options = {}) {
    throw new Error('LLMPort.streamChat() not implemented');
  }

  /** @returns {string | null} */ get activeModel() { return null; }
  /** @returns {string | null} */ get activeBackend() { return null; }
  /** @returns {Array<*>} */ get availableModels() { return []; }
  /** @returns {Promise<Array<*>>} */ async detectAvailable() { return []; }
  /** @returns {Promise<*>} */ async switchTo(modelName) { throw new Error('LLMPort.switchTo() not implemented'); }
  configureBackend(backendName, config) { throw new Error('LLMPort.configureBackend() not implemented'); }
  getConcurrencyStats() { return { active: 0, queued: 0 }; }

  async chatStructured(systemPrompt, messages = [], taskType = 'analysis') {
    throw new Error('LLMPort.chatStructured() not implemented');
  }

  get temperatures() { return {}; }
  get backends() { return {}; }
}

// ── ModelBridge Adapter ───────────────────────────────────
// Wraps ModelBridge. Adds: metrics, rate limiting, events.

class ModelBridgeAdapter extends LLMPort {
  static containerConfig = {
    name: 'llm',
    phase: 1,
    deps: ['model'],
    tags: ['port', 'foundation'],
    lateBindings: [],
    factory: (c) => new ModelBridgeAdapter(c.resolve('model'), c.resolve('bus')),
  };

  constructor(modelBridge, bus) {
    super();
    this._bridge = modelBridge;
    this.bus = bus || NullBus;

    // Rate Limiting
    this._bucket = new TokenBucket(RATE_LIMIT.BUCKET_CAPACITY, RATE_LIMIT.REFILL_PER_MINUTE);
    this._hourlyBudget = new HourlyBudget(RATE_LIMIT.HOURLY_BUDGETS);

    // Metrics
    this._metrics = {
      totalCalls: 0,
      totalStreamCalls: 0,
      totalTokensEstimated: 0,
      callsByTaskType: {},
      callsByBackend: {},
      errors: 0,
      rateLimited: 0,
      lastCallAt: /** @type {string | null} */ (null),
      avgLatencyMs: 0,
      _latencies: [],
    };
  }

  // ── Rate Limit ──────────────────────────────────────

  _checkRateLimit(taskType, options) {
    // 1. Token bucket (burst control)
    if (!this._bucket.tryConsume()) {
      this._metrics.rateLimited++;
      this.bus.emit('llm:rate-limited', {
        bucket: 'burst', used: this._bucket.capacity,
        budget: this._bucket.capacity, caller: taskType,
      }, { source: 'LLMPort' });
      return false;
    }

    // 2. Hourly budget (per priority class)
    const priority = options?.priority || 0;
    const budgetKey = RATE_LIMIT.PRIORITY_MAP[priority] || 'chat';
    const result = this._hourlyBudget.tryConsume(budgetKey);

    if (!result.allowed) {
      this._metrics.rateLimited++;
      this.bus.emit('llm:rate-limited', {
        bucket: budgetKey, used: result.used,
        budget: result.budget, caller: taskType,
      }, { source: 'LLMPort' });
      return false;
    }

    // Warn at 80% budget usage
    if (result.used > result.budget * 0.8) {
      this.bus.emit('llm:budget-warning', {
        bucket: budgetKey, used: result.used, budget: result.budget,
      }, { source: 'LLMPort' });
    }

    return true;
  }

  // ── Chat ────────────────────────────────────────────

  async chat(systemPrompt, messages = [], taskType = 'chat', options = {}) {
    // User chat (priority >= CHAT=10) bypasses rate limits
    if ((options?.priority || 0) < 10 && !this._checkRateLimit(taskType, options)) {
      throw new Error(`[LLM] Rate limited — ${taskType} budget exhausted. Try again later.`);
    }

    const start = Date.now();
    this._metrics.totalCalls++;
    this._metrics.callsByTaskType[taskType] = (this._metrics.callsByTaskType[taskType] || 0) + 1;
    this._metrics.callsByBackend[this._bridge.activeBackend] =
      (this._metrics.callsByBackend[this._bridge.activeBackend] || 0) + 1;
    this._metrics.lastCallAt = new Date().toISOString();

    try {
      const result = await this._bridge.chat(systemPrompt, messages, taskType, options);
      const latency = Date.now() - start;
      this._recordLatency(latency);

      // v3.5.0: Improved token estimation
      const promptTokens = estimateTokens(systemPrompt, taskType) +
        messages.reduce((s, m) => s + estimateTokens(m.content, taskType), 0);
      const responseTokens = estimateTokens(result, taskType);
      this._metrics.totalTokensEstimated += promptTokens + responseTokens;

      this.bus.emit('llm:call-complete', {
        taskType, backend: this._bridge.activeBackend,
        latencyMs: latency, promptTokens, responseTokens,
      }, { source: 'LLMPort' });

      return result;
    } catch (err) {
      this._metrics.errors++;
      this.bus.emit('llm:call-error', {
        taskType, backend: this._bridge.activeBackend, error: err.message,
      }, { source: 'LLMPort' });
      throw err;
    }
  }

  async streamChat(systemPrompt, messages = [], onChunk, abortSignal, taskType = 'chat', options = {}) {
    if ((options?.priority || 0) < 10 && !this._checkRateLimit(taskType, options)) {
      throw new Error(`[LLM] Rate limited — ${taskType} budget exhausted. Try again later.`);
    }

    const start = Date.now();
    this._metrics.totalStreamCalls++;
    this._metrics.callsByTaskType[taskType] = (this._metrics.callsByTaskType[taskType] || 0) + 1;
    this._metrics.lastCallAt = new Date().toISOString();

    try {
      const result = await this._bridge.streamChat(systemPrompt, messages, onChunk, abortSignal, taskType, options);
      this._recordLatency(Date.now() - start);
      return result;
    } catch (err) {
      this._metrics.errors++;
      throw err;
    }
  }

  async chatStructured(systemPrompt, messages = [], taskType = 'analysis', options = {}) {
    if ((options?.priority || 0) < 10 && !this._checkRateLimit(taskType, options)) {
      throw new Error(`[LLM] Rate limited — ${taskType} budget exhausted. Try again later.`);
    }

    this._metrics.totalCalls++;
    this._metrics.callsByTaskType[taskType] = (this._metrics.callsByTaskType[taskType] || 0) + 1;
    this._metrics.lastCallAt = new Date().toISOString();
    const start = Date.now();

    try {
      const result = await this._bridge.chatStructured(systemPrompt, messages, taskType);
      this._recordLatency(Date.now() - start);
      return result;
    } catch (err) {
      this._metrics.errors++;
      throw err;
    }
  }

  // ── Passthrough ─────────────────────────────────────

  get activeModel() { return this._bridge.activeModel; }
  get activeBackend() { return this._bridge.activeBackend; }
  get availableModels() { return this._bridge.availableModels; }
  async detectAvailable() { return this._bridge.detectAvailable(); }
  async switchTo(modelName) { return this._bridge.switchTo(modelName); }
  configureBackend(name, cfg) { return this._bridge.configureBackend(name, cfg); }
  getConcurrencyStats() { return this._bridge.getConcurrencyStats(); }
  get temperatures() { return this._bridge.temperatures; }
  get backends() { return this._bridge.backends; }
  _robustJsonParse(text) { return this._bridge._robustJsonParse?.(text) || null; }

  // ── Metrics & Status ────────────────────────────────

  getMetrics() {
    return { ...this._metrics, _latencies: undefined };
  }

  /** Get rate limit status (for dashboard / HealthMonitor) */
  getRateLimitStatus() {
    return {
      bucket: this._bucket.getStatus(),
      hourlyBudgets: this._hourlyBudget.getStatus(),
      rateLimited: this._metrics.rateLimited,
    };
  }

  /** Reset metrics and rate limit counters (e.g. per session) */
  resetMetrics() {
    this._metrics.totalCalls = 0;
    this._metrics.totalStreamCalls = 0;
    this._metrics.totalTokensEstimated = 0;
    this._metrics.callsByTaskType = {};
    this._metrics.callsByBackend = {};
    this._metrics.errors = 0;
    this._metrics.rateLimited = 0;
    this._metrics.avgLatencyMs = 0;
    this._metrics._latencies = [];
    this._hourlyBudget.reset();
  }

  _recordLatency(ms) {
    const buf = this._metrics._latencies;
    buf.push(ms);
    if (buf.length > 50) buf.shift();
    this._metrics.avgLatencyMs = Math.round(buf.reduce((a, b) => a + b, 0) / buf.length);
  }
}

// ── Test Mock ─────────────────────────────────────────────
// Drop-in mock for unit tests. No ModelBridge needed.

class MockLLM extends LLMPort {
  constructor(responses = {}) {
    super();
    this._responses = responses;
    this._calls = [];
    this._activeModel = 'mock-model';
    this._activeBackend = 'mock';
  }

  async chat(systemPrompt, messages = [], taskType = 'chat', options = {}) {
    this._calls.push({ systemPrompt, messages, taskType, options });
    const resp = this._responses[taskType] || this._responses.default || 'mock response';
    return typeof resp === 'function' ? resp(systemPrompt, messages, taskType) : resp;
  }

  async streamChat(systemPrompt, messages = [], onChunk, abortSignal, taskType = 'chat') {
    const text = await this.chat(systemPrompt, messages, taskType);
    for (const word of text.split(' ')) {
      if (abortSignal?.aborted) return;
      onChunk(word + ' ');
    }
  }

  get activeModel() { return this._activeModel; }
  get activeBackend() { return this._activeBackend; }
  get availableModels() { return [{ name: this._activeModel, backend: 'mock' }]; }
  async detectAvailable() { return this.availableModels; }
  async switchTo(m) { this._activeModel = m; return { ok: true }; }
  configureBackend() {}
  getConcurrencyStats() { return { active: 0, queued: 0 }; }
  get temperatures() { return { code: 0.1, analysis: 0.3, chat: 0.7, creative: 0.9 }; }
  get backends() { return { ollama: { baseUrl: 'http://127.0.0.1:11434' } }; }
  _robustJsonParse(text) { try { return JSON.parse(text); } catch (_e) { console.debug('[catch] JSON parse:', _e.message); return null; } }

  async chatStructured(systemPrompt, messages = [], taskType = 'analysis') {
    const text = await this.chat(systemPrompt, messages, taskType);
    try { return JSON.parse(text); } catch (_e) { console.debug('[catch] chatStructured JSON parse:', _e.message); return { _raw: text, _parseError: true }; }
  }

  /** Test helper: get all recorded calls */
  getCalls() { return this._calls; }
  /** Test helper: get last call */
  lastCall() { return this._calls[this._calls.length - 1]; }
  /** Test helper: set response for taskType */
  setResponse(taskType, response) { this._responses[taskType] = response; }
}

module.exports = { LLMPort, ModelBridgeAdapter, MockLLM, TokenBucket, HourlyBudget, estimateTokens };
