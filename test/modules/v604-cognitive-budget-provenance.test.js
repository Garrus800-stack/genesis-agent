// ============================================================
// Test: v6.0.4 — CognitiveBudget + ExecutionProvenance
// ============================================================

const { describe, test, assert, assertEqual, run } = require('../harness');

// ── Mock helpers ─────────────────────────────────────────
function mockBus() {
  const _listeners = new Map();
  const _emitted = [];
  return {
    on(event, fn, opts) {
      if (!_listeners.has(event)) _listeners.set(event, []);
      _listeners.get(event).push({ fn, ...opts });
      return () => { const a = _listeners.get(event); if (a) { const i = a.findIndex(l => l.fn === fn); if (i >= 0) a.splice(i, 1); } };
    },
    emit(event, data, meta) { _emitted.push({ event, data, meta }); const ls = _listeners.get(event); if (ls) for (const l of ls) l.fn(data); },
    fire(event, data, meta) { this.emit(event, data, meta); },
    _emitted,
    _listeners,
  };
}

// ═══════════════════════════════════════════════════════════
// CognitiveBudget
// ═══════════════════════════════════════════════════════════

const { CognitiveBudget, TIERS } = require('../../src/agent/intelligence/CognitiveBudget');

describe('CognitiveBudget — Tier Assessment', () => {
  test('exports TIERS with 4 levels', () => {
    assert(TIERS.TRIVIAL, 'should have TRIVIAL');
    assert(TIERS.MODERATE, 'should have MODERATE');
    assert(TIERS.COMPLEX, 'should have COMPLEX');
    assert(TIERS.EXTREME, 'should have EXTREME');
  });

  test('constructs with defaults', () => {
    const cb = new CognitiveBudget();
    assert(cb, 'should construct');
    assert(cb._enabled, 'should be enabled by default');
  });

  test('disabled mode returns complex for everything', () => {
    const cb = new CognitiveBudget({ config: { enabled: false } });
    const result = cb.assess('hi');
    assertEqual(result.tierName, 'complex', 'disabled → always complex');
  });

  // ── TRIVIAL ──
  test('greetings are trivial', () => {
    const cb = new CognitiveBudget();
    assertEqual(cb.assess('hi').tierName, 'trivial');
    assertEqual(cb.assess('Hello!').tierName, 'trivial');
    assertEqual(cb.assess('Hallo').tierName, 'trivial');
    assertEqual(cb.assess('Moin').tierName, 'trivial');
  });

  test('yes/no/thanks are trivial', () => {
    const cb = new CognitiveBudget();
    assertEqual(cb.assess('ja').tierName, 'trivial');
    assertEqual(cb.assess('nein').tierName, 'trivial');
    assertEqual(cb.assess('danke!').tierName, 'trivial');
    assertEqual(cb.assess('ok').tierName, 'trivial');
  });

  test('simple math is trivial', () => {
    const cb = new CognitiveBudget();
    assertEqual(cb.assess('Was ist 2+2?').tierName, 'trivial');
    assertEqual(cb.assess('What is 10 * 5?').tierName, 'trivial');
  });

  test('help/status/version are trivial', () => {
    const cb = new CognitiveBudget();
    assertEqual(cb.assess('help').tierName, 'trivial');
    assertEqual(cb.assess('status').tierName, 'trivial');
    assertEqual(cb.assess('version').tierName, 'trivial');
  });

  test('empty message is trivial', () => {
    const cb = new CognitiveBudget();
    assertEqual(cb.assess('').tierName, 'trivial');
  });

  test('short messages without complexity are trivial', () => {
    const cb = new CognitiveBudget();
    assertEqual(cb.assess('wie geht es?').tierName, 'trivial');
  });

  // ── COMPLEX ──
  test('code generation is complex', () => {
    const cb = new CognitiveBudget();
    assertEqual(cb.assess('Erstelle eine REST API mit Express').tierName, 'complex');
    assertEqual(cb.assess('Create a function that sorts arrays').tierName, 'complex');
  });

  test('multi-step instructions are complex', () => {
    const cb = new CognitiveBudget();
    assertEqual(cb.assess('Erstelle eine Datei und schreibe Tests dafür').tierName, 'complex');
  });

  test('shell commands are complex', () => {
    const cb = new CognitiveBudget();
    assertEqual(cb.assess('$ npm install express').tierName, 'complex');
    assertEqual(cb.assess('git status').tierName, 'complex');
  });

  test('self-modification is complex', () => {
    const cb = new CognitiveBudget();
    assertEqual(cb.assess('Modify the IntentRouter to handle German better').tierName, 'complex');
  });

  // ── EXTREME ──
  test('project-wide refactoring is extreme', () => {
    const cb = new CognitiveBudget();
    assertEqual(cb.assess('Refactore das gesamte Projekt auf TypeScript').tierName, 'extreme');
  });

  test('deployment is extreme', () => {
    const cb = new CognitiveBudget();
    assertEqual(cb.assess('Deploy to production').tierName, 'extreme');
  });

  test('clone/spawn is extreme', () => {
    const cb = new CognitiveBudget();
    assertEqual(cb.assess('Clone yourself').tierName, 'extreme');
  });

  // ── MODERATE ──
  test('medium questions are moderate', () => {
    const cb = new CognitiveBudget();
    assertEqual(cb.assess('Erkläre mir wie Promises in JavaScript funktionieren').tierName, 'moderate');
  });

  test('long messages default to moderate', () => {
    const cb = new CognitiveBudget();
    const long = 'Ich habe ein Problem mit meinem Code. ' + 'x'.repeat(200);
    assertEqual(cb.assess(long).tierName, 'moderate');
  });

  test('intent hint overrides to complex', () => {
    const cb = new CognitiveBudget();
    const result = cb.assess('do it', { intentHint: 'execute-code' });
    assertEqual(result.tierName, 'complex');
  });
});

