#!/usr/bin/env node
// Test: AdaptiveStrategy.js — Meta-cognitive feedback loop (v6.0.2 V6-12)
const { describe, test, assert, assertEqual, run } = require('../harness');
const { createBus } = require('../../src/agent/core/EventBus');
const { AdaptiveStrategy, BIAS_HYPOTHESES, STATUS, DEFAULTS } = require('../../src/agent/cognitive/AdaptiveStrategy');

// ── Mock factories ──────────────────────────────────────────

function mockStorage() {
  const data = {};
  return {
    readJSON: async (key) => data[key] || null,
    writeJSON: (key, val) => { data[key] = val; },
    writeJSONDebounced: (key, val) => { data[key] = val; },
    _data: data,
  };
}

function mockSelfModel(overrides = {}) {
  return {
    getCapabilityProfile: () => overrides.profile || {
      'code-gen': { successRate: 0.45, confidenceLower: 0.35, sampleSize: 12, isWeak: true, isStrong: false, topErrors: [{ category: 'syntax', count: 5 }], avgTokenCost: 1200, avgDurationMs: 8000 },
      'analysis': { successRate: 0.90, confidenceLower: 0.82, sampleSize: 20, isWeak: false, isStrong: true, topErrors: [], avgTokenCost: 800, avgDurationMs: 3000 },
    },
    getBiasPatterns: () => overrides.biases || [
      { name: 'scope-underestimate', description: 'Tends to underestimate', severity: 'high', evidence: '70% failure on long tasks (n=8)' },
    ],
    getBackendStrengthMap: () => overrides.backendMap || {},
  };
}

function mockPromptEvolution() {
  const calls = [];
  return {
    getSection: (name) => ({ text: `Default text for ${name}`, variantId: null }),
    startExperiment: async (section, text, hypothesis) => {
      calls.push({ section, text, hypothesis });
      return { variantId: `${section}-gen1` };
    },
    _experiments: {},
    _calls: calls,
  };
}

function mockModelRouter() {
  let injected = null;
  return {
    injectEmpiricalStrength: (map) => { injected = map; },
    _empiricalStrength: null,
    _empiricalStrengthAt: 0,
    get _injected() { return injected; },
  };
}

function mockOnlineLearner() {
  const signals = [];
  return {
    receiveWeaknessSignal: (taskType, isWeak) => { signals.push({ taskType, isWeak }); },
    _signals: signals,
  };
}

function createStrategy(overrides = {}) {
  const bus = createBus();
  const storage = mockStorage();
  const strategy = new AdaptiveStrategy({ bus, storage });
  strategy.cognitiveSelfModel = overrides.selfModel || mockSelfModel();
  strategy.promptEvolution = overrides.promptEvolution || mockPromptEvolution();
  strategy.modelRouter = overrides.modelRouter || mockModelRouter();
  strategy.onlineLearner = overrides.onlineLearner || mockOnlineLearner();
  strategy.quickBenchmark = overrides.quickBenchmark || null;
  // Shorten cooldown for tests
  strategy._config.cooldownMs = 100;
  return { strategy, bus, storage };
}

// ── Tests ───────────────────────────────────────────────────

describe('AdaptiveStrategy — Diagnosis', () => {
  test('returns null when SelfModel is not available', async () => {
    const { strategy } = createStrategy();
    strategy.cognitiveSelfModel = null;
    const result = await strategy.runCycle();
    assertEqual(result, null);
  });

  test('returns null when insufficient outcomes', async () => {
    const selfModel = mockSelfModel({
      profile: { 'chat': { successRate: 1, confidenceLower: 0.8, sampleSize: 3, isWeak: false, isStrong: false, topErrors: [] } },
      biases: [],
    });
    const { strategy } = createStrategy({ selfModel });
    strategy._config.minOutcomes = 10;
    const result = await strategy.runCycle();
    assertEqual(result, null);
  });

  test('detects actionable bias and proposes adaptation', async () => {
    const { strategy } = createStrategy();
    const result = await strategy.runCycle();
    assert(result !== null, 'should produce an adaptation');
    assertEqual(result.type, 'prompt-mutation');
    assertEqual(result.bias, 'scope-underestimate');
  });
});

