// ============================================================
// v7.3.7 #4b — PendingMomentsStore
//
// Verified:
//   - mark() creates a pending record
//   - getAll/getCount only see pending
//   - markReviewed transitions pending → reviewed with decision
//   - markExpired transitions pending → expired
//   - getExpiredCandidates uses 7-day TTL via injected clock
//   - Persistence: load survives restart
//   - Restart restores counter so new IDs don't collide
//   - Defensive: missing episodeId → null, no crash
//   - bus emits memory:marked
// ============================================================

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { PendingMomentsStore } = require('../../src/agent/memory/PendingMomentsStore');

function makeFakeClock(startMs = 1_000_000) {
  let t = startMs;
  return {
    now: () => t,
    advance: (ms) => { t += ms; },
  };
}

function makeMockBus() {
  const events = [];
  return {
    emit: (name, payload) => events.push({ name, payload }),
    events,
  };
}

let tempDir, bus, clock, store;

describe('v7.3.7 #4b — PendingMomentsStore', () => {

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'genesis-pending-test-'));
    bus = makeMockBus();
    clock = makeFakeClock();
    store = new PendingMomentsStore({ bus, storageDir: tempDir, clock });
  });

  afterEach(() => {
    try { store.stop(); } catch {}
    try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch {}
  });

  // ── Construction ──────────────────────────────────────────

  it('constructs with empty list when no file exists', () => {
    assert.strictEqual(store.getCount(), 0);
  });

  it('throws without storageDir', () => {
    assert.throws(() => new PendingMomentsStore({ bus }));
  });

  // ── mark() basics ─────────────────────────────────────────

  it('mark() returns ID and stores pending record', () => {
    const id = store.mark({ episodeId: 'ep_1', summary: 'first' });
    assert.ok(id);
    assert.strictEqual(store.getCount(), 1);
    const m = store.getById(id);
    assert.strictEqual(m.status, 'pending');
    assert.strictEqual(m.episodeId, 'ep_1');
    assert.strictEqual(m.summary, 'first');
    assert.strictEqual(m.triggerContext, 'self-marked');
  });

  it('mark() returns null when episodeId missing', () => {
    assert.strictEqual(store.mark({}), null);
    assert.strictEqual(store.mark({ summary: 'no episode' }), null);
    assert.strictEqual(store.getCount(), 0);
  });

  it('mark() truncates summary to 200 chars', () => {
    const long = 'x'.repeat(500);
    const id = store.mark({ episodeId: 'ep_1', summary: long });
    const m = store.getById(id);
    assert.strictEqual(m.summary.length, 200);
  });

  it('mark() emits memory:marked event', () => {
    const id = store.mark({ episodeId: 'ep_1', summary: 's', triggerContext: 'user' });
    const ev = bus.events.find(e => e.name === 'memory:marked');
    assert.ok(ev);
    assert.strictEqual(ev.payload.id, id);
    assert.strictEqual(ev.payload.episodeId, 'ep_1');
    assert.strictEqual(ev.payload.triggerContext, 'user');
  });

  // ── getAll / getCount ─────────────────────────────────────

  it('getAll only returns pending moments', () => {
    const a = store.mark({ episodeId: 'ep_1' });
    const b = store.mark({ episodeId: 'ep_2' });
    store.markReviewed(a, 'elevate');
    assert.strictEqual(store.getCount(), 1);
    assert.strictEqual(store.getAll()[0].id, b);
  });

  // ── markReviewed ──────────────────────────────────────────

  it('markReviewed transitions pending → reviewed', () => {
    const id = store.mark({ episodeId: 'ep_1' });
    clock.advance(60_000);
    const ok = store.markReviewed(id, 'elevate');
    assert.strictEqual(ok, true);
    const m = store.getById(id);
    assert.strictEqual(m.status, 'reviewed');
    assert.strictEqual(m.reviewedAs, 'elevate');
    assert.ok(m.reviewedAt);
  });

  it('markReviewed returns false for unknown id', () => {
    assert.strictEqual(store.markReviewed('nope', 'keep'), false);
  });

  it('markReviewed returns false if already reviewed/expired', () => {
    const id = store.mark({ episodeId: 'ep_1' });
    store.markReviewed(id, 'keep');
    assert.strictEqual(store.markReviewed(id, 'elevate'), false);
  });

  // ── markExpired ───────────────────────────────────────────

  it('markExpired transitions pending → expired', () => {
    const id = store.mark({ episodeId: 'ep_1' });
    const ok = store.markExpired(id);
    assert.strictEqual(ok, true);
    assert.strictEqual(store.getById(id).status, 'expired');
  });

  // ── getExpiredCandidates with TTL ─────────────────────────

  it('getExpiredCandidates returns pending moments past 7-day TTL', () => {
    const fresh = store.mark({ episodeId: 'ep_fresh' });
    clock.advance(8 * 24 * 60 * 60 * 1000);  // +8 days
    const old = store.mark({ episodeId: 'ep_old' });
    // Manually backdate "old" so that current relative TTL applies — actually
    // simpler: advance past fresh's TTL too, the new one won't be 8d old yet.
    // Re-think: fresh was created at t=1_000_000. After +8d, current time
    // is 1_000_000 + 8d. fresh's age = 8d > 7d → expired candidate.
    // old was just created → 0d → not.
    const candidates = store.getExpiredCandidates();
    assert.strictEqual(candidates.length, 1);
    assert.strictEqual(candidates[0].id, fresh);
  });

  it('getExpiredCandidates returns empty when nothing past TTL', () => {
    store.mark({ episodeId: 'ep_1' });
    clock.advance(3 * 24 * 60 * 60 * 1000);  // +3d, well below 7d
    assert.strictEqual(store.getExpiredCandidates().length, 0);
  });

  // ── Persistence ───────────────────────────────────────────

  it('persists across restarts', () => {
    const id = store.mark({ episodeId: 'ep_1', summary: 'persisted' });
    store.stop();

    const store2 = new PendingMomentsStore({ bus, storageDir: tempDir, clock });
    const m = store2.getById(id);
    assert.ok(m, 'moment must survive restart');
    assert.strictEqual(m.summary, 'persisted');
    assert.strictEqual(store2.getCount(), 1);
    store2.stop();
  });

  it('restart restores counter so new IDs do not collide with old ones', () => {
    store.mark({ episodeId: 'ep_a' });
    store.mark({ episodeId: 'ep_b' });
    store.stop();

    const store2 = new PendingMomentsStore({ bus, storageDir: tempDir, clock });
    const newId = store2.mark({ episodeId: 'ep_c' });
    // Counter should be at least 3 now — extract suffix
    const suffix = parseInt(/_(\d+)$/.exec(newId)[1], 10);
    assert.ok(suffix >= 3, `new ID suffix ${suffix} must be ≥ 3 after restart`);
    store2.stop();
  });

  it('survives corrupt JSONL line on load (skips bad line)', () => {
    store.mark({ episodeId: 'ep_good' });
    store.stop();
    // Append a corrupt line
    fs.appendFileSync(path.join(tempDir, 'pending-moments.jsonl'), 'NOT JSON\n');

    const store2 = new PendingMomentsStore({ bus, storageDir: tempDir, clock });
    assert.strictEqual(store2.getCount(), 1);  // good entry still there
    store2.stop();
  });

  // ── Diagnostics ───────────────────────────────────────────

  it('getReport counts statuses', () => {
    const a = store.mark({ episodeId: 'ep_a' });
    const b = store.mark({ episodeId: 'ep_b' });
    const c = store.mark({ episodeId: 'ep_c' });
    store.markReviewed(a, 'elevate');
    store.markExpired(c);
    const r = store.getReport();
    assert.strictEqual(r.total, 3);
    assert.strictEqual(r.pending, 1);
    assert.strictEqual(r.reviewed, 1);
    assert.strictEqual(r.expired, 1);
  });

});
