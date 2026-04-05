// ============================================================
// GENESIS — test/modules/writelock.test.js (v3.8.0)
// Tests for WriteLock: mutex, timeout, deadlock safety, stats
// ============================================================

const { describe, test, assert, assertEqual, assertRejects, run } = require('../harness');
const { WriteLock } = require('../../src/agent/core/WriteLock');

describe('WriteLock — Basic Mutex', () => {
  test('acquire + release cycle', async () => {
    const lock = new WriteLock({ name: 'test', defaultTimeoutMs: 1000 });
    assert(!lock.isLocked, 'should start unlocked');
    await lock.acquire();
    assert(lock.isLocked, 'should be locked after acquire');
    lock.release();
    assert(!lock.isLocked, 'should be unlocked after release');
  });

  test('withLock executes function and releases', async () => {
    const lock = new WriteLock({ name: 'test' });
    let executed = false;
    await lock.withLock(async () => { executed = true; });
    assert(executed, 'function should have executed');
    assert(!lock.isLocked, 'should release after withLock');
  });

  test('withLock releases on error', async () => {
    const lock = new WriteLock({ name: 'test' });
    try {
      await lock.withLock(async () => { throw new Error('deliberate'); });
    } catch (err) {
      assertEqual(err.message, 'deliberate');
    }
    assert(!lock.isLocked, 'should release even after error');
  });

  test('withLock returns value', async () => {
    const lock = new WriteLock({ name: 'test' });
    const result = await lock.withLock(async () => 42);
    assertEqual(result, 42);
  });
});

describe('WriteLock — Queueing', () => {
  test('second acquire waits until release', async () => {
    const lock = new WriteLock({ name: 'test', defaultTimeoutMs: 5000 });
    const order = [];

    await lock.acquire();
    order.push('first-acquired');

    const p2 = lock.acquire().then(() => { order.push('second-acquired'); });
    assertEqual(lock.queueLength, 1, 'should have 1 in queue');

    // Release first — second should proceed
    lock.release();
    await p2;
    order.push('done');
    lock.release();

    assertEqual(order.join(','), 'first-acquired,second-acquired,done');
  });

  test('multiple waiters are served in order', async () => {
    const lock = new WriteLock({ name: 'test', defaultTimeoutMs: 5000 });
    const order = [];

    await lock.acquire();
    const p1 = lock.acquire().then(() => { order.push(1); lock.release(); });
    const p2 = lock.acquire().then(() => { order.push(2); lock.release(); });
    const p3 = lock.acquire().then(() => { order.push(3); lock.release(); });

    assertEqual(lock.queueLength, 3);
    lock.release();
    await Promise.all([p1, p2, p3]);
    assertEqual(order.join(','), '1,2,3');
  });
});

describe('WriteLock — Timeout', () => {
  test('timeout rejects with WRITELOCK_TIMEOUT code', async () => {
    const lock = new WriteLock({ name: 'timeout-test', defaultTimeoutMs: 50 });
    await lock.acquire();

    try {
      await lock.acquire(); // Should timeout after 50ms
      assert(false, 'should have thrown');
    } catch (err) {
      assertEqual(err.code, 'WRITELOCK_TIMEOUT');
      assert(err.message.includes('timeout-test'), 'message should include lock name');
    }

    lock.release(); // Clean up
  });

  test('custom timeout overrides default', async () => {
    const lock = new WriteLock({ name: 'test', defaultTimeoutMs: 60000 });
    await lock.acquire();

    try {
      await lock.acquire(30); // 30ms override
      assert(false, 'should have thrown');
    } catch (err) {
      assertEqual(err.code, 'WRITELOCK_TIMEOUT');
    }

    lock.release();
  });

  test('timeout 0 means no timeout', async () => {
    const lock = new WriteLock({ name: 'test', defaultTimeoutMs: 0 });
    await lock.acquire();

    // With timeout=0, the acquire should wait forever.
    // We test that it does NOT reject by racing with a timer.
    let timedOut = false;
    const p = lock.acquire(0).then(() => { timedOut = false; lock.release(); });
    await new Promise(r => setTimeout(r, 100));

    // The acquire should still be pending (not timed out)
    assertEqual(lock.queueLength, 1, 'waiter should still be in queue');

    lock.release(); // Unblock the waiter
    await p;
    assert(!lock.isLocked);
  });
});

describe('WriteLock — Stats', () => {
  test('tracks acquires and releases', async () => {
    const lock = new WriteLock({ name: 'stats-test' });
    await lock.acquire();
    lock.release();
    await lock.acquire();
    lock.release();

    const stats = lock.getStats();
    assertEqual(stats.acquires, 2);
    assertEqual(stats.releases, 2);
    assertEqual(stats.timeouts, 0);
    assertEqual(stats.name, 'stats-test');
  });

  test('tracks peak queue length', async () => {
    const lock = new WriteLock({ name: 'peak-test', defaultTimeoutMs: 5000 });
    await lock.acquire();

    const p1 = lock.acquire().then(() => lock.release());
    const p2 = lock.acquire().then(() => lock.release());

    assertEqual(lock.getStats().peakQueue, 2);

    lock.release();
    await Promise.all([p1, p2]);
  });

  test('tracks timeouts', async () => {
    const lock = new WriteLock({ name: 'test', defaultTimeoutMs: 20 });
    await lock.acquire();
    try { await lock.acquire(); } catch { /* expected */ }
    try { await lock.acquire(); } catch { /* expected */ }
    lock.release();

    assertEqual(lock.getStats().timeouts, 2);
  });
});

describe('WriteLock — Edge Cases', () => {
  test('no-arg constructor works (backwards compat)', () => {
    const lock = new WriteLock();
    assertEqual(lock._name, 'unnamed');
    assert(lock._defaultTimeoutMs === 30000);
  });

  test('non-object constructor arg defaults gracefully', () => {
    const lock = new WriteLock('not-an-object');
    assertEqual(lock._name, 'unnamed');
  });

  test('getStats returns correct shape', () => {
    const lock = new WriteLock({ name: 'shape' });
    const stats = lock.getStats();
    assert('acquires' in stats);
    assert('releases' in stats);
    assert('timeouts' in stats);
    assert('peakQueue' in stats);
    assert('locked' in stats);
    assert('queueLength' in stats);
    assert('name' in stats);
  });
});

run();
