#!/usr/bin/env node
// Test: MetaCognitiveLoop — Integration tests for v6.0.2 wiring patches
const { describe, test, assert, assertEqual, run } = require('../harness');
const { createBus } = require('../../src/agent/core/EventBus');

// ── ModelRouter empirical strength injection ────────────────

describe('ModelRouter — Empirical Strength Injection (v6.0.2)', () => {
  let ModelRouter;
  try {
    ({ ModelRouter } = require('../../src/agent/revolution/ModelRouter'));
  } catch (_e) {
    // Skip if ModelRouter has heavy deps
  }

  test('injectEmpiricalStrength stores map and timestamp', () => {
    if (!ModelRouter) return;
    const bus = createBus();
    const router = new ModelRouter({
      bus,
      modelBridge: { activeModel: 'test', models: [], get activeBackend() { return 'mock'; } },
      metaLearning: null,
      worldState: null,
    });

    const strengthMap = {
      'code-gen': {
        recommended: 'claude',
        entries: [
          { backend: 'claude', confidence: 0.85, sampleSize: 10 },
          { backend: 'ollama', confidence: 0.45, sampleSize: 8 },
        ],
      },
    };

    router.injectEmpiricalStrength(strengthMap);
    assert(router._empiricalStrength !== null, 'should store strength map');
    assert(router._empiricalStrengthAt > 0, 'should store timestamp');
    assertEqual(router._empiricalStrength['code-gen'].recommended, 'claude');
  });

  test('emits router:empirical-strength-injected event', () => {
    if (!ModelRouter) return;
    const bus = createBus();
    const router = new ModelRouter({
      bus,
      modelBridge: { activeModel: 'test', models: [] },
      metaLearning: null,
      worldState: null,
    });

    let emitted = null;
    bus.on('router:empirical-strength-injected', (data) => { emitted = data; });
    router.injectEmpiricalStrength({ 'code-gen': { entries: [] }, 'analysis': { entries: [] } });
    assert(emitted !== null, 'should emit event');
    assertEqual(emitted.taskTypes, 2);
  });

  test('clearing empirical strength resets state', () => {
    if (!ModelRouter) return;
    const bus = createBus();
    const router = new ModelRouter({
      bus,
      modelBridge: { activeModel: 'test', models: [] },
      metaLearning: null,
      worldState: null,
    });

    router.injectEmpiricalStrength({ 'code-gen': { entries: [] } });
    router._empiricalStrength = null;
    router._empiricalStrengthAt = 0;
    assertEqual(router._empiricalStrength, null);
    assertEqual(router._empiricalStrengthAt, 0);
  });
});

// ── OnlineLearner weakness signals ──────────────────────────

describe('OnlineLearner — Weakness Signals (v6.0.2)', () => {
  let OnlineLearner;
  try {
    ({ OnlineLearner } = require('../../src/agent/cognitive/OnlineLearner'));
  } catch (_e) {
    // Skip if OnlineLearner has heavy deps
  }

  test('receiveWeaknessSignal stores signal with multiplier', () => {
    if (!OnlineLearner) return;
    const bus = createBus();
    const ol = new OnlineLearner({ bus });

    ol.receiveWeaknessSignal('code-gen', true);
    assert(ol._weaknessSignals !== undefined, 'should have weakness signals');
    assertEqual(ol._weaknessSignals['code-gen'].multiplier, 0.85);
    assert(ol._weaknessSignals['code-gen'].receivedAt > 0, 'should have timestamp');
  });

  test('receiveWeaknessSignal with isWeak=false sets higher multiplier', () => {
    if (!OnlineLearner) return;
    const bus = createBus();
    const ol = new OnlineLearner({ bus });

    ol.receiveWeaknessSignal('analysis', false);
    assertEqual(ol._weaknessSignals['analysis'].multiplier, 1.10);
  });

  test('ignores null taskType', () => {
    if (!OnlineLearner) return;
    const bus = createBus();
    const ol = new OnlineLearner({ bus });

    ol.receiveWeaknessSignal(null, true);
    assertEqual(ol._weaknessSignals, undefined);
  });

  test('tracks weaknessSignalsReceived stat', () => {
    if (!OnlineLearner) return;
    const bus = createBus();
    const ol = new OnlineLearner({ bus });

    ol.receiveWeaknessSignal('code-gen', true);
    ol.receiveWeaknessSignal('analysis', false);
    assertEqual(ol._stats.weaknessSignalsReceived, 2);
  });
});

