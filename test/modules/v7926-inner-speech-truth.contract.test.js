// ============================================================
// GENESIS — test/modules/v7926-inner-speech-truth.contract.test.js
// Contract test for v7.9.26 inner-speech truthfulness:
//   • recordReflection no longer writes the "I gave up" self-statement
//     on a per-attempt failure — it keeps only the lesson write. The
//     self-statement fired before GoalDriver decided to pause/retry/abandon,
//     so Genesis told itself it had given up on goals it was still pursuing.
//   • Terminal-outcome narration writes the truthful self-statement on the
//     real lifecycle events: goal:abandoned → "gave up on", goal:stalled →
//     "stalled on", goal:obsolete → "marked … obsolete".
//   • InnerSpeech receives the same truthful thought.
// ============================================================

'use strict';

const { describe, test, assert, assertEqual, run } = require('../harness');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const {
  recordReflection,
  wireGoalOutcomeNarration,
} = require(path.join(ROOT, 'src/agent/revolution/AgentLoopPursuitReflection'));

function captureLog() {
  const appended = [];
  return { appended, log: { append: (entry) => appended.push(entry) } };
}
function captureLessons() {
  const recorded = [];
  return { recorded, store: { record: (l) => recorded.push(l) } };
}
function captureInnerSpeech() {
  const emitted = [];
  return { emitted, is: { emit: (text, kind, meta) => emitted.push({ text, kind, meta }) } };
}
function mockBus() {
  const handlers = {};
  return {
    fire: (name, payload) => (handlers[name] || []).forEach((h) => h(payload)),
    bus: { on: (name, fn) => { (handlers[name] = handlers[name] || []).push(fn); return () => {}; } },
  };
}

describe('v7.9.26 inner-speech truth — decoupled reflection + terminal narration', () => {

  test('recordReflection keeps the lesson but no longer writes "I gave up"', () => {
    const ss = captureLog();
    const ls = captureLessons();
    recordReflection(
      { lessonsStore: ls.store, selfStatementLog: ss.log },
      { goalDescription: 'do the thing', classification: 'execution', errorMessage: 'boom', stepsExecuted: 1 }
    );
    assertEqual(ss.appended.length, 0, 'no per-attempt self-statement written');
    assertEqual(ls.recorded.length, 1, 'the lesson is still recorded');
    assertEqual(ls.recorded[0].category, 'obstacle-resolution', 'lesson category preserved');
  });

  test('goal:abandoned narrates "gave up on" (truthful terminal outcome)', () => {
    const ss = captureLog();
    const is = captureInnerSpeech();
    const m = mockBus();
    wireGoalOutcomeNarration(m.bus, { selfStatementLog: ss.log, innerSpeech: is.is });

    m.fire('goal:abandoned', { id: 'g1', reason: 'Global timeout (600000ms)' });

    assertEqual(ss.appended.length, 1, 'one self-statement on abandonment');
    assertEqual(ss.appended[0].kind, 'goal-abandoned');
    assert(ss.appended[0].text.includes('gave up on the goal'), 'says "gave up on"');
    assert(ss.appended[0].text.includes('Global timeout'), 'includes the reason');
    assert(!ss.appended[0].text.toLowerCase().includes('stalled'), 'not mislabelled as stalled');
    assertEqual(is.emitted.length, 1, 'InnerSpeech also receives the thought');
    assertEqual(is.emitted[0].kind, 'goal-abandoned');
  });

  test('goal:stalled and goal:obsolete narrate their own truthful outcomes', () => {
    const ss = captureLog();
    const m = mockBus();
    wireGoalOutcomeNarration(m.bus, { selfStatementLog: ss.log });

    m.fire('goal:stalled', { id: 'g2', description: 'build the parser', reason: '3 consecutive failures' });
    m.fire('goal:obsolete', { id: 'g3', description: 'old feature', reason: 'no longer relevant' });

    assertEqual(ss.appended.length, 2, 'one statement per terminal event');

    const stalled = ss.appended.find((e) => e.kind === 'goal-stalled');
    assert(stalled, 'stalled statement present');
    assert(stalled.text.includes('stalled on the goal "build the parser"'), 'stalled text + description');

    const obsolete = ss.appended.find((e) => e.kind === 'goal-obsolete');
    assert(obsolete, 'obsolete statement present');
    assert(obsolete.text.includes('marked the goal "old feature" obsolete'), 'obsolete text reads naturally');
  });

  test('a paused/retried failure produces no terminal statement (only real outcomes do)', () => {
    const ss = captureLog();
    const m = mockBus();
    wireGoalOutcomeNarration(m.bus, { selfStatementLog: ss.log });
    // A pursuit attempt failing fires no terminal event — GoalDriver pauses/retries.
    // No goal:abandoned/stalled/obsolete here → nothing narrated.
    assertEqual(ss.appended.length, 0, 'silence until a real terminal outcome');
  });

});

run();
