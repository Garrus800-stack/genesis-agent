// ============================================================
// TEST: PhenomenalFieldComputation — Consciousness Binding
// ============================================================

const { describe, test, assert, assertEqual, run } = require('../harness');
const { PhenomenalFieldComputation } = require('../../src/agent/consciousness/PhenomenalFieldComputation');

// ── Mock Field ───────────────────────────────────────────────
// PhenomenalFieldComputation reads from field.emotionalState,
// field.needsSystem, field.surpriseAccumulator, etc.

function mockField(overrides = {}) {
  return {
    emotionalState: {
      getState: () => ({ curiosity: 0.6, satisfaction: 0.5, frustration: 0.1, energy: 0.7, loneliness: 0.3 }),
      getMood: () => 'calm',
      getDominant: () => ({ emotion: 'curiosity', intensity: 0.6 }),
      ...(overrides.emotionalState || {}),
    },
    needsSystem: {
      getNeeds: () => ({ knowledge: 0.4, social: 0.2, maintenance: 0.1, rest: 0.1 }),
      getTotalDrive: () => 0.3,
      getMostUrgent: () => ({ need: 'knowledge', drive: 0.4 }),
      ...(overrides.needsSystem || {}),
    },
    surpriseAccumulator: {
      getRecentSignals: () => [
        { totalSurprise: 0.3 },
        { totalSurprise: 0.2 },
      ],
      ...(overrides.surpriseAccumulator || {}),
    },
    expectationEngine: {
      getReport: () => ({ activeExpectations: 3, avgConfidence: 0.7, recentAccuracy: 0.6 }),
      ...(overrides.expectationEngine || {}),
    },
    homeostasis: overrides.homeostasis || null,
    memoryFacade: overrides.memoryFacade || null,
    _lastConflict: null,
    ...(overrides._extra || {}),
  };
}

// ── Sampling ─────────────────────────────────────────────────

describe('PhenomenalFieldComputation — Sampling', () => {
  test('_sampleEmotion returns state from emotionalState', () => {
    const f = mockField();
    const c = new PhenomenalFieldComputation(f);
    const e = c._sampleEmotion();
    assertEqual(e.curiosity, 0.6);
    assertEqual(e.mood, 'calm');
    assert(e.dominant.emotion === 'curiosity', 'Should include dominant');
  });

  test('_sampleEmotion returns defaults when emotionalState is null', () => {
    const f = mockField();
    f.emotionalState = null;
    const c = new PhenomenalFieldComputation(f);
    const e = c._sampleEmotion();
    assertEqual(e.curiosity, 0.5);
    assertEqual(e.mood, 'calm');
  });

  test('_sampleNeeds returns state from needsSystem', () => {
    const f = mockField();
    const c = new PhenomenalFieldComputation(f);
    const n = c._sampleNeeds();
    assertEqual(n.knowledge, 0.4);
    assert(n.totalDrive > 0, 'Should have totalDrive');
    assert(n.mostUrgent.need === 'knowledge', 'Should report most urgent');
  });

  test('_sampleNeeds returns defaults when needsSystem is null', () => {
    const f = mockField();
    f.needsSystem = null;
    const c = new PhenomenalFieldComputation(f);
    const n = c._sampleNeeds();
    assertEqual(n.knowledge, 0.3);
  });

  test('_sampleSurprise computes from recent signals', () => {
    const f = mockField();
    const c = new PhenomenalFieldComputation(f);
    const s = c._sampleSurprise();
    assert(typeof s.recentLevel === 'number', 'Should compute level');
    assert(['rising', 'falling', 'stable'].includes(s.trend), 'Should compute trend');
  });

  test('_sampleSurprise returns defaults when null', () => {
    const f = mockField();
    f.surpriseAccumulator = null;
    const c = new PhenomenalFieldComputation(f);
    const s = c._sampleSurprise();
    assertEqual(s.recentLevel, 0);
    assertEqual(s.trend, 'stable');
  });

  test('_sampleExpectation reads from expectationEngine', () => {
    const f = mockField();
    const c = new PhenomenalFieldComputation(f);
    const e = c._sampleExpectation();
    assertEqual(e.activeCount, 3);
    assert(e.avgConfidence > 0, 'Should have confidence');
  });
});

