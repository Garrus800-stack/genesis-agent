// ============================================================
// GENESIS — test/modules/v7926-affect-failure-events.contract.test.js
// Contract test for v7.9.26 EmotionalState wiring:
//   • Operational failure events (goal:abandoned / goal:stalled /
//     goal:obsolete / llm:continuation-failed) raise frustration —
//     they were previously absent from the reactivity map.
//   • A budget cap (llm:cost-cap-reached) gives a milder bump.
//   • Repeated failures register but stay moderate (no runaway to max).
//   • The events are wired into the reactivity map the constructor builds.
// ============================================================

'use strict';

const { describe, test, assert, assertEqual, run } = require('../harness');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const { EmotionalState } = require(path.join(ROOT, 'src/agent/organism/EmotionalState'));

function fresh() {
  // bus → NullBus default, no storage, no intervals (no timers started)
  return new EmotionalState({});
}

// Reactivity handlers are arrow functions bound to the instance; calling one
// directly exercises the exact path _wireEvents subscribes to the bus.
function fire(inst, event, data) {
  const handler = inst._reactivity[event];
  assert(typeof handler === 'function', `event ${event} is wired into the reactivity map`);
  handler(data || {});
}

describe('v7.9.26 EmotionalState — operational failures register in affect', () => {

  test('goal:abandoned raises frustration and costs energy', () => {
    const e = fresh();
    assertEqual(e.getState().frustration, 0.1, 'baseline frustration');
    fire(e, 'goal:abandoned');
    assertEqual(e.getState().frustration, 0.16, 'frustration rose by 0.06');
    assertEqual(e.getState().energy, 0.77, 'energy dropped by 0.03');
  });

  test('goal:stalled, goal:obsolete and llm:continuation-failed each register', () => {
    let e = fresh();
    fire(e, 'goal:stalled');
    assertEqual(e.getState().frustration, 0.15, 'stalled +0.05');

    e = fresh();
    fire(e, 'goal:obsolete');
    assertEqual(e.getState().frustration, 0.14, 'obsolete +0.04');

    e = fresh();
    fire(e, 'llm:continuation-failed');
    assertEqual(e.getState().frustration, 0.15, 'continuation-failed +0.05');
  });

  test('llm:cost-cap-reached is a milder thwarting', () => {
    const e = fresh();
    fire(e, 'llm:cost-cap-reached');
    assertEqual(e.getState().frustration, 0.13, 'cost-cap +0.03 (milder than a failure)');
  });

  test('repeated failures register but stay moderate (no runaway to max)', () => {
    const e = fresh();
    for (let i = 0; i < 3; i++) fire(e, 'goal:abandoned');
    const f = e.getState().frustration;
    assert(f > 0.2, `frustration is clearly elevated (got ${f})`);
    assert(f < 0.5, `frustration stays moderate, not maxed (got ${f})`);
    assert(f < e.dimensions.frustration.max, 'well below the ceiling');
  });

});

run();
