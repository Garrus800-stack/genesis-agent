// ============================================================
// TEST: ReasoningTracer — Reasoning Trace UI Backend
// ============================================================

const { describe, test, assert, assertEqual, run } = require('../harness');
const { ReasoningTracer } = require('../../src/agent/cognitive/ReasoningTracer');

// ── Helpers ──────────────────────────────────────────────────

function makeBus() {
  const listeners = {};
  const emitted = [];
  return {
    on(event, fn, _opts) {
      (listeners[event] = listeners[event] || []).push(fn);
      return () => { listeners[event] = listeners[event].filter(f => f !== fn); };
    },
    emit(event, data, _meta) {
      emitted.push({ event, data });
      for (const fn of (listeners[event] || [])) fn(data);
    },
    listeners,
    emitted,
  };
}

// ── Basic ────────────────────────────────────────────────────

describe('ReasoningTracer — Basic', () => {
  test('constructor creates instance', () => {
    const bus = makeBus();
    const rt = new ReasoningTracer({ bus });
    assert(rt, 'Instance created');
  });

  test('start subscribes to events', () => {
    const bus = makeBus();
    const rt = new ReasoningTracer({ bus });
    rt.start();
    assert(bus.listeners['router:routed']?.length > 0, 'Subscribed to router:routed');
    assert(bus.listeners['online-learning:streak-detected']?.length > 0, 'Subscribed to streak');
    assert(bus.listeners['preservation:violation']?.length > 0, 'Subscribed to preservation');
    assert(bus.listeners['code:safety-blocked']?.length > 0, 'Subscribed to safety');
    assert(bus.listeners['selfmod:frozen']?.length > 0, 'Subscribed to frozen');
    rt.stop();
  });

  test('stop unsubscribes all listeners', () => {
    const bus = makeBus();
    const rt = new ReasoningTracer({ bus });
    rt.start();
    rt.stop();
    // After stop, emitting should not add traces
    bus.emit('router:routed', { selected: 'test', taskCategory: 'chat' });
    assertEqual(rt.getTraces().length, 0);
  });

  test('getTraces returns empty when no traces', () => {
    const bus = makeBus();
    const rt = new ReasoningTracer({ bus });
    const traces = rt.getTraces();
    assert(Array.isArray(traces), 'Returns array');
    assertEqual(traces.length, 0);
  });

  test('getStats returns zero counts when no traces', () => {
    const bus = makeBus();
    const rt = new ReasoningTracer({ bus });
    const stats = rt.getStats();
    assertEqual(stats.total, 0);
  });
});

// ── Model Routing ────────────────────────────────────────────

describe('ReasoningTracer — Model Routing', () => {
  test('records router:routed trace', () => {
    const bus = makeBus();
    const rt = new ReasoningTracer({ bus });
    rt.start();
    bus.emit('router:routed', { selected: 'claude-opus', taskCategory: 'code' });
    const traces = rt.getTraces();
    assertEqual(traces.length, 1);
    assertEqual(traces[0].type, 'model-route');
    assert(traces[0].summary.includes('claude-opus'), 'Summary mentions model');
    assert(traces[0].summary.includes('code'), 'Summary mentions task');
    assert(traces[0].label, 'Has label');
    assert(traces[0].age, 'Has age');
    rt.stop();
  });
});

// ── OnlineLearner Events ─────────────────────────────────────

describe('ReasoningTracer — OnlineLearner', () => {
  test('records streak detection', () => {
    const bus = makeBus();
    const rt = new ReasoningTracer({ bus });
    rt.start();
    bus.emit('online-learning:streak-detected', {
      actionType: 'code', consecutiveFailures: 3,
      suggestion: { promptStyle: 'structured', temperature: 0.3 },
    });
    const traces = rt.getTraces();
    assertEqual(traces[0].type, 'streak-switch');
    assert(traces[0].summary.includes('3×'), 'Mentions failure count');
    assert(traces[0].summary.includes('structured'), 'Mentions strategy');
    rt.stop();
  });

  test('records model escalation', () => {
    const bus = makeBus();
    const rt = new ReasoningTracer({ bus });
    rt.start();
    bus.emit('online-learning:escalation-needed', {
      actionType: 'code', currentModel: 'claude-sonnet', surprise: 0.87,
    });
    const traces = rt.getTraces();
    assertEqual(traces[0].type, 'model-escalation');
    assert(traces[0].summary.includes('claude-sonnet'), 'Mentions model');
    assert(traces[0].summary.includes('0.87'), 'Mentions surprise');
    rt.stop();
  });

  test('records temperature adjustment', () => {
    const bus = makeBus();
    const rt = new ReasoningTracer({ bus });
    rt.start();
    bus.emit('online-learning:temp-adjusted', {
      direction: 'down', oldTemp: 0.7, newTemp: 0.5, successRate: 0.4,
    });
    const traces = rt.getTraces();
    assertEqual(traces[0].type, 'temp-adjust');
    assert(traces[0].summary.includes('0.70'), 'Old temp');
    assert(traces[0].summary.includes('0.50'), 'New temp');
    rt.stop();
  });

  test('records calibration drift', () => {
    const bus = makeBus();
    const rt = new ReasoningTracer({ bus });
    rt.start();
    bus.emit('online-learning:calibration-drift', { avgSurprise: 0.72, windowSize: 10 });
    assertEqual(rt.getTraces()[0].type, 'calibration-drift');
    rt.stop();
  });

  test('records novelty shift', () => {
    const bus = makeBus();
    const rt = new ReasoningTracer({ bus });
    rt.start();
    bus.emit('online-learning:novelty-shift', { windowSize: 15 });
    assertEqual(rt.getTraces()[0].type, 'novelty-shift');
    rt.stop();
  });
});

