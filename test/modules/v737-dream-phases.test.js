// ============================================================
// v7.3.7 #7 — DreamCycle new Phases (1.5 / 4c / 4d / 6)
//
// Verified:
//   Phase 1.5 — Pending Moments Review:
//     - Batch limit of 5
//     - ELEVATE transitions episode to protected + linked CoreMemory
//     - LET_FADE emits memory:self-released
//     - KEEP marks moment as reviewed with no state change
//     - Expired (>7d) moments silently let-fade + journal note
//     - No LLM → safe default KEEP
//
//   Phase 4c — Layer Transition:
//     - Walks candidates (up to 10 per cycle)
//     - Honors ActiveReferences skip
//     - Protected → consults CoreMemories askLayerTransition
//     - Protected toLayer=3 skips entirely
//     - Unprotected → consolidate via fallback cascade
//     - Consolidated episode written back with layerHistory extended
//
//   Phase 4d — Journal Rotation: calls checkRotation safely
//
//   Phase 6 — Cycle Report: writes shared journal entry with
//     dream-report tag and summary text
// ============================================================

const { describe, it, beforeEach } = require('node:test');
const assert = require('assert');

const { DreamCycle } = require('../../src/agent/cognitive/DreamCycle');

function makeMockBus() {
  const events = [];
  return {
    emit: (name, payload) => events.push({ name, payload }),
    fire: (name, payload) => events.push({ name, payload, fire: true }),
    on: () => {},
    events,
  };
}

function makeFakeClock(startMs = 1_700_000_000_000) {
  let t = startMs;
  return { now: () => t, advance: (ms) => { t += ms; } };
}

// ── Mock dependencies ──────────────────────────────────────

function makePendingStore(moments = []) {
  let review = [...moments];
  const expired = [];
  return {
    getAll: () => review.filter(m => m.status === 'pending'),
    getExpiredCandidates: () => expired,
    markReviewed: (id, decision) => {
      const m = review.find(x => x.id === id);
      if (m) { m.status = 'reviewed'; m.reviewedAs = decision; return true; }
      return false;
    },
    markExpired: (id) => {
      const m = review.find(x => x.id === id);
      if (m) { m.status = 'expired'; return true; }
      return false;
    },
    _setExpired: (...items) => { expired.push(...items); },
  };
}

function makeJournalWriter() {
  const writes = [];
  return {
    write: (entry) => writes.push(entry),
    readLast: () => [],
    checkRotation: () => {},
    _writes: writes,
  };
}

function makeCoreMemories({ markAs = null, askAs = 'keep' } = {}) {
  return {
    markAsSignificant: async () => markAs,
    askLayerTransition: async () => askAs,
  };
}

function makeEpisodicMemory(episodes = []) {
  return {
    getTransitionCandidates: () => episodes,
    setProtected: () => true,
    setLinkedCoreMemoryId: () => true,
    replaceEpisode: () => true,
  };
}

function makeActiveRefs(activeSet = new Set()) {
  return { isActive: (id) => activeSet.has(id) };
}

function makeModel(reply = 'KEEP') {
  return {
    chat: async () => ({ content: reply }),
  };
}

// ══════════════════════════════════════════════════════════
// Phase 1.5 — Pending Moments Review
// ══════════════════════════════════════════════════════════