describe('AdaptiveStrategy — Proposal Logic', () => {
  test('maps scope-underestimate to solutions section', () => {
    const mapping = BIAS_HYPOTHESES['scope-underestimate'];
    assertEqual(mapping.section, 'solutions');
    assert(mapping.hypothesis.includes('sub-steps'), 'hypothesis should mention sub-steps');
  });

  test('maps token-overuse to formatting section', () => {
    const mapping = BIAS_HYPOTHESES['token-overuse'];
    assertEqual(mapping.section, 'formatting');
  });

  test('maps error-repetition to metacognition section', () => {
    const mapping = BIAS_HYPOTHESES['error-repetition'];
    assertEqual(mapping.section, 'metacognition');
  });

  test('maps backend-mismatch to optimizer section', () => {
    const mapping = BIAS_HYPOTHESES['backend-mismatch'];
    assertEqual(mapping.section, 'optimizer');
  });

  test('proposes backend-routing when significant delta exists', async () => {
    const selfModel = mockSelfModel({
      biases: [], // no biases → skip prompt mutation
      backendMap: {
        'code-gen': {
          recommended: 'claude',
          entries: [
            { backend: 'claude', confidence: 0.85, sampleSize: 10 },
            { backend: 'ollama', confidence: 0.45, sampleSize: 8 },
          ],
        },
      },
    });
    const { strategy } = createStrategy({ selfModel });
    const result = await strategy.runCycle();
    assert(result !== null, 'should produce an adaptation');
    assertEqual(result.type, 'backend-routing');
  });

  test('proposes temp-signal when weakness detected and no bias', async () => {
    const selfModel = mockSelfModel({
      biases: [],
      backendMap: {},
    });
    const { strategy } = createStrategy({ selfModel, promptEvolution: null });
    const result = await strategy.runCycle();
    assert(result !== null, 'should produce an adaptation');
    assertEqual(result.type, 'temp-signal');
    assertEqual(result.taskType, 'code-gen');
  });
});

describe('AdaptiveStrategy — Apply & Revert', () => {
  test('applies prompt mutation and sets status to applied-unvalidated (no benchmark)', async () => {
    const pe = mockPromptEvolution();
    const { strategy } = createStrategy({ promptEvolution: pe });
    const result = await strategy.runCycle();
    assertEqual(result.status, STATUS.APPLIED_UNVALIDATED);
    assertEqual(pe._calls.length, 1);
    assertEqual(pe._calls[0].section, 'solutions');
  });

  test('applies backend routing injection', async () => {
    const mr = mockModelRouter();
    const selfModel = mockSelfModel({
      biases: [],
      backendMap: {
        'code-gen': {
          recommended: 'claude',
          entries: [
            { backend: 'claude', confidence: 0.85, sampleSize: 10 },
            { backend: 'ollama', confidence: 0.40, sampleSize: 8 },
          ],
        },
      },
    });
    const { strategy } = createStrategy({ selfModel, modelRouter: mr });
    const result = await strategy.runCycle();
    assertEqual(result.type, 'backend-routing');
    assert(mr._injected !== null, 'should have injected strength map');
  });

  test('applies temp signal to OnlineLearner', async () => {
    const ol = mockOnlineLearner();
    const selfModel = mockSelfModel({ biases: [], backendMap: {} });
    const { strategy } = createStrategy({ selfModel, onlineLearner: ol, promptEvolution: null });
    const result = await strategy.runCycle();
    assertEqual(result.type, 'temp-signal');
    assertEqual(ol._signals.length, 1);
    assertEqual(ol._signals[0].taskType, 'code-gen');
    assertEqual(ol._signals[0].isWeak, true);
  });

  test('revert function works for prompt mutation', async () => {
    const pe = mockPromptEvolution();
    const { strategy } = createStrategy({ promptEvolution: pe });
    const result = await strategy.runCycle();
    assert(typeof result.revert === 'function', 'should have revert function');
    pe._experiments['solutions'] = { status: 'running' };
    result.revert();
    assertEqual(pe._experiments['solutions'].status, 'aborted');
  });
});