describe('CognitiveBudget — Section Filtering', () => {
  test('trivial tier skips organism sections', () => {
    const cb = new CognitiveBudget();
    const budget = cb.assess('hi');
    assert(!cb.shouldIncludeSection('_organismContext', budget), 'organism skipped in trivial');
    assert(!cb.shouldIncludeSection('_emotionalState', budget), 'emotional skipped in trivial');
  });

  test('trivial tier skips consciousness sections', () => {
    const cb = new CognitiveBudget();
    const budget = cb.assess('hi');
    assert(!cb.shouldIncludeSection('_consciousnessContext', budget), 'consciousness skipped');
    assert(!cb.shouldIncludeSection('_attentionalGate', budget), 'attention skipped');
  });

  test('complex tier includes everything', () => {
    const cb = new CognitiveBudget();
    const budget = cb.assess('Create a REST API');
    assert(cb.shouldIncludeSection('_organismContext', budget), 'organism included');
    assert(cb.shouldIncludeSection('_consciousnessContext', budget), 'consciousness included');
  });

  test('moderate tier includes organism, skips consciousness', () => {
    const cb = new CognitiveBudget();
    const budget = cb.assess('Erkläre mir Quicksort im Detail bitte');
    assert(cb.shouldIncludeSection('_organismContext', budget), 'organism included');
    assert(!cb.shouldIncludeSection('_consciousnessContext', budget), 'consciousness skipped');
  });
});

describe('CognitiveBudget — Stats', () => {
  test('tracks tier distribution', () => {
    const cb = new CognitiveBudget();
    cb.assess('hi');
    cb.assess('hi');
    cb.assess('Create a REST API');
    const stats = cb.getStats();
    assertEqual(stats.total, 3);
    assertEqual(stats.trivial, 2);
    assertEqual(stats.complex, 1);
  });

  test('getReport includes distribution percentages', () => {
    const cb = new CognitiveBudget();
    cb.assess('hi');
    cb.assess('Create a REST API');
    const report = cb.getReport();
    assertEqual(report.distribution.trivial, 50);
    assertEqual(report.distribution.complex, 50);
  });
});

// ═══════════════════════════════════════════════════════════
// ExecutionProvenance
// ═══════════════════════════════════════════════════════════

const { ExecutionProvenance } = require('../../src/agent/intelligence/ExecutionProvenance');

describe('ExecutionProvenance — Trace Lifecycle', () => {
  test('constructs with defaults', () => {
    const ep = new ExecutionProvenance();
    assert(ep, 'should construct');
    assert(ep._enabled, 'should be enabled');
  });

  test('beginTrace creates a trace', () => {
    const ep = new ExecutionProvenance();
    const id = ep.beginTrace('Hello world');
    assert(id, 'should return traceId');
    const trace = ep.getTrace(id);
    assert(trace, 'trace should exist');
    assertEqual(trace.input.message, 'Hello world');
  });

  test('beginTrace with custom correlationId', () => {
    const ep = new ExecutionProvenance();
    const id = ep.beginTrace('test', { correlationId: 'custom-123' });
    assertEqual(id, 'custom-123');
  });

  test('endTrace completes the trace', () => {
    const ep = new ExecutionProvenance();
    const id = ep.beginTrace('test');
    ep.endTrace(id, { tokens: 42, latencyMs: 150 });
    const trace = ep.getTrace(id);
    assertEqual(trace.response.tokens, 42);
    assertEqual(trace.response.latencyMs, 150);
    assertEqual(trace.response.outcome, 'success');
    assert(trace.duration > 0 || trace.duration === 0, 'should have duration');
  });

  test('endTrace records error outcome', () => {
    const ep = new ExecutionProvenance();
    const id = ep.beginTrace('test');
    ep.endTrace(id, { latencyMs: 50, error: 'timeout' });
    const trace = ep.getTrace(id);
    assertEqual(trace.response.outcome, 'error');
    assertEqual(trace.response.error, 'timeout');
  });

  test('disabled mode returns empty traceId', () => {
    const ep = new ExecutionProvenance({ config: { enabled: false } });
    const id = ep.beginTrace('test');
    assertEqual(id, '');
  });
});

