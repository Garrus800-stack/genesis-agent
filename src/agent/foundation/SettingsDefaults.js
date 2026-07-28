// ============================================================
// GENESIS — SettingsDefaults.js (v7.9.47 "Wachstums-Wache")
//
// The default settings tree, split out of Settings.js: 400 of its 699
// lines were this object, and the file sat one line under the 700-LOC
// guard that two watchers enforce (architectural fitness and the
// v7.9.29 hygiene contract). The tree is also the half that GROWS —
// every new setting lands here — so moving it is the split that lasts.
//
// Pure data, no I/O, no `this`. Settings.js takes a fresh copy per
// instance; nothing here is shared mutable state.
// ============================================================

'use strict';

const { TIMEOUTS } = require('../core/Constants');

/** The default settings tree. One fresh copy per Settings instance. */
const DEFAULTS = {
    models: {
      preferred: null, fallbackChain: [], anthropicApiKey: '', openaiBaseUrl: '', openaiApiKey: '', openaiModels: [],
      // v5.1.0: Per-task model assignment — null = use preferred/auto
      roles: { chat: null, code: null, analysis: null, creative: null },
      // v7.5.7-fix Phase 2: ollamaKeepAlive — null = Ollama default (5min).
      // Set to e.g. "30s" to free RAM faster, "0" to immediately unload
      // after each call, or "1h"/"-1" to keep loaded longer/forever.
      ollamaKeepAlive: null,
      // v7.5.7-fix Phase 2: maxConcurrent — how many parallel LLM requests
      // ModelBridge allows. Default 3 is the legacy value; users on
      // CPU-only setups may lower to 1 to avoid model thrashing in Ollama.
      maxConcurrent: 3,
    },
    daemon: { enabled: true, cycleMinutes: 5, autoRepair: true, autoOptimize: false },
    archive: { path: null },
    idleMind: {
      enabled: true, idleMinutes: 10, thinkMinutes: 15, maxActiveGoals: 3, journalMaxFileSizeMB: 10, journalMaxRotations: 3,
      // v7.9.4: every N goal-steps, break out of goal-execution and let the
      // activity-picker run instead. Keeps reflect/journal/dream/etc. firing
      // even when goals are active. 0 or null restores legacy always-goal
      // behavior. Default 3 = goal-step, goal-step, goal-step, activity, repeat.
      goalStepsPerActivityPick: 3,
      // v7.9.4 intent, NOT WIRED (found by the v7.9.47 audit): 'log' would
      // apply Math.log1p to dampen outlier activity boosts. Nothing reads
      // this key; _pickActivity does not consult it. Kept, not deleted.
      scoreNormalization: 'none',
      // v7.9.4 intent, NOT WIRED (found by the v7.9.47 audit): would favour
      // activities that have not run for a while. _pickActivity applies a
      // repetition PENALTY and no recurrence bonus, and nothing reads this
      // key. Kept as the recorded design — see docs/SETTINGS.md.
      recurrenceBonus: false,
    },
    // v7.5.7-fix Phase 2: SelfSpawner config
    selfSpawner: { maxWorkers: 3, timeoutMs: 5 * 60 * 1000, memoryLimitMB: 256 },
    // v7.5.7-fix Phase 2: WorkerPool (worker_threads, used by GenericWorker
    // for code-analysis/syntax-check/etc). 0 = use auto (cpus-1).
    workerPool: { maxWorkers: 0 },
    // v7.5.7-fix Phase 2: EventStore rotation. events.jsonl grows
    // unbounded over time; rotation keeps disk usage in check while
    // preserving recent history. 0 = disable rotation.
    eventStore: { maxFileSizeMB: 50, maxRotations: 3 },
    // v7.5.7-fix Phase 2: Memory caps. 0 = unlimited.
    // Generous defaults — users can lower if they hit performance issues
    // from large memory stores, or set 0 for unlimited.
    knowledgeGraph: { maxNodes: 5000 },
    selfStatementLog: { maxStatements: 5000 },
    episodicMemory: { maxEpisodes: 500 },
    // v7.7.9: InnerSpeech ring capacity. ~200 thoughts ≈ 200KB memory.
    // Older thoughts overflow to selfStatementLog, so this is purely the
    // hot-path window.
    innerSpeech: { capacity: 200 },
    // v7.7.9 Phase 2: ProactiveSelfExpression. Conservative defaults —
    // the user opts INTO higher frequency, not out of it. Phase 2
    // enables only the 'plan-failure-reflection' kind; other kinds
    // remain code-complete but gated off until Phase 3.
    //
    // No engagement-metric defaults exist anywhere here. By design.
    proactive: {
      enabled: true,
      minIntervalMs: 10 * 60 * 1000,            // 10 min between any two self-messages (v7.7.9 Phase 3b — Phase 3 burn-in showed 30 min suppressed 7/8 publishable thoughts in 28 min while the daily soft-cap (8) + per-kind floors + score dampener still throttle volume; 10 min keeps the minimum-gap function without choking the channel)
      userActivityCooldownMs: 10 * 60 * 1000,   // 10 minutes after user spoke
      baseThreshold: 0.55,                       // score must reach this to publish
      maxChars: 600,                             // sanity-check rejects longer
      dailyVolumeSoftCap: 8,                     // hard stop at 2× this
      quietHours: { start: '22:00', end: '07:00' },
      // v7.7.9 Phase 3: Full trigger-set open. All 5 kinds now active.
      // Conservative per-kind floors below ensure no single kind floods.
      // v7.7.9 ships Plan Phase 2 only — only plan-failure-reflection
      // is enabled by default. The other four kinds are code-complete
      // but gated off: per the Plan, idle-thought, goal-closure,
      // self-formulated-plan and question are Phase 3 territory, to
      // be enabled after Phase 2 is observed stable in real use.
      // Users can re-enable individual kinds via settings if they
      // want to opt into Phase 3 behaviour early.
      allowedKinds: [
        'plan-failure-reflection',
        // v7.9.36: allowed ≠ auto-trigger — concern is emitted ONLY by the
        // ConcernMonitor (same contract as prediction-mechanism-review).
        'concern',
        // v7.9.17: prediction-mechanism-review is allowed by default so
        // HardGates lets it through, but it has NO auto-trigger — it is
        // emitted ONLY by the /trajectory review handler. "Allowed" is not
        // "auto-produced": the thought exists only where the emit call is.
        // This satisfies "manual only" without runtime settings mutation.
        'prediction-mechanism-review',
      ],
      // Per-kind significance floors. Each kind has a different floor
      // for surfacing. plan-failure-reflection stays at 0.50 (the
      // Phase 2 default). idle-thought needs 0.70 + nov 0.65 — most
      // frequent trigger source, must be substantial to publish.
      // question needs 0.75 — the most invasive kind.
      // v7.9.36: generic per-kind wallclock caps (gate 6.5); concern ≤ 1/7d.
      perKindWallclockCaps: {
        concern: 604800000,
      },
      // v7.9.36: ConcernMonitor thresholds (two-source rule; see the monitor).
      concern: {
        hoursFloor: 20,          // >= total session hours in the 7-day window
        nightFloor: 3,           // OR >= sessions starting after nightHour
        nightHour: 23,
        patienceFloor: 0.35,     // chat signal: patience below AND …
        satisfactionFloor: 0.40, // … satisfaction below
        declineWindowMs: 2592000000, // 30 days of silence after 'not needed'
      },
      perKindFloors: {
        'plan-failure-reflection': { sigFloor: 0.50 },
        'idle-thought':            { sigFloor: 0.70, novFloor: 0.65 },
        'goal-closure-thought':    { sigFloor: 0.55 },
        'self-formulated-plan':    { sigFloor: 0.65 },
        'question':                { sigFloor: 0.75 },
        // v7.9.17: manually triggered via /trajectory review; the floor is
        // a formality (the handler emits it directly) but kept for symmetry.
        'prediction-mechanism-review': { sigFloor: 0.50 },
      },
    },
    // v7.7.9 Phase 3: Goal-lifecycle stalled-detection. The watchdog
    // converts hopelessly-blocked goals (e.g. blocked on a hallucinated
    // file path that will never exist) into proper failure-reflections.
    // Without it, such goals sat in the 'blocked' state forever and
    // the PSE pipeline never saw them.
    goals: {
      stalledTimeoutMs: 15 * 60 * 1000,         // 15 min blocked before stall-flag
      stalledWatchdogTickMs: 60 * 1000,         // scan once per minute
    },
    ui: {
      language: 'de',
      editorFontSize: 13,
      chatFontSize: 13,
      // v7.8.6: persisted widths for the three resizeable left panels.
      panelWidths: { 'file-tree': 220, 'goals': 280, 'editor': 600 },
    },
    security: { allowSelfModify: true, allowNetworkPeers: true, allowFileExecution: true },
    // v7.5.9 ZIP3 Phase 4a + ZIP5 Phase 4d: Software-installation defaults.
    // allowAutoInstall=false means "preview-only by default" — Genesis
    // shows the command it would run but does not execute. Set to true
    // AND raise trust to AUTONOMOUS (level 1) to enable Tier-1 (PM-install)
    // and Tier-2 (PM-bootstrap) automatically.
    //
    // fullAutonomy=true additionally enables Tier-3: direct download
    // from Genesis's curated software DB to ~/Downloads, and auto-launch
    // of the installer (Windows still shows a UAC prompt — that cannot
    // be bypassed). Without this toggle, Tier-3 stays preview-only even
    // at Trust 3.
    install: {
      allowAutoInstall: false,
      fullAutonomy: false,
      preferredPackageManager: 'auto',
      requireConfirmation: true,
      downloadDir: '~/Downloads',
    },
    // v7.5.9 ZIP3 Phase 4c: Language-Guard for self-modification.
    // Genesis only modifies its own JS/TS sources. Extending this
    // list is a deliberate decision — the safety properties of
    // ast-diff and the sandbox depend on the target being JS.
    selfModify: {
      allowedExtensions: ['.js', '.ts'],
    },
    // v7.9.9 (A): Trust level (0..2 = SUPERVISED, AUTONOMOUS, FULL_AUTONOMY).
    // Default is SUPERVISED (always ask) — completes v7.9.8 Fix 2's
    // "safe default for fresh installs" invariant at this last site.
    // Read by TrustLevelSystem.asyncLoad — overrides the persisted
    // trust-level.json default. UI dropdown writes here.
    trust: { level: 0 },
    // v7.4.7: Agency runtime preferences. autoResumeGoals selects
    // GoalDriver boot-pickup behavior (already wired in GoalDriver:562).
    // Values: 'ask' | 'always' | 'never'.
    // v7.5.0: negotiateBeforeAdd — when true, /goal add proposes
    // the goal as pending; Genesis then clarifies before it's
    // committed to the active stack. Default false for backwards
    // compatibility (existing users keep direct-add behaviour).
    // v7.5.2: autoRouteByTask — when true (default), ModelBridge.chat()
    // queries ModelRouter for non-user-chat taskTypes and switches model
    // per-call (without mutating activeModel). Direct user chat is
    // explicitly protected via _userChat marker in ChatOrchestrator.
    // v7.5.7-fix Phase 2: autoRouteByTask Default false. Was true (v7.5.2),
    // caused Genesis to load multiple model weights into Ollama in parallel
    // (one per task category) which on CPU-only setups led to 180s timeouts.
    // Users with GPU/multi-backend setups can re-enable via UI toggle.
    // v7.5.7-fix Phase 3: commitSnapshotOnShutdown — was hardcoded to
    // always-on in AgentCoreHealth.js, pollutes git history on collaborator
    // machines (commits .genesis/ state files at every shutdown). Default
    // false now — only opt-in for users who want shutdown-state in git.
    // Code-change snapshots in Reflector/SelfModificationPipeline are
    // unaffected — those happen at actual modification boundaries.
    // v7.7.1-hotfix: gitAutoInit + gitAutoCommit — both default off.
    // Genesis used to run `git init` + initial commit on any fresh
    // checkout (SelfModel.scan), and `git add+commit` at every code-change
    // boundary (Reflector, SelfModificationPipeline). On user repos this
    // pollutes history without consent. SnapshotManager (.genesis/snapshots/)
    // and GenesisBackup (.genesis-backups/) are the active fallback layers
    // and cover the same state-preservation use case via file-copy without
    // touching git. Opt-in only.
    agency: { autoResumeGoals: 'ask', negotiateBeforeAdd: false, autoRouteByTask: false, commitSnapshotOnShutdown: false, gitAutoInit: false, gitAutoCommit: false },
    mcp: { enabled: true, servers: [], serve: { enabled: false, port: 3580 } },
    // v7.5.7-fix Phase 3 Etappe 2: Health-Server defaults — was missing in
    // settings tree, only read by HealthServer service via .get(). UI now
    // exposes these so users can enable HTTP /health, /metrics endpoints.
    health: { httpEnabled: false, httpPort: 9090 },
    // v7.5.7-fix Phase 3 Etappe 2: Cost-Guard defaults — service uses
    // its own DEFAULTS (500k/2M/0.8), but settings tree was empty so the
    // UI couldn't pre-fill values. Defaults here mirror CostGuard.js.
    llm: {
      costGuard: {
        enabled: true,
        sessionTokenLimit: 500000,
        dailyTokenLimit: 2000000,
        warnThreshold: 0.8,
      },
      // v7.9.5 live-fix: ContinuationLoop max-attempts cap (Ollama code
      // generation). Was hardcoded MAX_CONTINUATIONS_DEFAULT=4. Heavy
      // code generations (multi-thousand-char outputs from qwen3-coder)
      // hit the ceiling with partial responses. Higher is safer for
      // quality, lower is safer for runaway-cost. Range 1..20.
      // v7.9.8 Fix 6: raised default 4 → 6 to match ContinuationLoop's
      // own default. The v7.9.7 P6 fix only touched ContinuationLoop's
      // MAX_CONTINUATIONS_DEFAULT, but ModelBridgeContinuation reads
      // from Settings and the Settings default was still 4 — heavy
      // code generations in Win-trace still cut off at attempt 4.
      // v7.9.9 noted that large cloud generations still truncated at 6.
      // v7.9.10 addressed that not by raising this global default but by
      // lifting the cap per capability: ContinuationLoop's
      // computeEffectiveMaxContinuations keeps 6 for local verified-prefill
      // models (where 6 suffices) and lifts no-prefill/cloud models to
      // CLOUD_NO_PREFILL_FLOOR (10). So 6 is the correct local-prefill
      // floor here; the 10 lives where it belongs, in the cloud path.
      continuation: { maxAttempts: 6 },
      // v7.9.12: Ollama HTTP idle-timeouts. localTimeoutMs was read by
      // phase1-foundation since v7.5.9 but never had a default entry here
      // (settings.get returned undefined → backend fell back to the
      // TIMEOUTS constant). Declaring both makes them UI-surfaceable and
      // keeps the defaults tree honest. cloudTimeoutMs (v7.9.12) is the
      // longer ceiling for Ollama-proxied cloud models (e.g. *-cloud).
      // v7.9.13: reference the constants instead of hardcoding the numbers,
      // so the default tracks the single source of truth in Constants.js
      // and cannot drift from it.
      localTimeoutMs: TIMEOUTS.LLM_RESPONSE_LOCAL,
      cloudTimeoutMs: TIMEOUTS.LLM_RESPONSE_CLOUD_OLLAMA,
      // v7.9.13: stream timeouts surfaced as settings (Constants.js promised
      // this override but never wired it). Values reference the constants so
      // they cannot drift. Affect only Ollama code-gen streaming (taskType
      // 'code'), the single path ContinuationLoop → StreamingCompletion.
      streamTimeouts: {
        firstChunk: TIMEOUTS.LLM_STREAM_FIRST_CHUNK,
        chunk: TIMEOUTS.LLM_STREAM_CHUNK,
        total: TIMEOUTS.LLM_STREAM_TOTAL,
        continuationTotal: TIMEOUTS.LLM_CONTINUATION_TOTAL,
      },
      numCtxCap: 65536, maxTokensDefault: 0, // v7.9.37 pass 4 (C1/C2): real-window cap; 0 = derive min(8192, ctx/4)
    },
    // v3.5.0: Configurable timeouts (were hardcoded across modules)
    timeouts: { approvalSec: 0, shellMs: 15000, httpMs: 60000, gitMs: 5000 },
    // v7.9.5 live-fix: shutdown LLM-call protection. Pre-fix, session
    // summary blocked the entire shutdown for as long as the LLM took
    // to respond (observed 80s+ with cloud models). Now: skip if the
    // session is shorter than minMs AND has no content, otherwise hard
    // timeout at timeoutMs. Both adjustable for users who run a fast
    // local model and want the summary every time.
    shutdown: { sessionSummaryMinMs: 60000, sessionSummaryTimeoutMs: 8000 },
    // v7.9.5 live-fix: peer discovery token subtree — was referenced by
    // PeerTransport.startDiscovery but never declared in the tree, so
    // settings.get('peer.discoveryToken') returned undefined and multicast
    // discovery stayed off even if the user wanted to enable it. Empty
    // default means discovery is opt-in (set a non-empty string here to
    // turn it on for peers sharing the same token).
    peer: { discoveryToken: '' },
    // v3.7.0: Cognitive strictMode — when true, AgentLoop refuses to run
    // unless core cognitive services (verifier, formalPlanner, worldState) are bound.
    // Default false for backwards compatibility.
    cognitive: {
      strictMode: false,
      // v4.0: Phase 9 — Cognitive Architecture feature flags
      // All features default to true. Set to false to disable individually.
      phase9Enabled: true,
      // v7.9.5 live-fix: per-PromptBuild rebuild of the architecture graph
      // triggered every ~6 minutes via the staleness check (default 5 min).
      // Bumped to 15 minutes — the graph is stable between self-mods and
      // doesn't need to be rebuilt that often. Configurable in case heavy
      // self-mod sessions want fresher reads.
      architectureReflection: { staleThresholdMs: 900000 },
      expectations: {
        enabled: true,
        minSamples: 10,           // Min MetaLearning samples for statistical prediction
        confidenceCap: 0.95,
      },
      simulation: {
        enabled: true,
        maxBranches: 3,
        maxDepth: 15,
        pruneThreshold: 0.05,
        timeBudgetMs: 5000,
      },
      surprise: {
        enabled: true,
        noveltyThreshold: 1.5,
        significantThreshold: 0.8,
        amplifiedLearning: true,  // Feed surprise weights into MetaLearning
      },
      dreams: {
        enabled: true,
        useLLM: true,             // false = heuristic-only (no LLM cost)
        minEpisodes: 10,
        maxDurationMs: 120000,
        consolidationIntervalMs: 30 * 60 * 1000,
      },
      selfNarrative: {
        enabled: true,
        injectInPrompts: true,    // false = narrative exists but isn't injected
        updateThreshold: 20,      // Accumulated change points before update
      },
      schemas: {
        maxSchemas: 200,
        relevanceThreshold: 0.3,
        confidenceDecayRate: 0.005,
      },
      // v7.9.0 Phase 2: Können — skill crystallization layer.
      // v7.9.4 extends with promotion, rehearsal, and acquisitionContext.
      koennen: {
        enabled: true,
        crystallization: {
          enabled: true,
          minCandidatesPerPattern: 3,
          windowMs: 7 * 24 * 60 * 60 * 1000,    // 7d lookback
          cooldownMs: 6 * 60 * 60 * 1000,       // 6h per pattern
          llm: { enabled: true, maxTokens: 2000, timeoutMs: 120000 },
          sandbox: { initTestTimeoutMs: 10000 },
          // v7.9.4: short first-person reflection generated at crystallization.
          acquisitionContext: { enabled: true, timeoutMs: 30000, maxLength: 500 },
        },
        effectiveness: {
          initialEvidence: 1,         // Wilson seed: 1 success / 1 total
          decayPerWeek: 0.05,         // Confidence drift when unused
        },
        // v7.9.4: promotion criteria for pending skills (conservative).
        promotion: {
          enabled: true,
          minInvocations:    8,                     // total rehearsals + productive uses
          minWilsonLB:       0.70,                  // confidence lower bound
          minDistinctInputs: 3,                     // distinct input shapes seen
          minAgeMs:          48 * 60 * 60 * 1000,   // 48h since crystallization
          discardSuggestionAfterDays: 14,
        },
        // v7.9.4: rehearsal as 16th IdleMind activity.
        rehearsal: {
          enabled: true,
          cooldownMs: 10 * 60 * 1000,
          inputGeneration: { llmFallback: true, timeoutMs: 30000 },
        },
      },
    },
    // v3.5.0: Organism tuning — previously hardcoded in EmotionalState/Homeostasis/NeedsSystem
    organism: {
      emotions: {
        decayIntervalMs: 60000,        // How often emotions drift toward baseline
        lonelinessIntervalMs: 300000,   // How often loneliness grows passively
        lonelinessGrowth: 0.008,        // Loneliness increment per tick
        significantShift: 0.05,         // Min change to emit emotion:shift event
        baselines: { curiosity: 0.6, satisfaction: 0.5, frustration: 0.1, energy: 0.7, loneliness: 0.3 },
        decayRates: { curiosity: 0.02, satisfaction: 0.03, frustration: 0.04, energy: 0.01, loneliness: 0.005 },
      },
      homeostasis: {
        tickIntervalMs: 30000,          // How often vitals are checked
        recoveryDurationMs: 300000,     // How long recovery mode lasts
        criticalThreshold: 2,           // N vitals in warning → enter recovery
        maxErrorWindowMs: 60000,        // Error rate window
        thresholds: {
          errorRate: { healthy: 0.5, warning: 2.0 },
          memoryPressure: { healthy: 75, warning: 90 },
          kgNodeCount: { healthy: 3000, warning: 5000 },
          responseLatency: { healthy: 5000, warning: 15000 },
        },
      },
      needs: {
        growthIntervalMs: 120000,       // How often needs grow
        growthRates: { knowledge: 0.008, social: 0.005, maintenance: 0.003, rest: 0.002 },
        weights: { knowledge: 1.2, social: 0.8, maintenance: 1.0, rest: 0.6 },
        satisfyAmounts: { knowledge: 0.15, social: 0.25, maintenance: 0.20, rest: 0.12 },
      },
      // v7.9.4: Metabolism settings — per-activity differentiated energy
      // costs. Pre-fix every IdleMind activity charged the flat
      // idleMindCycle cost of 2 energy, so a heavy Plan (LLM call) cost
      // the same as a 2-line Journal entry. Now Metabolism.ACTIVITY_COSTS
      // has per-activity keys (idleMind:plan = 12, idleMind:journal = 2,
      // etc.) and IdleMind._think() fires a second consume() with the
      // activity-specific key after each pick. Set to false to revert to
      // the flat-rate-only behaviour.
      metabolism: {
        differentiatedCosts: true,
      },
      // v7.9.5: Inhabit activity — Genesis's 17th IdleMind activity.
      // Composes a deterministic self-state snapshot (energy, dominant
      // emotion, urgent need, body restrictions, goal count) and emits
      // it via InnerSpeech with kind 'self-state-snapshot'. PSE HardGate
      // blocks proactive surfacing — the text stays private to Genesis.
      // Read-only display in the Dashboard "Inner state" widget.
      inhabit: {
        enabled: true,                   // Master toggle; false fully disables the activity
        cooldownMinutes: 15,             // Min minutes between two inhabit emissions
        idleBoost: true,                 // Boost selection chance during long idle stretches
      },
    },
};

/** Deep copy so two Settings instances never share nested objects. */
function defaultSettings() {
  return JSON.parse(JSON.stringify(DEFAULTS));
}

module.exports = { DEFAULTS, defaultSettings };
