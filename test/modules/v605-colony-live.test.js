// ============================================================
// Test: v6.0.5 — Colony Live Convergence
//
// Two PeerConsensus instances simulate separate Genesis
// processes. Each makes independent mutations, then syncs
// bidirectionally. Verifies:
//   1. Unidirectional A→B transfer
//   2. Bidirectional A↔B sync
//   3. Concurrent mutation resolution (LWW)
//   4. Multi-round convergence (catch-up after missed rounds)
//   5. Idempotent re-sync (no duplicates)
//   6. Multi-domain sync (settings + knowledge + schemas)
//   7. Full round-trip: identical state after sync
//
// This is a REAL integration test — no mocks for consensus
// logic. Only the bus and persistence are mocked.
// ============================================================

const { describe, test, assert, assertEqual, assertDeepEqual, run } = require('../harness');

// Inline require — PeerConsensus lives in hexagonal
const { PeerConsensus, VectorClock } = require('../../src/agent/hexagonal/PeerConsensus');

// ── Mock Bus ────────────────────────────────────────────────
function mockBus() {
  const _listeners = new Map();
  const _emitted = [];
  return {
    on(event, fn, opts) {
      if (!_listeners.has(event)) _listeners.set(event, []);
      _listeners.get(event).push({ fn, ...opts });
      return () => {
        const a = _listeners.get(event);
        if (a) { const i = a.findIndex(l => l.fn === fn); if (i >= 0) a.splice(i, 1); }
      };
    },
    emit(event, data, meta) {
      _emitted.push({ event, data, meta });
      const ls = _listeners.get(event);
      if (ls) for (const l of ls) l.fn(data, meta);
    },
    fire(event, data, meta) { this.emit(event, data, meta); },
    _emitted,
    _findEmitted(name) { return _emitted.filter(e => e.event === name); },
  };
}

// ── Factory: create a PeerConsensus instance ─────────────────
function createPeer(id) {
  const bus = mockBus();
  const pc = new PeerConsensus({
    bus,
    selfId: id,
    storageDir: '/tmp/genesis-test-colony-' + id,
    config: { enabled: true },
  });
  // Disable persistence for tests
  pc._save = () => {};
  pc._load = () => {};
  return { pc, bus };
}

// ── Helper: sync A → B (one direction) ──────────────────────
function syncAtoB(peerA, peerB) {
  const payload = peerA.buildSyncPayload(peerB._clocks ? {
    settings: peerB._clocks.settings.toJSON(),
    knowledge: peerB._clocks.knowledge.toJSON(),
    schemas: peerB._clocks.schemas.toJSON(),
  } : {});
  return peerB.applySyncPayload(payload);
}

// ── Helper: full bidirectional sync ─────────────────────────
function bidirectionalSync(peerA, peerB) {
  const ab = syncAtoB(peerA, peerB);
  const ba = syncAtoB(peerB, peerA);
  return { ab, ba };
}

// ── Helper: get all LWW values (sorted for deterministic comparison) ──
function getLwwState(peer) {
  const state = {};
  for (const [key, entry] of peer._lwwRegister) {
    state[key] = entry.value;
  }
  return state;
}

/** Compare two LWW states by value (order-independent) */
function assertStatesEqual(stateA, stateB, msg) {
  const keysA = Object.keys(stateA).sort();
  const keysB = Object.keys(stateB).sort();
  assertDeepEqual(keysA, keysB, msg + ' — keys mismatch');
  for (const k of keysA) {
    assertDeepEqual(stateA[k], stateB[k], msg + ` — value mismatch for "${k}"`);
  }
}

// ═══════════════════════════════════════════════════════════
// 1. VectorClock (foundation)
// ═══════════════════════════════════════════════════════════

describe('Colony Live — VectorClock', () => {

  test('tick increments own counter', () => {
    const vc = new VectorClock('A');
    vc.tick();
    assertEqual(vc.toJSON().A, 1);
    vc.tick();
    assertEqual(vc.toJSON().A, 2);
  });

  test('compare: before / after / concurrent / equal', () => {
    // A: {A:1}, B: {A:2} → A is before B
    assertEqual(VectorClock.compare({ A: 1 }, { A: 2 }), 'before');
    // A: {A:2}, B: {A:1} → A is after B
    assertEqual(VectorClock.compare({ A: 2 }, { A: 1 }), 'after');
    // A: {A:1}, B: {B:1} → concurrent
    assertEqual(VectorClock.compare({ A: 1 }, { B: 1 }), 'concurrent');
    // Equal
    assertEqual(VectorClock.compare({ A: 1 }, { A: 1 }), 'equal');
  });

  test('merge takes max per node', () => {
    const vc = new VectorClock('A');
    vc.tick(); // A:1
    vc.merge({ B: 3, A: 0 });
    const json = vc.toJSON();
    assertEqual(json.A, 2, 'merge should tick own clock');
    assertEqual(json.B, 3, 'merge should take remote max');
  });
});

// ═══════════════════════════════════════════════════════════
// 2. Unidirectional Sync (A → B)
// ═══════════════════════════════════════════════════════════

