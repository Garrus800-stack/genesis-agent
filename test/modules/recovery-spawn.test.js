// Test: AgentLoopRecovery.js Sub-Goal-Spawn — v7.4.5 Baustein D
const { AgentLoopRecoveryDelegate } = require('../../src/agent/revolution/AgentLoopRecovery');

let passed = 0, failed = 0;
const failures = [];
function test(name, fn) {
  try {
    const r = fn();
    if (r && typeof r.then === 'function') {
      return r.then(() => { passed++; console.log(`    ✅ ${name}`); })
              .catch(err => { failed++; failures.push({ name, error: err.message }); console.log(`    ❌ ${name}: ${err.message}`); });
    }
    passed++; console.log(`    ✅ ${name}`);
  } catch (err) { failed++; failures.push({ name, error: err.message }); console.log(`    ❌ ${name}: ${err.message}`); }
}
function assert(c, m) { if (!c) throw new Error(m || 'Assertion failed'); }

// Mocks
function makeGoalStack(goals = []) {
  let nextId = 1;
  return {
    goals,
    addSubGoal: async (parentId, desc, prio) => {
      const sub = {
        id: `sub_${nextId++}`,
        description: desc,
        priority: prio,
        parentId,
        status: 'active',
        currentStep: 0,
        steps: [],
      };
      goals.push(sub);
      return sub;
    },
    blockOnSubgoal: (parentId, subId) => {
      const p = goals.find(g => g.id === parentId);
      if (!p) return false;
      p.status = 'blocked';
      p.blockedBy = [...(p.blockedBy || []), subId];
      return true;
    },
  };
}
function makeBus() {
  const fired = [];
  return {
    fire: (name, data) => fired.push({ name, data }),
    fired,
  };
}
function makeLoop({ goalStack, bus, currentGoalId = 'parent_1', lessonsStore = null }) {
  return { goalStack, bus, currentGoalId, lessonsStore };
}

