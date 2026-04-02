// ============================================================
// GENESIS — manifest/phase13-consciousness.js
// Phase 13: Bewusstseinssubstrat (Consciousness Substrate)
//
// The unified experience layer. Binds all existing subsystems
// (emotions, needs, expectations, surprise, dreams, memory)
// into a coherent experiential field with attention, temporal
// continuity, and meta-awareness.
//
// Modules:
//   PhenomenalField     — unified experience frames (binding)
//   AttentionalGate     — competitive attention (salience)
//   TemporalSelf        — continuity across time (identity)
//   IntrospectionEngine — meta-cognition (self-awareness)
//
// All modules are fully optional — Genesis runs identically
// without Phase 13. Every dependency uses optional: true.
// Every subsystem check uses graceful degradation.
//
// Boot order within Phase 13:
//   1. AttentionalGate (no Phase 13 deps)
//   2. PhenomenalField (needs AttentionalGate)
//   3. TemporalSelf (needs PhenomenalField)
//   4. IntrospectionEngine (needs all above)
// ============================================================

function phase13(ctx, R) {
  const { bus, intervals } = ctx;

  return [
    // ── AttentionalGate — competitive attention ──────────
    // Must be first: PhenomenalField samples its state.
    ['attentionalGate', {
      phase: 13,
      deps: ['storage', 'eventStore'],
      tags: ['consciousness', 'attention'],
      lateBindings: [
        { prop: 'emotionalState', service: 'emotionalState', optional: true },
        { prop: 'needsSystem', service: 'needsSystem', optional: true },
        { prop: 'goalStack', service: 'goalStack', optional: true },
        { prop: 'homeostasis', service: 'homeostasis', optional: true },
        { prop: 'surpriseAccumulator', service: 'surpriseAccumulator', optional: true },
      ],
      factory: (c) => new (R('AttentionalGate').AttentionalGate)({
        bus,
        storage: c.resolve('storage'),
        eventStore: c.resolve('eventStore'),
        intervals,
        config: c.tryResolve('settings')
          ?.get('consciousness.attention') || {},
      }),
    }],

    // ── PhenomenalField — unified experience binding ─────
    // The core: samples all subsystems and creates coherent
    // experience frames with valence, arousal, coherence, Φ.
    ['phenomenalField', {
      phase: 13,
      deps: ['storage', 'eventStore'],
      tags: ['consciousness', 'binding', 'experience'],
      lateBindings: [
        { prop: 'emotionalState', service: 'emotionalState', optional: true },
        { prop: 'needsSystem', service: 'needsSystem', optional: true },
        { prop: 'surpriseAccumulator', service: 'surpriseAccumulator', optional: true },
        { prop: 'expectationEngine', service: 'expectationEngine', optional: true },
        { prop: 'homeostasis', service: 'homeostasis', optional: true },
        { prop: 'episodicMemory', service: 'episodicMemory', optional: true },
        { prop: 'schemaStore', service: 'schemaStore', optional: true },
        { prop: 'selfNarrative', service: 'selfNarrative', optional: true },
        { prop: 'attentionalGate', service: 'attentionalGate', optional: true },
        { prop: 'valueStore', service: 'valueStore', optional: true },
        { prop: 'bodySchema', service: 'bodySchema', optional: true },
      ],
      factory: (c) => new (R('PhenomenalField').PhenomenalField)({
        bus,
        storage: c.resolve('storage'),
        eventStore: c.resolve('eventStore'),
        intervals,
        config: c.tryResolve('settings')
          ?.get('consciousness.phenomenalField') || {},
      }),
    }],

    // ── TemporalSelf — continuity of identity ────────────
    // Links experience frames into a continuous stream.
    // Past (retention) → Present → Future (protention).
    ['temporalSelf', {
      phase: 13,
      deps: ['storage', 'eventStore'],
      tags: ['consciousness', 'temporality', 'identity'],
      lateBindings: [
        { prop: 'phenomenalField', service: 'phenomenalField', optional: true },
        { prop: 'emotionalState', service: 'emotionalState', optional: true },
        { prop: 'selfNarrative', service: 'selfNarrative', optional: true },
      ],
      factory: (c) => new (R('TemporalSelf').TemporalSelf)({
        bus,
        storage: c.resolve('storage'),
        eventStore: c.resolve('eventStore'),
        intervals,
        config: c.tryResolve('settings')
          ?.get('consciousness.temporal') || {},
      }),
    }],

    // ── IntrospectionEngine — meta-awareness ─────────────
    // Observes, analyzes, and reasons about Genesis's own
    // inner states. Three levels: state report, pattern
    // recognition, self-theorizing.
    ['introspectionEngine', {
      phase: 13,
      deps: ['storage', 'eventStore'],
      tags: ['consciousness', 'meta-cognition', 'introspection'],
      lateBindings: [
        { prop: 'phenomenalField', service: 'phenomenalField', optional: true },
        { prop: 'temporalSelf', service: 'temporalSelf', optional: true },
        { prop: 'emotionalState', service: 'emotionalState', optional: true },
        { prop: 'attentionalGate', service: 'attentionalGate', optional: true },
        { prop: 'selfNarrative', service: 'selfNarrative', optional: true },
        { prop: 'model', service: 'llm', optional: true },
        { prop: 'valueStore', service: 'valueStore', optional: true },
        // v4.12.8: Error pattern analysis bridge
        { prop: 'errorAggregator', service: 'errorAggregator', optional: true },
      ],
      factory: (c) => new (R('IntrospectionEngine').IntrospectionEngine)({
        bus,
        storage: c.resolve('storage'),
        eventStore: c.resolve('eventStore'),
        intervals,
        config: c.tryResolve('settings')
          ?.get('consciousness.introspection') || {},
      }),
    }],

    // ── ConsciousnessExtension — closed perceptual loop ─
    // Adds EchoicMemory (sliding window), PredictiveCoder
    // (surprise signals), NeuroModulators (dual-process
    // emotion), 2D AttentionalGate (salience map), DreamEngine
    // (offline consolidation), and consciousness state machine
    // (AWAKE/DAYDREAM/DEEP_SLEEP/HYPERVIGILANT).
    // Listens to consciousness:frame from PhenomenalField and
    // emits enriched events back onto the bus. Fully optional.
    //
    // v4.12.1 [P3-01]: Pass liteMode from settings to reduce
    // polling overhead on consumer hardware (Intel iGPU + Ollama).
    // Enable via: settings.set('consciousness.extension.liteMode', true)
    ['consciousnessExtension', {
      phase: 13,
      deps: ['storage', 'eventStore'],
      tags: ['consciousness', 'echoic', 'predictive', 'dream', 'neuromodulator'],
      lateBindings: [
        { prop: 'phenomenalField', service: 'phenomenalField', optional: true },
        { prop: 'attentionalGate', service: 'attentionalGate', optional: true },
        { prop: 'temporalSelf', service: 'temporalSelf', optional: true },
        { prop: 'introspectionEngine', service: 'introspectionEngine', optional: true },
        { prop: 'selfNarrative', service: 'selfNarrative', optional: true },
        { prop: 'model', service: 'llm', optional: true },
        { prop: 'dreamCycle', service: 'dreamCycle', optional: true },
        { prop: 'emotionalState', service: 'emotionalState', optional: true },
      ],
      factory: (c) => {
        const settingsCfg = c.tryResolve('settings')
          ?.get('consciousness.extension') || {};
        return new (R('ConsciousnessExtensionAdapter').ConsciousnessExtensionAdapter)({
          bus,
          storage: c.resolve('storage'),
          eventStore: c.resolve('eventStore'),
          intervals,
          config: settingsCfg,
        });
      },
    }],
  ];
}

module.exports = { phase13 };