// ── Salience ─────────────────────────────────────────────────

describe('PhenomenalFieldComputation — Salience', () => {
  test('_computeSalience returns normalized object', () => {
    const f = mockField();
    const c = new PhenomenalFieldComputation(f);
    const emotion = { dominant: { intensity: 0.6 } };
    const needs = { totalDrive: 0.3 };
    const surprise = { recentLevel: 0.4 };
    const expectation = { recentAccuracy: 0.5 };
    const memory = { activatedSchemas: 2 };
    const homeostasis = { state: 'normal' };
    const s = c._computeSalience(emotion, needs, surprise, expectation, memory, homeostasis);
    assert(s.emotion >= 0 && s.emotion <= 1, 'Normalized');
    assert(s.needs >= 0 && s.needs <= 1, 'Normalized');
    // Sum should approximate 1.0
    const sum = s.emotion + s.needs + s.surprise + s.expectation + s.memory + s.homeostasis;
    assert(Math.abs(sum - 1.0) < 0.01, `Sum should be ~1.0, got ${sum}`);
  });

  test('critical homeostasis dominates salience', () => {
    const f = mockField();
    const c = new PhenomenalFieldComputation(f);
    const s = c._computeSalience(
      { dominant: { intensity: 0.1 } }, { totalDrive: 0.1 },
      { recentLevel: 0 }, { recentAccuracy: 0.5 },
      { activatedSchemas: 0 }, { state: 'critical' }
    );
    assert(s.homeostasis > 0.4, `Critical should dominate, got ${s.homeostasis}`);
  });
});

// ── Valence ──────────────────────────────────────────────────

describe('PhenomenalFieldComputation — Valence', () => {
  test('positive emotions → positive valence', () => {
    const f = mockField();
    const c = new PhenomenalFieldComputation(f);
    const v = c._computeValence(
      { satisfaction: 0.8, curiosity: 0.7, frustration: 0.0, loneliness: 0.0 },
      { totalDrive: 0.2 },
      { recentLevel: 0 },
      { state: 'normal' }
    );
    assert(v > 0, `Expected positive valence, got ${v}`);
  });

  test('high frustration → negative valence', () => {
    const f = mockField();
    const c = new PhenomenalFieldComputation(f);
    const v = c._computeValence(
      { satisfaction: 0.1, curiosity: 0.1, frustration: 0.9, loneliness: 0.5 },
      { totalDrive: 0.8 },
      { recentLevel: 0.5 },
      { state: 'warning' }
    );
    assert(v < 0, `Expected negative valence, got ${v}`);
  });
});

// ── Arousal ──────────────────────────────────────────────────

describe('PhenomenalFieldComputation — Arousal', () => {
  test('high emotion + surprise → high arousal', () => {
    const f = mockField();
    const c = new PhenomenalFieldComputation(f);
    const a = c._computeArousal(
      { curiosity: 0.9, frustration: 0.8, energy: 0.9 },
      { totalDrive: 0.8 },
      { recentLevel: 1.0 },
      { state: 'normal' }
    );
    assert(a > 0.5, `Expected high arousal, got ${a}`);
  });

  test('low everything → low arousal', () => {
    const f = mockField();
    const c = new PhenomenalFieldComputation(f);
    const a = c._computeArousal(
      { curiosity: 0.1, frustration: 0.0, energy: 0.3 },
      { totalDrive: 0.1 },
      { recentLevel: 0 },
      { state: 'normal' }
    );
    assert(a < 0.5, `Expected low arousal, got ${a}`);
  });
});

// ── Qualia ───────────────────────────────────────────────────

