// ============================================================
// GENESIS — manifest/phase12-hybrid.js
// Phase 12: Symbolic + Neural Hybrid
//
// Graph reasoning.
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


  ];
}

module.exports = { phase12 };
