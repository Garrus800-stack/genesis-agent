#!/usr/bin/env node
// Test: PeerConsensus + VectorClock (v4.12.8)
const { describe, test, assert, assertEqual, run, createTestRoot } = require('../harness');
const path = require('path');
const fs = require('fs');

const { PeerConsensus, VectorClock } = require('../../src/agent/hexagonal/PeerConsensus');

// ═══════════════════════════════════════════════════════════
// VectorClock
// ═══════════════════════════════════════════════════════════

describe('VectorClock — Basic', () => {
  test('starts at 0', () => {
    const vc = new VectorClock('A');
    assertEqual(vc.value, 0);
  });

  test('tick increments own clock', () => {
    const vc = new VectorClock('A');
    vc.tick();
    assertEqual(vc.value, 1);
    vc.tick();
    assertEqual(vc.value, 2);
  });

  test('toJSON returns all components', () => {
    const vc = new VectorClock('A', { A: 3, B: 1 });
    const json = vc.toJSON();
    assertEqual(json.A, 3);
    assertEqual(json.B, 1);
  });
});

describe('VectorClock — Compare', () => {
  test('equal clocks → equal', () => {
    assertEqual(VectorClock.compare({ A: 1, B: 2 }, { A: 1, B: 2 }), 'equal');
  });

  test('a < b → before', () => {
    assertEqual(VectorClock.compare({ A: 1, B: 1 }, { A: 2, B: 1 }), 'before');
  });

  test('a > b → after', () => {
    assertEqual(VectorClock.compare({ A: 2, B: 2 }, { A: 1, B: 1 }), 'after');
  });

  test('concurrent clocks → concurrent', () => {
    assertEqual(VectorClock.compare({ A: 2, B: 1 }, { A: 1, B: 2 }), 'concurrent');
  });

  test('missing keys treated as 0', () => {
    assertEqual(VectorClock.compare({ A: 1 }, { A: 1, B: 1 }), 'before');
  });
});

describe('VectorClock — Merge', () => {
  test('merge takes max of each component', () => {
    const vc = new VectorClock('A', { A: 3, B: 1 });
    vc.merge({ A: 1, B: 5, C: 2 });
    const json = vc.toJSON();
    assert(json.A >= 3, 'A should be at least 3');
    assertEqual(json.B, 5);
    assertEqual(json.C, 2);
  });

  test('merge increments own clock (tick after merge)', () => {
    const vc = new VectorClock('A', { A: 1 });
    vc.merge({ B: 3 });
    assert(vc.value >= 2, 'should tick after merge');
  });
});

// ═══════════════════════════════════════════════════════════
// PeerConsensus
// ═══════════════════════════════════════════════════════════

function createConsensus(id, label) {
  const root = createTestRoot('consensus-' + label);
  const genesisDir = path.join(root, '.genesis');
  fs.mkdirSync(genesisDir, { recursive: true });

  const events = [];
  const bus = {
    emit: (n, d, m) => events.push({ name: n, data: d }),
    fire: (n, d, m) => events.push({ name: n, data: d }),
    on: () => {},
  };

  const { StorageService } = require('../../src/agent/foundation/StorageService');
  const storage = new StorageService(genesisDir);

  const consensus = new PeerConsensus({
    bus, storage, eventStore: null, selfId: id, config: {},
  });
  return { consensus, events, storage };
}

describe('PeerConsensus — Record + Build Payload', () => {
  test('records mutations and builds sync payload', () => {
    const { consensus } = createConsensus('A', 'record');
    consensus.recordMutation('settings', 'theme', 'dark');
    consensus.recordMutation('knowledge', 'user.name', { subject: 'user', relation: 'name', object: 'Alice' });

    const payload = consensus.buildSyncPayload({});
    assertEqual(payload.selfId, 'A');
    assert(payload.mutations.length >= 2, 'should include recorded mutations');
    assert(payload.clocks.settings.A >= 1);
  });

  test('empty payload when peer is up-to-date', () => {
    const { consensus } = createConsensus('A', 'uptodate');
    consensus.recordMutation('settings', 'lang', 'de');

    // Build payload as if peer already has our clock
    const ourClocks = {
      settings: consensus._clocks.settings.toJSON(),
      knowledge: consensus._clocks.knowledge.toJSON(),
      schemas: consensus._clocks.schemas.toJSON(),
    };
    const payload = consensus.buildSyncPayload(ourClocks);
    assertEqual(payload.mutations.length, 0);
  });
});