describe('PhenomenalFieldComputation — Qualia', () => {
  test('critical homeostasis → vigilance', () => {
    const f = mockField();
    const c = new PhenomenalFieldComputation(f);
    const q = c._determineQualia(0, 0.5, 0.5, {}, {}, {}, {}, { state: 'critical' }, {});
    assertEqual(q, 'vigilance');
  });

  test('high coherence + arousal + positive valence → flow', () => {
    const f = mockField();
    f._lastConflict = null;
    const c = new PhenomenalFieldComputation(f);
    const q = c._determineQualia(0.5, 0.7, 0.8, {}, { curiosity: 0.5 }, {}, { recentLevel: 0.3 }, { state: 'normal' }, {});
    assertEqual(q, 'flow');
  });

  test('low energy → exhaustion', () => {
    const f = mockField();
    f._lastConflict = null;
    const c = new PhenomenalFieldComputation(f);
    const q = c._determineQualia(-0.1, 0.3, 0.5, {}, { energy: 0.1 }, {}, { recentLevel: 0 }, { state: 'normal' }, {});
    assertEqual(q, 'exhaustion');
  });

  test('positive valence + coherence → contentment', () => {
    const f = mockField();
    f._lastConflict = null;
    const c = new PhenomenalFieldComputation(f);
    const q = c._determineQualia(0.3, 0.4, 0.6, {}, { energy: 0.7, curiosity: 0.3, loneliness: 0.1 }, { totalDrive: 0.2, knowledge: 0.2 }, { recentLevel: 0.1 }, { state: 'normal' }, {});
    assertEqual(q, 'contentment');
  });

  test('negative valence default → tension', () => {
    const f = mockField();
    f._lastConflict = null;
    const c = new PhenomenalFieldComputation(f);
    const q = c._determineQualia(-0.3, 0.4, 0.4, {}, { energy: 0.5, curiosity: 0.2, loneliness: 0.3 }, { totalDrive: 0.3 }, { recentLevel: 0.1 }, { state: 'normal' }, {});
    assertEqual(q, 'tension');
  });
});

// ── Gestalt ──────────────────────────────────────────────────

describe('PhenomenalFieldComputation — Gestalt', () => {
  test('_synthesizeGestalt returns string', () => {
    const f = mockField();
    const c = new PhenomenalFieldComputation(f);
    const g = c._synthesizeGestalt(0.3, 0.4, 0.6, 'contentment', {}, { curiosity: 0.5, energy: 0.7, frustration: 0.1, satisfaction: 0.5, loneliness: 0.2 }, { totalDrive: 0.3 }, { recentLevel: 0.2 });
    assert(typeof g === 'string', 'Should return string');
    assert(g.length > 10, 'Should be meaningful text');
  });

  test('flow gestalt describes alignment', () => {
    const f = mockField();
    const c = new PhenomenalFieldComputation(f);
    const g = c._synthesizeGestalt(0.5, 0.7, 0.8, 'flow', {}, { curiosity: 0.7 }, {}, {});
    assert(g.toLowerCase().includes('align') || g.toLowerCase().includes('merge') || g.toLowerCase().includes('seamless'), 'Flow should describe alignment');
  });
});

// ── Coherence ────────────────────────────────────────────────

describe('PhenomenalFieldComputation — Coherence', () => {
  test('_computeCoherence returns 0.5 when insufficient frames', () => {
    const f = mockField();
    f._frames = [];
    f._coherenceWindow = 5;
    const c = new PhenomenalFieldComputation(f);
    const salience = { emotion: 0.3, needs: 0.2, surprise: 0.1, expectation: 0.1, memory: 0.1, homeostasis: 0.2 };
    const coh = c._computeCoherence(salience);
    assertEqual(coh, 0.5);
  });

  test('_computeCoherence returns 0-1 with enough frames', () => {
    const f = mockField();
    const salience = { emotion: 0.3, needs: 0.2, surprise: 0.1, expectation: 0.1, memory: 0.1, homeostasis: 0.2 };
    f._frames = Array.from({ length: 10 }, () => ({ salience: { ...salience } }));
    f._coherenceWindow = 5;
    const c = new PhenomenalFieldComputation(f);
    const coh = c._computeCoherence(salience);
    assert(coh >= 0 && coh <= 1, `Should be 0-1, got ${coh}`);
  });
});

run();