describe('v7.3.7 #7 — DreamCycle Phase 1.5 (Pending Review)', () => {

  it('returns skipped when no pendingMomentsStore wired', async () => {
    const dc = new DreamCycle({ bus: makeMockBus() });
    const r = await dc._dreamPhasePendingReview(1.0);
    assert.strictEqual(r.skipped, true);
  });

  it('reviews all pending moments up to batch limit of 5', async () => {
    const bus = makeMockBus();
    const dc = new DreamCycle({ bus, clock: makeFakeClock() });
    const moments = Array.from({ length: 8 }, (_, i) => ({
      id: `pm_${i}`, episodeId: `ep_${i}`, summary: `m-${i}`, status: 'pending',
    }));
    dc.pendingMomentsStore = makePendingStore(moments);
    dc.model = makeModel('KEEP');

    const r = await dc._dreamPhasePendingReview(1.0);
    assert.strictEqual(r.reviewed, 5);
  });

  it('ELEVATE creates core memory, protects episode, emits event', async () => {
    const bus = makeMockBus();
    const dc = new DreamCycle({ bus, clock: makeFakeClock() });
    const mom = { id: 'pm_1', episodeId: 'ep_1', summary: 'important', status: 'pending' };
    dc.pendingMomentsStore = makePendingStore([mom]);
    dc.model = makeModel('ELEVATE');
    dc.coreMemories = makeCoreMemories({ markAs: { id: 'cm_new' } });
    let protectedEp, linkedEp;
    dc.episodicMemory = {
      setProtected: (id, v) => { protectedEp = { id, v }; return true; },
      setLinkedCoreMemoryId: (id, cmId) => { linkedEp = { id, cmId }; return true; },
    };

    await dc._dreamPhasePendingReview(1.0);

    assert.deepStrictEqual(protectedEp, { id: 'ep_1', v: true });
    assert.deepStrictEqual(linkedEp, { id: 'ep_1', cmId: 'cm_new' });
    const ev = bus.events.find(e => e.name === 'memory:self-elevated');
    assert.ok(ev);
    assert.strictEqual(ev.payload.episodeId, 'ep_1');
  });

  it('LET_FADE emits memory:self-released', async () => {
    const bus = makeMockBus();
    const dc = new DreamCycle({ bus, clock: makeFakeClock() });
    dc.pendingMomentsStore = makePendingStore([
      { id: 'pm_1', episodeId: 'ep_1', summary: 's', status: 'pending' }
    ]);
    dc.model = makeModel('LET_FADE');
    await dc._dreamPhasePendingReview(1.0);
    const ev = bus.events.find(e => e.name === 'memory:self-released');
    assert.ok(ev);
    assert.strictEqual(ev.payload.episodeId, 'ep_1');
  });

  it('KEEP neither elevates nor releases', async () => {
    const bus = makeMockBus();
    const dc = new DreamCycle({ bus, clock: makeFakeClock() });
    dc.pendingMomentsStore = makePendingStore([
      { id: 'pm_1', episodeId: 'ep_1', summary: 's', status: 'pending' }
    ]);
    dc.model = makeModel('KEEP');
    await dc._dreamPhasePendingReview(1.0);
    assert.ok(!bus.events.some(e => e.name === 'memory:self-elevated'));
    assert.ok(!bus.events.some(e => e.name === 'memory:self-released'));
  });

  it('expired moments get journal fade note and markExpired', async () => {
    const bus = makeMockBus();
    const dc = new DreamCycle({ bus, clock: makeFakeClock() });
    const store = makePendingStore([]);
    store._setExpired({ id: 'pm_exp', summary: 'too late', pinnedAt: '2025-01-01' });
    dc.pendingMomentsStore = store;
    dc.journalWriter = makeJournalWriter();

    const r = await dc._dreamPhasePendingReview(1.0);
    assert.strictEqual(r.expired, 1);
    assert.strictEqual(dc.journalWriter._writes.length, 1);
    assert.ok(dc.journalWriter._writes[0].tags.includes('pin-expired'));
  });

  it('no model → decision is "keep" (safe default)', async () => {
    const bus = makeMockBus();
    const dc = new DreamCycle({ bus, clock: makeFakeClock() });
    dc.pendingMomentsStore = makePendingStore([
      { id: 'pm_1', episodeId: 'ep_1', summary: 's', status: 'pending' }
    ]);
    dc.model = null;
    const r = await dc._dreamPhasePendingReview(1.0);
    assert.strictEqual(r.decisions[0].decision, 'keep');
  });
});

// ══════════════════════════════════════════════════════════
// Phase 4c — Layer-Transition-Consolidation
// ══════════════════════════════════════════════════════════

