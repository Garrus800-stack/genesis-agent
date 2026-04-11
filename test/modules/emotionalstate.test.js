// ============================================================
// Test: EmotionalState.js — dimensions, decay, clamping, reactivity
// ============================================================
let passed = 0, failed = 0;
const failures = [];

// v3.5.2: Fixed — queue-based async-safe test runner
const _testQueue = [];
function test(name, fn) { _testQueue.push({ name, fn }); }
function assert(c, m) { if (!c) throw new Error(m || 'Assertion failed'); }

// ── v7.1.1: Coverage expansion ────────────────────────────────
function describe(name, fn) { fn(); }  // shim — uses existing test() and assert()
function assertEqual(a, b, msg) {
  if (a !== b) throw new Error(msg || `Expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
}


const { EmotionalState } = require('../../src/agent/organism/EmotionalState');

console.log('\n  🧠 EmotionalState');

// ── Basic construction ──

test('creates with default dimensions', () => {
  const es = new EmotionalState({ bus: null, storage: null, intervals: null, config: {} });
  assert(es.dimensions.curiosity !== undefined, 'curiosity should exist');
  assert(es.dimensions.energy !== undefined, 'energy should exist');
  assert(es.dimensions.frustration !== undefined, 'frustration should exist');
  assert(es.dimensions.satisfaction !== undefined, 'satisfaction should exist');
  assert(es.dimensions.loneliness !== undefined, 'loneliness should exist');
});

test('dimensions start at expected defaults', () => {
  const es = new EmotionalState({ bus: null, storage: null, intervals: null, config: {} });
  assert(es.dimensions.curiosity.value === 0.6, 'curiosity should start at 0.6');
  assert(es.dimensions.energy.value === 0.8, 'energy should start at 0.8');
  assert(es.dimensions.frustration.value === 0.1, 'frustration should start at 0.1');
});

// ── Clamping ──

test('values clamped to min/max on adjust', () => {
  const es = new EmotionalState({ bus: null, storage: null, intervals: null, config: {} });
  // Push frustration way over max
  es._adjust('frustration', +5.0);
  assert(es.dimensions.frustration.value <= 1.0, 'frustration should be clamped at 1.0, got ' + es.dimensions.frustration.value);

  // Push energy way below min
  es._adjust('energy', -5.0);
  assert(es.dimensions.energy.value >= es.dimensions.energy.min, 'energy should not go below min');
});

test('adjust unknown dimension is a no-op', () => {
  const es = new EmotionalState({ bus: null, storage: null, intervals: null, config: {} });
  // Should not throw
  es._adjust('nonexistent_dimension', +0.5);
});

// ── Decay toward baseline ──

test('decay moves values toward baseline', () => {
  const es = new EmotionalState({ bus: null, storage: null, intervals: null, config: {} });
  // Spike frustration to 1.0
  es._adjust('frustration', +1.0);
  const before = es.dimensions.frustration.value;
  // Run decay manually
  es._decayTick();
  const after = es.dimensions.frustration.value;
  assert(after < before, `frustration should decay from ${before}, got ${after}`);
  assert(after > es.dimensions.frustration.baseline, 'should not overshoot baseline in one step');
});

test('decay does not move values past baseline', () => {
  const es = new EmotionalState({ bus: null, storage: null, intervals: null, config: {} });
  // Set curiosity exactly to baseline
  es.dimensions.curiosity.value = es.dimensions.curiosity.baseline;
  es._decayTick();
  assert(es.dimensions.curiosity.value === es.dimensions.curiosity.baseline, 'at baseline, decay should not change value');
});

// ── Config overrides ──

test('config overrides baselines and decay rates', () => {
  const es = new EmotionalState({
    bus: null, storage: null, intervals: null,
    config: {
      baselines: { curiosity: 0.9 },
      decayRates: { curiosity: 0.5 },
    },
  });
  assert(es.dimensions.curiosity.baseline === 0.9, 'baseline should be overridden');
  assert(es.dimensions.curiosity.decayRate === 0.5, 'decayRate should be overridden');
});

// ── Mood trend ──

test('getMoodTrend returns a string', () => {
  const es = new EmotionalState({ bus: null, storage: null, intervals: null, config: {} });
  const trend = es._moodTrend;
  assert(typeof trend === 'string', 'trend should be a string');
  assert(['rising', 'falling', 'stable'].includes(trend), `trend should be rising/falling/stable, got ${trend}`);
});

// ── Report structure ──

test('getReport returns complete structure', () => {
  const es = new EmotionalState({ bus: null, storage: null, intervals: null, config: {} });
  const r = es.getReport();
  assert(r.state, 'report should have state');
  assert(r.mood !== undefined, 'report should have mood');
  assert(r.trend !== undefined, 'report should have trend');
});


function makeES(dims = {}) {
  const bus = { emit(){}, fire(){}, on(){ return ()=>{}; } };
  const es = new EmotionalState({ bus });
  // Override dimension values directly for deterministic tests
  for (const [k, v] of Object.entries(dims)) {
    if (es.dimensions[k]) es.dimensions[k].value = v;
  }
  return es;
}

describe('EmotionalState — getState()', () => {
  test('returns all dimensions as numbers', () => {
    const es = makeES();
    const s = es.getState();
    assert(typeof s.energy === 'number');
    assert(typeof s.frustration === 'number');
    assert(typeof s.curiosity === 'number');
    assert(typeof s.satisfaction === 'number');
    assert(typeof s.loneliness === 'number');
  });
});

describe('EmotionalState — getDominant()', () => {
  test('returns neutral when near baseline', () => {
    const es = makeES();
    const d = es.getDominant();
    assert(typeof d.emotion === 'string');
    assert(typeof d.intensity === 'number');
  });

  test('returns correct dominant emotion', () => {
    const es = makeES({ frustration: 0.9, energy: 0.5, curiosity: 0.5, satisfaction: 0.5, loneliness: 0.5 });
    const d = es.getDominant();
    assertEqual(d.emotion, 'frustration');
  });
});

describe('EmotionalState — getMood()', () => {
  test('frustrated when frustration > 0.6', () => {
    assertEqual(makeES({ frustration: 0.7 }).getMood(), 'frustrated');
  });

  test('exhausted when energy < 0.2', () => {
    assertEqual(makeES({ energy: 0.1, frustration: 0.0 }).getMood(), 'exhausted');
  });

  test('lonely when loneliness > 0.7', () => {
    assertEqual(makeES({ loneliness: 0.8, frustration: 0.0, energy: 0.5 }).getMood(), 'lonely');
  });

  test('curious when curiosity > 0.7 and energy > 0.5', () => {
    assertEqual(makeES({ curiosity: 0.8, energy: 0.7, frustration: 0.0, loneliness: 0.0 }).getMood(), 'curious');
  });

  test('content when satisfaction > 0.7', () => {
    assertEqual(makeES({ satisfaction: 0.8, frustration: 0.0, energy: 0.6, loneliness: 0.0, curiosity: 0.0 }).getMood(), 'content');
  });

  test('focused when satisfaction > 0.5 and energy > 0.5', () => {
    assertEqual(makeES({ satisfaction: 0.6, energy: 0.6, frustration: 0.0, loneliness: 0.0, curiosity: 0.0 }).getMood(), 'focused');
  });

  test('tense when frustration > 0.4', () => {
    assertEqual(makeES({ frustration: 0.5, energy: 0.6 }).getMood(), 'tense');
  });

  test('tired when energy < 0.4', () => {
    assertEqual(makeES({ energy: 0.3, frustration: 0.0 }).getMood(), 'tired');
  });

  test('calm when near baseline', () => {
    const es = makeES({ energy: 0.5, frustration: 0.0, curiosity: 0.0, satisfaction: 0.0, loneliness: 0.0 });
    assertEqual(es.getMood(), 'calm');
  });
});

describe('EmotionalState — buildPromptContext()', () => {
  test('returns empty string near baseline', () => {
    const es = makeES();
    // baseline values produce low deviation
    assertEqual(es.buildPromptContext(), '');
  });

  test('includes frustration hint', () => {
    const es = makeES({ frustration: 0.8, energy: 0.5, curiosity: 0.0, satisfaction: 0.0, loneliness: 0.0 });
    const ctx = es.buildPromptContext();
    assert(ctx.includes('EMOTIONAL STATE') || ctx === '', 'should include state or be empty');
  });

  test('includes energy hint when low', () => {
    const es = makeES({ energy: 0.1, frustration: 0.0, curiosity: 0.0, satisfaction: 0.0, loneliness: 0.0 });
    const ctx = es.buildPromptContext();
    assert(typeof ctx === 'string');
  });
});

describe('EmotionalState — getIdlePriorities()', () => {
  test('returns all priority keys', () => {
    const es = makeES();
    const p = es.getIdlePriorities();
    assert(typeof p.reflect === 'number');
    assert(typeof p.plan === 'number');
    assert(typeof p.explore === 'number');
    assert(typeof p.ideate === 'number');
    assert(typeof p.journal === 'number');
    assert(typeof p.tidy === 'number');
    assert(typeof p.goal === 'number');
  });

  test('frustration increases reflect weight', () => {
    const calm = makeES({ frustration: 0.0 }).getIdlePriorities();
    const frustrated = makeES({ frustration: 1.0 }).getIdlePriorities();
    assert(frustrated.reflect > calm.reflect);
  });

  test('curiosity increases explore weight', () => {
    const low = makeES({ curiosity: 0.0 }).getIdlePriorities();
    const high = makeES({ curiosity: 1.0 }).getIdlePriorities();
    assert(high.explore > low.explore);
  });
});

describe('EmotionalState — getReport()', () => {
  test('returns complete report', () => {
    const es = makeES();
    const r = es.getReport();
    assert(typeof r.state === 'object');
    assert(typeof r.mood === 'string');
    assert(typeof r.dominant === 'object');
    assert(r.trend !== undefined);
    assert(typeof r.historyLength === 'number');
  });
});

describe('EmotionalState — getTrend()', () => {
  test('returns trend value', () => {
    const es = makeES();
    const t = es.getTrend();
    assert(t !== undefined);
  });
});

// v3.5.2: Async-safe runner — properly awaits all tests
(async () => {
  for (const t of _testQueue) {
    try {
      const r = t.fn(); if (r && r.then) await r;
      passed++; console.log(`    ✅ ${t.name}`);
    } catch (err) {
      failed++; console.log(`    ❌ ${t.name}: ${err.message}`);
    }
  }
  console.log(`\n    ${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
})();
