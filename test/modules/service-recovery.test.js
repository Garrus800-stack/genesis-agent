// ============================================================
// GENESIS — test/modules/service-recovery.test.js (v5.9.3)
//
// Tests ServiceRecovery: degradation handling, strategies,
// circuit breaker, health verification, event emission.
// ============================================================

const { describe, test, assert, assertEqual, run } = require('../harness');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const { ServiceRecovery } = require(path.join(ROOT, 'src/agent/autonomy/ServiceRecovery'));

// ── Mock Dependencies ───────────────────────────────────────

function mockBus() {
  const events = [];
  const handlers = {};
  return {
    on: (evt, fn) => { handlers[evt] = fn; return () => { delete handlers[evt]; }; },
    emit: (evt, data, meta) => events.push({ evt, data, meta }),
    _events: events,
    _handlers: handlers,
    _fire: (evt, data, meta) => handlers[evt]?.(data, meta),
  };
}

function mockContainer(services = {}) {
  const resolved = new Map(Object.entries(services));
  return {
    resolved,
    resolve: (name) => {
      if (resolved.has(name)) return resolved.get(name);
      throw new Error(`Not found: ${name}`);
    },
    tryResolve: (name, fallback = null) => resolved.get(name) || fallback,
    wireLateBindings: () => ({ wired: 0 }),
  };
}

// ── Tests ────────────────────────────────────────────────────

