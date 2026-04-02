// ============================================================
// GENESIS — manifest/phase2-intelligence.js
// Phase 2: Intelligence services
// ============================================================

function phase2(ctx, R) {
  const { rootDir, genesisDir, guard, bus, intervals } = ctx;
  const { CIRCUIT } = require('../core/Constants');

  return [
    ['intentRouter', {
      phase: 2, deps: [], tags: ['intelligence'],
      lateBindings: [
        // v4.10.0: LocalClassifier for fast intent classification
        { prop: '_localClassifier', service: 'localClassifier', optional: true },
      ],
      factory: () => new (R('IntentRouter').IntentRouter)({ bus }),
    }],

    ['tools', {
      phase: 2, deps: [], tags: ['intelligence'],
      lateBindings: [
        // v5.7.0 SA-P8: Auto-synthesize missing tools on first call
        { prop: '_toolSynthesis', service: 'dynamicToolSynthesis', optional: true },
      ],
      factory: () => {
        const { lang } = R('Language');
        return new (R('ToolRegistry').ToolRegistry)({ bus, lang });
      },
    }],

    ['workerPool', {
      phase: 2, deps: [], tags: ['intelligence'],
      factory: () => new (R('WorkerPool').WorkerPool)({ bus }),
    }],

    ['promptBuilder', {
      phase: 2,
      deps: ['selfModel', 'llm', 'knowledgeGraph', 'memory'],
      tags: ['intelligence'],
      lateBindings: [
        { prop: 'skills', service: 'skills' },
        { prop: 'learningService', service: 'learningService' },
        { prop: 'unifiedMemory', service: 'unifiedMemory' },
        { prop: 'anticipator', service: 'anticipator' },
        { prop: 'solutions', service: 'solutionAccumulator' },
        { prop: 'optimizer', service: 'selfOptimizer' },
        { prop: 'mcpClient', service: 'mcpClient', optional: true },
        { prop: 'emotionalState', service: 'emotionalState' },
        { prop: 'homeostasis', service: 'homeostasis' },
        { prop: 'needsSystem', service: 'needsSystem' },
        { prop: 'sessionPersistence', service: 'sessionPersistence' },
        { prop: 'vectorMemory', service: 'vectorMemory' },
        { prop: 'worldState', service: 'worldState', optional: true },
        { prop: 'episodicMemory', service: 'episodicMemory', optional: true },
        { prop: 'cognitiveMonitor', service: 'cognitiveMonitor', optional: true },
        // Phase 9: Self-narrative identity injection
        { prop: 'selfNarrative', service: 'selfNarrative', optional: true },
        // Phase 13: Consciousness substrate
        { prop: 'phenomenalField', service: 'phenomenalField', optional: true },
        { prop: 'attentionalGate', service: 'attentionalGate', optional: true },
        { prop: 'temporalSelf', service: 'temporalSelf', optional: true },
        { prop: 'introspectionEngine', service: 'introspectionEngine', optional: true },
        { prop: 'consciousnessExtension', service: 'consciousnessExtension', optional: true },
        // v4.12.4: New cognitive modules
        { prop: 'valueStore', service: 'valueStore', optional: true },
        { prop: 'userModel', service: 'userModel', optional: true },
        { prop: 'bodySchema', service: 'bodySchema', optional: true },
        // v4.12.5: Organism steering + immune context
        { prop: 'emotionalSteering', service: 'emotionalSteering', optional: true },
        { prop: 'immuneSystem', service: 'immuneSystem', optional: true },
        // v4.12.8: Safety context — selfmod circuit breaker + error trends
        { prop: 'selfModPipeline', service: 'selfModPipeline', optional: true },
        { prop: 'errorAggregator', service: 'errorAggregator', optional: true },
        // v5.0.0: Genome traits + Metabolism energy state
        { prop: '_genome', service: 'genome', optional: true },
        { prop: '_metabolism', service: 'metabolism', optional: true },
        // v5.2.0: Prompt Evolution — A/B testing for prompt sections
        { prop: 'promptEvolution', service: 'promptEvolution', optional: true },
        // v5.3.0 (SA-P7): Cross-project lessons
        { prop: 'lessonsStore', service: 'lessonsStore', optional: true },
        // v5.7.0 (SA-P3): Architecture self-reflection
        { prop: 'architectureReflection', service: 'architectureReflection', optional: true },
        // v5.7.0: Project intelligence
        { prop: 'projectIntelligence', service: 'projectIntelligence', optional: true },
      ],
      factory: (c) => new (R('PromptBuilder').PromptBuilder)({
        selfModel: c.resolve('selfModel'), model: c.resolve('llm'),
        skills: null, knowledgeGraph: c.resolve('knowledgeGraph'), memory: c.resolve('memory'),
      }),
    }],

    ['context', {
      phase: 2, deps: ['model', 'selfModel', 'memory'], tags: ['intelligence'],
      lateBindings: [
        // v4.10.0: DynamicContextBudget for intent-based allocation
        { prop: '_dynamicBudget', service: 'dynamicContextBudget', optional: true },
      ],
      factory: (c) => {
        // FIX v3.5.4: Pass lang for accurate token estimation
        const cm = new (R('ContextManager').ContextManager)(
          c.resolve('llm'), c.resolve('selfModel'), c.resolve('memory'), bus, c.resolve('lang')
        );
        cm.configureForModel(c.resolve('llm').activeModel);
        return cm;
      },
    }],

    ['reasoning', {
      phase: 2, deps: ['llm', 'prompts', 'tools'], tags: ['intelligence'],
      lateBindings: [
        // v4.10.0: GraphReasoner for deterministic structural queries
        { prop: '_graphReasoner', service: 'graphReasoner', optional: true },
      ],
      factory: (c) => new (R('ReasoningEngine').ReasoningEngine)(
        c.resolve('llm'), c.resolve('prompts'), c.resolve('tools'), bus
      ),
    }],

    ['analyzer', {
      phase: 2, deps: ['selfModel', 'llm', 'prompts'], tags: ['intelligence'],
      factory: (c) => new (R('CodeAnalyzer').CodeAnalyzer)(
        c.resolve('selfModel'), c.resolve('llm'), c.resolve('prompts')
      ),
    }],

    ['circuitBreaker', {
      phase: 2, deps: [], tags: ['intelligence', 'resilience'],
      factory: () => new (R('CircuitBreaker').CircuitBreaker)({
        bus, name: 'llm',
        failureThreshold: CIRCUIT.FAILURE_THRESHOLD,
        cooldownMs: CIRCUIT.COOLDOWN_MS,
        timeoutMs: CIRCUIT.TIMEOUT_MS,
        maxRetries: CIRCUIT.MAX_RETRIES,
      }),
    }],

    ['verifier', {
      phase: 2, deps: [], tags: ['intelligence', 'verification'],
      lateBindings: [
        { prop: 'worldState', service: 'worldState', optional: true },
      ],
      factory: () => new (R('VerificationEngine').VerificationEngine)({
        bus, rootDir,
      }),
    }],

    // FIX v5.1.0 (DI-1): CodeSafetyPort adapter — wraps the raw scanner
    // in a proper port interface so consumers depend on ports/, not on
    // intelligence/ directly. Eliminates all non-core cross-layer coupling.
    // v5.2.0: Scanner passed via R() — port no longer does cross-layer require.
    ['codeSafety', {
      phase: 2, deps: [], tags: ['intelligence', 'security', 'port'],
      factory: () => {
        const { CodeSafetyAdapter } = require('../ports/CodeSafetyPort');
        return CodeSafetyAdapter.fromScanner(R('CodeSafetyScanner'));
      },
    }],
  ];
}

module.exports = { phase2 };