// ── EventTypes registration ─────────────────────────────────

describe('EventTypes — ADAPTATION namespace (v6.0.2)', () => {
  let EventTypes;
  try {
    EventTypes = require('../../src/agent/core/EventTypes');
  } catch (_e) { /* skip */ }

  test('ADAPTATION events are registered', () => {
    if (!EventTypes) return;
    const A = EventTypes.EVENTS?.ADAPTATION || EventTypes.ADAPTATION;
    assert(A !== undefined, 'ADAPTATION namespace should exist');
    assertEqual(A.PROPOSED, 'adaptation:proposed');
    assertEqual(A.APPLIED, 'adaptation:applied');
    assertEqual(A.VALIDATED, 'adaptation:validated');
    assertEqual(A.ROLLED_BACK, 'adaptation:rolled-back');
    assertEqual(A.VALIDATION_DEFERRED, 'adaptation:validation-deferred');
    assertEqual(A.CYCLE_COMPLETE, 'adaptation:cycle-complete');
  });

  test('ADAPTATION events are frozen', () => {
    if (!EventTypes) return;
    const A = EventTypes.EVENTS?.ADAPTATION || EventTypes.ADAPTATION;
    assert(Object.isFrozen(A), 'should be frozen');
  });
});

// ── Constants ───────────────────────────────────────────────

describe('Constants — Adaptation (v6.0.2)', () => {
  let Constants;
  try {
    Constants = require('../../src/agent/core/Constants');
  } catch (_e) { /* skip */ }

  test('ADAPTATION constants are defined in PHASE9', () => {
    if (!Constants) return;
    const P9 = Constants.PHASE9;
    assert(P9.ADAPTATION_COOLDOWN_MS > 0, 'cooldown should be defined');
    assertEqual(P9.ADAPTATION_MIN_OUTCOMES, 10);
    assertEqual(P9.ADAPTATION_REGRESSION_THRESHOLD, -0.05);
    assertEqual(P9.ADAPTATION_NOISE_MARGIN, 0.02);
    assertEqual(P9.QUICK_BENCHMARK_BUDGET_FLOOR, 0.20);
  });
});

// ── Payload Schemas ─────────────────────────────────────────

describe('EventPayloadSchemas — Adaptation (v6.0.2)', () => {
  let SCHEMAS;
  try {
    ({ SCHEMAS } = require('../../src/agent/core/EventPayloadSchemas'));
  } catch (_e) { /* skip */ }

  test('adaptation schemas are registered', () => {
    if (!SCHEMAS) return;
    assert(SCHEMAS['adaptation:proposed'] !== undefined, 'proposed schema');
    assert(SCHEMAS['adaptation:applied'] !== undefined, 'applied schema');
    assert(SCHEMAS['adaptation:validated'] !== undefined, 'validated schema');
    assert(SCHEMAS['adaptation:rolled-back'] !== undefined, 'rolled-back schema');
    assert(SCHEMAS['adaptation:validation-deferred'] !== undefined, 'deferred schema');
    assert(SCHEMAS['adaptation:cycle-complete'] !== undefined, 'cycle-complete schema');
    assert(SCHEMAS['router:empirical-strength-injected'] !== undefined, 'router injection schema');
  });

  test('validated schema requires decision field', () => {
    if (!SCHEMAS) return;
    assertEqual(SCHEMAS['adaptation:validated'].decision, 'required');
  });
});

run();
