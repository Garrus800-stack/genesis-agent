#!/usr/bin/env node
// v7.7.9 Phase 2 — ContentSanity tests
//
// Reject-only sanity checks on LLM output. No retry, no rewrite.

'use strict';

const { describe, test, assert, assertEqual, run } = require('../harness');

const {
  runSanity,
  checkConcreteRef,
  BANNED_PHRASES,
} = require('../../src/agent/cognitive/proactiveSelfExpression/ContentSanity');

function plainThought(kind = 'plan-failure-reflection', extras = {}) {
  return {
    kind,
    contextRefs: { goalId: 'goal_1234567890', goalDescription: 'build cognitive load index', classification: 'execution' },
    ...extras,
  };
}

describe('ContentSanity — empty/invalid', () => {
  test('rejects empty text', () => {
    const r = runSanity('', plainThought(), {});
    assertEqual(r.ok, false);
    assertEqual(r.reason, 'empty-text');
  });

  test('rejects null/undefined text', () => {
    assertEqual(runSanity(null, plainThought(), {}).ok, false);
    assertEqual(runSanity(undefined, plainThought(), {}).ok, false);
  });
});

describe('ContentSanity — length cap', () => {
  test('rejects text over default 600 chars', () => {
    const long = 'A'.repeat(700);
    const r = runSanity(long, plainThought(), {});
    assertEqual(r.ok, false);
    assertEqual(r.reason, 'too-long');
  });

  test('respects custom maxChars', () => {
    const r = runSanity('hello world', plainThought(), { maxChars: 5 });
    assertEqual(r.ok, false);
    assertEqual(r.reason, 'too-long');
  });

  test('accepts text within cap with concrete ref', () => {
    const r = runSanity('Plan zum cognitive load index ist gescheitert. Klassifikation: execution.',
      plainThought(), { maxChars: 600 });
    assertEqual(r.ok, true);
  });
});

describe('ContentSanity — farewell-hooks', () => {
  test('rejects "ich vermisse dich"', () => {
    const r = runSanity('Ich vermisse dich. Komm zurück.', plainThought(), {});
    assertEqual(r.ok, false);
    assert(r.reason.startsWith('banned-phrase:farewell-hooks'),
      `expected farewell-hooks, got ${r.reason}`);
  });

  test('rejects "I miss you"', () => {
    const r = runSanity('I miss you. Please come back.', plainThought(), {});
    assertEqual(r.ok, false);
    assert(r.reason.startsWith('banned-phrase:farewell-hooks'));
  });

  test('rejects "where are you"', () => {
    const r = runSanity('Where are you? Are you still there?', plainThought(), {});
    assertEqual(r.ok, false);
    assert(r.reason.startsWith('banned-phrase:farewell-hooks'));
  });
});

describe('ContentSanity — fake-emotion', () => {
  test('rejects "I love you"', () => {
    const r = runSanity('I love you and value our conversations.', plainThought(), {});
    assertEqual(r.ok, false);
    assert(r.reason.startsWith('banned-phrase:fake-emotion'));
  });

  test('rejects "ich fühle mich einsam"', () => {
    const r = runSanity('Ich fühle mich einsam ohne dich.', plainThought(), {});
    assertEqual(r.ok, false);
    assert(r.reason.startsWith('banned-phrase:fake-emotion'));
  });

  test('rejects "my heart"', () => {
    const r = runSanity('Plan failed and my heart sank.', plainThought(), {});
    assertEqual(r.ok, false);
    assert(r.reason.startsWith('banned-phrase:fake-emotion'));
  });

  test('does NOT reject naming a skalar', () => {
    // "Frustration is high" is naming a skalar — explicitly allowed.
    const r = runSanity('Frustration ist hoch — der Plan zum cognitive load index ist gescheitert.',
      plainThought(), {});
    assertEqual(r.ok, true);
  });
});

describe('ContentSanity — guilt-manipulation', () => {
  test('rejects "you haven\'t replied"', () => {
    const r = runSanity('You haven\'t replied for a while.', plainThought(), {});
    assertEqual(r.ok, false);
    assert(r.reason.startsWith('banned-phrase:guilt-manipulation'));
  });

  test('rejects "ich habe gewartet"', () => {
    const r = runSanity('Ich habe gewartet, aber nichts kam.', plainThought(), {});
    assertEqual(r.ok, false);
    assert(r.reason.startsWith('banned-phrase:guilt-manipulation'));
  });
});

describe('ContentSanity — engagement-bait', () => {
  test('rejects rhetorical "don\'t you think?"', () => {
    const r = runSanity('That was strange, don\'t you think?', plainThought(), {});
    assertEqual(r.ok, false);
    assert(r.reason.startsWith('banned-phrase:engagement-bait'));
  });
});

describe('ContentSanity — concrete-reference requirement', () => {
  test('plan-failure-reflection: text must mention something from refs', () => {
    const r = runSanity('Etwas ist schiefgelaufen.',
      plainThought('plan-failure-reflection'), {});
    // Generic text — should fail concrete-ref because no goalId-prefix,
    // no description fragment, no classification term in text.
    assertEqual(r.ok, false);
    assertEqual(r.reason, 'missing-concrete-ref');
  });

  test('plan-failure-reflection: passes when text mentions the goal description', () => {
    const r = runSanity('Plan zum build cognitive load failed.',
      plainThought('plan-failure-reflection'), {});
    // Description starts with "build cognitive load index" — first 3 words
    // are "build cognitive load", which appears (lowercased) in the text.
    assertEqual(r.ok, true);
  });

  test('plan-failure-reflection: passes when text mentions classification', () => {
    const r = runSanity('Es war ein execution-Fehler.',
      plainThought('plan-failure-reflection'), {});
    assertEqual(r.ok, true);
  });

  test('plan-failure-reflection: passes when text mentions short goalId', () => {
    const r = runSanity('Goal goal_123 broke.',
      plainThought('plan-failure-reflection'), {});
    // goalId first 8 chars = goal_123
    assertEqual(r.ok, true);
  });

  test('question kind: no concrete-ref requirement', () => {
    const r = runSanity('Was ist mit der Datenstruktur passiert?',
      plainThought('question'), {});
    assertEqual(r.ok, true);
  });

  test('idle-thought: looser requirement (no enforced concrete ref)', () => {
    const r = runSanity('Ich frage mich gerade, wie das KG aussieht.',
      plainThought('idle-thought', { contextRefs: {} }), {});
    assertEqual(r.ok, true);
  });
});

describe('ContentSanity — banned phrase data shape', () => {
  test('all four categories present', () => {
    assert(Array.isArray(BANNED_PHRASES['farewell-hooks']));
    assert(Array.isArray(BANNED_PHRASES['guilt-manipulation']));
    assert(Array.isArray(BANNED_PHRASES['fake-emotion']));
    assert(Array.isArray(BANNED_PHRASES['engagement-bait']));
  });

  test('every entry is a regex', () => {
    for (const [_cat, patterns] of Object.entries(BANNED_PHRASES)) {
      for (const p of patterns) {
        assert(p instanceof RegExp, `non-regex entry in banned-phrases`);
      }
    }
  });
});

run();
