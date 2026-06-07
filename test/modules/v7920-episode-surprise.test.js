// ============================================================
// GENESIS — v7920-episode-surprise.test.js
// Facet I: recordEpisode carries metadata (incl. surprise) and
// emotionalWeight, the exact fields DreamCycleAnalysis reads as
// `episode.metadata?.surprise || episode.emotionalWeight || 0`.
// ============================================================
const { describe, test, assert, assertEqual, run } = require('../harness');
const { EpisodicMemory } = require('../../src/agent/hexagonal/EpisodicMemory');
const { createBus } = require('../../src/agent/core/EventBus');

function mockStorage() {
  const _data = {};
  return {
    readJSON: (f, def) => _data[f] ?? def,
    writeJSON: (f, d) => { _data[f] = d; },
    writeJSONAsync: async (f, d) => { _data[f] = d; },
    _data,
  };
}
const mk = () => new EpisodicMemory({ bus: createBus(), storage: mockStorage() });
const readSurprise = (ep) => (ep.metadata?.surprise || ep.emotionalWeight || 0);

describe('v7920 episode surprise / emotional weight', () => {

  function assertDeepEqualish(actual, expected, msg) {
    assert(JSON.stringify(actual) === JSON.stringify(expected), msg);
  }

  test('surprise + emotionalWeight are carried onto the episode', () => {
    const em = mk();
    em.recordEpisode({ topic: 'salient', metadata: { surprise: 0.9 }, emotionalWeight: 0.85 });
    const ep = em._episodes[0];
    assertEqual(ep.metadata.surprise, 0.9, 'metadata.surprise stored');
    assertEqual(ep.emotionalWeight, 0.85, 'emotionalWeight stored');
    assertEqual(readSurprise(ep), 0.9, 'read side picks up surprise');
  });

  test('absent fields -> defined defaults, read side yields 0 (no dead crash)', () => {
    const em = mk();
    em.recordEpisode({ topic: 'plain' });
    const ep = em._episodes[0];
    assertDeepEqualish(ep.metadata, {}, 'metadata defaults to {}');
    assertEqual(ep.emotionalWeight, null, 'emotionalWeight defaults to null');
    assertEqual(readSurprise(ep), 0, 'read side yields 0 when unset');
  });

  test('emotionalWeight alone (no metadata) -> read side falls back to it', () => {
    const em = mk();
    em.recordEpisode({ topic: 'weighted', emotionalWeight: 0.7 });
    const ep = em._episodes[0];
    assertEqual(readSurprise(ep), 0.7, 'falls back to emotionalWeight');
  });

  test('a genuine zero weight is preserved (not coerced to null)', () => {
    const em = mk();
    em.recordEpisode({ topic: 'zero', emotionalWeight: 0 });
    const ep = em._episodes[0];
    assertEqual(ep.emotionalWeight, 0, 'explicit 0 preserved by != null guard');
  });

});

if (require.main === module) run();
