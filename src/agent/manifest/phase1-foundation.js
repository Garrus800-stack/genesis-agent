// ============================================================
// GENESIS — manifest/phase1-foundation.js
// Phase 1: Foundation services + Port adapters
// ============================================================

/**
 * @param {object} ctx - Boot context
 * @param {Function} R - Module resolver
 * @returns {Array<[string, object]>}
 */
function phase1(ctx, R) {
  const { rootDir, genesisDir, guard, bus, intervals } = ctx;

  return [

    // ════════════════════════════════════════════════════
    // PHASE 1: FOUNDATION
    // ════════════════════════════════════════════════════

    ['settings', {
      phase: 1, deps: ['storage'], tags: ['foundation'],
      factory: (c) => new (R('Settings').Settings)(genesisDir, c.resolve('storage')),
    }],

    ['selfModel', {
      phase: 1, deps: [], tags: ['foundation'],
      factory: () => new (R('SelfModel').SelfModel)(rootDir, guard),
    }],

    // v7.3.6 #2: Self-Gate — telemetry on self-actions. No deps;
    // takes bus + (optionally) gateStats. Records observations;
    // does not block.
    ['selfGate', {
      phase: 1, deps: [], tags: ['foundation', 'safety'],
      lateBindings: [
        { prop: 'gateStats', service: 'gateStats', optional: true },
      ],
      factory: () => new (R('self-gate').SelfGate)({ bus, mode: 'warn' }),
    }],

    // v7.2.3: GenesisBackup — standalone backup system for .genesis/ folder.
    // Not an extension of SnapshotManager (which handles source code via Git);
    // this handles identity data via copy-to-sibling-folder.
    // Triggers: boot-if-stale, pre-self-mod, pre-recovery, shutdown.
    // See docs/ONTOGENESIS.md for why .genesis/ identity matters.
    ['genesisBackup', {
      phase: 1, deps: [], tags: ['foundation', 'safety', 'identity'],
      factory: () => new (R('GenesisBackup').GenesisBackup)({
        genesisDir, rootDir, bus,
      }),
    }],

    ['model', {
      phase: 1, deps: ['settings'], tags: ['foundation'],
      lateBindings: [
        { prop: 'metaLearning', service: 'metaLearning', optional: true },
      ],
      factory: (c) => {
        const mb = new (R('ModelBridge').ModelBridge)({ bus });
        mb._settings = c.resolve('settings');
        return mb;
      },
    }],

    // v5.2.0: Expose ModelBridge's internal LLMCache as a container service.
    // HomeostasisEffectors.prune-caches needs to call llmCache.clear().
    // Previously a phantom late-binding (referenced but never registered).
    ['llmCache', {
      phase: 1, deps: ['model'], tags: ['foundation', 'cache'],
      factory: (c) => c.resolve('model')._cache,
    }],

    ['prompts', {
      phase: 1, deps: [], tags: ['foundation'],
      factory: () => new (R('PromptEngine').PromptEngine)(),
    }],

    ['sandbox', {
      phase: 1, deps: [], tags: ['foundation'],
      // FIX v5.1.0 (A-1): Scanner injected via late-binding instead of direct require.
      // Eliminates the cross-phase coupling (foundation phase 1 → intelligence phase 2).
      lateBindings: [
        { prop: '_codeSafety', service: 'codeSafety', optional: true },
      ],
      factory: () => new (R('Sandbox').Sandbox)(rootDir),
    }],

    ['memory', {
      phase: 1, deps: ['storage'], tags: ['foundation', 'memory'],
      factory: (c) => new (R('ConversationMemory').ConversationMemory)(genesisDir, bus, c.resolve('storage')),
    }],

    ['eventStore', {
      phase: 1, deps: ['storage'], tags: ['foundation'],
      factory: (c) => {
        const es = new (R('EventStore').EventStore)(genesisDir, bus, c.resolve('storage'));
        es.installDefaults();
        return es;
      },
    }],

    ['knowledgeGraph', {
      phase: 1, deps: ['storage'], tags: ['foundation', 'knowledge'],
      factory: (c) => new (R('KnowledgeGraph').KnowledgeGraph)({ bus, storage: c.resolve('storage') }),
    }],

    ['capabilityGuard', {
      phase: 1, deps: [], tags: ['foundation', 'security'],
      factory: () => new (R('CapabilityGuard').CapabilityGuard)(rootDir, guard, bus),
    }],

    ['astDiff', {
      phase: 1, deps: [], tags: ['foundation'],
      factory: () => new (R('ASTDiff').ASTDiff)({ bus }),
    }],

    ['webFetcher', {
      phase: 1, deps: [], tags: ['foundation'],
      factory: () => new (R('WebFetcher').WebFetcher)({ bus }),
    }],

    ['uncertaintyGuard', {
      phase: 1, deps: ['memory', 'knowledgeGraph'], tags: ['foundation'],
      factory: (c) => new (R('UncertaintyGuard').UncertaintyGuard)({
        bus, memory: c.resolve('memory'), knowledgeGraph: c.resolve('knowledgeGraph'),
      }),
    }],

    ['embeddingService', {
      phase: 1, deps: ['memory', 'knowledgeGraph'], tags: ['foundation'], optional: true,
      factory: (c) => {
        const emb = new (R('EmbeddingService').EmbeddingService)({ bus });
        emb._memory = c.resolve('memory');
        emb._knowledgeGraph = c.resolve('knowledgeGraph');
        return emb;
      },
    }],

    ['worldState', {
      phase: 1, deps: ['storage', 'settings'], tags: ['foundation', 'perception'],
      factory: (c) => new (R('WorldState').WorldState)({
        bus, storage: c.resolve('storage'), rootDir,
        settings: c.resolve('settings'), guard,
      }),
    }],

    ['desktopPerception', {
      phase: 1, deps: ['worldState'], tags: ['foundation', 'perception'],
      factory: (c) => new (R('DesktopPerception').DesktopPerception)({
        bus, worldState: c.resolve('worldState'), rootDir, intervals,
      }),
    }],

    // v4.0.0: Module Signing — HMAC-SHA256 integrity for self-modified files
    ['moduleSigner', {
      phase: 1, deps: ['storage'], tags: ['foundation', 'security'],
      factory: (c) => new (R('ModuleSigner').ModuleSigner)({
        bus, storage: c.resolve('storage'), guard, rootDir,
      }),
    }],

    // ── PORTS (Hexagonal Architecture adapters) ──────────

    ['llm', {
      phase: 1, deps: ['model'], tags: ['port', 'foundation'],
      lateBindings: [
        // v7.2.2: Migrated from orphaned containerConfig. Without this,
        // cost budget checks were silently dead — _costGuard was always null.
        { prop: '_costGuard', service: 'costGuard', optional: true },
      ],
      factory: (c) => {
        const { ModelBridgeAdapter } = require('../ports/LLMPort');
        return new ModelBridgeAdapter(c.resolve('model'), bus);
      },
    }],

    ['mem', {
      phase: 1, deps: ['memory'], tags: ['port', 'foundation'],
      factory: (c) => {
        const { ConversationMemoryAdapter } = require('../ports/MemoryPort');
        return new ConversationMemoryAdapter(c.resolve('memory'));
      },
    }],

    ['kg', {
      phase: 1, deps: ['knowledgeGraph'], tags: ['port', 'foundation'],
      factory: (c) => {
        const { KnowledgeGraphAdapter } = require('../ports/KnowledgePort');
        return new KnowledgeGraphAdapter(c.resolve('knowledgeGraph'));
      },
    }],

    ['sbx', {
      phase: 1, deps: ['sandbox'], tags: ['port', 'foundation'],
      factory: (c) => {
        const { SandboxAdapter } = require('../ports/SandboxPort');
        return new SandboxAdapter(c.resolve('sandbox'));
      },
    }],

    // v4.12.8: BootTelemetry — now registered in manifest (was missing).
    // Default enabled:true — local-only, never sent anywhere.
    ['telemetry', {
      phase: 1, deps: ['storage'], tags: ['monitoring'],
      lateBindings: [
        { prop: '_settings', service: 'settings', optional: true },
      ],
      factory: (c) => new (R('BootTelemetry').BootTelemetry)({
        storage: c.resolve('storage'), bus, enabled: true,
      }),
    }],

    // v5.5.0: Self-Preservation Invariants — semantic safety rules
    // preventing self-modification from weakening safety systems.
    ['preservation', {
      phase: 1, deps: [], tags: ['safety', 'core'],
      factory: () => new (R('PreservationInvariants').PreservationInvariants)({ bus }),
    }],

    // v6.0.1: CostGuard — session/daily LLM token budget cap
    ['costGuard', {
      phase: 1, deps: [], tags: ['safety', 'cost'],
      lateBindings: [
        { prop: '_settings', service: 'settings', optional: true },
      ],
      factory: () => new (R('CostGuard').CostGuard)({ bus }),
    }],

    // AwarenessPort — lightweight replacement for 14-module
    // Consciousness Layer. NullAwareness is the default no-op impl.
    // A real implementation can be swapped in via DI.
    ['awareness', {
      phase: 1, deps: [], tags: ['foundation', 'awareness'],
      factory: () => new (R('NullAwareness').NullAwareness)({ bus }),
    }],
  ];
}

module.exports = { phase1 };
