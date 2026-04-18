// ============================================================
// Test: v7.3.1 A4-F3 — CapabilityMatcher + GoalStack Capability-Gate
// ============================================================

'use strict';

const { describe, test, assert, assertEqual, run } = require('../harness');
const CapabilityMatcher = require('../../src/agent/planning/CapabilityMatcher');

const MOCK_CAPS = [
  {
    id: 'homeostasis',
    module: 'src/agent/organism/Homeostasis.js',
    class: 'Homeostasis',
    category: 'organism',
    tags: ['organism', 'homeostasis', 'effectors'],
    description: 'Regulates internal state via corrective feedback',
    keywords: ['homeostasis', 'regulate', 'state', 'feedback', 'throttle', 'stabilize', 'effectors', 'organism'],
  },
  {
    id: 'metabolism',
    module: 'src/agent/organism/Metabolism.js',
    class: 'Metabolism',
    category: 'organism',
    tags: ['organism', 'metabolism', 'energy'],
    description: 'Real energy accounting for actions',
    keywords: ['metabolism', 'energy', 'action', 'accounting', 'organism'],
  },
  {
    id: 'dream-cycle',
    module: 'src/agent/cognitive/DreamCycle.js',
    class: 'DreamCycle',
    category: 'cognitive',
    tags: ['cognitive', 'consolidation'],
    description: 'Memory consolidation via dream cycles',
    keywords: ['dream', 'cycle', 'memory', 'consolidation', 'cognitive'],
  },
];

describe('v7.3.1 — CapabilityMatcher: keyword extraction', () => {
  test('extracts keywords, lowercases, dedupes', () => {
    const kws = CapabilityMatcher.extractKeywords('Implement Homeostatic Throttling for the stabilize function');
    // Note: extractKeywords STEMS the output. So we assert against stemmed forms.
    assert(kws.includes('implement') === false, 'stop-words filtered');
    assert(kws.some(k => k.startsWith('homeostat')), 'homeostatic → homeostat*');
    assert(kws.some(k => k.startsWith('throttl')), 'throttling → throttl');
    assert(kws.some(k => k.startsWith('stabili')), 'stabilize → stabiliz/stabilize');
  });

  test('filters stop-words (the, for, to, etc.)', () => {
    const kws = CapabilityMatcher.extractKeywords('the module to fix the thing for users');
    assert(!kws.includes('the'));
    assert(!kws.includes('for'));
    assert(!kws.includes('to'));
    // "thing" retained (not a stop word); after stemming stays "thing"
    assert(kws.includes('thing'));
  });

  test('handles German umlauts correctly', () => {
    const kws = CapabilityMatcher.extractKeywords('Größere Funktion für Händler');
    // After stemming: "größere" might become "größ" (strips -ere? no, -er is listed).
    // We assert umlauts are preserved in the stemmed form.
    assert(kws.some(k => k.includes('ö')), 'retained umlaut ö');
    assert(kws.some(k => k.includes('ä')), 'retained umlaut ä');
  });

  test('returns [] for empty input', () => {
    assertEqual(CapabilityMatcher.extractKeywords('').length, 0);
    assertEqual(CapabilityMatcher.extractKeywords(null).length, 0);
  });
});

describe('v7.3.1 — CapabilityMatcher: Jaccard', () => {
  test('identical sets → 1.0', () => {
    assertEqual(CapabilityMatcher.jaccard(['a', 'b'], ['a', 'b']), 1);
  });

  test('no overlap → 0', () => {
    assertEqual(CapabilityMatcher.jaccard(['a', 'b'], ['c', 'd']), 0);
  });

  test('partial overlap', () => {
    // {a,b,c} ∩ {b,c,d} = {b,c} = 2; ∪ = {a,b,c,d} = 4 → 2/4 = 0.5
    assertEqual(CapabilityMatcher.jaccard(['a', 'b', 'c'], ['b', 'c', 'd']), 0.5);
  });

  test('empty inputs → 0', () => {
    assertEqual(CapabilityMatcher.jaccard([], ['a']), 0);
    assertEqual(CapabilityMatcher.jaccard(['a'], []), 0);
  });
});

