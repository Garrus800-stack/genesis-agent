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
        // v7.1.6: All cross-phase bindings optional — PromptBuilderSections guards each with try-catch
        { prop: 'skills', service: 'skills', optional: true },
        { prop: 'learningService', service: 'learningService', optional: true },
        { prop: 'unifiedMemory', service: 'unifiedMemory', optional: true },
        { prop: 'anticipator', service: 'anticipator', optional: true },
        { prop: 'solutions', service: 'solutionAccumulator', optional: true },
        { prop: 'optimizer', service: 'selfOptimizer', optional: true },
        { prop: 'mcpClient', service: 'mcpClient', optional: true },
        { prop: 'emotionalState', service: 'emotionalState', optional: true },
        { prop: 'homeostasis', service: 'homeostasis', optional: true },
        { prop: 'needsSystem', service: 'needsSystem', optional: true },
        { prop: 'sessionPersistence', service: 'sessionPersistence', optional: true },
        { prop: 'vectorMemory', service: 'vectorMemory', optional: true },
        { prop: 'worldState', service: 'worldState', optional: true },
        { prop: 'episodicMemory', service: 'episodicMemory', optional: true },
        { prop: 'cognitiveMonitor', service: 'cognitiveMonitor', optional: true },
        // Phase 9: Self-narrative identity injection
        { prop: 'selfNarrative', service: 'selfNarrative', optional: true },
        // v7.6.0: AwarenessPort — single lightweight replacement
        { prop: 'awareness', service: 'awareness', optional: true },
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
        // v5.9.7 (V6-11): Task outcome tracker — empirical performance data
        { prop: 'taskOutcomeTracker', service: 'taskOutcomeTracker', optional: true },
        // v5.9.8 (V6-11): Cognitive self-model — replaces raw stats with calibrated self-awareness
        { prop: 'cognitiveSelfModel', service: 'cognitiveSelfModel', optional: true },
        // v6.0.4: Adaptive prompt optimization — skip/boost sections based on provenance data
        { prop: '_adaptiveStrategy', service: 'adaptivePromptStrategy', optional: true },
        // v6.0.4: Proportional intelligence — skip sections for trivial requests
        { prop: '_cognitiveBudget', service: 'cognitiveBudget', optional: true },
        // v7.0.4: Information sovereignty — disclosure decisions
        { prop: 'disclosurePolicy', service: 'disclosurePolicy', optional: true },
        // v7.0.9: IdleMind — autonomous activity status for honest self-reflection
        { prop: '_idleMind', service: 'idleMind', optional: true },
        // v7.1.5: EmotionalFrontier — emotional memory from recent sessions
        { prop: '_emotionalFrontier', service: 'emotionalFrontier', optional: true },
        // v7.1.6: Frontier writers — persistent self context
        { prop: '_unfinishedWorkFrontier', service: 'unfinishedWorkFrontier', optional: true },
        { prop: '_suspicionFrontier', service: 'suspicionFrontier', optional: true },
        { prop: '_lessonFrontier', service: 'lessonFrontier', optional: true },
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
        // v5.9.8 (V6-5): ConversationCompressor for LLM-based history summarization
        { prop: '_compressor', service: 'conversationCompressor', optional: true },
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
        // v7.0.9 Phase 2: InferenceEngine for causal reasoning
        { prop: '_inferenceEngine', service: 'inferenceEngine', optional: true },
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

    // v6.0.4: Proportional intelligence — skip unnecessary services for simple requests
    ['cognitiveBudget', {
      phase: 2, deps: [], tags: ['intelligence', 'optimization'],
      factory: () => {
        const settings = ctx.settings;
        const config = settings?.get?.('intelligence.cognitiveBudget') || {};
        return new (R('CognitiveBudget').CognitiveBudget)({ bus, config });
      },
    }],

    // v6.0.4: Causal traceability — every response has a provenance chain
    ['executionProvenance', {
      phase: 2, deps: [], tags: ['intelligence', 'observability'],
      lateBindings: [
        { prop: 'cognitiveBudget', service: 'cognitiveBudget', optional: true },
      ],
      factory: () => {
        const settings = ctx.settings;
        const config = settings?.get?.('intelligence.provenance') || {};
        return new (R('ExecutionProvenance').ExecutionProvenance)({ bus, config });
      },
    }],

    // v6.0.4: Self-optimizing prompts — adjusts sections based on empirical success data
    ['adaptivePromptStrategy', {
      phase: 2, deps: [], tags: ['intelligence', 'optimization', 'adaptive'],
      lateBindings: [
        { prop: '_provenance', service: 'executionProvenance', optional: true },
        { prop: '_storage', service: 'storage', optional: true },
      ],
      factory: () => {
        const config = ctx.settings?.get?.('intelligence.adaptivePrompt') || {};
        return new (R('AdaptivePromptStrategy').AdaptivePromptStrategy)({ bus, config });
      },
    }],

    // v6.0.8: Symbolic resolution — bypass LLM for known solutions
    ['symbolicResolver', {
      phase: 2, deps: [], tags: ['intelligence', 'optimization'],
      lateBindings: [
        { prop: 'lessonsStore', service: 'lessonsStore', optional: true },
        { prop: 'schemaStore', service: 'schemaStore', optional: true },
        // v7.0.9 Phase 2: Deterministic inference before LLM
        { prop: '_inferenceEngine', service: 'inferenceEngine', optional: true },
      ],
      factory: () => new (R('SymbolicResolver').SymbolicResolver)({ bus }),
    }],

    // v7.0.4: Information sovereignty — Genesis decides what to share with whom
    ['disclosurePolicy', {
      phase: 2, deps: [], tags: ['intelligence', 'security', 'sovereignty'],
      lateBindings: [
        { prop: 'trustLevelSystem', service: 'trustLevelSystem', optional: true },
        { prop: 'userModel', service: 'userModel', optional: true },
      ],
      factory: () => {
        const ownerName = ctx.settings?.get?.('disclosure.ownerName') || null;
        return new (R('DisclosurePolicy').DisclosurePolicy)({ bus, config: { ownerName } });
      },
    }],
  ];
}

module.exports = { phase2 };
