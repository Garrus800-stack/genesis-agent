const { describe, test, run } = require('../harness');
const { AgentLoopPlannerDelegate } = require('../../src/agent/revolution/AgentLoopPlanner');

const MOCK_PLAN = {
  title: 'Test Plan',
  steps: [
    { type: 'ANALYZE', description: 'Step 1', action: 'analyze', target: '' },
    { type: 'CODE', description: 'Step 2', action: 'code', target: 'x.js' },
  ],
  successCriteria: 'Tests pass',
};

function mockLoop(overrides = {}) {
  return {
    model: {
      chat: async () => ({ text: JSON.stringify(MOCK_PLAN) }),
      chatStructured: async () => MOCK_PLAN,
    },
    formalPlanner: null,
    selfModel: { getModuleSummary: () => ['mod1'], getCapabilities: () => ['cap1'] },
    memory: { recall: async () => [] },
    kg: { search: async () => [] },
    tools: { listTools: () => [{ name: 'shell' }] },
    worldState: null,
    episodicMemory: null,
    bodySchema: null,
    lang: { t: (k) => k },
    bus: { emit: () => {}, fire: () => {}, on: () => () => {} },
    rootDir: '/tmp/test',
    ...overrides,
  };
}

describe('AgentLoopPlanner', () => {
  test('exports AgentLoopPlannerDelegate', () => {
    if (typeof AgentLoopPlannerDelegate !== 'function') throw new Error('Missing');
  });

  test('constructor stores loop reference', () => {
    const loop = mockLoop();
    const p = new AgentLoopPlannerDelegate(loop);
    if (p.loop !== loop) throw new Error('Loop not stored');
  });

  test('_planGoal returns plan with steps', async () => {
    const p = new AgentLoopPlannerDelegate(mockLoop());
    const plan = await p._planGoal('Fix bug');
    if (!plan || !plan.steps || !Array.isArray(plan.steps)) throw new Error('Bad plan');
  });

  test('_planGoal prefers FormalPlanner when available', async () => {
    let formalUsed = false;
    const loop = mockLoop({
      formalPlanner: {
        plan: async () => {
          formalUsed = true;
          return { title: 'Formal', steps: [{ type: 'ANALYZE', description: 's' }], successCriteria: 'ok' };
        },
      },
    });
    await new AgentLoopPlannerDelegate(loop)._planGoal('Test');
    if (!formalUsed) throw new Error('FormalPlanner not used');
  });

  test('_planGoal falls back to LLM when FormalPlanner returns empty', async () => {
    let llmUsed = false;
    const loop = mockLoop({
      formalPlanner: { plan: async () => ({ title: '', steps: [], successCriteria: '' }) },
      model: {
        chat: async () => ({ text: JSON.stringify(MOCK_PLAN) }),
        chatStructured: async () => { llmUsed = true; return MOCK_PLAN; },
      },
    });
    await new AgentLoopPlannerDelegate(loop)._planGoal('Complex goal');
    if (!llmUsed) throw new Error('LLM fallback not triggered');
  });

  test('_planGoal falls back to LLM when FormalPlanner throws', async () => {
    let llmUsed = false;
    const loop = mockLoop({
      formalPlanner: { plan: async () => { throw new Error('crash'); } },
      model: {
        chat: async () => ({ text: JSON.stringify(MOCK_PLAN) }),
        chatStructured: async () => { llmUsed = true; return MOCK_PLAN; },
      },
    });
    await new AgentLoopPlannerDelegate(loop)._planGoal('Risky');
    if (!llmUsed) throw new Error('LLM fallback not triggered on error');
  });

  test('_salvagePlan extracts steps from raw text', () => {
    const p = new AgentLoopPlannerDelegate(mockLoop());
    const plan = p._salvagePlan('1. Analyze the code structure\n2. Write new module\n3. Run npm test', 'Fix bug');
    if (!plan.steps || plan.steps.length === 0) throw new Error('No steps salvaged');
    if (!plan.title) throw new Error('No title');
  });

  test('_inferStepType classifies CODE correctly', () => {
    const p = new AgentLoopPlannerDelegate(mockLoop());
    if (p._inferStepType('Write a new function') !== 'CODE') throw new Error('Should be CODE');
  });

  test('_inferStepType classifies SHELL correctly', () => {
    const p = new AgentLoopPlannerDelegate(mockLoop());
    if (p._inferStepType('Run npm install') !== 'SHELL') throw new Error('Should be SHELL');
  });

  test('_inferStepType defaults to ANALYZE', () => {
    const p = new AgentLoopPlannerDelegate(mockLoop());
    if (p._inferStepType('Review the situation') !== 'ANALYZE') throw new Error('Should default to ANALYZE');
  });
});

run();