// ── Safety Events ────────────────────────────────────────────

describe('ReasoningTracer — Safety', () => {
  test('records code:safety-blocked', () => {
    const bus = makeBus();
    const rt = new ReasoningTracer({ bus });
    rt.start();
    bus.emit('code:safety-blocked', {
      file: 'test.js', issues: [{ description: 'eval() detected' }],
    });
    const traces = rt.getTraces();
    assertEqual(traces[0].type, 'safety-block');
    assert(traces[0].summary.includes('test.js'), 'Mentions file');
    assert(traces[0].summary.includes('eval'), 'Mentions issue');
    rt.stop();
  });

  test('records preservation:violation', () => {
    const bus = makeBus();
    const rt = new ReasoningTracer({ bus });
    rt.start();
    bus.emit('preservation:violation', {
      file: 'Scanner.js', violations: [{ invariant: 'SAFETY_RULE_COUNT', detail: 'reduced' }],
    });
    const traces = rt.getTraces();
    assertEqual(traces[0].type, 'preservation-block');
    assert(traces[0].summary.includes('SAFETY_RULE_COUNT'), 'Mentions invariant');
    rt.stop();
  });

  test('records selfmod:frozen', () => {
    const bus = makeBus();
    const rt = new ReasoningTracer({ bus });
    rt.start();
    bus.emit('selfmod:frozen', { failures: 3, reason: 'threshold reached' });
    const traces = rt.getTraces();
    assertEqual(traces[0].type, 'circuit-frozen');
    assert(traces[0].summary.includes('3'), 'Mentions failures');
    rt.stop();
  });
});

// ── Step Outcomes ────────────────────────────────────────────

describe('ReasoningTracer — Steps', () => {
  test('records failed step outcome', () => {
    const bus = makeBus();
    const rt = new ReasoningTracer({ bus });
    rt.start();
    bus.emit('agent-loop:step-complete', { success: false, action: 'file-write', error: 'permission denied' });
    const traces = rt.getTraces();
    assertEqual(traces[0].type, 'step-outcome');
    assert(traces[0].summary.includes('file-write'), 'Mentions action');
    rt.stop();
  });

  test('does NOT record successful step', () => {
    const bus = makeBus();
    const rt = new ReasoningTracer({ bus });
    rt.start();
    bus.emit('agent-loop:step-complete', { success: true, action: 'file-read' });
    assertEqual(rt.getTraces().length, 0);
    rt.stop();
  });
});

// ── Ring Buffer ──────────────────────────────────────────────

describe('ReasoningTracer — Ring Buffer', () => {
  test('caps at MAX_TRACES', () => {
    const bus = makeBus();
    const rt = new ReasoningTracer({ bus });
    rt.start();
    for (let i = 0; i < 60; i++) {
      bus.emit('router:routed', { selected: `model-${i}`, taskCategory: 'chat' });
    }
    const traces = rt.getTraces(100);
    assert(traces.length <= 50, `Expected <=50, got ${traces.length}`);
    rt.stop();
  });

  test('getTraces respects limit', () => {
    const bus = makeBus();
    const rt = new ReasoningTracer({ bus });
    rt.start();
    for (let i = 0; i < 10; i++) {
      bus.emit('router:routed', { selected: `m${i}`, taskCategory: 'code' });
    }
    assertEqual(rt.getTraces(3).length, 3);
    rt.stop();
  });

  test('getTraces returns newest first', () => {
    const bus = makeBus();
    const rt = new ReasoningTracer({ bus });
    rt.start();
    bus.emit('router:routed', { selected: 'first', taskCategory: 'chat' });
    bus.emit('router:routed', { selected: 'second', taskCategory: 'chat' });
    const traces = rt.getTraces();
    assert(traces[0].summary.includes('second'), 'Newest first');
    assert(traces[1].summary.includes('first'), 'Oldest second');
    rt.stop();
  });
});

// ── Stats ────────────────────────────────────────────────────

describe('ReasoningTracer — Stats', () => {
  test('getStats counts by type', () => {
    const bus = makeBus();
    const rt = new ReasoningTracer({ bus });
    rt.start();
    bus.emit('router:routed', { selected: 'a', taskCategory: 'chat' });
    bus.emit('router:routed', { selected: 'b', taskCategory: 'code' });
    bus.emit('selfmod:frozen', { failures: 3, reason: 'test' });
    const stats = rt.getStats();
    assertEqual(stats.total, 3);
    assertEqual(stats.byType['model-route'], 2);
    assertEqual(stats.byType['circuit-frozen'], 1);
    rt.stop();
  });
});

// ── Correlation ID ───────────────────────────────────────────

describe('ReasoningTracer — Correlation', () => {
  test('records null correlationId when no context', () => {
    const bus = makeBus();
    const rt = new ReasoningTracer({ bus });
    rt.start();
    bus.emit('router:routed', { selected: 'test', taskCategory: 'chat' });
    const traces = rt.getTraces();
    assertEqual(traces[0].correlationId, null);
    rt.stop();
  });

  test('records correlationId from context when available', () => {
    const bus = makeBus();
    const rt = new ReasoningTracer({ bus });
    rt._correlationCtx = { getId: () => 'test-abc-123' };
    rt.start();
    bus.emit('router:routed', { selected: 'test', taskCategory: 'chat' });
    const traces = rt.getTraces();
    assertEqual(traces[0].correlationId, 'test-abc-123');
    rt.stop();
  });
});

run();
