// ============================================================
// v7.4.1 — ContextCollector vs RuntimeState Consistency Test
//
// Regression lock: ContextCollector._collectEmotionalSnapshot()
// and EmotionalState.getRuntimeSnapshot() both read the same
// live state but from independent code paths. If they drift,
// Genesis would have two different answers to "what do you feel"
// depending on which subsystem is asked — classic symptom of
// hidden state duplication.
//
// IMPORTANT: the two methods have DIFFERENT return shapes:
//   ContextCollector → { state, dominant: {emotion, intensity}, mood }
//   RuntimeSnapshot  → { dominant: string, intensity, mood, trend, top3 }
//
// Common comparable fields:
//   runtimeState.dominant  ≡  context.dominant.emotion   (both string)
//   runtimeState.mood      ≡  context.mood               (both string)
//
// We compare exactly those two fields — not the whole object.
// ============================================================

const { describe, it } = require('node:test');
const assert = require('assert');
const { EmotionalState } = require('../../src/agent/organism/EmotionalState');
const { ContextCollector } = require('../../src/agent/cognitive/ContextCollector');

function makeEmotionalState(overrides = {}) {
  // Real EmotionalState constructor takes {bus, storage, intervals, config}.
  // For tests we pass mocks — we only need getState/getDominant/getMood
  // which operate on internal dimensions.
  const es = new EmotionalState({
    bus: null,         // → falls back to NullBus
    storage: null,
    intervals: null,
    config: null,
  });
  const defaults = {
    curiosity: 0.8,
    satisfaction: 0.5,
    loneliness: 0.3,
    frustration: 0.1,
    energy: 0.7,
  };
  const values = { ...defaults, ...overrides };
  for (const [name, v] of Object.entries(values)) {
    if (es.dimensions[name]) {
      es.dimensions[name].value = v;
    }
  }
  return es;
}

function makeCollector(emotionalState) {
  // ContextCollector uses late-binding for all services — set them
  // after construction (same pattern as real boot sequence).
  const collector = new ContextCollector();
  collector.emotionalState = emotionalState;
  return collector;
}

describe('v7.4.1 — ContextCollector/RuntimeSnapshot emotion consistency', () => {

  it('runtimeState.dominant matches context.dominant.emotion', () => {
    const es = makeEmotionalState({ curiosity: 0.9 });
    const collector = makeCollector(es);

    const runtimeSnap = es.getRuntimeSnapshot();
    const contextSnap = collector._collectEmotionalSnapshot();

    assert.ok(runtimeSnap.dominant, 'runtimeSnap should have dominant');
    assert.ok(contextSnap?.dominant, 'contextSnap should have dominant');

    // Different shapes, same underlying value.
    assert.strictEqual(
      runtimeSnap.dominant,
      contextSnap.dominant.emotion,
      `dominant emotion drift: runtime="${runtimeSnap.dominant}" ` +
      `vs context="${contextSnap.dominant.emotion}"`);
  });

  it('runtimeState.mood matches context.mood', () => {
    const es = makeEmotionalState({ curiosity: 0.8, energy: 0.7 });
    const collector = makeCollector(es);

    const runtimeSnap = es.getRuntimeSnapshot();
    const contextSnap = collector._collectEmotionalSnapshot();

    assert.strictEqual(
      runtimeSnap.mood,
      contextSnap.mood,
      `mood drift: runtime="${runtimeSnap.mood}" ` +
      `vs context="${contextSnap.mood}"`);
  });

  it('both snapshots are stable across rapid reads (< 10ms)', () => {
    // Catches race conditions: if a read triggers any internal
    // mutation (decay, normalization), two back-to-back calls
    // would disagree. Must NOT happen — snapshots are pure reads.
    const es = makeEmotionalState();
    const collector = makeCollector(es);

    const r1 = es.getRuntimeSnapshot();
    const c1 = collector._collectEmotionalSnapshot();
    const r2 = es.getRuntimeSnapshot();
    const c2 = collector._collectEmotionalSnapshot();

    assert.strictEqual(r1.dominant, r2.dominant,
      'runtime snapshot must be stable across rapid reads');
    assert.strictEqual(r1.mood, r2.mood,
      'runtime mood must be stable');
    assert.strictEqual(c1.dominant.emotion, c2.dominant.emotion,
      'context snapshot must be stable');
    assert.strictEqual(c1.mood, c2.mood,
      'context mood must be stable');
  });

  it('consistency holds across multiple emotional configurations', () => {
    const configs = [
      { curiosity: 0.9, satisfaction: 0.2 },   // curiosity dominant
      { satisfaction: 0.9, curiosity: 0.3 },   // satisfaction dominant
      { loneliness: 0.8, energy: 0.2 },        // loneliness + low energy
      { frustration: 0.7, satisfaction: 0.2 }, // frustration dominant
    ];
    for (const cfg of configs) {
      const es = makeEmotionalState(cfg);
      const collector = makeCollector(es);
      const r = es.getRuntimeSnapshot();
      const c = collector._collectEmotionalSnapshot();
      assert.strictEqual(r.dominant, c.dominant.emotion,
        `drift at config ${JSON.stringify(cfg)}`);
      assert.strictEqual(r.mood, c.mood,
        `mood drift at config ${JSON.stringify(cfg)}`);
    }
  });

  it('ContextCollector returns null gracefully when emotionalState is null', () => {
    // Defensive: boot-phase or stripped-down test contexts.
    const collector = makeCollector(null);
    assert.strictEqual(collector._collectEmotionalSnapshot(), null);
  });
});
