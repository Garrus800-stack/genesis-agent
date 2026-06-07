const { describe, test, run } = require('../harness');
const { AgentLoopStepsDelegate } = require('../../src/agent/revolution/AgentLoopSteps');

function mockLoop(overrides = {}) {
  return {
    model: {
      // model.chat returns a string directly (not { text: ... })
      chat: async () => 'Analysis complete: no issues found.',
      chatStructured: async () => ({ result: 'ok' }),
    },
    sandbox: {
      execute: async () => ({ success: true, output: 'ok', error: null }),
      test: async () => ({ valid: true }),
    },
    shell: {
      run: async () => ({ stdout: 'done', stderr: '', exitCode: 0 }),
      isAllowed: () => true,
    },
    selfModel: { readModule: () => '// mock code' },
    memory: { recall: async () => [] },
    kg: { search: async () => [], learnFromText: () => {}, addNode: () => 'id', getNodesByType: () => [] },
    tools: { execute: async () => ({ result: 'ok' }), listTools: () => [] },
    selfMod: null,
    lang: { t: (k) => k },
    bus: { emit: () => {}, fire: () => {}, on: () => () => {} },
    guard: { issueToken: () => ({ token: 't', valid: true }), validateToken: () => true },
    _symbolicResolver: null,
    _executionProvenance: null,
    formalPlanner: null,
    taskDelegation: null,
    worldState: null,
    episodicMemory: null,
    bodySchema: null,
    ...overrides,
  };
}

describe('AgentLoopSteps', () => {
  test('exports AgentLoopStepsDelegate', () => {
    if (typeof AgentLoopStepsDelegate !== 'function') throw new Error('Missing');
  });

  test('constructor stores loop reference', () => {
    const d = new AgentLoopStepsDelegate(mockLoop());
    if (!d.loop) throw new Error('Loop not stored');
  });

  test('_executeStep dispatches ANALYZE and returns durationMs', async () => {
    const d = new AgentLoopStepsDelegate(mockLoop());
    const result = await d._executeStep({ type: 'ANALYZE', description: 'test', action: 'analyze' }, '', () => {});
    if (!result || typeof result.durationMs !== 'number') throw new Error('Bad result');
  });

  test('_executeStep durationMs is non-negative', async () => {
    const d = new AgentLoopStepsDelegate(mockLoop());
    const result = await d._executeStep({ type: 'ANALYZE', description: 'fast', action: 'analyze' }, '', () => {});
    if (result.durationMs < 0) throw new Error('Negative duration');
  });

  test('_stepAnalyze returns output', async () => {
    const d = new AgentLoopStepsDelegate(mockLoop());
    const result = await d._stepAnalyze({ type: 'ANALYZE', description: 'Analyze deps' }, '');
    if (!result || result.output === undefined) throw new Error('No output');
  });

  test('_stepAnalyze stores in KG when available', async () => {
    // v7.9.20 (F2): ANALYZE now persists a durable insight node via addNode
    // (language-agnostic), no longer through the DE-first learnFromText.
    let added = null;
    const d = new AgentLoopStepsDelegate(mockLoop({
      kg: {
        search: async () => [],
        getNodesByType: () => [],
        addNode: (type, label, props) => { added = { type, label, props }; return 'id'; },
      },
    }));
    await d._stepAnalyze({ type: 'ANALYZE', description: 'Analyze', target: 'src/agent/x.js' }, '');
    if (!added) throw new Error('KG.addNode not called');
    if (added.type !== 'insight' || added.props.type !== 'agent-loop-analysis') {
      throw new Error('Wrong node type/props: ' + JSON.stringify(added));
    }
  });

  test('_stepDelegate falls back when no taskDelegation', async () => {
    const d = new AgentLoopStepsDelegate(mockLoop({ taskDelegation: null }));
    const result = await d._stepDelegate({ type: 'DELEGATE', description: 'delegate' }, '', () => {});
    if (!result) throw new Error('No fallback result');
  });

  test('attemptRepair is a function', () => {
    const d = new AgentLoopStepsDelegate(mockLoop());
    if (typeof d.attemptRepair !== 'function') throw new Error('Missing');
  });

  test('verifyGoal is a function', () => {
    const d = new AgentLoopStepsDelegate(mockLoop());
    if (typeof d.verifyGoal !== 'function') throw new Error('Missing');
  });
});

run();
