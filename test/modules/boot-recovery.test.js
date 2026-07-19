#!/usr/bin/env node
// Test: BootRecovery.js — Crash-resilient boot via sentinel file
const { describe, test, assert, assertEqual, run, createTestRoot } = require('../harness');
const path = require('path');
const fs = require('fs');

const { BootRecovery } = require('../../src/agent/foundation/BootRecovery');
const { SnapshotManager } = require('../../src/agent/capabilities/SnapshotManager');

function setup(label) {
  const root = createTestRoot('boot-recovery-' + label);
  const genesisDir = path.join(root, '.genesis');
  fs.mkdirSync(genesisDir, { recursive: true });
  // Create mock source tree
  const agentDir = path.join(root, 'src', 'agent');
  fs.mkdirSync(agentDir, { recursive: true });
  fs.writeFileSync(path.join(agentDir, 'TestModule.js'), 'module.exports = { v: 1 };');

  const guard = {
    validateWrite: (p) => {
      if (p.includes('kernel')) throw new Error('protected');
      return true;
    },
  };
  const snapshotMgr = new SnapshotManager({
    rootDir: root,
    storage: { baseDir: genesisDir },
    guard,
  });
  const recovery = new BootRecovery({ genesisDir, snapshotManager: snapshotMgr });
  return { root, genesisDir, snapshotMgr, recovery, guard };
}

describe('BootRecovery — Clean Boot', () => {
  test('first boot: no sentinel → creates sentinel, returns recovered=false', () => {
    const { recovery, genesisDir } = setup('clean');
    const result = recovery.preBootCheck();
    assertEqual(result.recovered, false);
    assertEqual(result.crashCount, 0);
    assert(fs.existsSync(path.join(genesisDir, 'boot-sentinel.json')), 'sentinel should exist');
  });

  test('postBootSuccess clears sentinel', () => {
    const { recovery, genesisDir } = setup('success');
    recovery.preBootCheck();
    assert(fs.existsSync(path.join(genesisDir, 'boot-sentinel.json')));
    recovery.postBootSuccess();
    assert(!fs.existsSync(path.join(genesisDir, 'boot-sentinel.json')), 'sentinel should be cleared');
  });

  test('postBootSuccess creates _last_good_boot snapshot (v7.9.37 T3: off the boot path)', async () => {
    const { recovery, snapshotMgr } = setup('snapshot');
    recovery.preBootCheck();
    recovery.postBootSuccess();
    // v7.9.37 (T3): the snapshot copies ~400 files (copyFileSync) and used to
    // block the boot for ~4.8s. It is now scheduled a tick later — still created
    // after a clean boot, just not in the boot's critical path.
    // v7.9.41 r5: the boot snapshot is now the ASYNC twin (createAsync) — it
    // finishes a few ticks later than the old one-tick sync create. Poll for
    // completion instead of a fixed 20ms; the guarded behavior is unchanged:
    // the snapshot appears after a clean boot, off the boot's critical path.
    {
      const t0 = Date.now();
      while (Date.now() - t0 < 2000) {
        try { if (snapshotMgr.list().some(s => s.name === '_last_good_boot')) break; } catch (_e) {}
        await new Promise((r) => setTimeout(r, 25));
      }
    }
    const list = snapshotMgr.list();
    assert(list.some(s => s.name === '_last_good_boot'), 'should create last-good-boot snapshot');
  });
});

describe('BootRecovery — Crash Detection', () => {
  test('sentinel present → crash detected, increments count', () => {
    const { recovery, genesisDir } = setup('crash');
    // Simulate: first boot writes sentinel
    recovery.preBootCheck();
    // Don't call postBootSuccess → simulate crash
    // Second boot should detect crash
    const result = recovery.preBootCheck();
    assertEqual(result.crashCount, 1);
  });

  test('crash with snapshot → restores and reports recovery', () => {
    const { recovery, snapshotMgr } = setup('restore');
    // Create a good snapshot
    snapshotMgr.create('manual-good');
    // Simulate crash (sentinel left behind)
    recovery.preBootCheck();
    // Second boot should restore
    const result = recovery.preBootCheck();
    assertEqual(result.recovered, true);
    assertEqual(result.snapshot, 'manual-good');
    assertEqual(result.crashCount, 1);
  });

  test('crash without snapshot → no restore, reports crashCount', () => {
    const { recovery } = setup('no-snap');
    recovery.preBootCheck();
    const result = recovery.preBootCheck();
    assertEqual(result.recovered, false);
    assert(result.crashCount >= 1);
  });

  test('3+ consecutive crashes → boots clean (no restore)', () => {
    const { recovery, genesisDir, snapshotMgr } = setup('max-crash');
    snapshotMgr.create('some-snapshot');
    // Simulate 4 consecutive crashes
    for (let i = 0; i < 4; i++) {
      recovery.preBootCheck(); // don't call postBootSuccess
    }
    const result = recovery.preBootCheck();
    // After MAX_CRASH_RECOVERIES (3), should boot clean
    assertEqual(result.recovered, false);
    assert(result.crashCount > 3);
  });
});

describe('BootRecovery — Edge Cases', () => {
  test('no snapshotManager → graceful degradation', () => {
    const root = createTestRoot('boot-recovery-no-snap');
    const genesisDir = path.join(root, '.genesis');
    fs.mkdirSync(genesisDir, { recursive: true });
    const recovery = new BootRecovery({ genesisDir, snapshotManager: null });
    recovery.preBootCheck();
    const result = recovery.preBootCheck();
    assertEqual(result.recovered, false);
  });

  test('corrupt sentinel file → treated as clean', () => {
    const { recovery, genesisDir } = setup('corrupt');
    fs.writeFileSync(path.join(genesisDir, 'boot-sentinel.json'), 'NOT JSON{{{');
    const result = recovery.preBootCheck();
    assertEqual(result.recovered, false);
    assertEqual(result.crashCount, 0);
  });

  test('skips _auto_before_restore snapshots when finding good snapshot', () => {
    const { recovery, snapshotMgr } = setup('skip-auto');
    snapshotMgr.create('real-good');
    snapshotMgr.create('_auto_before_restore_12345');
    recovery.preBootCheck();
    const result = recovery.preBootCheck();
    assertEqual(result.snapshot, 'real-good');
  });
});

run();
