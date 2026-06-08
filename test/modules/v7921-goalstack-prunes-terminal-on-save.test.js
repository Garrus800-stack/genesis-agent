'use strict';
// v7.9.21 (Point D) — GoalStack._save() persists only non-terminal goals to
// goals.json. Terminal goals (completed/failed/abandoned) live in the archive;
// leaving them in goals.json grew it without bound and diverged from
// goals/active.json. The in-memory this.goals array is NOT mutated, so
// parent-completion and unblock logic still see terminal children in-session.
const { describe, test, run, assert } = require('../harness');
const { GoalStack } = require('../../src/agent/planning/GoalStack');
const { goalStackLifecycleMixin } = require('../../src/agent/planning/GoalStackLifecycle');

describe('v7921 goalstack prunes terminal on save', () => {
  test('_save persists only non-terminal goals; in-memory keeps all', () => {
    const fake = {
      storage: { last: null, writeJSONDebounced(name, data) { this.last = { name, data }; } },
      goals: [
        { id: 'a', status: 'active' },
        { id: 'b', status: 'blocked' },
        { id: 'p', status: 'paused' },
        { id: 'c', status: 'completed' },
        { id: 'f', status: 'failed' },
        { id: 'x', status: 'abandoned' },
      ],
    };
    GoalStack.prototype._save.call(fake);
    assert(fake.storage.last && fake.storage.last.name === 'goals.json', 'wrote goals.json');
    const persisted = fake.storage.last.data.map(g => g.id).sort();
    assert(
      JSON.stringify(persisted) === JSON.stringify(['a', 'b', 'p']),
      'persisted set must be non-terminal only (active/blocked/paused) — got: ' + persisted.join(','),
    );
    assert(fake.goals.length === 6, 'in-memory this.goals must be untouched (6) — got: ' + fake.goals.length);
  });

  test('_isTerminal covers completed/failed/abandoned only', () => {
    assert(GoalStack._isTerminal('completed') === true, 'completed terminal');
    assert(GoalStack._isTerminal('failed') === true, 'failed terminal');
    assert(GoalStack._isTerminal('abandoned') === true, 'abandoned terminal');
    assert(GoalStack._isTerminal('active') === false, 'active not terminal');
    assert(GoalStack._isTerminal('blocked') === false, 'blocked not terminal');
    assert(GoalStack._isTerminal('paused') === false, 'paused not terminal');
  });

  test('no storage → _save is a guarded no-op', () => {
    const fake = { goals: [{ id: 'a', status: 'active' }] };
    GoalStack.prototype._save.call(fake); // must not throw
    assert(true, 'survived without storage');
  });

  test('parent still auto-completes from an in-memory completed child', () => {
    const stack = Object.assign({
      goals: [
        { id: 'parent', status: 'blocked', description: 'p' },
        { id: 'child', status: 'active', parentId: 'parent', description: 'c' },
      ],
      _save() {},
      bus: { emit() {}, fire() {} },
    }, goalStackLifecycleMixin);
    stack.completeGoal('child', 'done');
    assert(stack.goals.find(g => g.id === 'child').status === 'completed', 'child completed');
    assert(
      stack.goals.find(g => g.id === 'parent').status === 'completed',
      'parent must auto-complete from the in-memory completed child — got: ' + stack.goals.find(g => g.id === 'parent').status,
    );
  });
});

if (require.main === module) run();
