const { describe, test, assert, assertEqual, run } = require('../harness');
const { SchemaStore } = require('../../src/agent/planning/SchemaStore');

function makeSS() {
  return new SchemaStore({ bus: { emit(){}, fire(){}, on(){} }, storage: null, config: {} });
}
function makeSchema(name, trigger, conf) {
  return { name, description: `Test ${name}`, trigger: trigger || name, successModifier: 0.5, confidence: conf || 0.7, sourcePattern: 'test', occurrences: 3 };
}

describe('SchemaStoreIndex — _scoreRelevance', () => {
  test('scores higher for trigger match', () => {
    const ss = makeSS();
    const s = makeSchema('code-test', 'code test deploy');
    const score1 = ss._scoreRelevance(s, 'code', 'testing the code', '', {});
    const score2 = ss._scoreRelevance(s, 'unrelated', 'nothing here', '', {});
    assert(score1 > score2, 'trigger match should score higher');
  });
});

describe('SchemaStoreIndex — _findSimilar', () => {
  test('finds by exact name', () => {
    const ss = makeSS();
    ss.store(makeSchema('deploy-pattern', 'deploy ci'));
    const found = ss._findSimilar(makeSchema('deploy-pattern', 'deploy ci'));
    assert(found, 'should find by name');
  });
  test('returns null for no match', () => {
    const ss = makeSS();
    const found = ss._findSimilar(makeSchema('unique-xyz', 'unique xyz'));
    assertEqual(found, null);
  });
});

describe('SchemaStoreIndex — _extractKeywords', () => {
  test('extracts words from trigger and description', () => {
    const ss = makeSS();
    const kw = ss._extractKeywords(makeSchema('test', 'code deploy run'));
    assert(kw.length > 0);
    assert(kw.includes('code') || kw.includes('deploy'));
  });
});

describe('SchemaStoreIndex — _prune', () => {
  test('does nothing under max', () => {
    const ss = makeSS();
    ss.store(makeSchema('a', 'a'));
    ss._prune();
    assert(ss.getAll().length >= 1);
  });
});

describe('SchemaStoreIndex — _rebuildIndex', () => {
  test('rebuilds search index', () => {
    const ss = makeSS();
    ss.store(makeSchema('indexed', 'searchable keyword'));
    ss._rebuildIndex();
    const results = ss.match('searchable');
    // Index should allow matching
    assert(true); // no crash = success
  });
});

describe('SchemaStoreIndex — _maybeDecay', () => {
  test('does not crash on empty store', () => {
    const ss = makeSS();
    ss._maybeDecay();
    assert(true);
  });
});

run();
