// ============================================================
// Test: IntervalManager — lifecycle, pause/resume, cleanup
// ============================================================
let passed = 0, failed = 0;
const failures = [];

// v3.5.2: Fixed — queue-based async-safe test runner
const _testQueue = [];
function test(name, fn) { _testQueue.push({ name, fn }); }
function assert(c, m) { if (!c) throw new Error(m || 'Assertion failed'); }

const { IntervalManager } = require('../../src/agent/core/IntervalManager');

console.log('\n  ⏱️  IntervalManager');

// ── Registration ────────────────────────────────────────

test('register creates named interval', () => {
  const im = new IntervalManager();
  let count = 0;
  im.register('test1', () => { count++; }, 50);
  const status = im.getStatus();
  assert(status.length === 1, `Expected 1 interval, got ${status.length}`);
  assert(status[0].name === 'test1');
  assert(status[0].intervalMs === 50);
  assert(status[0].paused === false);
  im.shutdown();
});

test('register with immediate runs callback sync', () => {
  const im = new IntervalManager();
  let called = false;
  im.register('imm', () => { called = true; }, 999999, { immediate: true });
  assert(called, 'Callback should have been called immediately');
  im.shutdown();
});

test('re-register clears old interval', () => {
  const im = new IntervalManager();
  im.register('dup', () => {}, 100);
  im.register('dup', () => {}, 200);
  const status = im.getStatus();
  assert(status.length === 1, 'Should still have 1 interval');
  assert(status[0].intervalMs === 200, 'Should have updated interval');
  im.shutdown();
});

// ── Clear ───────────────────────────────────────────────

test('clear removes specific interval', () => {
  const im = new IntervalManager();
  im.register('a', () => {}, 100);
  im.register('b', () => {}, 100);
  im.clear('a');
  const status = im.getStatus();
  assert(status.length === 1);
  assert(status[0].name === 'b');
  im.shutdown();
});

test('clear non-existent is a no-op', () => {
  const im = new IntervalManager();
  im.clear('nope'); // Should not throw
  im.shutdown();
});

// ── Pause / Resume ──────────────────────────────────────

test('pause marks interval as paused', () => {
  const im = new IntervalManager();
  im.register('p', () => {}, 100);
  im.pause('p');
  const status = im.getStatus();
  assert(status[0].paused === true, 'Should be paused');
  im.shutdown();
});

test('resume restarts paused interval', () => {
  const im = new IntervalManager();
  im.register('r', () => {}, 100);
  im.pause('r');
  im.resume('r');
  const status = im.getStatus();
  assert(status[0].paused === false, 'Should be resumed');
  im.shutdown();
});

test('pauseAll pauses all intervals', () => {
  const im = new IntervalManager();
  im.register('x', () => {}, 100);
  im.register('y', () => {}, 100);
  im.pauseAll();
  const status = im.getStatus();
  assert(status.every(s => s.paused), 'All should be paused');
  im.shutdown();
});

test('resumeAll resumes all intervals', () => {
  const im = new IntervalManager();
  im.register('x', () => {}, 100);
  im.register('y', () => {}, 100);
  im.pauseAll();
  im.resumeAll();
  const status = im.getStatus();
  assert(status.every(s => !s.paused), 'All should be resumed');
  im.shutdown();
});

// ── Shutdown ────────────────────────────────────────────

test('shutdown clears all and prevents new registrations', () => {
  const im = new IntervalManager();
  im.register('a', () => {}, 100);
  im.register('b', () => {}, 100);
  im.shutdown();
  assert(im.getStatus().length === 0, 'All intervals should be cleared');
  im.register('c', () => {}, 100); // Should be silently ignored
  assert(im.getStatus().length === 0, 'New registrations should be blocked');
});

// ── Error safety ────────────────────────────────────────

test('callback errors dont crash the manager', (done) => {
  const im = new IntervalManager();
  // Register a callback that throws — it should be caught
  im.register('err', () => { throw new Error('boom'); }, 50, { immediate: true });
  // If we get here, the error was caught
  assert(im.getStatus().length === 1, 'Interval should still be registered');
  im.shutdown();
});

// ── Report ──────────────────────────────────────────────

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
