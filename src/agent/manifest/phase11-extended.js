// ============================================================
// GENESIS — manifest/phase11-extended.js
// Phase 11: Extended Perception & Action
//
// Trust levels, effector registry, web perception.
// ============================================================

function phase11(ctx, R) {
  const { bus, intervals } = ctx;

  return [
    // ── TrustLevelSystem — early phase, used by everything ──
    ['trustLevelSystem', {
      phase: 11,
      deps: ['storage', 'settings'],
      tags: ['foundation', 'security'],
      lateBindings: [
        { prop: 'metaLearning', service: 'metaLearning', optional: true },
      ],
      factory: (c) => new (R('TrustLevelSystem').TrustLevelSystem)({
        bus,
        storage: c.resolve('storage'),
        settings: c.tryResolve('settings'),
        config: c.tryResolve('settings')
          ?.get('trust') || {},
      }),
    }],

    // ── EffectorRegistry ──
    ['effectorRegistry', {
      phase: 11,
      deps: ['storage', 'eventStore'],
      tags: ['capabilities', 'effectors'],
      lateBindings: [
        { prop: 'trustLevel', service: 'trustLevelSystem', optional: true },
        { prop: 'worldState', service: 'worldState', optional: true },
      ],
      factory: (c) => new (R('EffectorRegistry').EffectorRegistry)({
        bus,
        storage: c.resolve('storage'),
        eventStore: c.resolve('eventStore'),
        rootDir: c.resolve('rootDir'),
        config: c.tryResolve('settings')
          ?.get('effectors') || {},
      }),
    }],

    // ── WebPerception ──
    ['webPerception', {
      phase: 11,
      deps: ['storage', 'eventStore'],
      tags: ['capabilities', 'perception'],
      lateBindings: [
        { prop: 'worldState', service: 'worldState', optional: true },
      ],
      optional: true,
      factory: (c) => new (R('WebPerception').WebPerception)({
        bus,
        storage: c.resolve('storage'),
        eventStore: c.resolve('eventStore'),
        config: c.tryResolve('settings')
          ?.get('webPerception') || {},
      }),
    }],

    // ── SelfSpawner — parallel worker processes ──
    ['selfSpawner', {
      phase: 11,
      deps: ['storage', 'eventStore'],
      tags: ['capabilities', 'autonomy'],
      lateBindings: [
        { prop: 'model', service: 'model', optional: true },
      ],
      optional: true,
      factory: (c) => new (R('SelfSpawner').SelfSpawner)({
        bus,
        storage: c.resolve('storage'),
        eventStore: c.resolve('eventStore'),
        rootDir: c.resolve('rootDir'),
        config: c.tryResolve('settings')
          ?.get('selfSpawner') || {},
      }),
    }],
  ];
}

module.exports = { phase11 };
