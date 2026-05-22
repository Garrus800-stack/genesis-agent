// ============================================================
// GENESIS — manifest/phase6-autonomy.js
// Phase 6: Autonomy services
// ============================================================

function phase6(ctx, R) {
  const { rootDir, genesisDir, guard, bus, intervals } = ctx;

  return [
    ['daemon', {
      phase: 6,
      deps: ['reflector', 'selfModel', 'memory', 'llm', 'prompts', 'skills', 'sandbox', 'storage'],
      tags: ['autonomy'],
      // v6.0.7: Trust-gated repair scope
      lateBindings: [
        { prop: 'trustLevelSystem', service: 'trustLevelSystem', optional: true },
        // v7.3.5: Goal lifecycle review scheduling (cross-phase 6→4 to goalStack)
        { prop: 'goalStack', service: 'goalStack', optional: true, expects: ['reviewGoals'],
          impact: 'No periodic goal lifecycle review (goals stay active even after all steps done)' },
        // v7.6.1 audit-closeout: Self-Gate observation on autonomous cycles.
        // Closes the symmetry gap where 'daemon-action' was a documented
        // actionType in self-gate.js but had no call site.
        { prop: 'selfGate', service: 'selfGate', optional: true },
      ],
      factory: (c) => {
        const dm = new (R('AutonomousDaemon').AutonomousDaemon)({
          bus, reflector: c.resolve('reflector'), selfModel: c.resolve('selfModel'),
          memory: c.resolve('memory'), model: c.resolve('llm'),
          prompts: c.resolve('prompts'), skills: c.resolve('skills'),
          sandbox: c.resolve('sandbox'), guard, intervals,
          storage: c.resolve('storage'),
        });
        // v7.5.7-fix Phase 2 round 3: cycleMinutes from settings (UI exposed).
        const settings = c.tryResolve ? c.tryResolve('settings') : null;
        const cycleMin = settings?.get?.('daemon.cycleMinutes');
        if (typeof cycleMin === 'number' && cycleMin > 0 && dm.config) {
          dm.config.cycleInterval = cycleMin * 60 * 1000;
        }
        return dm;
      },
    }],

    ['idleMind', {
      phase: 6,
      deps: ['model', 'prompts', 'selfModel', 'memory', 'knowledgeGraph', 'eventStore', 'goalStack', 'storage'],
      tags: ['autonomy'],
      lateBindings: [
        { prop: 'mcpClient', service: 'mcpClient', optional: true },
        // v7.1.6: cross-phase P6→P5/P7, optional for graceful degradation
        // v7.2.1: expectedActive marks bindings critical for IdleMind's core activities
        { prop: 'learningService', service: 'learningService', optional: true },
        { prop: 'emotionalState', service: 'emotionalState', optional: true, expectedActive: true, expects: ['getState', 'getIdlePriorities'], impact: 'No emotion-weighted activity selection' },
        { prop: 'needsSystem', service: 'needsSystem', optional: true, expectedActive: true, expects: ['getActivityRecommendations'], impact: 'No needs-driven activity recommendations' },
        { prop: '_homeostasis', service: 'homeostasis', optional: true, expectedActive: true },
        { prop: 'worldState', service: 'worldState', optional: true },
        { prop: 'episodicMemory', service: 'episodicMemory', optional: true },
        // Phase 9: Cognitive Architecture
        { prop: 'dreamCycle', service: 'dreamCycle', optional: true },
        { prop: 'selfNarrative', service: 'selfNarrative', optional: true },
        // v4.12.8: Memory consolidation during idle
        { prop: 'unifiedMemory', service: 'unifiedMemory', optional: true },
        // v5.0.0: Genome traits + Metabolism energy gating
        { prop: '_genome', service: 'genome', optional: true, expectedActive: true, expects: ['trait'] },
        { prop: '_metabolism', service: 'metabolism', optional: true, expectedActive: true },
        // v6.0.8: Directed curiosity — explore weak areas
        { prop: '_cognitiveSelfModel', service: 'cognitiveSelfModel', optional: true, expectedActive: true, expects: ['getCapabilityProfile'] },
        // v7.1.5: EmotionalFrontier — emotion-aware activity targeting
        { prop: '_emotionalFrontier', service: 'emotionalFrontier', optional: true, expectedActive: true },
        // v7.1.6: Frontier writers — research topic sources
        { prop: '_unfinishedWorkFrontier', service: 'unfinishedWorkFrontier', optional: true, expectedActive: true, expects: ['getRecent'] },
        { prop: '_suspicionFrontier', service: 'suspicionFrontier', optional: true, expectedActive: true, expects: ['getRecent'] },
        { prop: '_lessonFrontier', service: 'lessonFrontier', optional: true, expectedActive: true, expects: ['getRecent'] },
        // v7.1.6: WebFetcher — for research activity
        { prop: '_webFetcher', service: 'webFetcher', optional: true, expectedActive: true, expects: ['fetch'] },
        // v7.1.6: TrustLevelSystem — research trust gate
        { prop: '_trustLevelSystem', service: 'trustLevelSystem', optional: true, expectedActive: true, expects: ['getLevel'] },
        // v7.2.0: LessonsStore — for self-define activity
        { prop: 'lessonsStore', service: 'lessonsStore', optional: true, expectedActive: true, expects: ['getAll', 'getStats'] },
        // v7.7.9: InnerSpeech — first-person thought channel.
        // IdleMind continues writing journal.jsonl + IDLE_THOUGHT events
        // unchanged. emit() is additive — never blocks idle cycle.
        { prop: 'innerSpeech', service: 'innerSpeech', optional: true,
          expects: ['emit'],
          impact: 'Idle thoughts not routed to inner-speech channel; PSE cannot subscribe' },
        // v7.9.4: Können Phase 3 — required for SkillRehearsal activity.
        // Both optional with graceful degradation: without them the activity
        // returns 0 in shouldTrigger and never runs.
        { prop: 'skillManager', service: 'skills', optional: true,
          impact: 'SkillRehearsal activity disabled — cannot execute pending skills' },
        { prop: 'effectivenessTracker', service: 'skillEffectivenessTracker', optional: true,
          impact: 'SkillRehearsal cannot record invocation outcomes for Wilson-LB' },
      ],
      factory: (c) => {
        const im = new (R('IdleMind').IdleMind)({
          bus, model: c.resolve('llm'), prompts: c.resolve('prompts'),
          selfModel: c.resolve('selfModel'), memory: c.resolve('memory'),
          knowledgeGraph: c.resolve('knowledgeGraph'), eventStore: c.resolve('eventStore'),
          storageDir: genesisDir, goalStack: c.resolve('goalStack'),
          intervals, storage: c.resolve('storage'),
        });
        // v7.5.7-fix Phase 2: journal rotation + interval thresholds from settings.
        const settings = c.tryResolve ? c.tryResolve('settings') : null;
        // v7.9.4: keep a reference so IdleMind code paths (e.g. per-activity
        // metabolism cost in _think, goal-step balance in goal-loop) can
        // read live settings without re-resolving the container per cycle.
        im._settings = settings || null;
        const sz = settings?.get?.('idleMind.journalMaxFileSizeMB');
        const rot = settings?.get?.('idleMind.journalMaxRotations');
        if (typeof sz === 'number') im._journalMaxFileSizeMB = sz;
        if (typeof rot === 'number') im._journalMaxRotations = rot;
        // v7.5.7-fix Phase 2 round 3: idle/think minutes from settings (UI exposed).
        const idleMin = settings?.get?.('idleMind.idleMinutes');
        const thinkMin = settings?.get?.('idleMind.thinkMinutes');
        if (typeof idleMin === 'number' && idleMin > 0) im.idleThreshold = idleMin * 60 * 1000;
        if (typeof thinkMin === 'number' && thinkMin > 0) im.thinkInterval = thinkMin * 60 * 1000;
        return im;
      },
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
      factory: () => new (R('ErrorAggregator').ErrorAggregator)({ bus, intervals }),
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

    // V7-4A: External daemon control via Unix Socket / Named Pipe
    ['daemonController', {
      phase: 6, deps: ['daemon'], tags: ['autonomy', 'control'],
      lateBindings: [
        { prop: 'agentLoop', service: 'agentLoop', optional: true },
        // v7.6.1 audit-closeout: Self-Gate observation on socket-triggered
        // autonomous actions (extern daemon control → Genesis acts). Pairs
        // with the 'plan-start' check in AgentLoop.pursue() — both fire
        // when the action passes through both layers.
        { prop: 'selfGate', service: 'selfGate', optional: true },
      ],
      factory: (c) => {
        const settings = c.has('settings') ? c.resolve('settings') : null;
        const enabled = settings?.get?.('daemon.controlEnabled') ?? true;
        if (!enabled) return null;
        const socketPath = settings?.get?.('daemon.socketPath') || undefined;
        const ctrl = new (R('DaemonController').DaemonController)({
          bus, daemon: c.resolve('daemon'), container: c, socketPath,
        });
        ctrl.start();
        return ctrl;
      },
    }],

    // v5.9.2: Deployment Manager foundation — strategy-based deploys with rollback
    ['deploymentManager', {
      phase: 6, deps: [], tags: ['autonomy', 'deployment', 'devops'],
      lateBindings: [
        { prop: 'shell',            service: 'shellAgent',      optional: true },
        { prop: 'healthMonitor',    service: 'healthMonitor',   optional: true },
        { prop: 'hotReloader',      service: 'hotReloader',     optional: true },
        { prop: '_snapshotManager', service: 'snapshotManager', optional: true }, // v7.1.2: V7-4B real rollback
      ],
      factory: () => new (R('DeploymentManager').DeploymentManager)({ bus }),
    }],

    // v6.0.1: BackupManager — export/import ~/.genesis/ data
    ['backupManager', {
      phase: 6, deps: [], tags: ['autonomy', 'backup'],
      factory: () => new (R('BackupManager').BackupManager)(genesisDir, { bus }),
    }],

    // v6.0.1: AutoUpdater — GitHub release checker
    // v7.1.1: lateBinding to deploymentManager for optional auto-apply (V7-4B bridge)
    ['autoUpdater', {
      phase: 6, deps: [], tags: ['autonomy', 'update'],
      lateBindings: [
        { prop: '_settings',          service: 'settings',          optional: true },
        { prop: '_deploymentManager', service: 'deploymentManager', optional: true },
      ],
      factory: () => new (R('AutoUpdater').AutoUpdater)({ bus, intervals }),
    }],

    // v6.0.5: NetworkSentinel — connectivity monitoring + Ollama failover
    ['networkSentinel', {
      phase: 6, deps: [], tags: ['autonomy', 'network', 'resilience'],
      lateBindings: [
        { prop: '_modelBridge',    service: 'llm',            optional: true },
        { prop: '_settings',       service: 'settings',       optional: true },
        { prop: '_knowledgeGraph', service: 'knowledgeGraph', optional: true },
        { prop: '_lessonsStore',   service: 'lessonsStore',   optional: true },
      ],
      factory: () => new (R('NetworkSentinel').NetworkSentinel)({ bus, intervals }),
    }],
  ];
}

module.exports = { phase6 };