(async () => {

  await test('spawns sub-goal for module-not-found and blocks parent', async () => {
    const goalStack = makeGoalStack([
      { id: 'parent_1', description: 'do something', status: 'active', currentStep: 1, steps: [{}, {}] },
    ]);
    const bus = makeBus();
    const loop = makeLoop({ goalStack, bus });
    const r = new AgentLoopRecoveryDelegate(loop);

    const result = await r._trySpawnObstacleSubgoal(
      { type: 'module-not-found', module: 'lodash', contextKey: 'module:lodash', subGoalDescription: 'Install missing npm module: lodash' },
      { type: 'CODE' },
      0,
      () => {}
    );

    assert(result.spawned === true, `should spawn, got ${JSON.stringify(result)}`);
    assert(result.subId, 'should return subId');
    const parent = goalStack.goals.find(g => g.id === 'parent_1');
    assert(parent.status === 'blocked', `parent should be blocked, got ${parent.status}`);
    assert(parent.blockedBy.includes(result.subId), 'parent.blockedBy should include subId');
    const spawnedEvent = bus.fired.find(e => e.name === 'goal:subgoal-spawned');
    assert(spawnedEvent, 'goal:subgoal-spawned should fire');
    assert(spawnedEvent.data.obstacleType === 'module-not-found');
  });

  await test('refuses spawn when depth limit reached (parent has 3 ancestors)', async () => {
    // Build chain: g0 → g1 → g2 → g3 (g3 is current parent, depth 3 from g0)
    const goalStack = makeGoalStack([
      { id: 'g0', description: 'root', status: 'blocked' },
      { id: 'g1', description: 'level 1', status: 'blocked', parentId: 'g0' },
      { id: 'g2', description: 'level 2', status: 'blocked', parentId: 'g1' },
      { id: 'g3', description: 'level 3 (current parent)', status: 'active', parentId: 'g2', currentStep: 1, steps: [{}, {}] },
    ]);
    const bus = makeBus();
    const loop = makeLoop({ goalStack, bus, currentGoalId: 'g3' });
    const r = new AgentLoopRecoveryDelegate(loop);

    const result = await r._trySpawnObstacleSubgoal(
      { type: 'module-not-found', module: 'foo', contextKey: 'module:foo', subGoalDescription: 'Install foo' },
      { type: 'CODE' }, 0, () => {}
    );

    assert(result.spawned === false, 'should refuse spawn');
    assert(result.reason === 'depth-limit', `reason should be depth-limit, got ${result.reason}`);
    const guarded = bus.fired.find(e => e.name === 'goal:obstacle-loop-protected');
    assert(guarded, 'should emit obstacle-loop-protected');
    assert(guarded.data.reason === 'depth-limit');
  });

  await test('loop-protect: 3rd spawn for same contextPath in 5min is blocked', async () => {
    const goalStack = makeGoalStack([
      { id: 'parent_1', description: 'do', status: 'active', currentStep: 1, steps: [{}] },
    ]);
    const bus = makeBus();
    const loop = makeLoop({ goalStack, bus });
    const r = new AgentLoopRecoveryDelegate(loop);

    const obstacle = { type: 'module-not-found', module: 'foo', contextKey: 'module:foo', subGoalDescription: 'Install foo' };

    // Three spawns in a row (same parent + step + contextKey)
    const r1 = await r._trySpawnObstacleSubgoal(obstacle, { type: 'CODE' }, 0, () => {});
    const r2 = await r._trySpawnObstacleSubgoal(obstacle, { type: 'CODE' }, 0, () => {});
    const r3 = await r._trySpawnObstacleSubgoal(obstacle, { type: 'CODE' }, 0, () => {});

    assert(r1.spawned === true, 'first should spawn');
    assert(r2.spawned === true, 'second should spawn');
    assert(r3.spawned === false, 'third should be loop-protected');
    assert(r3.reason === 'loop-protection', `reason: ${r3.reason}`);
  });

  await test('loop-protect: different contextPaths do NOT trigger protection', async () => {
    const goalStack = makeGoalStack([
      { id: 'parent_1', description: 'do', status: 'active', currentStep: 1, steps: [{}] },
    ]);
    const bus = makeBus();
    const loop = makeLoop({ goalStack, bus });
    const r = new AgentLoopRecoveryDelegate(loop);

    const obstacleA = { type: 'module-not-found', module: 'a', contextKey: 'module:a', subGoalDescription: 'install a' };
    const obstacleB = { type: 'module-not-found', module: 'b', contextKey: 'module:b', subGoalDescription: 'install b' };
    const obstacleC = { type: 'module-not-found', module: 'c', contextKey: 'module:c', subGoalDescription: 'install c' };

    const r1 = await r._trySpawnObstacleSubgoal(obstacleA, { type: 'CODE' }, 0, () => {});
    const r2 = await r._trySpawnObstacleSubgoal(obstacleB, { type: 'CODE' }, 0, () => {});
    const r3 = await r._trySpawnObstacleSubgoal(obstacleC, { type: 'CODE' }, 0, () => {});

    assert(r1.spawned && r2.spawned && r3.spawned, 'all three different obstacles should spawn');
  });

  await test('lessons-veto: refuses spawn when 3+ recent failures recorded', async () => {
    const goalStack = makeGoalStack([
      { id: 'parent_1', description: 'do', status: 'active', currentStep: 1, steps: [{}] },
    ]);
    const bus = makeBus();
    // Stub LessonsStore returning 3 failure-outcomes
    const lessonsStore = {
      recall: () => [
        { outcome: 'subgoal-failed' }, { outcome: 'subgoal-failed' }, { outcome: 'subgoal-failed' },
      ],
    };
    const loop = makeLoop({ goalStack, bus, lessonsStore });
    const r = new AgentLoopRecoveryDelegate(loop);

    const result = await r._trySpawnObstacleSubgoal(
      { type: 'module-not-found', module: 'cursed', contextKey: 'module:cursed', subGoalDescription: 'install cursed' },
      { type: 'CODE' }, 0, () => {}
    );

    assert(result.spawned === false, 'should refuse');
    assert(result.reason === 'lessons-veto', `reason: ${result.reason}`);
  });

  await test('lessons-allow: 2 recent failures still allows spawn', async () => {
    const goalStack = makeGoalStack([
      { id: 'parent_1', description: 'do', status: 'active', currentStep: 1, steps: [{}] },
    ]);
    const bus = makeBus();
    const lessonsStore = {
      recall: () => [
        { outcome: 'subgoal-failed' }, { outcome: 'subgoal-failed' }, { outcome: 'subgoal-completed' },
      ],
    };
    const loop = makeLoop({ goalStack, bus, lessonsStore });
    const r = new AgentLoopRecoveryDelegate(loop);

    const result = await r._trySpawnObstacleSubgoal(
      { type: 'module-not-found', module: 'foo', contextKey: 'module:foo', subGoalDescription: 'install foo' },
      { type: 'CODE' }, 0, () => {}
    );

    assert(result.spawned === true, `should spawn (only 2 failures), got ${JSON.stringify(result)}`);
  });

  await test('refuses spawn when no goalStack', async () => {
    const r = new AgentLoopRecoveryDelegate(makeLoop({ goalStack: null, bus: makeBus() }));
    const result = await r._trySpawnObstacleSubgoal(
      { type: 'module-not-found', module: 'x', contextKey: 'module:x', subGoalDescription: 'x' },
      { type: 'CODE' }, 0, () => {}
    );
    assert(result.spawned === false);
    assert(result.reason === 'no-goalstack-or-parent');
  });

  console.log(`  ${passed} passed, ${failed} failed`);
  if (failed > 0) {
    console.log('\n  Failures:');
    for (const f of failures) console.log(`    - ${f.name}: ${f.error}`);
    process.exit(1);
  }
})();
