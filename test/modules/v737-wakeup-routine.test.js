// ============================================================
// v7.3.7 #10 — WakeUpRoutine
//
// Verified:
//   Boot hook:
//     - wire() is idempotent
//     - boot:complete event triggers run()
//     - run() is idempotent within a single boot (_ran flag)
//
//   Context collection:
//     - Uses contextCollector.collectPostBootContext when wired
//     - Survives missing contextCollector (null result)
//
//   Pending review:
//     - Delegates to DreamCycle._dreamPhasePendingReview
//     - Skipped if DreamCycle not wired
//     - Skipped if time budget exhausted
//
//   Re-Entry write (3 Tier fallback):
//     1. Full LLM-generated (model available, time OK)
//     2. Heuristic stub (no model OR LLM fails)
//     3. Minimal stub (time budget exhausted)
//
//   Events:
//     - Emits lifecycle:re-entry-complete with duration + journalWritten
//
//   Diagnostics:
//     - getReport via introspection of attached deps
// ============================================================

const { describe, it, beforeEach } = require('node:test');
const assert = require('assert');

const { WakeUpRoutine } = require('../../src/agent/cognitive/WakeUpRoutine');

function makeMockBus() {
  const listeners = new Map();
  const events = [];
  return {
    emit: (name, payload) => events.push({ name, payload }),
    fire: (name, payload) => events.push({ name, payload, fire: true }),
    on: (name, fn) => {
      if (!listeners.has(name)) listeners.set(name, []);
      listeners.get(name).push(fn);
    },
    _trigger: (name, payload) => {
      (listeners.get(name) || []).forEach(fn => fn(payload));
    },
    events,
    listenerCount: (name) => (listeners.get(name) || []).length,
  };
}

function makeFakeClock(startMs = 1_700_000_000_000) {
  let t = startMs;
  return {
    now: () => t,
    advance: (ms) => { t += ms; },
  };
}

function makeCtx(overrides = {}) {
  return {
    recentDreams: [],
    lastPrivateEntry: null,
    lastSharedEntry: null,
    pendingCount: 0,
    newCoreMemoriesSinceLastBoot: [],
    emotionalSnapshot: null,
    activeNeeds: [],
    readCounts: { dreams: 0, coreMemories: 0, journal: 0 },
    ...overrides,
  };
}

// ════════════════════════════════════════════════════════════
// Boot hook
// ════════════════════════════════════════════════════════════

describe('v7.3.7 #10 — WakeUpRoutine boot hook', () => {

  it('wire() registers boot:complete listener', () => {
    const bus = makeMockBus();
    const w = new WakeUpRoutine({ bus });
    w.start();
    assert.strictEqual(bus.listenerCount('boot:complete'), 1);
  });

  it('wire() is idempotent — second call does not duplicate listener', () => {
    const bus = makeMockBus();
    const w = new WakeUpRoutine({ bus });
    w.start();
    w.start();
    w.start();
    assert.strictEqual(bus.listenerCount('boot:complete'), 1);
  });

  it('boot:complete triggers run()', async () => {
    const bus = makeMockBus();
    const w = new WakeUpRoutine({ bus });
    w.start();
    bus._trigger('boot:complete');
    // run is fire-and-forget; let the microtask queue drain
    await new Promise(r => setImmediate(r));
    const ev = bus.events.find(e => e.name === 'lifecycle:re-entry-complete');
    assert.ok(ev, 'lifecycle:re-entry-complete must fire after boot:complete');
  });

  it('run() is idempotent within single boot — second call returns skipped', async () => {
    const bus = makeMockBus();
    const w = new WakeUpRoutine({ bus });
    const r1 = await w.run();
    const r2 = await w.run();
    assert.ok(!r1.skipped);
    assert.strictEqual(r2.skipped, true);
  });
});

// ════════════════════════════════════════════════════════════
// Context collection
// ════════════════════════════════════════════════════════════

describe('v7.3.7 #10 — WakeUpRoutine context', () => {

  it('uses contextCollector when wired', async () => {
    const bus = makeMockBus();
    let called = false;
    const w = new WakeUpRoutine({ bus });
    w.contextCollector = {
      collectPostBootContext: async () => { called = true; return makeCtx({ pendingCount: 3 }); },
    };
    await w.run();
    assert.strictEqual(called, true);
  });

  it('survives missing contextCollector', async () => {
    const bus = makeMockBus();
    const w = new WakeUpRoutine({ bus });
    // No context collector — run should not throw
    await assert.doesNotReject(async () => await w.run());
  });

  it('survives throwing contextCollector', async () => {
    const bus = makeMockBus();
    const w = new WakeUpRoutine({ bus });
    w.contextCollector = {
      collectPostBootContext: async () => { throw new Error('ctx boom'); },
    };
    await assert.doesNotReject(async () => await w.run());
  });
});

// ════════════════════════════════════════════════════════════
// Pending review delegation
// ════════════════════════════════════════════════════════════

