// @ts-checked-v5.8
// ============================================================
// GENESIS — Settings.js (v2 — with API key encryption)
// Persistent configuration. API keys are encrypted at rest
// using AES-256-GCM with a machine-derived key.
// Stored in .genesis/settings.json.
// ============================================================

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');
const { createLogger } = require('../core/Logger');
const _log = createLogger('Settings');

// v7.6.7 Track A: Encryption-at-rest concern extracted to SettingsEncryption.js
// (Mixin pattern, analog ModelBridgeFailover.js). Module-level helpers are
// invoked directly via `enc.encryptValue(...)` etc.; instance methods are
// mounted onto Settings.prototype at the bottom of this file.
const enc = require('./SettingsEncryption');
const {
  SENSITIVE_KEYS,
  ENC_PREFIX,
  ENC_PREFIX_V2,
  ENC_PREFIX_V3,
  encryptValue,
  decryptValue,
} = enc;

// v7.4.7: Settings whose changes need runtime side-effects (start/stop
// services, gate runtime behavior). Mapped to bus events that
// AgentCoreWire listens for. Settings whose change requires a restart
// to take effect (e.g. timeouts.approvalSec injected into agentLoop)
// are NOT in this map — they're advisory-only via the UI hint.
const TOGGLE_EVENT_KEYS = {
  'daemon.enabled':            'settings:daemon-toggled',
  'idleMind.enabled':          'settings:idlemind-toggled',
  'security.allowSelfModify':  'settings:selfmod-toggled',
  'trust.level':               'settings:trust-level-changed',
  'agency.autoResumeGoals':    'settings:auto-resume-changed',
  'agency.autoRouteByTask':    'settings:auto-route-toggled',  // v7.5.2
  'mcp.serve.enabled':         'settings:mcp-serve-toggled',
};

