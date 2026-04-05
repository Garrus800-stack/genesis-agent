// ============================================================
// GENESIS — DreamCycleAnalysis.test.js (v5.6.0)
// Tests for the extracted analysis delegate.
// ============================================================

const { describe, test, assert, assertEqual, run } = require('../harness');
const { DreamCycle } = require('../../src/agent/cognitive/DreamCycle');

function makeDC(overrides = {}) {
  return new DreamCycle({
    bus: { emit() {}, fire() {}, on() {} },
    storage: null,
    episodicMemory: null,
    schemaStore: overrides.schemaStore || null,
    knowledgeGraph: overrides.kg || null,
    metaLearning: null,
    model: null,
    eventStore: null,
    config: { useLLM: false, minEpisodes: 2, schemaMinOccurrences: 2 },
  });
}

function makeEpisode(id, ts, opts = {}) {
  return {
    id,
    timestamp: ts,
    tags: opts.tags || [],
    metadata: opts.metadata || {},
    summary: opts.summary || '',
    emotionalWeight: opts.emotionalWeight || 0,
  };
}

describe('DreamCycleAnalysis — _detectPatterns', () => {
  test('returns empty for empty episodes', () => {
    const dc = makeDC();
    const patterns = dc._detectPatterns([]);
    assert(Array.isArray(patterns));
    assertEqual(patterns.length, 0);
  });

  test('detects action sequences from tagged episodes', () => {
    const dc = makeDC();
    const now = Date.now();
    // Two separate time windows (>30min apart) with same sequence
    const episodes = [
      makeEpisode('e1', now, { metadata: { actionType: 'CODE_GENERATE' } }),
      makeEpisode('e2', now + 1000, { metadata: { actionType: 'RUN_TESTS', success: true } }),
      makeEpisode('e3', now + 3600000, { metadata: { actionType: 'CODE_GENERATE' } }),
      makeEpisode('e4', now + 3601000, { metadata: { actionType: 'RUN_TESTS', success: true } }),
    ];
    const patterns = dc._detectPatterns(episodes);
    const seqs = patterns.filter(p => p.type === 'action-sequence');
    assert(seqs.length >= 1, 'should find at least one action sequence');
    assert(seqs[0].occurrences >= 2);
  });

  test('detects error clusters', () => {
    const dc = makeDC();
    const now = Date.now();
    const episodes = [
      makeEpisode('e1', now, { metadata: { success: false, actionType: 'deploy' } }),
      makeEpisode('e2', now + 1000, { metadata: { success: false, actionType: 'deploy' } }),
    ];
    const patterns = dc._detectPatterns(episodes);
    const clusters = patterns.filter(p => p.type === 'error-cluster');
    assert(clusters.length >= 1, 'should find error cluster');
    assertEqual(clusters[0].successRate, 0);
  });
});

describe('DreamCycleAnalysis — _findSurprisePatterns', () => {
  test('groups by positive and negative surprise', () => {
    const dc = makeDC();
    const episodes = [
      makeEpisode('s1', 1, { metadata: { surprise: 0.9, valence: 'positive' } }),
      makeEpisode('s2', 2, { metadata: { surprise: 0.85, valence: 'positive' } }),
      makeEpisode('s3', 3, { metadata: { surprise: 0.95, valence: 'negative' } }),
      makeEpisode('s4', 4, { metadata: { surprise: 0.88, valence: 'negative' } }),
    ];
    const patterns = dc._findSurprisePatterns(episodes);
    assert(patterns.length >= 2, 'should have positive + negative');
    assert(patterns.some(p => p.type === 'surprise-positive'));
    assert(patterns.some(p => p.type === 'surprise-negative'));
  });

  test('returns empty for low-surprise episodes', () => {
    const dc = makeDC();
    const episodes = [
      makeEpisode('s1', 1, { metadata: { surprise: 0.1 } }),
      makeEpisode('s2', 2, { metadata: { surprise: 0.2 } }),
    ];
    assertEqual(dc._findSurprisePatterns(episodes).length, 0);
  });
});

describe('DreamCycleAnalysis — _groupByTimeWindow', () => {
  test('groups episodes within time window', () => {
    const dc = makeDC();
    const episodes = [
      makeEpisode('a', 1000), makeEpisode('b', 2000), makeEpisode('c', 3000),
      makeEpisode('d', 100000), makeEpisode('e', 101000),
    ];
    const windows = dc._groupByTimeWindow(episodes, 10000);
    assertEqual(windows.length, 2);
    assertEqual(windows[0].length, 3);
    assertEqual(windows[1].length, 2);
  });

  test('returns empty for empty input', () => {
    const dc = makeDC();
    assertEqual(dc._groupByTimeWindow([], 1000).length, 0);
  });
});

describe('DreamCycleAnalysis — _heuristicSchemas', () => {
  test('produces schemas from patterns', () => {
    const dc = makeDC();
    const patterns = [
      { type: 'action-sequence', key: 'code→test', occurrences: 5, successRate: 0.8, detail: [] },
    ];
    const schemas = dc._heuristicSchemas(patterns);
    assertEqual(schemas.length, 1);
    assert(schemas[0].name.includes('action-sequence'));
    assert(schemas[0].confidence > 0);
    assert(schemas[0].successModifier > 0);
  });
});

describe('DreamCycleAnalysis — _consolidateMemories', () => {
  test('strengthens high-surprise and decays low-surprise', () => {
    const nodes = new Map();
    nodes.set('n1', { properties: { weight: 0.5 } });
    nodes.set('n2', { properties: { weight: 0.5 } });
    const kg = {
      findNode(id) { return nodes.get(id); },
    };
    const dc = makeDC({ kg });
    const episodes = [
      makeEpisode('e1', 1, { metadata: { surprise: 0.9, knowledgeNodeId: 'n1' } }),
      makeEpisode('e2', 2, { metadata: { surprise: 0.1, knowledgeNodeId: 'n2' } }),
    ];
    const result = dc._consolidateMemories(episodes);
    assertEqual(result.strengthened, 1);
    assertEqual(result.decayed, 1);
    assert(nodes.get('n1').properties.weight > 0.5);
    assert(nodes.get('n2').properties.weight < 0.5);
  });
});

describe('DreamCycleAnalysis — _generateInsights', () => {
  test('detects contradicting schemas', () => {
    const dc = makeDC({
      schemaStore: {
        getAll: () => [{
          id: 'existing',
          trigger: 'code test deploy',
          successModifier: -0.5,
          name: 'deploy-fails',
        }],
      },
    });
    const newSchemas = [{
      id: 'new1',
      trigger: 'code test deploy',
      successModifier: 0.6,
      name: 'deploy-works',
    }];
    const insights = dc._generateInsights(newSchemas);
    assert(insights.length >= 1);
    assertEqual(insights[0].type, 'contradiction');
  });
});

describe('DreamCycleAnalysis — _parseJSONResponse', () => {
  test('parses plain JSON', () => {
    const dc = makeDC();
    const result = dc._parseJSONResponse('[{"a":1}]');
    assert(Array.isArray(result));
    assertEqual(result[0].a, 1);
  });

  test('extracts JSON from markdown fences', () => {
    const dc = makeDC();
    const result = dc._parseJSONResponse('```json\n[{"b":2}]\n```');
    assert(Array.isArray(result));
    assertEqual(result[0].b, 2);
  });

  test('returns null for garbage', () => {
    const dc = makeDC();
    assertEqual(dc._parseJSONResponse('not json at all'), null);
  });

  test('returns null for null input', () => {
    const dc = makeDC();
    assertEqual(dc._parseJSONResponse(null), null);
  });
});

run();
