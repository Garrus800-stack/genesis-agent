// ============================================================
// GENESIS — manifest/phase7-organism.js
// Phase 7: Organism layer (emotions, homeostasis, needs,
//          metabolism, immune system, effectors)
//
// v4.12.5: Added HomeostasisEffectors (wires correction events),
//          Metabolism (real energy accounting), ImmuneSystem
//          (self-healing). These complete the organism loop:
//          sense → decide → ACT → heal.
// ============================================================

function phase7(ctx, R) {
  const { rootDir, genesisDir, guard, bus, intervals } = ctx;

  return [
    ['emotionalState', {
      phase: 7, deps: ['storage', 'settings'], tags: ['organism'],
      factory: (c) => new (R('EmotionalState').EmotionalState)({
        bus, storage: c.resolve('storage'), intervals,
        config: c.resolve('settings').get('organism.emotions') || {},
      }),
    }],

    ['homeostasis', {
      phase: 7, deps: ['storage', 'emotionalState', 'settings'], tags: ['organism'],
      factory: (c) => new (R('Homeostasis').Homeostasis)({
        bus, storage: c.resolve('storage'), intervals,
        emotionalState: c.resolve('emotionalState'),
        config: c.resolve('settings').get('organism.homeostasis') || {},
      }),
    }],

    ['needsSystem', {
      phase: 7, deps: ['storage', 'emotionalState', 'settings'], tags: ['organism'],
      lateBindings: [
        { prop: 'userModel', service: 'userModel', optional: true },
      ],
      factory: (c) => new (R('NeedsSystem').NeedsSystem)({
        bus, storage: c.resolve('storage'), intervals,
        emotionalState: c.resolve('emotionalState'),
        config: c.resolve('settings').get('organism.needs') || {},
      }),
    }],

    // v4.12.4: BodySchema — embodiment awareness
    ['bodySchema', {
      phase: 7, deps: ['storage'], tags: ['organism', 'embodiment', 'capabilities'],
      lateBindings: [
        { prop: 'tools', service: 'tools', optional: true },
        { prop: 'circuitBreaker', service: 'circuitBreaker', optional: true },
        { prop: 'homeostasis', service: 'homeostasis', optional: true },
        { prop: 'trustLevelSystem', service: 'trustLevelSystem', optional: true },
        { prop: 'mcpClient', service: 'mcpClient', optional: true },
        { prop: 'model', service: 'llm', optional: true },
        { prop: 'effectorRegistry', service: 'effectorRegistry', optional: true },
        { prop: 'embodiedPerception', service: 'embodiedPerception', optional: true },
        // v6.0.5 (V6-10): Real connectivity status from NetworkSentinel
        { prop: 'networkSentinel', service: 'networkSentinel', optional: true },
      ],
      factory: (c) => new (R('BodySchema').BodySchema)({
        bus, storage: c.resolve('storage'),
        config: c.tryResolve('settings')
          ?.get('organism.bodySchema') || {},
      }),
    }],

    // v5.6.0 SA-P4: EmbodiedPerception — UI events as embodied state
    ['embodiedPerception', {
      phase: 7, deps: [], tags: ['organism', 'embodiment', 'perception', 'sa-p4'],
      factory: (c) => new (R('EmbodiedPerception').EmbodiedPerception)({
        bus,
        config: c.tryResolve('settings')
          ?.get('organism.embodiedPerception') || {},
      }),
    }],

    // v4.12.5: HomeostasisEffectors — wires correction events to real actions
    // Homeostasis detects problems; Effectors fix them.
    ['homeostasisEffectors', {
      phase: 7, deps: ['storage'], tags: ['organism', 'homeostasis', 'effectors'],
      lateBindings: [
        { prop: 'llmCache', service: 'llmCache', optional: true },
        { prop: 'knowledgeGraph', service: 'knowledgeGraph', optional: true },
        { prop: 'dynamicContextBudget', service: 'dynamicContextBudget', optional: true },
        { prop: 'vectorMemory', service: 'vectorMemory', optional: true },
        { prop: 'conversationMemory', service: 'memory', optional: true },
        { prop: 'homeostasis', service: 'homeostasis', optional: true },
      ],
      factory: (c) => new (R('HomeostasisEffectors').HomeostasisEffectors)({
        bus, storage: c.resolve('storage'),
        config: c.tryResolve('settings')
          ?.get('organism.effectors') || {},
      }),
    }],

    // v4.12.5: Metabolism — real energy accounting from resource consumption
    ['metabolism', {
      phase: 7, deps: ['storage'], tags: ['organism', 'metabolism', 'energy'],
      lateBindings: [
        { prop: 'emotionalState', service: 'emotionalState', optional: true },
        { prop: 'needsSystem', service: 'needsSystem', optional: true },
        { prop: 'homeostasis', service: 'homeostasis', optional: true },
        // v7.2.2: Migrated from orphaned containerConfig. Without this,
        // genetic 'consolidation' trait had no effect on metabolism regen rate.
        { prop: 'genome', service: 'genome', optional: true },
      ],
      factory: (c) => new (R('Metabolism').Metabolism)({
        bus, storage: c.resolve('storage'), intervals,
        config: c.tryResolve('settings')
          ?.get('organism.metabolism') || {},
      }),
    }],

    // v4.12.5: ImmuneSystem — self-healing from recurring failure patterns
    ['immuneSystem', {
      phase: 7, deps: ['storage'], tags: ['organism', 'immune', 'self-repair'],
      lateBindings: [
        { prop: 'homeostasis', service: 'homeostasis', optional: true },
        { prop: 'emotionalState', service: 'emotionalState', optional: true },
        { prop: 'circuitBreaker', service: 'circuitBreaker', optional: true },
        { prop: 'llmCache', service: 'llmCache', optional: true },
        { prop: 'tools', service: 'tools', optional: true },
        { prop: 'conversationMemory', service: 'memory', optional: true },
        { prop: 'eventStore', service: 'eventStore', optional: true },
      ],
      factory: (c) => new (R('ImmuneSystem').ImmuneSystem)({
        bus, storage: c.resolve('storage'), intervals,
        config: c.tryResolve('settings')
          ?.get('organism.immune') || {},
      }),
    }],

    // v5.0.0: Genome — heritable identity with mutation support
    ['genome', {
      phase: 7, deps: ['storage'], tags: ['organism', 'identity', 'heritable'],
      factory: (c) => new (R('Genome').Genome)({
        bus, storage: c.resolve('storage'),
        config: c.tryResolve('settings')
          ?.get('organism.genome') || {},
      }),
    }],
  ];
}

module.exports = { phase7 };