class Settings {
  constructor(storageDir, storage) {
    this.storage = storage || null;
    this._storageDir = storageDir;
    this.filePath = path.join(storageDir, 'settings.json');
    // v7.4.7: Optional bus for emitting setting-change events.
    // Set later via setBus(). Used so that Daemon/IdleMind/SelfMod
    // toggles take effect at runtime, not just at next boot.
    this._bus = null;
    // v7.6.6 Track A: installation-anchored encryption.
    // Lazy-loaded on first crypto operation via _getInstallId().
    // Sentinel '' = "tried, failed, fall back to legacy hostname-key".
    this._installId = null;
    // v7.6.6 Track A.4: SENSITIVE_KEYS that could not be decrypted during
    // load/migration. Fired as settings:keys-unreadable from setBus()
    // once the bus is available, then cleared.
    this._unreadableKeys = [];
    // FIX v4.10.0 (M-4): Use a randomly generated salt persisted to disk.
    // Previously, salt was deterministic from storageDir path — an attacker
    // with local access could reconstruct the key without brute force.
    // Random salt is generated on first run and stored in .genesis/enc-salt.
    this._encSalt = this._loadOrCreateSalt(storageDir);
    this.data = {
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
      idleMind: { enabled: true, idleMinutes: 2, thinkMinutes: 3, maxActiveGoals: 3, journalMaxFileSizeMB: 10, journalMaxRotations: 3 },
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
        ],
        // Per-kind significance floors. Each kind has a different floor
        // for surfacing. plan-failure-reflection stays at 0.50 (the
        // Phase 2 default). idle-thought needs 0.70 + nov 0.65 — most
        // frequent trigger source, must be substantial to publish.
        // question needs 0.75 — the most invasive kind.
        perKindFloors: {
          'plan-failure-reflection': { sigFloor: 0.50 },
          'idle-thought':            { sigFloor: 0.70, novFloor: 0.65 },
          'goal-closure-thought':    { sigFloor: 0.55 },
          'self-formulated-plan':    { sigFloor: 0.65 },
          'question':                { sigFloor: 0.75 },
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
      ui: { language: 'de', editorFontSize: 13, chatFontSize: 13 },
      security: { allowSelfModify: true, allowNetworkPeers: true, allowFileExecution: true },
      // v7.5.9 ZIP3 Phase 4a + ZIP5 Phase 4d: Software-installation defaults.
      // allowAutoInstall=false means "preview-only by default" — Genesis
      // shows the command it would run but does not execute. Set to true
      // AND raise trust to AUTONOMOUS (2) to enable Tier-1 (PM-install)
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
      // v7.4.7: Trust level (0..3 = SUPERVISED..FULL_AUTONOMY).
      // Read by TrustLevelSystem.asyncLoad — overrides the persisted
      // trust-level.json default. UI dropdown writes here.
      trust: { level: 1 },
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
      },
      // v3.5.0: Configurable timeouts (were hardcoded across modules)
      timeouts: { approvalSec: 60, shellMs: 15000, httpMs: 60000, gitMs: 5000 },
      // v3.7.0: Cognitive strictMode — when true, AgentLoop refuses to run
      // unless core cognitive services (verifier, formalPlanner, worldState) are bound.
      // Default false for backwards compatibility.
      cognitive: {
        strictMode: false,
        // v4.0: Phase 9 — Cognitive Architecture feature flags
        // All features default to true. Set to false to disable individually.
        phase9Enabled: true,
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
      },
    };
    // FIX v7.0.8: Moved _load() back into constructor (was asyncLoad since v3.8.0).
    // _load() is synchronous (readJSON is sync). Having it in asyncLoad() caused a
    // race condition: ModelBridge.asyncLoad() runs concurrently in the same boot level
    // and reads models.preferred BEFORE Settings._load() applies env overrides.
    // Result: GENESIS_MODEL env var was ignored, auto-select picked wrong model.
    this._load();
    // v7.5.7-fix Phase 3 Etappe 3: Sanity-clamp known numeric fields after load.
    // Without this, a malformed settings.json (manual edit, copied from older
    // version) could make Genesis crash because e.g. maxConcurrent=-1 or
    // sessionTokenLimit=NaN gets passed to schedulers/budgets.
    this._sanityClampOnLoad();
  }

  /**
   * v7.5.7-fix Phase 3 Etappe 3: Clamp known numeric settings to valid ranges.
   * Logs a warning when clamping; does not throw. Mirror of the UI's
   * settings-defaults.js registry.
   */
  _sanityClampOnLoad() {
    const log = (msg) => { try { require('../core/Logger').createLogger('Settings').warn(`[SANITY] ${msg}`); } catch (_e) { /* logger optional */ } };
    const clamp = (path, min, max) => {
      const v = this.get(path);
      if (typeof v !== 'number' || Number.isNaN(v)) return;
      if (v < min) { this._setRaw(path, min); log(`${path}=${v} clamped to ${min} (min)`); }
      else if (v > max) { this._setRaw(path, max); log(`${path}=${v} clamped to ${max} (max)`); }
    };
    clamp('models.maxConcurrent',                 1, 50);
    clamp('selfSpawner.maxWorkers',               1, 50);
    clamp('selfSpawner.timeoutMs',                10000, 3600000);
    clamp('selfSpawner.memoryLimitMB',            64, 8192);
    clamp('workerPool.maxWorkers',                0, 64);
    clamp('eventStore.maxFileSizeMB',             0, 5000);
    clamp('eventStore.maxRotations',              0, 100);
    clamp('knowledgeGraph.maxNodes',              0, 1000000);
    clamp('selfStatementLog.maxStatements',       0, 1000000);
    clamp('episodicMemory.maxEpisodes',           0, 1000000);
    // v7.7.9: InnerSpeech capacity bounded so badly-edited settings don't
    // allocate enormous arrays. 1..10000 covers reasonable use cases.
    clamp('innerSpeech.capacity',                 1, 10000);
    // v7.7.9 Phase 2: PSE numeric clamps. Bounded so badly-edited settings
    // can't disable the boundary altogether. minIntervalMs ≥ 30s prevents
    // accidental flooding; baseThreshold ∈ [0,1] is a score; maxChars
    // bounded so PSE can't push novella-length messages.
    clamp('proactive.minIntervalMs',              30 * 1000, 24 * 60 * 60 * 1000);
    clamp('proactive.userActivityCooldownMs',     0,         24 * 60 * 60 * 1000);
    clamp('proactive.baseThreshold',              0,         1);
    clamp('proactive.maxChars',                   50,        4000);
    clamp('proactive.dailyVolumeSoftCap',         0,         100);
    // v7.7.9 Phase 3: StalledGoalWatchdog timeouts. timeoutMs ≥ 60s
    // prevents accidental over-aggressive stall-flagging. tickMs ≥ 5s
    // prevents busy-loop scans, ≤ 10 min prevents drift on long-running
    // sessions.
    clamp('goals.stalledTimeoutMs',               60 * 1000, 24 * 60 * 60 * 1000);
    clamp('goals.stalledWatchdogTickMs',          5 * 1000,  10 * 60 * 1000);
    clamp('llm.costGuard.sessionTokenLimit',      1000, 100000000);
    clamp('llm.costGuard.dailyTokenLimit',        1000, 1000000000);
    clamp('llm.costGuard.warnThreshold',          0.5, 0.99);
    clamp('idleMind.idleMinutes',                 1, 1440);
    clamp('idleMind.thinkMinutes',                1, 1440);
    clamp('idleMind.maxActiveGoals',              1, 100);
    clamp('idleMind.journalMaxFileSizeMB',        1, 5000);
    clamp('idleMind.journalMaxRotations',         0, 100);
    clamp('daemon.cycleMinutes',                  1, 1440);
    clamp('mcp.serve.port',                       1024, 65535);
    clamp('health.httpPort',                      1024, 65535);
    clamp('timeouts.approvalSec',                 10, 86400);
    clamp('cognitive.simulation.maxBranches',     1, 100);
    clamp('cognitive.simulation.maxDepth',        1, 1000);
    clamp('organism.emotions.decayIntervalMs',    1000, 3600000);
    clamp('organism.emotions.lonelinessIntervalMs', 1000, 86400000);
    clamp('ui.editorFontSize',                    8, 48);
    clamp('ui.chatFontSize',                      8, 48);
    clamp('trust.level',                          0, 3);
  }

  /** Internal: write value at dot-path without touching events or _save. */
  _setRaw(dotPath, value) {
    const parts = dotPath.split('.');
    let obj = this.data;
    for (let i = 0; i < parts.length - 1; i++) {
      if (!obj[parts[i]] || typeof obj[parts[i]] !== 'object') return;
      obj = obj[parts[i]];
    }
    obj[parts[parts.length - 1]] = value;
  }


  /**
   * v7.6.6 Track A: Lazy-load the installation UUID from `.install-id`.
   * Cached in this._installId. Sentinel '' on failure (fall back to
   * legacy hostname-derived key for encrypt/decrypt). Returns null when
   * the cached sentinel is empty so callers see a clean tri-state:
   * UUID-string | null.
   */
  _getInstallId() {
    if (this._installId !== null) {
      return this._installId || null;
    }
    try {
      const { getOrCreate } = require('./InstallId.js');
      this._installId = getOrCreate(this._storageDir);
    } catch (err) {
      _log.warn(`[SETTINGS] InstallId unavailable, falling back to legacy machine-id: ${err.message}`);
      this._installId = ''; // sentinel: tried, failed
    }
    return this._installId || null;
  }

  /** @param {string} dotPath @param {*} value */
  /**
   * v7.4.7: Late-bind a bus so set() can emit toggle events for
   * Daemon/IdleMind/SelfMod runtime toggles. Called from AgentCoreWire
   * after Settings is resolved (Settings is in phase 0, bus also).
   *
   * v7.6.6 Track A.4: Also fires settings:keys-unreadable for any
   * SENSITIVE_KEYS that failed to decrypt during load (e.g. after
   * `.install-id` rotation). Buffer is cleared after fire so subsequent
   * setBus() calls do not refire the same event.
   * @param {*} bus
   */
  setBus(bus) {
    this._bus = bus || null;
    if (this._bus && this._unreadableKeys.length > 0) {
      try {
        this._bus.fire('settings:keys-unreadable', { keys: this._unreadableKeys.slice() }, { source: 'Settings' });
      } catch (_e) { /* never let event-fire break setBus */ }
      this._unreadableKeys = [];
    }
  }

  set(dotPath, value) {
    const parts = dotPath.split('.');
    let obj = this.data;
    for (let i = 0; i < parts.length - 1; i++) {
      if (!obj[parts[i]] || typeof obj[parts[i]] !== 'object') obj[parts[i]] = {};
      obj = obj[parts[i]];
    }
    // v7.4.7: capture old value BEFORE write so toggle events can be
    // emitted with from/to. Used for runtime daemon/idleMind/selfMod
    // toggles — without this, AgentCoreWire's listener can't tell if
    // the value actually changed.
    const oldValue = obj[parts[parts.length - 1]];
    if (SENSITIVE_KEYS.has(dotPath) && value && typeof value === 'string'
        && !value.startsWith(ENC_PREFIX)
        && !value.startsWith(ENC_PREFIX_V2)
        && !value.startsWith(ENC_PREFIX_V3)) {
      obj[parts[parts.length - 1]] = encryptValue(value, this._encSalt, this._getInstallId());
    } else {
      obj[parts[parts.length - 1]] = value;
    }
    this._save();
    // v7.4.7: Emit toggle events for runtime-relevant settings.
    // Listened to in AgentCoreWire to start/stop services live.
    if (this._bus && oldValue !== value) {
      const eventKey = TOGGLE_EVENT_KEYS[dotPath];
      if (eventKey) {
        try {
          this._bus.fire(eventKey, { from: oldValue, to: value, key: dotPath }, { source: 'Settings' });
        } catch (_e) { /* never let event-emit break a save */ }
      }
    }
  }

  /**
   * v7.5.7-fix Phase 3: batch-set multiple settings in a single call.
   * UI was previously sending one IPC per setting (4-8 per Save click),
   * each triggering listeners (e.g. ModelBridge.setRoles → log spam).
   * This call writes everything, then emits toggle events once at the end.
   *
   * Returns array of changes for caller (e.g. for change-log display).
   *
   * @param {Array<[string, *]>} entries - [dotPath, value] pairs
   * @returns {Array<{ key: string, from: *, to: * }>} changes that occurred
   */
  setBatch(entries) {
    if (!Array.isArray(entries) || entries.length === 0) return [];
    const changes = [];
    const eventQueue = [];

    for (const [dotPath, value] of entries) {
      if (typeof dotPath !== 'string') continue;
      const parts = dotPath.split('.');
      let obj = this.data;
      for (let i = 0; i < parts.length - 1; i++) {
        if (!obj[parts[i]] || typeof obj[parts[i]] !== 'object') obj[parts[i]] = {};
        obj = obj[parts[i]];
      }
      const oldValue = obj[parts[parts.length - 1]];
      if (SENSITIVE_KEYS.has(dotPath) && value && typeof value === 'string'
          && !value.startsWith(ENC_PREFIX)
          && !value.startsWith(ENC_PREFIX_V2)
          && !value.startsWith(ENC_PREFIX_V3)) {
        obj[parts[parts.length - 1]] = encryptValue(value, this._encSalt, this._getInstallId());
      } else {
        obj[parts[parts.length - 1]] = value;
      }
      // v7.5.7-fix Phase 3 followup: deep-equality for arrays/objects so
      // that "no actual change" doesn't trigger spurious change-log entries
      // (was visible in user logs as `mcp.servers: [0 items] → [0 items]`).
      // Reference-inequality alone fires even when contents are identical.
      const isChanged = (() => {
        if (oldValue === value) return false;
        if (typeof oldValue !== typeof value) return true;
        if (oldValue === null || value === null) return oldValue !== value;
        if (typeof oldValue === 'object') {
          try { return JSON.stringify(oldValue) !== JSON.stringify(value); }
          catch (_e) { return true; }
        }
        return oldValue !== value;
      })();
      if (isChanged) {
        changes.push({ key: dotPath, from: oldValue, to: value });
        const eventKey = TOGGLE_EVENT_KEYS[dotPath];
        if (eventKey) eventQueue.push({ eventKey, payload: { from: oldValue, to: value, key: dotPath } });
      }
    }

    // Single save for entire batch (debounced anyway, but call once cleanly)
    this._save();

    // Emit toggle events after all writes are done
    if (this._bus) {
      for (const ev of eventQueue) {
        try { this._bus.fire(ev.eventKey, ev.payload, { source: 'Settings' }); }
        catch (_e) { /* never let event-emit break the batch */ }
      }
    }

    return changes;
  }

  get(dotPath) {
    const parts = dotPath.split('.');
    /** @type {*} */ let val = this.data;
    for (const p of parts) { if (val == null) return undefined; val = val[p]; }
    if (SENSITIVE_KEYS.has(dotPath) && typeof val === 'string'
        && (val.startsWith(ENC_PREFIX) || val.startsWith(ENC_PREFIX_V2) || val.startsWith(ENC_PREFIX_V3))) {
      return decryptValue(val, this._encSalt, this._getInstallId());
    }
    return val;
  }

  getAll() {
    const copy = JSON.parse(JSON.stringify(this.data));
    const antKey = this.get('models.anthropicApiKey');
    copy.models.anthropicApiKey = antKey ? antKey.slice(0, 8) + '...' : '';
    const oaiKey = this.get('models.openaiApiKey');
    copy.models.openaiApiKey = oaiKey ? oaiKey.slice(0, 8) + '...' : '';
    return copy;
  }

  getRaw() { return this.data; }

  /**
   * v7.4.0: Runtime snapshot for RuntimeStatePort.
   * I/O-free, in-memory only. Uses getAll() (NOT getRaw())
   * so API keys are already masked by the time they leave
   * this method. Whitelist: backend, model, trustLevel,
   * language. Everything else stays internal.
   *
   * CRITICAL: NEVER call getRaw() here. That would bypass
   * the masking and leak real API keys into the prompt.
   */
  getRuntimeSnapshot() {
    const all = this.getAll();  // already masked
    return {
      backend: all?.models?.defaultBackend || null,
      model: all?.models?.defaultModel || null,
      trustLevel: all?.trust?.level || null,
      language: all?.ui?.language || null,
    };
  }
  hasAnthropic() { const k = this.get('models.anthropicApiKey'); return !!(k && k.length > 10); }
  hasOpenAI() { return !!(this.get('models.openaiBaseUrl') && this.get('models.openaiApiKey')); }

  _save() {
    try {
      // v3.7.1: Non-blocking via debounced async write.
      // Settings changes are user-triggered and infrequent — debounce is ideal.
      if (this.storage) this.storage.writeJSONDebounced('settings.json', this.data, 500);
    } catch (err) { _log.warn('[SETTINGS] Save failed:', err.message); }
  }

  /**
   * v3.8.0: Was async boot-time loading. Since v7.0.8, _load() runs in
   * constructor (sync) to avoid race conditions with ModelBridge.
   * asyncLoad() kept as no-op for Container.bootAll() compatibility.
   */
  async asyncLoad() {
    // _load() already called in constructor — nothing to do.
  }


  _load() {
    try {
      let loaded = null;
      if (this.storage) {
        loaded = this.storage.readJSON('settings.json', null);
      }
      if (loaded) {
        this.data = this._deepMerge(this.data, loaded);
        this._migratePlaintextKeys();
        // v7.6.6 Track A.3: Re-key legacy enc:/enc2: ciphertexts to enc3:
        // (installation-anchored). Atomic, idempotent, partial-success-safe.
        this._migrateLegacyEncryption();
        // v7.6.6 Track A.4: Detect enc3: values that fail to decrypt
        // (typically after .install-id rotation). Buffered for setBus()
        // to fire as settings:keys-unreadable.
        this._checkUnreadableV3Keys();
      }
    } catch (err) { _log.warn('[SETTINGS] Load failed, using defaults:', err.message); }

    // v5.9.0: Environment variable overrides (for headless/CI mode)
    this._applyEnvOverrides();
  }

  /**
   * v7.6.6 Track A.3: Re-key any legacy `enc:`/`enc2:` ciphertext to
   * `enc3:` using the installation-anchored key. Runs once on first
   * v7.6.6 boot of an existing install; idempotent on subsequent boots.
   *
   * Properties:
   *   - Pre-migration backup created before any rewrite
   *     (`settings.json.pre-v3-migration`, only if not already present)
   *   - Partial success accepted: keys whose legacy decrypt fails are
   *     left as-is and tracked in `_unreadableKeys` for the boot-time
   *     warning event
   *   - No-op when no install-id is available (cannot create v3 ciphertexts)
   *   - No-op when no legacy-prefix values are present
   *   - Single _save() at end so failure mid-loop does not leave a
   *     partially-written file (the in-memory state is the only thing
   *     mutated until save)
   */
  _deepMerge(target, source) {
    const result = { ...target };
    for (const key of Object.keys(source)) {
      if (source[key] && typeof source[key] === 'object' && !Array.isArray(source[key])) {
        result[key] = this._deepMerge(target[key] || {}, source[key]);
      } else { result[key] = source[key]; }
    }
    return result;
  }

  /** @private */
  _applyEnvOverrides() {
    const ENV_MAP = {
      'GENESIS_API_KEY':    'models.anthropicApiKey',
      'ANTHROPIC_API_KEY':  'models.anthropicApiKey',
      'GENESIS_OPENAI_KEY': 'models.openaiApiKey',
      'OPENAI_API_KEY':     'models.openaiApiKey',
      'GENESIS_MODEL':      'models.preferred',
    };
    for (const [env, dotPath] of Object.entries(ENV_MAP)) {
      const val = process.env[env]?.trim();
      if (val && val.length > 0) {
        this.set(dotPath, val);
        _log.info(`[SETTINGS] Applied env override: ${env} → ${dotPath}`);
      }
    }
  }
}

// v7.6.7 Track A: Mount the encryption mixin onto Settings.prototype.
// Pure structural extraction — runtime semantics unchanged. See
// SettingsEncryption.js for the extracted methods and rationale.
Object.assign(Settings.prototype, enc.settingsEncryptionMixin);

module.exports = { Settings };
