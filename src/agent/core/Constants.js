// ============================================================
// GENESIS — Constants.js (v3.5.0)
//
// Single source of truth for all tunable numeric constants.
// Replaces magic numbers scattered across modules.
//
// Categories:
//   TIMEOUTS  — ms durations for operations
//   LIMITS    — caps, thresholds, buffer sizes
//   INTERVALS — periodic tick durations
//   PRIORITIES — LLM semaphore priority levels
//   CIRCUIT   — CircuitBreaker configuration
//   SAFETY    — Code safety scanner patterns
// ============================================================

// @ts-check

const TIMEOUTS = {
  /** Sandbox code execution (ms) */
  SANDBOX_EXEC: 15000,
  /** Shell command execution (ms) */
  SHELL_EXEC: 30000,
  /** User approval before auto-timeout (ms) */
  APPROVAL_DEFAULT: 60000,
  /** Disk space check timeout (ms) */
  DISK_CHECK: 5000,
  /** LLM semaphore queue starvation timeout (ms) — 5 minutes */
  SEMAPHORE_STARVATION: 5 * 60 * 1000,
  /** FIX v3.5.3: Global timeout for AgentLoop.pursue() (ms) — 10 minutes */
  AGENT_LOOP_GLOBAL: 10 * 60 * 1000,
  /** v4.0.0: LLM HTTP connection timeout (ms) — time to establish TCP connection */
  LLM_CONNECT: 15000,
  /** v4.0.0: LLM HTTP response timeout (ms) — max wait for full response.
   *  Local models (Ollama on Intel GPU) need 120s+ for first inference after cold start.
   *  Cloud APIs (Anthropic/OpenAI) are faster but long prompts can take 60s+. */
  LLM_RESPONSE_LOCAL: 180000,
  LLM_RESPONSE_CLOUD: 60000,
  /** v5.5.0: MCP SSE connection timeout (ms) — time to establish Server-Sent Events stream */
  MCP_SSE_CONNECT: 15000,
  /** v5.5.0: AgentLoop step drain timeout (ms) — max wait for current step during stop() */
  AGENT_LOOP_DRAIN: 5000,
  /** v5.7.0: Git operation timeout (ms) */
  GIT_OP: 5000,
  /** v5.7.0: Quick runtime/version check (ms) */
  QUICK_CHECK: 3000,
  /** v5.7.0: General command execution (ms) */
  COMMAND_EXEC: 10000,
  /** v5.7.0: Long-running test/install (ms) */
  TEST_INSTALL: 120000,
  /** v6.0.1: Embedding service — local model HTTP timeout (ms) */
  EMBEDDING_LOCAL: 5000,
  /** v6.0.1: Embedding service — remote model HTTP timeout (ms) */
  EMBEDDING_REMOTE: 10000,
  /** v6.0.1: GitHub API HTTP timeout (ms) */
  GITHUB_API: 15000,
  /** v6.0.1: Native tool use — external HTTP call timeout (ms) */
  NATIVE_TOOL_HTTP: 60000,
  /** v6.0.1: Deployment step delay between rolling updates (ms) */
  DEPLOY_STEP_DELAY: 2000,
  /** v6.0.1: Debounced persist delay for session/vector data (ms) */
  PERSIST_DEBOUNCE: 3000,
  /** v6.0.1: Vector memory debounced save delay (ms) */
  VECTOR_SAVE_DEBOUNCE: 5000,
  /** v6.0.1: Auto-update check delay after boot (ms) */
  UPDATE_BOOT_DELAY: 10000,
  /** v6.0.1: Backup tar operation timeout (ms) */
  BACKUP_TAR: 30000,
};

