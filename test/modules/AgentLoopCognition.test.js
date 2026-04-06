#!/usr/bin/env node
// Test: AgentLoopCognition — cognitive hooks + awareness consultation (v7.6.0)
const { describe, test, assert, assertEqual, run } = require('../harness');
const { AgentLoopCognitionDelegate } = require('../../src/agent/revolution/AgentLoopCognition');

function mockLoop(overrides = {}) {
  return {
    mentalSimulator: null,
    expectationEngine: null,
    cognitiveHealthTracker: null,
    model: { activeModel: 'test-model' },
    ...overrides,
  };
}

describe('AgentLoopCognition', () => {

  // ── preExecute ────────────────────────────────────────

  test('preExecute returns proceed:true when no Phase9 services', async () => {
    const cog = new AgentLoopCognitionDelegate(mockLoop());
    const result = await cog.preExecute({ title: 'test', steps: [] });
    assertEqual(result.proceed, true);
  });

  test('preExecute runs simulation when simulator available', async () => {
    let simulated = false;
    const loop = mockLoop({
      mentalSimulator: {
        simulate: (steps) => { simulated = true; return { riskScore: 0.2, recommendation: 'proceed' }; },
      },
    });
    const cog = new AgentLoopCognitionDelegate(loop);
    const result = await cog.preExecute({ title: 'test', steps: [{ type: 'code' }] });
    assert(simulated, 'simulator.simulate should be called');
    assertEqual(result.proceed, true);
    assert(result.simulation, 'should include simulation result');
  });

  test('preExecute blocks on replan recommendation', async () => {
    const loop = mockLoop({
      mentalSimulator: {
        simulate: () => ({ riskScore: 0.9, recommendation: 'replan', expectedValue: 0.1 }),
      },
    });
    const cog = new AgentLoopCognitionDelegate(loop);
    const result = await cog.preExecute({ title: 'risky', steps: [{ type: 'deploy' }] });
    assertEqual(result.proceed, false);
    assertEqual(result.reason, 'simulation-risk');
  });

  test('preExecute forms expectations per step', async () => {
    let expectCalls = 0;
    const loop = mockLoop({
      expectationEngine: {
        expect: (step) => { expectCalls++; return { expected: step.type }; },
      },
    });
    const cog = new AgentLoopCognitionDelegate(loop);
    const plan = { title: 'test', steps: [{ type: 'a' }, { type: 'b' }] };
    await cog.preExecute(plan);
    assertEqual(expectCalls, 2);
    assertEqual(plan._expectations.length, 2);
  });

  // ── postStep ──────────────────────────────────────────

  test('postStep is no-op without expectationEngine', () => {
    const cog = new AgentLoopCognitionDelegate(mockLoop());
    // Should not throw
    cog.postStep({ _expectations: null }, 0, { type: 'code' }, { error: null });
  });

  test('postStep compares expectations', () => {
    let compared = false;
    const loop = mockLoop({
      expectationEngine: {
        compare: () => { compared = true; },
      },
    });
    const cog = new AgentLoopCognitionDelegate(loop);
    const plan = { _expectations: [{ expected: 'pass' }] };
    cog.postStep(plan, 0, { type: 'code' }, { error: null, verification: { status: 'pass' } });
    assert(compared, 'compare should be called');
  });

  // ── consultConsciousness (v7.6.0) ─────────────────────

  test('consultConsciousness returns safe defaults without awareness', () => {
    const cog = new AgentLoopCognitionDelegate(mockLoop());
    const result = cog.consultConsciousness({ title: 'test' });
    assertEqual(result.paused, false);
    assertEqual(result.concerns.length, 0);
    assertEqual(result.valueContext, '');
  });

  test('consultConsciousness delegates to awareness.consult()', () => {
    const loop = mockLoop({
      awareness: {
        consult: (plan) => ({
          paused: true,
          concerns: ['ethical conflict detected'],
          coherence: 0.3,
          mode: 'captured',
          qualia: 'apprehension',
          focus: 'ethical-conflict',
          valueContext: 'safety first',
        }),
      },
    });
    const cog = new AgentLoopCognitionDelegate(loop);
    const result = cog.consultConsciousness({ title: 'dangerous' });
    assertEqual(result.paused, true);
    assertEqual(result.concerns[0], 'ethical conflict detected');
    assertEqual(result.valueContext, 'safety first');
  });

  test('consultConsciousness enriches with valueStore', () => {
    const loop = mockLoop({
      valueStore: {
        getForDomain: (domain) => [
          { name: 'safety', weight: 0.9, description: 'Prioritize safety' },
        ],
      },
    });
    const cog = new AgentLoopCognitionDelegate(loop);
    const result = cog.consultConsciousness({ title: 'deploy', steps: [{ type: 'deploy' }] });
    assert(result.valueContext.includes('safety'), 'should contain value context');
    assert(result.valueContext.includes('90%'), 'should contain weight');
  });

  test('consultConsciousness merges awareness + valueStore context', () => {
    const loop = mockLoop({
      awareness: {
        consult: () => ({
          paused: false, concerns: [], coherence: 1, mode: 'diffuse',
          qualia: null, focus: null, valueContext: 'awareness ctx',
        }),
      },
      valueStore: {
        getForDomain: () => [{ name: 'quality', weight: 0.8, description: 'Code quality' }],
      },
    });
    const cog = new AgentLoopCognitionDelegate(loop);
    const result = cog.consultConsciousness({ title: 'refactor code', steps: [{ type: 'code' }] });
    assert(result.valueContext.includes('awareness ctx'), 'should keep awareness context');
    assert(result.valueContext.includes('quality'), 'should append valueStore context');
  });

  // ── _inferDomain ──────────────────────────────────────

  test('_inferDomain classifies code tasks', () => {
    const cog = new AgentLoopCognitionDelegate(mockLoop());
    assertEqual(cog._inferDomain({ title: 'refactor the parser', steps: [] }), 'code');
    assertEqual(cog._inferDomain({ title: 'test', steps: [{ type: 'implement' }] }), 'code');
  });

  test('_inferDomain classifies deployment tasks', () => {
    const cog = new AgentLoopCognitionDelegate(mockLoop());
    assertEqual(cog._inferDomain({ title: 'deploy to production', steps: [] }), 'deployment');
  });

  test('_inferDomain classifies self-modification', () => {
    const cog = new AgentLoopCognitionDelegate(mockLoop());
    assertEqual(cog._inferDomain({ title: 'self-modify the prompt', steps: [] }), 'self-modification');
  });

  test('_inferDomain defaults to all', () => {
    const cog = new AgentLoopCognitionDelegate(mockLoop());
    assertEqual(cog._inferDomain({ title: 'something else', steps: [] }), 'all');
  });

  // ── _deriveQuality ────────────────────────────────────

  test('_deriveQuality returns 0.9 for pass', () => {
    const cog = new AgentLoopCognitionDelegate(mockLoop());
    assertEqual(cog._deriveQuality({ verification: { status: 'pass' } }), 0.9);
  });

  test('_deriveQuality returns 0.2 for error', () => {
    const cog = new AgentLoopCognitionDelegate(mockLoop());
    assertEqual(cog._deriveQuality({ error: 'boom' }), 0.2);
  });

  test('_deriveQuality returns 0.6 for no verification', () => {
    const cog = new AgentLoopCognitionDelegate(mockLoop());
    assertEqual(cog._deriveQuality({}), 0.6);
  });
});

run();
