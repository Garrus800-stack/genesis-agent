// ============================================================
// Test: HealthMonitor.js — Latency, memory, degradation, auto-CB
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

const { HealthMonitor } = require('../../src/agent/autonomy/HealthMonitor');
const { EventBus } = require('../../src/agent/core/EventBus');

function createHM(overrides = {}) {
  const testBus = new EventBus();
  return new HealthMonitor({
    circuitBreaker: overrides.cb || {
      state: 'CLOSED',
      _transition: function(s) { this.state = s; },
      getStatus: function() { return { name: 'llm', state: this.state }; },
    },
    eventStore: { append: () => {} },
    workerPool: overrides.workerPool || {
      getStatus: () => ({ workers: 2, maxWorkers: 4, busy: 0, queued: 0 }),
    },
    bus: testBus,
  });
}

console.log('\n  📦 HealthMonitor');

// ── Latency Tracking ────────────────────────────────────────

test('recordLatency creates service entry', () => {
  const hm = createHM();
  hm.recordLatency('testService', 100);
  const lat = hm.getLatencyFor('testService');
  assert(lat !== null, 'Should have latency data');
  assert(lat.samples === 1);
  assert(lat.avg === 100);
});

test('recordLatency computes percentiles', () => {
  const hm = createHM();
  for (let i = 1; i <= 100; i++) hm.recordLatency('svc', i * 10);
  const lat = hm.getLatencyFor('svc');
  assert(lat.p50 > 0, 'p50 should be computed');
  assert(lat.p95 > lat.p50, 'p95 > p50');
  assert(lat.p99 >= lat.p95, 'p99 >= p95');
  assert(lat.avg > 0, 'avg should be > 0');
});

test('recordLatency trims window at max size', () => {
  const hm = createHM();
  hm._latencyWindowSize = 10;
  for (let i = 0; i < 50; i++) hm.recordLatency('trim', i);
  const lat = hm.getLatencyFor('trim');
  assert(lat.samples === 10, `Expected 10 samples, got ${lat.samples}`);
});

test('getLatencyFor returns null for unknown service', () => {
  const hm = createHM();
  assert(hm.getLatencyFor('nope') === null);
});

test('critical latency triggers degradation', () => {
  const hm = createHM();
  hm.recordLatency('slow', 6000); // Above 5000ms critical threshold
  const report = hm.getReport();
  assert(report.degradation.slow !== undefined, 'Should have degradation entry');
  assert(report.degradation.slow.level === 'critical');
});

test('warning latency triggers degraded level', () => {
  const hm = createHM();
  hm.recordLatency('medium', 3000); // Above 2000ms warning
  const report = hm.getReport();
  assert(report.degradation.medium?.level === 'degraded');
});

test('normal latency does not trigger degradation', () => {
  const hm = createHM();
  hm.recordLatency('fast', 50);
  const report = hm.getReport();
  assert(report.degradation.fast === undefined);
});

// ── Memory Tracking ─────────────────────────────────────────

test('_captureMemorySnapshot stores snapshot', () => {
  const hm = createHM();
  hm._captureMemorySnapshot();
  assert(hm._memorySnapshots.length === 1);
  assert(hm._memorySnapshots[0].heapUsed > 0);
});

test('_getMemoryMB returns positive values', () => {
  const hm = createHM();
  const mem = hm._getMemoryMB();
  assert(mem.heapUsed > 0, 'heapUsed should be positive');
  assert(mem.rss > 0, 'rss should be positive');
});

test('_getMemoryTrend returns insufficient-data with few snapshots', () => {
  const hm = createHM();
  hm._captureMemorySnapshot();
  assert(hm._getMemoryTrend() === 'insufficient-data');
});

test('memory snapshots trimmed at max', () => {
  const hm = createHM();
  hm._memoryMaxSnapshots = 5;
  for (let i = 0; i < 20; i++) hm._captureMemorySnapshot();
  assert(hm._memorySnapshots.length === 5, `Expected 5, got ${hm._memorySnapshots.length}`);
});

test('_isMemoryLeakSuspected returns false with insufficient data', () => {
  const hm = createHM();
  assert(hm._isMemoryLeakSuspected() === false);
});

// ── Degradation State ───────────────────────────────────────

