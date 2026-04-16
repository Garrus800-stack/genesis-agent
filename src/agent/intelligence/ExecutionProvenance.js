// @ts-check
// ============================================================
// GENESIS — ExecutionProvenance.js (v6.0.4)
//
// Jede Genesis-Antwort hat eine beweisbare Kausalkette.
// Nicht nur "was hat das LLM gesagt" sondern "WARUM hat
// das LLM das gesagt".
//
// Trace-Struktur:
//   requestId → {
//     input:       { message, timestamp }
//     budget:      { tier, reason }
//     intent:      { type, confidence, method }
//     prompt:      { sectionsActive, sectionsSkipped, totalTokens }
//     context:     { historyTokens, truncated, compressed }
//     model:       { name, backend, scoreBreakdown, temperature }
//     response:    { tokens, latencyMs, outcome }
//     sideEffects: { eventsEmitted, servicesTriggered }
//   }
//
// Design:
//   - Collects data via EventBus listeners during request lifecycle
//   - Each request gets a unique traceId (correlationId)
//   - Ring buffer: keeps last N traces (default 100)
//   - Queryable via CLI: /trace [id], /trace last
//   - Dashboard: Provenance viewer panel
//   - Zero performance impact: all listeners are passive observers
//
// Integration:
//   ChatOrchestrator → beginTrace(message) → returns traceId
//   PromptBuilder    → recordSections(traceId, sections)
//   ModelBridge      → recordModelSelection(traceId, model, score)
//   AgentLoop        → recordSteps(traceId, steps)
//   ChatOrchestrator → endTrace(traceId, response)
//
// Why nobody has this:
//   Other agents log inputs and outputs. Nobody logs the
//   decision chain — which prompt sections were active,
//   which gates filtered, which signals influenced which
//   parameters. This makes debugging trivial and self-mod
//   auditable.
// ============================================================

'use strict';

const { NullBus } = require('../core/EventBus');
const { createLogger } = require('../core/Logger');
const _log = createLogger('Provenance');

class ExecutionProvenance {
  /**
   * @param {{ bus?: object, config?: object }} opts
   */
  constructor({ bus, config } = {}) {
    this.bus = bus || NullBus;
    this.cognitiveBudget = null;

    const cfg = config || {};
    this._maxTraces = cfg.maxTraces || 100;
    this._enabled = cfg.enabled !== false;

    /** @type {Map<string, object>} traceId → trace data */
    this._traces = new Map();
    /** @type {string[]} ordered trace IDs (ring buffer) */
    this._traceOrder = [];
    /** @type {string|null} currently active trace */
    this._activeTraceId = null;

    this._stats = {
      totalTraces: 0,
      avgLatencyMs: 0,
      tierDistribution: { trivial: 0, moderate: 0, complex: 0, extreme: 0 },
    };

    this._unsubs = [];
  }

  // ═══════════════════════════════════════════════════════════
  // LIFECYCLE
  // ═══════════════════════════════════════════════════════════

  start() {
    this._wireEvents();
    _log.info(`[PROVENANCE] Active — tracing enabled, buffer: ${this._maxTraces}`);
  }

  stop() {
    for (const unsub of this._unsubs) {
      try { if (typeof unsub === 'function') unsub(); } catch (_e) { /* ok */ }
    }
    this._unsubs = [];
  }

  // ═══════════════════════════════════════════════════════════
  // TRACE LIFECYCLE
  // ═══════════════════════════════════════════════════════════

  /**
   * Begin a new execution trace. Called at the start of request handling.
   *
   * @param {string} message - User input
   * @param {{ correlationId?: string }} [opts]
   * @returns {string} traceId
   */
  beginTrace(message, opts = {}) {
    if (!this._enabled) return '';

    const traceId = opts.correlationId || this._generateId();

    const trace = {
      id: traceId,
      timestamp: Date.now(),
      input: {
        message: (message || '').slice(0, 500),
        length: (message || '').length,
      },
      budget: null,
      intent: null,
      prompt: null,
      context: null,
      model: null,
      response: null,
      agentLoop: null,
      sideEffects: [],
      duration: null,
    };

    this._traces.set(traceId, trace);
    this._traceOrder.push(traceId);
    this._activeTraceId = traceId;

    // Evict oldest if over capacity
    while (this._traceOrder.length > this._maxTraces) {
      const old = this._traceOrder.shift();
      if (old) this._traces.delete(old);
    }

    return traceId;
  }

  /**
   * Record the cognitive budget assessment.
   * @param {string} traceId
   * @param {{ tierName: string, reason: string }} budget
   */
  recordBudget(traceId, budget) {
    const trace = this._traces.get(traceId);
    if (!trace) return;
    trace.budget = {
      tier: budget.tierName,
      reason: budget.reason,
    };
    if (budget.tierName) {
      this._stats.tierDistribution[budget.tierName] =
        (this._stats.tierDistribution[budget.tierName] || 0) + 1;
    }
  }

