// ============================================================
// GENESIS — manifest/phase9-cognitive-koennen.js
// Phase 9: Cognitive Architecture — Können sub-manifest (v7.8.9+)
//
// Holds the Können-Konzept services. Extracted from
// phase9-cognitive.js to keep that file under the 700-LOC
// architectural-fitness ceiling once v7.8.9 (and later v7.9.0,
// v7.9.1) added the Können-related modules.
//
// Services live logically in Phase 9 (cognitive). The split is
// purely file-size discipline; ContainerManifest combines both
// sub-manifests when assembling the full phase-9 service list.
//
// All services are optional — Genesis runs identically without
// the Können layer.
// ============================================================

function phase9Koennen(ctx, R) {
  const { bus, intervals } = ctx;

  return [
    // v7.8.9 (koennen-v789 contract): Affect-encoding at AgentLoop boundaries.
    // Snapshots emotional state at agent-loop:started, tracks peaks via
    // emotion:shift during the trajectory, sums surprise via
    // SurpriseAccumulator.getSignalsSince() at agent-loop:complete, evaluates
    // a baseline-relative triage gate, and persists every boundary (pass and
    // fail) to .genesis/koennen/candidates.jsonl for v7.9.0 calibration.
    ['koennenCandidateLog', {
      phase: 9,
      deps: ['bus'],
      tags: ['cognitive', 'koennen', 'v789'],
      lateBindings: [
        { prop: 'storage',             service: 'storage',             optional: true },
        { prop: 'emotionalState',      service: 'emotionalState',      optional: true },
        { prop: 'surpriseAccumulator', service: 'surpriseAccumulator', optional: true },
        { prop: 'genome',              service: 'genome',              optional: true },
      ],
      factory: () => new (R('KoennenCandidateLog').KoennenCandidateLog)({ bus, intervals }),
    }],

    // v7.8.9 (koennen-v789 contract): Reflects on accumulated skill candidates.
    // When ≥3 candidates passed gate within the last 7 days (with 6h cooldown),
    // emits koennen:candidates-noticed which SelfNarrative listens to.
    ['skillCandidateNarrative', {
      phase: 9,
      deps: ['bus'],
      tags: ['cognitive', 'koennen', 'narrative', 'v789'],
      lateBindings: [
        { prop: 'koennenCandidateLog', service: 'koennenCandidateLog', optional: true },
      ],
      factory: () => new (R('SkillCandidateNarrative').SkillCandidateNarrative)({ bus }),
    }],

    // v7.9.0 Phase 2 (koennen-crystallizer-v790 contract):
    // Tracks per-skill Wilson-LB. Public API only; Phase 3 (v7.9.1)
    // HabitatOutpost will call recordInvocation() during rehearsals.
    ['skillEffectivenessTracker', {
      phase: 9,
      deps: ['bus'],
      tags: ['cognitive', 'koennen', 'tracker', 'v790'],
      lateBindings: [
        { prop: 'storage',  service: 'storage',  optional: true },
        { prop: 'settings', service: 'settings', optional: true },
      ],
      factory: () => new (R('SkillEffectivenessTracker').SkillEffectivenessTracker)({ bus }),
    }],

    // v7.9.0 Phase 2 (koennen-crystallizer-v790 contract):
    // SkillCrystallizer runs as DreamCycle Phase 3c. Clusters
    // Können-candidates, asks LLM to extract a reusable skill per
    // cluster, runs CodeSafety + Sandbox-init gates, persists passing
    // skills to .genesis/koennen/skills-pending/ for Phase-3 promotion.
    ['skillCrystallizer', {
      phase: 9,
      deps: ['bus'],
      tags: ['cognitive', 'koennen', 'crystallizer', 'v790'],
      lateBindings: [
        { prop: 'model',            service: 'model',                optional: true },
        { prop: 'candidateLog',     service: 'koennenCandidateLog',  optional: true },
        { prop: 'embeddingService', service: 'embeddingService',     optional: true },
        { prop: 'codeSafety',       service: 'codeSafety',           optional: true },
        { prop: 'sandbox',          service: 'sandbox',              optional: true },
        { prop: 'settings',         service: 'settings',             optional: true },
      ],
      factory: () => new (R('SkillCrystallizer').SkillCrystallizer)({
        bus, genesisDir: ctx.genesisDir,
      }),
    }],
  ];
}

module.exports = { phase9Koennen };
