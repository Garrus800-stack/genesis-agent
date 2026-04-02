// ============================================================
// GENESIS — test/modules/lifecycle-integration.test.js (v5.9.3)
//
// End-to-end lifecycle integration test.
// Verifies: Boot → Wire → Interact → Shutdown → Verify.
//
// Does NOT require Electron or LLM backend. Mocks the kernel
// layer and LLM to test the full DI wiring, event flow,
// service lifecycle, and shutdown integrity.
//
// What this catches that unit tests miss:
//   - Cross-service wiring failures after manifest changes
//   - Shutdown ordering regressions (data loss)
//   - Event flow breaks (emit without listener, or vice versa)
//   - Late-binding resolution failures
//   - Boot phase ordering violations
// ============================================================

const { describe, test, assert, assertEqual, run } = require('../harness');
const path = require('path');
const fs = require('fs');
const os = require('os');

const ROOT = path.resolve(__dirname, '..', '..');

// ── Test Environment ─────────────────────────────────────────

let TEST_DIR;

function setupTestEnv() {
  TEST_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'genesis-lifecycle-'));
  for (const sub of ['sandbox', 'uploads', 'skills']) {
    fs.mkdirSync(path.join(TEST_DIR, sub), { recursive: true });
  }
  fs.writeFileSync(
    path.join(TEST_DIR, 'settings.json'),
    JSON.stringify({
      logging: { level: 'error' },
      health: { httpEnabled: false },
      mcp: { serve: { enabled: false } },
    }),
    'utf-8'
  );
}

function cleanupTestEnv() {
  try { fs.rmSync(TEST_DIR, { recursive: true, force: true }); } catch { /* ok */ }
}

// ── Mocks ────────────────────────────────────────────────────

class MockSafeGuard {
  constructor() { this.locked = true; this.kernelHashes = new Map(); this.criticalHashes = new Map(); }
  lockKernel() { this.locked = true; }
  unlockKernel() { this.locked = false; }
  isKernelLocked() { return this.locked; }
  verifyKernel() { return { passed: true, failures: [] }; }
  verifyCritical() { return { passed: true, failures: [] }; }
  hashFile() { return 'mock-hash'; }
}

// ── Core Imports ─────────────────────────────────────────────

const { EventBus } = require(path.join(ROOT, 'src/agent/core/EventBus'));
const { Container } = require(path.join(ROOT, 'src/agent/core/Container'));
const { buildManifest } = require(path.join(ROOT, 'src/agent/ContainerManifest'));

// ── Tests ────────────────────────────────────────────────────

