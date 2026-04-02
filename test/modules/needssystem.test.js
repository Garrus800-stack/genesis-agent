// ============================================================
// Test: NeedsSystem.js — needs, growth, satisfaction, drive
// ============================================================
let passed = 0, failed = 0;
const failures = [];

// v3.5.2: Fixed — queue-based async-safe test runner
const _testQueue = [];
function test(name, fn) { _testQueue.push({ name, fn }); }
function assert(c, m) { if (!c) throw new Error(m || 'Assertion failed'); }

const { NeedsSystem } = require('../../src/agent/organism/NeedsSystem');

console.log('\n  🔥 NeedsSystem');

function makeNeeds(overrides = {}) {
  return new NeedsSystem({
    bus: null, storage: null, intervals: null, emotionalState: null,
    config: {}, ...overrides,
  });
}

// ── Construction ──

test('has all four needs', () => {
  const ns = makeNeeds();
  const needs = ns.getNeeds();
  assert(needs.knowledge !== undefined, 'should have knowledge');
  assert(needs.social !== undefined, 'should have social');
  assert(needs.maintenance !== undefined, 'should have maintenance');
  assert(needs.rest !== undefined, 'should have rest');
});

test('needs start at expected values', () => {
  const ns = makeNeeds();
  assert(ns.needs.knowledge.value === 0.3, 'knowledge should start at 0.3');
  assert(ns.needs.social.value === 0.2, 'social should start at 0.2');
});

// ── Satisfaction ──

test('satisfy reduces a need value', () => {
  const ns = makeNeeds();
  ns.needs.knowledge.value = 0.8;
  const before = ns.needs.knowledge.value;
  ns.satisfy('knowledge');
  assert(ns.needs.knowledge.value < before, 'knowledge should decrease after satisfy');
});

test('satisfy clamps to 0', () => {
  const ns = makeNeeds();
  ns.needs.knowledge.value = 0.01;
  ns.satisfy('knowledge', 5.0); // massive satisfaction
  assert(ns.needs.knowledge.value >= 0, 'need should not go below 0');
});

test('satisfy unknown need is a no-op', () => {
  const ns = makeNeeds();
  // Should not throw
  ns.satisfy('nonexistent_need');
});

// ── Growth ──

test('growth tick increases need values', () => {
  const ns = makeNeeds();
  const beforeKnowledge = ns.needs.knowledge.value;
  const beforeSocial = ns.needs.social.value;
  ns._growthTick();
  assert(ns.needs.knowledge.value > beforeKnowledge, 'knowledge should grow');
  assert(ns.needs.social.value > beforeSocial, 'social should grow');
});

test('growth clamps to 1.0', () => {
  const ns = makeNeeds();
  ns.needs.knowledge.value = 0.99;
  ns._growthTick();
  assert(ns.needs.knowledge.value <= 1.0, 'need should not exceed 1.0');
});

// ── Drive calculation ──

test('getTotalDrive returns a number >= 0', () => {
  const ns = makeNeeds();
  const drive = ns.getTotalDrive();
  assert(typeof drive === 'number', 'drive should be a number');
  assert(drive >= 0, 'drive should be non-negative');
});

test('higher needs produce higher drive', () => {
  const ns = makeNeeds();
  const lowDrive = ns.getTotalDrive();
  // Max out all needs
  for (const need of Object.values(ns.needs)) need.value = 1.0;
  const highDrive = ns.getTotalDrive();
  assert(highDrive > lowDrive, 'maxed needs should produce higher drive');
});

// ── Most urgent ──

test('getMostUrgent returns need with highest weighted value', () => {
  const ns = makeNeeds();
  // Make knowledge clearly dominant
  ns.needs.knowledge.value = 1.0;
  ns.needs.social.value = 0.0;
  ns.needs.maintenance.value = 0.0;
  ns.needs.rest.value = 0.0;
  const urgent = ns.getMostUrgent();
  assert(urgent.need === 'knowledge', `expected knowledge, got ${urgent.need}`);
});

// ── Activity recommendations ──

test('getActivityRecommendations returns array', () => {
  const ns = makeNeeds();
  const recs = ns.getActivityRecommendations();
  assert(Array.isArray(recs), 'should return array');
  assert(recs.length > 0, 'should return at least one recommendation');
});

// ── Config overrides ──

test('config overrides growth rates', () => {
  const ns = new NeedsSystem({
    bus: null, storage: null, intervals: null, emotionalState: null,
    config: { growthRates: { knowledge: 0.5 } },
  });
  assert(ns.needs.knowledge.growthRate === 0.5, 'growth rate should be overridden');
});

// ── Report ──

test('getReport returns complete structure', () => {
  const ns = makeNeeds();
  const r = ns.getReport();
  assert(r.needs, 'report should have needs');
  assert(r.totalDrive !== undefined, 'report should have totalDrive');
  assert(r.mostUrgent, 'report should have mostUrgent');
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
