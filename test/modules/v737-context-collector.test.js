// ============================================================
// v7.3.7 #3 — ContextCollector
//
// Verified:
//   - Zero-dep constructor (only clock)
//   - All sources optional via late-binding pattern
//   - Three collect-methods: post-boot, idle, dream
//   - Defensive: missing source → null/[], never throw
//   - Uses real v7.3.6 APIs (getState/getDominant/getMood,
//     getNeeds/getMostUrgent, getRecent, getTimeSinceLastDream)
//   - Clock-injected for deterministic tests
// ============================================================

const { describe, it, beforeEach } = require('node:test');
const assert = require('assert');

const { ContextCollector } = require('../../src/agent/cognitive/ContextCollector');

function makeFakeClock(startMs = 1_000_000) {
  let t = startMs;
  return {
    now: () => t,
    advance: (ms) => { t += ms; },
  };
}

// ── Source mocks (mimic v7.3.6 real APIs) ───────────────────

function mockEmotionalState() {
  return {
    getState: () => ({ valence: 0.6, energy: 0.8 }),
    getDominant: () => ({ name: 'curiosity', intensity: 0.42 }),
    getMood: () => 'engaged',
  };
}

function mockNeedsSystem(activeMap = { connection: 0.7, novelty: 0.3, rest: 0.6 }) {
  return {
    getNeeds: () => activeMap,
    getMostUrgent: () => ({ need: 'connection', drive: 0.7 }),
    getTotalDrive: () => Object.values(activeMap).reduce((a, b) => a + b, 0),
  };
}

function mockEpisodicMemory(opts = {}) {
  return {
    getRecent: (_days = 7) => opts.recent ?? [{ id: 'ep_1' }, { id: 'ep_2' }],
    getUnprocessed: opts.hasUnprocessed
      ? () => [{ id: 'ep_3' }]
      : undefined,
    getTransitionCandidates: opts.hasTransitions
      ? () => [{ id: 'ep_4' }]
      : undefined,
  };
}

function mockJournalWriter(entries = []) {
  return {
    readLast: (visibility, n) => entries
      .filter(e => e.visibility === visibility)
      .slice(-n),
  };
}

function mockPending(count = 0) {
  return { getCount: () => count };
}

function mockCoreMemories(items = []) {
  return { list: () => items };
}

function mockDreamCycle(timeSinceMs = 5 * 60 * 1000) {
  return { getTimeSinceLastDream: () => timeSinceMs };
}

