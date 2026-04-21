// @ts-checked-v5.6
// ============================================================
// GENESIS — ReasoningTracer.js (v5.5.0 — Reasoning Trace UI)
//
// Collects causal reasoning traces from decision-making events
// and serves them to the Dashboard as human-readable chains.
//
// Instead of raw EventBus logs, this shows "why" behind decisions:
//   "Model escalated to claude-opus because 3 consecutive code
//    failures with surprise 0.87 on claude-sonnet"
//
// Subscribes to: ModelRouter, OnlineLearner, PreservationInvariants,
// CodeSafety, SelfMod circuit breaker, AgentLoop step outcomes.
//
// Ring buffer of last 50 traces. Each trace:
//   { ts, type, summary, detail, correlationId? }
//
// Design: Pure event subscriber. No polling. No state mutation.
// Late-bound to CorrelationContext for ID extraction.
// ============================================================

const { createLogger } = require('../core/Logger');
const _log = createLogger('ReasoningTracer');

const MAX_TRACES = 50;

// Human-readable type labels for the Dashboard
const TYPE_LABELS = {
  'model-route':       '🎯 Model',
  'streak-switch':     '🔄 Strategy',
  'model-escalation':  '⬆️ Escalate',
  'temp-adjust':       '🌡️ Temp',
  'calibration-drift': '📊 Drift',
  'novelty-shift':     '🆕 Novelty',
  'safety-block':      '🛡️ Safety',
  'preservation-block':'🔒 Preserve',
  'circuit-frozen':    '⛔ Frozen',
  'step-outcome':      '📋 Step',
};

// Declarative trace subscription table — drives start()
const TRACE_SUBSCRIPTIONS = [
  { event: 'router:routed', type: 'model-route',
    summarize: (d) => `Selected ${d.selected || 'unknown'} for ${d.taskCategory || 'task'}` },
  { event: 'online-learning:streak-detected', type: 'streak-switch',
    summarize: (d) => `${d.consecutiveFailures}× ${d.actionType} failures → switching to ${d.suggestion?.promptStyle || 'alt'} @ temp ${d.suggestion?.temperature?.toFixed(2) || '?'}` },
  { event: 'online-learning:escalation-needed', type: 'model-escalation',
    summarize: (d) => `${d.actionType} on ${d.currentModel}: surprise ${d.surprise?.toFixed(2) || '?'} → signal larger model` },
  { event: 'online-learning:temp-adjusted', type: 'temp-adjust',
    summarize: (d) => `${d.direction || 'adjust'}: ${d.oldTemp?.toFixed(2) || '?'} → ${d.newTemp?.toFixed(2) || '?'} (success rate ${((d.successRate || 0) * 100).toFixed(0)}%)` },
  { event: 'online-learning:calibration-drift', type: 'calibration-drift',
    summarize: (d) => `Prediction drift: avg surprise ${d.avgSurprise?.toFixed(2) || '?'} over ${d.windowSize || '?'} signals` },
  { event: 'online-learning:novelty-shift', type: 'novelty-shift',
    summarize: (d) => `Novelty increasing — surprise trend upward over ${d.windowSize || '?'} signals` },
  { event: 'code:safety-blocked', type: 'safety-block',
    summarize: (d) => `Blocked ${d.file || d.files?.join(', ') || 'unknown'}: ${d.issues?.map(i => i.description).join(', ') || 'safety violation'}` },
  { event: 'preservation:violation', type: 'preservation-block',
    summarize: (d) => `${d.file}: ${d.violations?.map(v => v.invariant).join(', ') || 'invariant violation'}` },
  { event: 'selfmod:frozen', type: 'circuit-frozen',
    summarize: (d) => `Self-modification frozen after ${d.failures || '?'} failures: ${d.reason || 'threshold reached'}` },
  { event: 'goal:step-complete', type: 'step-outcome',
    summarize: (d) => d.success === false ? `Step failed: ${d.action || d.step || 'unknown'} — ${d.error || 'no detail'}` : null },
];

const { applySubscriptionHelper } = require('../core/subscription-helper');

class ReasoningTracer {
  constructor({ bus }) {
    this.bus = bus;
    this._traces = [];
    this._unsubs = [];
    this._correlationCtx = null; // late-bound
  }

  start() {
    for (const sub of TRACE_SUBSCRIPTIONS) {
      this._subscribe(sub.event, (data) => {
        const summary = sub.summarize(data);
        if (summary !== null) this._record(sub.type, summary, data);
      });
    }
    _log.info(`[REASONING] Active — tracing decisions (max ${MAX_TRACES})`);
  }

  stop() {
    this._unsubAll();
    _log.info(`[REASONING] Stopped — ${this._traces.length} traces collected`);
  }

  // ── Public API ─────────────────────────────────────────

  /**
   * Get recent reasoning traces for Dashboard display.
   * @param {number} [limit=20] - max traces to return
   * @returns {Array<{ts: number, type: string, label: string, summary: string, detail: object, correlationId: string|null, age: string}>}
   */
  getTraces(limit = 20) {
    const now = Date.now();
    return this._traces.slice(-limit).reverse().map(t => ({
      ...t,
      label: TYPE_LABELS[t.type] || t.type,
      age: _formatAge(now - t.ts),
    }));
  }

  /**
   * Get trace statistics for diagnostics.
   */
  getStats() {
    const counts = {};
    for (const t of this._traces) {
      counts[t.type] = (counts[t.type] || 0) + 1;
    }
    return {
      total: this._traces.length,
      byType: counts,
      oldestAge: this._traces.length > 0 ? Date.now() - this._traces[0].ts : 0,
    };
  }

  // ── Internals ──────────────────────────────────────────

  _subscribe(event, handler) {
    this._sub(event, handler, { key: `reasoning-${event}` });
  }

  _record(type, summary, detail) {
    const correlationId = this._correlationCtx?.getId?.() || null;
    this._traces.push({
      ts: Date.now(),
      type,
      summary,
      detail,
      correlationId,
    });
    // Ring buffer
    if (this._traces.length > MAX_TRACES) {
      this._traces = this._traces.slice(-MAX_TRACES);
    }
  }
}

// Format milliseconds to human-readable age
function _formatAge(ms) {
  if (ms < 1000) return 'just now';
  if (ms < 60000) return `${Math.floor(ms / 1000)}s ago`;
  if (ms < 3600000) return `${Math.floor(ms / 60000)}m ago`;
  return `${Math.floor(ms / 3600000)}h ago`;
}

applySubscriptionHelper(ReasoningTracer);

module.exports = { ReasoningTracer };
