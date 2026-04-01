// ============================================================
// Test: AutonomousDaemon.js — lifecycle, cycle dispatch,
// config, status reporting
// ============================================================

const { describe, test, assert, assertEqual, run } = require('../harness');
const { AutonomousDaemon } = require('../../src/agent/autonomy/AutonomousDaemon');

function createDaemon(overrides = {}) {
  const events = [];
  return {
    daemon: new AutonomousDaemon({
      bus: { fire: (e, d) => events.push({ e, d }), emit: (e, d) => events.push({ e, d }), on: () => () => {} },
      reflector: {
        diagnose: async () => ({ issues: [], scannedModules: 5 }),
        repair: async (issues) => issues.map(i => ({ ...i, fixed: true })),
      },
      selfModel: {
        getFullModel: () => ({ modules: {}, files: {}, capabilities: [] }),
        getModuleSummary: () => [],
      },
      memory: {
        getStats: () => ({ episodes: 3, facts: 10 }),
        recallEpisodes: () => [],
        prune: () => 0,
      },
      model: { chat: async () => '{"suggestions": []}', activeModel: 'gemma2:9b' },
      prompts: { build: () => 'prompt' },
      skills: { listSkills: () => [] },
      sandbox: { execute: async () => ({ success: true, output: '' }) },
      guard: { verifyIntegrity: () => ({ ok: true }) },
      intervals: null,
      ...overrides,
    }),
    events,
  };
}

describe('AutonomousDaemon: Lifecycle', () => {
  test('starts and sets running flag', () => {
    const { daemon } = createDaemon();
    daemon.start();
    assert(daemon.running, 'Should be running after start()');
    daemon.stop();
  });

  test('stop clears running flag', () => {
    const { daemon } = createDaemon();
    daemon.start();
    daemon.stop();
    assert(!daemon.running, 'Should not be running after stop()');
  });

  test('double start is a no-op', () => {
    const { daemon } = createDaemon();
    daemon.start();
    daemon.start(); // Should not throw
    assert(daemon.running);
    daemon.stop();
  });

  test('double stop is safe', () => {
    const { daemon } = createDaemon();
    daemon.start();
    daemon.stop();
    daemon.stop(); // Should not throw
    assert(!daemon.running);
  });

  test('start emits daemon:started event', () => {
    const { daemon, events } = createDaemon();
    daemon.start();
    assert(events.some(e => e.e === 'daemon:started'));
    daemon.stop();
  });

  test('stop emits daemon:stopped event', () => {
    const { daemon, events } = createDaemon();
    daemon.start();
    daemon.stop();
    assert(events.some(e => e.e === 'daemon:stopped'));
  });
});

describe('AutonomousDaemon: Configuration', () => {
  test('default config has reasonable intervals', () => {
    const { daemon } = createDaemon();
    assert(daemon.config.cycleInterval >= 60000, 'Cycle should be at least 1 minute');
    assert(daemon.config.healthInterval >= 1, 'Health interval should be positive');
    assert(daemon.config.maxAutoRepairs >= 1);
  });

  test('autoOptimize defaults to false', () => {
    const { daemon } = createDaemon();
    assertEqual(daemon.config.autoOptimize, false);
  });

  test('autoRepair defaults to true', () => {
    const { daemon } = createDaemon();
    assertEqual(daemon.config.autoRepair, true);
  });
});

describe('AutonomousDaemon: Status', () => {
  test('getStatus returns structured report', () => {
    const { daemon } = createDaemon();
    const status = daemon.getStatus();
    assert('running' in status);
    assert('cycleCount' in status);
    assert('lastResults' in status);
    assertEqual(status.running, false);
  });

  test('getStatus reflects running state', () => {
    const { daemon } = createDaemon();
    daemon.start();
    assertEqual(daemon.getStatus().running, true);
    daemon.stop();
    assertEqual(daemon.getStatus().running, false);
  });

  test('cycleCount starts at zero', () => {
    const { daemon } = createDaemon();
    assertEqual(daemon.getStatus().cycleCount, 0);
  });
});

describe('AutonomousDaemon: Cycle Dispatch', () => {
  test('_runCycle increments cycleCount', async () => {
    const { daemon } = createDaemon();
    daemon.running = true;
    await daemon._runCycle();
    assert(daemon.cycleCount >= 1, `Expected cycleCount >= 1, got ${daemon.cycleCount}`);
    daemon.running = false;
  });

  test('_healthCheck runs without error', async () => {
    const { daemon } = createDaemon();
    const result = await daemon._healthCheck();
    // Should complete without throwing
    assert(true, 'Health check completed');
  });

  test('_runCycle does nothing when not running', async () => {
    const { daemon } = createDaemon();
    daemon.running = false;
    const before = daemon.cycleCount;
    await daemon._runCycle();
    assertEqual(daemon.cycleCount, before, 'Should not increment when not running');
  });
});

run();
