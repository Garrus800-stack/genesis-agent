'use strict';
// v7.9.22 Item 4 — a plan's status follows its linked goal's terminal state. The link
// lives on the plan (plan.goalId) and is persisted; a terminal goal event moves the plan
// off 'new'; a repeated terminal event is a no-op; a plan with no link is untouched.
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const ROOT = path.resolve(__dirname, '..', '..');
const { plansMixin } = require(path.join(ROOT, 'src/agent/autonomy/IdleMindPlans'));
let passed = 0, failed = 0;
function test(n, fn) { try { fn(); console.log('    \u2705 ' + n); passed++; } catch (e) { console.log('    \u274c ' + n + ': ' + e.message); failed++; } }

function stub(plans) {
  const o = { plans, _saved: 0 };
  Object.assign(o, plansMixin);
  o._savePlans = function () { this._saved++; };   // override the real fs/storage persist
  return o;
}

test('linking sets plan.goalId; a completing goal flips the plan to completed', () => {
  const o = stub([{ id: 'p1', status: 'new' }]);
  o._linkGoalToPlan('g1', 'p1');
  assert.strictEqual(o.plans[0].goalId, 'g1');
  o._onGoalTerminal({ id: 'g1' }, 'completed');
  assert.strictEqual(o.plans[0].status, 'completed');
});
test('a failing goal flips the plan to failed', () => {
  const o = stub([{ id: 'p1', status: 'new' }]);
  o._linkGoalToPlan('g2', 'p1');
  o._onGoalTerminal({ id: 'g2' }, 'failed');
  assert.strictEqual(o.plans[0].status, 'failed');
});
test('an abandoned goal flips the plan off new', () => {
  const o = stub([{ id: 'p1', status: 'new' }]);
  o._linkGoalToPlan('g3', 'p1');
  o._onGoalTerminal({ id: 'g3' }, 'abandoned');
  assert.notStrictEqual(o.plans[0].status, 'new');
});
test('a plan with no link is untouched', () => {
  const o = stub([{ id: 'p1', status: 'new' }]);
  o._onGoalTerminal({ id: 'gX' }, 'completed');
  assert.strictEqual(o.plans[0].status, 'new');
});
test('a falsy goal id records no link', () => {
  const o = stub([{ id: 'p1', status: 'new' }]);
  o._linkGoalToPlan(undefined, 'p1');
  assert.strictEqual(o.plans[0].goalId, undefined);
});
test('a repeated terminal event is a no-op (no extra persist once status is set)', () => {
  const o = stub([{ id: 'p1', status: 'new' }]);
  o._linkGoalToPlan('g1', 'p1');         // saves once
  o._onGoalTerminal({ id: 'g1' }, 'completed');   // flips + saves
  const saves = o._saved;
  o._onGoalTerminal({ id: 'g1' }, 'completed');   // already completed → guard → no save
  assert.strictEqual(o._saved, saves);
});
test('Plan.js wires the link and keeps the 50-cap', () => {
  const src = fs.readFileSync(path.join(ROOT, 'src/agent/autonomy/activities/Plan.js'), 'utf8');
  assert.ok(/_linkGoalToPlan\(goal\?\.id, plan\.id\)/.test(src), 'link call present');
  assert.ok(/plans\.length > 50/.test(src), '50-cap intact');
});

console.log('\n    ' + passed + ' passed \u00b7 ' + failed + ' failed \u00b7 v7.9.22 Item 4 plan-link');
process.exit(failed > 0 ? 1 : 0);
