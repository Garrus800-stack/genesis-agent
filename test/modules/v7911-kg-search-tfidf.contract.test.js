#!/usr/bin/env node
// ============================================================
// GENESIS — test/modules/v7911-kg-search-tfidf.contract.test.js
//
// v7.9.11: KG search uses TF-IDF + file-token-boost. Verified
// against Garrus's Win field-trace 2026-05-25 nodes.
// ============================================================

'use strict';

const { describe, test, assert, assertEqual, run } = require('../harness');
const { KnowledgeGraph } = require('../../src/agent/foundation/KnowledgeGraph');

function makeKG() {
  return new KnowledgeGraph({ storage: null });
}

function addNodes(kg, nodes) {
  for (const n of nodes) {
    const id = kg.addNode(n.type, n.label, n.properties);
    // Normalise accessed/accessCount so recency doesn't dominate ranking
    // assertions — we're testing content-match scoring, not freshness.
    const node = kg.graph.nodes.get(id);
    if (node) {
      node.accessed = Date.now();
      node.accessCount = 1;
    }
  }
}

describe('v7.9.11 — KG search TF-IDF + file-token-boost', () => {

  test('query with file token: nodes with matching properties.file rank first', () => {
    const kg = makeKG();
    addNodes(kg, [
      { type: 'idea', label: 'Introduce a daily-digest capability for reflection patterns',
        properties: { type: 'feature-idea' } },
      { type: 'insight', label: 'Reflect.js multi-source trigger logic',
        properties: { file: 'src/agent/autonomy/activities/Reflect.js' } },
      { type: 'insight', label: 'CognitiveWorkspace.js: reflection on architecture',
        properties: { file: 'src/agent/cognitive/CognitiveWorkspace.js' } },
    ]);

    const results = kg.search('Identify all references to Reflect.js in the codebase', 5);
    assert(results.length >= 2, `expected >=2 results, got ${results.length}`);
    assert(
      (results[0].node.properties.file || '').includes('Reflect.js'),
      `top result must reference Reflect.js, got "${results[0].node.label}" with file="${results[0].node.properties.file || 'NONE'}"`
    );
  });

  test('query with file token: nodes without file property and only generic-word match get demoted', () => {
    const kg = makeKG();
    addNodes(kg, [
      // Generic idea matching only via word "reflect"
      { type: 'idea', label: 'reflect on improving code quality',
        properties: { type: 'feature-idea' } },
      // Insight with explicit file reference
      { type: 'insight', label: 'analysis of Reflect.js triggers',
        properties: { file: 'src/agent/autonomy/activities/Reflect.js' } },
    ]);

    const results = kg.search('references to Reflect.js', 5);
    const genericRank = results.findIndex(r => r.node.type === 'idea');
    const fileRank = results.findIndex(r => (r.node.properties.file || '').includes('Reflect.js'));
    assert(fileRank < genericRank || genericRank === -1,
      `file-ref node should rank above generic idea (fileRank=${fileRank}, genericRank=${genericRank})`);
  });

  test('rare token outranks common token via IDF', () => {
    const kg = makeKG();
    addNodes(kg, [
      // Common word "test" appears in 4 nodes; rare "foobarbaz" in only 1
      { type: 'note', label: 'test of pattern A', properties: {} },
      { type: 'note', label: 'test of pattern B', properties: {} },
      { type: 'note', label: 'test of pattern C', properties: {} },
      { type: 'note', label: 'test of pattern D', properties: {} },
      { type: 'note', label: 'a unique foobarbaz observation', properties: {} },
    ]);

    const results = kg.search('test foobarbaz', 10);
    assert(results.length >= 1, 'has at least one result');
    // foobarbaz is rare (high IDF), should rank top
    assert(results[0].node.label.includes('foobarbaz'),
      `top result should match the rare token first; got "${results[0].node.label}"`);
  });

  test('query without file token: TF-IDF ranking, no file-boost active', () => {
    const kg = makeKG();
    addNodes(kg, [
      { type: 'note', label: 'discussion of concept X', properties: {} },
      { type: 'insight', label: 'unrelated note', properties: { file: 'src/foo.js' } },
    ]);

    const results = kg.search('discussion of concept', 5);
    assert(results.length >= 1, 'has results');
    assert(results[0].node.label.includes('concept'),
      'top result must match the query words, not the unrelated file-having node');
  });

  test('empty queryWords (only short words) preserves pre-fix recency-only behavior', () => {
    // Pre-fix v7.9.10 ran the outer for-loop over all nodes and scored
    // them by recency + connectivity + accessCount only when no query
    // word qualified (filter >2 chars dropped them all). My TF-IDF fix
    // must NOT change this — short-only queries still return all nodes
    // ranked by freshness.
    const kg = makeKG();
    addNodes(kg, [
      { type: 'note', label: 'something', properties: {} },
      { type: 'note', label: 'other', properties: {} },
    ]);
    const results = kg.search('a is to be', 5);
    assertEqual(results.length, 2, 'pre-fix behavior preserved: all nodes returned');
    // Scores should be roughly equal (~1.0 from recency) — not zero, not 10+
    for (const r of results) {
      assert(r.score > 0 && r.score < 5,
        `score should be in recency-only range (~1.0), got ${r.score}`);
    }
  });

});

if (require.main === module) run();
