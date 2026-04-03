// ============================================================
// GENESIS — manifest/phase9-cognitive.js
// Phase 9: Cognitive Architecture
//
// Expectation, Simulation, Surprise — the cognitive loop.
// DreamCycle and SelfNarrative are planned for Sprint 4-5
// and will be added to this manifest when ready.
//
// All services are optional — Genesis runs identically without
// Phase 9. Every lateBinding uses optional: true. Every hook
// in AgentLoop checks for null before calling.
// ============================================================

function phase9(ctx, R) {
  const { bus, intervals } = ctx;

  return [
    // ── CognitiveHealthTracker — must be FIRST in Phase 9 ──
    // All other Phase 9 services can use it for resilience.
    ['cognitiveHealthTracker', {
      phase: 9,
      deps: ['storage', 'eventStore'],
      tags: ['cognitive', 'health'],
      factory: (c) => new (R('CognitiveHealthTracker').CognitiveHealthTracker)({
        bus,
        storage: c.resolve('storage'),
        eventStore: c.resolve('eventStore'),
        config: c.tryResolve('settings')
          ?.get('cognitive.healthTracker') || {},
      }),
    }],

    ['expectationEngine', {
      phase: 9,
      deps: ['metaLearning', 'schemaStore', 'worldState', 'storage'],
      tags: ['cognitive', 'prediction'],
      factory: (c) => new (R('ExpectationEngine').ExpectationEngine)({
        bus,
        metaLearning: c.resolve('metaLearning'),
        schemaStore: c.resolve('schemaStore'),
        worldState: c.resolve('worldState'),
        storage: c.resolve('storage'),
        config: c.tryResolve('settings')
          ?.get('cognitive.expectations') || {},
      }),
    }],

    ['surpriseAccumulator', {
      phase: 9,
      deps: ['episodicMemory', 'eventStore', 'storage'],
      tags: ['cognitive', 'learning'],
      factory: (c) => new (R('SurpriseAccumulator').SurpriseAccumulator)({
        bus,
        episodicMemory: c.resolve('episodicMemory'),
        eventStore: c.resolve('eventStore'),
        storage: c.resolve('storage'),
        intervals,
        config: c.tryResolve('settings')
          ?.get('cognitive.surprise') || {},
      }),
    }],

    ['mentalSimulator', {
      phase: 9,
      deps: ['worldState', 'expectationEngine', 'storage'],
      tags: ['cognitive', 'simulation'],
      factory: (c) => new (R('MentalSimulator').MentalSimulator)({
        bus,
        worldState: c.resolve('worldState'),
        expectationEngine: c.resolve('expectationEngine'),
        storage: c.resolve('storage'),
        config: c.tryResolve('settings')
          ?.get('cognitive.simulation') || {},
      }),
    }],

    ['dreamCycle', {
      phase: 9,
      deps: ['episodicMemory', 'schemaStore', 'knowledgeGraph',
             'metaLearning', 'model', 'eventStore', 'storage'],
      tags: ['cognitive', 'consolidation'],
      lateBindings: [
        { prop: 'surpriseAccumulator', service: 'surpriseAccumulator', optional: true },
        { prop: 'valueStore', service: 'valueStore', optional: true },
      ],
      factory: (c) => new (R('DreamCycle').DreamCycle)({
        bus,
        episodicMemory: c.resolve('episodicMemory'),
        schemaStore: c.resolve('schemaStore'),
        knowledgeGraph: c.resolve('knowledgeGraph'),
        metaLearning: c.resolve('metaLearning'),
        model: c.resolve('llm'),
        eventStore: c.resolve('eventStore'),
        storage: c.resolve('storage'),
        intervals,
        config: c.tryResolve('settings')
          ?.get('cognitive.dreams') || {},
      }),
    }],

    ['selfNarrative', {
      phase: 9,
      deps: ['metaLearning', 'episodicMemory', 'emotionalState',
             'schemaStore', 'selfModel', 'model', 'storage'],
      tags: ['organism', 'identity', 'cognitive'],
      lateBindings: [
        { prop: 'surpriseAccumulator', service: 'surpriseAccumulator', optional: true },
      ],
      factory: (c) => new (R('SelfNarrative').SelfNarrative)({
        bus,
        metaLearning: c.resolve('metaLearning'),
        episodicMemory: c.resolve('episodicMemory'),
        emotionalState: c.resolve('emotionalState'),
        schemaStore: c.resolve('schemaStore'),
        selfModel: c.resolve('selfModel'),
        model: c.resolve('llm'),
        storage: c.resolve('storage'),
        intervals,
        config: c.tryResolve('settings')
          ?.get('cognitive.selfNarrative') || {},
      }),
    }],

    // v5.0.0: EpigeneticLayer — experience-driven trait modification
    ['epigeneticLayer', {
      phase: 9, deps: ['eventStore', 'storage'], tags: ['organism', 'epigenetic', 'conditioning'],
      lateBindings: [
        { prop: 'genome', service: 'genome' },
        { prop: 'dreamCycle', service: 'dreamCycle', optional: true },
      ],
      factory: (c) => new (R('EpigeneticLayer').EpigeneticLayer)({
        bus,
        eventStore: c.resolve('eventStore'),
        storage: c.resolve('storage'),
      }),
    }],

    // v5.2.0: PromptEvolution — A/B testing for prompt template sections
    ['promptEvolution', {
      phase: 9, deps: ['storage', 'metaLearning'], tags: ['cognitive', 'learning'],
      lateBindings: [
        { prop: 'moduleSigner', service: 'moduleSigner', optional: true },
        { prop: 'model', service: 'model', optional: true },
      ],
      factory: (c) => new (R('PromptEvolution').PromptEvolution)({
        bus,
        storage: c.resolve('storage'),
        metaLearning: c.resolve('metaLearning'),
      }),
    }],

    // v5.3.0 (SA-P5): OnlineLearner — real-time learning from every step
    ['onlineLearner', {
      phase: 9, deps: ['bus'], tags: ['cognitive', 'learning', 'online'],
      lateBindings: [
        { prop: 'metaLearning', service: 'metaLearning', optional: true },
        { prop: 'promptEvolution', service: 'promptEvolution', optional: true },
        { prop: 'modelRouter', service: 'modelRouter', optional: true },
        { prop: 'emotionalState', service: 'emotionalState', optional: true },
      ],
      factory: () => new (R('OnlineLearner').OnlineLearner)({
        bus,
        config: ctx.guard ? {} : {},
      }),
    }],

    // v5.3.0 (SA-P7): LessonsStore — cross-project persistent learning
    ['lessonsStore', {
      phase: 9, deps: ['bus'], tags: ['cognitive', 'learning', 'persistent'],
      factory: () => new (R('LessonsStore').LessonsStore)({
        bus,
      }),
    }],

    // v5.5.0: ReasoningTracer — collects causal reasoning traces for Dashboard
    ['reasoningTracer', {
      phase: 9, deps: [], tags: ['cognitive', 'observability'],
      lateBindings: [
        { prop: '_correlationCtx', service: 'correlationContext', optional: true },
      ],
      factory: () => new (R('ReasoningTracer').ReasoningTracer)({
        bus,
      }),
    }],

    // v5.5.0: WorkspaceFactory — injects CognitiveWorkspace constructor into AgentLoop
    // via late-binding, eliminating the cross-phase import (revolution→cognitive).
    ['workspaceFactory', {
      phase: 9, deps: [], tags: ['cognitive', 'port'],
      factory: () => {
        const { CognitiveWorkspace } = R('CognitiveWorkspace');
        return (opts) => new CognitiveWorkspace(opts);
      },
    }],
    // v5.7.0 (SA-P3): ArchitectureReflection — live queryable architecture model
    ['architectureReflection', {
      phase: 9, deps: ['selfModel'], tags: ['cognitive', 'reflection'],
      lateBindings: [
        { prop: 'knowledgeGraph', service: 'knowledgeGraph', optional: true },
      ],
      factory: (c) => new (R('ArchitectureReflection').ArchitectureReflection)({
        bus,
        selfModel: c.resolve('selfModel'),
        config: c.tryResolve('settings')
          ?.get('cognitive.architectureReflection') || {},
      }),
    }],

    // v5.7.0 (SA-P8): DynamicToolSynthesis — generates tools on demand
    ['dynamicToolSynthesis', {
      phase: 9, deps: ['storage'], tags: ['cognitive', 'tools', 'synthesis'],
      lateBindings: [
        { prop: 'llm', service: 'llm', optional: true },
        { prop: 'toolRegistry', service: 'toolRegistry', optional: true },
        { prop: 'sandbox', service: 'sandbox', optional: true },
        { prop: 'codeSafety', service: 'codeSafety', optional: true },
      ],
      factory: (c) => new (R('DynamicToolSynthesis').DynamicToolSynthesis)({
        bus,
        storage: c.resolve('storage'),
        config: c.tryResolve('settings')
          ?.get('cognitive.toolSynthesis') || {},
      }),
    }],

    // v5.7.0: ProjectIntelligence — deep project understanding
    ['projectIntelligence', {
      phase: 9, deps: ['storage'], tags: ['cognitive', 'project'],
      lateBindings: [
        { prop: 'selfModel', service: 'selfModel', optional: true },
      ],
      factory: (c) => new (R('ProjectIntelligence').ProjectIntelligence)({
        bus,
        storage: c.resolve('storage'),
        config: c.tryResolve('settings')
          ?.get('cognitive.projectIntelligence') || {},
      }),
    }],

    // v5.9.7 (V6-11): TaskOutcomeTracker — SelfModel data collection layer
    ['taskOutcomeTracker', {
      phase: 9, deps: ['bus'], tags: ['cognitive', 'learning', 'selfmodel'],
      lateBindings: [
        { prop: 'storage', service: 'storage', optional: true },
      ],
      factory: () => new (R('TaskOutcomeTracker').TaskOutcomeTracker)({
        bus,
      }),
    }],

    // v5.9.8 (V6-11): CognitiveSelfModel — empirical capability self-awareness
    ['cognitiveSelfModel', {
      phase: 9, deps: ['bus'], tags: ['cognitive', 'selfmodel', 'v6-11'],
      lateBindings: [
        { prop: 'taskOutcomeTracker', service: 'taskOutcomeTracker', optional: true },
        { prop: 'lessonsStore', service: 'lessonsStore', optional: true },
        { prop: 'reasoningTracer', service: 'reasoningTracer', optional: true },
      ],
      factory: (c) => new (R('CognitiveSelfModel').CognitiveSelfModel)({
        bus,
        config: c.tryResolve('settings')
          ?.get('cognitive.selfModel') || {},
      }),
    }],
  ];
}

module.exports = { phase9 };