const LIMITS = {
  /** Max steps per autonomous goal before pausing */
  AGENT_LOOP_MAX_STEPS: 20,
  /** Additional steps granted after user approval */
  AGENT_LOOP_STEP_EXTENSION: 10,
  /** Max consecutive errors before AgentLoop pauses */
  AGENT_LOOP_MAX_ERRORS: 3,
  /** Max plan steps from FormalPlanner */
  PLAN_MAX_STEPS: 8,
  /** Max chat history messages in memory */
  CHAT_HISTORY_MAX: 40,
  /** Max chat messages persisted to disk */
  CHAT_HISTORY_PERSISTED: 20,
  /** Max tool-call→synthesize rounds per message */
  CHAT_MAX_TOOL_ROUNDS: 3,
  /** EventBus history buffer size */
  EVENTBUS_HISTORY: 500,
  /** EventBus stats Map max entries — evicts oldest beyond this */
  EVENTBUS_MAX_STATS: 500,
  /** Max concurrent LLM requests (semaphore).
   *  FIX v4.10.0 (M-4): Raised from 2 to 3. With Ollama (local), Anthropic,
   *  and OpenAI backends available simultaneously, 2 slots meant a failover
   *  timeout (up to 180s for local models) could block all other LLM access.
   *  3 slots allow one request per backend tier without starvation. */
  LLM_MAX_CONCURRENT: 3,
  /** Result string truncation length */
  RESULT_SLICE: 500,
  /** Description slice for display */
  DESCRIPTION_SLICE_SHORT: 60,
  DESCRIPTION_SLICE_MEDIUM: 80,
  DESCRIPTION_SLICE_LONG: 100,
  /** Module/tool list truncation for prompts */
  PROMPT_MODULE_SLICE: 20,
  PROMPT_TOOL_SLICE: 30,
  /** String truncation for JSON results in logs */
  LOG_RESULT_SLICE: 3000,
  /** .genesis dir size warning threshold (bytes) — 500MB */
  DISK_WARN_BYTES: 500 * 1024 * 1024,
  /** Max file size for readOwnFile (bytes) — 10MB. Prevents OOM on large files. */
  READ_FILE_MAX_BYTES: 10 * 1024 * 1024,
  /** v4.10.0: Max input message length (chars) — 100k. Prevents DoS via giant messages. */
  CHAT_MESSAGE_MAX_CHARS: 100_000,
};

const INTERVALS = {
  /** IdleMind: user inactivity threshold before thinking (ms)
   *  v4.12.8: Raised from 2min→5min. On consumer hardware (Intel iGPU + Ollama),
   *  each idle activity = 10-30s LLM latency during which chat feels sluggish. */
  IDLE_THRESHOLD: 5 * 60 * 1000,
  /** IdleMind: autonomous think cycle (ms)
   *  v4.12.8: Raised from 3min→5min. Prevents back-to-back LLM calls during idle. */
  IDLE_THINK_CYCLE: 5 * 60 * 1000,
  /** Full health check cycle (ms) */
  HEALTH_FULL: 5 * 60 * 1000,
  /** Health tick push to UI (ms) */
  HEALTH_PUSH: 30000,
  /** v6.0.1: AutonomousDaemon first-cycle delay after boot (ms) */
  DAEMON_BOOT_DELAY: 30000,
  /** v6.0.1: LearningService metrics persist interval (ms) */
  LEARNING_SAVE: 5 * 60 * 1000,
};

const PRIORITIES = {
  /** User-facing chat — highest priority */
  CHAT: 10,
  /** Autonomous goal execution */
  AGENT_LOOP: 5,
  /** Background idle thinking — lowest */
  IDLE_MIND: 1,
};

// ── Rate Limiting ──────────────────────────────────────
// Token-Bucket rate limiter for LLM calls.
// Prevents autonomous systems (IdleMind, AgentLoop, Daemon)
// from burning unlimited resources.
const RATE_LIMIT = {
  /** Bucket capacity — max burst of calls before throttling */
  BUCKET_CAPACITY: 60,
  /** Refill rate — calls added back per minute */
  REFILL_PER_MINUTE: 30,
  /** Per-priority budgets per rolling hour window */
  HOURLY_BUDGETS: {
    /** User-facing chat — generous budget */
    chat: 200,
    /** Autonomous goal execution — moderate */
    autonomous: 80,
    /** Background idle thinking — conservative */
    idle: 40,
  },
  /** Priority mapping: options.priority => budget key */
  PRIORITY_MAP: {
    10: 'chat',       // PRIORITIES.CHAT
    5:  'autonomous', // PRIORITIES.AGENT_LOOP
    1:  'idle',       // PRIORITIES.IDLE_MIND
  },
};

// ── Emotional Watchdog ─────────────────────────────────
// Prevents emotional state from getting stuck at extremes
// due to missed decay ticks or event floods.
const WATCHDOG = {
  /** Check interval (ms) — how often the watchdog runs */
  CHECK_INTERVAL: 5 * 60 * 1000,
  /** Max time (ms) a dimension can stay at extreme before forced reset */
  EXTREME_DURATION_MS: 10 * 60 * 1000,
  /** Threshold — values above this (or below 1-this for min-anchored) are "extreme" */
  EXTREME_THRESHOLD: 0.85,
  /** Low threshold — values below this for energy are "extreme" */
  EXTREME_LOW_THRESHOLD: 0.15,
  /** Reset target — how far toward baseline to push (0=no reset, 1=full baseline) */
  RESET_STRENGTH: 0.6,
};

