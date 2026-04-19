// ============================================================
// GENESIS — manifest/phase5-hexagonal.js
// Phase 5: Hexagonal services (orchestration, memory, collab)
// ============================================================

function phase5(ctx, R) {
  const { rootDir, genesisDir, guard, bus, intervals } = ctx;

  return [
    ['unifiedMemory', {
      phase: 5, deps: ['memory', 'knowledgeGraph', 'eventStore'], tags: ['hexagonal', 'memory'],
      factory: (c) => new (R('UnifiedMemory').UnifiedMemory)({
        bus, memory: c.resolve('memory'),
        knowledgeGraph: c.resolve('knowledgeGraph'),
        embeddingService: c.tryResolve('embeddingService'),
        eventStore: c.resolve('eventStore'),
      }),
    }],

    ['episodicMemory', {
      phase: 5, deps: ['storage'], tags: ['hexagonal', 'memory'],
      factory: (c) => new (R('EpisodicMemory').EpisodicMemory)({
        bus, storage: c.resolve('storage'),
        embeddingService: c.tryResolve('embeddingService'),
        intervals,
      }),
    }],

    ['chatOrchestrator', {
      phase: 5,
      deps: ['intentRouter', 'llm', 'context', 'tools', 'circuitBreaker', 'promptBuilder', 'uncertaintyGuard', 'memory', 'unifiedMemory', 'storage'],
      tags: ['hexagonal'],
      lateBindings: [
        { prop: 'nativeToolUse', service: 'nativeToolUse', optional: true },
        { prop: 'modelRouter', service: 'modelRouter', optional: true },
        { prop: 'episodicMemory', service: 'episodicMemory', optional: true },
        // v6.0.5: Wire proportional intelligence + causal tracing into hot path
        { prop: '_cognitiveBudget', service: 'cognitiveBudget', optional: true },
        { prop: '_provenance', service: 'executionProvenance', optional: true },
        // FIX v6.1.1: Wire learning — record tool outcomes for reuse
        { prop: 'lessonsStore', service: 'lessonsStore', optional: true },
      ],
      factory: (c) => {
        const { lang } = R('Language');
        return new (R('ChatOrchestrator').ChatOrchestrator)({
          bus, lang, intentRouter: c.resolve('intentRouter'),
          model: c.resolve('llm'), context: c.resolve('context'),
          tools: c.resolve('tools'), circuitBreaker: c.resolve('circuitBreaker'),
          promptBuilder: c.resolve('promptBuilder'),
          uncertaintyGuard: c.resolve('uncertaintyGuard'),
          memory: c.resolve('memory'), unifiedMemory: c.resolve('unifiedMemory'),
          storageDir: genesisDir, storage: c.resolve('storage'),
        });
      },
    }],

    ['selfModPipeline', {
      phase: 5,
      deps: ['selfModel', 'llm', 'prompts', 'sandbox', 'reflector', 'skills', 'cloner', 'reasoning', 'hotReloader', 'tools', 'eventStore', 'astDiff'],
      tags: ['hexagonal'],
      // v4.13.1 (Audit P1): Bind VerificationEngine for mandatory code verification
      lateBindings: [
        { prop: 'verifier', service: 'verifier', optional: true },
        // v5.0.0: Genome traits scale circuit breaker; Metabolism gates energy
        { prop: '_genome', service: 'genome', optional: true },
        { prop: '_metabolism', service: 'metabolism', optional: true },
        // v5.1.0 (DI-1): CodeSafety via port instead of direct cross-layer import
        { prop: '_codeSafety', service: 'codeSafety' },
        // v5.5.0: Self-Preservation Invariants — semantic safety analysis
        { prop: '_preservation', service: 'preservation', optional: true },
        // AwarenessPort — coherence-gated self-modification
        { prop: '_awareness', service: 'awareness', optional: true },
        // v7.2.0: IdleMind + Storage — for self-reflect handler
        { prop: '_idleMind', service: 'idleMind', optional: true, expects: ['getStatus', 'readJournal'] },
        { prop: '_storage', service: 'storage', optional: true },
        // v7.2.3: GenesisBackup — snapshot .genesis/ before self-modification writes
        { prop: '_genesisBackup', service: 'genesisBackup', optional: true, expects: ['backup'] },
      ],
      factory: (c) => {
        const { lang } = R('Language');
        return new (R('SelfModificationPipeline').SelfModificationPipeline)({
          bus, lang, selfModel: c.resolve('selfModel'), model: c.resolve('llm'),
          prompts: c.resolve('prompts'), sandbox: c.resolve('sandbox'),
          reflector: c.resolve('reflector'), skills: c.resolve('skills'),
          cloner: c.resolve('cloner'), reasoning: c.resolve('reasoning'),
          hotReloader: c.resolve('hotReloader'), guard,
          tools: c.resolve('tools'), eventStore: c.resolve('eventStore'),
          rootDir, astDiff: c.resolve('astDiff'),
        });
      },
    }],

    ['commandHandlers', {
      phase: 5,
      deps: ['sandbox', 'fileProcessor', 'network', 'analyzer', 'goalStack', 'settings', 'webFetcher', 'shellAgent'],
      tags: ['hexagonal'],
      lateBindings: [
        // v7.1.6: cross-phase P5→P6, optional for graceful degradation
        { prop: 'daemon', service: 'daemon', optional: true },
        { prop: 'idleMind', service: 'idleMind', optional: true },
        { prop: 'skillManager', service: 'skills', optional: true },
        // v7.3.2: P5→P9 for memory-mark / memory-list / memory-veto commands
        { prop: 'coreMemories', service: 'coreMemories', optional: true },
      ],
      factory: (c) => {
        const { lang } = R('Language');
        return new (R('CommandHandlers').CommandHandlers)({
          bus, lang, sandbox: c.resolve('sandbox'), fileProcessor: c.resolve('fileProcessor'),
          network: c.resolve('network'), daemon: null, idleMind: null,
          analyzer: c.resolve('analyzer'), goalStack: c.resolve('goalStack'),
          settings: c.resolve('settings'), webFetcher: c.resolve('webFetcher'),
          shellAgent: c.resolve('shellAgent'),
          mcpClient: c.tryResolve('mcpClient'),
        });
      },
    }],

    ['learningService', {
      phase: 5, deps: ['memory', 'knowledgeGraph', 'eventStore', 'storage'], tags: ['hexagonal'],
      factory: (c) => new (R('LearningService').LearningService)({
        bus, memory: c.resolve('memory'), knowledgeGraph: c.resolve('knowledgeGraph'),
        eventStore: c.resolve('eventStore'), storageDir: genesisDir,
        intervals, storage: c.resolve('storage'),
      }),
    }],

    ['taskDelegation', {
      phase: 5, deps: ['eventStore'], tags: ['collaboration'],
      lateBindings: [
        { prop: 'network', service: 'network' },
        { prop: 'goalStack', service: 'goalStack' },
      ],
      factory: (c) => new (R('TaskDelegation').TaskDelegation)({
        bus, eventStore: c.resolve('eventStore'),
      }),
    }],

    // v4.12.8: PeerConsensus — Vector Clock + LWW state sync
    ['peerConsensus', {
      phase: 5, deps: ['storage', 'eventStore'], tags: ['hexagonal', 'consensus'],
      lateBindings: [
        { prop: 'network', service: 'network', optional: true },
        { prop: 'settings', service: 'settings', optional: true },
        { prop: 'knowledgeGraph', service: 'knowledgeGraph', optional: true },
        { prop: 'schemaStore', service: 'schemaStore', optional: true },
      ],
      factory: (c) => new (R('PeerConsensus').PeerConsensus)({
        bus,
        storage: c.resolve('storage'),
        eventStore: c.resolve('eventStore'),
        config: c.tryResolve('settings')?.get('peer.consensus') || {},
      }),
    }],


  ];
}

module.exports = { phase5 };
