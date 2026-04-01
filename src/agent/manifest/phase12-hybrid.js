// ============================================================
// GENESIS — manifest/phase12-hybrid.js
// Phase 12: Symbolic + Neural Hybrid
//
// Graph reasoning, adaptive memory.
// ============================================================

function phase12(ctx, R) {
  const { bus, intervals } = ctx;

  return [
    // ── GraphReasoner ──
    ['graphReasoner', {
      phase: 12,
      deps: ['knowledgeGraph', 'selfModel'],
      tags: ['intelligence', 'reasoning'],
      factory: (c) => new (R('GraphReasoner').GraphReasoner)({
        bus,
        knowledgeGraph: c.resolve('knowledgeGraph'),
        selfModel: c.resolve('selfModel'),
        config: c.tryResolve('settings')
          ?.get('reasoning.graph') || {},
      }),
    }],

    // ── AdaptiveMemory ──
    ['adaptiveMemory', {
      phase: 12,
      deps: ['storage', 'eventStore'],
      tags: ['memory', 'intelligence'],
      lateBindings: [
        { prop: 'emotionalState', service: 'emotionalState', optional: true },
        { prop: 'surpriseAccumulator', service: 'surpriseAccumulator', optional: true },
        { prop: 'episodicMemory', service: 'episodicMemory', optional: true },
        { prop: 'vectorMemory', service: 'vectorMemory', optional: true },
      ],
      factory: (c) => new (R('AdaptiveMemory').AdaptiveMemory)({
        bus,
        storage: c.resolve('storage'),
        eventStore: c.resolve('eventStore'),
        config: c.tryResolve('settings')
          ?.get('memory.adaptive') || {},
      }),
    }],
  ];
}

module.exports = { phase12 };