test('_escalateDegradation sets level', () => {
  const hm = createHM();
  hm._escalateDegradation('llm', 'degraded', 'test');
  assert(hm._degradationState.has('llm'));
  assert(hm._degradationState.get('llm').level === 'degraded');
});

test('escalation only increases, never decreases', () => {
  const hm = createHM();
  hm._escalateDegradation('svc', 'critical', 'bad');
  hm._escalateDegradation('svc', 'degraded', 'less bad'); // Should not downgrade
  assert(hm._degradationState.get('svc').level === 'critical', 'Should stay critical');
});

test('_decayDegradation reduces old entries', () => {
  const hm = createHM();
  hm._degradationState.set('old', { level: 'degraded', since: Date.now() - 200000, reason: 'test' });
  hm._decayDegradation();
  assert(!hm._degradationState.has('old'), 'Old degraded entry should be removed');
});

test('_decayDegradation downgrades critical to degraded', () => {
  const hm = createHM();
  hm._degradationState.set('crit', { level: 'critical', since: Date.now() - 200000, reason: 'test' });
  hm._decayDegradation();
  assert(hm._degradationState.get('crit').level === 'degraded', 'Should downgrade to degraded');
});

test('_overallStatus returns healthy when no degradation', () => {
  const hm = createHM();
  assert(hm._overallStatus() === 'healthy');
});

test('_overallStatus returns critical when any service is critical', () => {
  const hm = createHM();
  hm._escalateDegradation('svc', 'critical', 'bad');
  assert(hm._overallStatus() === 'critical');
});

// ── Report ──────────────────────────────────────────────────

test('getReport returns full structured report', () => {
  const hm = createHM();
  hm.recordLatency('test', 50);
  hm._captureMemorySnapshot();
  const report = hm.getReport();

  assert(report.status === 'healthy');
  assert(typeof report.timestamp === 'string');
  assert(typeof report.latency === 'object');
  assert(typeof report.memory === 'object');
  assert(typeof report.degradation === 'object');
  assert(typeof report.uptime === 'number');
  assert(report.workerPool !== null);
  assert(report.circuitBreaker !== null);
});

// ── Lifecycle ───────────────────────────────────────────────

test('start/stop controls interval', () => {
  const hm = createHM();
  hm.start(100000); // Long interval to avoid actual ticks
  assert(hm._started === true);
  assert(hm._interval !== null);
  hm.stop();
  assert(hm._started === false);
  assert(hm._interval === null);
});

test('start is idempotent', () => {
  const hm = createHM();
  hm.start(100000);
  const firstInterval = hm._interval;
  hm.start(100000); // Should not create new interval
  assert(hm._interval === firstInterval, 'Should reuse same interval');
  hm.stop();
});

// ── Async Tests ─────────────────────────────────────────────

async function runAsync() {
  await test('checkNow runs a full tick without error', async () => {
    const hm = createHM();
    await hm.checkNow();
    // Should have captured at least one memory snapshot
    assert(hm._memorySnapshots.length >= 1);
  });

  await test('auto-circuit: sustained critical degradation forces CB open', async () => {
    const cb = {
      state: 'CLOSED',
      _transition: function(s) { this.state = s; },
      getStatus: function() { return { name: 'llm', state: this.state }; },
    };
    const hm = createHM({ cb });

    // Simulate sustained critical degradation (>30s ago)
    hm._degradationState.set('llm', {
      level: 'critical',
      since: Date.now() - 35000, // 35s ago
      reason: 'test',
    });

    await hm._tick();
    assert(cb.state === 'OPEN', `Expected CB to be forced OPEN, got ${cb.state}`);
  });

  await test('workerPool queue backlog triggers degradation', async () => {
    const hm = createHM({
      workerPool: { getStatus: () => ({ workers: 2, maxWorkers: 2, busy: 2, queued: 10 }) },
    });
    await hm._tick();
    assert(hm._degradationState.has('workerPool'), 'Should flag workerPool degradation');
  });
}

runAsync().then(() => {
  console.log(`\n  ${passed} passed, ${failed} failed`);
  if (failures.length > 0) failures.forEach(f => console.log(`    FAIL: ${f.name} — ${f.error}`));
  process.exit(failed > 0 ? 1 : 0);
});
