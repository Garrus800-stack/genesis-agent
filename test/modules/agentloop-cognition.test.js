const { describe, test, run } = require('../harness');
const { AgentLoopCognitionDelegate } = require('../../src/agent/revolution/AgentLoopCognition');

function mockLoop(overrides = {}) {
  return {
    // Phase 9 services — all optional, graceful degradation when null
    _mentalSimulator: null,
    _expectationEngine: null,
    _surpriseAccumulator: null,
    _onlineLearner: null,
    _taskRecorder: null,
    _cognitiveHealthTracker: null,
    _cognitiveWorkspaceFactory: null,
    bus: { emit: () => {}, fire: () => {}, on: () => () => {} },
    lang: { t: (k) => k },
    ...overrides,
  };
}

describe('AgentLoopCognition', () => {
  test('exports AgentLoopCognitionDelegate', () => {
    if (typeof AgentLoopCognitionDelegate !== 'function') throw new Error('Missing');
  });

  test('constructor stores loop reference', () => {
    const loop = mockLoop();
    const c = new AgentLoopCognitionDelegate(loop);
    if (c.loop !== loop) throw new Error('Loop not stored');
  });

  test('preExecute returns proceed:true with no Phase 9 services', async () => {
    const c = new AgentLoopCognitionDelegate(mockLoop());
    const plan = { title: 'Test', steps: [{ type: 'ANALYZE', description: 's' }] };
    const result = await c.preExecute(plan);
    if (!result) throw new Error('No result');
    if (result.proceed !== true) throw new Error('Should proceed when no services');
  });

  test('preExecute works with MentalSimulator available', async () => {
    let simCalled = false;
    const loop = mockLoop({
      _mentalSimulator: {
        simulate: async () => { simCalled = true; return { success: true, issues: [] }; },
      },
      _cognitiveHealthTracker: {
        guard: async (name, fn) => fn(),
      },
    });
    const c = new AgentLoopCognitionDelegate(loop);
    const plan = { title: 'Test', steps: [{ type: 'CODE', description: 's' }] };
    const result = await c.preExecute(plan);
    if (!result || result.proceed !== true) throw new Error('Should proceed');
  });

  test('preExecute gracefully handles simulator error', async () => {
    const loop = mockLoop({
      _mentalSimulator: {
        simulate: async () => { throw new Error('Simulator crashed'); },
      },
      _cognitiveHealthTracker: {
        guard: async (name, fn) => fn(),
      },
    });
    const c = new AgentLoopCognitionDelegate(loop);
    const plan = { title: 'Test', steps: [{ type: 'CODE', description: 's' }] };
    // Should not throw — graceful degradation
    const result = await c.preExecute(plan);
    if (!result) throw new Error('No result after error');
    if (result.proceed !== true) throw new Error('Should still proceed after error');
  });

  test('postStep does not throw without Phase 9 services', async () => {
    const c = new AgentLoopCognitionDelegate(mockLoop());
    const plan = { title: 'Test', steps: [{ type: 'ANALYZE', description: 's' }] };
    const step = plan.steps[0];
    // Should not throw
    try {
      await c.postStep(plan, 0, step, { success: true });
    } catch (e) {
      throw new Error('postStep threw without services: ' + e.message);
    }
  });

  test('postStep works with ExpectationEngine available', async () => {
    let compareCalled = false;
    const loop = mockLoop({
      _expectationEngine: {
        compare: (stepIdx, result) => { compareCalled = true; return { surprise: 0.1 }; },
        formExpectations: () => {},
      },
      _cognitiveHealthTracker: {
        guard: async (name, fn) => fn(),
      },
    });
    const c = new AgentLoopCognitionDelegate(loop);
    await c.postStep(
      { title: 'T', steps: [{ type: 'CODE', description: 's' }] },
      0,
      { type: 'CODE', description: 's' },
      { success: true }
    );
  });

  test('handles null plan in preExecute', async () => {
    const c = new AgentLoopCognitionDelegate(mockLoop());
    const result = await c.preExecute(null);
    if (!result || result.proceed !== true) throw new Error('Should handle null plan');
  });
});

run();