describe('ExecutionProvenance — Recording', () => {
  test('recordBudget stores tier info', () => {
    const ep = new ExecutionProvenance();
    const id = ep.beginTrace('hi');
    ep.recordBudget(id, { tierName: 'trivial', reason: 'greeting' });
    const trace = ep.getTrace(id);
    assertEqual(trace.budget.tier, 'trivial');
    assertEqual(trace.budget.reason, 'greeting');
  });

  test('recordIntent stores classification', () => {
    const ep = new ExecutionProvenance();
    const id = ep.beginTrace('Create API');
    ep.recordIntent(id, { type: 'execute-code', confidence: 0.85, method: 'regex' });
    const trace = ep.getTrace(id);
    assertEqual(trace.intent.type, 'execute-code');
    assertEqual(trace.intent.confidence, 0.85);
  });

  test('recordPrompt stores section data', () => {
    const ep = new ExecutionProvenance();
    const id = ep.beginTrace('test');
    ep.recordPrompt(id, {
      active: ['_formatting', '_knowledgeContext', '_safetyContext'],
      skipped: ['_consciousnessContext', '_organismContext'],
      totalTokens: 2000,
    });
    const trace = ep.getTrace(id);
    assertEqual(trace.prompt.sectionsActive, 3);
    assertEqual(trace.prompt.sectionsSkipped, 2);
    assertEqual(trace.prompt.totalTokens, 2000);
  });

  test('recordModel stores model selection', () => {
    const ep = new ExecutionProvenance();
    const id = ep.beginTrace('test');
    ep.recordModel(id, { name: 'claude-3.5-sonnet', backend: 'anthropic', temperature: 0.77 });
    const trace = ep.getTrace(id);
    assertEqual(trace.model.name, 'claude-3.5-sonnet');
    assertEqual(trace.model.temperature, 0.77);
  });

  test('recordContext stores context details', () => {
    const ep = new ExecutionProvenance();
    const id = ep.beginTrace('test');
    ep.recordContext(id, { historyTokens: 1500, systemTokens: 3000, truncated: false, compressed: true });
    const trace = ep.getTrace(id);
    assertEqual(trace.context.historyTokens, 1500);
    assert(trace.context.compressed, 'should be compressed');
  });

  test('recordAgentLoop stores step data', () => {
    const ep = new ExecutionProvenance();
    const id = ep.beginTrace('test');
    ep.recordAgentLoop(id, { steps: 3, approved: true, success: true, duration: 5000 });
    const trace = ep.getTrace(id);
    assertEqual(trace.agentLoop.steps, 3);
    assert(trace.agentLoop.success, 'should be successful');
  });

  test('records to nonexistent trace silently', () => {
    const ep = new ExecutionProvenance();
    // Should not throw
    ep.recordBudget('nonexistent', { tierName: 'trivial', reason: 'test' });
    ep.recordIntent('nonexistent', { type: 'general', confidence: 0.5 });
    ep.endTrace('nonexistent', { latencyMs: 0 });
    assert(true, 'should not throw');
  });
});

