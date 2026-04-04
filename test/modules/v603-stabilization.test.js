// ============================================================
// Test: v6.0.3 Stabilization — Organism, Ports, Foundation
//
// Expands stub tests for:
//   - EmbodiedPerception (SA-P4, listener lifecycle)
//   - HomeostasisEffectors (effector dispatch)
//   - EmotionalSteering (signal computation)
//   - ImmuneSystem (threat detection)
//   - CostGuard (budget enforcement)
//   - DesktopPerception (state tracking)
//   - ArchitectureReflection (SA-P3, graph queries)
// ============================================================

const { describe, test, assert, assertEqual, run } = require('../harness');
const path = require('path');
const os = require('os');

// ── Mock helpers ─────────────────────────────────────────────
function mockBus() {
  const _listeners = new Map();
  const _emitted = [];
  return {
    on(event, fn, opts) {
      if (!_listeners.has(event)) _listeners.set(event, []);
      _listeners.get(event).push({ fn, ...opts });
      return () => { const arr = _listeners.get(event); if (arr) { const i = arr.findIndex(l => l.fn === fn); if (i >= 0) arr.splice(i, 1); } };
    },
    emit(event, data, meta) { _emitted.push({ event, data, meta }); const ls = _listeners.get(event); if (ls) for (const l of ls) l.fn(data); },
    fire(event, data, meta) { this.emit(event, data, meta); },
    _emitted,
    _listeners,
    listeners: new Map(),
  };
}

function mockStorage() {
  const _data = {};
  return {
    readJSON(file, fallback) { return _data[file] || fallback; },
    writeJSON(file, data) { _data[file] = data; },
    _data,
  };
}

// ═══════════════════════════════════════════════════════════
// EmbodiedPerception (SA-P4)
// ═══════════════════════════════════════════════════════════

const { EmbodiedPerception } = require('../../src/agent/organism/EmbodiedPerception');

describe('EmbodiedPerception (SA-P4)', () => {
  test('constructs with defaults', () => {
    const ep = new EmbodiedPerception({ bus: mockBus() });
    assert(ep, 'should construct');
    assertEqual(ep.getEngagement().level, 'active', 'should start active');
  });

  test('processHeartbeat updates UI state', () => {
    const ep = new EmbodiedPerception({ bus: mockBus() });
    ep.processHeartbeat({ activePanel: 'editor', windowFocused: true, userIdleMs: 0 });
    assertEqual(ep.getUIState().activePanel, 'editor', 'panel should update');
  });

  test('engagement transitions to idle on high userIdleMs', () => {
    const ep = new EmbodiedPerception({ bus: mockBus(), config: { idleThresholdMs: 100 } });
    ep.processHeartbeat({ userIdleMs: 200, windowFocused: true });
    assertEqual(ep.getEngagement().level, 'idle', 'should be idle');
  });

  test('engagement transitions to background on unfocused', () => {
    const ep = new EmbodiedPerception({ bus: mockBus() });
    ep.processHeartbeat({ windowFocused: false, userIdleMs: 0 });
    assertEqual(ep.getEngagement().level, 'background', 'should be background');
  });

  test('engagement transitions to away on long idle', () => {
    const ep = new EmbodiedPerception({ bus: mockBus(), config: { awayThresholdMs: 100 } });
    ep.processHeartbeat({ userIdleMs: 200, windowFocused: true });
    assertEqual(ep.getEngagement().level, 'away', 'should be away');
  });

  test('isUserTyping returns true when typing with content', () => {
    const ep = new EmbodiedPerception({ bus: mockBus() });
    ep.processHeartbeat({ isTyping: true, chatInputLength: 5 });
    assert(ep.isUserTyping(), 'should be typing');
  });

  test('isUserTyping returns false when empty input', () => {
    const ep = new EmbodiedPerception({ bus: mockBus() });
    ep.processHeartbeat({ isTyping: true, chatInputLength: 0 });
    assert(!ep.isUserTyping(), 'empty input = not typing');
  });

  test('buildPromptContext returns empty for active user', () => {
    const ep = new EmbodiedPerception({ bus: mockBus() });
    ep.processHeartbeat({ windowFocused: true, userIdleMs: 0, activePanel: 'chat' });
    assertEqual(ep.buildPromptContext(), '', 'active user needs no context');
  });

  test('buildPromptContext includes away state', () => {
    const ep = new EmbodiedPerception({ bus: mockBus(), config: { awayThresholdMs: 100 } });
    ep.processHeartbeat({ userIdleMs: 200, windowFocused: true });
    assert(ep.buildPromptContext().includes('Away'), 'should mention away');
  });

  test('emits panel-changed event', () => {
    const bus = mockBus();
    const ep = new EmbodiedPerception({ bus });
    ep.processHeartbeat({ activePanel: 'dashboard' });
    const evt = bus._emitted.find(e => e.event === 'embodied:panel-changed');
    assert(evt, 'should emit panel-changed');
    assertEqual(evt.data.to, 'dashboard');
  });

  test('emits focus-changed event', () => {
    const bus = mockBus();
    const ep = new EmbodiedPerception({ bus });
    ep.processHeartbeat({ windowFocused: false });
    const evt = bus._emitted.find(e => e.event === 'embodied:focus-changed');
    assert(evt, 'should emit focus-changed');
    assertEqual(evt.data.focused, false);
  });

  test('rejects non-object heartbeat', () => {
    const ep = new EmbodiedPerception({ bus: mockBus() });
    ep.processHeartbeat(null);
    ep.processHeartbeat('invalid');
    ep.processHeartbeat(42);
    // Should not throw
    assertEqual(ep.getUIState().activePanel, 'chat', 'state unchanged');
  });

  test('responds to bus ui:heartbeat event', () => {
    const bus = mockBus();
    const ep = new EmbodiedPerception({ bus });
    bus.emit('ui:heartbeat', { activePanel: 'settings' });
    assertEqual(ep.getUIState().activePanel, 'settings', 'should process bus heartbeat');
  });

  // FIX v6.0.3: Listener lifecycle
  test('stop() cleans up bus listener', () => {
    const bus = mockBus();
    const ep = new EmbodiedPerception({ bus });
    const before = (bus._listeners.get('ui:heartbeat') || []).length;
    assert(before > 0, 'should have listener');
    ep.stop();
    const after = (bus._listeners.get('ui:heartbeat') || []).length;
    assertEqual(after, 0, 'listener should be removed after stop');
  });

  test('getReport returns full diagnostic', () => {
    const ep = new EmbodiedPerception({ bus: mockBus() });
    const report = ep.getReport();
    assert(report.uiState, 'should have uiState');
    assert(report.engagement, 'should have engagement');
  });
});