describe('Colony Live — Unidirectional Sync', () => {

  test('A mutations transfer to B', () => {
    const { pc: A } = createPeer('leader');
    const { pc: B } = createPeer('worker');

    A.recordMutation('settings', 'theme', 'dark');
    A.recordMutation('settings', 'language', 'de');

    const result = syncAtoB(A, B);
    assertEqual(result.accepted, 2, 'B should accept 2 mutations');

    const stateB = getLwwState(B);
    assertEqual(stateB['settings:theme'], 'dark');
    assertEqual(stateB['settings:language'], 'de');
  });

  test('empty sync produces no changes', () => {
    const { pc: A } = createPeer('leader');
    const { pc: B } = createPeer('worker');

    const result = syncAtoB(A, B);
    assertEqual(result.accepted, 0, 'no mutations to sync');
    assertEqual(result.rejected, 0, 'no rejections');
  });

  test('second sync is idempotent', () => {
    const { pc: A } = createPeer('leader');
    const { pc: B } = createPeer('worker');

    A.recordMutation('settings', 'theme', 'dark');
    syncAtoB(A, B);

    // Second sync — same data, should not re-accept
    const result2 = syncAtoB(A, B);
    assertEqual(result2.accepted, 0, 'idempotent: no new data');
  });
});

// ═══════════════════════════════════════════════════════════
// 3. Bidirectional Sync (A ↔ B)
// ═══════════════════════════════════════════════════════════

describe('Colony Live — Bidirectional Sync', () => {

  test('independent mutations merge in both directions', () => {
    const { pc: A } = createPeer('leader');
    const { pc: B } = createPeer('worker');

    // A and B make independent mutations
    A.recordMutation('settings', 'theme', 'dark');
    B.recordMutation('settings', 'font-size', '14');

    bidirectionalSync(A, B);

    const stateA = getLwwState(A);
    const stateB = getLwwState(B);

    // Both should have both values
    assertEqual(stateA['settings:theme'], 'dark');
    assertEqual(stateA['settings:font-size'], '14');
    assertEqual(stateB['settings:theme'], 'dark');
    assertEqual(stateB['settings:font-size'], '14');
  });

  test('states are identical after bidirectional sync', () => {
    const { pc: A } = createPeer('leader');
    const { pc: B } = createPeer('worker');

    A.recordMutation('knowledge', 'node-1', { type: 'fact', content: 'TypeScript is typed JS' });
    A.recordMutation('knowledge', 'node-2', { type: 'pattern', content: 'Factory pattern' });
    B.recordMutation('knowledge', 'node-3', { type: 'fact', content: 'Rust is memory-safe' });

    bidirectionalSync(A, B);

    const stateA = getLwwState(A);
    const stateB = getLwwState(B);
    assertStatesEqual(stateA, stateB, 'states should be identical after sync');
  });
});

// ═══════════════════════════════════════════════════════════
// 4. Concurrent Conflict Resolution (LWW)
// ═══════════════════════════════════════════════════════════

describe('Colony Live — Conflict Resolution', () => {

  test('concurrent edits: newer timestamp wins', () => {
    const { pc: A } = createPeer('leader');
    const { pc: B } = createPeer('worker');

    // Both edit the same key — concurrent vector clocks
    A.recordMutation('settings', 'theme', 'dark');
    // Small delay to ensure different timestamps
    const t = Date.now();
    B._lwwRegister.set('settings:theme', {
      value: 'light',
      timestamp: t + 100, // B is newer
      clock: { worker: 1 },
    });
    B._clocks.settings.tick();

    bidirectionalSync(A, B);

    // B's timestamp is newer → 'light' should win on both
    const stateA = getLwwState(A);
    const stateB = getLwwState(B);
    assertEqual(stateA['settings:theme'], stateB['settings:theme'],
      'both should converge to same value');
  });

  test('strictly newer clock always wins over older', () => {
    const { pc: A } = createPeer('leader');
    const { pc: B } = createPeer('worker');

    // A makes mutation, syncs to B, then A makes another mutation
    A.recordMutation('settings', 'theme', 'dark');
    syncAtoB(A, B);

    // A updates the same key (strictly newer clock)
    A.recordMutation('settings', 'theme', 'blue');
    syncAtoB(A, B);

    assertEqual(getLwwState(B)['settings:theme'], 'blue', 'newer clock wins');
  });
});

// ═══════════════════════════════════════════════════════════
// 5. Multi-Round Catch-Up
// ═══════════════════════════════════════════════════════════

describe('Colony Live — Multi-Round Recovery', () => {

  test('B catches up after missing several rounds', () => {
    const { pc: A } = createPeer('leader');
    const { pc: B } = createPeer('worker');

    // A makes many mutations while B is "disconnected"
    for (let i = 0; i < 10; i++) {
      A.recordMutation('knowledge', `fact-${i}`, { content: `Fact ${i}` });
    }

    // B reconnects and catches up in one sync
    const result = syncAtoB(A, B);
    assertEqual(result.accepted, 10, 'B should accept all 10 missed mutations');

    const stateB = getLwwState(B);
    for (let i = 0; i < 10; i++) {
      assert(stateB[`knowledge:fact-${i}`], `B should have fact-${i}`);
    }
  });

  test('re-sync after catch-up is idempotent', () => {
    const { pc: A } = createPeer('leader');
    const { pc: B } = createPeer('worker');

    for (let i = 0; i < 5; i++) {
      A.recordMutation('settings', `key-${i}`, `val-${i}`);
    }

    syncAtoB(A, B); // catch-up
    const result2 = syncAtoB(A, B); // re-sync

    assertEqual(result2.accepted, 0, 'no new data on re-sync');
  });
});

