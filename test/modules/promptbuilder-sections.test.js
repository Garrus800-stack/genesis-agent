// ============================================================
// Test: PromptBuilderSections.js — prototype delegation,
// section method returns, edge cases
// v5.6.0: Extracted from PromptBuilder.js
// ============================================================

const { describe, test, assert, assertEqual, run } = require('../harness');
const { PromptBuilder } = require('../../src/agent/intelligence/PromptBuilder');
const { sections } = require('../../src/agent/intelligence/PromptBuilderSections');

function createBuilder(overrides = {}) {
  return new PromptBuilder({
    selfModel: overrides.selfModel || { getFullModel: () => ({}), getModuleSummary: () => [], getCapabilities: () => [], moduleCount: () => 0 },
    model: overrides.model || { activeModel: 'test-model' },
    skills: overrides.skills || { listSkills: () => [] },
    knowledgeGraph: null,
    memory: overrides.memory || null,
    ...overrides,
  });
}

describe('PromptBuilderSections: Delegation', () => {
  test('sections object exports all expected methods', () => {
    const expected = [
      '_identity', '_formatting', '_capabilities', '_knowledgeContext',
      '_mcpContext', '_sessionContext', '_memoryContext', '_learningContext',
      '_lessonsContext', '_inferCategory', '_solutionContext', '_anticipatorContext',
      '_optimizerContext', '_organismContext', '_safetyContext', '_metacognitiveContext',
      '_selfAwarenessContext', '_knowledgeContextAsync', '_memoryContextAsync',
      '_perceptionContext', '_consciousnessContext', '_valuesContext',
      '_userModelContext', '_bodySchemaContext', '_episodicContext',
      '_architectureContext', '_projectContext', '_taskPerformanceContext',
    ];
    for (const name of expected) {
      assert(typeof sections[name] === 'function', `sections.${name} should be a function`);
    }
    assertEqual(Object.keys(sections).length, expected.length);
  });

  test('prototype delegation attaches methods to PromptBuilder', () => {
    const builder = createBuilder();
    assert(typeof builder._identity === 'function', '_identity should be on instance');
    assert(typeof builder._formatting === 'function', '_formatting should be on instance');
    assert(typeof builder._organismContext === 'function', '_organismContext should be on instance');
    assert(typeof builder._consciousnessContext === 'function', '_consciousnessContext should be on instance');
  });
});

describe('PromptBuilderSections: Identity', () => {
  test('returns default identity without user name', () => {
    const builder = createBuilder();
    const result = builder._identity();
    assert(result.includes('Genesis'), 'should mention Genesis');
    assert(result.includes('Do NOT introduce'), 'should include no-intro rule');
  });

  test('returns personalized identity with user name', () => {
    const builder = createBuilder({
      memory: { db: { semantic: { 'user.name': { value: 'Garrus' } } } },
    });
    const result = builder._identity();
    assert(result.includes('Garrus'), 'should include user name');
  });
});

describe('PromptBuilderSections: Formatting', () => {
  test('returns formatting rules', () => {
    const builder = createBuilder();
    const result = builder._formatting();
    assert(result.includes('RESPONSE RULES'), 'should include rules header');
    assert(result.includes('code blocks'), 'should mention code blocks');
  });

  test('uses PromptEvolution when available', () => {
    const builder = createBuilder();
    builder.promptEvolution = {
      getSection: (name, def) => ({ text: `evolved:${name}` }),
    };
    const result = builder._formatting();
    assertEqual(result, 'evolved:formatting');
  });
});

describe('PromptBuilderSections: Capabilities', () => {
  test('includes model name', () => {
    const builder = createBuilder();
    const result = builder._capabilities();
    assert(result.includes('test-model'), 'should include model name');
  });

  test('mentions tools when skills available', () => {
    const builder = createBuilder({ skills: { listSkills: () => [{ name: 'code' }] } });
    const result = builder._capabilities();
    assert(result.includes('tools available'), 'should mention tools');
  });
});

