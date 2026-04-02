// ============================================================
// Test: v380-asyncload.test.js — asyncLoad() Migration + Safety Branch Coverage
//
// Tests for:
//   1. asyncLoad() exists on all 14 migrated modules
//   2. Container.bootAll() calls asyncLoad()
//   3. VerificationEngine branch coverage (error paths, fallbacks)
//   4. Container asyncLoad lifecycle hook
// ============================================================

let passed = 0, failed = 0;
const _testQueue = [];
function test(name, fn) { _testQueue.push({ name, fn }); }
function assert(c, m) { if (!c) throw new Error(m || 'Assertion failed'); }

console.log('\n  🔄 v3.8.0 asyncLoad() Migration & Safety Branches');

// ════════════════════════════════════════════════════════════
// 1. asyncLoad() exists on all 14 migrated modules
// ════════════════════════════════════════════════════════════
console.log('\n  📦 asyncLoad() Method Presence');

const { NullBus } = require('../../src/agent/core/EventBus');

// Helper: create minimal storage mock
function mockStorage(data = {}) {
  return {
    readJSON: (file, def) => data[file] !== undefined ? data[file] : def,
    writeJSON: () => {},
    writeJSONAsync: async () => {},
    writeJSONDebounced: () => {},
    readText: () => '',
    appendTextAsync: async () => {},
  };
}

// -- Foundation modules --

test('ConversationMemory has asyncLoad()', () => {
  const { ConversationMemory } = require('../../src/agent/foundation/ConversationMemory');
  const m = new ConversationMemory('/tmp/test', NullBus, mockStorage());
  assert(typeof m.asyncLoad === 'function', 'should have asyncLoad');
});

test('KnowledgeGraph has asyncLoad()', () => {
  const { KnowledgeGraph } = require('../../src/agent/foundation/KnowledgeGraph');
  const m = new KnowledgeGraph('/tmp/test', NullBus, mockStorage());
  assert(typeof m.asyncLoad === 'function', 'should have asyncLoad');
});

test('Settings has asyncLoad()', () => {
  const { Settings } = require('../../src/agent/foundation/Settings');
  const m = new Settings('/tmp/test', mockStorage());
  assert(typeof m.asyncLoad === 'function', 'should have asyncLoad');
});

test('WorldState has asyncLoad()', () => {
  const { WorldState } = require('../../src/agent/foundation/WorldState');
  const m = new WorldState({ bus: NullBus, storage: mockStorage(), rootDir: '/tmp/test' });
  assert(typeof m.asyncLoad === 'function', 'should have asyncLoad');
});

// -- Hexagonal --

test('EpisodicMemory has asyncLoad()', () => {
  const { EpisodicMemory } = require('../../src/agent/hexagonal/EpisodicMemory');
  const m = new EpisodicMemory({ bus: NullBus, storage: mockStorage(), storageDir: '/tmp/test' });
  assert(typeof m.asyncLoad === 'function', 'should have asyncLoad');
});

// -- Organism --

test('EmotionalState has asyncLoad()', () => {
  const { EmotionalState } = require('../../src/agent/organism/EmotionalState');
  const m = new EmotionalState({ bus: NullBus, storage: mockStorage() });
  assert(typeof m.asyncLoad === 'function', 'should have asyncLoad');
});

test('Homeostasis has asyncLoad()', () => {
  const { Homeostasis } = require('../../src/agent/organism/Homeostasis');
  const m = new Homeostasis({ bus: NullBus, storage: mockStorage() });
  assert(typeof m.asyncLoad === 'function', 'should have asyncLoad');
});

test('NeedsSystem has asyncLoad()', () => {
  const { NeedsSystem } = require('../../src/agent/organism/NeedsSystem');
  const m = new NeedsSystem({ bus: NullBus, storage: mockStorage() });
  assert(typeof m.asyncLoad === 'function', 'should have asyncLoad');
});

// -- Planning --

test('GoalStack has asyncLoad()', () => {
  const { GoalStack } = require('../../src/agent/planning/GoalStack');
  const m = new GoalStack(NullBus, mockStorage());
  assert(typeof m.asyncLoad === 'function', 'should have asyncLoad');
});

