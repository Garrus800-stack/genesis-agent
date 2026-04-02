// ============================================================
// GENESIS — manifest/phase6-autonomy.js
// Phase 6: Autonomy services
// ============================================================

function phase6(ctx, R) {
  const { rootDir, genesisDir, guard, bus, intervals } = ctx;

  return [
    ['daemon', {
      phase: 6,
      deps: ['reflector', 'selfModel', 'memory', 'llm', 'prompts', 'skills', 'sandbox'],
      tags: ['autonomy'],
      factory: (c) => new (R('AutonomousDaemon').AutonomousDaemon)({
        bus, reflector: c.resolve('reflector'), selfModel: c.resolve('selfModel'),
        memory: c.resolve('memory'), model: c.resolve('llm'),
        prompts: c.resolve('prompts'), skills: c.resolve('skills'),
        sandbox: c.resolve('sandbox'), guard, intervals,
      }),
    }],

    ['idleMind', {
      phase: 6,
      deps: ['model', 'prompts', 'selfModel', 'memory', 'knowledgeGraph', 'eventStore', 'goalStack', 'storage'],
      tags: ['autonomy'],
      lateBindings: [
        { prop: 'mcpClient', service: 'mcpClient', optional: true },
        { prop: 'learningService', service: 'learningService' },
        { prop: 'emotionalState', service: 'emotionalState' },
        { prop: 'needsSystem', service: 'needsSystem' },
        { prop: '_homeostasis', service: 'homeostasis' },
        { prop: 'worldState', service: 'worldState', optional: true },
        { prop: 'episodicMemory', service: 'episodicMemory', optional: true },
        // Phase 9: Cognitive Architecture
        { prop: 'dreamCycle', service: 'dreamCycle', optional: true },
        { prop: 'selfNarrative', service: 'selfNarrative', optional: true },
        // v4.12.8: Memory consolidation during idle
        { prop: 'unifiedMemory', service: 'unifiedMemory', optional: true },
        // v5.0.0: Genome traits + Metabolism energy gating
        { prop: '_genome', service: 'genome', optional: true },
        { prop: '_metabolism', service: 'metabolism', optional: true },
      ],
      factory: (c) => new (R('IdleMind').IdleMind)({
        bus, model: c.resolve('llm'), prompts: c.resolve('prompts'),
        selfModel: c.resolve('selfModel'), memory: c.resolve('memory'),
        knowledgeGraph: c.resolve('knowledgeGraph'), eventStore: c.resolve('eventStore'),
        storageDir: genesisDir, goalStack: c.resolve('goalStack'),
        intervals, storage: c.resolve('storage'),
      }),
    }],

    ['healthMonitor', {
      phase: 6, deps: ['circuitBreaker', 'eventStore', 'workerPool'], tags: ['autonomy'],
      factory: (c) => new (R('HealthMonitor').HealthMonitor)({
        bus, circuitBreaker: c.resolve('circuitBreaker'),
        eventStore: c.resolve('eventStore'), workerPool: c.resolve('workerPool'),
        container: c, intervals,
      }),
    }],

    // v5.9.3: Auto-recovery for degraded services
    ['serviceRecovery', {
      phase: 6, deps: [], tags: ['autonomy', 'recovery'],
      lateBindings: [
        { prop: 'container',     service: 'container',     optional: true },
        { prop: 'healthMonitor', service: 'healthMonitor', optional: true },
      ],
      factory: () => new (R('ServiceRecovery').ServiceRecovery)({ bus }),
    }],

    ['cognitiveMonitor', {
      phase: 6, deps: ['eventStore', 'storage'], tags: ['metacognition', 'autonomy'],
      lateBindings: [
        { prop: 'llmPort', service: 'llm', optional: true },
        { prop: 'toolRegistry', service: 'tools', optional: true },
      ],
      factory: (c) => new (R('CognitiveMonitor').CognitiveMonitor)({
        bus, eventStore: c.resolve('eventStore'), storage: c.resolve('storage'), intervals,
      }),
    }],

    ['errorAggregator', {
      phase: 6, deps: [], tags: ['monitoring', 'autonomy'],
      factory: () => new (R('ErrorAggregator').ErrorAggregator)({ bus }),
    }],

    // v5.2.0: Optional HTTP health endpoint for external monitoring.
    // Only created if settings.health.httpEnabled is true.
    ['healthServer', {
      phase: 6, deps: ['settings'], tags: ['autonomy', 'monitoring'],
      factory: (c) => {
        const settings = c.resolve('settings');
        const enabled = settings.get?.('health.httpEnabled') || false;
        if (!enabled) return null;
        const port = settings.get?.('health.httpPort') || 9477;
        const hs = new (R('HealthServer').HealthServer)({ port, container: c, bus });
        hs.start();
        return hs;
      },
    }],

    // v5.9.2: Deployment Manager foundation — strategy-based deploys with rollback
    ['deploymentManager', {
      phase: 6, deps: [], tags: ['autonomy', 'deployment', 'devops'],
      lateBindings: [
        { prop: 'shell',         service: 'shellAgent',    optional: true },
        { prop: 'healthMonitor', service: 'healthMonitor', optional: true },
        { prop: 'hotReloader',   service: 'hotReloader',   optional: true },
      ],
      factory: () => new (R('DeploymentManager').DeploymentManager)({ bus }),
    }],
  ];
}

module.exports = { phase6 };
