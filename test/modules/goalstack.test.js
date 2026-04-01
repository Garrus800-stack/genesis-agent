// Test: GoalStack.js — sub-goals, dependencies, blocking
const path = require('path');
const fs = require('fs');
const os = require('os');

let passed = 0, failed = 0;
function test(name, fn) {
  // v3.5.2: Fixed — try/catch around fn() for sync errors
  try {
    const result = fn();
    if (result && typeof result.then === 'function') {
      return result.then(() => {
        passed++; console.log(`    ✅ ${name}`);
      }).catch(err => {
        failed++; (typeof failures !== "undefined" ? failures : []).push({ name, error: err.message });
        console.log(`    ❌ ${name}: ${err.message}`);
      });
    }
    passed++; console.log(`    ✅ ${name}`);
  } catch (err) {
    failed++; (typeof failures !== "undefined" ? failures : []).push({ name, error: err.message });
    console.log(`    ❌ ${name}: ${err.message}`);
  }
}
function assert(c, m) { if (!c) throw new Error(m || 'Assertion failed'); }

const tmpDir = path.join(os.tmpdir(), 'genesis-test-goals-' + Date.now());
fs.mkdirSync(tmpDir, { recursive: true });

// Mock model
const mockModel = {
  chat: async (prompt) => {
    if (prompt.includes('Zerlege')) return 'think: Schritt eins\ncheck: Schritt zwei';
    return 'OK';
  },
};

const { GoalStack } = require('../../src/agent/planning/GoalStack');
const { bus } = require('../../src/agent/core/EventBus');

console.log('\n  📦 GoalStack Hierarchical');

async function runTests() {
  const gs = new GoalStack({ model: mockModel, prompts: {}, storageDir: tmpDir });

  await test('creates goal with sub-goal support', async () => {
    const goal = await gs.addGoal('Test goal', 'test', 'high');
    assert(goal.parentId === null, 'Root goal has no parent');
    assert(Array.isArray(goal.childIds), 'Has childIds array');
    assert(goal.blockedBy.length === 0, 'Not blocked');
  });

  await test('creates sub-goal linked to parent', async () => {
    const parent = gs.getAll()[0];
    const sub = await gs.addSubGoal(parent.id, 'Sub task');
    assert(sub.parentId === parent.id, 'Sub-goal references parent');
    const updatedParent = gs.getAll().find(g => g.id === parent.id);
    assert(updatedParent.childIds.includes(sub.id), 'Parent lists child');
  });

  await test('goal with dependency starts as blocked', async () => {
    const dep = await gs.addGoal('Dependency', 'test');
    const blocked = await gs.addGoal('Depends on first', 'test', 'medium', { blockedBy: [dep.id] });
    assert(blocked.status === 'blocked', `Expected blocked, got ${blocked.status}`);
  });

  await test('getGoalTree returns hierarchical structure', () => {
    const tree = gs.getGoalTree();
    assert(tree.length > 0, 'Tree has roots');
    const root = tree.find(t => t.children && t.children.length > 0);
    assert(root, 'At least one root has children');
  });

  await test('getSubGoals returns children', () => {
    const parent = gs.getAll().find(g => g.childIds && g.childIds.length > 0);
    if (parent) {
      const subs = gs.getSubGoals(parent.id);
      assert(subs.length > 0, 'Has sub-goals');
      assert(subs[0].parentId === parent.id, 'Sub-goal references parent');
    }
  });

  // Cleanup
  fs.rmSync(tmpDir, { recursive: true, force: true });

  console.log(`\n  ${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

runTests().catch(err => { console.error(err); process.exit(1); });
