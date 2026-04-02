// ============================================================
// GENESIS — KnowledgeGraphSearch.test.js (v5.6.0)
// Tests for the extracted search/learning/context delegate.
// ============================================================

const { describe, test, assert, assertEqual, run } = require('../harness');
const { KnowledgeGraph } = require('../../src/agent/foundation/KnowledgeGraph');

function makeKG() {
  const events = [];
  const kg = new KnowledgeGraph({
    bus: { emit(e, d, m) { events.push({ e, d, m }); }, fire() {}, on() {} },
    storage: null,
  });
  kg._events = events;
  return kg;
}

describe('KnowledgeGraphSearch — search', () => {
  test('returns empty for empty graph', () => {
    const kg = makeKG();
    const results = kg.search('anything');
    assertEqual(results.length, 0);
  });

  test('finds nodes by label match', () => {
    const kg = makeKG();
    kg.addNode('concept', 'JavaScript', { domain: 'programming' });
    kg.addNode('concept', 'Python', { domain: 'programming' });
    kg.addNode('entity', 'Berlin', { domain: 'city' });
    const results = kg.search('JavaScript');
    assert(results.length >= 1, 'should find JavaScript');
    assertEqual(results[0].node.label, 'JavaScript');
  });

  test('respects limit', () => {
    const kg = makeKG();
    for (let i = 0; i < 20; i++) kg.addNode('concept', `item-${i}`, {});
    const results = kg.search('item', 5);
    assertEqual(results.length, 5);
  });

  test('scores label matches higher than property matches', () => {
    const kg = makeKG();
    kg.addNode('concept', 'React', { note: 'framework' });
    kg.addNode('concept', 'framework', { note: 'generic' });
    const results = kg.search('React');
    assertEqual(results[0].node.label, 'React');
  });
});

describe('KnowledgeGraphSearch — buildContext', () => {
  test('returns empty string for no results', () => {
    const kg = makeKG();
    assertEqual(kg.buildContext('nothing'), '');
  });

  test('builds context string from graph', () => {
    const kg = makeKG();
    kg.addNode('concept', 'Node.js', { type: 'runtime' });
    kg.addNode('concept', 'Express', { type: 'framework' });
    kg.connect('Node.js', 'uses', 'Express');
    const ctx = kg.buildContext('Node.js');
    assert(ctx.includes('KNOWLEDGE CONTEXT'));
    assert(ctx.includes('Node.js'));
  });

  test('respects token limit', () => {
    const kg = makeKG();
    for (let i = 0; i < 50; i++) kg.addNode('concept', `concept-${i}`, { desc: 'a'.repeat(100) });
    const ctx = kg.buildContext('concept', 50);
    const tokens = Math.ceil(ctx.length / 3.5);
    assert(tokens <= 100, 'should stay near token limit');
  });
});

describe('KnowledgeGraphSearch — learnFromText', () => {
  test('learns is-a relationships (German)', () => {
    const kg = makeKG();
    const count = kg.learnFromText('JavaScript ist eine Programmiersprache');
    assert(count >= 1, 'should learn at least 1 fact');
    const results = kg.search('JavaScript');
    assert(results.length >= 1);
  });

  test('learns uses relationships (German)', () => {
    const kg = makeKG();
    const count = kg.learnFromText('Genesis benutzt EventBus');
    assert(count >= 1);
  });

  test('learns person names', () => {
    const kg = makeKG();
    const count = kg.learnFromText('My name is Alice');
    assert(count >= 1);
    const results = kg.search('Alice');
    assert(results.length >= 1);
  });

  test('learns project associations', () => {
    const kg = makeKG();
    const count = kg.learnFromText('I work on Genesis');
    assert(count >= 1);
  });

  test('emits knowledge:learned event', () => {
    const kg = makeKG();
    kg.learnFromText('Python ist eine Sprache');
    assert(kg._events.some(e => e.e === 'knowledge:learned'));
  });

  test('returns 0 for no learnable content', () => {
    const kg = makeKG();
    assertEqual(kg.learnFromText('Hello world!'), 0);
  });
});

describe('KnowledgeGraphSearch — _cacheVector', () => {
  test('caches and evicts when over limit', () => {
    const kg = makeKG();
    kg._maxNodeVectors = 3;
    kg._cacheVector('a', [1]);
    kg._cacheVector('b', [2]);
    kg._cacheVector('c', [3]);
    kg._cacheVector('d', [4]);
    assertEqual(kg._nodeVectors.size, 3);
    assert(!kg._nodeVectors.has('a'), 'oldest should be evicted');
    assert(kg._nodeVectors.has('d'));
  });
});

run();