// ════════════════════════════════════════════════════════════
describe('v7.3.7 #3 — ContextCollector', () => {

  let clock, cc;
  beforeEach(() => {
    clock = makeFakeClock();
    cc = new ContextCollector({ clock });
  });

  // ── Construction ──────────────────────────────────────────

  it('constructs with zero deps except clock', () => {
    const fresh = new ContextCollector({});
    assert.strictEqual(fresh.episodicMemory, null);
    assert.strictEqual(fresh.dreamCycle, null);
    assert.strictEqual(fresh.coreMemories, null);
  });

  it('default clock falls back to Date if not injected', () => {
    const fresh = new ContextCollector();
    assert.ok(typeof fresh._clock.now === 'function');
  });

  // ── collectPostBootContext (graceful when nothing wired) ──

  it('collectPostBootContext returns safe defaults with no sources', async () => {
    const ctx = await cc.collectPostBootContext();
    assert.strictEqual(ctx.recentDreams.length, 0);
    assert.strictEqual(ctx.lastPrivateEntry, null);
    assert.strictEqual(ctx.lastSharedEntry, null);
    assert.strictEqual(ctx.pendingCount, 0);
    assert.deepStrictEqual(ctx.newCoreMemoriesSinceLastBoot, []);
    assert.strictEqual(ctx.emotionalSnapshot, null);
    assert.deepStrictEqual(ctx.activeNeeds, []);
    assert.ok(ctx.readCounts);
  });

  // ── collectPostBootContext (with all sources) ─────────────

  it('collectPostBootContext assembles emotional snapshot from real EmotionalState API', async () => {
    cc.emotionalState = mockEmotionalState();
    const ctx = await cc.collectPostBootContext();
    assert.ok(ctx.emotionalSnapshot);
    assert.deepStrictEqual(ctx.emotionalSnapshot.state, { valence: 0.6, energy: 0.8 });
    assert.strictEqual(ctx.emotionalSnapshot.dominant.name, 'curiosity');
    assert.strictEqual(ctx.emotionalSnapshot.mood, 'engaged');
  });

  it('collectPostBootContext extracts active needs above threshold (default 0.5)', async () => {
    cc.needsSystem = mockNeedsSystem({ connection: 0.7, rest: 0.6, novelty: 0.3, curiosity: 0.5 });
    const ctx = await cc.collectPostBootContext();
    // Threshold is >= 0.5: connection(0.7), rest(0.6), curiosity(0.5) qualify.
    // novelty(0.3) excluded.
    assert.strictEqual(ctx.activeNeeds.length, 3);
    // Sorted descending by value
    assert.strictEqual(ctx.activeNeeds[0].name, 'connection');
    assert.strictEqual(ctx.activeNeeds[0].value, 0.7);
    assert.strictEqual(ctx.activeNeeds[2].name, 'curiosity');
  });

  it('collectPostBootContext reads dreams (source=dreamcycle) from journal', async () => {
    cc.journalWriter = mockJournalWriter([
      { visibility: 'shared', source: 'dreamcycle', content: 'Dream A' },
      { visibility: 'shared', source: 'genesis', content: 'Note' },
      { visibility: 'shared', source: 'dreamcycle', content: 'Dream B' },
    ]);
    const ctx = await cc.collectPostBootContext();
    assert.strictEqual(ctx.recentDreams.length, 2);
    assert.strictEqual(ctx.recentDreams[0].content, 'Dream A');
  });

  it('collectPostBootContext reads pending count', async () => {
    cc.pendingMomentsStore = mockPending(7);
    const ctx = await cc.collectPostBootContext();
    assert.strictEqual(ctx.pendingCount, 7);
  });

  // ── newCoreMemoriesSinceLastBoot ──────────────────────────

  it('newCoreMemoriesSinceLastBoot returns nothing on first call', async () => {
    cc.coreMemories = mockCoreMemories([
      // Timestamp BEFORE clock.now() (1_000_000) — counts as old
      { id: 'cm_old', timestamp: new Date(500_000).toISOString() },
    ]);
    const ctx = await cc.collectPostBootContext();
    // First call sets the marker — nothing qualifies as "after marker"
    assert.deepStrictEqual(ctx.newCoreMemoriesSinceLastBoot, []);
  });

  it('newCoreMemoriesSinceLastBoot returns memories created after marker on later calls', async () => {
    const items = [
      { id: 'cm_old', timestamp: new Date(500_000).toISOString() },
    ];
    cc.coreMemories = { list: () => items };

    await cc.collectPostBootContext();  // sets marker at clock.now() = 1_000_000

    // Simulate a new core memory created at clock.now()
    const newTs = new Date(clock.now()).toISOString();
    items.push({ id: 'cm_new', timestamp: newTs });
    clock.advance(1000);  // 1s later

    const ctx2 = await cc.collectPostBootContext();
    assert.strictEqual(ctx2.newCoreMemoriesSinceLastBoot.length, 1);
    assert.strictEqual(ctx2.newCoreMemoriesSinceLastBoot[0].id, 'cm_new');
  });

  // ── collectIdleContext ───────────────────────────────────

  it('collectIdleContext returns safe defaults without sources', async () => {
    const ctx = await cc.collectIdleContext();
    assert.strictEqual(ctx.emotionalSnapshot, null);
    assert.deepStrictEqual(ctx.activeNeeds, []);
    assert.strictEqual(ctx.pendingCount, 0);
    assert.strictEqual(ctx.recentEpisodeCount, 0);
    assert.strictEqual(ctx.timeSinceLastDream, Infinity);
  });

  it('collectIdleContext uses getRecent(1) for recent episode count', async () => {
    cc.episodicMemory = mockEpisodicMemory({ recent: [{ id: 'a' }, { id: 'b' }, { id: 'c' }] });
    const ctx = await cc.collectIdleContext();
    assert.strictEqual(ctx.recentEpisodeCount, 3);
  });

  it('collectIdleContext uses getTimeSinceLastDream() — real DreamCycle API', async () => {
    cc.dreamCycle = mockDreamCycle(15 * 60 * 1000);
    const ctx = await cc.collectIdleContext();
    assert.strictEqual(ctx.timeSinceLastDream, 15 * 60 * 1000);
  });

  // ── collectDreamContext ──────────────────────────────────

  it('collectDreamContext returns empty arrays when v7.3.7-extension methods missing', async () => {
    // Without getUnprocessed/getTransitionCandidates — both are NEW in v7.3.7 Step 5
    cc.episodicMemory = mockEpisodicMemory({});
    cc.pendingMomentsStore = mockPending(0);
    const ctx = await cc.collectDreamContext();
    assert.deepStrictEqual(ctx.unprocessedEpisodes, []);
    assert.deepStrictEqual(ctx.transitionCandidates, []);
    assert.strictEqual(ctx.pendingMomentsCount, 0);
  });

  it('collectDreamContext returns data when extension methods exist (forward-compat)', async () => {
    cc.episodicMemory = mockEpisodicMemory({ hasUnprocessed: true, hasTransitions: true });
    const ctx = await cc.collectDreamContext();
    assert.strictEqual(ctx.unprocessedEpisodes.length, 1);
    assert.strictEqual(ctx.transitionCandidates.length, 1);
  });

  // ── Defensive: source throws ──────────────────────────────

  it('does not propagate exceptions from misbehaving sources', async () => {
    cc.emotionalState = {
      getState: () => { throw new Error('boom'); },
      getDominant: () => { throw new Error('boom'); },
      getMood: () => { throw new Error('boom'); },
    };
    let ctx;
    await assert.doesNotReject(async () => { ctx = await cc.collectPostBootContext(); });
    assert.strictEqual(ctx.emotionalSnapshot, null);
  });

  // ── Diagnostics ───────────────────────────────────────────

  it('getReport reports which sources are attached', () => {
    cc.episodicMemory = {};
    cc.dreamCycle = {};
    const r = cc.getReport();
    assert.strictEqual(r.sourcesAttached.episodicMemory, true);
    assert.strictEqual(r.sourcesAttached.dreamCycle, true);
    assert.strictEqual(r.sourcesAttached.journalWriter, false);
  });

});
