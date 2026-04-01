// ============================================================
// Test: CircuitBreaker.js — State machine, retries, fallback
// ============================================================
let passed = 0, failed = 0;
const failures = [];

function test(name, fn) {
  // v3.5.2: Fixed — try/catch around fn() for sync errors
  try {
    const result = fn();
    if (result && typeof result.then === 'function') {
      return result.then(() => {
        passed++; console.log(`    ✅ ${name}`);
      }).catch(err => {
        failed++; failures.push({ name, error: err.message });
        console.log(`    ❌ ${name}: ${err.message}`);
      });
    }
    passed++; console.log(`    ✅ ${name}`);
  } catch (err) {
    failed++; failures.push({ name, error: err.message });
    console.log(`    ❌ ${name}: ${err.message}`);
  }
}
function assert(c, m) { if (!c) throw new Error(m || 'Assertion failed'); }

const { CircuitBreaker } = require('../../src/agent/core/CircuitBreaker');

console.log('\n  📦 CircuitBreaker');

// Sync tests
test('starts in CLOSED state', () => {
  const cb = new CircuitBreaker({ name: 'test' });
  assert(cb.state === 'CLOSED', `Expected CLOSED, got ${cb.state}`);
  assert(cb.failures === 0);
});

test('getStatus returns structured data', () => {
  const cb = new CircuitBreaker({ name: 'test-status' });
  const s = cb.getStatus();
  assert(s.name === 'test-status');
  assert(s.state === 'CLOSED');
  assert(typeof s.stats === 'object');
});

test('reset forces CLOSED', () => {
  const cb = new CircuitBreaker({ name: 'test-reset' });
  cb.state = 'OPEN';
  cb.failures = 5;
  cb.reset();
  assert(cb.state === 'CLOSED');
  assert(cb.failures === 0);
});

