// ============================================================
// Test: Homeostasis.js — vitals, state machine, autonomy gating
// ============================================================
let passed = 0, failed = 0;
const failures = [];

// v3.5.2: Fixed — queue-based async-safe test runner
const _testQueue = [];
function test(name, fn) { _testQueue.push({ name, fn }); }
function assert(c, m) { if (!c) throw new Error(m || 'Assertion failed'); }

const { Homeostasis } = require('../../src/agent/organism/Homeostasis');

console.log('\n  💓 Homeostasis');

function makeHomeo(overrides = {}) {
  return new Homeostasis({
    bus: null, storage: null, intervals: null, emotionalState: null,
    config: {}, ...overrides,
  });
}

// ── Construction ──

test('starts in healthy state', () => {
  const h = makeHomeo();
  assert(h.getState() === 'healthy', `expected healthy, got ${h.getState()}`);
});

test('has expected vital signs', () => {
  const h = makeHomeo();
  const vitals = h.getVitals();
  assert(vitals.errorRate !== undefined, 'should have errorRate');
  assert(vitals.memoryPressure !== undefined, 'should have memoryPressure');
  assert(vitals.kgNodeCount !== undefined, 'should have kgNodeCount');
  assert(vitals.circuitState !== undefined, 'should have circuitState');
  assert(vitals.responseLatency !== undefined, 'should have responseLatency');
});

// ── Autonomy gating ──

test('autonomy allowed when healthy', () => {
  const h = makeHomeo();
  assert(h.isAutonomyAllowed() === true, 'should allow autonomy when healthy');
});

test('isHealthyForComplexWork when healthy', () => {
  const h = makeHomeo();
  assert(h.isHealthyForComplexWork() === true, 'should allow complex work when healthy');
});

// ── Vital classification ──

test('classifyVital returns healthy for values in range', () => {
  const h = makeHomeo();
  const vital = h.vitals.errorRate;
  vital.value = 0.1; // well within healthy range
  const status = h._classifyVital(vital);
  assert(status === 'healthy', `expected healthy, got ${status}`);
});

test('classifyVital returns warning for values in warning range', () => {
  const h = makeHomeo();
  const vital = h.vitals.errorRate;
  vital.value = 1.0; // in warning range (0.5–2.0)
  const status = h._classifyVital(vital);
  assert(status === 'warning', `expected warning, got ${status}`);
});

test('classifyVital returns critical for values above warning max', () => {
  const h = makeHomeo();
  const vital = h.vitals.errorRate;
  vital.value = 5.0; // above warning max
  const status = h._classifyVital(vital);
  assert(status === 'critical', `expected critical, got ${status}`);
});

// ── Config overrides ──

test('config overrides threshold values', () => {
  const h = new Homeostasis({
    bus: null, storage: null, intervals: null, emotionalState: null,
    config: {
      thresholds: { errorRate: { healthy: 1.0, warning: 3.0 } },
      criticalThreshold: 5,
    },
  });
  // errorRate at 0.8 should now be healthy (threshold raised to 1.0)
  h.vitals.errorRate.value = 0.8;
  assert(h._classifyVital(h.vitals.errorRate) === 'healthy',
    'custom threshold should make 0.8 healthy');
});

// ── Report ──

test('getReport returns complete structure', () => {
  const h = makeHomeo();
  const r = h.getReport();
  assert(r.state, 'report should have state');
  assert(r.vitals, 'report should have vitals');
  assert(r.recentCorrections !== undefined, 'report should have corrections');
});

test('buildPromptContext returns string', () => {
  const h = makeHomeo();
  const ctx = h.buildPromptContext();
  assert(typeof ctx === 'string', 'prompt context should be a string');
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