describe('ServiceRecovery', () => {

  test('constructs with minimal deps', () => {
    const bus = mockBus();
    const sr = new ServiceRecovery({ bus });
    assert(sr.bus === bus, 'bus assigned');
    assert(sr.stats.attempted === 0, 'stats zeroed');
  });

  test('boot() subscribes to health:degradation', () => {
    const bus = mockBus();
    const sr = new ServiceRecovery({ bus });
    sr.boot();
    assert(bus._handlers['health:degradation'], 'handler registered');
  });

  test('stop() unsubscribes', () => {
    const bus = mockBus();
    const sr = new ServiceRecovery({ bus });
    sr.boot();
    assert(bus._handlers['health:degradation'], 'handler before stop');
    sr.stop();
    // unsub function was called — handler should be removed
    assert(sr._unsubs.length === 0, 'unsubs cleared');
  });

  test('skips non-recoverable services (bus, storage, guard)', async () => {
    const bus = mockBus();
    const sr = new ServiceRecovery({ bus });
    sr.boot();

    await bus._fire('health:degradation', { service: 'bus', level: 'critical', reason: 'test' });
    assertEqual(sr.stats.attempted, 0);

    await bus._fire('health:degradation', { service: 'storage', level: 'critical', reason: 'test' });
    assertEqual(sr.stats.attempted, 0);
  });

  test('skips non-critical levels', async () => {
    const bus = mockBus();
    const sr = new ServiceRecovery({ bus });
    sr.boot();

    await bus._fire('health:degradation', { service: 'knowledgeGraph', level: 'info', reason: 'test' });
    assertEqual(sr.stats.attempted, 0);
  });

  test('reinit strategy calls asyncLoad()', async () => {
    const bus = mockBus();
    let loaded = false;
    const svc = { asyncLoad: async () => { loaded = true; } };
    const container = mockContainer({ knowledgeGraph: svc });

    const sr = new ServiceRecovery({ bus, container });
    sr.boot();

    await bus._fire('health:degradation', { service: 'knowledgeGraph', level: 'critical', reason: 'test' });
    assertEqual(sr.stats.attempted, 1);
    assertEqual(sr.stats.succeeded, 1);
    assert(loaded, 'asyncLoad was called');

    const recoveryEvt = bus._events.find(e => e.evt === 'health:recovery');
    assert(recoveryEvt, 'health:recovery emitted');
    assertEqual(recoveryEvt.data.service, 'knowledgeGraph');
    assertEqual(recoveryEvt.data.strategy, 'reinit');
  });

  test('reset strategy calls reset()', async () => {
    const bus = mockBus();
    let wasReset = false;
    const svc = { reset: async () => { wasReset = true; } };
    const container = mockContainer({ customService: svc });

    const sr = new ServiceRecovery({ bus, container });
    sr.boot();

    await bus._fire('health:degradation', { service: 'customService', level: 'degraded', reason: 'stuck' });
    assert(wasReset, 'reset() was called');
    assertEqual(sr.stats.succeeded, 1);
  });

  test('emits recovery-failed on error', async () => {
    const bus = mockBus();
    const svc = { asyncLoad: async () => { throw new Error('boom'); } };
    const container = mockContainer({ lessonsStore: svc });

    const sr = new ServiceRecovery({ bus, container });
    sr.boot();

    await bus._fire('health:degradation', { service: 'lessonsStore', level: 'critical', reason: 'crash' });
    assertEqual(sr.stats.failed, 1);

    const failEvt = bus._events.find(e => e.evt === 'health:recovery-failed');
    assert(failEvt, 'health:recovery-failed emitted');
    assertEqual(failEvt.data.service, 'lessonsStore');
    assertEqual(failEvt.data.error, 'boom');
  });

  test('circuit breaker trips after MAX_RETRIES', async () => {
    const bus = mockBus();
    const svc = { asyncLoad: async () => { throw new Error('fail'); } };
    const container = mockContainer({ lessonsStore: svc });

    const sr = new ServiceRecovery({ bus, container });
    sr.boot();

    // Attempt 3 times → should exhaust
    for (let i = 0; i < 3; i++) {
      await bus._fire('health:degradation', { service: 'lessonsStore', level: 'critical', reason: 'crash' });
    }
    assertEqual(sr.stats.failed, 3);
    assertEqual(sr.stats.exhausted, 1);

    const exhaustEvt = bus._events.find(e => e.evt === 'health:recovery-exhausted');
    assert(exhaustEvt, 'health:recovery-exhausted emitted');

    // 4th attempt should be skipped
    await bus._fire('health:degradation', { service: 'lessonsStore', level: 'critical', reason: 'again' });
    assertEqual(sr.stats.attempted, 3); // still 3
  });

  test('getStats() returns tracker state', async () => {
    const bus = mockBus();
    const svc = { asyncLoad: async () => {} };
    const container = mockContainer({ knowledgeGraph: svc });

    const sr = new ServiceRecovery({ bus, container });
    sr.boot();

    await bus._fire('health:degradation', { service: 'knowledgeGraph', level: 'critical', reason: 'test' });

    const stats = sr.getStats();
    assertEqual(stats.attempted, 1);
    assertEqual(stats.succeeded, 1);
    assert(stats.services.knowledgeGraph, 'tracker has service entry');
    assertEqual(stats.services.knowledgeGraph.attempts, 1);
    assertEqual(stats.services.knowledgeGraph.exhausted, false);
  });

  test('containerConfig is valid', () => {
    const cfg = ServiceRecovery.containerConfig;
    assertEqual(cfg.name, 'serviceRecovery');
    assertEqual(cfg.phase, 7);
    assert(Array.isArray(cfg.deps), 'has deps array');
    assert(Array.isArray(cfg.lateBindings), 'has lateBindings');
  });

  test('verifyHealth uses getHealth() if available', async () => {
    const bus = mockBus();
    const svc = {
      asyncLoad: async () => {},
      getHealth: async () => ({ status: 'healthy' }),
    };
    const container = mockContainer({ knowledgeGraph: svc });

    const sr = new ServiceRecovery({ bus, container });
    sr.boot();

    await bus._fire('health:degradation', { service: 'knowledgeGraph', level: 'critical', reason: 'test' });
    assertEqual(sr.stats.succeeded, 1);
  });

  test('verifyHealth returns false for critical health', async () => {
    const bus = mockBus();
    let loadCount = 0;
    const svc = {
      asyncLoad: async () => { loadCount++; },
      getHealth: async () => ({ status: 'critical' }),
    };
    const container = mockContainer({ knowledgeGraph: svc });

    const sr = new ServiceRecovery({ bus, container });
    sr.boot();

    await bus._fire('health:degradation', { service: 'knowledgeGraph', level: 'critical', reason: 'test' });
    assertEqual(sr.stats.failed, 1);  // recovery "succeeded" but health check failed
  });
});

run();