describe('v7.3.7 #7 — DreamCycle Phase 4c (Layer Transition)', () => {

  it('returns skipped without transition API', async () => {
    const dc = new DreamCycle({ bus: makeMockBus() });
    const r = await dc._dreamPhaseLayerTransition(1.0);
    assert.strictEqual(r.skipped, true);
  });

  it('processes unprotected episodes with extractive fallback (no LLM)', async () => {
    const bus = makeMockBus();
    const dc = new DreamCycle({ bus, clock: makeFakeClock() });
    const ep = {
      id: 'ep_1',
      layer: 1,
      topic: 'A topic',
      summary: 'First sentence. Middle sentence. Last sentence.',
      layerHistory: [{ layer: 1, since: '2026-01-01T00:00:00Z' }],
      transitionPending: true,
      protected: false,
    };
    let replacedWith;
    dc.episodicMemory = {
      getTransitionCandidates: () => [ep],
      replaceEpisode: (_id, newEp) => { replacedWith = newEp; return true; },
    };
    dc.model = null;  // force extractive

    const r = await dc._dreamPhaseLayerTransition(1.0);
    assert.strictEqual(r.processed, 1);
    assert.strictEqual(r.results[0].action, 'consolidated');
    assert.ok(replacedWith);
    assert.strictEqual(replacedWith.layer, 2);
    assert.strictEqual(replacedWith.layerHistory.length, 2);
    const ev = bus.events.find(e => e.name === 'memory:consolidated');
    assert.ok(ev);
  });

  it('LLM path produces Schema with distilled summary', async () => {
    const bus = makeMockBus();
    const dc = new DreamCycle({ bus, clock: makeFakeClock() });
    const ep = {
      id: 'ep_1', layer: 1, topic: 't', summary: 'long summary here',
      layerHistory: [], transitionPending: true, protected: false,
    };
    let stored;
    dc.episodicMemory = {
      getTransitionCandidates: () => [ep],
      replaceEpisode: (_id, newEp) => { stored = newEp; return true; },
    };
    dc.model = { chat: async () => ({ content: 'Short distilled summary.' }) };

    await dc._dreamPhaseLayerTransition(1.0);
    assert.strictEqual(stored.summary, 'Short distilled summary.');
    assert.strictEqual(stored.layer, 2);
  });

  it('Protected episode → asks CoreMemories (keep respected)', async () => {
    const bus = makeMockBus();
    const dc = new DreamCycle({ bus, clock: makeFakeClock() });
    const ep = {
      id: 'ep_1', layer: 1, transitionPending: true,
      protected: true, linkedCoreMemoryId: 'cm_1', layerHistory: [],
    };
    dc.episodicMemory = makeEpisodicMemory([ep]);
    dc.coreMemories = makeCoreMemories({ askAs: 'keep' });

    const r = await dc._dreamPhaseLayerTransition(1.0);
    assert.strictEqual(r.results[0].action, 'kept-layer');
    const ev = bus.events.find(e => e.name === 'memory:layer-transition-asked');
    assert.ok(ev);
    assert.strictEqual(ev.payload.decision, 'keep');
  });

  it('Protected + toLayer=3 → protected-max-layer, no LLM call', async () => {
    const bus = makeMockBus();
    const dc = new DreamCycle({ bus, clock: makeFakeClock() });
    const ep = {
      id: 'ep_1', layer: 2, transitionPending: true,
      protected: true, linkedCoreMemoryId: 'cm_1', layerHistory: [],
    };
    dc.episodicMemory = makeEpisodicMemory([ep]);
    dc.coreMemories = {
      askLayerTransition: () => { throw new Error('must not be called'); }
    };
    const r = await dc._dreamPhaseLayerTransition(1.0);
    assert.strictEqual(r.results[0].action, 'protected-max-layer');
  });

  it('ActiveReferences skip prevents consolidation', async () => {
    const bus = makeMockBus();
    const dc = new DreamCycle({ bus, clock: makeFakeClock() });
    const active = new Set(['ep_1']);
    dc.activeRefs = makeActiveRefs(active);
    // Candidate API must respect skipIf
    dc.episodicMemory = {
      getTransitionCandidates: (opts) => {
        const all = [{ id: 'ep_1', layer: 1, transitionPending: true, protected: false, layerHistory: [], summary: 's' }];
        return all.filter(ep => !opts.skipIf || !opts.skipIf(ep.id));
      },
      replaceEpisode: () => true,
    };
    dc.model = null;
    const r = await dc._dreamPhaseLayerTransition(1.0);
    assert.strictEqual(r.processed, 0);
  });

  it('Fallback failure emits memory:consolidation-failed', async () => {
    const bus = makeMockBus();
    const dc = new DreamCycle({ bus, clock: makeFakeClock() });
    const ep = {
      id: 'ep_bad', layer: 1, transitionPending: true, protected: false,
      summary: '', topic: '', layerHistory: [],
    };
    dc.episodicMemory = {
      getTransitionCandidates: () => [ep],
      replaceEpisode: () => true,
    };
    dc.model = null;
    // Empty summary+topic → extractive returns null → fail
    const r = await dc._dreamPhaseLayerTransition(1.0);
    const failEv = bus.events.find(e => e.name === 'memory:consolidation-failed');
    assert.ok(failEv);
    assert.strictEqual(r.results[0].action, 'failed');
  });

  it('No candidates → processed 0, no events', async () => {
    const bus = makeMockBus();
    const dc = new DreamCycle({ bus });
    dc.episodicMemory = makeEpisodicMemory([]);
    const r = await dc._dreamPhaseLayerTransition(1.0);
    assert.strictEqual(r.processed, 0);
  });
});