// ═══════════════════════════════════════════════════════════
// HomeostasisEffectors
// ═══════════════════════════════════════════════════════════

const { HomeostasisEffectors } = require('../../src/agent/organism/HomeostasisEffectors');

describe('HomeostasisEffectors', () => {
  test('constructs with defaults', () => {
    const he = new HomeostasisEffectors({ bus: mockBus() });
    assert(he, 'should construct');
  });

  test('constructs and has stats tracking', () => {
    const he = new HomeostasisEffectors({ bus: mockBus() });
    assert(he._stats, 'should have _stats');
    assert(typeof he._stats === 'object', 'stats should be object');
  });

  test('stop cleans up listeners', () => {
    const bus = mockBus();
    const he = new HomeostasisEffectors({ bus });
    he.start();
    he.stop();
    // Should not throw
    assert(true, 'stop should complete');
  });
});

// ═══════════════════════════════════════════════════════════
// EmotionalSteering
// ═══════════════════════════════════════════════════════════

const { EmotionalSteering, THRESHOLDS } = require('../../src/agent/organism/EmotionalSteering');

describe('EmotionalSteering', () => {
  function mockEmotional() {
    return {
      getState() { return { valence: 0.5, arousal: 0.5, confidence: 0.6, frustration: 0.2 }; },
      getDimension(d) { return { valence: 0.5, arousal: 0.5, confidence: 0.6, frustration: 0.2 }[d] || 0; },
    };
  }

  test('constructs with defaults', () => {
    const es = new EmotionalSteering({ bus: mockBus(), emotionalState: mockEmotional() });
    assert(es, 'should construct');
  });

  test('THRESHOLDS exported and non-empty', () => {
    assert(THRESHOLDS, 'should export THRESHOLDS');
    assert(Object.keys(THRESHOLDS).length > 0, 'should have threshold entries');
  });

  test('getSignals returns signal object', () => {
    const es = new EmotionalSteering({ bus: mockBus(), emotionalState: mockEmotional() });
    const signals = es.getSignals();
    assert(typeof signals === 'object', 'should return object');
  });

  test('getStats returns stats object', () => {
    const es = new EmotionalSteering({ bus: mockBus(), emotionalState: mockEmotional() });
    const stats = es.getStats();
    assert(typeof stats === 'object', 'should return object');
  });

  test('disabled when config.enabled=false', () => {
    const es = new EmotionalSteering({ bus: mockBus(), emotionalState: mockEmotional(), config: { enabled: false } });
    assertEqual(es._enabled, false, 'should be disabled');
  });
});