describe('PromptBuilderSections: Context Methods', () => {
  test('_knowledgeContext returns empty without query', () => {
    const builder = createBuilder();
    assertEqual(builder._knowledgeContext(), '');
  });

  test('_mcpContext returns empty without mcpClient', () => {
    const builder = createBuilder();
    assertEqual(builder._mcpContext(), '');
  });

  test('_sessionContext returns empty without sessionPersistence', () => {
    const builder = createBuilder();
    assertEqual(builder._sessionContext(), '');
  });

  test('_memoryContext returns empty without memory', () => {
    const builder = createBuilder();
    assertEqual(builder._memoryContext(), '');
  });

  test('_learningContext returns empty without learningService', () => {
    const builder = createBuilder();
    assertEqual(builder._learningContext(), '');
  });

  test('_lessonsContext returns empty without lessonsStore', () => {
    const builder = createBuilder();
    assertEqual(builder._lessonsContext(), '');
  });

  test('_solutionContext returns empty without solutions', () => {
    const builder = createBuilder();
    assertEqual(builder._solutionContext(), '');
  });

  test('_anticipatorContext returns empty without anticipator', () => {
    const builder = createBuilder();
    assertEqual(builder._anticipatorContext(), '');
  });

  test('_optimizerContext returns empty without optimizer', () => {
    const builder = createBuilder();
    assertEqual(builder._optimizerContext(), '');
  });

  test('_organismContext returns empty without organism modules', () => {
    const builder = createBuilder();
    assertEqual(builder._organismContext(), '');
  });

  test('_safetyContext returns empty without safety modules', () => {
    const builder = createBuilder();
    assertEqual(builder._safetyContext(), '');
  });

  test('_metacognitiveContext returns empty without cognitiveMonitor', () => {
    const builder = createBuilder();
    assertEqual(builder._metacognitiveContext(), '');
  });

  test('_selfAwarenessContext returns empty without selfNarrative', () => {
    const builder = createBuilder();
    assertEqual(builder._selfAwarenessContext(), '');
  });

  test('_perceptionContext returns empty without worldState', () => {
    const builder = createBuilder();
    assertEqual(builder._perceptionContext(), '');
  });

  test('_consciousnessContext returns empty without consciousness modules', () => {
    const builder = createBuilder();
    assertEqual(builder._consciousnessContext(), '');
  });

  test('_valuesContext returns empty without valueStore', () => {
    const builder = createBuilder();
    assertEqual(builder._valuesContext(), '');
  });

  test('_userModelContext returns empty without userModel', () => {
    const builder = createBuilder();
    assertEqual(builder._userModelContext(), '');
  });

  test('_bodySchemaContext returns empty without bodySchema', () => {
    const builder = createBuilder();
    assertEqual(builder._bodySchemaContext(), '');
  });

  test('_episodicContext returns empty without episodicMemory', () => {
    const builder = createBuilder();
    assertEqual(builder._episodicContext(), '');
  });
});

describe('PromptBuilderSections: _inferCategory', () => {
  test('detects code-gen', () => {
    const builder = createBuilder();
    assertEqual(builder._inferCategory('implement a sorting function'), 'code-gen');
  });

  test('detects refactor', () => {
    const builder = createBuilder();
    assertEqual(builder._inferCategory('refactor the dashboard'), 'refactor');
  });

  test('detects debug', () => {
    const builder = createBuilder();
    assertEqual(builder._inferCategory('fix this error in the parser'), 'debug');
  });

  test('detects testing', () => {
    const builder = createBuilder();
    assertEqual(builder._inferCategory('run tests for EventBus'), 'testing');
  });

  test('returns general for unknown', () => {
    const builder = createBuilder();
    assertEqual(builder._inferCategory('what is the weather today'), 'general');
  });
});

describe('PromptBuilderSections: Organism Context', () => {
  test('includes emotional state when available', () => {
    const builder = createBuilder();
    builder.emotionalState = { buildPromptContext: () => 'MOOD: calm' };
    const result = builder._organismContext();
    assert(result.includes('MOOD: calm'), 'should include emotional state');
  });

  test('includes genome traits', () => {
    const builder = createBuilder();
    builder._genome = {
      getTraits: () => ({ curiosity: 0.8, caution: 0.5, riskTolerance: 0.6 }),
      generation: 3,
    };
    const result = builder._organismContext();
    assert(result.includes('NATURE:'), 'should include nature');
    assert(result.includes('curiosity=0.80'), 'should show curiosity');
  });

  test('includes low energy warning', () => {
    const builder = createBuilder();
    builder._metabolism = {
      getEnergyLevel: () => ({ state: 'low', current: 20, max: 100 }),
    };
    const result = builder._organismContext();
    assert(result.includes('ENERGY LOW'), 'should warn about low energy');
  });
});

describe('PromptBuilderSections: Safety Context', () => {
  test('shows frozen self-modification', () => {
    const builder = createBuilder();
    builder.selfModPipeline = {
      getCircuitBreakerStatus: () => ({ frozen: true, failures: 5, threshold: 3 }),
    };
    const result = builder._safetyContext();
    assert(result.includes('FROZEN'), 'should indicate frozen state');
  });

  test('shows failure count when not frozen', () => {
    const builder = createBuilder();
    builder.selfModPipeline = {
      getCircuitBreakerStatus: () => ({ frozen: false, failures: 2, threshold: 3 }),
    };
    const result = builder._safetyContext();
    assert(result.includes('2/3'), 'should show failure ratio');
  });
});

run();
