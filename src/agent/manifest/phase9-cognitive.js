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

const { phase9b } = require('./phase9-cognitive-b'); // v7.9.29 (hygiene #10)

function phase9(ctx, R) {
  const { bus, intervals } = ctx;

  return [
    // CognitiveHealthTracker — FIRST in Phase 9; other services use it for resilience.
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

    // v7.9.20 (O): tracks self-modification outcomes; records a
    // 'self-modification' lesson on churn so proposals stop touching the file.
    ['selfModOutcomeTracker', {
      phase: 9,
      deps: ['lessonsStore'],
      tags: ['cognitive', 'learning'],
      factory: (c) => new (R('SelfModOutcomeTracker').SelfModOutcomeTracker)({
        bus,
        lessonsStore: c.resolve('lessonsStore'),
        config: c.tryResolve('settings')
          ?.get('cognitive.selfModOutcome') || {},
      }),
    }],

    // v7.3.7: Storage layer for memory-as-habitat. JournalWriter = append-only
    // stream (3 visibilities); PendingMomentsStore = pinned moments awaiting
    // DreamCycle review. Both before ContextCollector so its late-bindings find them.
    ['journalWriter', {
      phase: 9,
      deps: ['storage'],
      tags: ['cognitive', 'memory', 'storage'],
      factory: (c) => new (R('JournalWriter').JournalWriter)({
        bus,
        storageDir: c.resolve('storage').baseDir,
      }),
    }],

    ['pendingMomentsStore', {
      phase: 9,
      deps: ['storage'],
      tags: ['cognitive', 'memory', 'storage'],
      factory: (c) => new (R('PendingMomentsStore').PendingMomentsStore)({
        bus,
        storageDir: c.resolve('storage').baseDir,
      }),
    }],

    // v7.3.7: ContextCollector — shared by WakeUp/IdleMind/DreamCycle.
    // Zero-dep constructor; all sources as optional late-bindings.
    ['contextCollector', {
      phase: 9,
      deps: [],
      tags: ['cognitive', 'context'],
      lateBindings: [
        { prop: 'episodicMemory',      service: 'episodicMemory',      optional: true },
        { prop: 'journalWriter',       service: 'journalWriter',       optional: true },
        { prop: 'pendingMomentsStore', service: 'pendingMomentsStore', optional: true },
        { prop: 'coreMemories',        service: 'coreMemories',        optional: true },
        { prop: 'emotionalState',      service: 'emotionalState',      optional: true },
        { prop: 'needsSystem',         service: 'needsSystem',         optional: true },
        { prop: 'dreamCycle',          service: 'dreamCycle',          optional: true },
      ],
      factory: () => new (R('ContextCollector').ContextCollector)({}),
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
        // v7.3.7: Phase 1.5 / 4c / 4d / 6
        { prop: 'pendingMomentsStore', service: 'pendingMomentsStore', optional: true },
        { prop: 'journalWriter',       service: 'journalWriter',       optional: true },
        { prop: 'coreMemories',        service: 'coreMemories',        optional: true },
        { prop: 'activeRefs',          service: 'activeReferences',    optional: true },
        { prop: 'contextCollector',    service: 'contextCollector',    optional: true },
        // v7.9.0 Phase 2: Können skill crystallization (Phase 3c).
        { prop: 'skillCrystallizer',   service: 'skillCrystallizer',   optional: true },
        // v7.9.4: Können skill promotion (Phase 3d, after crystallization).
        { prop: 'skillPromotionEvaluator', service: 'skillPromotionEvaluator', optional: true, impact: 'Pending skills never get promoted' },
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

    // v7.5.5: SelfStatementLog — captures Genesis's own statements and
    // detects structural claims without _introspectionContext backing.
    // v7.5.7: Optional goalStack late-binding for activity-claim snapshots
    // — when Genesis claims "ich beschäftige mich mit X" the active-goal
    // snapshot decides whether it's a soft confabulation. Degrades
    // gracefully if goalStack missing.
    ['selfStatementLog', {
      phase: 9,
      deps: ['storage', 'eventStore', 'settings'],
      tags: ['cognitive', 'self', 'audit'],
      lateBindings: [
        { prop: 'goalStack', service: 'goalStack', optional: true, expects: ['getActiveGoals'] },
      ],
      factory: (c) => {
        const settings = c.resolve('settings');
        // v7.5.7-fix Phase 2: configurable count-cap. 0/undefined = unlimited.
        const maxStatements = settings?.get?.('selfStatementLog.maxStatements');
        return new (R('SelfStatementLog').SelfStatementLog)({
          bus,
          storageDir: c.resolve('storage').baseDir,
          eventStore: c.resolve('eventStore'),
          maxStatements: typeof maxStatements === 'number' ? maxStatements : 0,
        });
      },
    }],

    // v7.7.9 Phase 2: InnerSpeech — first-person thought channel.
    // Bounded in-memory ring buffer with Genesis's own thoughts. Async
    // multi-subscriber delivery; persistent overflow to selfStatementLog.
    // Boundary: thoughts FOR HIMSELF → InnerSpeech, FOR USER → ChatHistory,
    // structured events → EventBus. Self-Gate-Asymmetry: emit() never throws.
    ['innerSpeech', {
      phase: 9,
      deps: [],
      tags: ['cognitive', 'self', 'self-expression'],
      lateBindings: [
        { prop: '_selfStatementLog', service: 'selfStatementLog', optional: true,
          expects: ['append'],
          impact: 'No persistent overflow when ring fills; thoughts dropped silently' },
      ],
      factory: (c) => {
        const settings = c.tryResolve ? c.tryResolve('settings') : null;
        const capacity = settings?.get?.('innerSpeech.capacity') ?? 200;
        return new (R('InnerSpeech').InnerSpeech)({ bus, capacity });
      },
    }],

    // v7.7.9 Phase 2: ProactiveSelfExpression — subscribes to InnerSpeech
    // and decides if/when to publish a self-initiated chat message.
    // Pipeline: HardGates → Score → ContentGeneration → ContentSanity →
    // ChatOrchestrator.appendSelfMessage().
    //
    // No engagement metrics, no farewell hooks, no fake emotion, no
    // adaptive learning from user reactions. Genesis writes from
    // internal state, not to please. CI guard enforces this at file-
    // content level (see test/modules/v779-anti-pattern-guard.contract).
    //
    // Phase 2 enables only the 'plan-failure-reflection' kind by
    // default. Other kinds remain code-complete but gated off until
    // Phase 3 / Phase 4.
    ['proactiveSelfExpression', {
      phase: 9, deps: ['innerSpeech'], tags: ['cognitive', 'self', 'self-expression', 'proactive'],
      lateBindings: [
        { prop: 'modelBridge', service: 'model', optional: false,
          impact: 'PSE cannot generate self-message text; pipeline suppresses with "generation-error"' },
        { prop: 'emotionalState', service: 'emotionalState', optional: true,
          impact: 'Emotional skalars unavailable for state block; generation continues' },
        { prop: 'settings', service: 'settings', optional: true,
          impact: 'Falls back to PSE built-in defaults' },
        { prop: 'chatOrchestrator', service: 'chatOrchestrator', optional: false,
          impact: 'No way to publish self-messages; suppresses with "chat-orchestrator-unavailable"' },
      ],
      factory: (c) => {
        const storageDir = ctx.rootDir ? require('path').join(ctx.rootDir, '.genesis') : null;
        return new (R('ProactiveSelfExpression').ProactiveSelfExpression)({
          bus, innerSpeech: c.resolve('innerSpeech'), storageDir,
          eventStore: c.tryResolve ? c.tryResolve('eventStore') : null,
          storage: c.tryResolve ? c.tryResolve('storage') : null,
        });
      },
    }],

    // v7.9.36 (E3): ConcernMonitor — the relationship gesture. Watches two
    // INDEPENDENT sources (session pattern from the trajectory journal +
    // the UserModel's decaying affect inference) and, only when both agree,
    // emits a 'concern' thought into InnerSpeech. The thought then passes
    // every existing PSE guard plus the new per-kind wallclock cap
    // (gate 6.5 — once per 7 days) and the concern shape checks. A user
    // decline silences the kind for 30 days via PSE.declineKind.
    ['concernMonitor', {
      phase: 9,
      deps: ['bus', 'storage'],
      tags: ['cognitive', 'self', 'relationship'],
      lateBindings: [
        { prop: 'userModel', service: 'userModel', optional: true,
          impact: 'No chat-model affect source; the two-source rule then never fires' },
        { prop: 'innerSpeech', service: 'innerSpeech', optional: true,
          impact: 'No emission path; monitor evaluates but stays silent' },
        { prop: 'proactiveSelfExpression', service: 'proactiveSelfExpression', optional: true,
          impact: 'Declines cannot be persisted; wallclock cap still limits frequency' },
        { prop: 'settings', service: 'settings', optional: true,
          impact: 'Falls back to built-in concern defaults' },
      ],
      factory: (c) => new (R('ConcernMonitor').ConcernMonitor)({
        bus,
        storage: c.resolve('storage'),
      }),
    }],

    // v7.7.9 Phase 3: StalledGoalWatchdog — bridges resource-blocked
    // goals back into the failure-reflection pathway. Without this,
    // hopelessly-blocked goals (hallucinated paths) sit forever and
    // PSE never sees them. Ticks once per minute, flags blocked
    // goals older than goals.stalledTimeoutMs, transitions to
    // 'stalled', emits synthetic plan-failure-reflection.
    ['stalledGoalWatchdog', {
      phase: 9,
      deps: [],
      tags: ['cognitive', 'goals', 'lifecycle'],
      lateBindings: [
        // v7.9.26: the watchdog no longer narrates stalls itself — markStalled
        // fires goal:stalled and the AgentLoop's terminal-outcome narration
        // turns that into the InnerSpeech / self-statement thought. The watchdog
        // keeps only the lesson capture.
        { prop: 'lessonsStore', service: 'lessonsStore', optional: true,
          impact: 'No lesson learned from stalled goals' },
      ],
      factory: (c) => new (R('StalledGoalWatchdog').StalledGoalWatchdog)({
        bus,
        goalStack: c.tryResolve ? c.tryResolve('goalStack') : null,
        settings: c.tryResolve ? c.tryResolve('settings') : null,
        eventStore: c.tryResolve ? c.tryResolve('eventStore') : null,
        intervals: ctx.intervals || null,
      }),
    }],

    // v7.7.9 Phase 3: KindTriggers — translates goal:completed and
    // planner:complete events into InnerSpeech thoughts. idle-thought
    // comes from IdleMind, plan-failure-reflection from AgentLoopPursuit.
    ['kindTriggers', {
      phase: 9, deps: [], tags: ['cognitive', 'self-expression', 'triggers'],
      lateBindings: [
        { prop: 'innerSpeech', service: 'innerSpeech', optional: true,
          impact: 'No goal-closure or self-formulated-plan thoughts' },
      ],
      factory: (c) => new (R('KindTriggers').KindTriggers)({ bus }),
    }],

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
      // late-bindings: PatternMatcher (structural retrieval, v7.0.9)
      //                embeddingService + intervalManager (semantic recall, v7.8.8)
      lateBindings: [
        { prop: '_patternMatcher', service: 'patternMatcher', optional: true },
      ],
      factory: (c) => new (R('LessonsStore').LessonsStore)({
        bus,
        embeddingService: c.tryResolve ? c.tryResolve('embeddingService') : null,
        intervalManager:  intervals,
      }),
    }],

    // v7.9.15: SelfTrajectory — the collaborative self-trajectory journal.
    // Identity-persistent (.genesis, via the storage service). genome is an
    // earlier phase (hard dep); cognitiveSelfModel/lessonsStore/modelBridge
    // are late-bound (same-phase or late, used only at draft time, graceful
    // when absent). modelBridge absent → generateDraft writes a stub.
    ['selfTrajectory', {
      phase: 9, deps: ['bus', 'storage', 'genome'], tags: ['cognitive', 'identity', 'persistent'],
      lateBindings: [
        { prop: 'cognitiveSelfModel', service: 'cognitiveSelfModel', optional: true,
          impact: 'Draft prompt omits the self-observation source; draft still works' },
        { prop: 'lessonsStore', service: 'lessonsStore', optional: true,
          impact: 'Draft prompt omits the most-recalled lessons; draft still works' },
        { prop: 'modelBridge', service: 'model', optional: true,
          impact: 'generateDraft writes a placeholder stub instead of an LLM draft' },
        { prop: 'eventCounter', service: 'eventCounter', optional: true,
          impact: 'commit() records event_count as null instead of the per-cycle significant-event count' },
      ],
      factory: (c) => new (R('SelfTrajectory').SelfTrajectory)({
        bus,
        storage: c.resolve('storage'),
        genome: c.resolve('genome'),
      }),
    }],

    // v7.9.16: EventCounter — passive significant-event observer that fills
    // SelfTrajectory's event_count. Append-only journal via the storage
    // service; no in-memory state (countSince reads on demand). One-way
    // dependency: selfTrajectory late-binds this, this never references
    // selfTrajectory. Started in the Phase-9 start sequence, stopped in
    // TO_STOP. Observes goal/lesson/emotion-watchdog/session events.
    ['eventCounter', {
      phase: 9, deps: ['bus', 'storage'], tags: ['cognitive', 'persistent', 'observer'],
      factory: (c) => new (R('EventCounter').EventCounter)({
        bus,
        storage: c.resolve('storage'),
      }),
    }],

    // v7.9.33 (AP-2, S8): ChangeRegister — the change witness. Passive
    // sibling of EventCounter: subscribes six sources (both KG prune
    // paths, schema prune, two memory releases, consolidation) plus the
    // first-ever listener on fitness:evaluated; one append-only line per
    // event into change-register.jsonl, never pruned, never read on the
    // runtime path (slash-only). Started in the Phase-9 start sequence,
    // stopped in TO_STOP.
    ['changeRegister', {
      phase: 9, deps: ['bus', 'storage'], tags: ['cognitive', 'persistent', 'observer'],
      factory: (c) => new (R('ChangeRegister').ChangeRegister)({
        bus,
        storage: c.resolve('storage'),
      }),
    }],

    // v7.9.17: TrajectoryCalibration — silent reality-check for trajectory
    // entries. Triggered by trajectory:committed; reads (one-way) the event
    // journal, the capability profile, the embedding service, the model
    // (separate classifier), and selfTrajectory entries. SelfTrajectory does
    // not depend on it. All sources late-bound + optional → graceful.
    ['trajectoryCalibration', {
      phase: 9, deps: ['bus', 'storage'], tags: ['cognitive', 'persistent', 'observer'],
      lateBindings: [
        { prop: 'model', service: 'model', optional: true,
          impact: 'expected directions stay null (no separate classifier) — sign-scores cannot be computed' },
        { prop: 'embeddingService', service: 'embeddingService', optional: true,
          impact: 'value-position drift stays null (no embedding distance)' },
        { prop: 'cognitiveSelfModel', service: 'cognitiveSelfModel', optional: true,
          impact: 'schwaeche capability snapshot is empty — schwaeche sign-score stays null' },
        { prop: 'eventCounter', service: 'eventCounter', optional: true,
          impact: 'wachstum success-rate trend unavailable — wachstum sign-score stays null' },
        { prop: 'selfTrajectory', service: 'selfTrajectory', optional: true,
          impact: 'cannot read cycle boundaries / prior value — review returns no-trajectory' },
      ],
      factory: (c) => new (R('TrajectoryCalibration').TrajectoryCalibration)({
        bus,
        storage: c.resolve('storage'),
      }),
    }],

    // v7.8.8: LessonsAutoCapture — extracted bus-listener layer that converts
    // runtime events into lessonsStore.record() calls. Separate lifecycle from
    // the store so the store stays focused on persistence and recall.
    ...phase9b(ctx, R),
  ];
}

module.exports = { phase9 };