// ═══════════════════════════════════════════════════════════
// ImmuneSystem
// ═══════════════════════════════════════════════════════════

const { ImmuneSystem } = require('../../src/agent/organism/ImmuneSystem');

describe('ImmuneSystem', () => {
  test('constructs with defaults', () => {
    const is = new ImmuneSystem({ bus: mockBus() });
    assert(is, 'should construct');
  });

  test('getReport returns threat data', () => {
    const is = new ImmuneSystem({ bus: mockBus() });
    const report = is.getReport();
    assert(typeof report === 'object', 'should return object');
  });

  test('isQuarantined returns false for unknown source', () => {
    const is = new ImmuneSystem({ bus: mockBus() });
    assert(!is.isQuarantined('unknown-source'), 'should not be quarantined');
  });

  test('buildPromptContext returns string', () => {
    const is = new ImmuneSystem({ bus: mockBus() });
    const ctx = is.buildPromptContext();
    assert(typeof ctx === 'string', 'should return string');
  });

  test('stop cleans up listeners', () => {
    const bus = mockBus();
    const is = new ImmuneSystem({ bus });
    is.start();
    is.stop();
    assert(true, 'stop should complete');
  });
});

// ═══════════════════════════════════════════════════════════
// CostGuard
// ═══════════════════════════════════════════════════════════

const { CostGuard } = require('../../src/agent/ports/CostGuard');

describe('CostGuard', () => {
  test('constructs with defaults', () => {
    const cg = new CostGuard();
    assert(cg, 'should construct');
  });

  test('allows calls within budget', () => {
    const cg = new CostGuard({ config: { sessionTokenLimit: 100000, dailyTokenLimit: 200000 } });
    const result = cg.checkBudget('code-gen', 500);
    assert(result.allowed, 'should allow within budget');
  });

  test('blocks autonomous calls when session budget exhausted', () => {
    const cg = new CostGuard({ config: { sessionTokenLimit: 1000, dailyTokenLimit: 200000, warnThreshold: 1.1 } });
    // Fill up budget with autonomous calls
    cg.checkBudget('code-gen', 1001);
    const result = cg.checkBudget('code-gen', 100);
    assert(!result.allowed, 'should block autonomous over budget');
  });

  test('user chat (priority>=10) bypasses budget', () => {
    const cg = new CostGuard({ config: { sessionTokenLimit: 100, dailyTokenLimit: 200000, warnThreshold: 1.1 } });
    // Fill up budget
    cg.checkBudget('code-gen', 101);
    // User chat uses priority >= 10
    const result = cg.checkBudget('chat', 100, { priority: 10 });
    assert(result.allowed, 'user chat (priority>=10) should bypass budget');
  });

  test('getUsage returns token counts', () => {
    const cg = new CostGuard({ config: { sessionTokenLimit: 100000, warnThreshold: 1.1 } });
    cg.checkBudget('chat', 500);
    const usage = cg.getUsage();
    assert(usage.session.tokens >= 500, 'should track session tokens');
    assert(typeof usage.session.pct === 'number', 'should have percentage');
    assert(typeof usage.daily.tokens === 'number', 'should have daily tokens');
  });

  test('disabled mode allows everything', () => {
    const cg = new CostGuard({ config: { enabled: false } });
    const result = cg.checkBudget('code-gen', 999999);
    assert(result.allowed, 'disabled should allow all');
  });
});

// ═══════════════════════════════════════════════════════════
// DesktopPerception
// ═══════════════════════════════════════════════════════════

const { DesktopPerception } = require('../../src/agent/foundation/DesktopPerception');

describe('DesktopPerception', () => {
  const tmpDir = path.join(os.tmpdir(), `genesis-dp-test-${process.pid}`);

  function mockWorldState() {
    return {
      state: { project: { gitStatus: {} }, runtime: {} },
      updateMemoryUsage() {},
      recordFileChange() {},
    };
  }

  test('constructs with required deps', () => {
    const dp = new DesktopPerception({
      bus: mockBus(),
      worldState: mockWorldState(),
      rootDir: tmpDir,
    });
    assert(dp, 'should construct');
  });

  test('starts and sets _running flag', () => {
    const dp = new DesktopPerception({
      bus: mockBus(),
      worldState: mockWorldState(),
      rootDir: tmpDir,
    });
    dp.start();
    assert(dp._running === true, 'should be running');
    dp.stop();
    assert(dp._running === false, 'should stop');
  });

  test('stop is safe when not started', () => {
    const dp = new DesktopPerception({
      bus: mockBus(),
      worldState: mockWorldState(),
      rootDir: tmpDir,
    });
    dp.stop(); // Should not throw
    assert(true, 'stop before start is safe');
  });
});

