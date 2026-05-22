// @ts-checked-v5.6
// GENESIS — LessonsAutoCapture.js
// Bus-listener layer that converts runtime events into LessonsStore.record() calls.
// Extracted from LessonsStore in v7.8.8 to keep the store focused on persistence,
// scoring, and recall — auto-capture is a separate concern with its own lifecycle.
//
// Subscribes to:
//   online-learning:streak-detected, online-learning:escalation-needed,
//   online-learning:temp-adjusted, workspace:consolidate,
//   prompt-evolution:promoted, shell:outcome, dream:complete
//
// Writes via store.record(). Increments store._stats.autoCaptures on each hook.

'use strict';

const { createLogger } = require('../core/Logger');
const _log = createLogger('LessonsAutoCapture');

class LessonsAutoCapture {
  /**
   * @param {object} deps
   * @param {object} deps.bus           - EventBus (required)
   * @param {object} deps.store         - LessonsStore instance (required)
   */
  constructor({ bus, store }) {
    if (!bus || !store) throw new Error('LessonsAutoCapture: bus and store are required');
    this.bus = bus;
    this.store = store;
    this._unsubs = [];
    // v7.9.5 live-fix: per-trigger counters so we can tell whether
    // 0 lessons over 2h means "no events fired" or "events fired but
    // got rejected". Surfaced via getDiagnostics() and on stop().
    this._counts = {
      'online-learning:streak-detected': { received: 0, captured: 0 },
      'online-learning:escalation-needed': { received: 0, captured: 0 },
      'online-learning:temp-adjusted': { received: 0, captured: 0 },
      'workspace:consolidate': { received: 0, captured: 0 },
      'prompt-evolution:promoted': { received: 0, captured: 0 },
      'shell:outcome': { received: 0, captured: 0 },
      'dream:complete': { received: 0, captured: 0 },
    };
  }

  /** v7.9.5 live-fix: per-trigger counts for diagnostics. */
  getDiagnostics() { return { ...this._counts }; }

  start() {
    const sub = (event, fn) => {
      const wrapped = (d) => {
        const c = this._counts[event];
        if (c) c.received++;
        const prev = this.store._stats?.autoCaptures || 0;
        try { fn(d); } catch (err) { _log.debug(`[AUTO-CAPTURE] ${event} handler error: ${err.message}`); }
        const next = this.store._stats?.autoCaptures || 0;
        if (next > prev && c) c.captured++;
      };
      const off = this.bus.on(event, wrapped, { source: 'LessonsAutoCapture' });
      if (off) this._unsubs.push(off);
    };

    // ── OnlineLearner events ────────────────────────────
    sub('online-learning:streak-detected',   (d) => this._captureStreak(d));
    sub('online-learning:escalation-needed', (d) => this._captureEscalation(d));
    sub('online-learning:temp-adjusted',     (d) => this._captureTemp(d));

    // ── High-surprise consolidation ─────────────────────
    sub('workspace:consolidate', (d) => this._captureWorkspace(d));

    // ── Prompt evolution ─────────────────────────────────
    sub('prompt-evolution:promoted', (d) => this._capturePrompt(d));

    // ── Shell outcomes ───────────────────────────────────
    sub('shell:outcome', (d) => this._captureShell(d));

    // ── Dream insights ───────────────────────────────────
    sub('dream:complete', (d) => this._captureDream(d));

    _log.info('[AUTO-CAPTURE] 7 lesson-capture hooks active');
  }

  stop() {
    for (const off of this._unsubs) { try { off(); } catch (_e) {} }
    this._unsubs = [];
    // v7.9.5 live-fix: surface per-trigger received/captured counts so the
    // common "0 lessons after long session" pattern can be diagnosed.
    const summary = Object.entries(this._counts || {})
      .filter(([_, v]) => v.received > 0)
      .map(([k, v]) => `${k}: ${v.captured}/${v.received}`)
      .join(', ');
    if (summary) _log.info(`[AUTO-CAPTURE] Triggers fired (captured/received): ${summary}`);
    else _log.info('[AUTO-CAPTURE] No triggers fired during this session');
  }

  // ── Capture impls — each translates an event payload into a record() call.
  // store._stats.autoCaptures is incremented to preserve pre-v7.8.8 metric.