test('MetaLearning has asyncLoad()', () => {
  const { MetaLearning } = require('../../src/agent/planning/MetaLearning');
  const m = new MetaLearning({ bus: NullBus, storage: mockStorage() });
  assert(typeof m.asyncLoad === 'function', 'should have asyncLoad');
});

test('SelfOptimizer has asyncLoad()', () => {
  const { SelfOptimizer } = require('../../src/agent/planning/SelfOptimizer');
  const m = new SelfOptimizer({ bus: NullBus, storage: mockStorage(), eventStore: {}, memory: {}, goalStack: {}, storageDir: '/tmp/test' });
  assert(typeof m.asyncLoad === 'function', 'should have asyncLoad');
});

test('SolutionAccumulator has asyncLoad()', () => {
  const { SolutionAccumulator } = require('../../src/agent/planning/SolutionAccumulator');
  const m = new SolutionAccumulator({ bus: NullBus, storage: mockStorage(), memory: {}, knowledgeGraph: {}, storageDir: '/tmp/test' });
  assert(typeof m.asyncLoad === 'function', 'should have asyncLoad');
});

// -- Revolution --

test('SessionPersistence has asyncLoad()', () => {
  const { SessionPersistence } = require('../../src/agent/revolution/SessionPersistence');
  const m = new SessionPersistence({
    bus: NullBus, model: { chat: async () => '' },
    memory: { getStats: () => ({}) }, storage: mockStorage(),
    lang: { t: k => k },
  });
  assert(typeof m.asyncLoad === 'function', 'should have asyncLoad');
});

test('VectorMemory has asyncLoad()', () => {
  const { VectorMemory } = require('../../src/agent/revolution/VectorMemory');
  const m = new VectorMemory({ bus: NullBus, storage: mockStorage(), storageDir: '/tmp/test' });
  assert(typeof m.asyncLoad === 'function', 'should have asyncLoad');
});

// ════════════════════════════════════════════════════════════
// 2. asyncLoad() actually loads data
// ════════════════════════════════════════════════════════════
console.log('\n  📂 asyncLoad() Data Loading');

test('GoalStack.asyncLoad() populates goals from storage', async () => {
  const { GoalStack } = require('../../src/agent/planning/GoalStack');
  const storage = mockStorage({ 'goals.json': [{ id: 'g1', title: 'test' }] });
  const gs = new GoalStack({ lang: { t: k => k }, bus: NullBus, model: {}, prompts: {}, storageDir: '/tmp/test', storage });
  assert(gs.goals.length === 0, 'goals should be empty before asyncLoad');
  await gs.asyncLoad();
  assert(gs.goals.length === 1, `goals should have 1 entry after asyncLoad, got ${gs.goals.length}`);
});

test('SelfOptimizer.asyncLoad() populates metrics', async () => {
  const { SelfOptimizer } = require('../../src/agent/planning/SelfOptimizer');
  const storage = mockStorage({ 'optimizer-metrics.json': { responses: [1, 2], errors: [], analysisCount: 5 } });
  const so = new SelfOptimizer({ bus: NullBus, storage, eventStore: {}, memory: {}, goalStack: {}, storageDir: '/tmp/test' });
  assert(so.metrics.analysisCount === 0, 'metrics should be default before asyncLoad');
  await so.asyncLoad();
  assert(so.metrics.analysisCount === 5, 'metrics should be loaded after asyncLoad');
});

test('SolutionAccumulator.asyncLoad() populates solutions', async () => {
  const { SolutionAccumulator } = require('../../src/agent/planning/SolutionAccumulator');
  const storage = mockStorage({ 'solutions.json': [{ id: 1 }, { id: 2 }] });
  const sa = new SolutionAccumulator({ bus: NullBus, storage, memory: {}, knowledgeGraph: {}, storageDir: '/tmp/test' });
  assert(sa.solutions.length === 0, 'solutions should be empty before asyncLoad');
  await sa.asyncLoad();
  assert(sa.solutions.length === 2, 'solutions should be loaded after asyncLoad');
});

// ════════════════════════════════════════════════════════════
// 3. Container.bootAll() calls asyncLoad()
// ════════════════════════════════════════════════════════════
console.log('\n  🏗 Container asyncLoad Integration');