// Async tests
async function runAsync() {
  await test('successful call stays CLOSED', async () => {
    const cb = new CircuitBreaker({ name: 'ok', failureThreshold: 3, maxRetries: 0, timeoutMs: 1000 });
    const result = await cb.execute(() => Promise.resolve('done'));
    assert(result === 'done', `Expected 'done', got '${result}'`);
    assert(cb.state === 'CLOSED');
    assert(cb.stats.totalSuccesses === 1);
  });

  await test('tracks failure count', async () => {
    const cb = new CircuitBreaker({ name: 'fail', failureThreshold: 3, maxRetries: 0, timeoutMs: 1000 });
    try { await cb.execute(() => Promise.reject(new Error('boom'))); } catch {}
    assert(cb.failures === 1, `Expected 1 failure, got ${cb.failures}`);
    assert(cb.state === 'CLOSED', 'Should still be CLOSED after 1 failure');
  });

  await test('opens after threshold failures', async () => {
    const cb = new CircuitBreaker({ name: 'threshold', failureThreshold: 2, maxRetries: 0, timeoutMs: 1000 });
    try { await cb.execute(() => Promise.reject(new Error('f1'))); } catch {}
    try { await cb.execute(() => Promise.reject(new Error('f2'))); } catch {}
    assert(cb.state === 'OPEN', `Expected OPEN, got ${cb.state}`);
  });

  await test('OPEN circuit rejects immediately without fallback', async () => {
    const cb = new CircuitBreaker({ name: 'open-reject', failureThreshold: 1, maxRetries: 0, cooldownMs: 60000, timeoutMs: 1000 });
    try { await cb.execute(() => Promise.reject(new Error('trigger'))); } catch {}
    assert(cb.state === 'OPEN');

    let rejected = false;
    try { await cb.execute(() => Promise.resolve('should not run')); }
    catch (err) { rejected = true; assert(err.message.includes('OPEN'), `Expected OPEN error, got: ${err.message}`); }
    assert(rejected, 'Should have thrown');
  });

  await test('OPEN circuit uses fallback when provided', async () => {
    const cb = new CircuitBreaker({
      name: 'fallback', failureThreshold: 1, maxRetries: 0,
      cooldownMs: 60000, timeoutMs: 1000,
      fallback: () => 'fallback-result',
    });
    try { await cb.execute(() => Promise.reject(new Error('trigger'))); } catch {}
    assert(cb.state === 'OPEN');

    const result = await cb.execute(() => Promise.resolve('nope'));
    assert(result === 'fallback-result', `Expected fallback, got: ${result}`);
    assert(cb.stats.totalFallbacks >= 1);
  });

  await test('retries before counting as failure', async () => {
    let attempts = 0;
    const cb = new CircuitBreaker({ name: 'retry', failureThreshold: 3, maxRetries: 2, retryDelayMs: 10, timeoutMs: 1000 });

    try {
      await cb.execute(() => { attempts++; return Promise.reject(new Error('retry-me')); });
    } catch {}

    assert(attempts === 3, `Expected 3 attempts (1 + 2 retries), got ${attempts}`);
    assert(cb.failures === 1, 'Should count as 1 failure, not 3');
  });

  await test('retry succeeds on second attempt', async () => {
    let attempts = 0;
    const cb = new CircuitBreaker({ name: 'retry-ok', maxRetries: 2, retryDelayMs: 10, timeoutMs: 1000 });

    const result = await cb.execute(() => {
      attempts++;
      if (attempts < 2) return Promise.reject(new Error('not yet'));
      return Promise.resolve('ok');
    });

    assert(result === 'ok');
    assert(attempts === 2);
    assert(cb.state === 'CLOSED');
  });

  await test('timeout triggers failure', async () => {
    const cb = new CircuitBreaker({ name: 'timeout', failureThreshold: 1, maxRetries: 0, timeoutMs: 50 });

    let timedOut = false;
    try {
      await cb.execute(() => new Promise(resolve => setTimeout(resolve, 200)));
    } catch (err) {
      timedOut = true;
      assert(err.message.includes('Timeout'), `Expected timeout error, got: ${err.message}`);
    }
    assert(timedOut, 'Should have timed out');
  });

  await test('HALF_OPEN transitions to CLOSED on success', async () => {
    const cb = new CircuitBreaker({ name: 'half-open', failureThreshold: 1, maxRetries: 0, cooldownMs: 1, timeoutMs: 1000 });
    try { await cb.execute(() => Promise.reject(new Error('open it'))); } catch {}
    assert(cb.state === 'OPEN');

    // Wait for cooldown to elapse
    await new Promise(r => setTimeout(r, 10));
    const result = await cb.execute(() => Promise.resolve('recovered'));
    assert(result === 'recovered');
    assert(cb.state === 'CLOSED', `Expected CLOSED, got ${cb.state}`);
  });

  await test('HALF_OPEN returns to OPEN on failure', async () => {
    const cb = new CircuitBreaker({ name: 'half-fail', failureThreshold: 1, maxRetries: 0, cooldownMs: 1, timeoutMs: 1000 });
    try { await cb.execute(() => Promise.reject(new Error('open'))); } catch {}
    assert(cb.state === 'OPEN');

    await new Promise(r => setTimeout(r, 10));
    try { await cb.execute(() => Promise.reject(new Error('still broken'))); } catch {}
    assert(cb.state === 'OPEN', `Expected OPEN, got ${cb.state}`);
  });

  await test('stats track all metrics', async () => {
    const cb = new CircuitBreaker({ name: 'stats', maxRetries: 0, failureThreshold: 10, timeoutMs: 1000 });
    await cb.execute(() => Promise.resolve(1));
    await cb.execute(() => Promise.resolve(2));
    try { await cb.execute(() => Promise.reject(new Error('x'))); } catch {}

    assert(cb.stats.totalCalls === 3, `Expected 3 calls, got ${cb.stats.totalCalls}`);
    assert(cb.stats.totalSuccesses === 2, `Expected 2 successes, got ${cb.stats.totalSuccesses}`);
    assert(cb.stats.totalFailures === 1, `Expected 1 failure, got ${cb.stats.totalFailures}`);
  });

  await test('state changes are recorded', async () => {
    const cb = new CircuitBreaker({ name: 'changes', failureThreshold: 1, maxRetries: 0, cooldownMs: 1, timeoutMs: 1000 });
    try { await cb.execute(() => Promise.reject(new Error('x'))); } catch {}
    await new Promise(r => setTimeout(r, 10));
    await cb.execute(() => Promise.resolve('ok'));

    const changes = cb.stats.stateChanges;
    assert(changes.length >= 2, `Expected >= 2 state changes, got ${changes.length}`);
    assert(changes[0].from === 'CLOSED' && changes[0].to === 'OPEN');
  });
}

runAsync().then(() => {
  console.log(`\n  ${passed} passed, ${failed} failed`);
  if (failures.length > 0) failures.forEach(f => console.log(`    FAIL: ${f.name} — ${f.error}`));
  process.exit(failed > 0 ? 1 : 0);
});