describe('AdaptiveStrategy — Safety Guards', () => {
  test('respects cooldown between same-type adaptations', async () => {
    const { strategy } = createStrategy();
    strategy._config.cooldownMs = 60_000;
    const result1 = await strategy.runCycle();
    assert(result1 !== null, 'first cycle should work');
    // Clear active to allow second cycle
    strategy._active = [];
    const result2 = await strategy.runCycle();
    // Should skip the same bias due to cooldown
    assert(result2 === null || result2.bias !== result1.bias,
      'should skip same bias due to cooldown');
  });

  test('respects max active adaptations', async () => {
    const { strategy } = createStrategy();
    strategy._config.maxActiveAdaptations = 1;
    await strategy.runCycle();
    assertEqual(strategy._active.length, 1);
    // Second cycle should skip (max active reached)
    const result2 = await strategy.runCycle();
    assertEqual(result2, null);
  });

  test('skips recently rolled-back adaptation', async () => {
    const { strategy } = createStrategy();
    strategy._config.cooldownMs = 60_000;
    // Simulate rolled-back history
    strategy._history.push({
      id: 'adapt_old', type: 'prompt-mutation', bias: 'scope-underestimate',
      status: STATUS.ROLLED_BACK, validatedAt: Date.now(),
    });
    strategy._active = [];
    const result = await strategy.runCycle();
    // Should either skip or pick a different type
    if (result) {
      assert(result.bias !== 'scope-underestimate',
        'should not retry recently rolled-back bias');
    }
  });
});

describe('AdaptiveStrategy — Persistence', () => {
  test('saves and loads history', async () => {
    const { strategy, storage } = createStrategy();
    await strategy.runCycle();
    strategy._saveSync();

    const data = storage._data['adaptive-strategy.json'];
    assert(data !== null, 'should have persisted data');
    assert(data.stats.proposed >= 1, 'should have recorded proposed count');
  });

  test('strips revert function from serialized records', async () => {
    const { strategy } = createStrategy();
    const result = await strategy.runCycle();
    // Move to history
    strategy._active = [];
    strategy._history.push(strategy._serializableRecord(result));
    const serialized = strategy._history[strategy._history.length - 1];
    assertEqual(serialized.revert, undefined, 'revert should not be serialized');
  });
});

describe('AdaptiveStrategy — Events', () => {
  test('emits adaptation:proposed event', async () => {
    const { strategy, bus } = createStrategy();
    let emitted = null;
    bus.on('adaptation:proposed', (data) => { emitted = data; });
    await strategy.runCycle();
    assert(emitted !== null, 'should emit proposed event');
    assert(emitted.id.startsWith('adapt_'), 'id should have correct prefix');
    assertEqual(emitted.type, 'prompt-mutation');
  });

  test('emits adaptation:applied event', async () => {
    const { strategy, bus } = createStrategy();
    let emitted = null;
    bus.on('adaptation:applied', (data) => { emitted = data; });
    await strategy.runCycle();
    assert(emitted !== null, 'should emit applied event');
    assertEqual(emitted.revertAvailable, true);
  });
});

describe('AdaptiveStrategy — Report', () => {
  test('getReport returns structured data', async () => {
    const { strategy } = createStrategy();
    await strategy.runCycle();
    const report = strategy.getReport();
    assert(Array.isArray(report.active), 'should have active array');
    assert(Array.isArray(report.history), 'should have history array');
    assert(typeof report.stats.proposed === 'number', 'should have stats');
    assert(typeof report.generatedAt === 'number', 'should have timestamp');
  });
});

run();
