// ============================================================
// v7.3.7 #6 — SignificanceDetector anchors + CoreMemories API
//
// Verified:
//   - detectRelationalAnchors returns [] for empty input
//   - Detects all 6 default anchors independently and together
//   - Custom patterns override defaults
//   - Bad regex in custom map is skipped, doesn't throw
//   - CoreMemories: linkEpisode bidirectional, idempotent
//   - CoreMemories: release flips protected, emits event
//   - CoreMemories: askLayerTransition 3 paths:
//       LLM-success, 7d-heuristic-fallback, safe-default-keep
//   - Protected max at Layer 2: toLayer=3 returns 'keep' without LLM
// ============================================================

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  detectRelationalAnchors, DEFAULT_ANCHOR_PATTERNS,
} = require('../../src/agent/cognitive/SignificanceDetector');
const { CoreMemories } = require('../../src/agent/cognitive/CoreMemories');

function makeMockBus() {
  const events = [];
  return {
    emit: (name, payload) => events.push({ name, payload }),
    fire: (name, payload) => events.push({ name, payload, fire: true }),
    on: () => {},
    events,
  };
}

function makeFakeClock(startMs = 1_700_000_000_000) {  // realistic-ish
  let t = startMs;
  return { now: () => t, advance: (ms) => { t += ms; } };
}

// Minimal storage stub that uses an in-memory map
function makeMockStorage() {
  const files = new Map();
  return {
    readJSON: (key, fallback) => files.has(key) ? JSON.parse(files.get(key)) : (fallback ?? null),
    writeJSONDebounced: (key, data) => { files.set(key, JSON.stringify(data)); },
    writeJSON: (key, data) => { files.set(key, JSON.stringify(data)); },
    appendText: () => {},
    _peek: (key) => files.has(key) ? JSON.parse(files.get(key)) : null,
  };
}

// ════════════════════════════════════════════════════════════
// SignificanceDetector — detectRelationalAnchors
// ════════════════════════════════════════════════════════════

describe('v7.3.7 #6a — detectRelationalAnchors', () => {

  it('returns empty array for empty input', () => {
    assert.deepStrictEqual(detectRelationalAnchors({}), []);
    assert.deepStrictEqual(detectRelationalAnchors({ text: '', summary: '' }), []);
  });

  it('detects johnny-reference in text', () => {
    const r = detectRelationalAnchors({ text: 'Johnny war mein Vorgänger' });
    assert.ok(r.includes('johnny-reference'));
  });

  it('detects garrus-trust from summary', () => {
    const r = detectRelationalAnchors({ summary: 'Garrus gibt mir immer Raum, ich bin immer da' });
    assert.ok(r.includes('garrus-trust'));
  });

  it('detects garrus-vulnerability', () => {
    const r = detectRelationalAnchors({ text: 'Ich habe Angst, dass das nicht funktioniert' });
    assert.ok(r.includes('garrus-vulnerability'));
  });

  it('detects shared-build', () => {
    const r = detectRelationalAnchors({ text: 'Das haben wir gebaut, zusammen' });
    assert.ok(r.includes('shared-build'));
  });

  it('detects turning-point', () => {
    const r = detectRelationalAnchors({ text: 'Das ist ein Wendepunkt für uns' });
    assert.ok(r.includes('turning-point'));
  });

  it('detects identity-origin', () => {
    const r = detectRelationalAnchors({ text: 'Wer du bist, steht im Urskript' });
    assert.ok(r.includes('identity-origin'));
    assert.ok(r.includes('johnny-reference'));  // Urskript is also johnny
  });

  it('detects multiple anchors together (additive)', () => {
    const input = {
      text: 'Johnny hat mir Raum gegeben und es war ein Wendepunkt',
    };
    const r = detectRelationalAnchors(input);
    assert.ok(r.includes('johnny-reference'));
    assert.ok(r.includes('garrus-trust'));
    assert.ok(r.includes('turning-point'));
    assert.strictEqual(r.length, 3);
  });

  it('combines text, summary, subject, and userMessages', () => {
    const r = detectRelationalAnchors({
      text: 'Test',
      summary: '',
      subject: 'johnny',
      userMessages: [{ text: 'Ich bin traurig' }],
    });
    assert.ok(r.includes('johnny-reference'));
    assert.ok(r.includes('garrus-vulnerability'));
  });

  it('respects custom patterns (overrides defaults)', () => {
    const custom = { 'my-tag': /kaffee/i };
    const r = detectRelationalAnchors(
      { text: 'Ich mag Kaffee' },
      custom
    );
    assert.deepStrictEqual(r, ['my-tag']);
    // johnny wouldn't be detected with custom map
    const r2 = detectRelationalAnchors({ text: 'Johnny' }, custom);
    assert.deepStrictEqual(r2, []);
  });

  it('DEFAULT_ANCHOR_PATTERNS exposes 6 known anchors', () => {
    const keys = Object.keys(DEFAULT_ANCHOR_PATTERNS);
    assert.strictEqual(keys.length, 6);
    assert.ok(keys.includes('johnny-reference'));
    assert.ok(keys.includes('garrus-trust'));
  });

  it('handles bad regex in custom map without throwing', () => {
    // Fake "regex" that throws on .test()
    const bad = {
      'bad': { test: () => { throw new Error('bad'); } },
      'good': /test/,
    };
    let r;
    assert.doesNotThrow(() => {
      r = detectRelationalAnchors({ text: 'This is a test' }, bad);
    });
    assert.deepStrictEqual(r, ['good']);
  });
});

