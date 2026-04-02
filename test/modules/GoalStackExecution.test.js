// ============================================================
// GENESIS — GoalStackExecution.test.js (v5.6.0)
// Tests for the extracted execution/decomposition delegate.
// ============================================================

const { describe, test, assert, assertEqual, run } = require('../harness');
const { GoalStack } = require('../../src/agent/planning/GoalStack');

function makeGS(modelResponse = 'think: Analyze the problem') {
  const events = [];
  return new GoalStack({
    lang: { t: (k, v) => v ? `${k}: ${JSON.stringify(v)}` : k },
    bus: { emit(e, d, m) { events.push({ e, d }); }, fire() {}, on() {} },
    model: {
      chat: async () => modelResponse,
    },
    prompts: {},
    storage: null,
    _events: events,
  });
}

describe('GoalStackExecution — _decompose', () => {
  test('decomposes into steps from LLM response', async () => {
    const gs = makeGS('think: Analyze the code\ncode: Write the fix\ncheck: Verify it works');
    const steps = await gs._decompose('Fix the bug');
    assertEqual(steps.length, 3);
    assertEqual(steps[0].type, 'think');
    assertEqual(steps[1].type, 'code');
    assertEqual(steps[2].type, 'check');
    assertEqual(steps[0].status, 'pending');
  });

  test('falls back to generic steps on garbage LLM output', async () => {
    const gs = makeGS('I do not understand the format');
    const steps = await gs._decompose('Do something');
    assert(steps.length >= 2, 'should produce fallback steps');
    assertEqual(steps[0].type, 'think');
  });

  test('respects maxStepsPerGoal', async () => {
    const gs = makeGS(Array(20).fill('think: step').join('\n'));
    gs.maxStepsPerGoal = 4;
    const steps = await gs._decompose('Big task');
    assert(steps.length <= 4);
  });
});

describe('GoalStackExecution — _executeStep', () => {
  test('routes think steps to _stepThink', async () => {
    const gs = makeGS('Analysis complete.');
    const result = await gs._executeStep(
      { type: 'think', action: 'Analyze' },
      { description: 'Test goal', currentStep: 0, steps: [{}], results: [] }
    );
    assert(result.success);
    assert(result.output.includes('Analysis'));
  });

  test('routes code steps to _stepCode', async () => {
    const gs = makeGS('```javascript\nconsole.log("hi")\n```');
    const result = await gs._executeStep(
      { type: 'code', action: 'Write code' },
      { description: 'Test goal', currentStep: 0, steps: [{}], results: [] }
    );
    assert(result.success);
    assert(result.output.includes('console.log'));
  });

  test('code step fails when no code block in response', async () => {
    const gs = makeGS('I cannot generate code for this.');
    const result = await gs._executeStep(
      { type: 'code', action: 'Write code' },
      { description: 'Test goal', currentStep: 0, steps: [{}], results: [] }
    );
    assert(!result.success);
  });

  test('check step passes on YES response', async () => {
    const gs = makeGS('YES. Everything looks good.');
    const result = await gs._executeStep(
      { type: 'check', action: 'Verify' },
      { description: 'Test goal', currentStep: 0, steps: [{}], results: [] }
    );
    assert(result.success);
  });

  test('check step fails on NO response', async () => {
    const gs = makeGS('NO. Tests are failing.');
    const result = await gs._executeStep(
      { type: 'check', action: 'Verify' },
      { description: 'Test goal', currentStep: 0, steps: [{}], results: [] }
    );
    assert(!result.success);
  });

  test('create-file step emits event and succeeds', async () => {
    const events = [];
    const gs = makeGS();
    gs.bus = { emit(e, d, m) { events.push({ e, d }); }, fire() {}, on() {} };
    const result = await gs._executeStep(
      { type: 'create-file', action: 'Create config', detail: 'config.json' },
      { description: 'Setup', currentStep: 0, steps: [{}], results: [] }
    );
    assert(result.success);
    assert(events.some(e => e.e === 'goal:create-file'));
  });

  test('unknown type falls back to think', async () => {
    const gs = makeGS('Fallback response.');
    const result = await gs._executeStep(
      { type: 'unknown-type', action: 'Something' },
      { description: 'Test', currentStep: 0, steps: [{}], results: [] }
    );
    assert(result.success);
  });
});

describe('GoalStackExecution — _replan', () => {
  test('replans with new steps on LLM response', async () => {
    const events = [];
    const gs = makeGS('think: Try different approach\ncode: Rewrite module');
    gs.bus = { emit(e, d, m) { events.push({ e }); }, fire() {}, on() {} };
    gs.storage = { writeJSONDebounced() {} };
    const goal = {
      id: 'g1', description: 'Fix it', maxAttempts: 3,
      steps: [{ type: 'code', action: 'old' }],
      currentStep: 0, results: [], attempts: 0,
    };
    const result = await gs._replan(goal, 'syntax error');
    assert(result === true);
    assertEqual(goal.steps.length, 2);
    assertEqual(goal.attempts, 0);
    assert(events.some(e => e.e === 'goal:replanned'));
  });

  test('returns false when LLM gives up', async () => {
    const gs = makeGS('GIVE_UP — this goal is not achievable.');
    const goal = {
      id: 'g2', description: 'Impossible', maxAttempts: 3,
      steps: [{ type: 'think', action: 'try' }],
      currentStep: 0, results: [],
    };
    const result = await gs._replan(goal, 'repeated failure');
    assert(result === false);
  });
});

run();