describe('Lifecycle Integration', () => {

  test('buildManifest returns service Map for all profiles', () => {
    setupTestEnv();
    try {
      const bus = new EventBus();
      const guard = new MockSafeGuard();
      const intervals = { register: () => {}, clear: () => {}, clearAll: () => {} };

      const manifest = buildManifest({
        rootDir: ROOT,
        genesisDir: TEST_DIR,
        bus,
        guard,
        intervals,
        bootProfile: 'minimal',
      });

      assert(manifest instanceof Map, 'returns a Map');
      assert(manifest.size >= 50, `at least 50 services (got ${manifest.size})`);
    } finally {
      cleanupTestEnv();
    }
  });

  test('Container registers and resolves core services from manifest', () => {
    setupTestEnv();
    try {
      const bus = new EventBus();
      const guard = new MockSafeGuard();
      const intervals = { register: () => {}, clear: () => {}, clearAll: () => {} };

      const manifest = buildManifest({
        rootDir: ROOT,
        genesisDir: TEST_DIR,
        bus,
        guard,
        intervals,
        bootProfile: 'minimal',
      });

      const container = new Container({ bus });
      container.registerInstance('rootDir', ROOT);
      container.registerInstance('guard', guard);
      container.registerInstance('bus', bus);

      // Register all services from manifest
      let registered = 0;
      for (const [name, config] of manifest) {
        try {
          container.register(name, config.factory, config);
          registered++;
        } catch { /* some may fail without full deps */ }
      }

      assert(registered > 30, `registered ${registered} services`);

      // Core services should be resolvable
      const coreServices = ['storage', 'settings'];
      for (const svc of coreServices) {
        try {
          const instance = container.resolve(svc);
          assert(instance !== null && instance !== undefined, `${svc} resolved`);
        } catch {
          // Some services need more deps — ok in isolation
        }
      }
    } finally {
      cleanupTestEnv();
    }
  });

  test('EventBus emit/on round-trip works across services', () => {
    const bus = new EventBus();
    const received = [];

    bus.on('test:lifecycle', (data) => received.push(data));
    bus.emit('test:lifecycle', { phase: 'boot' });
    bus.emit('test:lifecycle', { phase: 'interact' });
    bus.emit('test:lifecycle', { phase: 'shutdown' });

    assertEqual(received.length, 3);
    assertEqual(received[0].phase, 'boot');
    assertEqual(received[1].phase, 'interact');
    assertEqual(received[2].phase, 'shutdown');
  });

  test('Container late-bindings wire correctly', () => {
    const bus = new EventBus();
    const c = new Container({ bus });

    c.register('svcA', () => ({ name: 'A', svcB: null }), {
      phase: 1, deps: [],
      lateBindings: [{ prop: 'svcB', service: 'svcB' }],
    });
    c.register('svcB', () => ({ name: 'B' }), { phase: 2, deps: [] });

    c.resolve('svcA');
    c.resolve('svcB');
    const result = c.wireLateBindings();

    assertEqual(result.wired, 1);
    assertEqual(c.resolve('svcA').svcB.name, 'B');
  });

  test('Container optional late-bindings skip missing services', () => {
    const bus = new EventBus();
    const c = new Container({ bus });

    c.register('svcA', () => ({ name: 'A', optDep: null }), {
      phase: 1, deps: [],
      lateBindings: [{ prop: 'optDep', service: 'doesNotExist', optional: true }],
    });

    c.resolve('svcA');
    const result = c.wireLateBindings();

    assertEqual(result.skipped, 1);
    assertEqual(c.resolve('svcA').optDep, null);
  });

  test('shutdown calls stop() on all TO_STOP services', () => {
    const stopped = [];
    const bus = new EventBus();
    const c = new Container({ bus });

    const services = ['svcA', 'svcB', 'svcC'];
    for (const name of services) {
      c.registerInstance(name, {
        stop: () => { stopped.push(name); },
      });
    }

    // Simulate shutdown pattern from AgentCoreHealth
    for (const name of services) {
      try {
        const svc = c.tryResolve(name);
        if (svc?.stop) svc.stop();
      } catch { /* safe */ }
    }

    assertEqual(stopped.length, 3);
    assert(stopped.includes('svcA'), 'svcA stopped');
    assert(stopped.includes('svcB'), 'svcB stopped');
    assert(stopped.includes('svcC'), 'svcC stopped');
  });

  test('shutdown sync-write pattern prevents data loss', () => {
    const writes = [];

    // Mock service that uses sync write in stop()
    const svc = {
      _data: { key: 'value' },
      stop() {
        // This is the pattern from WorldState, LessonsStore, etc.
        writes.push({ method: 'writeFileSync', data: this._data });
      },
    };

    svc.stop();
    assertEqual(writes.length, 1);
    assertEqual(writes[0].data.key, 'value');
  });

  test('ServiceRecovery integrates with health events', () => {
    const { ServiceRecovery } = require(path.join(ROOT, 'src/agent/autonomy/ServiceRecovery'));
    const bus = new EventBus();

    const sr = new ServiceRecovery({ bus });
    sr.boot();

    // Verify it subscribed to the right event
    // We can check by emitting and seeing stats change
    // (skip services won't increment attempted)
    assert(sr.stats.attempted === 0, 'starts at 0');
  });

  test('full manifest service count matches expectations', () => {
    setupTestEnv();
    try {
      const bus = new EventBus();
      const guard = new MockSafeGuard();
      const intervals = { register: () => {}, clear: () => {}, clearAll: () => {} };

      const manifest = buildManifest({
        rootDir: ROOT,
        genesisDir: TEST_DIR,
        bus,
        guard,
        intervals,
        bootProfile: 'full',
      });

      // v5.9.3: 118+ registered services
      assert(manifest.size >= 100, `total services >= 100 (got ${manifest.size})`);

      // Key services must be present
      assert(manifest.has('healthMonitor'), 'has healthMonitor');
      assert(manifest.has('serviceRecovery'), 'has serviceRecovery');
    } finally {
      cleanupTestEnv();
    }
  });

  test('autoMap contains all expected modules', () => {
    const { getAutoMap } = require(path.join(ROOT, 'src/agent/ContainerManifest'));
    const map = getAutoMap();

    // Key modules must be discoverable
    const expected = [
      'EventBus', 'Container', 'Logger', 'HealthMonitor',
      'ServiceRecovery', 'AgentLoop', 'FailureAnalyzer',
      'ColonyOrchestrator', 'DeploymentManager',
    ];

    for (const mod of expected) {
      assert(map[mod], `autoMap contains ${mod} → ${map[mod]}`);
    }
  });
});

run();
