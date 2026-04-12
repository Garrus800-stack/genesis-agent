const { describe, test, assert, assertEqual, run } = require('../harness');

const { AdaptiveStrategyApplyDelegate, BIAS_HYPOTHESES, STATUS } = require('../../src/agent/cognitive/AdaptiveStrategyApply');
const { AdaptiveStrategy } = require('../../src/agent/cognitive/AdaptiveStrategy');
const { NullBus } = require('../../src/agent/core/EventBus');

function makeParent(overrides = {}) {
  const parent = new AdaptiveStrategy({ bus: NullBus, storage: null });
  Object.assign(parent, overrides);
  return parent;
}

describe('AdaptiveStrategyApply Delegate', () => {

  test('BIAS_HYPOTHESES exports all 4 bias mappings', () => {
    assert(BIAS_HYPOTHESES['scope-underestimate'], 'should have scope-underestimate');
    assert(BIAS_HYPOTHESES['token-overuse'], 'should have token-overuse');
    assert(BIAS_HYPOTHESES['error-repetition'], 'should have error-repetition');
    assert(BIAS_HYPOTHESES['backend-mismatch'], 'should have backend-mismatch');
  });

  test('STATUS exports all 6 states', () => {
    assertEqual(STATUS.PROPOSED, 'proposed');
    assertEqual(STATUS.APPLIED, 'applied');
    assertEqual(STATUS.VALIDATING, 'validating');
    assertEqual(STATUS.CONFIRMED, 'confirmed');
    assertEqual(STATUS.ROLLED_BACK, 'rolled-back');
    assertEqual(STATUS.APPLIED_UNVALIDATED, 'applied-unvalidated');
  });

  test('diagnose returns null without CognitiveSelfModel', () => {
    const parent = makeParent();
    const delegate = new AdaptiveStrategyApplyDelegate(parent);
    const result = delegate.diagnose();
    assertEqual(result, null, 'Should return null without selfModel');
  });

  test('diagnose returns null with insufficient data', () => {
    const parent = makeParent({
      cognitiveSelfModel: {
        getCapabilityProfile: () => ({ 'code-gen': { sampleSize: 3 } }),
        getBiasPatterns: () => [],
        getBackendStrengthMap: () => ({}),
      },
    });
    const delegate = new AdaptiveStrategyApplyDelegate(parent);
    const result = delegate.diagnose();
    assertEqual(result, null, 'Should return null with < 10 samples');
  });

  test('diagnose returns findings with actionable bias', () => {
    const parent = makeParent({
      cognitiveSelfModel: {
        getCapabilityProfile: () => ({
          'code-gen': { sampleSize: 15, isWeak: false, isStrong: false },
        }),
        getBiasPatterns: () => [{ name: 'scope-underestimate', severity: 'high', evidence: 'test' }],
        getBackendStrengthMap: () => ({}),
      },
    });
    const delegate = new AdaptiveStrategyApplyDelegate(parent);
    const result = delegate.diagnose();
    assert(result !== null, 'Should return findings');
    assert(result.biases.length > 0, 'Should have biases');
  });

  test('propose returns null when no candidates', () => {
    const parent = makeParent();
    const delegate = new AdaptiveStrategyApplyDelegate(parent);
    const result = delegate.propose({
      biases: [],
      backendMap: {},
      weaknesses: [],
    });
    assertEqual(result, null);
  });

  test('propose returns prompt-mutation for high-severity bias', () => {
    const parent = makeParent({
      promptEvolution: { getSection: () => ({ text: 'test' }) },
    });
    const delegate = new AdaptiveStrategyApplyDelegate(parent);
    const result = delegate.propose({
      biases: [{ name: 'scope-underestimate', severity: 'high', evidence: 'test evidence' }],
      backendMap: {},
      weaknesses: [],
    });
    assert(result !== null, 'Should return proposal');
    assertEqual(result.type, 'prompt-mutation');
    assertEqual(result.bias, 'scope-underestimate');
    assertEqual(result.priority, 3, 'High severity should be priority 3');
  });

  test('propose returns temp-signal for weak task types', () => {
    const parent = makeParent({
      onlineLearner: { receiveWeaknessSignal: () => {} },
    });
    const delegate = new AdaptiveStrategyApplyDelegate(parent);
    const result = delegate.propose({
      biases: [],
      backendMap: {},
      weaknesses: [['code-gen', { isWeak: true }]],
    });
    assert(result !== null);
    assertEqual(result.type, 'temp-signal');
    assertEqual(result.taskType, 'code-gen');
  });

  test('applyStrategy dispatches prompt-mutation', async () => {
    let experimentStarted = false;
    const parent = makeParent({
      promptEvolution: {
        getSection: () => ({ text: 'original' }),
        startExperiment: async () => { experimentStarted = true; return { variantId: 'v1' }; },
        _experiments: {},
      },
    });
    const delegate = new AdaptiveStrategyApplyDelegate(parent);
    const revert = await delegate.applyStrategy({
      type: 'prompt-mutation',
      section: 'solutions',
      hypothesis: 'test hypothesis',
    });
    assert(experimentStarted, 'Should have called startExperiment');
    assert(typeof revert === 'function', 'Should return revert function');
  });

  test('applyStrategy dispatches backend-routing', async () => {
    let injected = null;
    const parent = makeParent({
      modelRouter: {
        injectEmpiricalStrength: (map) => { injected = map; },
        _empiricalStrength: null,
        _empiricalStrengthAt: 0,
      },
    });
    const delegate = new AdaptiveStrategyApplyDelegate(parent);
    const backendMap = { 'code-gen': { entries: [{ backend: 'claude', confidence: 0.9 }] } };
    const revert = await delegate.applyStrategy({
      type: 'backend-routing',
      backendMap,
    });
    assertEqual(injected, backendMap, 'Should inject backend map');
    assert(typeof revert === 'function', 'Should return revert function');

    // Test revert
    revert();
    assertEqual(parent.modelRouter._empiricalStrength, null, 'Should clear on revert');
  });

  test('applyStrategy dispatches temp-signal', async () => {
    let signalReceived = null;
    const parent = makeParent({
      onlineLearner: {
        receiveWeaknessSignal: (type, isWeak) => { signalReceived = { type, isWeak }; },
      },
    });
    const delegate = new AdaptiveStrategyApplyDelegate(parent);
    const revert = await delegate.applyStrategy({
      type: 'temp-signal',
      taskType: 'code-gen',
      isWeak: true,
    });
    assertEqual(signalReceived.type, 'code-gen');
    assertEqual(signalReceived.isWeak, true);
    assert(typeof revert === 'function');
  });

  test('applyStrategy returns null for unknown type', async () => {
    const parent = makeParent();
    const delegate = new AdaptiveStrategyApplyDelegate(parent);
    const revert = await delegate.applyStrategy({ type: 'unknown' });
    assertEqual(revert, null);
  });

  test('AdaptiveStrategy._applyDelegate is wired on construction', () => {
    const as = new AdaptiveStrategy({ bus: NullBus, storage: null });
    assert(as._applyDelegate instanceof AdaptiveStrategyApplyDelegate,
      '_applyDelegate should be AdaptiveStrategyApplyDelegate');
  });

  test('_hasSignificantBackendDelta detects large delta', () => {
    const parent = makeParent();
    const delegate = new AdaptiveStrategyApplyDelegate(parent);
    const map = {
      'code-gen': {
        entries: [
          { backend: 'claude', confidence: 0.9 },
          { backend: 'gpt-4', confidence: 0.5 },
        ],
      },
    };
    assert(delegate._hasSignificantBackendDelta(map), 'Should detect 40pp delta');
  });

  test('_hasSignificantBackendDelta returns false for small delta', () => {
    const parent = makeParent();
    const delegate = new AdaptiveStrategyApplyDelegate(parent);
    const map = {
      'code-gen': {
        entries: [
          { backend: 'claude', confidence: 0.8 },
          { backend: 'gpt-4', confidence: 0.75 },
        ],
      },
    };
    assert(!delegate._hasSignificantBackendDelta(map), 'Should not detect 5pp delta');
  });

});

run();
