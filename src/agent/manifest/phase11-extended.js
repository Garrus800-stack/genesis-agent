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

    // ── EarnedAutonomy — Wilson-score per-action trust tracker ──
    ['earnedAutonomy', {
      phase: 11,
      deps: ['storage'],
      tags: ['autonomy', 'trust'],
      lateBindings: [
        { prop: 'trustLevelSystem', service: 'trustLevelSystem', optional: true },
      ],
      factory: (c) => new (R('EarnedAutonomy').EarnedAutonomy)({
        bus,
        storage: c.resolve('storage'),
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

    // ── RuntimeStatePort (v7.4.0) ──
    // Collects in-memory snapshots from running services and
    // makes them available to PromptBuilder. Phase 11 is the
    // right home because all 8 source services (settings,
    // daemon, idleMind, peerNetwork, emotionalState, needsSystem,
    // metabolism, goalStack) exist by phase 10 at the latest.
    // lateBinding stays as safety-net for graceful degradation.
    // See docs/ARCHITECTURE.md — Leitprinzip 0.6.
    ['runtimeStatePort', {
      phase: 11,
      deps: [],
      tags: ['port', 'runtime-state'],
      lateBindings: [
        { prop: 'settings',       service: 'settings',       optional: true },
        { prop: 'daemon',         service: 'daemon',         optional: true },
        { prop: 'idleMind',       service: 'idleMind',       optional: true },
        { prop: 'peerNetwork',    service: 'peerNetwork',    optional: true },
        { prop: 'emotionalState', service: 'emotionalState', optional: true },
        { prop: 'needsSystem',    service: 'needsSystem',    optional: true },
        { prop: 'metabolism',     service: 'metabolism',     optional: true },
        { prop: 'goalStack',      service: 'goalStack',      optional: true },
      ],
      factory: () => new (R('RuntimeStatePort').RuntimeStatePort)({}),
    }],
  ];
}

module.exports = { phase11 };