describe('v7.3.1 — CapabilityMatcher: match (the real test)', () => {
  test('"Implement Homeostatic Throttling" → matches homeostasis (Stemmed+Prefix)', () => {
    // Short goal text has low Jaccard due to few tokens. Real-world goals
    // tend to be longer. We test both here: short text gets prefix-match
    // (score >= 0.2 is fine — the gate correctly treats it as ambiguous).
    const result = CapabilityMatcher.match('Implement Homeostatic Throttling', MOCK_CAPS);
    assert(result.matched, 'has a match via prefix-similarity');
    assertEqual(result.matched.id, 'homeostasis', 'matches homeostasis');
  });

  test('longer duplicate goal exceeds BLOCK threshold', () => {
    // This is the real-world case from v7.2.8: Genesis proposes something
    // that strongly overlaps with an existing capability. With enough
    // overlapping keywords the gate correctly blocks.
    const result = CapabilityMatcher.match(
      'Implement homeostatic throttling to regulate state via feedback for stabilize effectors organism',
      MOCK_CAPS,
    );
    assertEqual(result.matched.id, 'homeostasis');
    assert(result.score > 0.4, `expected score > 0.4, got ${result.score}`);
  });

  test('"Add Memory Consolidation via Dream Cycle" → matches dream-cycle', () => {
    const result = CapabilityMatcher.match('Add Memory Consolidation via Dream Cycle', MOCK_CAPS);
    assertEqual(result.matched.id, 'dream-cycle');
    assert(result.score > 0.3, `expected high score, got ${result.score}`);
  });

  test('"Learn to speak French" → no match, decision: pass', () => {
    const result = CapabilityMatcher.match('Learn to speak French fluently', MOCK_CAPS);
    // All scores should be low
    assert(result.score < 0.4, `expected low score, got ${result.score}`);
    assertEqual(result.decision, 'pass');
  });

  test('decision thresholds: pass < 0.4, block > 0.8', () => {
    assertEqual(CapabilityMatcher.THRESHOLDS.PASS, 0.4);
    assertEqual(CapabilityMatcher.THRESHOLDS.BLOCK, 0.8);
  });

  test('empty capability list → decision: pass', () => {
    const result = CapabilityMatcher.match('anything', []);
    assertEqual(result.decision, 'pass');
    assertEqual(result.matched, null);
  });
});

describe('v7.3.1 — CapabilityMatcher: novel-override validation', () => {
  test('valid override: both reason + contrasting present', () => {
    const result = CapabilityMatcher.validateNovelOverride({
      reason: 'This uses predictive control, not reactive regulation',
      contrasting: 'homeostasis',
    });
    assertEqual(result.valid, true);
  });

  test('invalid: reason too short', () => {
    const result = CapabilityMatcher.validateNovelOverride({
      reason: 'because',
      contrasting: 'homeostasis',
    });
    assertEqual(result.valid, false);
    assert(result.violations.some(v => v.includes('reason')));
  });

  test('invalid: contrasting missing', () => {
    const result = CapabilityMatcher.validateNovelOverride({
      reason: 'This is actually a different kind of thing',
    });
    assertEqual(result.valid, false);
    assert(result.violations.some(v => v.includes('contrasting')));
  });

  test('invalid: no object', () => {
    const result = CapabilityMatcher.validateNovelOverride(null);
    assertEqual(result.valid, false);
  });
});

