#!/usr/bin/env node
// Test: AwarenessPort + NullAwareness (v7.6.0)
const { describe, test, assert, assertEqual, run } = require('../harness');
const { AwarenessPort } = require('../../src/agent/ports/AwarenessPort');
const { NullAwareness } = require('../../src/agent/foundation/NullAwareness');

// ── AwarenessPort (base class defaults) ─────────────────────

describe('AwarenessPort', () => {

  test('getCoherence returns 1.0 by default', () => {
    const port = new AwarenessPort();
    assertEqual(port.getCoherence(), 1.0);
  });

  test('getMode returns diffuse by default', () => {
    const port = new AwarenessPort();
    assertEqual(port.getMode(), 'diffuse');
  });

  test('getPrimaryFocus returns null by default', () => {
    const port = new AwarenessPort();
    assertEqual(port.getPrimaryFocus(), null);
  });

  test('getQualia returns null by default', () => {
    const port = new AwarenessPort();
    assertEqual(port.getQualia(), null);
  });

  test('consult returns safe defaults', () => {
    const port = new AwarenessPort();
    const result = port.consult({ title: 'test' });
    assertEqual(result.paused, false);
    assertEqual(result.concerns.length, 0);
    assertEqual(result.coherence, 1.0);
    assertEqual(result.valueContext, '');
    assertEqual(result.mode, 'diffuse');
    assertEqual(result.qualia, null);
  });

  test('buildPromptContext returns empty string', () => {
    const port = new AwarenessPort();
    assertEqual(port.buildPromptContext(), '');
  });

  test('getReport returns status object', () => {
    const port = new AwarenessPort();
    const report = port.getReport();
    assertEqual(report.mode, 'diffuse');
    assertEqual(report.coherence, 1.0);
    assertEqual(report.active, false);
  });

  test('lifecycle methods are no-ops', () => {
    const port = new AwarenessPort();
    port.start();
    port.stop();
    // asyncLoad returns undefined (no crash)
    const result = port.asyncLoad();
    assert(result === undefined || result instanceof Promise, 'asyncLoad should be safe');
  });
});

// ── NullAwareness (concrete no-op impl) ─────────────────────

describe('NullAwareness', () => {

  test('extends AwarenessPort', () => {
    const na = new NullAwareness();
    assert(na instanceof AwarenessPort, 'should be instanceof AwarenessPort');
  });

  test('accepts bus in constructor', () => {
    const bus = { on: () => {} };
    const na = new NullAwareness({ bus });
    assertEqual(na.bus, bus);
  });

  test('works without constructor args', () => {
    const na = new NullAwareness();
    assertEqual(na.bus, null);
    assertEqual(na.getCoherence(), 1.0);
  });

  test('consult never pauses', () => {
    const na = new NullAwareness();
    const result = na.consult({ title: 'dangerous self-mod', steps: [{ type: 'code' }] });
    assertEqual(result.paused, false);
    assertEqual(result.concerns.length, 0);
  });

  test('buildPromptContext returns empty (zero prompt overhead)', () => {
    const na = new NullAwareness();
    assertEqual(na.buildPromptContext(), '');
  });

  test('getReport shows inactive', () => {
    const na = new NullAwareness();
    const report = na.getReport();
    assertEqual(report.active, false);
    assertEqual(report.coherence, 1.0);
  });

  test('start/stop are safe no-ops', () => {
    const na = new NullAwareness();
    na.start();
    na.stop();
    na.start();
    na.stop();
    // No crash, no state change
    assertEqual(na.getCoherence(), 1.0);
  });
});

run();
