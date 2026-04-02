#!/usr/bin/env node
// ============================================================
// Test: BiologicalAliases.js — alias mapping, lazy loading
// Test: SelfMod genome-scaled circuit breaker threshold
// ============================================================
const { describe, test, assert, assertEqual, run } = require('../harness');

// ════════════════════════════════════════════════════════════
// BIOLOGICAL ALIASES
// ════════════════════════════════════════════════════════════

describe('BiologicalAliases — ALIAS_MAP', () => {
  test('ALIAS_MAP has 11 entries', () => {
    const { ALIAS_MAP } = require('../../src/agent/organism/BiologicalAliases');
    assertEqual(Object.keys(ALIAS_MAP).length, 11);
  });

  test('all mapped values are strings', () => {
    const { ALIAS_MAP } = require('../../src/agent/organism/BiologicalAliases');
    for (const [key, val] of Object.entries(ALIAS_MAP)) {
      assertEqual(typeof val, 'string', `${key} should map to string`);
    }
  });

  test('known aliases exist', () => {
    const { ALIAS_MAP } = require('../../src/agent/organism/BiologicalAliases');
    assertEqual(ALIAS_MAP.Morphogenesis, 'SelfModificationPipeline');
    assertEqual(ALIAS_MAP.CognitiveLoop, 'AgentLoop');
    assertEqual(ALIAS_MAP.Connectome, 'KnowledgeGraph');
    assertEqual(ALIAS_MAP.Reproduction, 'CloneFactory');
    assertEqual(ALIAS_MAP.DriveSystem, 'GoalStack');
    assertEqual(ALIAS_MAP.Colony, 'PeerNetwork');
    assertEqual(ALIAS_MAP.HippocampalBuffer, 'ConversationMemory');
  });
});

describe('BiologicalAliases — Lazy loading', () => {
  test('Morphogenesis resolves to SelfModificationPipeline', () => {
    const aliases = require('../../src/agent/organism/BiologicalAliases');
    const { SelfModificationPipeline } = require('../../src/agent/hexagonal/SelfModificationPipeline');
    assertEqual(aliases.Morphogenesis, SelfModificationPipeline);
  });

  test('CognitiveLoop resolves to AgentLoop', () => {
    const aliases = require('../../src/agent/organism/BiologicalAliases');
    const { AgentLoop } = require('../../src/agent/revolution/AgentLoop');
    assertEqual(aliases.CognitiveLoop, AgentLoop);
  });

  test('DriveSystem resolves to GoalStack', () => {
    const aliases = require('../../src/agent/organism/BiologicalAliases');
    const { GoalStack } = require('../../src/agent/planning/GoalStack');
    assertEqual(aliases.DriveSystem, GoalStack);
  });

  test('Connectome resolves to KnowledgeGraph', () => {
    const aliases = require('../../src/agent/organism/BiologicalAliases');
    const { KnowledgeGraph } = require('../../src/agent/foundation/KnowledgeGraph');
    assertEqual(aliases.Connectome, KnowledgeGraph);
  });
});

// ════════════════════════════════════════════════════════════
// GENOME-SCALED CIRCUIT BREAKER
// ════════════════════════════════════════════════════════════

describe('SelfMod — Genome-scaled circuit breaker', () => {
  function createPipeline(genomeTrait) {
    const events = [];
    const bus = {
      emit: (n, d, m) => events.push({ name: n, data: d }),
      fire: (n, d, m) => events.push({ name: n, data: d }),
      on: () => {},
    };
    const { SelfModificationPipeline } = require('../../src/agent/hexagonal/SelfModificationPipeline');
    const pipeline = new SelfModificationPipeline({
      lang: { t: (k) => k }, bus,
      selfModel: null, model: null, prompts: null, sandbox: null,
      reflector: null, skills: null, cloner: null, reasoning: null,
      hotReloader: null, guard: null, tools: null, eventStore: null,
      rootDir: '/tmp', astDiff: null,
    });
    if (genomeTrait !== undefined) {
      pipeline._genome = { trait: (name) => name === 'riskTolerance' ? genomeTrait : 0.5 };
    }
    return { pipeline, events };
  }

  test('default threshold is 3 without genome', () => {
    const { pipeline } = createPipeline();
    assertEqual(pipeline._getCircuitBreakerThreshold(), 3);
  });

  test('high riskTolerance (0.8) gives threshold ~4-5', () => {
    const { pipeline } = createPipeline(0.8);
    const threshold = pipeline._getCircuitBreakerThreshold();
    assert(threshold >= 4 && threshold <= 5, `expected 4-5, got ${threshold}`);
  });

  test('low riskTolerance (0.2) gives threshold 2', () => {
    const { pipeline } = createPipeline(0.2);
    const threshold = pipeline._getCircuitBreakerThreshold();
    assertEqual(threshold, 2);
  });

  test('minimum threshold is 2', () => {
    const { pipeline } = createPipeline(0.0);
    const threshold = pipeline._getCircuitBreakerThreshold();
    assert(threshold >= 2, `threshold should be at least 2, got ${threshold}`);
  });

  test('circuit breaker freezes at genome-scaled threshold', () => {
    const { pipeline } = createPipeline(0.2); // threshold = 2
    pipeline._recordFailure('fail 1');
    assertEqual(pipeline.getCircuitBreakerStatus().frozen, false);
    pipeline._recordFailure('fail 2');
    assertEqual(pipeline.getCircuitBreakerStatus().frozen, true);
  });

  test('high risk tolerance requires more failures to freeze', () => {
    const { pipeline } = createPipeline(0.8); // threshold = 4-5
    const threshold = pipeline._getCircuitBreakerThreshold();
    for (let i = 0; i < threshold - 1; i++) {
      pipeline._recordFailure(`fail ${i + 1}`);
    }
    assertEqual(pipeline.getCircuitBreakerStatus().frozen, false);
    pipeline._recordFailure('final fail');
    assertEqual(pipeline.getCircuitBreakerStatus().frozen, true);
  });

  test('getCircuitBreakerStatus reports dynamic threshold', () => {
    const { pipeline } = createPipeline(0.6);
    const status = pipeline.getCircuitBreakerStatus();
    assert(status.threshold >= 2 && status.threshold <= 5, `dynamic threshold expected, got ${status.threshold}`);
  });
});

run();
