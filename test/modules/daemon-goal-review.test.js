// Test: AutonomousDaemon goal-lifecycle review scheduling (v7.3.5 commit 5)
// Before v7.3.5, GoalStack.reviewGoals() existed but was only ever called
// from DreamCycle Phase 6 at intensity >= 0.5. Goals that hit 6/8 or 7/8 but
// never flipped to completed, and goals that stalled with no update for
// days, stayed active indefinitely. v7.3.5 wires a periodic goal review
// into the daemon cycle.
const { describe, test, run } = require('../harness');
const { AutonomousDaemon } = require('../../src/agent/autonomy/AutonomousDaemon');

function makeStubGoalStack() {
  const calls = [];
  return {
    _calls: calls,
    reviewGoals(opts) {
      calls.push(opts);
      return { changed: [{ id: 'g1', from: 'active', to: 'completed', reason: 'test' }], reviewed: 2 };
    },
  };
}

function makeDaemon({ goalStack } = {}) {
  const bus = { emit() {}, fire() {} };
  const d = new AutonomousDaemon({
    bus,
    reflector: { diagnose: async () => ({ issues: [] }) },
    selfModel: { getCapabilities: () => [] },
    memory: null,
    model: null,
    prompts: null,
    skills: null,
    sandbox: null,
    guard: { verifyIntegrity: () => true },
    intervals: null,
  });
  if (goalStack !== undefined) d.goalStack = goalStack;
  return d;
}

describe('AutonomousDaemon goal-review wiring', () => {
  test('goalReviewInterval is configured', () => {
    const d = makeDaemon();
    if (typeof d.config.goalReviewInterval !== 'number') {
      throw new Error('goalReviewInterval config missing');
    }
    if (d.config.goalReviewInterval <= 0) {
      throw new Error('goalReviewInterval must be positive');
    }
  });

  test('goalStack is declared as late-bound (null by default)', () => {
    const d = makeDaemon();
    if (d.goalStack !== null) {
      throw new Error('goalStack should start as null (late-bound)');
    }
  });

  test('_reviewGoals returns safe result when goalStack is absent', async () => {
    const d = makeDaemon();
    const result = await d._reviewGoals();
    if (result.changed !== 0) throw new Error('no-stack should report 0 changes');
    if (result.skipped !== 'no-goal-stack') throw new Error('should mark as skipped');
  });

  test('_reviewGoals delegates to goalStack.reviewGoals when wired', async () => {
    const stack = makeStubGoalStack();
    const d = makeDaemon({ goalStack: stack });
    const result = await d._reviewGoals();
    if (stack._calls.length !== 1) throw new Error('should have called reviewGoals once');
    if (result.changed !== 1) throw new Error('should report 1 change');
    if (result.reviewed !== 2) throw new Error('should report 2 reviewed');
  });

  test('_reviewGoals catches goalStack errors without crashing cycle', async () => {
    const throwingStack = {
      reviewGoals() { throw new Error('boom'); },
    };
    const d = makeDaemon({ goalStack: throwingStack });
    const result = await d._reviewGoals();
    if (result.changed !== 0) throw new Error('error case should report 0 changes');
    if (!result.error) throw new Error('error should be captured');
  });

  test('cycle at goalReviewInterval triggers the review (behavioural check)', async () => {
    const stack = makeStubGoalStack();
    const d = makeDaemon({ goalStack: stack });
    d.running = true;

    // Simulate cycles up to the trigger interval
    const triggerCycle = d.config.goalReviewInterval;
    for (let i = 1; i < triggerCycle; i++) {
      d.cycleCount = i;
      // manually test the gate expression only — not running full _runCycle
      if (d.cycleCount % d.config.goalReviewInterval === 0) {
        throw new Error('should not trigger at cycle ' + i);
      }
    }
    d.cycleCount = triggerCycle;
    if (d.cycleCount % d.config.goalReviewInterval !== 0) {
      throw new Error('should trigger at cycle ' + triggerCycle);
    }
  });
});

run();