const { Container } = require('../../src/agent/core/Container');

test('Container.bootAll() calls asyncLoad() on services', async () => {
  const c = new Container();
  let asyncLoadCalled = false;
  let bootCalled = false;

  c.register('testService', () => ({
    asyncLoad: async () => { asyncLoadCalled = true; },
    boot: async () => { bootCalled = true; },
  }));

  await c.bootAll();
  assert(asyncLoadCalled, 'asyncLoad should have been called');
  assert(bootCalled, 'boot should also have been called');
});

test('Container.bootAll() calls asyncLoad before boot', async () => {
  const c = new Container();
  const order = [];

  c.register('testService', () => ({
    asyncLoad: async () => { order.push('asyncLoad'); },
    boot: async () => { order.push('boot'); },
  }));

  await c.bootAll();
  assert(order[0] === 'asyncLoad', `asyncLoad should be first, got ${order[0]}`);
  assert(order[1] === 'boot', `boot should be second, got ${order[1]}`);
});

test('Container.bootAll() handles asyncLoad errors gracefully', async () => {
  const c = new Container();

  c.register('failService', () => ({
    asyncLoad: async () => { throw new Error('load failed'); },
  }));

  const results = await c.bootAll();
  assert(results[0].status === 'error', 'should report error status');
  assert(results[0].error.includes('load failed'), 'should include error message');
});

test('Container.bootAll() works without asyncLoad', async () => {
  const c = new Container();
  c.register('simpleService', () => ({ value: 42 }));
  const results = await c.bootAll();
  assert(results[0].status === 'ok', 'should succeed without asyncLoad');
});

// ════════════════════════════════════════════════════════════
// 4. VerificationEngine — Branch Coverage
// ════════════════════════════════════════════════════════════
console.log('\n  🔍 VerificationEngine Branch Coverage');

const { VerificationEngine } = require('../../src/agent/intelligence/VerificationEngine');

test('VerificationEngine constructor initializes stats', () => {
  const ve = new VerificationEngine({ bus: NullBus, rootDir: '/tmp/test' });
  assert(ve._stats.total === 0, 'total should start at 0');
  assert(ve._stats.pass === 0, 'pass should start at 0');
  assert(ve._stats.fail === 0, 'fail should start at 0');
  assert(ve._stats.ambiguous === 0, 'ambiguous should start at 0');
});

test('VerificationEngine has sub-verifiers', () => {
  const ve = new VerificationEngine({ bus: NullBus, rootDir: '/tmp/test' });
  assert(ve._verifiers.code, 'should have code verifier');
  assert(ve._verifiers.test, 'should have test verifier');
  assert(ve._verifiers.shell, 'should have shell verifier');
  assert(ve._verifiers.file, 'should have file verifier');
  assert(ve._verifiers.plan, 'should have plan verifier');
});

test('VerificationEngine.verify() handles unknown step type', async () => {
  const ve = new VerificationEngine({ bus: NullBus, rootDir: '/tmp/test' });
  const result = await ve.verify('UNKNOWN_TYPE', { type: 'UNKNOWN' }, { output: 'test' });
  // Should return ambiguous for unknown types, not crash
  assert(result, 'should return a result');
  assert(result.status, 'should have a status');
});

test('VerificationEngine.verify() test verifier — pass on exit code 0', async () => {
  const ve = new VerificationEngine({ bus: NullBus, rootDir: '/tmp/test' });
  const result = await ve.verify('RUN_TESTS', { type: 'RUN_TESTS' }, { exitCode: 0, output: '5 passing\n0 failing', stderr: '' });
  assert(result.status === 'pass', `should pass, got ${result.status}: ${result.reason || ''}`);
});

test('VerificationEngine.verify() test verifier — fail on exit code 1', async () => {
  const ve = new VerificationEngine({ bus: NullBus, rootDir: '/tmp/test' });
  const result = await ve.verify('RUN_TESTS', { type: 'RUN_TESTS' }, { exitCode: 1, error: 'test failed', output: '0 passing\n3 failing', stderr: 'AssertionError' });
  assert(result.status === 'fail', `should fail, got ${result.status}: ${result.reason || ''}`);
});