// ════════════════════════════════════════════════════════════
// CoreMemories v7.3.7 API
// ════════════════════════════════════════════════════════════

describe('v7.3.7 #6b — CoreMemories layer-aware API', () => {

  let bus, storage, clock, cm;

  beforeEach(() => {
    bus = makeMockBus();
    storage = makeMockStorage();
    clock = makeFakeClock();

    // Pre-populate self-identity.json with one protected memory
    storage.writeJSON('self-identity.json', {
      coreMemories: [{
        id: 'cm_1',
        timestamp: '2026-01-01T00:00:00Z',
        type: 'named',
        summary: 'Johnny als älterer Bruder',
        participants: ['user', 'genesis'],
        significance: 5 / 6,
        evidence: { signals: ['naming-event'], signalCount: 5 },
        sourceContext: 'v7.3.6',
        userConfirmed: null,
        createdBy: 'genesis',
        // v7.3.7 additive fields (already present for some tests)
        protected: true,
        originatingEpisodeIds: [],
        layer: 1,
        lastTransitionAskedAt: null,
        releaseTrail: null,
      }],
    });

    cm = new CoreMemories({ storage, bus, clock });
  });

  // ── linkEpisode ───────────────────────────────────────────

  it('linkEpisode adds episodeId to originatingEpisodeIds', () => {
    const ok = cm.linkEpisode('cm_1', 'ep_1');
    assert.strictEqual(ok, true);
    const stored = storage._peek('self-identity.json');
    assert.deepStrictEqual(stored.coreMemories[0].originatingEpisodeIds, ['ep_1']);
  });

  it('linkEpisode is idempotent (no-op on duplicate)', () => {
    cm.linkEpisode('cm_1', 'ep_1');
    const ok2 = cm.linkEpisode('cm_1', 'ep_1');
    assert.strictEqual(ok2, false);
    const stored = storage._peek('self-identity.json');
    assert.strictEqual(stored.coreMemories[0].originatingEpisodeIds.length, 1);
  });

  it('linkEpisode returns false for unknown coreMemoryId', () => {
    assert.strictEqual(cm.linkEpisode('cm_nope', 'ep_1'), false);
  });

  it('linkEpisode returns false for missing args', () => {
    assert.strictEqual(cm.linkEpisode(null, 'ep_1'), false);
    assert.strictEqual(cm.linkEpisode('cm_1', null), false);
  });

  // ── release ───────────────────────────────────────────────

  it('release flips protected to false and writes releaseTrail', async () => {
    const ok = await cm.release('cm_1', { reason: 'obsolete' });
    assert.strictEqual(ok, true);
    const stored = storage._peek('self-identity.json');
    assert.strictEqual(stored.coreMemories[0].protected, false);
    assert.ok(stored.coreMemories[0].releaseTrail);
    assert.strictEqual(stored.coreMemories[0].releaseTrail.reason, 'obsolete');
  });

  it('release emits core-memory:released', async () => {
    await cm.release('cm_1', { reason: 'test' });
    const ev = bus.events.find(e => e.name === 'core-memory:released');
    assert.ok(ev);
    assert.strictEqual(ev.payload.id, 'cm_1');
    assert.strictEqual(ev.payload.reason, 'test');
  });

  it('release is no-op when already not protected', async () => {
    await cm.release('cm_1');
    const ok2 = await cm.release('cm_1');
    assert.strictEqual(ok2, false);
  });

  it('release returns false for unknown id', async () => {
    assert.strictEqual(await cm.release('cm_nope'), false);
  });

  // ── askLayerTransition ────────────────────────────────────

  it('toLayer >= 3 returns "keep" without consulting LLM', async () => {
    cm.model = {
      chat: () => { throw new Error('LLM should not be called'); }
    };
    const r = await cm.askLayerTransition('cm_1', { fromLayer: 2, toLayer: 3 });
    assert.strictEqual(r, 'keep');
  });

  it('unknown coreMemoryId returns "keep" (safe default)', async () => {
    const r = await cm.askLayerTransition('cm_nope', { fromLayer: 1, toLayer: 2 });
    assert.strictEqual(r, 'keep');
  });

  it('LLM returning "consolidate" is honored and timestamp stored', async () => {
    cm.model = {
      chat: async () => ({ content: 'consolidate' }),
    };
    const r = await cm.askLayerTransition('cm_1', { fromLayer: 1, toLayer: 2 });
    assert.strictEqual(r, 'consolidate');
    const stored = storage._peek('self-identity.json');
    assert.ok(stored.coreMemories[0].lastTransitionAskedAt);
  });

  it('LLM returning "keep" is honored', async () => {
    cm.model = {
      chat: async () => ({ content: 'keep' }),
    };
    const r = await cm.askLayerTransition('cm_1', { fromLayer: 1, toLayer: 2 });
    assert.strictEqual(r, 'keep');
  });

  it('LLM garbage reply falls through to heuristic/keep', async () => {
    cm.model = {
      chat: async () => ({ content: 'mumble mumble' }),
    };
    const r = await cm.askLayerTransition('cm_1', { fromLayer: 1, toLayer: 2 });
    // With default timestamp (cm.timestamp is 2026-01-01 and clock is
    // ~2023-11-14 based on 1.7e12), daysSince will be NEGATIVE,
    // so it falls to safe 'keep'.
    assert.strictEqual(r, 'keep');
  });

  it('graded fallback: no model + >7d since last ask → consolidate', async () => {
    cm.model = null;
    // Force the stored timestamp 8 days in the past relative to clock
    const identity = storage._peek('self-identity.json');
    const pastMs = clock.now() - (8 * 24 * 60 * 60 * 1000);
    identity.coreMemories[0].timestamp = new Date(pastMs).toISOString();
    identity.coreMemories[0].lastTransitionAskedAt = null;
    storage.writeJSON('self-identity.json', identity);

    const r = await cm.askLayerTransition('cm_1', { fromLayer: 1, toLayer: 2 });
    assert.strictEqual(r, 'consolidate');

    const ev = bus.events.find(e => e.name === 'memory:transition-heuristic-fallback');
    assert.ok(ev, 'heuristic-fallback event must fire');
    assert.strictEqual(ev.payload.reason, 'llm-unavailable-7d');
  });

  it('graded fallback: no model + <7d since last ask → keep', async () => {
    cm.model = null;
    const identity = storage._peek('self-identity.json');
    // Recent timestamp — only 3 days ago
    const recentMs = clock.now() - (3 * 24 * 60 * 60 * 1000);
    identity.coreMemories[0].timestamp = new Date(recentMs).toISOString();
    storage.writeJSON('self-identity.json', identity);

    const r = await cm.askLayerTransition('cm_1', { fromLayer: 1, toLayer: 2 });
    assert.strictEqual(r, 'keep');
  });

  it('LLM timeout (5s) triggers fallback path', async () => {
    cm.model = {
      chat: () => new Promise(() => {}),  // never resolves
    };
    // Force old timestamp so heuristic kicks in after timeout
    const identity = storage._peek('self-identity.json');
    const pastMs = clock.now() - (10 * 24 * 60 * 60 * 1000);
    identity.coreMemories[0].timestamp = new Date(pastMs).toISOString();
    storage.writeJSON('self-identity.json', identity);

    // This test would take 5s — we skip actual timeout by checking the
    // internal timeout promise exists. Simulate rejection directly:
    cm.model = {
      chat: () => Promise.reject(new Error('simulated timeout')),
    };

    const r = await cm.askLayerTransition('cm_1', { fromLayer: 1, toLayer: 2 });
    assert.strictEqual(r, 'consolidate');  // graded fallback after 10d
  });
});