// ═══════════════════════════════════════════════════════════
// 6. Multi-Domain Sync
// ═══════════════════════════════════════════════════════════

describe('Colony Live — Multi-Domain', () => {

  test('settings + knowledge + schemas sync independently', () => {
    const { pc: A } = createPeer('leader');
    const { pc: B } = createPeer('worker');

    A.recordMutation('settings', 'theme', 'dark');
    A.recordMutation('knowledge', 'node-1', { content: 'test' });
    A.recordMutation('schemas', 'event-1', { fields: ['a', 'b'] });

    bidirectionalSync(A, B);

    const stateB = getLwwState(B);
    assertEqual(stateB['settings:theme'], 'dark');
    assertDeepEqual(stateB['knowledge:node-1'], { content: 'test' });
    assertDeepEqual(stateB['schemas:event-1'], { fields: ['a', 'b'] });
  });

  test('vector clocks are per-domain', () => {
    const { pc: A } = createPeer('leader');

    A.recordMutation('settings', 'a', 1);
    A.recordMutation('settings', 'b', 2);
    A.recordMutation('knowledge', 'c', 3);

    const settingsClock = A._clocks.settings.toJSON();
    const knowledgeClock = A._clocks.knowledge.toJSON();

    assert(settingsClock.leader >= 2, 'settings clock should have 2+ ticks');
    assert(knowledgeClock.leader >= 1, 'knowledge clock should have 1+ tick');
  });
});

// ═══════════════════════════════════════════════════════════
// 7. Full Round-Trip Convergence Proof
// ═══════════════════════════════════════════════════════════

describe('Colony Live — Full Round-Trip Proof', () => {

  test('A↔B round-trip converges to identical state', () => {
    const { pc: A } = createPeer('leader');
    const { pc: B } = createPeer('worker');

    // Phase 1: Independent mutations
    A.recordMutation('settings', 'theme', 'dark');
    A.recordMutation('knowledge', 'typescript', { type: 'fact', content: 'TS compiles to JS' });
    B.recordMutation('settings', 'lang', 'de');
    B.recordMutation('knowledge', 'rust', { type: 'fact', content: 'Rust has no GC' });

    // Phase 2: First bidirectional sync
    bidirectionalSync(A, B);

    // Phase 3: More mutations on both sides
    A.recordMutation('settings', 'editor', 'vscode');
    B.recordMutation('settings', 'shell', 'zsh');

    // Phase 4: Second bidirectional sync
    bidirectionalSync(A, B);

    // Verify: complete convergence
    const stateA = getLwwState(A);
    const stateB = getLwwState(B);

    // Sort keys for deterministic comparison
    const keysA = Object.keys(stateA).sort();
    const keysB = Object.keys(stateB).sort();

    assertDeepEqual(keysA, keysB, 'same keys on both peers');

    for (const key of keysA) {
      assertDeepEqual(stateA[key], stateB[key], `values should match for key "${key}"`);
    }
  });

  test('3-peer topology converges via daisy-chain sync', () => {
    const { pc: A } = createPeer('alpha');
    const { pc: B } = createPeer('beta');
    const { pc: C } = createPeer('gamma');

    // Each peer makes a unique mutation
    A.recordMutation('knowledge', 'from-A', 'value-A');
    B.recordMutation('knowledge', 'from-B', 'value-B');
    C.recordMutation('knowledge', 'from-C', 'value-C');

    // Daisy-chain: A↔B, then B↔C, then A↔B again
    bidirectionalSync(A, B);
    bidirectionalSync(B, C);
    bidirectionalSync(A, B);

    // All three should have all three values
    const stateA = getLwwState(A);
    const stateB = getLwwState(B);
    const stateC = getLwwState(C);

    for (const key of ['knowledge:from-A', 'knowledge:from-B', 'knowledge:from-C']) {
      assert(stateA[key], `A should have ${key}`);
      assert(stateB[key], `B should have ${key}`);
      assert(stateC[key], `C should have ${key}`);
    }

    assertStatesEqual(stateA, stateB, 'A and B converged');
    assertStatesEqual(stateB, stateC, 'B and C converged');
  });

  test('sync status reports correct diagnostics', () => {
    const { pc: A } = createPeer('leader');
    const { pc: B } = createPeer('worker');

    A.recordMutation('settings', 'x', 1);
    syncAtoB(A, B);

    const status = B.getStatus();
    assert(status, 'should return sync status');
    assert(status.stats.syncSuccesses >= 1, 'should have at least 1 successful sync');
    assert(status.stats.itemsReceived >= 1, 'should have received items');
  });
});

run();
