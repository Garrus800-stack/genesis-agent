// ============================================================
// v7.3.7 #5 — EpisodicMemory Layer-System
//
// Verified:
//   - New episodes have v7.3.7 fields with sensible defaults
//   - Self-migration on _load() for legacy episodes (no `layer`)
//   - Migration is idempotent (already-migrated skipped)
//   - layerHistory[0].since = original timestamp, never Date.now()
//   - getRecentCount(windowMs) counts within window
//   - getUnprocessed filters by lastConsolidatedAt + transitionPending
//   - getTransitionCandidates respects maxPerCycle and skipIf
//   - setProtected / setLinkedCoreMemoryId / replaceEpisode work
//   - Layer-1 cap (500): triggers transitionPending marks + event
//   - Hard runaway (>1000): triggers dream:cycle-forced event
//   - Migration script idempotency on filesystem
// ============================================================

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { EpisodicMemory } = require('../../src/agent/hexagonal/EpisodicMemory');
const { migrateEpisodes } = require('../../scripts/migrate-episodes-to-layers');

function makeMockBus() {
  const events = [];
  return {
    emit: (name, payload) => events.push({ name, payload }),
    fire: (name, payload) => events.push({ name, payload, fire: true }),
    on: () => {},
    events,
  };
}

// In-memory storage stub — sufficient for these tests
function makeMockStorage(initial = null) {
  const data = { value: initial };
  return {
    readJSON: () => data.value,
    writeJSONDebounced: (_name, payload) => { data.value = payload; },
    writeJSON: (_name, payload) => { data.value = payload; },
    _peek: () => data.value,
  };
}

let bus;
let mem;

