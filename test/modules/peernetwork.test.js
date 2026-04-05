// ============================================================
// Test: PeerHealth + PeerNetwork validation methods
// ============================================================
let passed = 0, failed = 0;
const failures = [];

// v3.5.2: Fixed — queue-based async-safe test runner
const _testQueue = [];
function test(name, fn) { _testQueue.push({ name, fn }); }
function assert(c, m) { if (!c) throw new Error(m || 'Assertion failed'); }

const { PeerHealth } = require('../../src/agent/hexagonal/PeerNetwork');

console.log('\n  🌐 PeerHealth + PeerNetwork Validation');

// ── PeerHealth ──────────────────────────────────────────

test('new PeerHealth starts healthy', () => {
  const h = new PeerHealth();
  assert(h.isHealthy, 'Should start healthy');
  assert(h.failures === 0);
  assert(h.successes === 0);
  assert(h.avgLatency === Infinity, 'No latencies yet');
});

test('recordSuccess tracks latency and resets failures', () => {
  const h = new PeerHealth();
  h.recordFailure();
  h.recordFailure();
  assert(h.failures === 2);
  h.recordSuccess(50);
  assert(h.failures === 0, 'Failures should reset on success');
  assert(h.successes === 1);
  assert(h.avgLatency === 50);
});

test('avgLatency computes running average', () => {
  const h = new PeerHealth();
  h.recordSuccess(100);
  h.recordSuccess(200);
  h.recordSuccess(300);
  assert(h.avgLatency === 200, `Expected 200, got ${h.avgLatency}`);
});

test('latency window is capped at 10', () => {
  const h = new PeerHealth();
  for (let i = 0; i < 15; i++) h.recordSuccess(i * 10);
  assert(h.latencies.length === 10, `Expected 10 latencies, got ${h.latencies.length}`);
});

test('recordFailure increments and tracks backoff', () => {
  const h = new PeerHealth();
  h.recordFailure();
  assert(h.failures === 1);
  assert(h.backoffMs === 2000, `Backoff should double: ${h.backoffMs}`);
  h.recordFailure();
  assert(h.backoffMs === 4000);
  h.recordFailure();
  assert(h.backoffMs === 8000);
});

test('backoff caps at 60s', () => {
  const h = new PeerHealth();
  for (let i = 0; i < 20; i++) h.recordFailure();
  assert(h.backoffMs === 60000, `Backoff should cap at 60000: ${h.backoffMs}`);
});

test('success resets backoff', () => {
  const h = new PeerHealth();
  h.recordFailure();
  h.recordFailure();
  h.recordFailure();
  assert(h.backoffMs > 1000);
  h.recordSuccess(10);
  assert(h.backoffMs === 1000, 'Backoff should reset to 1000');
});

test('isHealthy false after 3 failures', () => {
  const h = new PeerHealth();
  h.recordFailure();
  h.recordFailure();
  assert(h.isHealthy, 'Should still be healthy at 2 failures');
  h.recordFailure();
  assert(!h.isHealthy, 'Should be unhealthy at 3 failures');
});

test('isHealthy false when stale (>120s)', () => {
  const h = new PeerHealth();
  h.lastSeen = Date.now() - 130000; // 130 seconds ago
  assert(!h.isHealthy, 'Should be unhealthy when stale');
});

test('score is lower for healthier peers', () => {
  const healthy = new PeerHealth();
  healthy.recordSuccess(20);
  healthy.recordSuccess(30);

  const slow = new PeerHealth();
  slow.recordSuccess(500);
  slow.recordSuccess(600);

  const failing = new PeerHealth();
  failing.recordFailure();
  failing.recordFailure();
  failing.recordSuccess(50);

  assert(healthy.score < slow.score, `Healthy (${healthy.score}) should score lower than slow (${slow.score})`);
  assert(healthy.score < failing.score, `Healthy (${healthy.score}) should score lower than failing (${failing.score})`);
});

// ── PeerNetwork validation (import methods) ─────────────

// We test the static validation methods by creating a minimal PeerNetwork
// Stubbing out everything except the validators

function createMinimalNetwork() {
  const { PeerNetwork } = require('../../src/agent/hexagonal/PeerNetwork');
  const net = new PeerNetwork(
    // selfModel mock
    { getFullModel: () => ({ identity: 'test', version: '1.0' }), getCapabilities: () => [], readModule: () => null },
    // skills mock
    { listSkills: () => [], loadedSkills: new Map() },
    // model mock
    { chat: async () => '' },
    // prompts mock
    {}
  );
  // FIX v5.1.0 (DI-1): CodeSafety via lateBinding
  net._codeSafety = require('../../src/agent/ports/CodeSafetyPort').CodeSafetyAdapter.fromScanner();
  return net;
}

test('_validateManifest accepts valid manifest', () => {
  const net = createMinimalNetwork();
  const result = net._validateManifest({ name: 'my-skill', description: 'A test skill' });
  assert(result.ok, 'Should be valid');
});

test('_validateManifest rejects missing name', () => {
  const net = createMinimalNetwork();
  const result = net._validateManifest({ description: 'No name' });
  assert(!result.ok);
  assert(result.error.includes('name'));
});

test('_validateManifest rejects missing description', () => {
  const net = createMinimalNetwork();
  const result = net._validateManifest({ name: 'test' });
  assert(!result.ok);
  assert(result.error.includes('description'));
});

test('_validateManifest rejects long names', () => {
  const net = createMinimalNetwork();
  const result = net._validateManifest({ name: 'a'.repeat(65), description: 'test' });
  assert(!result.ok);
  assert(result.error.includes('long'));
});

test('_validateManifest rejects special characters', () => {
  const net = createMinimalNetwork();
  const result = net._validateManifest({ name: 'my skill!', description: 'test' });
  assert(!result.ok);
  assert(result.error.includes('characters'));
});

test('_validateImportedCode accepts clean code', () => {
  let hasAcorn = false;
  try { require('acorn'); hasAcorn = true; } catch {}
  if (!hasAcorn) { console.log('    ⏭  skipped (acorn not installed — scanner blocks all)'); return; }
  const net = createMinimalNetwork();
  const result = net._validateImportedCode('function hello() { return "world"; }');
  assert(result.ok, 'Should accept clean code');
});

test('_validateImportedCode blocks process.exit', () => {
  const net = createMinimalNetwork();
  const result = net._validateImportedCode('process.exit(1)');
  assert(!result.ok);
});

test('_validateImportedCode blocks eval', () => {
  const net = createMinimalNetwork();
  const result = net._validateImportedCode('eval("dangerous")');
  assert(!result.ok);
});

test('_validateImportedCode blocks child_process', () => {
  const net = createMinimalNetwork();
  const result = net._validateImportedCode("const cp = require('child_process');");
  assert(!result.ok);
});

test('_validateImportedCode blocks process.env access', () => {
  const net = createMinimalNetwork();
  const result = net._validateImportedCode('const key = process.env.SECRET_KEY;');
  assert(!result.ok);
});

test('_validateImportedCode rejects oversized code', () => {
  const net = createMinimalNetwork();
  const result = net._validateImportedCode('x'.repeat(100001));
  assert(!result.ok);
  assert(result.error.includes('100KB'));
});

test('_validateImportedCode allows 100KB exactly', () => {
  let hasAcorn = false;
  try { require('acorn'); hasAcorn = true; } catch {}
  if (!hasAcorn) { console.log('    ⏭  skipped (acorn not installed — scanner blocks all)'); return; }
  const net = createMinimalNetwork();
  const result = net._validateImportedCode('x'.repeat(100000));
  assert(result.ok, 'Should allow exactly 100KB');
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
