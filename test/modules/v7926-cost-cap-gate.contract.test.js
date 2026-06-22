// ============================================================
// GENESIS — test/modules/v7926-cost-cap-gate.contract.test.js
// Contract test for v7.9.26 budget-cap handling:
//   • GoalDriver suspends autonomous pursuit on llm:cost-cap-reached
//     (the cap signal was previously fired by CostGuard but consumed
//     by no one, so a capped goal re-picked every 60s).
//   • A budget reset lifts the gate and resumes pursuit.
//   • CostGuard now fires the reset events its recovery contract needs:
//     resetSession → llm:budget-manual-reset, daily rollover →
//     llm:budget-auto-reset.
// ============================================================

'use strict';

const { describe, test, assert, assertEqual, run } = require('../harness');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const { GoalDriver } = require(path.join(ROOT, 'src/agent/agency/GoalDriver'));
const { CostGuard } = require(path.join(ROOT, 'src/agent/ports/CostGuard'));

function mockBus() {
  const fired = [];
  return {
    fired,
    bus: {
      on: () => () => {},                 // returns an unsubscribe fn
      emit: () => {},
      fire: (name, payload) => fired.push({ name, payload }),
    },
  };
}

describe('v7.9.26 cost-cap gate + CostGuard reset signals', () => {

  test('GoalDriver suspends pursuit while budget-capped, resumes on reset', () => {
    const { bus } = mockBus();
    const gd = new GoalDriver({ bus, goalStack: {}, settings: {} });

    // Put the driver in a state where _scanAndMaybePursue can reach selection.
    gd._running = true;
    gd._bootPickupHandled = true;
    gd.agentLoop = {};
    let selectCalled = 0;
    gd._selectNext = () => { selectCalled++; return null; }; // null → no real pursuit

    // Baseline: not capped → scan reaches the selection step.
    gd._scanAndMaybePursue();
    assertEqual(selectCalled, 1, 'scan proceeds when not capped');

    // Cap reached → gate engages, scan returns before selection.
    gd._onBudgetCapped({ scope: 'session' });
    assertEqual(gd._budgetCapped, true, 'gate engaged on cost-cap-reached');
    gd._scanAndMaybePursue();
    assertEqual(selectCalled, 1, 'pursuit suspended while capped — no new selection');

    // Budget reset → gate lifts and pursuit resumes (even with no paused goals).
    gd._onBudgetReset('auto');
    assertEqual(gd._budgetCapped, false, 'gate lifted on reset');
    assertEqual(selectCalled, 2, 'reset resumes pursuit');
  });

  test('a second cap signal while already capped does not double-engage', () => {
    const { bus } = mockBus();
    const gd = new GoalDriver({ bus, goalStack: {}, settings: {} });
    gd._running = true;
    gd._onBudgetCapped({ scope: 'session' });
    gd._onBudgetCapped({ scope: 'daily' }); // idempotent
    assertEqual(gd._budgetCapped, true, 'still capped, no error');
  });

  test('CostGuard.resetSession fires llm:budget-manual-reset with a timestamp', () => {
    const { fired, bus } = mockBus();
    const cg = new CostGuard({ bus });
    cg.resetSession();
    const ev = fired.find(e => e.name === 'llm:budget-manual-reset');
    assert(ev, 'manual-reset event fired');
    assert(typeof ev.payload.timestamp === 'string', 'carries an ISO timestamp');
  });

  test('CostGuard daily rollover fires llm:budget-auto-reset', () => {
    const { fired, bus } = mockBus();
    const cg = new CostGuard({ bus });
    cg._lastResetDate = '2000-01-01'; // force a day rollover
    cg._checkDailyReset();
    const ev = fired.find(e => e.name === 'llm:budget-auto-reset');
    assert(ev, 'auto-reset event fired on daily rollover');
    assertEqual(ev.payload.triggeredBy, 'cost-guard-daily', 'attributed to the daily reset');
    assert(typeof ev.payload.reason === 'string', 'carries a reason');
  });

});

run();