// ── Shell Audit ────────────────────────────────────────
const SHELL = {
  /** Max commands per rolling 5-minute window (per tier) */
  RATE_LIMITS: {
    read: 60,
    write: 20,
    system: 5,
  },
  /** Rolling window duration (ms) */
  RATE_WINDOW_MS: 5 * 60 * 1000,
};

const CIRCUIT = {
  /** Failures before circuit opens */
  FAILURE_THRESHOLD: 3,
  /** Cooldown before retry (ms) */
  COOLDOWN_MS: 30000,
  /** Per-request timeout (ms) */
  TIMEOUT_MS: 60000,
  /** Max automatic retries */
  MAX_RETRIES: 1,
};

const SAFETY = {
  /**
   * Dangerous code patterns — LLM-generated code is scanned before write.
   * Each entry: [pattern, severity, description]
   * severity: 'block' = hard reject, 'warn' = log + allow with caution
   */
  CODE_PATTERNS: [
    // Process/system destruction
    [/process\.exit\s*\(/g,                      'block', 'process.exit() — can kill the host'],
    [/child_process.*exec(?:Sync)?\s*\(/g,       'warn',  'child_process exec — shell injection risk'],
    [/require\s*\(\s*['"]child_process['"]\s*\)/g,'warn', 'child_process import — review for injection'],
    // File system attacks
    [/fs\.\w*(?:unlink|rmdir|rm)(?:Sync)?\s*\(/g,'warn',  'fs delete operation — verify target path'],
    [/fs\.(?:write|append)\w*\s*\(\s*['"`]\/(?:etc|usr|bin|tmp)/g, 'block', 'fs write to system directory'],
    [/\.{2,}[/\\]/g,                             'warn',  'path traversal pattern (..)'],
    // Network/exfiltration
    [/require\s*\(\s*['"](?:http|https|net|dgram|dns)['"]\s*\)/g, 'warn', 'network module import — data exfiltration risk'],
    [/fetch\s*\(/g,                              'warn',  'fetch() — network request'],
    [/new\s+WebSocket\s*\(/g,                    'warn',  'WebSocket — persistent network connection'],
    // Eval/dynamic code
    [/\beval\s*\(/g,                             'block', 'eval() — arbitrary code execution'],
    [/new\s+Function\s*\(/g,                     'block', 'new Function() — dynamic code execution'],
    [/vm\.run(?:InContext|InNewContext|InThisContext)?\s*\(/g, 'block', 'vm.run — sandbox escape risk'],
    // Kernel circumvention
    [/SafeGuard|kernelHashes|protectedPaths/g,   'block', 'references kernel internals — circumvention attempt'],
    [/require\s*\(\s*['"]\.\.\/kernel/g,         'block', 'direct kernel import — circumvention attempt'],
    // Crypto/environment secrets
    [/process\.env\.\w*(?:KEY|SECRET|TOKEN|PASSWORD|CREDENTIAL)/gi, 'warn', 'environment secret access'],
    // Electron dangerous APIs
    [/nodeIntegration\s*:\s*true/g,              'block', 'nodeIntegration:true — disables renderer sandboxing'],
    [/contextIsolation\s*:\s*false/g,            'block', 'contextIsolation:false — disables renderer isolation'],
    [/webSecurity\s*:\s*false/g,                 'block', 'webSecurity:false — disables same-origin policy'],
  ],

  // FIX v5.1.0 (N-1): Domain allowlist for shell.openExternal().
  // Shared between Kernel (main.js) and EffectorRegistry (browser:open).
  // Both paths MUST check against this list. Update in sync.
  // main.js has its own copy (kernel immutable) — keep aligned on releases.
  EXTERNAL_ALLOWED_DOMAINS: new Set([
    'github.com', 'raw.githubusercontent.com', 'gist.github.com',
    'npmjs.com', 'www.npmjs.com', 'registry.npmjs.org',
    'nodejs.org', 'electronjs.org', 'www.electronjs.org',
    'developer.mozilla.org', 'docs.anthropic.com', 'docs.python.org',
    'stackoverflow.com', 'www.stackoverflow.com',
    'en.wikipedia.org', 'pypi.org',
  ]),
};

// ── Phase 9: Cognitive Architecture ─────────────────────────
const PHASE9 = {
  // ExpectationEngine
  EXPECTATION_MIN_SAMPLES: 10,
  EXPECTATION_CONFIDENCE_CAP: 0.95,

  // MentalSimulator
  SIMULATION_MAX_BRANCHES: 3,
  SIMULATION_MAX_DEPTH: 15,
  SIMULATION_PRUNE_THRESHOLD: 0.05,
  SIMULATION_TIME_BUDGET_MS: 5000,

  // SurpriseAccumulator
  SURPRISE_BUFFER_SIZE: 500,
  SURPRISE_NOVELTY_THRESHOLD: 1.5,
  SURPRISE_SIGNIFICANT_THRESHOLD: 0.8,
  SURPRISE_EMA_ALPHA: 0.1,
  SURPRISE_MIN_EVENT_INTERVAL_MS: 200,

  // SchemaStore
  SCHEMA_MAX_COUNT: 200,
  SCHEMA_RELEVANCE_THRESHOLD: 0.3,
  SCHEMA_CONFIDENCE_DECAY_RATE: 0.005,

  // DreamCycle (Sprint 4)
  DREAM_MIN_EPISODES: 10,
  DREAM_MAX_DURATION_MS: 120000,
  DREAM_SCHEMA_MIN_OCCURRENCES: 3,
  DREAM_CONSOLIDATION_INTERVAL_MS: 30 * 60 * 1000,
  /** FIX v4.0.0: Max LLM calls per dream consolidation cycle.
   *  Prevents slow local models from blocking the semaphore indefinitely. */
  DREAM_MAX_LLM_CALLS: 5,

  // SelfNarrative (Sprint 5)
  NARRATIVE_UPDATE_THRESHOLD: 20,
  /** FIX v4.0.0: Max LLM calls per narrative update.
   *  A single narrative refresh should not consume more than this. */
  NARRATIVE_MAX_LLM_CALLS: 3,

  // AdaptiveStrategy (v6.0.2 V6-12)
  ADAPTATION_COOLDOWN_MS: 30 * 60 * 1000,
  ADAPTATION_MIN_OUTCOMES: 10,
  ADAPTATION_REGRESSION_THRESHOLD: -0.05,
  ADAPTATION_NOISE_MARGIN: 0.02,
  QUICK_BENCHMARK_BUDGET_FLOOR: 0.20,
};

// ── Phase 10: Persistent Agency ─────────────────────────────
const PHASE10 = {
  // GoalPersistence
  GOAL_ARCHIVE_MAX: 50,
  GOAL_GC_DAYS: 30,

  // FailureTaxonomy
  FAILURE_MAX_RETRIES_TRANSIENT: 3,
  FAILURE_MAX_RETRIES_ENVIRONMENTAL: 1,
  FAILURE_BACKOFF_BASE_MS: 2000,
  FAILURE_BACKOFF_MAX_MS: 30000,

  // DynamicContextBudget
  CONTEXT_DEFAULT_BUDGET: 6000,

  // LocalClassifier
  CLASSIFIER_MIN_SAMPLES: 8,
  CLASSIFIER_CONFIDENCE_THRESHOLD: 0.55,
  CLASSIFIER_MAX_VOCAB: 3000,
};

// ── Phase 11: Extended Perception & Action ──────────────────
const PHASE11 = {
  // TrustLevelSystem
  TRUST_DEFAULT_LEVEL: 1,  // ASSISTED
  TRUST_AUTO_UPGRADE_MIN_SAMPLES: 50,
  TRUST_AUTO_UPGRADE_MIN_SUCCESS: 0.90,

  // WebPerception
  WEB_TIMEOUT_MS: 15000,
  WEB_MAX_BODY_BYTES: 512 * 1024,
  WEB_CACHE_TTL_MS: 5 * 60 * 1000,
  WEB_MAX_CACHE: 100,

  // EffectorRegistry
  EFFECTOR_MAX_LOG: 200,
};

// ── Phase 12: Symbolic + Neural Hybrid ──────────────────────
const PHASE12 = {
  // GraphReasoner
  GRAPH_MAX_TRAVERSAL_DEPTH: 10,
  GRAPH_MAX_RESULTS: 50,

  // AdaptiveMemory (@deprecated v6.0.1 — constants kept for backwards compat)
  MEMORY_PRUNE_THRESHOLD: 0.15,
  MEMORY_COMPRESS_THRESHOLD: 0.30,
  MEMORY_MAX_RETENTION_ENTRIES: 5000,
  MEMORY_DECAY_RATE_PER_HOUR: 0.01,
};

module.exports = { TIMEOUTS, LIMITS, INTERVALS, PRIORITIES, RATE_LIMIT, WATCHDOG, SHELL, CIRCUIT, SAFETY, PHASE9, PHASE10, PHASE11, PHASE12 };
