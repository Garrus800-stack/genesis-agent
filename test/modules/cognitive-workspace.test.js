// ============================================================
// TEST: CognitiveWorkspace — SA-P6 Working Memory
// ============================================================

const { describe, test, assertEqual, assert, run } = require('../harness');
const { CognitiveWorkspace, NullWorkspace } = require('../../src/agent/cognitive/CognitiveWorkspace');

// ── Basic Operations ────────────────────────────────────────

describe('CognitiveWorkspace — Basic', () => {
  test('store and recall', () => {
    const ws = new CognitiveWorkspace();
    ws.store('file-analysis', 'Found 3 imports');
    assertEqual(ws.recall('file-analysis'), 'Found 3 imports');
  });

  test('has()', () => {
    const ws = new CognitiveWorkspace();
    ws.store('key1', 'val1');
    assert(ws.has('key1'));
    assert(!ws.has('key2'));
  });

  test('remove()', () => {
    const ws = new CognitiveWorkspace();
    ws.store('temp', 'data');
    assert(ws.remove('temp'));
    assert(!ws.has('temp'));
    assertEqual(ws.recall('temp'), null);
  });

  test('recall returns null for missing key', () => {
    const ws = new CognitiveWorkspace();
    assertEqual(ws.recall('nonexistent'), null);
  });

  test('store updates existing key', () => {
    const ws = new CognitiveWorkspace();
    ws.store('key', 'v1', 0.5);
    ws.store('key', 'v2', 0.3); // Lower salience should keep higher
    assertEqual(ws.recall('key'), 'v2');
    const snap = ws.snapshot();
    assert(snap[0].salience >= 0.5, 'Should keep higher salience');
  });
});

// ── Capacity + Eviction ─────────────────────────────────────

describe('CognitiveWorkspace — Capacity', () => {
  test('respects capacity limit', () => {
    const ws = new CognitiveWorkspace({ capacity: 3 });
    ws.store('a', 1, 0.9);
    ws.store('b', 2, 0.8);
    ws.store('c', 3, 0.7);
    const r = ws.store('d', 4, 0.85); // Should evict 'c' (0.7)
    assert(r.stored, 'Should store new item');
    assertEqual(r.evicted, 'c');
    assert(!ws.has('c'), 'Evicted item gone');
    assert(ws.has('d'), 'New item stored');
  });

  test('rejects item below capacity threshold', () => {
    const ws = new CognitiveWorkspace({ capacity: 2 });
    ws.store('high1', 1, 0.9);
    ws.store('high2', 2, 0.8);
    const r = ws.store('low', 3, 0.5); // Below both existing
    assert(!r.stored, 'Should reject');
    assert(!ws.has('low'));
  });

  test('evicts correct item with multiple candidates', () => {
    const ws = new CognitiveWorkspace({ capacity: 3 });
    ws.store('a', 1, 0.9);
    ws.store('b', 2, 0.3); // Lowest
    ws.store('c', 3, 0.6);
    ws.store('d', 4, 0.5); // Should evict 'b' (0.3)
    assertEqual(ws.snapshot().length, 3);
    assert(!ws.has('b'));
    assert(ws.has('d'));
  });
});

// ── Salience Mechanics ──────────────────────────────────────

describe('CognitiveWorkspace — Salience', () => {
  test('recall boosts salience', () => {
    const ws = new CognitiveWorkspace();
    ws.store('item', 'data', 0.5);
    ws.recall('item');
    ws.recall('item');
    const snap = ws.snapshot();
    assert(snap[0].salience > 0.5, 'Salience should increase after access');
    assertEqual(snap[0].accessCount, 2);
  });

  test('tick decays salience', () => {
    const ws = new CognitiveWorkspace();
    ws.store('item', 'data', 0.5);
    ws.tick();
    ws.tick();
    const snap = ws.snapshot();
    assert(snap[0].salience < 0.5, 'Salience should decay');
    assert(snap[0].salience > 0.3, 'Should not decay too fast');
  });

  test('items below threshold auto-removed on tick', () => {
    const ws = new CognitiveWorkspace();
    ws.store('fading', 'data', 0.1);
    ws.tick(); // 0.1 - 0.05 = 0.05
    assert(ws.has('fading'), 'Still above threshold');
    ws.tick(); // 0.05 - 0.05 = 0.00
    assert(!ws.has('fading'), 'Should be auto-removed');
  });

  test('salience capped at 1.0', () => {
    const ws = new CognitiveWorkspace();
    ws.store('item', 'data', 0.95);
    ws.recall('item'); // +0.1
    ws.recall('item'); // +0.1
    const snap = ws.snapshot();
    assert(snap[0].salience <= 1.0, 'Should not exceed 1.0');
  });
});

// ── Snapshot + Context ──────────────────────────────────────