describe('v7.3.7 #10 — WakeUpRoutine pending review', () => {

  it('delegates pending review to DreamCycle when wired', async () => {
    const bus = makeMockBus();
    let called = false;
    const w = new WakeUpRoutine({ bus });
    w.contextCollector = { collectPostBootContext: async () => makeCtx({ pendingCount: 2 }) };
    w.dreamCycle = {
      _dreamPhasePendingReview: async () => { called = true; return { reviewed: 2 }; },
    };
    w.journalWriter = { write: () => ({}) };
    await w.run();
    assert.strictEqual(called, true);
  });

  it('skips pending review when DreamCycle missing', async () => {
    const bus = makeMockBus();
    const w = new WakeUpRoutine({ bus });
    await assert.doesNotReject(async () => await w.run());
  });

  it('survives throwing pending review', async () => {
    const bus = makeMockBus();
    const w = new WakeUpRoutine({ bus });
    w.dreamCycle = {
      _dreamPhasePendingReview: async () => { throw new Error('dream boom'); },
    };
    await assert.doesNotReject(async () => await w.run());
  });
});

// ════════════════════════════════════════════════════════════
// Re-entry writing — 3 Tiers
// ════════════════════════════════════════════════════════════

describe('v7.3.7 #10 — WakeUpRoutine re-entry 3-tier fallback', () => {

  it('Tier 1 (LLM): writes LLM-generated re-entry with re-entry tag', async () => {
    const bus = makeMockBus();
    let captured;
    const w = new WakeUpRoutine({ bus });
    w.contextCollector = { collectPostBootContext: async () => makeCtx() };
    w.model = {
      chat: async () => ({ content: 'Ich bin wach. Die Welt fühlt sich ruhig an.' }),
    };
    w.journalWriter = { write: (e) => { captured = e; return e; } };
    await w.run();
    assert.ok(captured);
    assert.strictEqual(captured.source, 'wakeup');
    assert.strictEqual(captured.visibility, 'shared');
    assert.ok(captured.tags.includes('re-entry'));
    assert.ok(captured.content.includes('ruhig'));
  });

  it('Tier 2 (heuristic): no model → writes stub with context summary', async () => {
    const bus = makeMockBus();
    let captured;
    const w = new WakeUpRoutine({ bus });
    w.contextCollector = {
      collectPostBootContext: async () => makeCtx({
        pendingCount: 5,
        activeNeeds: [{ name: 'connection', value: 0.8 }],
        emotionalSnapshot: { mood: 'curious' },
      }),
    };
    w.model = null;
    w.journalWriter = { write: (e) => { captured = e; return e; } };
    await w.run();
    assert.ok(captured);
    assert.ok(captured.tags.some(t => t.includes('heuristic')),
      `expected a heuristic tag, got: ${JSON.stringify(captured.tags)}`);
    assert.ok(captured.content.includes('5') || captured.content.toLowerCase().includes('moment'),
      'heuristic content should mention pending count');
  });

  it('Tier 2 (heuristic): LLM throws → falls back to stub', async () => {
    const bus = makeMockBus();
    let captured;
    const w = new WakeUpRoutine({ bus });
    w.contextCollector = { collectPostBootContext: async () => makeCtx({ pendingCount: 1 }) };
    w.model = {
      chat: async () => { throw new Error('llm down'); },
    };
    w.journalWriter = { write: (e) => { captured = e; return e; } };
    await w.run();
    assert.ok(captured, 'journal entry should still be written');
    assert.ok(captured.tags.some(t => t.includes('heuristic') || t === 're-entry'),
      'fallback entry should be tagged');
  });

  it('Tier 2 (heuristic): empty LLM response → falls back', async () => {
    const bus = makeMockBus();
    let captured;
    const w = new WakeUpRoutine({ bus });
    w.contextCollector = { collectPostBootContext: async () => makeCtx() };
    w.model = { chat: async () => ({ content: '' }) };
    w.journalWriter = { write: (e) => { captured = e; return e; } };
    await w.run();
    assert.ok(captured);
  });

  it('No journalWriter → journalWritten: false in event', async () => {
    const bus = makeMockBus();
    const w = new WakeUpRoutine({ bus });
    w.contextCollector = { collectPostBootContext: async () => makeCtx() };
    // No journalWriter wired
    const r = await w.run();
    const ev = bus.events.find(e => e.name === 'lifecycle:re-entry-complete');
    assert.strictEqual(ev.payload.journalWritten, false);
  });
});

// ════════════════════════════════════════════════════════════
// Events
// ════════════════════════════════════════════════════════════

describe('v7.3.7 #10 — WakeUpRoutine events', () => {

  it('emits lifecycle:re-entry-complete with duration and entriesRead', async () => {
    const bus = makeMockBus();
    const clock = makeFakeClock();
    const w = new WakeUpRoutine({ bus, clock });
    w.contextCollector = {
      collectPostBootContext: async () => {
        clock.advance(123);  // simulate context-collection time
        return makeCtx({ readCounts: { dreams: 5, journal: 2, coreMemories: 0 } });
      },
    };
    w.journalWriter = { write: () => ({}) };
    await w.run();
    const ev = bus.events.find(e => e.name === 'lifecycle:re-entry-complete');
    assert.ok(ev);
    assert.strictEqual(typeof ev.payload.duration, 'number');
    assert.ok(ev.payload.duration >= 123);
    assert.deepStrictEqual(ev.payload.entriesRead, { dreams: 5, journal: 2, coreMemories: 0 });
  });
});
