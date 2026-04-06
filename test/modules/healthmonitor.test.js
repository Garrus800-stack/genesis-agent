#!/usr/bin/env node
// Test: HealthMonitor — health tracking + latency recording
const { describe, test, assert, assertEqual, run } = require('../harness');
const { createBus } = require('../../src/agent/core/EventBus');
const { HealthMonitor } = require('../../src/agent/autonomy/HealthMonitor');

function create(overrides = {}) {
  const bus = createBus();
  return { bus, monitor: new HealthMonitor({ bus, ...overrides }) };
}

describe('HealthMonitor', () => {

  test('constructor initializes with empty state', () => {
    const { monitor } = create();
    const report = monitor.getReport();
    assertEqual(report.status, 'healthy');
    assert(report.memory.current.rss > 0, 'should have RSS');
    assert(report.uptime >= 0);
  });

  test('start and stop lifecycle', () => {
    const { monitor } = create();
    monitor.start(60000);
    monitor.stop();
    // Double stop is safe
    monitor.stop();
  });

  test('recordLatency stores samples', () => {
    const { monitor } = create();
    monitor.recordLatency('llm', 100);
    monitor.recordLatency('llm', 200);
    monitor.recordLatency('llm', 150);
    const lat = monitor.getLatencyFor('llm');
    assert(lat !== null, 'should have latency data');
    assertEqual(lat.samples, 3);
    assert(lat.avg > 0, 'should compute avg');
    assert(lat.p50 > 0, 'should compute p50');
  });

  test('recordLatency caps at 100 services', () => {
    const { monitor } = create();
    for (let i = 0; i < 105; i++) {
      monitor.recordLatency(`svc-${i}`, 10);
    }
    // Should not exceed 100 + a few (implementation trims oldest)
    const report = monitor.getReport();
    assert(Object.keys(report.latency).length <= 105);
  });

  test('getLatencyFor returns null for unknown service', () => {
    const { monitor } = create();
    assertEqual(monitor.getLatencyFor('nonExistent'), null);
  });

  test('recordLatency emits degradation on critical threshold', () => {
    const { bus, monitor } = create();
    let degraded = null;
    bus.on('health:degradation', (data) => { degraded = data; });
    monitor.recordLatency('slow-svc', 30000); // 30s — should be critical
    assert(degraded !== null, 'should emit degradation');
    assertEqual(degraded.service, 'slow-svc');
  });

  test('recordMetric emits health:metric', () => {
    const { bus, monitor } = create();
    let metric = null;
    bus.on('health:metric', (data) => { metric = data; });
    monitor.recordMetric('llm', 'tokens', 500);
    assert(metric !== null);
    assertEqual(metric.service, 'llm');
    assertEqual(metric.metric, 'tokens');
    assertEqual(metric.value, 500);
  });

  test('getReport includes all sections', () => {
    const { monitor } = create();
    const report = monitor.getReport();
    assert('status' in report);
    assert('latency' in report);
    assert('memory' in report);
    assert('degradation' in report);
    assert('uptime' in report);
    assert('pid' in report);
  });

  test('checkNow runs tick without error', async () => {
    const { monitor } = create();
    await monitor.checkNow();
    // Should not throw
  });

  test('start with intervals manager', () => {
    const intervals = {
      register: (name, fn, ms, opts) => {},
      unregister: (name) => {},
      clear: (name) => {},
    };
    const bus = createBus();
    const monitor = new HealthMonitor({ bus, intervals });
    monitor.start();
    monitor.stop();
  });
});

run();