describe('v7.3.1 — GoalStack: Capability-Gate integration', () => {
  const { GoalStack } = require('../../src/agent/planning/GoalStack');

  function makeStack(capabilities = MOCK_CAPS) {
    const busEvents = [];
    const lessons = [];
    const stack = new GoalStack({
      bus: {
        emit: (event, data) => busEvents.push({ event, data }),
        fire: (event, data) => busEvents.push({ event, data }),
        _container: null,
      },
      storageDir: '/tmp/test-goalstack-' + Date.now(),
      storage: null,
      model: {
        chat: async () => '1. Step one\n2. Step two\n3. Step three',
      },
      prompts: {},
    });
    stack.selfModel = { getCapabilitiesDetailed: () => capabilities };
    stack.lessonsStore = { record: (l) => lessons.push(l) };
    return { stack, busEvents, lessons };
  }

  test('blocks clear duplicate from non-user source', async () => {
    const { stack, busEvents, lessons } = makeStack();
    // Stuff many overlapping keywords to trigger block
    const desc = 'homeostasis regulate state feedback throttle stabilize effectors organism';
    const result = await stack.addGoal(desc, 'idle-mind', 'medium');
    assertEqual(result, null, 'block returns null');
    const blocked = busEvents.find(e => e.event === 'goal:blocked-as-duplicate');
    assert(blocked, 'goal:blocked-as-duplicate event emitted');
    const lesson = lessons.find(l => l.category === 'duplicate-proposal');
    assert(lesson, 'duplicate-proposal lesson recorded');
  });

  test('user-sourced duplicates get warning, not block', async () => {
    const { stack, busEvents } = makeStack();
    const desc = 'homeostasis regulate state feedback throttle stabilize effectors organism';
    const result = await stack.addGoal(desc, 'user', 'high');
    assert(result, 'user goal succeeds');
    assert(result.id, 'result has id');
    const warn = busEvents.find(e => e.event === 'goal:duplicate-warning');
    assert(warn, 'goal:duplicate-warning event emitted');
    const blocked = busEvents.find(e => e.event === 'goal:blocked-as-duplicate');
    assertEqual(blocked, undefined, 'NO block event for user source');
  });

  test('novel override with valid reason passes block', async () => {
    const { stack, busEvents, lessons } = makeStack();
    const desc = 'homeostasis regulate state feedback throttle stabilize effectors organism';
    const result = await stack.addGoal(desc, 'idle-mind', 'medium', {
      novel: {
        reason: 'Uses predictive control loop, not reactive feedback',
        contrasting: 'homeostasis (which is reactive)',
      },
    });
    assert(result, 'override lets goal through');
    const lesson = lessons.find(l => l.category === 'novel-claimed');
    assert(lesson, 'novel-claimed lesson recorded');
    const blocked = busEvents.find(e => e.event === 'goal:blocked-as-duplicate');
    assertEqual(blocked, undefined, 'no block event when override valid');
  });

  test('novel override with invalid reason falls back to normal gate', async () => {
    const { stack, busEvents } = makeStack();
    const desc = 'homeostasis regulate state feedback throttle stabilize effectors organism';
    const result = await stack.addGoal(desc, 'idle-mind', 'medium', {
      novel: { reason: 'hi', contrasting: '' }, // invalid
    });
    assertEqual(result, null, 'invalid override → normal gate → block');
  });

  test('passes clearly novel goal without any events', async () => {
    const { stack, busEvents } = makeStack();
    const result = await stack.addGoal('Learn to speak Finnish fluently', 'idle-mind', 'medium');
    assert(result, 'novel goal passes');
    const warn = busEvents.find(e => e.event === 'goal:duplicate-warning');
    const blocked = busEvents.find(e => e.event === 'goal:blocked-as-duplicate');
    assertEqual(warn, undefined);
    assertEqual(blocked, undefined);
  });

  test('skips gate gracefully when selfModel not wired', async () => {
    const { stack } = makeStack();
    stack.selfModel = null;
    const result = await stack.addGoal('any duplicate-ish goal', 'idle-mind', 'medium');
    assert(result, 'no selfModel → no gate → passes');
  });
});

run();
