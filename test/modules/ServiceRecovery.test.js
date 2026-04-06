#!/usr/bin/env node
// Test: ServiceRecovery — auto-recovery for degraded services
const { describe, test, assert, assertEqual, run } = require('../harness');
const { createBus } = require('../../src/agent/core/EventBus');
const { ServiceRecovery } = require('../../src/agent/autonomy/ServiceRecovery');

function mockContainer(services = {}) {
  const resolved = new Map(Object.entries(services));
  return {
    resolved,
    resolve: (name) => { if (!resolved.has(name)) throw new Error(`Not found: ${name}`); return resolved.get(name); },
    tryResolve: (name, fallback) => resolved.get(name) ?? fallback,
    wireLateBindings: () => {},
  };
}

function mockService(overrides = {}) {
  return {
    asyncLoad: async () => {},
    stop: () => {},
    getHealth: () => ({ status: 'healthy' }),
    ...overrides,
  };
}

describe('ServiceRecovery', () => {

  test('boot subscribes to health:degradation', () => {
    const bus = createBus();
    const sr = new ServiceRecovery({ bus });
    sr.boot();
    assertEqual(sr._unsubs.length, 1);
    sr.stop();
  });

  test('stop unsubscribes', () => {
    const bus = createBus();
    const sr = new ServiceRecovery({ bus });
    sr.boot();
    sr.stop();
    assertEqual(sr._unsubs.length, 0);
  });

  test('ignores info-level degradation', async () => {
    const bus = createBus();
    const sr = new ServiceRecovery({ bus });
    sr.boot();
    bus.emit('health:degradation', { service: 'llm', level: 'info', reason: 'slow' });
    await new Promise(r => setTimeout(r, 10));
    assertEqual(sr.stats.attempted, 0);
    sr.stop();
  });

  test('ignores skip services (bus, storage, etc)', async () => {
    const bus = createBus();
    const sr = new ServiceRecovery({ bus });
    sr.boot();
    bus.emit('health:degradation', { service: 'bus', level: 'critical', reason: 'test' });
    await new Promise(r => setTimeout(r, 10));
    assertEqual(sr.stats.attempted, 0);
    sr.stop();
  });

  test('classifies reinit services correctly', () => {
    const bus = createBus();
    const sr = new ServiceRecovery({ bus });
    assertEqual(sr._classifyStrategy('knowledgeGraph'), 'reinit');
    assertEqual(sr._classifyStrategy('lessonsStore'), 'reinit');
    assertEqual(sr._classifyStrategy('vectorMemory'), 'reinit');
  });

  test('classifies skip services correctly', () => {
    const bus = createBus();
    const sr = new ServiceRecovery({ bus });
    assertEqual(sr._classifyStrategy('bus'), 'skip');
    assertEqual(sr._classifyStrategy('storage'), 'skip');
  });

  test('classifies reset for services with reset()', () => {
    const svc = mockService({ reset: async () => {} });
    const container = mockContainer({ myService: svc });
    const bus = createBus();
    const sr = new ServiceRecovery({ bus, container });
    assertEqual(sr._classifyStrategy('myService'), 'reset');
  });

  test('falls back to restart for unknown services', () => {
    const svc = { stop: () => {} }; // no asyncLoad, no reset
    const container = mockContainer({ myService: svc });
    const bus = createBus();
    const sr = new ServiceRecovery({ bus, container });
    assertEqual(sr._classifyStrategy('myService'), 'restart');
  });

  test('reinit strategy calls asyncLoad', async () => {
    let loaded = false;
    const svc = mockService({ asyncLoad: async () => { loaded = true; } });
    const container = mockContainer({ testSvc: svc });
    const bus = createBus();
    const sr = new ServiceRecovery({ bus, container });
    await sr._executeStrategy('testSvc', 'reinit');
    assert(loaded, 'asyncLoad should have been called');
  });

  test('reset strategy calls reset', async () => {
    let wasReset = false;
    const svc = mockService({ reset: async () => { wasReset = true; } });
    const container = mockContainer({ testSvc: svc });
    const bus = createBus();
    const sr = new ServiceRecovery({ bus, container });
    await sr._executeStrategy('testSvc', 'reset');
    assert(wasReset, 'reset should have been called');
  });

  test('skip strategy throws', async () => {
    const bus = createBus();
    const sr = new ServiceRecovery({ bus });
    let threw = false;
    try { await sr._executeStrategy('bus', 'skip'); } catch { threw = true; }
    assert(threw, 'skip should throw');
  });

  test('circuit breaker trips after 3 attempts', () => {
    const bus = createBus();
    const sr = new ServiceRecovery({ bus });
    sr._recordAttempt('testSvc');
    sr._recordAttempt('testSvc');
    sr._recordAttempt('testSvc');
    assert(sr._isExhausted('testSvc'), 'should be exhausted after 3');
    assertEqual(sr._getAttemptCount('testSvc'), 3);
  });

  test('circuit breaker does not trip at 2 attempts', () => {
    const bus = createBus();
    const sr = new ServiceRecovery({ bus });
    sr._recordAttempt('testSvc');
    sr._recordAttempt('testSvc');
    assert(!sr._isExhausted('testSvc'), 'should not be exhausted at 2');
  });

  test('successful recovery emits health:recovery', async () => {
    const svc = mockService();
    const container = mockContainer({ testSvc: svc });
    const bus = createBus();
    const sr = new ServiceRecovery({ bus, container });
    sr.boot();
    let recovered = null;
    bus.on('health:recovery', (data) => { recovered = data; });
    bus.emit('health:degradation', { service: 'testSvc', level: 'critical', reason: 'test' });
    await new Promise(r => setTimeout(r, 30));
    assert(recovered !== null, 'should emit health:recovery');
    assertEqual(recovered.service, 'testSvc');
    assertEqual(sr.stats.succeeded, 1);
    sr.stop();
  });

  test('failed recovery emits health:recovery-failed', async () => {
    const svc = mockService({
      asyncLoad: async () => { throw new Error('boom'); },
    });
    const container = mockContainer({ testSvc: svc });
    const bus = createBus();
    const sr = new ServiceRecovery({ bus, container });
    sr.boot();
    let failed = null;
    bus.on('health:recovery-failed', (data) => { failed = data; });
    bus.emit('health:degradation', { service: 'testSvc', level: 'degraded', reason: 'test' });
    await new Promise(r => setTimeout(r, 30));
    // testSvc has asyncLoad → classified as reinit → asyncLoad throws
    assert(failed !== null, 'should emit health:recovery-failed');
    assertEqual(failed.service, 'testSvc');
    assertEqual(sr.stats.failed, 1);
    sr.stop();
  });

  test('getStats returns stats and tracker state', () => {
    const bus = createBus();
    const sr = new ServiceRecovery({ bus });
    sr._recordAttempt('svcA');
    sr._recordAttempt('svcA');
    const stats = sr.getStats();
    assertEqual(stats.services.svcA.attempts, 2);
    assert(!stats.services.svcA.exhausted);
  });

  test('verifyHealth returns true for healthy service', async () => {
    const svc = mockService({ getHealth: () => ({ status: 'ok' }) });
    const container = mockContainer({ testSvc: svc });
    const bus = createBus();
    const sr = new ServiceRecovery({ bus, container });
    const ok = await sr._verifyHealth('testSvc');
    assert(ok, 'should be healthy');
  });

  test('verifyHealth returns false for critical service', async () => {
    const svc = mockService({ getHealth: () => ({ status: 'critical' }) });
    const container = mockContainer({ testSvc: svc });
    const bus = createBus();
    const sr = new ServiceRecovery({ bus, container });
    const ok = await sr._verifyHealth('testSvc');
    assert(!ok, 'should not be healthy');
  });

  test('verifyHealth returns false for missing service', async () => {
    const container = mockContainer({});
    const bus = createBus();
    const sr = new ServiceRecovery({ bus, container });
    const ok = await sr._verifyHealth('nonExistent');
    assert(!ok, 'should return false for missing');
  });
});

run();