describe('v7.3.7 #5 — EpisodicMemory Layer System', () => {

  beforeEach(() => {
    bus = makeMockBus();
    mem = new EpisodicMemory({ bus, storage: makeMockStorage(), embeddingService: null, intervals: null });
  });

  // ── recordEpisode applies v7.3.7 defaults ─────────────────

  it('new episode starts at layer 1 with layerHistory', () => {
    const id = mem.recordEpisode({ topic: 'test', summary: 's' });
    const ep = mem._episodes.find(e => e.id === id);
    assert.strictEqual(ep.layer, 1);
    assert.ok(Array.isArray(ep.layerHistory));
    assert.strictEqual(ep.layerHistory.length, 1);
    assert.strictEqual(ep.layerHistory[0].layer, 1);
    assert.ok(ep.layerHistory[0].since);
  });

  it('new episode has all v7.3.7 fields with sensible defaults', () => {
    const id = mem.recordEpisode({ topic: 'test' });
    const ep = mem._episodes.find(e => e.id === id);
    assert.deepStrictEqual(ep.immuneAnchors, []);
    assert.strictEqual(ep.protected, false);
    assert.strictEqual(ep.linkedCoreMemoryId, null);
    assert.strictEqual(ep.lastConsolidatedAt, null);
    assert.strictEqual(ep.feelingEssence, null);
    assert.strictEqual(ep.pinStatus, null);
  });

  it('recordEpisode honors explicit protected=true', () => {
    const id = mem.recordEpisode({ topic: 'core', protected: true });
    const ep = mem._episodes.find(e => e.id === id);
    assert.strictEqual(ep.protected, true);
  });

  // ── Self-Migration on load ────────────────────────────────

  it('self-migrates legacy episodes (no layer field) on _load', () => {
    const legacyEpisodes = [
      { id: 'ep_old1', timestamp: '2025-01-01T00:00:00Z', topic: 'a', tags: [] },
      { id: 'ep_old2', timestamp: '2025-02-01T00:00:00Z', topic: 'b', tags: [] },
    ];
    const storage = makeMockStorage({ episodes: legacyEpisodes, causalLinks: [], counter: 2 });
    const mem2 = new EpisodicMemory({ bus, storage });
    mem2._load();

    const ep1 = mem2._episodes.find(e => e.id === 'ep_old1');
    assert.strictEqual(ep1.layer, 1);
    assert.strictEqual(ep1.layerHistory[0].since, '2025-01-01T00:00:00Z',
      'since must equal ORIGINAL timestamp, not Date.now()');
    assert.strictEqual(ep1.protected, false);
    assert.deepStrictEqual(ep1.immuneAnchors, []);
  });

  it('self-migration is idempotent', () => {
    const alreadyMigrated = [
      { id: 'ep_a', timestamp: '2025-01-01T00:00:00Z', topic: 'a', tags: [],
        layer: 2, layerHistory: [{ layer: 1, since: '2025-01-01T00:00:00Z' },
                                  { layer: 2, since: '2025-02-01T00:00:00Z' }],
        immuneAnchors: ['johnny-reference'], protected: true,
        linkedCoreMemoryId: 'cm_1', lastConsolidatedAt: '2025-02-01T00:00:00Z',
        feelingEssence: null, pinStatus: null, pinnedAt: null, pinReviewedAt: null },
    ];
    const storage = makeMockStorage({ episodes: alreadyMigrated, causalLinks: [], counter: 1 });
    const mem2 = new EpisodicMemory({ bus, storage });
    mem2._load();

    const ep = mem2._episodes.find(e => e.id === 'ep_a');
    assert.strictEqual(ep.layer, 2, 'layer must not be reset');
    assert.strictEqual(ep.protected, true, 'protected must not be reset');
    assert.deepStrictEqual(ep.immuneAnchors, ['johnny-reference']);
  });

  // ── getRecentCount ────────────────────────────────────────

  it('getRecentCount counts episodes within window', () => {
    mem.recordEpisode({ topic: 'now' });
    mem.recordEpisode({ topic: 'now2' });
    // Backdate one
    mem._episodes[0].timestampMs = Date.now() - (10 * 60 * 60 * 1000); // 10h ago

    const lastHour = mem.getRecentCount(60 * 60 * 1000);
    assert.strictEqual(lastHour, 1);
  });

  it('getRecentCount returns 0 for invalid windowMs', () => {
    mem.recordEpisode({ topic: 'a' });
    assert.strictEqual(mem.getRecentCount(0), 0);
    assert.strictEqual(mem.getRecentCount(-100), 0);
    assert.strictEqual(mem.getRecentCount('abc'), 0);
  });

  // ── getUnprocessed ────────────────────────────────────────

  it('getUnprocessed returns episodes with no consolidation + no pending', () => {
    const a = mem.recordEpisode({ topic: 'fresh' });
    const b = mem.recordEpisode({ topic: 'consolidated' });
    const c = mem.recordEpisode({ topic: 'pending' });

    mem._episodes.find(e => e.id === b).lastConsolidatedAt = '2026-01-01T00:00:00Z';
    mem._episodes.find(e => e.id === c).transitionPending = true;

    const un = mem.getUnprocessed();
    assert.strictEqual(un.length, 1);
    assert.strictEqual(un[0].id, a);
  });

  // ── getTransitionCandidates ───────────────────────────────

  it('getTransitionCandidates returns transitionPending episodes up to maxPerCycle', () => {
    for (let i = 0; i < 5; i++) {
      const id = mem.recordEpisode({ topic: `ep-${i}` });
      mem._episodes.find(e => e.id === id).transitionPending = true;
    }
    const c = mem.getTransitionCandidates({ maxPerCycle: 3 });
    assert.strictEqual(c.length, 3);
  });

  it('getTransitionCandidates honors skipIf', () => {
    const ids = [];
    for (let i = 0; i < 3; i++) {
      const id = mem.recordEpisode({ topic: `ep-${i}` });
      mem._episodes.find(e => e.id === id).transitionPending = true;
      ids.push(id);
    }
    const skipSet = new Set([ids[1]]);
    const c = mem.getTransitionCandidates({ skipIf: (id) => skipSet.has(id) });
    assert.strictEqual(c.length, 2);
    assert.ok(!c.some(ep => skipSet.has(ep.id)));
  });

  it('getTransitionCandidates returns [] when no transitionPending', () => {
    mem.recordEpisode({ topic: 'a' });
    mem.recordEpisode({ topic: 'b' });
    assert.deepStrictEqual(mem.getTransitionCandidates(), []);
  });

  // ── setProtected ──────────────────────────────────────────

  it('setProtected updates flag and returns true on change', () => {
    const id = mem.recordEpisode({ topic: 'a' });
    assert.strictEqual(mem.setProtected(id, true), true);
    assert.strictEqual(mem._episodes.find(e => e.id === id).protected, true);
  });

  it('setProtected is idempotent (false on no-change)', () => {
    const id = mem.recordEpisode({ topic: 'a' });
    mem.setProtected(id, true);
    assert.strictEqual(mem.setProtected(id, true), false);
  });

  it('setProtected returns false for unknown id', () => {
    assert.strictEqual(mem.setProtected('nope', true), false);
  });

  // ── setLinkedCoreMemoryId ─────────────────────────────────

  it('setLinkedCoreMemoryId updates link', () => {
    const id = mem.recordEpisode({ topic: 'a' });
    assert.strictEqual(mem.setLinkedCoreMemoryId(id, 'cm_1'), true);
    assert.strictEqual(mem._episodes.find(e => e.id === id).linkedCoreMemoryId, 'cm_1');
  });

  // ── replaceEpisode ────────────────────────────────────────

  it('replaceEpisode swaps in new episode preserving id and layerHistory', () => {
    const id = mem.recordEpisode({ topic: 'old', tags: ['t1'] });
    const newEp = {
      id,
      timestamp: '2026-01-01T00:00:00Z',
      topic: 'new',
      summary: 'verdichtet',
      layer: 2,
      tags: ['t2'],
    };
    assert.strictEqual(mem.replaceEpisode(id, newEp), true);
    const ep = mem._episodes.find(e => e.id === id);
    assert.strictEqual(ep.topic, 'new');
    assert.strictEqual(ep.layer, 2);
    // Tag index should reflect the swap
    assert.ok(!mem._tagIndex.get('t1')?.has(id));
    assert.ok(mem._tagIndex.get('t2')?.has(id));
    // layerHistory preserved from original
    assert.ok(Array.isArray(ep.layerHistory));
    assert.strictEqual(ep.layerHistory.length, 1);
  });

  it('replaceEpisode rejects mismatched id', () => {
    const id = mem.recordEpisode({ topic: 'a' });
    const ok = mem.replaceEpisode(id, { id: 'different', topic: 'x' });
    assert.strictEqual(ok, false);
  });

  it('replaceEpisode returns false for unknown id', () => {
    assert.strictEqual(mem.replaceEpisode('nope', { id: 'nope', topic: 'x' }), false);
  });

  it('replaceEpisode clears transitionPending on the new episode', () => {
    const id = mem.recordEpisode({ topic: 'old' });
    mem._episodes.find(e => e.id === id).transitionPending = true;
    mem.replaceEpisode(id, { id, topic: 'new', layer: 2 });
    assert.strictEqual(mem._episodes.find(e => e.id === id).transitionPending, undefined);
  });

  // ── Layer-1 Cap (using direct array manipulation to avoid 500 records) ─

  it('Layer-1 overflow marks oldest as transitionPending and emits event', () => {
    // Manually populate Layer 1 with 510 episodes
    const baseTs = Date.now() - (1000 * 24 * 60 * 60 * 1000); // long ago
    for (let i = 0; i < 510; i++) {
      mem._episodes.push({
        id: `ep_${i}`,
        timestamp: new Date(baseTs + i * 1000).toISOString(),
        timestampMs: baseTs + i * 1000,
        layer: 1, layerHistory: [], tags: [],
      });
    }
    const before = bus.events.length;
    mem._enforceLayerCaps();

    const overflowEvent = bus.events.find(e => e.name === 'memory:layer-overflow');
    assert.ok(overflowEvent, 'memory:layer-overflow must be emitted');
    assert.strictEqual(overflowEvent.payload.layer, 1);
    assert.strictEqual(overflowEvent.payload.count, 510);
    // 510 - 50 (youngest stay) = 460 marked
    assert.strictEqual(overflowEvent.payload.pendingTransitions, 460);
    assert.ok(bus.events.length > before);
  });

  it('Hard runaway (>1000 in Layer 1) emits dream:cycle-forced', () => {
    const baseTs = Date.now() - (2000 * 24 * 60 * 60 * 1000);
    for (let i = 0; i < 1010; i++) {
      mem._episodes.push({
        id: `ep_${i}`,
        timestamp: new Date(baseTs + i * 1000).toISOString(),
        timestampMs: baseTs + i * 1000,
        layer: 1, layerHistory: [], tags: [],
      });
    }
    mem._enforceLayerCaps();

    const forced = bus.events.find(e => e.name === 'dream:cycle-forced');
    assert.ok(forced, 'dream:cycle-forced must be emitted at runaway');
    assert.strictEqual(forced.payload.reason, 'layer-1-runaway');
  });

  it('youngest 50 episodes are not marked as transitionPending', () => {
    const baseTs = Date.now() - (1000 * 24 * 60 * 60 * 1000);
    for (let i = 0; i < 600; i++) {
      mem._episodes.push({
        id: `ep_${i}`,
        timestamp: new Date(baseTs + i * 1000).toISOString(),
        timestampMs: baseTs + i * 1000,
        layer: 1, layerHistory: [], tags: [],
      });
    }
    mem._enforceLayerCaps();

    // Episodes 550-599 are youngest 50
    for (let i = 550; i < 600; i++) {
      const ep = mem._episodes.find(e => e.id === `ep_${i}`);
      assert.notStrictEqual(ep.transitionPending, true,
        `youngest 50 must stay Detail (ep_${i})`);
    }
    // Episode ep_0 should be marked
    const old = mem._episodes.find(e => e.id === 'ep_0');
    assert.strictEqual(old.transitionPending, true);
  });
});