  /**
   * Record the intent classification result.
   * @param {string} traceId
   * @param {{ type: string, confidence: number, method?: string }} intent
   */
  recordIntent(traceId, intent) {
    const trace = this._traces.get(traceId);
    if (!trace) return;
    trace.intent = {
      type: intent.type,
      confidence: intent.confidence,
      method: intent.method || 'unknown',
    };
  }

  /**
   * Record which prompt sections were active/skipped.
   * @param {string} traceId
   * @param {{ active: string[], skipped: string[], totalTokens: number }} prompt
   */
  recordPrompt(traceId, prompt) {
    const trace = this._traces.get(traceId);
    if (!trace) return;
    trace.prompt = {
      sectionsActive: prompt.active?.length || 0,
      sectionsSkipped: prompt.skipped?.length || 0,
      activeList: prompt.active || [],
      skippedList: prompt.skipped || [],
      totalTokens: prompt.totalTokens || 0,
    };
  }

  /**
   * Record context assembly details.
   * @param {string} traceId
   * @param {{ historyTokens: number, systemTokens: number, truncated: boolean, compressed: boolean }} ctx
   */
  recordContext(traceId, ctx) {
    const trace = this._traces.get(traceId);
    if (!trace) return;
    trace.context = { ...ctx };
  }

  /**
   * Record model selection and parameters.
   * @param {string} traceId
   * @param {{ name: string, backend: string, score?: number, temperature?: number, reason?: string }} model
   */
  recordModel(traceId, model) {
    const trace = this._traces.get(traceId);
    if (!trace) return;
    trace.model = { ...model };
  }

  /**
   * Record agent loop execution (if triggered).
   * @param {string} traceId
   * @param {{ steps: number, approved: boolean, success: boolean, duration: number }} loop
   */
  recordAgentLoop(traceId, loop) {
    const trace = this._traces.get(traceId);
    if (!trace) return;
    trace.agentLoop = { ...loop };
  }

  /**
   * End the trace with response data.
   * @param {string} traceId
   * @param {{ tokens?: number, latencyMs: number, outcome?: string, error?: string }} response
   */
  endTrace(traceId, response) {
    const trace = this._traces.get(traceId);
    if (!trace) return;

    trace.response = {
      tokens: response.tokens || 0,
      latencyMs: response.latencyMs,
      outcome: response.outcome || (response.error ? 'error' : 'success'),
      error: response.error || null,
    };
    trace.duration = Date.now() - trace.timestamp;

    if (this._activeTraceId === traceId) {
      this._activeTraceId = null;
    }

    // Update rolling avg latency
    this._stats.totalTraces++;
    this._stats.avgLatencyMs =
      (this._stats.avgLatencyMs * (this._stats.totalTraces - 1) + trace.duration) /
      this._stats.totalTraces;
  }

  // ═══════════════════════════════════════════════════════════
  // QUERY API
  // ═══════════════════════════════════════════════════════════

  /**
   * Get a specific trace by ID.
   * @param {string} traceId
   * @returns {object|null}
   */
  getTrace(traceId) {
    return this._traces.get(traceId) || null;
  }

  /**
   * Get the most recent N traces.
   * @param {number} [count=10]
   * @returns {object[]}
   */
  getRecentTraces(count = 10) {
    const ids = this._traceOrder.slice(-count);
    return ids.map(id => this._traces.get(id)).filter(Boolean);
  }

  /**
   * Get the last completed trace.
   * @returns {object|null}
   */
  getLastTrace() {
    for (let i = this._traceOrder.length - 1; i >= 0; i--) {
      const trace = this._traces.get(this._traceOrder[i]);
      if (trace?.response) return trace;
    }
    return null;
  }

  /**
   * Get the currently active trace (in-flight request).
   * @returns {object|null}
   */
  getActiveTrace() {
    if (!this._activeTraceId) return null;
    return this._traces.get(this._activeTraceId) || null;
  }

