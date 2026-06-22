#!/usr/bin/env node
// Test: Ideate near-duplicate guard — P5 (v7.9.25)
// - recent ideas are fed back into the prompt
// - a fresh idea too close (TF-IDF cosine >= 0.40) to a recent one triggers ONE
//   retry; a distinct retry is kept, a still-close retry keeps the first idea
const { describe, test, assert, assertEqual, run } = require('../harness');
const ideate = require('../../src/agent/autonomy/activities/Ideate');

// Strings verified against the real tfidf module:
//   NEAR ~ RECENT = 0.745 (>= 0.40),  DISTINCT ~ RECENT = 0.000 (< 0.40)
const RECENT = 'Personalized Learning Pathway Generator that builds learning paths';
const NEAR = 'Personalized Learning Path Generator that builds learning routes';
const DISTINCT = 'Distributed cache invalidation across edge nodes with TTL handling';

function mockIdleMind(responses, recentLabels = [RECENT]) {
  const calls = [];
  const added = [];
  let i = 0;
  return {
    selfModel: { getCapabilities: () => [] },
    memory: { getFactContext: () => '' },
    kg: {
      getNodesByType: (type) => type === 'idea'
        ? recentLabels.map((label, idx) => ({ label, created: idx }))
        : [],
      addNode: (type, label, props) => { added.push({ type, label, props }); },
    },
    model: { chat: async (prompt) => { calls.push(prompt); return responses[i++]; } },
    _calls: calls,
    _added: added,
  };
}

describe('Ideate P5 — near-duplicate guard', () => {

  test('recent ideas are injected into the brainstorming prompt', async () => {
    const m = mockIdleMind([DISTINCT]);
    await ideate.run(m);
    assert(m._calls[0].includes('Personalized Learning Pathway Generator'),
      'recent idea label appears in the prompt');
  });

  test('a near-duplicate triggers a retry; a distinct retry is kept', async () => {
    const m = mockIdleMind([NEAR, DISTINCT]);
    const out = await ideate.run(m);
    assertEqual(m._calls.length, 2, 'retried exactly once');
    assertEqual(out, DISTINCT, 'distinct retry is returned');
    assertEqual(m._added[0].label, DISTINCT, 'distinct retry is the stored idea');
  });

  test('a distinct first idea is kept without a retry', async () => {
    const m = mockIdleMind([DISTINCT]);
    const out = await ideate.run(m);
    assertEqual(m._calls.length, 1, 'no retry for a distinct idea');
    assertEqual(out, DISTINCT, 'first idea returned');
    assertEqual(m._added[0].label, DISTINCT, 'first idea stored');
  });

  test('if the retry is also a near-duplicate, the first idea is kept (no loop)', async () => {
    const m = mockIdleMind([NEAR, NEAR]);
    const out = await ideate.run(m);
    assertEqual(m._calls.length, 2, 'retried once, then stopped');
    assertEqual(out, NEAR, 'first idea kept when retry still too similar');
    assertEqual(m._added[0].label, NEAR, 'first idea stored');
  });

  test('with no recent ideas there is no similarity check', async () => {
    const m = mockIdleMind([NEAR], []);
    const out = await ideate.run(m);
    assertEqual(m._calls.length, 1, 'single call when nothing to compare against');
    assertEqual(out, NEAR, 'idea stored as-is');
  });
});

run();