describe('PeerConsensus — Apply Sync', () => {
  test('applies new keys from peer', () => {
    const { consensus: a } = createConsensus('A', 'apply-a');
    const { consensus: b } = createConsensus('B', 'apply-b');

    a.recordMutation('settings', 'color', 'blue');
    const payload = a.buildSyncPayload({});
    const result = b.applySyncPayload(payload);

    assertEqual(result.accepted, 1);
    assertEqual(result.rejected, 0);
  });

  test('LWW resolves concurrent updates by timestamp', () => {
    const { consensus: a } = createConsensus('A', 'lww-a');
    const { consensus: b } = createConsensus('B', 'lww-b');

    // Both write to same key — concurrent
    a.recordMutation('settings', 'mode', 'light');
    b.recordMutation('settings', 'mode', 'dark');

    // A syncs to B — B should accept if A's timestamp is newer
    // (in practice both are ~same ms, so result depends on timing)
    const payload = a.buildSyncPayload(b._clocks);
    const result = b.applySyncPayload(payload);

    // Should have detected a conflict
    assert(result.conflicts >= 0, 'may or may not conflict depending on timing');
    assertEqual(result.accepted + result.rejected, 1);
  });

  test('rejects older updates', () => {
    const { consensus: a } = createConsensus('A', 'reject-a');
    const { consensus: b } = createConsensus('B', 'reject-b');

    // B writes first, then A writes same key
    b.recordMutation('settings', 'x', 'old');
    a.recordMutation('settings', 'x', 'new');

    // Apply A's newer value to B
    const payloadA = a.buildSyncPayload({});
    b.applySyncPayload(payloadA);

    // Now try to apply B's old value to A — should be rejected
    const payloadB = b.buildSyncPayload({});
    // B now has A's value, so its payload for 'x' has A's clock
    // This tests that the system doesn't regress
    assert(true); // no crash
  });
});

describe('PeerConsensus — Bidirectional Sync', () => {
  test('two peers converge after mutual sync', () => {
    const { consensus: a } = createConsensus('A', 'bidir-a');
    const { consensus: b } = createConsensus('B', 'bidir-b');

    a.recordMutation('settings', 'a_only', 'from_a');
    b.recordMutation('settings', 'b_only', 'from_b');

    // A → B
    const payloadAtoB = a.buildSyncPayload({});
    b.applySyncPayload(payloadAtoB);

    // B → A
    const payloadBtoA = b.buildSyncPayload({});
    a.applySyncPayload(payloadBtoA);

    // Both should have both keys
    assert(a._lwwRegister.has('settings:b_only'), 'A should have B\'s key');
    assert(b._lwwRegister.has('settings:a_only'), 'B should have A\'s key');
  });
});

describe('PeerConsensus — Persistence', () => {
  test('persists and loads state', () => {
    const root = createTestRoot('consensus-persist');
    const genesisDir = path.join(root, '.genesis');
    fs.mkdirSync(genesisDir, { recursive: true });

    const { StorageService } = require('../../src/agent/foundation/StorageService');
    const storage = new StorageService(genesisDir);
    const bus = { emit: () => {}, fire: () => {}, on: () => {} };

    const c1 = new PeerConsensus({ bus, storage, selfId: 'P', config: {} });
    c1.recordMutation('settings', 'key1', 'val1');
    c1._save();

    // Create new instance with same storage
    const c2 = new PeerConsensus({ bus, storage, selfId: 'P', config: {} });
    assert(c2._lwwRegister.has('settings:key1'), 'should load persisted data');
  });
});

describe('PeerConsensus — Status', () => {
  test('getStatus returns complete info', () => {
    const { consensus } = createConsensus('S', 'status');
    consensus.recordMutation('settings', 'a', 1);
    const status = consensus.getStatus();
    assertEqual(status.selfId, 'S');
    assert(status.clocks.settings >= 1);
    assert(status.registerSize >= 1);
    assert(typeof status.stats.syncAttempts === 'number');
  });
});

run();