  /**
   * Format a trace as a human-readable string (for CLI /trace).
   * @param {object} trace
   * @returns {string}
   */
  formatTrace(trace) {
    if (!trace) return '(no trace found)';
    const lines = [];
    lines.push(`── Trace ${trace.id} ──`);
    lines.push(`  Input: "${trace.input?.message?.slice(0, 80)}${(trace.input?.length || 0) > 80 ? '...' : ''}"`);

    if (trace.budget) {
      lines.push(`  Budget: ${trace.budget.tier} (${trace.budget.reason})`);
    }
    if (trace.intent) {
      lines.push(`  Intent: ${trace.intent.type} (${Math.round(trace.intent.confidence * 100)}% via ${trace.intent.method})`);
    }
    if (trace.prompt) {
      lines.push(`  Prompt: ${trace.prompt.sectionsActive} active, ${trace.prompt.sectionsSkipped} skipped (${trace.prompt.totalTokens} tokens)`);
      if (trace.prompt.skippedList?.length > 0) {
        lines.push(`    Skipped: ${trace.prompt.skippedList.join(', ')}`);
      }
    }
    if (trace.context) {
      lines.push(`  Context: ${trace.context.historyTokens || 0} history tokens${trace.context.truncated ? ' (truncated)' : ''}${trace.context.compressed ? ' (compressed)' : ''}`);
    }
    if (trace.model) {
      lines.push(`  Model: ${trace.model.name} via ${trace.model.backend}${trace.model.temperature ? ` (temp: ${trace.model.temperature})` : ''}`);
    }
    if (trace.agentLoop) {
      lines.push(`  AgentLoop: ${trace.agentLoop.steps} steps, ${trace.agentLoop.success ? 'success' : 'failed'} (${trace.agentLoop.duration}ms)`);
    }
    if (trace.response) {
      lines.push(`  Response: ${trace.response.tokens} tokens, ${trace.response.latencyMs}ms, ${trace.response.outcome}`);
      if (trace.response.error) lines.push(`    Error: ${trace.response.error}`);
    }
    if (trace.duration) {
      lines.push(`  Total: ${trace.duration}ms`);
    }

    return lines.join('\n');
  }

  /**
   * Get provenance statistics.
   * @returns {object}
   */
  getStats() {
    return {
      ...this._stats,
      activeTraces: this._traces.size,
      bufferSize: this._maxTraces,
      currentlyTracing: !!this._activeTraceId,
    };
  }

  /**
   * Full diagnostic report.
   * @returns {object}
   */
  getReport() {
    return {
      stats: this.getStats(),
      recentTraces: this.getRecentTraces(5).map(t => ({
        id: t.id,
        input: t.input?.message?.slice(0, 60),
        tier: t.budget?.tier,
        intent: t.intent?.type,
        model: t.model?.name,
        latency: t.response?.latencyMs,
        outcome: t.response?.outcome,
      })),
    };
  }

  // ═══════════════════════════════════════════════════════════
  // EVENT WIRING (passive observation)
  // ═══════════════════════════════════════════════════════════

  /** @private */
  _wireEvents() {
    // Observe intent classification
    this._unsubs.push(
      this.bus.on('intent:classified', (data) => {
        if (this._activeTraceId && data) {
          this.recordIntent(this._activeTraceId, data);
        }
      }, { source: 'ExecutionProvenance', priority: -20 })
    );

    // Observe context compression
    this._unsubs.push(
      this.bus.on('context:compressed', (data) => {
        if (this._activeTraceId && data) {
          const trace = this._traces.get(this._activeTraceId);
          if (trace) {
            trace.context = trace.context || {};
            trace.context.compressed = true;
          }
        }
      }, { source: 'ExecutionProvenance', priority: -20 })
    );

    // Observe agent loop activity
    this._unsubs.push(
      this.bus.on('agent-loop:complete', (data) => {
        if (this._activeTraceId && data) {
          this.recordAgentLoop(this._activeTraceId, data);
        }
      }, { source: 'ExecutionProvenance', priority: -20 })
    );

    // Track side effects
    this._unsubs.push(
      this.bus.on('selfmod:success', (data) => {
        this._recordSideEffect('selfmod:success', data);
      }, { source: 'ExecutionProvenance', priority: -20 })
    );
    this._unsubs.push(
      this.bus.on('shell:executed', (data) => {
        this._recordSideEffect('shell:executed', data);
      }, { source: 'ExecutionProvenance', priority: -20 })
    );
    this._unsubs.push(
      this.bus.on('tool:synthesized', (data) => {
        this._recordSideEffect('tool:synthesized', data);
      }, { source: 'ExecutionProvenance', priority: -20 })
    );
  }

  /** @private */
  _recordSideEffect(event, data) {
    if (!this._activeTraceId) return;
    const trace = this._traces.get(this._activeTraceId);
    if (trace) {
      trace.sideEffects.push({ event, summary: JSON.stringify(data).slice(0, 200), ts: Date.now() });
    }
  }

  /** @private */
  _generateId() {
    const ts = Date.now().toString(36);
    const rand = Math.random().toString(36).slice(2, 6);
    return `t-${ts}-${rand}`;
  }
}

module.exports = { ExecutionProvenance };
