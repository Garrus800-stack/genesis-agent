// Test: v7.6.8 GoalStack lifecycle mixin extraction (Track A)
// Pins the structural extraction of lifecycle/hierarchy methods from
// GoalStack.js into GoalStackLifecycle.js. Same pattern as v7.6.7
// SettingsEncryption split.

'use strict';

const { describe, test, run } = require('../harness');
const { createTestRoot } = require('../harness');
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const ROOT = path.resolve(__dirname, '../..');

describe('v7.6.8 GoalStack lifecycle split', () => {

  test('GoalStackLifecycle module exports goalStackLifecycleMixin with 14 keys', () => {
    const lifecycle = require('../../src/agent/planning/GoalStackLifecycle');
    assert(lifecycle.goalStackLifecycleMixin, 'must export goalStackLifecycleMixin');

    const expected = [
      'pauseGoal', 'resumeGoal', 'completeGoal', 'abandonGoal',
      'blockOnSubgoal', 'blockOnResources', 'unblockOnResource',
      'markStalled', 'markObsolete', 'reviewGoals',
      'getSubGoals', 'getGoalTree',
      '_unblockDependents', '_checkParentCompletion',
    ];
    const actual = Object.keys(lifecycle.goalStackLifecycleMixin).sort();
    assert.deepStrictEqual(actual, expected.sort(),
      `mixin keys must match expected 14 — got ${actual.length}: ${actual.join(', ')}`);
  });

  test('Object.assign mounts mixin onto GoalStack.prototype', () => {
    const { GoalStack } = require('../../src/agent/planning/GoalStack');
    assert(typeof GoalStack.prototype.completeGoal === 'function',
      'GoalStack.prototype.completeGoal must be defined via mixin');
    assert(typeof GoalStack.prototype.markStalled === 'function');
    assert(typeof GoalStack.prototype.reviewGoals === 'function');
    assert(typeof GoalStack.prototype._unblockDependents === 'function');
  });

  test('identity-equality: prototype methods === mixin methods', () => {
    const { GoalStack } = require('../../src/agent/planning/GoalStack');
    const { goalStackLifecycleMixin } = require('../../src/agent/planning/GoalStackLifecycle');
    assert.strictEqual(GoalStack.prototype.completeGoal, goalStackLifecycleMixin.completeGoal,
      'prototype.completeGoal must be identical reference to mixin.completeGoal');
    assert.strictEqual(GoalStack.prototype.markStalled, goalStackLifecycleMixin.markStalled);
    assert.strictEqual(GoalStack.prototype.reviewGoals, goalStackLifecycleMixin.reviewGoals);
  });

  test('completeGoal end-to-end: state mutation and _save called', () => {
    const { GoalStack } = require('../../src/agent/planning/GoalStack');
    const fires = [];
    const writes = [];
    const stack = new GoalStack({
      bus: { fire: (e, d) => fires.push({ e, d }), emit: () => {}, on: () => {} },
      storage: { writeJSONDebounced: (n, d) => writes.push({ n, d }), readJSON: () => [] },
      storageDir: createTestRoot('v768'),
    });
    stack.goals.push({ id: 'g1', description: 'test', status: 'active', priority: 'medium', created: new Date().toISOString() });

    const ok = stack.completeGoal('g1');
    assert.strictEqual(ok, true);
    assert.strictEqual(stack.goals[0].status, 'completed');
    assert(stack.goals[0].completedAt, 'completedAt timestamp must be set');
    assert(writes.length > 0, '_save must have triggered storage write');
    assert(fires.some(f => f.e === 'goal:completed'), 'goal:completed event must fire');
  });

  test('parent-completion chain: subgoal complete fires _checkParentCompletion', () => {
    const { GoalStack } = require('../../src/agent/planning/GoalStack');
    const fires = [];
    const stack = new GoalStack({
      bus: { fire: (e, d) => fires.push({ e, d }), emit: () => {}, on: () => {} },
      storage: { writeJSONDebounced: () => {}, readJSON: () => [] },
      storageDir: createTestRoot('v768'),
    });
    stack.goals.push(
      { id: 'parent', description: 'p', status: 'active', priority: 'medium' },
      { id: 'sub', description: 's', status: 'active', priority: 'medium', parentId: 'parent' },
    );

    stack.completeGoal('sub');
    // parent should auto-complete via _checkParentCompletion
    assert.strictEqual(stack.goals.find(g => g.id === 'parent').status, 'completed',
      'parent must be auto-completed when all sub-goals complete');
    assert(fires.some(f => f.e === 'goal:completed' && f.d.via === 'sub-goals'),
      'goal:completed with via:sub-goals must fire');
  });

  test('unblockDependents: completing a goal reactivates blockedBy dependents', () => {
    const { GoalStack } = require('../../src/agent/planning/GoalStack');
    const fires = [];
    const stack = new GoalStack({
      bus: { fire: (e, d) => fires.push({ e, d }), emit: () => {}, on: () => {} },
      storage: { writeJSONDebounced: () => {}, readJSON: () => [] },
      storageDir: createTestRoot('v768'),
    });
    stack.goals.push(
      { id: 'a', description: 'a', status: 'active', priority: 'medium' },
      { id: 'b', description: 'b', status: 'blocked', priority: 'medium', blockedBy: ['a'] },
    );

    stack.completeGoal('a');
    const b = stack.goals.find(g => g.id === 'b');
    assert.strictEqual(b.status, 'active', 'b must be unblocked when a completes');
    assert.strictEqual(b.blockedBy.length, 0, 'b.blockedBy must be empty');
    assert(fires.some(f => f.e === 'goal:unblocked'), 'goal:unblocked must fire');
  });

  test('source-presence: GoalStack.js does not redefine extracted methods', () => {
    const src = fs.readFileSync(path.join(ROOT, 'src/agent/planning/GoalStack.js'), 'utf8');
    // Methods that moved to GoalStackLifecycle must NOT have a class-body
    // declaration in GoalStack.js. Match `<spaces><methodname>(<args>) {`.
    const extracted = [
      'pauseGoal', 'resumeGoal', 'completeGoal', 'abandonGoal',
      'blockOnSubgoal', 'blockOnResources', 'unblockOnResource',
      'markStalled', 'markObsolete', 'reviewGoals',
      'getSubGoals', 'getGoalTree',
      '_unblockDependents', '_checkParentCompletion',
    ];
    for (const name of extracted) {
      const re = new RegExp(`^\\s{2}${name}\\s*\\(`, 'm');
      assert(!re.test(src),
        `GoalStack.js must not redefine ${name} — regression of structural extraction`);
    }
  });

  test('method-binding: this.goals access from extracted methods works', () => {
    const { GoalStack } = require('../../src/agent/planning/GoalStack');
    const stack = new GoalStack({
      bus: { fire: () => {}, emit: () => {}, on: () => {} },
      storage: { writeJSONDebounced: () => {}, readJSON: () => [] },
      storageDir: createTestRoot('v768'),
    });
    stack.goals.push(
      { id: 'g1', description: 'one', status: 'active', priority: 'medium' },
      { id: 'g2', description: 'two', status: 'active', priority: 'medium', parentId: 'g1' },
    );

    // pauseGoal accesses this.goals.find — must work via prototype-mounted form
    const ok = stack.pauseGoal('g1');
    assert.strictEqual(ok, true);
    assert.strictEqual(stack.goals[0].status, 'paused');

    // getSubGoals uses this.goals.filter
    const subs = stack.getSubGoals('g1');
    assert.strictEqual(subs.length, 1);
    assert.strictEqual(subs[0].id, 'g2');
  });
});

run();