// ══════════════════════════════════════════════════════════
// Phase 4d — Journal Rotation
// ══════════════════════════════════════════════════════════

describe('v7.3.7 #7 — DreamCycle Phase 4d (Journal Rotation)', () => {

  it('no-op when journalWriter missing', () => {
    const dc = new DreamCycle({ bus: makeMockBus() });
    assert.doesNotThrow(() => dc._dreamPhaseJournalRotation());
  });

  it('calls checkRotation on journalWriter', () => {
    const dc = new DreamCycle({ bus: makeMockBus() });
    let called = false;
    dc.journalWriter = { checkRotation: () => { called = true; } };
    dc._dreamPhaseJournalRotation();
    assert.strictEqual(called, true);
  });

  it('throwing checkRotation does not propagate', () => {
    const dc = new DreamCycle({ bus: makeMockBus() });
    dc.journalWriter = { checkRotation: () => { throw new Error('boom'); } };
    assert.doesNotThrow(() => dc._dreamPhaseJournalRotation());
  });
});

// ══════════════════════════════════════════════════════════
// Phase 6 — Cycle Report Entry
// ══════════════════════════════════════════════════════════

describe('v7.3.7 #7 — DreamCycle Phase 6 (Cycle Report)', () => {

  it('no-op when journalWriter missing', async () => {
    const dc = new DreamCycle({ bus: makeMockBus() });
    await assert.doesNotReject(async () => {
      await dc._dreamPhaseCycleReport({ dreamNumber: 1, phases: [] });
    });
  });

  it('writes dream-report entry with summary text', async () => {
    const dc = new DreamCycle({ bus: makeMockBus(), clock: makeFakeClock() });
    dc.journalWriter = makeJournalWriter();
    await dc._dreamPhaseCycleReport({
      dreamNumber: 42,
      phases: [
        { name: 'pending-review', reviewed: 3,
          decisions: [
            { decision: 'elevate' }, { decision: 'keep' }, { decision: 'let_fade' },
          ] },
        { name: 'layer-transition', processed: 7 },
      ],
      newSchemas: [],
    });

    assert.strictEqual(dc.journalWriter._writes.length, 1);
    const w = dc.journalWriter._writes[0];
    assert.strictEqual(w.visibility, 'shared');
    assert.strictEqual(w.source, 'dreamcycle');
    assert.ok(w.tags.includes('dream-report'));
    assert.ok(w.content.includes('Dream #42'));
    assert.ok(w.content.includes('3 Momente'));
    assert.ok(w.content.includes('7 Episoden'));
    assert.strictEqual(w.meta.dreamNumber, 42);
    assert.strictEqual(w.meta.reviewed, 3);
    assert.strictEqual(w.meta.consolidated, 7);
  });

  it('no write when nothing meaningful to report', async () => {
    const dc = new DreamCycle({ bus: makeMockBus(), clock: makeFakeClock() });
    dc.journalWriter = makeJournalWriter();
    await dc._dreamPhaseCycleReport({
      dreamNumber: 5, phases: [{ name: 'recall', episodeCount: 0 }], newSchemas: [],
    });
    assert.strictEqual(dc.journalWriter._writes.length, 0);
  });
});
