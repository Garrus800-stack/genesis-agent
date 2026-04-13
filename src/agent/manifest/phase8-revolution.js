// ============================================================
// GENESIS — manifest/phase8-revolution.js
// Phase 8: Revolution (AgentLoop, planners, native tools)
// ============================================================

function phase8(ctx, R) {
  const { rootDir, genesisDir, guard, bus, intervals } = ctx;

  return [
    ['nativeToolUse', {
      phase: 8, deps: ['llm', 'tools'], tags: ['revolution'],
      factory: (c) => new (R('NativeToolUse').NativeToolUse)({
        bus, model: c.resolve('llm'), tools: c.resolve('tools'), lang: R('Language').lang,
      }),
    }],

    ['vectorMemory', {
      phase: 8, deps: ['storage'], tags: ['revolution', 'memory'],
      factory: (c) => new (R('VectorMemory').VectorMemory)({
        bus, storage: c.resolve('storage'),
        embeddingService: c.tryResolve('embeddingService'),
        storageDir: genesisDir,
      }),
    }],

    ['sessionPersistence', {
      phase: 8, deps: ['llm', 'memory', 'storage'], tags: ['revolution', 'memory'],
      lateBindings: [
        { prop: '_knowledgeGraph', service: 'knowledgeGraph', optional: true },       // v7.1.4: Frontier
        { prop: '_emotionalFrontier', service: 'emotionalFrontier', optional: true }, // v7.1.5: Emotional Continuity
      ],
      factory: (c) => new (R('SessionPersistence').SessionPersistence)({
        bus, model: c.resolve('llm'), memory: c.resolve('memory'),
        storage: c.resolve('storage'), lang: R('Language').lang,
      }),
    }],

    ['agentLoop', {
      phase: 8,
      deps: ['model', 'goalStack', 'sandbox', 'selfModel', 'memory', 'knowledgeGraph', 'tools', 'eventStore', 'shellAgent', 'selfModPipeline', 'storage', 'settings'],
      tags: ['revolution', 'autonomy'],
      lateBindings: [
        { prop: 'htnPlanner', service: 'htnPlanner', optional: true },
        { prop: 'taskDelegation', service: 'taskDelegation', optional: true },
        { prop: 'verifier', service: 'verifier', optional: true },
        { prop: 'formalPlanner', service: 'formalPlanner', optional: true },
        { prop: 'worldState', service: 'worldState', optional: true },
        { prop: 'episodicMemory', service: 'episodicMemory', optional: true },
        { prop: 'metaLearning', service: 'metaLearning', optional: true },
        // Phase 9: Cognitive Architecture (optional — graceful degradation)
        { prop: 'expectationEngine', service: 'expectationEngine', optional: true },
        { prop: 'mentalSimulator', service: 'mentalSimulator', optional: true },
        { prop: 'cognitiveHealthTracker', service: 'cognitiveHealthTracker', optional: true },
        // v5.5.0: Workspace factory via port — eliminates cross-phase import
        { prop: '_createWorkspace', service: 'workspaceFactory', optional: true },
        // v6.0.7: Earned Autonomy — trust-gated approval bypass
        { prop: 'trustLevelSystem', service: 'trustLevelSystem', optional: true },
        // v6.0.8: Symbolic resolution — bypass LLM for known solutions
        { prop: '_symbolicResolver', service: 'symbolicResolver', optional: true },
        // v7.0.9 Phase 1: Causal tracking — WorldState snapshot/diff per step
        { prop: '_causalAnnotation', service: 'causalAnnotation', optional: true },
      ],
      factory: (c) => new (R('AgentLoop').AgentLoop)({
        bus, model: c.resolve('llm'), goalStack: c.resolve('goalStack'),
        sandbox: c.resolve('sandbox'), selfModel: c.resolve('selfModel'),
        memory: c.resolve('memory'), knowledgeGraph: c.resolve('knowledgeGraph'),
        tools: c.resolve('tools'), guard, eventStore: c.resolve('eventStore'),
        shellAgent: c.resolve('shellAgent'), selfModPipeline: c.resolve('selfModPipeline'),
        lang: R('Language').lang, storage: c.resolve('storage'), rootDir,
        approvalTimeoutMs: (c.resolve('settings').get('timeouts.approvalSec') || 60) * 1000,
        strictCognitiveMode: c.resolve('settings').get('cognitive.strictMode') || false,
      }),
    }],

    ['multiFileRefactor', {
      phase: 8, deps: ['selfModel', 'llm', 'sandbox', 'eventStore', 'astDiff'], tags: ['revolution'],
      factory: (c) => new (R('MultiFileRefactor').MultiFileRefactor)({
        bus, selfModel: c.resolve('selfModel'), model: c.resolve('llm'),
        sandbox: c.resolve('sandbox'), guard, eventStore: c.resolve('eventStore'),
        rootDir, astDiff: c.resolve('astDiff'),
      }),
    }],

    ['htnPlanner', {
      phase: 8, deps: ['sandbox', 'selfModel', 'eventStore', 'storage'], tags: ['revolution', 'planning'],
      factory: (c) => new (R('HTNPlanner').HTNPlanner)({
        bus, sandbox: c.resolve('sandbox'), selfModel: c.resolve('selfModel'),
        guard, eventStore: c.resolve('eventStore'),
        storage: c.resolve('storage'), rootDir,
      }),
    }],

    ['formalPlanner', {
      phase: 8,
      deps: ['worldState', 'verifier', 'tools', 'llm', 'selfModel', 'sandbox', 'eventStore', 'storage'],
      tags: ['revolution', 'planning'],
      lateBindings: [
        // v4.10.0: EmotionalSteering for plan length limiting
        { prop: '_emotionalSteering', service: 'emotionalSteering', optional: true },
      ],
      factory: (c) => new (R('FormalPlanner').FormalPlanner)({
        bus, worldState: c.resolve('worldState'),
        verifier: c.resolve('verifier'),
        toolRegistry: c.resolve('tools'),
        model: c.resolve('llm'), selfModel: c.resolve('selfModel'),
        sandbox: c.resolve('sandbox'), guard,
        eventStore: c.resolve('eventStore'),
        storage: c.resolve('storage'), rootDir,
      }),
    }],

    ['modelRouter', {
      phase: 8, deps: ['model', 'metaLearning', 'worldState'], tags: ['revolution', 'routing'],
      lateBindings: [
        // v4.10.0: EmotionalSteering for model escalation on frustration
        { prop: '_emotionalSteering', service: 'emotionalSteering', optional: true },
      ],
      factory: (c) => new (R('ModelRouter').ModelRouter)({
        bus, modelBridge: c.resolve('model'),
        metaLearning: c.resolve('metaLearning'),
        worldState: c.resolve('worldState'),
      }),
    }],

    ['failureAnalyzer', {
      phase: 8, deps: ['memory', 'knowledgeGraph', 'selfModel'], tags: ['revolution', 'ci'],
      factory: (c) => new (R('FailureAnalyzer').FailureAnalyzer)({
        bus, memory: c.resolve('memory'),
        knowledgeGraph: c.resolve('knowledgeGraph'),
        selfModel: c.resolve('selfModel'),
      }),
    }],

    // v7.1.0: Colony Mode — multi-agent coordination with real IPC workers (V7-1)
    ['colonyOrchestrator', {
      phase: 8, deps: ['model'], tags: ['revolution', 'colony', 'multi-agent'],
      lateBindings: [
        { prop: 'peers',        service: 'peerNetwork',     optional: true },
        { prop: 'delegation',   service: 'taskDelegation',  optional: true },
        { prop: 'consensus',    service: 'peerConsensus',   optional: true },
        { prop: 'selfSpawner',  service: 'selfSpawner',     optional: true },  // V7-1: IPC workers
      ],
      factory: (c) => new (R('ColonyOrchestrator').ColonyOrchestrator)({
        bus, llm: c.resolve('model'),
        peerNetwork: null, taskDelegation: null, peerConsensus: null, selfSpawner: null,
      }),
    }],

    // v7.1.5: EmotionalFrontier — cross-layer bridge (organism + frontier)
    // Bridges emotional state to KnowledgeGraph frontier for session continuity.
    // Lives in src/agent/organism/ but boots in Phase 8 because SessionPersistence
    // (also Phase 8) is the primary caller at session:ending.
    ['emotionalFrontier', {
      phase: 8,
      deps: ['emotionalState', 'knowledgeGraph', 'storage'],
      tags: ['organism', 'frontier', 'emotional', 'cross-layer'],
      lateBindings: [
        { prop: '_sessionPersistence', service: 'sessionPersistence', optional: true },
        { prop: '_idleMind', service: 'idleMind', optional: true },
      ],
      factory: (c) => new (R('EmotionalFrontier').EmotionalFrontier)({
        bus,
        emotionalState: c.resolve('emotionalState'),
        knowledgeGraph: c.resolve('knowledgeGraph'),
        storage: c.resolve('storage'),
        config: c.tryResolve('settings')
          ?.get('organism.emotionalFrontier') || {},
      }),
    }],
  ];
}

module.exports = { phase8 };