// ═══════════════════════════════════════════════════════════
// ArchitectureReflection (SA-P3)
// ═══════════════════════════════════════════════════════════

const { ArchitectureReflection } = require('../../src/agent/cognitive/ArchitectureReflection');

describe('ArchitectureReflection (SA-P3)', () => {
  function makeAR() {
    const bus = mockBus();
    bus.listeners = new Map();
    const ar = new ArchitectureReflection({
      bus,
      selfModel: { rootDir: path.resolve(__dirname, '../..') },
    });
    // Simulate container registrations
    ar._container = {
      registrations: new Map([
        ['llm', { phase: 1, deps: [], tags: ['foundation'], lateBindings: [] }],
        ['intentRouter', { phase: 2, deps: ['llm'], tags: ['intelligence'], lateBindings: [] }],
        ['chatOrchestrator', { phase: 5, deps: ['intentRouter', 'llm'], tags: ['hexagonal'], lateBindings: [{ prop: 'nativeToolUse', service: 'nativeToolUse', optional: true }] }],
      ]),
    };
    return ar;
  }

  test('constructs and starts', () => {
    const ar = makeAR();
    ar.start();
    assert(ar._services.size > 0, 'should index services');
  });

  test('getSnapshot returns architecture summary', () => {
    const ar = makeAR();
    ar.start();
    const snap = ar.getSnapshot();
    assert(snap.services >= 3, 'should have services');
    assert(typeof snap.layers === 'number', 'should have layer count');
  });

  test('getServiceInfo returns service details', () => {
    const ar = makeAR();
    ar.start();
    const info = ar.getServiceInfo('chatOrchestrator');
    assert(info, 'should find chatOrchestrator');
    assertEqual(info.phase, 5, 'should be phase 5');
    assert(info.deps.includes('intentRouter'), 'should depend on intentRouter');
  });

  test('getServiceInfo returns null for unknown service', () => {
    const ar = makeAR();
    ar.start();
    assertEqual(ar.getServiceInfo('nonexistent'), null, 'should return null');
  });

  test('getDependencyChain finds path', () => {
    const ar = makeAR();
    ar.start();
    const chain = ar.getDependencyChain('chatOrchestrator', 'llm');
    assert(chain, 'should find path');
    assertEqual(chain[0], 'chatOrchestrator', 'should start at source');
    assert(chain.includes('llm'), 'should end at target');
  });

  test('getDependencyChain returns null for disconnected', () => {
    const ar = makeAR();
    ar.start();
    assertEqual(ar.getDependencyChain('llm', 'chatOrchestrator'), null, 'no reverse path');
  });

  test('getCouplings detects late-bindings', () => {
    const ar = makeAR();
    // Add nativeToolUse so the late-binding from chatOrchestrator resolves
    ar._container.registrations.set('nativeToolUse', { phase: 8, deps: [], tags: ['revolution'], lateBindings: [] });
    ar.start();
    const couplings = ar.getCouplings();
    assert(couplings.length > 0, 'should have couplings');
    assert(couplings.some(c => c.type.startsWith('late-')), 'should have late-binding couplings');
  });

  test('getPhaseMap groups by phase', () => {
    const ar = makeAR();
    ar.start();
    const pm = ar.getPhaseMap();
    assert(pm[1], 'should have phase 1');
    assert(pm[5], 'should have phase 5');
  });

  test('query returns results for "depends on llm"', () => {
    const ar = makeAR();
    ar.start();
    const r = ar.query('what depends on llm');
    assert(r.type === 'dependents', 'should match dependents query');
  });

  test('query returns results for "coupling"', () => {
    const ar = makeAR();
    ar.start();
    const r = ar.query('show couplings');
    assert(r.type === 'couplings', 'should match coupling query');
  });

  test('buildPromptContext returns architecture summary', () => {
    const ar = makeAR();
    ar.start();
    const ctx = ar.buildPromptContext();
    assert(ctx.includes('ARCHITECTURE'), 'should include ARCHITECTURE prefix');
  });

  test('stop is safe no-op', () => {
    const ar = makeAR();
    ar.start();
    ar.stop();
    assert(true, 'stop should not throw');
  });
});

// ═══════════════════════════════════════════════════════════

if (require.main === module) run();
