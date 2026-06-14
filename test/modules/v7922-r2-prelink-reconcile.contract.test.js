'use strict';
// v7.9.22 R2 — a standing, idempotent boot reconcile heals a plan whose goal<->plan link
// predates Item 4: a stranded plan (non-terminal, no goalId) whose title matches exactly one
// terminal archived goal adopts that goal's id and status; ambiguous, already-linked, already-
// terminal, and no-match cases are left untouched.
const { describe, test, assert, run } = require('../harness');
const { plansMixin } = require('../../src/agent/autonomy/IdleMindPlans');

function makeIdle(plans, archive) {
  return Object.assign({
    plans,
    storage: {
      readJSON: (name, def) => (name === 'goals/archive.json' ? archive : def),
      writeJSON: () => {}, writeJSONDebounced: () => {},
    },
  }, plansMixin);
}
const goal = (id, status, description) => ({ id, status, description, completedAt: new Date().toISOString() });

describe('v7.9.22 R2 — pre-link plan reconcile on boot', () => {
  test('a stranded plan with exactly one matching terminal goal adopts its id and status', () => {
    const plans = [{ id: 'p1', title: 'Inspect X.js', status: 'new' }];
    makeIdle(plans, [goal('g1', 'completed', 'Inspect X.js')])._reconcilePreLinkPlans();
    assert(plans[0].goalId === 'g1', `expected goalId g1, got ${plans[0].goalId}`);
    assert(plans[0].status === 'completed', `expected status completed, got ${plans[0].status}`);
  });

  test('the adopted status is the goal\'s terminal state (e.g. abandoned)', () => {
    const plans = [{ id: 'p1', title: 'Inspect Y.js', status: 'new' }];
    makeIdle(plans, [goal('g2', 'abandoned', 'Inspect Y.js')])._reconcilePreLinkPlans();
    assert(plans[0].status === 'abandoned' && plans[0].goalId === 'g2', `got status=${plans[0].status} goalId=${plans[0].goalId}`);
  });

  test('a title that matches two archived goals leaves the plan untouched', () => {
    const plans = [{ id: 'p1', title: 'Inspect X.js', status: 'new' }];
    makeIdle(plans, [goal('g1', 'completed', 'Inspect X.js'), goal('g2', 'failed', 'Inspect X.js')])._reconcilePreLinkPlans();
    assert(plans[0].goalId === undefined && plans[0].status === 'new', `collision should be left alone, got goalId=${plans[0].goalId} status=${plans[0].status}`);
  });

  test('a plan already carrying a goalId is untouched', () => {
    const plans = [{ id: 'p1', title: 'Inspect X.js', status: 'new', goalId: 'existing' }];
    makeIdle(plans, [goal('g1', 'completed', 'Inspect X.js')])._reconcilePreLinkPlans();
    assert(plans[0].goalId === 'existing' && plans[0].status === 'new', `linked plan must not be re-linked, got goalId=${plans[0].goalId}`);
  });

  test('a plan already at a terminal status is untouched', () => {
    const plans = [{ id: 'p1', title: 'Inspect X.js', status: 'completed' }];
    makeIdle(plans, [goal('g1', 'completed', 'Inspect X.js')])._reconcilePreLinkPlans();
    assert(plans[0].goalId === undefined, `already-terminal plan must not gain a goalId, got ${plans[0].goalId}`);
  });

  test('a plan whose matching goal is absent from the archive is untouched', () => {
    const plans = [{ id: 'p1', title: 'Inspect X.js', status: 'new' }];
    makeIdle(plans, [goal('g9', 'completed', 'Inspect OTHER.js')])._reconcilePreLinkPlans();
    assert(plans[0].goalId === undefined && plans[0].status === 'new', `no-match plan must stay, got goalId=${plans[0].goalId} status=${plans[0].status}`);
  });

  test('the pass is idempotent — a second run changes nothing', () => {
    const plans = [{ id: 'p1', title: 'Inspect X.js', status: 'new' }];
    const idle = makeIdle(plans, [goal('g1', 'completed', 'Inspect X.js')]);
    idle._reconcilePreLinkPlans();
    const after1 = { goalId: plans[0].goalId, status: plans[0].status };
    idle._reconcilePreLinkPlans();
    assert(plans[0].goalId === after1.goalId && plans[0].status === after1.status, 'second run must be a no-op');
  });
});

run();
