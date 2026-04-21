// ============================================================
// Test: IntentRouter — conversational questions route to general (v7.3.3)
//
// Before v7.3.3 the intent patterns over-matched: any message containing
// the word "Ziel" or "Architektur" was classified as 'goals' or
// 'self-inspect' respectively, which triggered a template-dump handler
// instead of letting Genesis answer via the LLM.
//
// This test locks the new restricted patterns: conversational questions
// fall through to 'general' so Genesis can respond in his own words,
// while explicit imperatives still trigger the action handlers.
// ============================================================

'use strict';

const { describe, test, assert, run } = require('../harness');
const { IntentRouter } = require('../../src/agent/intelligence/IntentRouter');

// ── Questions about goals should NOT trigger the goals handler ──
describe('v7.3.3 — goals: conversational questions go to general', () => {
  const router = new IntentRouter();

  const conversationalQuestions = [
    'was sind deine ziele?',
    'welche ziele hast du?',
    'was ist dein ziel?',
    'worauf zielst du ab?',
    'hast du ein ziel im leben?',
    'what are your goals?',
    'what is your main goal?',
    'do you have any goals?',
    'tell me about your goals',
    // Meta-conversational (this is what triggered the bug in Garrus's screenshot)
    'möchtest du unterscheiden zwischen zielen?',
    'wie organisierst du deine ziele?',
    // Sentences that just happen to contain the word
    'ich erziele gute ergebnisse',  // "erziele" contains "ziel"
  ];

  for (const msg of conversationalQuestions) {
    test(`"${msg}" → general (not goals)`, () => {
      const result = router.classify(msg);
      assert(
        result.type !== 'goals',
        `Expected not-goals, got '${result.type}' (conf=${result.confidence}) — conversational questions must go to general`
      );
    });
  }
});

// ── Imperative goal commands SHOULD still trigger the goals handler ──
describe('v7.3.3 — goals: imperatives still route correctly', () => {
  const router = new IntentRouter();

  const imperatives = [
    'setze ein ziel: refactor X',
    'erstelle ein ziel: optimize performance',
    'lösche alle ziele',
    'cancel all goals',
    'abandon all goals',
    'lösche ziel 2',
    'cancel goal 1',
    'ziel hinzufügen: new task',
    'add goal: implement feature',
  ];

  for (const msg of imperatives) {
    test(`"${msg}" → goals`, () => {
      const result = router.classify(msg);
      assert(
        result.type === 'goals',
        `Expected goals, got '${result.type}' (conf=${result.confidence}) — imperatives must still reach the goals handler`
      );
    });
  }
});

// ── Questions about capabilities/architecture should NOT trigger self-inspect ──
describe('v7.3.3 — self-inspect: conversational questions go to general', () => {
  const router = new IntentRouter();

  const conversationalQuestions = [
    'was kannst du?',
    'was kannst du alles?',
    'welche fähigkeiten hast du?',
    'wie bist du aufgebaut?',
    'zeig mir deine architektur',     // ← this used to match but is conversational
    'erklär mir deine architektur',
    'was ist deine architektur?',
    'woraus bestehst du?',
    'stell dich vor',
    'what can you do?',
    'tell me about yourself',
    'what is your architecture?',
    'explain how you work',
  ];

  for (const msg of conversationalQuestions) {
    test(`"${msg}" → general (not self-inspect)`, () => {
      const result = router.classify(msg);
      assert(
        result.type !== 'self-inspect',
        `Expected not-self-inspect, got '${result.type}' (conf=${result.confidence}) — conversational questions must go to general for LLM response`
      );
    });
  }
});

// ── v7.3.6 #1: Slash-Discipline — module-listing imperatives must now
//    fall through to general; slash commands take their place.
//    The tests below are the v7.3.3-imperatives inverted: what previously
//    had to trigger self-inspect now must NOT trigger it.
describe('v7.3.6 — self-inspect: imperatives fall through to general (slash-only)', () => {
  const router = new IntentRouter();

  const formerImperatives = [
    'zeig mir deine module',
    'liste alle module auf',
    'nenn mir die module',
    'show me the modules',
    'list all modules',
    'welche module hast du?',
    'zeig mir den quellcode',
    'show me the source files',
  ];

  for (const msg of formerImperatives) {
    test(`"${msg}" → NOT self-inspect (v7.3.6 slash-discipline)`, () => {
      const result = router.classify(msg);
      assert(
        result.type !== 'self-inspect',
        `Expected not-self-inspect, got '${result.type}' — v7.3.6 makes self-inspect slash-only`
      );
    });
  }
});

run();
