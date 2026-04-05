// ============================================================
// Test: EmotionalState.js — dimensions, decay, clamping, reactivity
// ============================================================
let passed = 0, failed = 0;
const failures = [];

// v3.5.2: Fixed — queue-based async-safe test runner
const _testQueue = [];
function test(name, fn) { _testQueue.push({ name, fn }); }
function assert(c, m) { if (!c) throw new Error(m || 'Assertion failed'); }

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
