#!/usr/bin/env node
// Test: AutonomousDaemon — lifecycle, config, cycle management
const { describe, test, assert, assertEqual, run } = require('../harness');
const { createBus } = require('../../src/agent/core/EventBus');
const { AutonomousDaemon } = require('../../src/agent/autonomy/AutonomousDaemon');

function create(overrides = {}) {
  const bus = createBus();
  return {
    bus,
    daemon: new AutonomousDaemon({
      bus,
      reflector: null,
      selfModel: null,
      memory: null,
      model: null,
      prompts: null,
      skills: null,
      sandbox: null,
      guard: null,
      intervals: null,
      ...overrides,
    }),
  };
}

describe('AutonomousDaemon', () => {

  test('constructor initializes with running=false', () => {
    const { daemon } = create();
    assertEqual(daemon.running, false);
    assertEqual(daemon.cycleCount, 0);
  });

  test('config has sensible defaults', () => {
    const { daemon } = create();
    assertEqual(daemon.config.cycleInterval, 5 * 60 * 1000);
    assertEqual(daemon.config.healthInterval, 3);
    assertEqual(daemon.config.autoRepair, true);
    assertEqual(daemon.config.autoOptimize, false);
  });

  test('start sets running=true', () => {
    const { daemon } = create();
    daemon.start();
    assert(daemon.running, 'should be running');
    daemon.stop();
  });

  test('start is idempotent', () => {
    const { daemon } = create();
    daemon.start();
    daemon.start();
    assert(daemon.running);
    daemon.stop();
  });

  test('stop sets running=false', () => {
    const { daemon } = create();
    daemon.start();
    daemon.stop();
    assertEqual(daemon.running, false);
  });

  test('stop is safe when not started', () => {
    const { daemon } = create();
    daemon.stop(); // Should not throw
  });

  test('_runCycle skips when not running', async () => {
    const { daemon } = create();
    await daemon._runCycle();
    assertEqual(daemon.cycleCount, 0);
  });

  test('_runCycle increments cycleCount', async () => {
    const { daemon } = create();
    daemon.running = true;
    await daemon._runCycle();
    assertEqual(daemon.cycleCount, 1);
  });

  test('knownGaps and gapAttempts initialize empty', () => {
    const { daemon } = create();
    assertEqual(daemon.knownGaps.length, 0);
    assertEqual(daemon.gapAttempts.size, 0);
  });

  test('dynamic gap collection from bus events', () => {
    const { bus, daemon } = create();
    daemon.start();
    // Simulate skill:learned event with a topic
    bus.emit('skill:learned', { topic: 'REST API design patterns' });
    // _dynamicGaps should have been populated (if the listener is set up)
    daemon.stop();
  });

  test('start with intervals manager', () => {
    const intervals = {
      register: (name, fn, ms, opts) => {},
      unregister: (name) => {},
      clear: (name) => {},
    };
    const { daemon } = create({ intervals });
    daemon.start();
    assert(daemon.running);
    daemon.stop();
  });
});

run();