  _captureStreak(data) {
    if (!data?.suggestion) return;
    this.store._stats.autoCaptures++;
    this.store.record({
      category: data.actionType || 'general',
      insight: `After ${data.consecutiveFailures} failures on ${data.actionType}, switching to "${data.suggestion.promptStyle}" at temperature ${data.suggestion.temperature?.toFixed(2)} resolved the issue`,
      strategy: { promptStyle: data.suggestion.promptStyle, temperature: data.suggestion.temperature, trigger: 'failure-streak' },
      evidence: { surprise: 0.6, successRate: 0, sampleSize: data.consecutiveFailures, confidence: 0.5 },
      tags: [data.actionType, 'streak-recovery'],
      source: 'streak',
    });
  }

  _captureEscalation(data) {
    if (!data?.actionType) return;
    this.store._stats.autoCaptures++;
    this.store.record({
      category: data.actionType,
      insight: `Model "${data.currentModel}" insufficient for ${data.actionType} tasks - high surprise (${data.surprise?.toFixed(2)}) indicates capability gap`,
      strategy: { model: data.currentModel, trigger: 'escalation' },
      evidence: { surprise: data.surprise || 0.7, confidence: 0.6 },
      tags: [data.actionType, data.currentModel, 'model-limit'],
      source: 'escalation',
    });
  }

  _captureTemp(data) {
    if (!data?.actionType) return;
    this.store._stats.autoCaptures++;
    const direction = data.newTemp > data.oldTemp ? 'raised' : 'lowered';
    this.store.record({
      category: data.actionType,
      insight: `Temperature ${direction} from ${data.oldTemp?.toFixed(2)} to ${data.newTemp?.toFixed(2)} for ${data.actionType} (success rate: ${Math.round((data.successRate || 0) * 100)}%)`,
      strategy: { temperature: data.newTemp, previousTemp: data.oldTemp, model: data.model },
      evidence: { successRate: data.successRate || 0, sampleSize: data.windowSize || 10, confidence: 0.4 },
      tags: [data.actionType, data.model, 'temperature'],
      source: 'temp-tuning',
    });
  }

  _captureWorkspace(data) {
    if (!data?.items || data.items.length === 0) return;
    const top = data.items[0];
    if (top.salience < 0.6) return;
    this.store._stats.autoCaptures++;
    this.store.record({
      category: 'goal-execution',
      insight: `Key insight during goal "${data.goalId}": ${typeof top.value === 'string' ? top.value.slice(0, 150) : JSON.stringify(top.value).slice(0, 150)}`,
      evidence: { surprise: top.salience, confidence: Math.min(top.salience, 0.7) },
      tags: ['workspace', top.key],
      source: 'workspace-consolidation',
    });
  }

  _capturePrompt(data) {
    if (!data?.section || !data?.variant) return;
    this.store._stats.autoCaptures++;
    this.store.record({
      category: 'prompt-optimization',
      insight: `Prompt section "${data.section}" improved ${Math.round((data.improvement || 0) * 100)}% with variant "${data.variant}" after ${data.trials || 0} trials`,
      strategy: { promptStyle: data.variant, section: data.section },
      evidence: { successRate: data.improvement || 0, sampleSize: data.trials || 25, confidence: 0.7 },
      tags: ['prompt-evolution', data.section],
      source: 'prompt-evolution',
    });
  }

  _captureShell(data) {
    if (!data?.command) return;
    this.store.record({
      category: data.success ? 'shell-success' : 'shell-failure',
      insight: data.success
        ? `Command "${data.command}" works on ${data.platform}`
        : `Command "${data.command}" failed on ${data.platform}: ${data.error || 'unknown'}`,
      strategy: { command: data.command, platform: data.platform },
      tags: ['shell', data.platform, data.success ? 'works' : 'fails'],
      source: 'shell-outcome',
      evidence: { successRate: data.success ? 1 : 0, confidence: 0.8, sampleSize: 1 },
    });
  }

  _captureDream(data) {
    if (!data || (data.insights <= 0 && data.newSchemas <= 0)) return;
    this.store.record({
      category: 'dream-insight',
      insight: `Dream #${data.dreamNumber}: ${data.insights} insights, ${data.newSchemas} new schemas, ${data.strengthened} strengthened memories`,
      tags: ['dream', 'autonomous'],
      source: 'dream-cycle',
      evidence: { confidence: 0.5, sampleSize: 1, successRate: 0.5 },
    });
  }
}

module.exports = { LessonsAutoCapture };