describe('ExecutionProvenance — Query', () => {
  test('getRecentTraces returns last N', () => {
    const ep = new ExecutionProvenance();
    ep.beginTrace('one'); ep.beginTrace('two'); ep.beginTrace('three');
    const recent = ep.getRecentTraces(2);
    assertEqual(recent.length, 2);
    assertEqual(recent[1].input.message, 'three');
  });

  test('getLastTrace returns last completed trace', () => {
    const ep = new ExecutionProvenance();
    const id1 = ep.beginTrace('first');
    ep.endTrace(id1, { latencyMs: 100 });
    const id2 = ep.beginTrace('second'); // not completed
    const last = ep.getLastTrace();
    assertEqual(last.input.message, 'first');
  });

  test('getActiveTrace returns in-flight trace', () => {
    const ep = new ExecutionProvenance();
    ep.beginTrace('active');
    const active = ep.getActiveTrace();
    assert(active, 'should have active trace');
    assertEqual(active.input.message, 'active');
  });

  test('getActiveTrace returns null after endTrace', () => {
    const ep = new ExecutionProvenance();
    const id = ep.beginTrace('done');
    ep.endTrace(id, { latencyMs: 50 });
    assertEqual(ep.getActiveTrace(), null);
  });

  test('ring buffer evicts oldest traces', () => {
    const ep = new ExecutionProvenance({ config: { maxTraces: 3 } });
    ep.beginTrace('a'); ep.beginTrace('b'); ep.beginTrace('c'); ep.beginTrace('d');
    const all = ep.getRecentTraces(10);
    assertEqual(all.length, 3);
    assertEqual(all[0].input.message, 'b'); // 'a' evicted
  });
});

describe('ExecutionProvenance — Formatting', () => {
  test('formatTrace produces readable output', () => {
    const ep = new ExecutionProvenance();
    const id = ep.beginTrace('Create a REST API');
    ep.recordBudget(id, { tierName: 'complex', reason: 'pattern match' });
    ep.recordIntent(id, { type: 'execute-code', confidence: 0.85, method: 'regex' });
    ep.recordPrompt(id, { active: ['_formatting', '_safety'], skipped: ['_consciousness'], totalTokens: 2000 });
    ep.recordModel(id, { name: 'claude-3.5-sonnet', backend: 'anthropic', temperature: 0.7 });
    ep.endTrace(id, { tokens: 300, latencyMs: 1500 });

    const output = ep.formatTrace(ep.getTrace(id));
    assert(output.includes('Trace'), 'should have trace header');
    assert(output.includes('complex'), 'should show tier');
    assert(output.includes('execute-code'), 'should show intent');
    assert(output.includes('claude-3.5-sonnet'), 'should show model');
    assert(output.includes('300 tokens'), 'should show response tokens');
  });

  test('formatTrace handles null gracefully', () => {
    const ep = new ExecutionProvenance();
    const output = ep.formatTrace(null);
    assert(output.includes('no trace'), 'should show no trace message');
  });
});

describe('ExecutionProvenance — Stats', () => {
  test('tracks total traces and avg latency', () => {
    const ep = new ExecutionProvenance();
    const id1 = ep.beginTrace('a');
    ep.endTrace(id1, { latencyMs: 100 });
    const id2 = ep.beginTrace('b');
    ep.endTrace(id2, { latencyMs: 200 });
    const stats = ep.getStats();
    assertEqual(stats.totalTraces, 2);
    assert(typeof stats.avgLatencyMs === 'number', 'should have avg latency');
  });

  test('getReport includes recent trace summaries', () => {
    const ep = new ExecutionProvenance();
    const id = ep.beginTrace('test');
    ep.recordBudget(id, { tierName: 'trivial', reason: 'test' });
    ep.endTrace(id, { latencyMs: 50 });
    const report = ep.getReport();
    assert(report.recentTraces.length > 0, 'should have recent traces');
    assertEqual(report.recentTraces[0].tier, 'trivial');
  });
});

describe('ExecutionProvenance — Event Wiring', () => {
  test('start wires listeners, stop cleans up', () => {
    const bus = mockBus();
    const ep = new ExecutionProvenance({ bus });
    ep.start();
    assert(ep._unsubs.length > 0, 'should have subscriptions');
    const count = ep._unsubs.length;
    ep.stop();
    // After stop, _unsubs should be cleared
    assertEqual(ep._unsubs.length, 0, 'should clean up subscriptions');
  });

  test('captures intent:classified events into active trace', () => {
    const bus = mockBus();
    const ep = new ExecutionProvenance({ bus });
    ep.start();
    const id = ep.beginTrace('test');
    bus.emit('intent:classified', { type: 'general', confidence: 0.5, method: 'regex' });
    const trace = ep.getTrace(id);
    assert(trace.intent, 'should capture intent');
    assertEqual(trace.intent.type, 'general');
    ep.stop();
  });

  test('captures side effects into active trace', () => {
    const bus = mockBus();
    const ep = new ExecutionProvenance({ bus });
    ep.start();
    const id = ep.beginTrace('test');
    bus.emit('shell:executed', { command: 'ls' });
    const trace = ep.getTrace(id);
    assertEqual(trace.sideEffects.length, 1);
    assertEqual(trace.sideEffects[0].event, 'shell:executed');
    ep.stop();
  });
});

// ═══════════════════════════════════════════════════════════

if (require.main === module) run();
