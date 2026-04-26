// ============================================================
// GENESIS — manifest/phase10-agency.js
// Phase 10: Persistent Agency
//
// Goal persistence, failure taxonomy, dynamic context,
// emotional steering, local classifier.
// ============================================================

function phase10(ctx, R) {
  const { bus, intervals } = ctx;

  return [
    // ── GoalPersistence — must be after GoalStack (phase 4) ──
    ['goalPersistence', {
      phase: 10,
      deps: ['storage', 'goalStack', 'eventStore'],
      tags: ['planning', 'persistence'],
      lateBindings: [
        { prop: 'agentLoop', service: 'agentLoop', optional: true },
        // v7.4.5 Baustein B: cost summary on goal archive
        { prop: 'costStream', service: 'costStream', optional: true },
      ],
      factory: (c) => new (R('GoalPersistence').GoalPersistence)({
        bus,
        storage: c.resolve('storage'),
        goalStack: c.resolve('goalStack'),
        eventStore: c.resolve('eventStore'),
        config: c.tryResolve('settings')
          ?.get('agency.goalPersistence') || {},
      }),
    }],

    // ── FailureTaxonomy — phase 2 level (used by AgentLoop) ──
    ['failureTaxonomy', {
      phase: 10,
      deps: ['eventStore'],
      tags: ['intelligence', 'error-handling'],
      lateBindings: [
        { prop: 'modelRouter', service: 'modelRouter', optional: true },
        { prop: 'worldState', service: 'worldState', optional: true },
      ],
      factory: (c) => new (R('FailureTaxonomy').FailureTaxonomy)({
        bus,
        eventStore: c.resolve('eventStore'),
        config: c.tryResolve('settings')
          ?.get('agency.failureTaxonomy') || {},
      }),
    }],

    // ── DynamicContextBudget ──
    ['dynamicContextBudget', {
      phase: 10,
      deps: ['storage'],
      tags: ['intelligence', 'context'],
      lateBindings: [
        { prop: 'metaLearning', service: 'metaLearning', optional: true },
      ],
      factory: (c) => new (R('DynamicContextBudget').DynamicContextBudget)({
        bus,
        storage: c.resolve('storage'),
        config: c.tryResolve('settings')
          ?.get('agency.contextBudget') || {},
      }),
    }],

    // v5.9.7 (V6-5): ConversationCompressor — LLM-based context overflow protection
    ['conversationCompressor', {
      phase: 10,
      deps: ['bus'],
      tags: ['intelligence', 'context', 'compression'],
      lateBindings: [
        { prop: 'model', service: 'llm', optional: true },
      ],
      factory: (c) => new (R('ConversationCompressor').ConversationCompressor)({
        bus,
        config: c.tryResolve('settings')
          ?.get('agency.conversationCompressor') || {},
      }),
    }],

    // ── EmotionalSteering ──
    ['emotionalSteering', {
      phase: 10,
      deps: ['emotionalState', 'storage'],
      tags: ['organism', 'steering'],
      lateBindings: [
        { prop: 'modelRouter', service: 'modelRouter', optional: true },
        { prop: 'needsSystem', service: 'needsSystem', optional: true },
        // v7.2.2: Migrated from orphaned containerConfig. Without this,
        // embodiment→steering feedback loop was silently dead (v7.0.3 feature).
        { prop: 'bodySchema', service: 'bodySchema', optional: true },
      ],
      factory: (c) => new (R('EmotionalSteering').EmotionalSteering)({
        bus, intervals,
        emotionalState: c.resolve('emotionalState'),
        storage: c.resolve('storage'),
        config: c.tryResolve('settings')
          ?.get('organism.steering') || {},
      }),
    }],

    // ── LocalClassifier ──
    ['localClassifier', {
      phase: 10,
      deps: ['storage'],
      tags: ['intelligence', 'classification'],
      factory: (c) => new (R('LocalClassifier').LocalClassifier)({
        bus,
        storage: c.resolve('storage'),
        config: c.tryResolve('settings')
          ?.get('agency.localClassifier') || {},
      }),
    }],

    // ── v4.12.4: UserModel — Theory of Mind ──
    ['userModel', {
      phase: 10,
      deps: ['storage'],
      tags: ['intelligence', 'social', 'theory-of-mind'],
      factory: (c) => new (R('UserModel').UserModel)({
        bus,
        storage: c.resolve('storage'),
        config: c.tryResolve('settings')
          ?.get('agency.userModel') || {},
      }),
    }],

    // v5.0.0: FitnessEvaluator — selection pressure via composite scoring
    ['fitnessEvaluator', {
      phase: 10,
      deps: ['eventStore', 'storage'],
      tags: ['organism', 'evolution', 'fitness'],
      lateBindings: [
        { prop: 'genome', service: 'genome', optional: true },
        { prop: 'metabolism', service: 'metabolism', optional: true },
        { prop: 'immuneSystem', service: 'immuneSystem', optional: true },
      ],
      factory: (c) => new (R('FitnessEvaluator').FitnessEvaluator)({
        bus,
        eventStore: c.resolve('eventStore'),
        storage: c.resolve('storage'),
        intervals,
        config: c.tryResolve('settings')
          ?.get('organism.fitness') || {},
      }),
    }],
    // v7.4.5: GoalDriver — orchestrates which goal gets pursued next.
    // Replaces implicit pursue triggers (DaemonController-direct, IdleMind)
    // with one event-driven driver. Listens to boot:complete, goal:added,
    // goal:unblocked, agent-loop:complete, resource:available,
    // permission:granted. Calls agentLoop.pursue(goal) — new object-based
    // signature with backward-compat for pursue(string).
    ['goalDriver', {
      phase: 10,
      deps: ['bus', 'goalStack', 'goalPersistence', 'eventStore', 'settings'],
      tags: ['agency', 'driver'],
      lateBindings: [
        { prop: 'agentLoop', service: 'agentLoop', optional: true,
          expects: ['pursue', 'stop'],
          impact: 'No goal pursuits possible — driver is idle' },
        { prop: 'resourceRegistry', service: 'resourceRegistry',
          optional: true,
          impact: 'No resource pre-checks (default-allow)' },
      ],
      factory: (c) => new (R('GoalDriver').GoalDriver)({
        bus,
        goalStack: c.resolve('goalStack'),
        goalPersistence: c.resolve('goalPersistence'),
        eventStore: c.resolve('eventStore'),
        settings: c.resolve('settings'),
        intervals,
        config: c.tryResolve('settings')
          ?.get('agency.goalDriver') || {},
      }),
    }],

  ];
}

module.exports = { phase10 };
