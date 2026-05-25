#!/usr/bin/env node
// ============================================================
// Test: TrustLevelSystem.js — v7.9.7 (3-level system)
//
// Covers:
//   - Default trust level (AUTONOMOUS)
//   - Approval checks per action type × trust level
//   - Level transitions (setLevel)
//   - Auto-upgrade suggestions
//   - Audit log recording
//   - Risk classification for action types
//   - Stats tracking
//   - v7.9.7 migration from 4-level to 3-level scheme
// ============================================================

const { describe, test, assert, assertEqual, assertRejects, run } = require('../harness');

const { createBus } = require('../../src/agent/core/EventBus');

function mockStorage() {
  const _data = {};
  return {
    readJSON: (f, def) => _data[f] ?? def,
    writeJSON: (f, d) => { _data[f] = d; },
    writeJSONAsync: async (f, d) => { _data[f] = d; },
    _data,
  };
}

const { TrustLevelSystem } = require('../../src/agent/foundation/TrustLevelSystem');

// ── Tests ──────────────────────────────────────────────────

describe('TrustLevelSystem — Defaults', () => {
  test('starts at SUPERVISED level (v7.9.8 default)', () => {
    const tls = new TrustLevelSystem({ bus: createBus(), storage: mockStorage() });
    const status = tls.getStatus();
    assert(status.level === 0 || status.levelName === 'supervised' || status.levelName === 'SUPERVISED',
      `expected supervised level, got ${JSON.stringify(status)}`);
  });

  test('getStats returns zeroed counters', () => {
    const tls = new TrustLevelSystem({ bus: createBus(), storage: mockStorage() });
    const stats = tls.getStats();
    assertEqual(stats.approvalChecks, 0);
  });
});

describe('TrustLevelSystem — Approval Checks', () => {
  test('low-risk actions approved at AUTONOMOUS level', async () => {
    const tls = new TrustLevelSystem({ bus: createBus(), storage: mockStorage() });
    await tls.setLevel(1); // v7.9.8: default is now SUPERVISED; test AUTONOMOUS explicitly
    const result = tls.checkApproval('read-file', {});
    assert(result.approved === true || result.needsApproval === false,
      'low-risk read should be auto-approved at AUTONOMOUS');
  });

  test('SUPERVISED requires approval for everything (v7.9.8 default)', () => {
    const tls = new TrustLevelSystem({ bus: createBus(), storage: mockStorage() });
    // No setLevel — default is SUPERVISED in v7.9.8.
    const result = tls.checkApproval('read-file', {});
    assert(result.approved === false || result.needsApproval === true || result.needsUserApproval === true,
      'at SUPERVISED, even low-risk read must require approval (sacred user-settings invariant)');
  });

  test('critical actions require approval at AUTONOMOUS level', async () => {
    const tls = new TrustLevelSystem({ bus: createBus(), storage: mockStorage() });
    await tls.setLevel(1); // v7.9.8: default is now SUPERVISED; test AUTONOMOUS explicitly
    const result = tls.checkApproval('EXTERNAL_API', {});
    // At AUTONOMOUS level, critical should still need approval
    assert(result.approved === false || result.needsApproval === true,
      'self-modify check should return a valid result');
    // Stats should increment
    const stats = tls.getStats();
    assert(stats.approvalChecks >= 1, 'should track approval checks');
  });
});

describe('TrustLevelSystem — Level Transitions', () => {
  test('setLevel changes the trust level', async () => {
    const tls = new TrustLevelSystem({ bus: createBus(), storage: mockStorage() });
    await tls.setLevel(2);
    const status = tls.getStatus();
    assert(status.level === 2 || status.levelName === 'full_autonomy' || status.levelName === 'FULL_AUTONOMY',
      `expected level 2 (full autonomy), got ${JSON.stringify(status)}`);
  });

  test('setLevel emits trust:level-changed event', async () => {
    const bus = createBus();
    let emitted = null;
    bus.on('trust:level-changed', (data) => { emitted = data; });
    const tls = new TrustLevelSystem({ bus, storage: mockStorage() });
    await tls.setLevel(2);
    // Give event a tick to fire
    await new Promise(r => setTimeout(r, 50));
    assert(emitted !== null, 'should emit level-changed event');
  });

  test('setLevel rejects out-of-range values (v7.9.7: 0..2)', async () => {
    const tls = new TrustLevelSystem({ bus: createBus(), storage: mockStorage() });
    await assertRejects(() => tls.setLevel(3), 'level 3 is out of range');
    await assertRejects(() => tls.setLevel(-1), 'level -1 is out of range');
  });
});

describe('TrustLevelSystem — Migration (v7.9.7)', () => {
  test('migrates old level 1 (ASSISTED) to new SUPERVISED (v7.9.9 A — safer-default rebucket)', () => {
    assertEqual(TrustLevelSystem._migrateLevel(1), 0);
  });

  test('migrates old level 2 (AUTONOMOUS) to new AUTONOMOUS (same behaviour)', () => {
    assertEqual(TrustLevelSystem._migrateLevel(2), 1);
  });

  test('migrates old level 3 (FULL) to new FULL_AUTONOMY', () => {
    assertEqual(TrustLevelSystem._migrateLevel(3), 2);
  });

  test('preserves level 0 (SUPERVISED)', () => {
    assertEqual(TrustLevelSystem._migrateLevel(0), 0);
  });

  test('out-of-range values default to SUPERVISED (v7.9.8)', () => {
    assertEqual(TrustLevelSystem._migrateLevel(99), 0);
    assertEqual(TrustLevelSystem._migrateLevel(-5), 0);
    assertEqual(TrustLevelSystem._migrateLevel(undefined), 0);
  });
});

describe('TrustLevelSystem — Auto-Upgrades', () => {
  test('checkAutoUpgrades returns array', () => {
    const tls = new TrustLevelSystem({ bus: createBus(), storage: mockStorage() });
    const upgrades = tls.checkAutoUpgrades();
    assert(Array.isArray(upgrades), 'should return an array');
  });

  test('getPendingUpgrades returns array', () => {
    const tls = new TrustLevelSystem({ bus: createBus(), storage: mockStorage() });
    const pending = tls.getPendingUpgrades();
    assert(Array.isArray(pending), 'should return an array');
  });
});

describe('TrustLevelSystem — Risk Classification', () => {
  test('_getActionRisk returns risk level', () => {
    const tls = new TrustLevelSystem({ bus: createBus(), storage: mockStorage() });
    // Access private method for testing risk classification
    if (typeof tls._getActionRisk === 'function') {
      const risk = tls._getActionRisk('self-modify');
      assert(risk, 'self-modify should have a risk classification');
    }
  });
});

describe('TrustLevelSystem — Status & Persistence', () => {
  test('getStatus includes all required fields', () => {
    const tls = new TrustLevelSystem({ bus: createBus(), storage: mockStorage() });
    const status = tls.getStatus();
    assert('level' in status || 'levelName' in status, 'should have level');
  });

  test('persists level changes to storage', async () => {
    const storage = mockStorage();
    const tls = new TrustLevelSystem({ bus: createBus(), storage });
    await tls.setLevel(2);
    // Check that storage was written
    const hasData = Object.keys(storage._data).length > 0;
    assert(hasData, 'should persist to storage');
  });
});

run();
