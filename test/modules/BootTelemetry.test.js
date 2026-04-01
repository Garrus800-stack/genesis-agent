#!/usr/bin/env node
// Test: BootTelemetry.js — Opt-in metrics
const { describe, test, assert, assertEqual, run } = require('../harness');
const { BootTelemetry } = require('../../src/agent/foundation/BootTelemetry');

function mockStorage() {
  const _store = {};
  return {
    readJSON: (k, def) => _store[k] || def,
    writeJSON: (k, v) => { _store[k] = v; },
    _store,
  };
}

describe('BootTelemetry — Disabled', () => {
  test('does nothing when disabled', () => {
    const t = new BootTelemetry({ storage: mockStorage(), enabled: false });
    t.recordBoot(500);
    t.recordModelLatency('chat', 200, 'test');
    t.recordError('test', 'fail');
    assertEqual(t.getReport(), null, 'report is null when disabled');
  });
});

describe('BootTelemetry — Recording', () => {
  test('records boot timing', async () => {
    const t = new BootTelemetry({ storage: mockStorage(), enabled: true });
    await t.asyncLoad();
    t.recordBoot(1234, 50, 2);
    const r = t.getReport();
    assertEqual(r.totalBoots, 1);
    assertEqual(r.avgBootMs, 1234);
    assertEqual(r.lastBoot.services, 50);
  });

  test('records model latency', async () => {
    const t = new BootTelemetry({ storage: mockStorage(), enabled: true });
    await t.asyncLoad();
    t.recordModelLatency('chat', 500, 'gemma2:9b');
    t.recordModelLatency('chat', 300, 'gemma2:9b');
    const r = t.getReport();
    assertEqual(r.avgModelLatencyMs, 400);
  });

  test('records errors', async () => {
    const t = new BootTelemetry({ storage: mockStorage(), enabled: true });
    await t.asyncLoad();
    t.recordError('sandbox', 'timeout');
    const r = t.getReport();
    assertEqual(r.errorsLast24h, 1);
  });

  test('sessions tracked', async () => {
    const t = new BootTelemetry({ storage: mockStorage(), enabled: true });
    await t.asyncLoad();
    t.endSession(10, 2);
    const r = t.getReport();
    assertEqual(r.totalSessions, 1);
  });
});

describe('BootTelemetry — Persistence', () => {
  test('data survives flush + reload', async () => {
    const storage = mockStorage();
    const t1 = new BootTelemetry({ storage, enabled: true });
    await t1.asyncLoad();
    t1.recordBoot(999, 40, 0);
    t1.flush();
    assert(storage._store['telemetry.json'], 'should persist');

    const t2 = new BootTelemetry({ storage, enabled: true });
    await t2.asyncLoad();
    const r = t2.getReport();
    assertEqual(r.totalBoots, 1);
  });
});

describe('BootTelemetry — Bounds', () => {
  test('trims history beyond 100 entries', async () => {
    const t = new BootTelemetry({ storage: mockStorage(), enabled: true });
    await t.asyncLoad();
    for (let i = 0; i < 120; i++) {
      t.recordBoot(i);
    }
    assert(t._data.boots.length <= 100, 'should trim to 100');
  });
});

run();