describe('CognitiveWorkspace — Snapshot', () => {
  test('snapshot sorted by salience descending', () => {
    const ws = new CognitiveWorkspace();
    ws.store('low', 'l', 0.3);
    ws.store('high', 'h', 0.9);
    ws.store('mid', 'm', 0.6);
    const snap = ws.snapshot();
    assertEqual(snap[0].key, 'high');
    assertEqual(snap[1].key, 'mid');
    assertEqual(snap[2].key, 'low');
  });

  test('buildContext returns formatted string', () => {
    const ws = new CognitiveWorkspace({ capacity: 5 });
    ws.store('analysis', 'Found circular dep in module A', 0.8);
    ws.store('intent', 'User wants refactoring', 0.9);
    const ctx = ws.buildContext();
    assert(ctx.includes('WORKING MEMORY'), 'Has header');
    assert(ctx.includes('[intent]'), 'Has highest salience item');
    assert(ctx.includes('[analysis]'), 'Has second item');
    assert(ctx.includes('2/5'), 'Shows slot usage');
  });

  test('buildContext returns empty for empty workspace', () => {
    const ws = new CognitiveWorkspace();
    assertEqual(ws.buildContext(), '');
  });

  test('buildContext limits items', () => {
    const ws = new CognitiveWorkspace();
    for (let i = 0; i < 9; i++) ws.store('k' + i, 'v' + i, 0.5 + i * 0.05);
    const ctx = ws.buildContext(3);
    const lines = ctx.split('\n').filter(l => l.includes('[k'));
    assertEqual(lines.length, 3);
  });
});

// ── Consolidation ───────────────────────────────────────────

describe('CognitiveWorkspace — Consolidation', () => {
  test('getConsolidationCandidates filters by salience', () => {
    const ws = new CognitiveWorkspace();
    ws.store('important', 'data', 0.8);
    ws.store('trivial', 'data', 0.2);
    const candidates = ws.getConsolidationCandidates();
    assertEqual(candidates.length, 1);
    assertEqual(candidates[0].key, 'important');
  });

  test('frequently accessed items consolidate even with low salience', () => {
    const ws = new CognitiveWorkspace();
    ws.store('used', 'data', 0.3);
    ws.recall('used');
    ws.recall('used');
    ws.recall('used'); // accessCount >= 3
    const candidates = ws.getConsolidationCandidates();
    assert(candidates.some(c => c.key === 'used'), 'Should consolidate frequently accessed');
  });

  test('clear returns stats', () => {
    const ws = new CognitiveWorkspace();
    ws.store('a', 1, 0.8);
    ws.store('b', 2, 0.2);
    const stats = ws.clear();
    assertEqual(stats.itemsCleared, 2);
    assertEqual(stats.consolidated, 1);
    assertEqual(ws.snapshot().length, 0);
  });
});

// ── Goal Lifecycle ──────────────────────────────────────────

describe('CognitiveWorkspace — Lifecycle', () => {
  test('constructor sets goal metadata', () => {
    const ws = new CognitiveWorkspace({ goalId: 'g-123', goalTitle: 'Refactor EventBus' });
    assertEqual(ws.goalId, 'g-123');
    assertEqual(ws.goalTitle, 'Refactor EventBus');
  });

  test('getStats returns comprehensive data', () => {
    const ws = new CognitiveWorkspace({ goalId: 'g-1', capacity: 5 });
    ws.store('a', 1, 0.8);
    ws.store('b', 2, 0.6);
    ws.tick();
    const stats = ws.getStats();
    assertEqual(stats.goalId, 'g-1');
    assertEqual(stats.slots, 2);
    assertEqual(stats.capacity, 5);
    assertEqual(stats.steps, 1);
    assert(stats.avgSalience > 0);
    assert(stats.ageMs >= 0);
  });

  test('full lifecycle: create → populate → decay → consolidate → clear', () => {
    const ws = new CognitiveWorkspace({ goalId: 'lifecycle', capacity: 4 });

    // Step 1: Store initial analysis
    ws.store('file-scan', '47 files found', 0.7);
    ws.store('intent', 'add logging', 0.9);
    ws.tick();

    // Step 2: Store code result, recall intent
    ws.store('code-result', 'function added', 0.8);
    ws.recall('intent'); // Boost
    ws.tick();

    // Step 3: Store test result
    ws.store('test-result', '12/12 pass', 0.7);
    ws.tick();

    // Intent should be highest (boosted), file-scan should have decayed most
    const snap = ws.snapshot();
    assertEqual(snap[0].key, 'intent');
    assert(snap[snap.length - 1].salience < snap[0].salience);

    // Consolidation should pick high-salience items
    const candidates = ws.getConsolidationCandidates();
    assert(candidates.length >= 2, 'Should consolidate important items');

    // Clear
    const stats = ws.clear();
    assert(stats.itemsCleared > 0);
    assertEqual(ws.snapshot().length, 0);
  });
});

// ── NullWorkspace ───────────────────────────────────────────

describe('NullWorkspace', () => {
  test('all operations are safe no-ops', () => {
    const nw = CognitiveWorkspace.NULL;
    assert(!nw.store('k', 'v').stored);
    assertEqual(nw.recall('k'), null);
    assert(!nw.has('k'));
    assert(!nw.remove('k'));
    assertEqual(nw.snapshot().length, 0);
    nw.tick(); // No throw
    assertEqual(nw.buildContext(), '');
    assertEqual(nw.getConsolidationCandidates().length, 0);
    assertEqual(nw.clear().itemsCleared, 0);
    assertEqual(nw.getStats().slots, 0);
  });
});

run();