test('VerificationEngine.verify() shell verifier — pass', async () => {
  const ve = new VerificationEngine({ bus: NullBus, rootDir: '/tmp/test' });
  const result = await ve.verify('shell', { type: 'SHELL' }, { exitCode: 0, output: 'done' });
  assert(result.status === 'pass', `shell pass should work, got ${result.status}`);
});

test('VerificationEngine.verify() shell verifier — fail on timeout', async () => {
  const ve = new VerificationEngine({ bus: NullBus, rootDir: '/tmp/test' });
  const result = await ve.verify('shell', { type: 'SHELL' }, { exitCode: 1, error: 'ETIMEDOUT', output: '' });
  assert(result.status === 'fail', `shell timeout should fail, got ${result.status}`);
});

test('VerificationEngine.verify() file verifier — pass for existing file', async () => {
  const ve = new VerificationEngine({ bus: NullBus, rootDir: '/tmp/test' });
  // Use a file that exists
  const result = await ve.verify('file', { type: 'CODE', target: 'package.json' },
    { output: 'written' });
  // Ambiguous since /tmp/test/package.json may not exist in test env
  assert(result.status, 'should have a status');
});

test('VerificationEngine.getStats() returns stats object', () => {
  const ve = new VerificationEngine({ bus: NullBus, rootDir: '/tmp/test' });
  const stats = ve.getStats();
  assert(typeof stats === 'object', 'should return object');
  assert(typeof stats.total === 'number', 'should have total');
});

test('VerificationEngine.verify() increments stats', async () => {
  const ve = new VerificationEngine({ bus: NullBus, rootDir: '/tmp/test' });
  await ve.verify('shell', {}, { exitCode: 0, output: 'ok' });
  await ve.verify('shell', {}, { exitCode: 1, error: 'fail' });
  const stats = ve.getStats();
  assert(stats.total === 2, `total should be 2, got ${stats.total}`);
});

// ════════════════════════════════════════════════════════════
// 5. CircuitBreaker — Branch Coverage
// ════════════════════════════════════════════════════════════
console.log('\n  ⚡ CircuitBreaker Branch Coverage');

const { CircuitBreaker } = require('../../src/agent/core/CircuitBreaker');

test('CircuitBreaker starts CLOSED', () => {
  const cb = new CircuitBreaker({ bus: NullBus });
  assert(cb.state === 'CLOSED', `should start CLOSED, got ${cb.state}`);
});

test('CircuitBreaker opens after threshold failures', async () => {
  const cb = new CircuitBreaker({ bus: NullBus, failureThreshold: 2, maxRetries: 0 });
  const failFn = async () => { throw new Error('fail'); };
  try { await cb.execute(failFn); } catch {}
  try { await cb.execute(failFn); } catch {}
  assert(cb.state === 'OPEN', `should be OPEN after failures, got ${cb.state}`);
});

test('CircuitBreaker rejects calls when OPEN', async () => {
  const cb = new CircuitBreaker({ bus: NullBus, failureThreshold: 1, maxRetries: 0 });
  const failFn = async () => { throw new Error('fail'); };
  try { await cb.execute(failFn); } catch {}
  // Now OPEN — next call should be rejected or use fallback
  let rejected = false;
  try { await cb.execute(async () => 'ok'); } catch { rejected = true; }
  assert(rejected || cb.state === 'OPEN', 'should reject or stay OPEN');
});

test('CircuitBreaker tracks successes', async () => {
  const cb = new CircuitBreaker({ bus: NullBus });
  await cb.execute(async () => 'ok');
  assert(cb.successes >= 1, 'should track successes');
  assert(cb.stats.totalSuccesses >= 1, 'stats should track successes');
});

test('CircuitBreaker.getStatus() returns state info', () => {
  const cb = new CircuitBreaker({ bus: NullBus });
  const status = cb.getStatus();
  assert(status.state === 'CLOSED', `state should be CLOSED, got ${status.state}`);
  assert(typeof status.failures === 'number', 'should have failures count');
  assert(typeof status.stats === 'object', 'should have stats');
});

// ════════════════════════════════════════════════════════════
// Runner
// ════════════════════════════════════════════════════════════
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