// ════════════════════════════════════════════════════════════
// Migration Script (filesystem-level)
// ════════════════════════════════════════════════════════════

describe('v7.3.7 #5 — migrate-episodes-to-layers script', () => {
  let tempDir;
  let filePath;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'genesis-mig-test-'));
    filePath = path.join(tempDir, 'episodic-memory.json');
  });
  afterEach(() => {
    try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch {}
  });

  it('migrates legacy episodes and preserves original timestamps', () => {
    fs.writeFileSync(filePath, JSON.stringify({
      episodes: [
        { id: 'ep_1', timestamp: '2024-06-15T10:00:00Z', topic: 'old', tags: [] },
      ],
      causalLinks: [], counter: 1,
    }));
    const r = migrateEpisodes(filePath);
    assert.strictEqual(r.migrated, 1);
    const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    assert.strictEqual(data.episodes[0].layer, 1);
    assert.strictEqual(data.episodes[0].layerHistory[0].since, '2024-06-15T10:00:00Z',
      'since must be the original timestamp');
  });

  it('is idempotent (second run skips already-migrated)', () => {
    fs.writeFileSync(filePath, JSON.stringify({
      episodes: [{ id: 'ep_1', timestamp: '2024-06-15T10:00:00Z', topic: 'a', tags: [] }],
      causalLinks: [], counter: 1,
    }));
    migrateEpisodes(filePath);
    const r2 = migrateEpisodes(filePath);
    assert.strictEqual(r2.migrated, 0);
    assert.strictEqual(r2.skipped, 1);
  });

  it('handles partial migration correctly', () => {
    fs.writeFileSync(filePath, JSON.stringify({
      episodes: [
        { id: 'ep_done', timestamp: '2024-01-01T00:00:00Z', topic: 'a', tags: [], layer: 1,
          layerHistory: [{ layer: 1, since: '2024-01-01T00:00:00Z' }] },
        { id: 'ep_pending', timestamp: '2024-02-01T00:00:00Z', topic: 'b', tags: [] },
      ],
      causalLinks: [], counter: 2,
    }));
    const r = migrateEpisodes(filePath);
    assert.strictEqual(r.migrated, 1);
    assert.strictEqual(r.skipped, 1);
    const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    // The newly migrated one keeps its ORIGINAL timestamp
    const pending = data.episodes.find(e => e.id === 'ep_pending');
    assert.strictEqual(pending.layerHistory[0].since, '2024-02-01T00:00:00Z');
    // Already-migrated stays untouched
    const done = data.episodes.find(e => e.id === 'ep_done');
    assert.strictEqual(done.layerHistory[0].since, '2024-01-01T00:00:00Z');
  });

  it('returns zero counts when file does not exist', () => {
    const r = migrateEpisodes(path.join(tempDir, 'nope.json'));
    assert.strictEqual(r.migrated, 0);
    assert.strictEqual(r.total, 0);
  });
});
