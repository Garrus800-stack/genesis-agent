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
        // v7.3.3: Phase-6 goal review — optional, cross-phase P9→P4
        { prop: 'goalStack', service: 'goalStack', optional: true },
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
      // v7.0.9 Phase 3: PatternMatcher for structural lesson retrieval
      lateBindings: [
        { prop: '_patternMatcher', service: 'patternMatcher', optional: true },
      ],
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
    // v6.0.0 (V6-5): onEvict callback wired — evicted slots emitted to bus for
    // downstream persistence/summarization (MemoryConsolidator, LessonsStore).
    ['workspaceFactory', {
      phase: 9, deps: [], tags: ['cognitive', 'port'],
      factory: () => {
        const { CognitiveWorkspace } = R('CognitiveWorkspace');
        return (opts) => new CognitiveWorkspace({
          ...opts,
          onEvict: (key, slot) => {
            bus.emit('workspace:slot-evicted', {
              key,
              value: typeof slot.value === 'string' ? slot.value.slice(0, 500) : JSON.stringify(slot.value).slice(0, 500),
              salience: slot.salience,
              accessCount: slot.accessCount,
              goalId: opts.goalId || null,
            }, { source: 'CognitiveWorkspace' });
          },
        });
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
        { prop: 'toolRegistry', service: 'tools', optional: true }, // v7.1.6: was 'toolRegistry' (dangling)
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

    // v7.3.1: CoreMemories — significant moments that shape identity.
    // Append-only, protected from DreamCycle decay, user-actionable via
    // dashboard veto. 6-signal detector at threshold 4/6. Candidates
    // (below threshold) logged separately for calibration.
    // v7.3.2: Wired to chat:completed + user:message for live triggering.
    ['coreMemories', {
      phase: 9, deps: ['bus', 'storage'], tags: ['cognitive', 'identity', 'v7.3.1'],
      lateBindings: [
        { prop: 'model', service: 'llm', optional: true },
        { prop: 'selfModel', service: 'selfModel', optional: true },
        { prop: 'emotionalState', service: 'emotionalState', optional: true, expectedActive: true, expects: ['getHistoryForSignificance'] },
        { prop: 'conversationMemory', service: 'memory', optional: true },
        { prop: 'knowledgeGraph', service: 'knowledgeGraph', optional: true },
      ],
      factory: (c) => new (R('CoreMemories').CoreMemories)({
        bus,
        storage: c.resolve('storage'),
      }),
    }],

    // v6.0.0 (V6-7): MemoryConsolidator — KG + LessonsStore hygiene
    ['memoryConsolidator', {
      phase: 9, deps: ['bus'], tags: ['cognitive', 'memory', 'v6-7'],
      lateBindings: [
        { prop: 'knowledgeGraph', service: 'knowledgeGraph', optional: true },
        { prop: 'lessonsStore', service: 'lessonsStore', optional: true },
        { prop: 'storage', service: 'storage', optional: true },
      ],
      factory: (c) => new (R('MemoryConsolidator').MemoryConsolidator)({
        bus,
        config: c.tryResolve('settings')
          ?.get('cognitive.memoryConsolidator') || {},
      }),
    }],

    // v6.0.0 (V6-8): TaskRecorder — execution trace capture + replay
    ['taskRecorder', {
      phase: 9, deps: ['bus'], tags: ['cognitive', 'replay', 'v6-8'],
      factory: () => new (R('TaskRecorder').TaskRecorder)({
        bus,
      }),
    }],

    // v6.0.2 (V6-12): QuickBenchmark — in-process validation for adaptation loop
    ['quickBenchmark', {
      phase: 9, deps: ['bus', 'storage'], tags: ['cognitive', 'benchmark', 'v6-0-2'],
      lateBindings: [
        { prop: 'costGuard', service: 'costGuard', optional: true },
      ],
      factory: (c) => new (R('QuickBenchmark').QuickBenchmark)({
        bus, storage: c.resolve('storage'),
      }),
    }],

    // v6.0.2 (V6-12): AdaptiveStrategy — meta-cognitive feedback loop
    ['adaptiveStrategy', {
      phase: 9, deps: ['bus', 'storage'], tags: ['cognitive', 'metacognition', 'v6-0-2'],
      lateBindings: [
        { prop: 'cognitiveSelfModel', service: 'cognitiveSelfModel', optional: true, expectedActive: true, expects: ['getCapabilityProfile', 'getBiasPatterns'] },
        { prop: 'promptEvolution',    service: 'promptEvolution',    optional: true, expectedActive: true },
        { prop: 'modelRouter',        service: 'modelRouter',        optional: true },
        { prop: 'onlineLearner',      service: 'onlineLearner',      optional: true },
        { prop: 'quickBenchmark',     service: 'quickBenchmark',     optional: true },
        // v7.1.7 F5: Emotional-Cognitive Bridge — emotions influence adaptation strategy
        { prop: 'emotionalSteering',  service: 'emotionalSteering',  optional: true, expectedActive: true, expects: ['getSignals'], impact: 'No emotional context in adaptation decisions' },
      ],
      factory: (c) => new (R('AdaptiveStrategy').AdaptiveStrategy)({
        bus, storage: c.resolve('storage'),
      }),
    }],

    // v7.0.9 Phase 1: CausalAnnotation — causal tracking for WorldState mutations
    ['causalAnnotation', {
      phase: 9, deps: [], tags: ['cognitive', 'causal', 'reasoning'],
      lateBindings: [
        { prop: 'kg', service: 'knowledgeGraph', optional: true },
      ],
      factory: () => new (R('CausalAnnotation').CausalAnnotation)({
        bus,
      }),
    }],

    // v7.0.9 Phase 2: InferenceEngine — rule-based deterministic inference
    ['inferenceEngine', {
      phase: 9, deps: [], tags: ['cognitive', 'reasoning', 'inference'],
      lateBindings: [
        { prop: 'graph', service: 'knowledgeGraph', optional: true },
      ],
      factory: () => new (R('InferenceEngine').InferenceEngine)({
        bus,
      }),
    }],

    // v7.0.9 Phase 3: PatternMatcher — structural similarity for lessons
    ['patternMatcher', {
      phase: 9, deps: [], tags: ['cognitive', 'learning'],
      factory: () => new (R('PatternMatcher').PatternMatcher)(),
    }],

    // v7.0.9 Phase 3: StructuralAbstraction — LLM-deferred pattern extraction
    ['structuralAbstraction', {
      phase: 9, deps: [], tags: ['cognitive', 'learning', 'abstraction'],
      lateBindings: [
        { prop: 'lessonsStore', service: 'lessonsStore', optional: true },
      ],
      factory: () => new (R('StructuralAbstraction').StructuralAbstraction)({
        bus,
      }),
    }],

    // v7.0.9 Phase 4: GoalSynthesizer — autonomous goal generation
    ['goalSynthesizer', {
      phase: 9, deps: [], tags: ['cognitive', 'autonomy', 'goals'],
      lateBindings: [
        { prop: 'selfModel', service: 'cognitiveSelfModel', optional: true, expectedActive: true, expects: ['getCapabilityProfile'], impact: 'No weakness-driven goal generation' },
        { prop: 'tracker', service: 'taskOutcomeTracker', optional: true, expectedActive: true },
        { prop: 'lessonsStore', service: 'lessonsStore', optional: true },
        { prop: 'inferenceEngine', service: 'inferenceEngine', optional: true },
        // v7.1.7 F4: Frontier-driven goal sources
        { prop: '_unfinishedWorkFrontier', service: 'unfinishedWorkFrontier', optional: true, expectedActive: true, expects: ['getRecent'] },
        { prop: '_suspicionFrontier', service: 'suspicionFrontier', optional: true, expectedActive: true, expects: ['getRecent'] },
        { prop: '_lessonFrontier', service: 'lessonFrontier', optional: true, expectedActive: true, expects: ['getRecent'] },
      ],
      factory: () => new (R('GoalSynthesizer').GoalSynthesizer)({
        bus,
      }),
    }],

    // v7.1.6: SuspicionFrontier — persists novel/surprising events across sessions.
    // Uses generic FrontierWriter with suspicionExtractor + suspicionMerger.
    // Decay 0.6/boot. Merges nodes with same dominant_category to prevent bloat.
    // Event-buffering: collects surprise:novel-event over session, writes at session:ending.
    ['suspicionFrontier', {
      phase: 9,
      deps: ['knowledgeGraph', 'storage'],
      tags: ['cognitive', 'frontier', 'suspicion'],
      factory: (c) => {
        const { FrontierWriter } = R('FrontierWriter');
        const { suspicionExtractor, suspicionMerger } = R('FrontierExtractors');
        const writer = new FrontierWriter({
          name: 'suspicion',
          edgeType: 'HIGH_SUSPICION',
          decayFactor: 0.6,
          maxImprints: 8,
          pruneThreshold: 0.05,
          extractFn: suspicionExtractor,
          mergeFn: suspicionMerger,
        }, {
          bus,
          knowledgeGraph: c.resolve('knowledgeGraph'),
          storage: c.resolve('storage'),
        });

        // v7.1.6: Buffer novel events, flush at session end
        writer.enableEventBuffer('surprise:novel-event', 'session:ending', 'novelEvents');

        return writer;
      },
    }],

    // v7.1.6: LessonFrontier — tracks which lessons were recalled during sessions.
    // Uses generic FrontierWriter with lessonExtractor.
    // Decay 0.6/boot. v7.1.6 scope: only lesson:applied tracking.
    // Confirmed/contradicted deferred to v7.1.7.
    ['lessonFrontier', {
      phase: 9,
      deps: ['knowledgeGraph', 'storage'],
      tags: ['cognitive', 'frontier', 'lessons'],
      factory: (c) => {
        const { FrontierWriter } = R('FrontierWriter');
        const { lessonExtractor } = R('FrontierExtractors');
        const writer = new FrontierWriter({
          name: 'lessonTracking',
          edgeType: 'LESSON_APPLIED',
          decayFactor: 0.6,
          maxImprints: 5,
          pruneThreshold: 0.05,
          extractFn: lessonExtractor,
        }, {
          bus,
          knowledgeGraph: c.resolve('knowledgeGraph'),
          storage: c.resolve('storage'),
        });

        // v7.1.6: Buffer applied lessons, flush at session end
        writer.enableEventBuffer('lesson:applied', 'session:ending', 'appliedLessons');

        // v7.1.7 F1: Buffer confirmed/contradicted events, merge into context at flush
        const confirmedBuffer = [];
        const contradictedBuffer = [];
        bus.on('lesson:confirmed', (data) => {
          if (confirmedBuffer.length >= 200) confirmedBuffer.shift();
          confirmedBuffer.push(data);
        }, { source: 'LessonFrontier', key: 'lesson-confirmed-buffer' });
        bus.on('lesson:contradicted', (data) => {
          if (contradictedBuffer.length >= 200) contradictedBuffer.shift();
          contradictedBuffer.push(data);
        }, { source: 'LessonFrontier', key: 'lesson-contradicted-buffer' });

        // Wrap the existing flush to inject confirmed/contradicted into context
        const originalExtract = writer._extractFn;
        writer._extractFn = (context) => {
          context.confirmedLessons = [...confirmedBuffer];
          context.contradictedLessons = [...contradictedBuffer];
          confirmedBuffer.length = 0;
          contradictedBuffer.length = 0;
          return originalExtract(context);
        };

        return writer;
      },
    }],
  ];
}

module.exports = { phase9 };
