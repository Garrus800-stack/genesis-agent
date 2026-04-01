// ============================================================
// Test: ModelBridge.js — concurrency semaphore, backend config
// ============================================================
let passed = 0, failed = 0;
const failures = [];

// v3.5.2: Fixed — queue-based async-safe test runner
const _testQueue = [];
function test(name, fn) { _testQueue.push({ name, fn }); }
function assert(c, m) { if (!c) throw new Error(m || 'Assertion failed'); }

const { ModelBridge } = require('../../src/agent/foundation/ModelBridge');

console.log('\n  🤖 ModelBridge (Concurrency)');

// ── Construction ──

test('creates with default config', () => {
  const mb = new ModelBridge({});
  assert(mb.activeModel === null, 'no model selected by default');
  assert(mb.backends.ollama, 'should have ollama backend');
  assert(mb.backends.anthropic, 'should have anthropic backend');
  assert(mb.backends.openai, 'should have openai backend');
});

test('has concurrency stats', () => {
  const mb = new ModelBridge({});
  const stats = mb.getConcurrencyStats();
  assert(typeof stats.active === 'number', 'should have active count');
  assert(typeof stats.queued === 'number', 'should have queued count');
  assert(stats.active === 0, 'initially no active requests');
});

// ── Semaphore ──

test('semaphore limits concurrency', async () => {
  const mb = new ModelBridge({ maxConcurrentLLM: 2 });
  const sem = mb._semaphore;

  // Acquire 2 — should succeed immediately
  await sem.acquire(0);
  await sem.acquire(0);
  assert(sem.active === 2, 'should have 2 active');

  // Third acquire should queue
  let thirdResolved = false;
  const thirdPromise = sem.acquire(0).then(() => { thirdResolved = true; });
  // Give microtask a chance to resolve
  await new Promise(r => setTimeout(r, 10));
  assert(!thirdResolved, 'third acquire should be queued');
  assert(sem.queue.length === 1, 'should have 1 queued');

  // Release one — third should now proceed
  sem.release();
  await new Promise(r => setTimeout(r, 10));
  assert(thirdResolved, 'third should resolve after release');
  assert(sem.active === 2, 'should still have 2 active (one released, one dequeued)');

  // Cleanup
  sem.release();
  sem.release();
});

test('semaphore respects priority (higher goes first)', async () => {
  const mb = new ModelBridge({ maxConcurrentLLM: 1 });
  const sem = mb._semaphore;
  const order = [];

  // Fill the slot
  await sem.acquire(0);

  // Queue two requests: low priority then high priority
  sem.acquire(1).then(() => { order.push('low'); sem.release(); });
  sem.acquire(10).then(() => { order.push('high'); sem.release(); });

  await new Promise(r => setTimeout(r, 10));
  assert(sem.queue.length === 2, 'should have 2 queued');

  // Release — high priority should go first
  sem.release();
  await new Promise(r => setTimeout(r, 10));
  sem.release();
  await new Promise(r => setTimeout(r, 10));

  assert(order[0] === 'high', `expected high first, got: ${order.join(', ')}`);
  assert(order[1] === 'low', `expected low second, got: ${order.join(', ')}`);
});

test('semaphore tracks peak stats', async () => {
  const mb = new ModelBridge({ maxConcurrentLLM: 1 });
  const sem = mb._semaphore;

  await sem.acquire(0);
  sem.acquire(0); // queued
  sem.acquire(0); // queued
  await new Promise(r => setTimeout(r, 10));

  const stats = sem.getStats();
  assert(stats.peakActive >= 1, 'peak active should be at least 1');
  assert(stats.peakQueued >= 2, 'peak queued should be at least 2');

  // Cleanup
  sem.release();
  await new Promise(r => setTimeout(r, 10));
  sem.release();
  await new Promise(r => setTimeout(r, 10));
  sem.release();
});

// ── Backend config ──

test('configureBackend adds anthropic models', () => {
  const mb = new ModelBridge({});
  mb.configureBackend('anthropic', { apiKey: 'test-key' });
  const anthropic = mb.availableModels.find(m => m.backend === 'anthropic');
  assert(anthropic, 'should add anthropic model');
  assert(anthropic.name.includes('claude'), 'model name should contain claude');
});

test('temperature profiles are set', () => {
  const mb = new ModelBridge({});
  assert(mb.temperatures.code === 0.1, 'code temp should be 0.1');
  assert(mb.temperatures.chat === 0.7, 'chat temp should be 0.7');
  assert(mb.temperatures.creative === 0.9, 'creative temp should be 0.9');
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
