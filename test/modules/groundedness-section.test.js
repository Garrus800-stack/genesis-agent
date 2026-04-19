// ============================================================
// Test: PromptBuilder groundedness section (v7.3.3)
//
// The groundedness section is an anti-escalation guardrail that
// activates only for the 'general' intent — i.e. conversational
// responses. For explicit task intents (agent-goal, self-modify,
// self-repair, etc.) Genesis is allowed to plan multi-step work.
//
// What it prevents:
//  1. Halluzinierte TypeScript-Pfade (the real code is .js)
//  2. Escalation of conversational questions into multi-step plans
//  3. Invented module paths
//
// What it does NOT touch:
//  - Imperative task messages — those get a normal prompt without
//    the guardrails, so Genesis can plan freely when asked to.
// ============================================================

'use strict';

const { describe, test, assert, assertIncludes, run } = require('../harness');
const { PromptBuilder } = require('../../src/agent/intelligence/PromptBuilder');

function makeBuilder() {
  // Minimal PromptBuilder — only needs _currentIntent + method access
  return new PromptBuilder({
    model: { activeModel: 'mock' },
    lang: { get: () => 'en', t: (k) => k },
  });
}

describe('v7.3.3 — groundedness section: activates only for general intent', () => {
  test('returns non-empty content for general intent', () => {
    const pb = makeBuilder();
    pb.setIntent('general');
    const out = pb._groundednessContext();
    assert(out.length > 0, 'should return content for general intent');
    assertIncludes(out, 'GROUNDEDNESS', 'should be clearly labeled');
  });

  test('returns empty string for agent-goal intent', () => {
    const pb = makeBuilder();
    pb.setIntent('agent-goal');
    const out = pb._groundednessContext();
    assert(out === '', `expected empty for agent-goal, got "${out.slice(0, 40)}..."`);
  });

  test('returns empty string for self-modify intent', () => {
    const pb = makeBuilder();
    pb.setIntent('self-modify');
    const out = pb._groundednessContext();
    assert(out === '', 'expected empty for self-modify');
  });

  test('returns empty string for self-repair intent', () => {
    const pb = makeBuilder();
    pb.setIntent('self-repair');
    const out = pb._groundednessContext();
    assert(out === '', 'expected empty for self-repair');
  });

  test('returns empty string for goals intent (imperative)', () => {
    const pb = makeBuilder();
    pb.setIntent('goals');
    const out = pb._groundednessContext();
    assert(out === '', 'expected empty for goals imperative');
  });

  test('returns empty string for self-inspect intent', () => {
    const pb = makeBuilder();
    pb.setIntent('self-inspect');
    const out = pb._groundednessContext();
    assert(out === '', 'expected empty for self-inspect');
  });
});

describe('v7.3.3 — groundedness section: content correctness', () => {
  test('names the JavaScript-not-TypeScript rule explicitly', () => {
    const pb = makeBuilder();
    pb.setIntent('general');
    const out = pb._groundednessContext();
    assertIncludes(out, 'JavaScript', 'should mention JavaScript explicitly');
    assertIncludes(out, '.ts files', 'should name .ts files as non-existent');
  });

  test('prohibits escalating questions into plans', () => {
    const pb = makeBuilder();
    pb.setIntent('general');
    const out = pb._groundednessContext();
    assertIncludes(out, 'answer with words', 'should say answer with words, not plan');
    assertIncludes(out, 'question', 'should address questions as a distinct case');
  });

  test('allows escalation when user explicitly gives a task', () => {
    const pb = makeBuilder();
    pb.setIntent('general');
    const out = pb._groundednessContext();
    // The rule should NOT be absolute — it should say "only escalate when..."
    assertIncludes(out, 'Only escalate', 'should permit escalation conditionally');
    assertIncludes(out, 'explicitly', 'should require explicitness');
  });

  test('warns against inventing file paths', () => {
    const pb = makeBuilder();
    pb.setIntent('general');
    const out = pb._groundednessContext();
    assertIncludes(out, 'paths that actually exist', 'should require real paths');
  });
});

describe('v7.3.3 — groundedness section: integration with prompt build', () => {
  test('build output includes groundedness when intent=general', () => {
    const pb = makeBuilder();
    pb.setIntent('general');
    const built = pb.build();
    assertIncludes(built, 'GROUNDEDNESS', 'full prompt should contain the section');
  });

  test('build output does NOT include groundedness when intent=agent-goal', () => {
    const pb = makeBuilder();
    pb.setIntent('agent-goal');
    const built = pb.build();
    assert(
      !built.includes('GROUNDEDNESS RULES'),
      'full prompt should NOT contain groundedness for agent-goal'
    );
  });

  test('build output does NOT include groundedness when no intent set (fallback=general, so actually YES)', () => {
    // When no intent is set, _currentIntent defaults to 'general' in the constructor.
    // So the groundedness section SHOULD appear.
    const pb = makeBuilder();
    const built = pb.build();
    assertIncludes(built, 'GROUNDEDNESS', 'default intent is general, so section appears');
  });
});

run();
