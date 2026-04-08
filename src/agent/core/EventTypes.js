// ============================================================
// GENESIS — EventTypes.js (v3.5.0 — Payload Docs)
//
// Central registry of all EventBus event names.
// Prevents typos in event strings — use these constants instead
// of raw strings. IDE autocomplete catches misspellings.
//
// v3.5.0: Added JSDoc payload documentation for every event.
//   Usage:  EVENTS.AGENT_LOOP.STARTED  →  'agent-loop:started'
//   Hover:  Shows expected { data } and { meta } shapes.
//
// Usage:
//   const { EVENTS } = require('./EventTypes');
//   bus.emit(EVENTS.AGENT_LOOP.STARTED, data);
//   bus.on(EVENTS.VERIFICATION.COMPLETE, handler);
// ============================================================

const EVENTS = Object.freeze({

  // ── Agent Loop ─────────────────────────────────────────
  // v4.12.5-fix: Consolidated — removed phantom 'agent-loop:completed'
  // (AgentLoop.js emits 'agent-loop:complete'), merged AGENTLOOP namespace.
  /** @payload {{ goalId: string, goal: string, stepCount: number }} */
  AGENT_LOOP: Object.freeze({
    /** @payload {{ goalId: string, goal: string }} */
    STARTED:          'agent-loop:started',
    /** @payload {{ goalId: string, title: string, steps: number, toolsUsed: string[], verificationMethod: string, success: boolean, summary: string }} */
    COMPLETE:         'agent-loop:complete',
    /** @payload {{ goalId: string, stepIndex: number, result: string, type: string }} */
    STEP_COMPLETE:    'agent-loop:step-complete',
    /** @payload {{ goalId: string, stepIndex: number, type: string, error: string }} */
    STEP_FAILED:      'agent-loop:step-failed',
    /** @payload {{ goalId: string, step: number, peerId: string }} */
    STEP_DELEGATING:  'agent-loop:step-delegating',
    /** @payload {{ action: string, description: string }} */
    APPROVAL_NEEDED:  'agent-loop:approval-needed',
    /** @payload {{ action: string, description: string, reason: string, goalId: string }} */
    AUTO_APPROVED:    'agent-loop:auto-approved',
    /** @payload {{ goalId: string, question: string }} */
    NEEDS_INPUT:      'agent-loop:needs-input',
    /** @payload {{ goalId: string, elapsedMs: number }} */
    TIMEOUT:          'agent-loop:timeout',
  }),

  // v5.2.0 (SA-P6): Working memory lifecycle
  WORKSPACE: Object.freeze({
    /** @payload {{ goalId: string, capacity: number }} */
    CREATED:      'workspace:created',
    /** @payload {{ goalId: string, key: string, salience: number, evicted?: string }} */
    STORED:       'workspace:stored',
    /** @payload {{ goalId: string, items: Array, workspaceStats: object }} */
    CONSOLIDATE:  'workspace:consolidate',
    /** @payload {{ goalId: string, itemsCleared: number, consolidated: number }} */
    CLEARED:      'workspace:cleared',
  }),

  // v5.3.0 (SA-P5): Online learning — real-time behavioral adaptation
  ONLINE_LEARNING: Object.freeze({
    /** @payload {{ actionType: string, consecutiveFailures: number, suggestion: object }} */
    STREAK_DETECTED:    'online-learning:streak-detected',
    /** @payload {{ actionType: string, currentModel: string, surprise: number }} */
    ESCALATION_NEEDED:  'online-learning:escalation-needed',
    /** @payload {{ actionType: string, model: string, oldTemp: number, newTemp: number, successRate: number }} */
    TEMP_ADJUSTED:      'online-learning:temp-adjusted',
    /** @payload {{ avgSurprise: number, windowSize: number, suggestion: string }} */
    CALIBRATION_DRIFT:  'online-learning:calibration-drift',
    /** @payload {{ trend: string, avgSurprise: number, suggestion: string }} */
    NOVELTY_SHIFT:      'online-learning:novelty-shift',
  }),

  // v5.3.0 (SA-P7): Cross-project lessons
  LESSONS: Object.freeze({
    /** @payload {{ id: string, category: string, insight: string }} */
    RECORDED:           'lessons:recorded',
    /** @payload {{ category: string, count: number }} */
    RECALLED:           'lessons:recalled',
    /** @payload {{ category: string, title: string, content: string, tags: string[] }} */
    LEARNED:            'lesson:learned',
  }),

  // ── Self-Preservation ────────────────────────────────────
  PRESERVATION: Object.freeze({
    /** @payload {{ file: string, violations: Array<{invariant: string, detail: string}> }} */
    VIOLATION:          'preservation:violation',
    /** @payload {{ file: string, invariantCount: number }} */
    PASSED:             'preservation:passed',
  }),

  // ── Agent System ───────────────────────────────────────
  AGENT: Object.freeze({
    /** @payload {{ state: 'ready'|'thinking'|'error'|'warning'|'self-modifying'|'booting', detail?: string, model?: string }} */
    STATUS:               'agent:status',
    /** @payload {{ errors: string[] }} */
    SHUTDOWN:             'agent:shutdown',
    /** @payload {{ error: string, source?: string }} */
    ERROR:                'agent:error',
    /** @payload {{ action: string, description: string }} — IPC push to renderer */
    LOOP_APPROVAL_NEEDED: 'agent:loop-approval-needed',
    /** @payload {{ goalId: string, step: number, total: number }} — IPC push to renderer */
    LOOP_PROGRESS:        'agent:loop-progress',
    /** @payload {{ filename: string, content: string }} — IPC push to renderer */
    OPEN_IN_EDITOR:       'agent:open-in-editor',
    /** @payload {{ state: string, model?: string, memory?: object }} — IPC push to renderer */
    STATUS_UPDATE:        'agent:status-update',
  }),

  // ── Safety ─────────────────────────────────────────────
  SAFETY: Object.freeze({
    /** @payload {{ services: string[], message: string }} */
    DEGRADED:       'safety:degraded',
  }),

  // ── Boot ───────────────────────────────────────────────
  BOOT: Object.freeze({
    /** @payload {{ services: string[], count: number }} */
    DEGRADED:       'boot:degraded',
  }),

  // ── Error Aggregation ──────────────────────────────────
  ERROR_AGG: Object.freeze({
    /** @payload {{ errorRate: number, trend: string, topSources: object[] }} */
    TREND:          'error:trend',
    /** @payload {{ categories: object, trending: Array, spikes: Array }} */
    HEALTH_SUMMARY: 'error:health-summary',
  }),

  // ── Chat ───────────────────────────────────────────────
  CHAT: Object.freeze({
    /** @payload {{ success: boolean, duration?: number }} */
    COMPLETED: 'chat:completed',
    /** @payload {{ error: string }} */
    ERROR:     'chat:error',
    /** @payload {{ attempt: number }} */
    RETRY:     'chat:retry',
  }),

  // ── Circuit Breaker ────────────────────────────────────
  CIRCUIT: Object.freeze({
    /** @payload {{ from: string, to: 'closed'|'open'|'half-open' }} */
    STATE_CHANGE: 'circuit:state-change',
    /** @payload {{ error: string }} */
    FALLBACK:     'circuit:fallback',
  }),

  // ── Code Safety (v3.5.0) ──────────────────────────────
  CODE: Object.freeze({
    /** @payload {{ file: string, issues: Array<{ severity: string, description: string, count: number }> }} */
    SAFETY_BLOCKED: 'code:safety-blocked',
  }),

  // ── Self-Modification Circuit Breaker ─────────────────
  SELFMOD: Object.freeze({
    /** @payload {{ file: string }} */
    SUCCESS:       'selfmod:success',
    /** @payload {{ count: number, reason: string }} */
    FAILURE:       'selfmod:failure',
    /** @payload {{ reason: string, failures: number }} */
    FROZEN:        'selfmod:frozen',
    /** @payload {{}} */
    CIRCUIT_RESET: 'selfmod:circuit-reset',
    /** @payload {{ coherence: number }} */
    CONSCIOUSNESS_BLOCKED: 'selfmod:consciousness-blocked',
  }),

  // ── Cognitive Monitor ──────────────────────────────────
  COGNITIVE: Object.freeze({
    /** @payload {{ interval: number }} */
    STARTED:              'cognitive:started',
    /** @payload {{ pattern: string, count: number }} */
    CIRCULARITY_DETECTED: 'cognitive:circularity-detected',
    /** @payload {{ decision: string, quality: number }} */
    DECISION_EVALUATED:   'cognitive:decision-evaluated',
    /** @payload {{ metric: string, value: number }} */
    OVERLOAD:             'cognitive:overload',
    /** @payload {{ used: number, budget: number }} */
    TOKEN_BUDGET_WARNING: 'cognitive:token-budget-warning',
    /** @payload {{ service: string, failures: number, backoffMs: number, lastError: string }} */
    SERVICE_DEGRADED:     'cognitive:service-degraded',
    /** @payload {{ service: string, failures: number, totalFailures: number, lastError: string, autoRecoverMs: number }} */
    SERVICE_DISABLED:     'cognitive:service-disabled',
    /** @payload {{ service: string, previousState: string, totalRecoveries: number }} */
    SERVICE_RECOVERED:    'cognitive:service-recovered',
  }),

  // ── CI / FailureAnalyzer ────────────────────────────────
  CI: Object.freeze({
    /** @payload {{ file: string, issues: Array }} */
    ANALYZED: 'ci:analyzed',
  }),

  // ── Container ──────────────────────────────────────────
  CONTAINER: Object.freeze({
    REPLACED: 'container:replaced',
  }),

  // ── Context ────────────────────────────────────────────
  CONTEXT: Object.freeze({
    BUILT: 'context:built',
    /** @payload {{ originalTokens: number, compressedTokens: number, messagesCompressed: number, tokensSaved: number }} */
    COMPRESSED:         'context:compressed',
    /** @payload {{ totalTokens: number, budget: number, messagesCompressed: number }} */
    OVERFLOW_PREVENTED: 'context:overflow-prevented',
  }),

  // ── Daemon ─────────────────────────────────────────────
  DAEMON: Object.freeze({
    STARTED:       'daemon:started',
    STOPPED:       'daemon:stopped',
    CYCLE_COMPLETE: 'daemon:cycle-complete',
    SUGGESTIONS:   'daemon:suggestions',
    AUTO_REPAIR:   'daemon:auto-repair',
    SKILL_CREATED: 'daemon:skill-created',
    // V7-4A: External control channel
    CONTROL_LISTENING:    'daemon:control-listening',
    CONTROL_CLOSED:       'daemon:control-closed',
    CONTROL_CONNECTED:    'daemon:control-connected',
    CONTROL_DISCONNECTED: 'daemon:control-disconnected',
    CONTROL_COMMAND:      'daemon:control-command',
    CONTROL_ERROR:        'daemon:control-error',
  }),

  // ── Delegation ─────────────────────────────────────────
  DELEGATION: Object.freeze({
    SUBMITTED: 'delegation:submitted',
    COMPLETED: 'delegation:completed',
    FAILED:    'delegation:failed',
    RECEIVED:  'delegation:received',
    REJECTED:  'delegation:rejected',
  }),

  // ── Editor ─────────────────────────────────────────────
  EDITOR: Object.freeze({
    OPEN: 'editor:open',
  }),

  // ── Embedding ──────────────────────────────────────────
  EMBEDDING: Object.freeze({
    READY: 'embedding:ready',
  }),

  // ── Emotion ────────────────────────────────────────────
  EMOTION: Object.freeze({
    SHIFT: 'emotion:shift',
    /** @payload {{ dimension: string, from: number, to: number, stuckMs: number }} */
    WATCHDOG_RESET: 'emotion:watchdog-reset',
    /** @payload {{ stuck: Array<{ dimension: string, value: number, stuckSince: number }> }} */
    WATCHDOG_ALERT: 'emotion:watchdog-alert',
  }),

  // ── Episodic Memory ────────────────────────────────────
  EPISODIC: Object.freeze({
    RECORDED: 'episodic:recorded',
  }),

  // ── File ───────────────────────────────────────────────
  FILE: Object.freeze({
    IMPORT_BLOCKED: 'file:import-blocked',
    IMPORTED: 'file:imported',
    EXECUTED: 'file:executed',
  }),

  // ── Goal ───────────────────────────────────────────────
  GOAL: Object.freeze({
    CREATED:     'goal:created',
    COMPLETED:   'goal:completed',
    FAILED:      'goal:failed',
    REPLANNED:   'goal:replanned',
    UNBLOCKED:   'goal:unblocked',
    STEP_START:  'goal:step-start',
    CREATE_FILE: 'goal:create-file',
    ABANDONED:   'goal:abandoned',
  }),

  // ── Health Monitor ─────────────────────────────────────
  HEALTH: Object.freeze({
    STARTED:             'health:started',
    TICK:                'health:tick',
    METRIC:              'health:metric',
    DEGRADATION:         'health:degradation',
    MEMORY_LEAK:         'health:memory-leak',
    CIRCUIT_FORCED_OPEN: 'health:circuit-forced-open',
    /** @payload {{ service: string, strategy: string, reason: string, attemptsUsed: number }} */
    RECOVERY:            'health:recovery',
    /** @payload {{ service: string, strategy: string, reason: string, error: string, attemptsRemaining: number }} */
    RECOVERY_FAILED:     'health:recovery-failed',
    /** @payload {{ service: string, totalAttempts: number }} */
    RECOVERY_EXHAUSTED:  'health:recovery-exhausted',
  }),

  // ── Homeostasis ────────────────────────────────────────
  HOMEOSTASIS: Object.freeze({
    STATE_CHANGE:     'homeostasis:state-change',
    CRITICAL:         'homeostasis:critical',
    RECOVERING:       'homeostasis:recovering',
    PAUSE_AUTONOMY:   'homeostasis:pause-autonomy',
    THROTTLE:         'homeostasis:throttle',
    REDUCE_LOAD:      'homeostasis:reduce-load',
    REDUCE_CONTEXT:   'homeostasis:reduce-context',
    PRUNE_CACHES:     'homeostasis:prune-caches',
    PRUNE_KNOWLEDGE:  'homeostasis:prune-knowledge',
    /** @payload {{ type: string, result: string, vital: string }} */
    CORRECTION_APPLIED: 'homeostasis:correction-applied',
    /** @payload {{ type: string, vital: string }} */
    CORRECTION_LIFTED: 'homeostasis:correction-lifted',
    /** @payload {{ recommendations: string[] }} */
    SIMPLIFIED_MODE: 'homeostasis:simplified-mode',
    /** @payload {{ vital: string, oldThreshold: number, newThreshold: number }} */
    ALLOSTASIS:       'homeostasis:allostasis',
  }),

  // ── Phase 7: Immune System ────────────────────────────
  IMMUNE: Object.freeze({
    /** @payload {{ level: number, signature: string, remedy: string, target: string }} */
    INTERVENTION: 'immune:intervention',
    /** @payload {{ service: string, duration: number, reason: string }} */
    QUARANTINE:   'immune:quarantine',
  }),

  // ── Phase 7: Metabolism ───────────────────────────────
  METABOLISM: Object.freeze({
    /** @payload {{ energy: number, tokenCost: number, latencyCost: number, heapCost: number }} */
    COST: 'metabolism:cost',
  }),

  // ── Hot Reload ─────────────────────────────────────────
  HOT_RELOAD: Object.freeze({
    SUCCESS:      'hot-reload:success',
    FAILED:       'hot-reload:failed',
    SYNTAX_ERROR: 'hot-reload:syntax-error',
    /** @payload {{ file: string, reason: string }} */
    ROLLBACK:     'hot-reload:rollback',
  }),

  // ── HTN Planner ────────────────────────────────────────
  HTN: Object.freeze({
    PLAN_VALIDATED: 'htn:plan-validated',
    DRY_RUN:        'htn:dry-run',
    COST_ESTIMATED: 'htn:cost-estimated',
  }),

  // ── Idle Mind ──────────────────────────────────────────
  IDLE: Object.freeze({
    THINKING:        'idle:thinking',
    THOUGHT_COMPLETE: 'idle:thought-complete',
    /** v5.7.0: Proactive insight shared with user @payload {{ activity: string, insight: string }} */
    PROACTIVE_INSIGHT: 'idle:proactive-insight',
    /** v6.0.1: Trigger memory consolidation from idle activity @payload {{}} */
    CONSOLIDATE_MEMORY: 'idle:consolidate-memory',
    /** v6.0.8: Directed curiosity — weakness-targeted exploration @payload {{ weakness: string, targetModule: string, insight: string }} */
    CURIOSITY_TARGETED: 'idle:curiosity-targeted',
  }),

  // ── Intent Router ──────────────────────────────────────
  INTENT: Object.freeze({
    CLASSIFIED:     'intent:classified',
    LLM_CLASSIFIED: 'intent:llm-classified',
    LEARNED:        'intent:learned',
  }),

  // ── Knowledge ──────────────────────────────────────────
  KNOWLEDGE: Object.freeze({
    LEARNED:    'knowledge:learned',
    NODE_ADDED: 'knowledge:node-added',
  }),

  // ── Learning Service ───────────────────────────────────
  LEARNING: Object.freeze({
    PATTERN_DETECTED:    'learning:pattern-detected',
    FRUSTRATION_DETECTED: 'learning:frustration-detected',
    INTENT_SUGGESTION:   'learning:intent-suggestion',
    PERFORMANCE_ALERT:   'learning:performance-alert',
  }),

  // ── LLM ────────────────────────────────────────────────
  LLM: Object.freeze({
    CALL_COMPLETE: 'llm:call-complete',
    CALL_ERROR:    'llm:call-error',
    /** @payload {{ bucket: string, used: number, budget: number, caller?: string }} */
    RATE_LIMITED:  'llm:rate-limited',
    /** @payload {{ bucket: string, used: number, budget: number }} */
    BUDGET_WARNING: 'llm:budget-warning',
    /** @payload {{ scope: string, used: number, limit: number, taskType: string }} */
    COST_CAP_REACHED: 'llm:cost-cap-reached',
    /** @payload {{ scope: string, pct: number, used: number, limit: number }} */
    COST_WARNING: 'llm:cost-warning',
  }),

  // ── MCP ────────────────────────────────────────────────
  MCP: Object.freeze({
    CONNECTED:        'mcp:connected',
    CONNECTING:       'mcp:connecting',
    DISCONNECTED:     'mcp:disconnected',
    DEGRADED:         'mcp:degraded',
    ERROR:            'mcp:error',
    TOOLS_DISCOVERED: 'mcp:tools-discovered',
    SERVER_REMOVED:   'mcp:server-removed',
    SERVER_STARTED:   'mcp:server-started',
    BRIDGE_STARTED:   'mcp:bridge-started',
    RESOURCE_READ:    'mcp:resource-read',
    PATTERN_DETECTED: 'mcp:pattern-detected',
    /** @payload {{ method: string, params: object }} */
    NOTIFICATION:     'mcp:notification',
    /** @payload {{ tool: string, args: object, result: *, elapsed: number }} */
    TOOL_CALL:        'mcp:tool-call',
  }),

  // ── Colony (v5.9.2) ────────────────────────────────────
  COLONY: Object.freeze({
    /** @payload {{ id: string, goal: string }} */
    RUN_STARTED:     'colony:run-started',
    /** @payload {{ id: string, goal: string, subtasks: number, duration: number }} */
    RUN_COMPLETED:   'colony:run-completed',
    /** @payload {{ id: string, error: string }} */
    RUN_FAILED:      'colony:run-failed',
    /** @payload {{ goal: string, options?: object }} */
    RUN_REQUEST:     'colony:run-request',
    /** @payload {{ runId: string, merged: number, conflicts: number }} */
    MERGE_COMPLETED: 'colony:merge-completed',
  }),

  // ── Deployment (v5.9.2) ────────────────────────────────
  DEPLOY: Object.freeze({
    /** @payload {{ id: string, target: string, strategy: string }} */
    STARTED:    'deploy:started',
    /** @payload {{ id: string, target: string, strategy: string, duration: number }} */
    COMPLETED:  'deploy:completed',
    /** @payload {{ id: string, target: string, error: string }} */
    FAILED:     'deploy:failed',
    /** @payload {{ target: string, options?: object }} */
    REQUEST:    'deploy:request',
    /** @payload {{ id: string, target: string, snapshot: number }} */
    ROLLBACK:   'deploy:rollback',
    /** @payload {{ id: string, target: string, reason: string }} v7.0.2 fail-honest */
    ROLLBACK_UNAVAILABLE: 'deploy:rollback-unavailable',
    /** @payload {{ target: string, from: string, to: string }} v6.0.6 Blue-Green swap */
    SWAP:       'deploy:swap',
  }),

  // ── Task Outcomes (v5.9.7) ──────────────────────────────
  TASK_OUTCOME: Object.freeze({
    /** @payload {{ taskType: string, backend: string, success: boolean, tokenCost: number, durationMs: number, intent: string|null }} */
    RECORDED:      'task-outcome:recorded',
    /** @payload {{ byTaskType: object, byBackend: object, total: number }} */
    STATS_UPDATED: 'task-outcome:stats-updated',
  }),

  // ── Memory ─────────────────────────────────────────────
  MEMORY: Object.freeze({
    FACT_STORED:    'memory:fact-stored',
    UNIFIED_RECALL: 'memory:unified-recall',
    /** @payload {{ key: string, source?: string }} */
    READ:           'memory:read',
    /** @payload {{ key: string, source?: string }} */
    WRITE:          'memory:write',
    /** @payload {{ topic: string, conflictCount: number, resolutionCount: number }} */
    CONFLICTS_RESOLVED: 'memory:conflicts-resolved',
    /** @payload {{ key: string, type: string, source?: string }} */
    STORED:             'memory:stored',
  }),

  // ── Meta Learning ──────────────────────────────────────
  META: Object.freeze({
    OUTCOME_RECORDED:       'meta:outcome-recorded',
    RECOMMENDATIONS_UPDATED: 'meta:recommendations-updated',
  }),

  // ── Network (v6.0.5 — V6-10 Offline-First) ─────────────
  NETWORK: Object.freeze({
    STATUS:    'network:status',
    FAILOVER:  'network:failover',
    RESTORED:  'network:restored',
    ERROR:     'network:error',
  }),

  // ── Model ──────────────────────────────────────────────
  MODEL: Object.freeze({
    FAILOVER:          'model:failover',
    NO_MODELS:         'model:no-models',
    OLLAMA_UNAVAILABLE: 'model:ollama-unavailable',
    /** @payload {{ model: string, backend: string, priority: number }} */
    QUERY:             'model:query',
  }),

  // ── Needs System ───────────────────────────────────────
  NEEDS: Object.freeze({
    HIGH_DRIVE: 'needs:high-drive',
    SATISFIED:  'needs:satisfied',
  }),

  // ── Peer Network ───────────────────────────────────────
  PEER: Object.freeze({
    DISCOVERED:     'peer:discovered',
    TRUSTED:        'peer:trusted',
    EVICTED:        'peer:evicted',
    UNHEALTHY:      'peer:unhealthy',
    /** @payload {{ ip: string, reason: string }} */
    REJECTED:       'peer:rejected',
    SKILL_IMPORTED: 'peer:skill-imported',
    /** @payload {{ from: string, accepted: number, rejected: number, conflicts: number }} */
    SYNC_APPLIED:   'peer:sync-applied',
    /** @payload {{ score: number, maxScore: number, peerId: string }} */
    FITNESS_SCORE:  'peer:fitness-score',
  }),

  // ── Perception ─────────────────────────────────────────
  PERCEPTION: Object.freeze({
    FILE_ADDED:       'perception:file-added',
    FILE_CHANGED:     'perception:file-changed',
    FILE_REMOVED:     'perception:file-removed',
    MEMORY_PRESSURE:  'perception:memory-pressure',
  }),

  // ── Embodied Perception (SA-P4) ────────────────────────
  EMBODIED: Object.freeze({
    PANEL_CHANGED:      'embodied:panel-changed',
    FOCUS_CHANGED:      'embodied:focus-changed',
    ENGAGEMENT_CHANGED: 'embodied:engagement-changed',
  }),

  // ── UI Heartbeat ────────────────────────────────────────
  UI: Object.freeze({
    HEARTBEAT: 'ui:heartbeat',
  }),

  // ── Planner ────────────────────────────────────────────
  PLANNER: Object.freeze({
    STARTED:    'planner:started',
    COMPLETE:   'planner:complete',
    REPLANNING: 'planner:replanning',
    TRUNCATED:  'planner:truncated',
  }),

  // ── Reasoning ──────────────────────────────────────────
  REASONING: Object.freeze({
    STARTED:         'reasoning:started',
    COMPLETED:       'reasoning:completed',
    STEP:            'reasoning:step',
    REFINED:         'reasoning:refined',
    SOLVE:           'reasoning:solve',
    IMPACT_ANALYSIS: 'reasoning:impact-analysis',
  }),

  // ── Refactor ───────────────────────────────────────────
  REFACTOR: Object.freeze({
    STARTED:     'refactor:started',
    COMPLETE:    'refactor:complete',
    ROLLED_BACK: 'refactor:rolled-back',
  }),

  // ── Router ─────────────────────────────────────────────
  ROUTER: Object.freeze({
    ROUTED: 'router:routed',
    /** @payload {{ taskTypes: number }} */
    EMPIRICAL_STRENGTH_INJECTED: 'router:empirical-strength-injected',
  }),

  // ── Shell ──────────────────────────────────────────────
  SHELL: Object.freeze({
    EXECUTED:           'shell:executed',
    FAILED:             'shell:failed',
    BLOCKED:            'shell:blocked',
    PLANNING:           'shell:planning',
    PLAN_COMPLETE:      'shell:plan-complete',
    STEP:               'shell:step',
    PERMISSION_CHANGED: 'shell:permission-changed',
    /** @payload {{ tier: string, count: number, limit: number, windowMs: number }} */
    RATE_LIMITED:       'shell:rate-limited',
  }),

  // ── Skill Registry (v5.9.8 V6-6) ──────────────────────────
  SKILL_REGISTRY: Object.freeze({
    INSTALLED:   'skill:installed',
    UNINSTALLED: 'skill:uninstalled',
  }),

  // ── Memory Consolidation (v6.0.0 V6-7) ─────────────────
  MEMORY_CONSOLIDATION: Object.freeze({
    /** @payload {{ kgMerged: number, kgPruned: number, lessonsArchived: number, lessonsDecayed: number, durationMs: number }} */
    COMPLETE:  'memory:consolidation-complete',
    /** @payload {{ error: string }} */
    FAILED:    'memory:consolidation-failed',
  }),

  // ── Workspace Eviction (v6.0.0 V6-5) ───────────────────
  WORKSPACE_EVICTION: Object.freeze({
    /** @payload {{ key: string, value: string, salience: number, accessCount: number, goalId: string|null }} */
    SLOT_EVICTED: 'workspace:slot-evicted',
  }),

  // ── Task Recorder (v6.0.0 V6-8) ────────────────────────
  TASK_RECORDER: Object.freeze({
    /** @payload {{ id: string, goalId: string, steps: number, llmCalls: number, durationMs: number }} */
    RECORDING_COMPLETE: 'replay:recording-complete',
    // v6.0.5 (V6-8): Deterministic replay events
    /** @payload {{ id: string, goalDescription: string, totalEvents: number }} */
    STARTED:            'replay:started',
    /** @payload {{ recordingId: string, index: number, total: number, kind: string, offset: number }} */
    EVENT:              'replay:event',
    /** @payload {{ id: string, eventsReplayed: number, replayDurationMs: number }} */
    COMPLETED:          'replay:completed',
  }),

  // ── Store (EventStore.append dynamic events) ────────────
  STORE: Object.freeze({
    AGENT_LOOP_COMPLETE: 'store:AGENT_LOOP_COMPLETE',
    CHAT_MESSAGE:        'store:CHAT_MESSAGE',
    CODE_MODIFIED:       'store:CODE_MODIFIED',
    CODE_SAFETY_BLOCK:   'store:CODE_SAFETY_BLOCK',
    CODE_SAFETY_WARN:    'store:CODE_SAFETY_WARN',
    COGNITIVE_SNAPSHOT:   'store:COGNITIVE_SNAPSHOT',
    ERROR_OCCURRED:      'store:ERROR_OCCURRED',
    HEALTH_ALERT:        'store:HEALTH_ALERT',
    HEALTH_CIRCUIT_FORCED: 'store:HEALTH_CIRCUIT_FORCED',
    HEALTH_DEGRADATION:  'store:HEALTH_DEGRADATION',
    IDLE_THOUGHT:        'store:IDLE_THOUGHT',
    INTENT_CLASSIFIED:   'store:INTENT_CLASSIFIED',
    MCP_TOOL_CALL:       'store:MCP_TOOL_CALL',
    MODEL_FAILOVER:      'store:MODEL_FAILOVER',
    MULTI_FILE_REFACTOR: 'store:MULTI_FILE_REFACTOR',
    SHELL_PLAN_EXECUTED: 'store:SHELL_PLAN_EXECUTED',
    SKILL_CREATED:       'store:SKILL_CREATED',
    SURPRISE_NOVEL:      'store:SURPRISE_NOVEL',
    SYSTEM_BOOT:         'store:SYSTEM_BOOT',
    SYSTEM_SHUTDOWN:     'store:SYSTEM_SHUTDOWN',
    TASK_DELEGATED:      'store:TASK_DELEGATED',
    INTEGRITY_VIOLATION: 'store:integrity-violation',
  }),

  // ── Capability ─────────────────────────────────────────
  CAPABILITY: Object.freeze({
    ISSUED:  'capability:issued',
    REVOKED: 'capability:revoked',
  }),

  // ── Tools ──────────────────────────────────────────────
  TOOLS: Object.freeze({
    REGISTERED:   'tools:registered',
    UNREGISTERED: 'tools:unregistered',
    CALLING:      'tools:calling',
    /** @payload {{ name: string, duration: number, success: boolean }} — emitted by ToolRegistry on every call */
    RESULT:       'tools:result',
    ERROR:        'tools:error',
    /** @payload {{ tool: string, duration: number, success: boolean }} */
    COMPLETED:    'tools:completed',
    // v4.12.5-fix: Removed phantom 'tool:executed' — ToolRegistry emits 'tools:result'.
    // Consumers (LearningService, CognitiveMonitor) now use TOOLS.RESULT.
    NATIVE_CALL:  'tool:native-call',
    // v5.7.0 SA-P8: Dynamic Tool Synthesis events
    /** @payload {{ name: string, description: string, attempt: number }} */
    SYNTHESIZED:       'tool:synthesized',
    /** @payload {{ description: string }} */
    SYNTHESIS_FAILED:  'tool:synthesis-failed',
  }),

  // ── User ───────────────────────────────────────────────
  USER: Object.freeze({
    MESSAGE: 'user:message',
  }),

  // ── Verification ───────────────────────────────────────
  VERIFICATION: Object.freeze({
    COMPLETE: 'verification:complete',
  }),

  // ── Web ────────────────────────────────────────────────
  WEB: Object.freeze({
    SEARCH:  'web:search',
    FETCH:   'web:fetch',
    FETCHED: 'web:fetched',
  }),

  // ── Worker ─────────────────────────────────────────────
  WORKER: Object.freeze({
    SPAWNED: 'worker:spawned',
    ERROR:   'worker:error',
  }),

  // ── Execution Audit (CapabilityGuard) ──────────────────
  EXEC: Object.freeze({
    SANDBOX: 'exec:sandbox',
    SHELL:   'exec:shell',
    SYSTEM:  'exec:system',
  }),

  // ── Filesystem Audit (CapabilityGuard) ─────────────────
  FS: Object.freeze({
    READ:       'fs:read',
    WRITE:      'fs:write',
    WRITE_SELF: 'fs:write:self',
  }),

  // ── Module Signing (ModuleSigner) ──────────────────────
  MODULE: Object.freeze({
    /** @payload {{ path: string, hash: string }} */
    SIGNED:   'module:signed',
    /** @payload {{ path: string, expected: string, actual: string }} */
    TAMPERED: 'module:tampered',
  }),

  // ── Network Audit (CapabilityGuard) ────────────────────
  NET: Object.freeze({
    EXTERNAL: 'net:external',
    LOCAL:    'net:local',
  }),

  // ── Plugin Registry ────────────────────────────────────
  PLUGIN: Object.freeze({
    /** @payload {{ name: string, type: string, version: string }} */
    INSTALLED:   'plugin:installed',
    /** @payload {{ name: string }} */
    UNINSTALLED: 'plugin:uninstalled',
  }),

  // ── World State ────────────────────────────────────────
  WORLD_STATE: Object.freeze({
    FILE_CHANGED: 'worldstate:file-changed',
  }),

  // ── Phase 9: Cognitive Architecture ────────────────────
  EXPECTATION: Object.freeze({
    FORMED:     'expectation:formed',
    COMPARED:   'expectation:compared',
    CALIBRATED: 'expectation:calibrated',
  }),

  SIMULATION: Object.freeze({
    STARTED:  'simulation:started',
    BRANCHED: 'simulation:branched',
    COMPLETE: 'simulation:complete',
    REPLAN:   'simulation:replan',
  }),

  SURPRISE: Object.freeze({
    PROCESSED:          'surprise:processed',
    AMPLIFIED_LEARNING: 'surprise:amplified-learning',
    NOVEL_EVENT:        'surprise:novel-event',
  }),

  SCHEMA: Object.freeze({
    STORED:  'schema:stored',
    MERGED:  'schema:merged',
    MATCHED: 'schema:matched',
    REMOVED: 'schema:removed',
    PRUNED:  'schema:pruned',
  }),

  DREAM: Object.freeze({
    STARTED:      'dream:started',
    PHASE:        'dream:phase',
    SCHEMA_FOUND: 'dream:schema-found',
    COMPLETE:     'dream:complete',
  }),

  NARRATIVE: Object.freeze({
    UPDATED: 'narrative:updated',
  }),

  // ── Phase 10: Persistent Agency ────────────────────────
  GOAL_PERSIST: Object.freeze({
    LOADED:     'goals:loaded',
    RESUMED:    'goal:resumed',
    CHECKPOINT: 'goal:checkpoint',
  }),

  FAILURE: Object.freeze({
    CLASSIFIED: 'failure:classified',
  }),

  CLASSIFIER: Object.freeze({
    TRAINED: 'classifier:trained',
  }),

  STEERING: Object.freeze({
    MODEL_ESCALATION: 'steering:model-escalation',
    REST_MODE:        'steering:rest-mode',
  }),

  // ── Phase 11: Extended Perception & Action ─────────────
  TRUST: Object.freeze({
    LEVEL_CHANGED:     'trust:level-changed',
    UPGRADES_AVAILABLE:'trust:upgrades-available',
    UPGRADE_ACCEPTED:  'trust:upgrade-accepted',
  }),

  // v6.0.7: Earned Autonomy
  AUTONOMY: Object.freeze({
    EARNED:  'autonomy:earned',
    REVOKED: 'autonomy:revoked',
    STATUS:  'autonomy:status',
  }),

  // v6.0.8: Symbolic resolution + Consciousness gate + Directed curiosity
  SYMBOLIC: Object.freeze({
    RESOLVED: 'symbolic:resolved',
    FALLBACK: 'symbolic:fallback',
  }),

  EFFECTOR: Object.freeze({
    REGISTERED: 'effector:registered',
    EXECUTED:   'effector:executed',
    FAILED:     'effector:failed',
    BLOCKED:    'effector:blocked',
  }),

  NOTIFICATION: Object.freeze({
    SHOW: 'notification:show',
  }),

  SPAWNER: Object.freeze({
    STARTING:  'spawner:starting',
    COMPLETED: 'spawner:completed',
    PROGRESS:  'spawner:progress',
    /** @payload {{ error: string }} */
    ERROR:     'spawner:error',
  }),

  // ── Phase 12: Symbolic + Neural Hybrid ─────────────────
  ADAPTIVE_MEMORY: Object.freeze({
    CONSOLIDATED: 'memory:consolidated',
  }),

  // ── Phase 8 additions (v4.10.0) ────────────────────────
  // v4.12.5-fix: AGENTLOOP.STEP_COMPLETE merged into AGENT_LOOP.STEP_COMPLETE

  // v7.0.1: Phase 13 (Consciousness) removed — 14 dead events cleaned up.
  // Consciousness Layer replaced by AwarenessPort (Phase 1) in v7.0.0.

  ATTENTION: Object.freeze({
    /** @payload {{ channel, strength, mode }} */
    DIRECTED:  'attention:directed',
    /** @payload {{ by: string, activation: number, interrupted: string[] }} */
    CAPTURED:  'attention:captured',
    /** @payload {{ from: string }} */
    RELEASED:  'attention:released',
    /** @payload {{ from: string[], to: string[], mode: string }} */
    SHIFT:     'attention:shift',
  }),

  // ── v5.0.0: Organism Evolution ───────────────────────────
  GENOME: Object.freeze({
    /** @payload {{ generation: number, traits: object, lineageDepth: number }} */
    LOADED:          'genome:loaded',
    /** @payload {{ trait: string, before: number, after: number, delta: number, reason: string }} */
    TRAIT_ADJUSTED:  'genome:trait-adjusted',
    /** @payload {{ parentHash: string, childGeneration: number, mutations: Array<{trait,parent,child,delta}> }} */
    REPRODUCED:      'genome:reproduced',
  }),

  METABOLISM_EXT: Object.freeze({
    /** @payload {{ activity: string, cost: number, remaining: number, state: string }} */
    CONSUMED:        'metabolism:consumed',
    /** @payload {{ activity: string, cost: number, available: number }} */
    INSUFFICIENT:    'metabolism:insufficient',
    /** @payload {{ from: string, to: string, energy: number, max: number }} */
    STATE_CHANGED:   'metabolism:state-changed',
  }),

  FITNESS: Object.freeze({
    /** @payload {{ score: number, metrics: object, genomeHash: string, generation: number, belowMedian: boolean, archivalRecommended: boolean }} */
    EVALUATED:       'fitness:evaluated',
  }),

  // ── Prompt Evolution (v5.2.0) ────────────────────────────
  PROMPT_EVOLUTION: Object.freeze({
    /** @payload {{ section: string, variantId: string, hypothesis: string, generation: number }} */
    EXPERIMENT_STARTED:   'prompt-evolution:experiment-started',
    /** @payload {{ section: string, variantId: string, decision: string, controlRate: number, variantRate: number, improvement: number }} */
    EXPERIMENT_COMPLETED: 'prompt-evolution:experiment-completed',
    /** @payload {{ section: string, generation: number }} */
    ROLLBACK:             'prompt-evolution:rollback',
  }),

  // ── Adaptive Prompt Strategy (v6.0.4) ─────────────────────
  PROMPT_STRATEGY: Object.freeze({
    /** @payload {{ intents: number, recommendations: object }} */
    UPDATED:              'prompt:strategy-updated',
  }),

  // ── Adaptive Strategy (v6.0.2 V6-12) ───────────────────────
  ADAPTATION: Object.freeze({
    /** @payload {{ id: string, type: string, bias: string|null, section: string|null, hypothesis: string|null }} */
    PROPOSED:             'adaptation:proposed',
    /** @payload {{ id: string, type: string, revertAvailable: boolean }} */
    APPLIED:              'adaptation:applied',
    /** @payload {{ id: string, type: string, baselineScore: number, postScore: number, delta: number, decision: string }} */
    VALIDATED:            'adaptation:validated',
    /** @payload {{ id: string, type: string, reason: string, lessonStored: boolean }} */
    ROLLED_BACK:          'adaptation:rolled-back',
    /** @payload {{ id: string, reason: string }} */
    VALIDATION_DEFERRED:  'adaptation:validation-deferred',
    /** @payload {{ outcome: string, cyclesRun: number }} */
    CYCLE_COMPLETE:       'adaptation:cycle-complete',
  }),

  // ── Value Store (v5.6.0 DA-2) ─────────────────────────────
  VALUE: Object.freeze({
    /** @payload {{ name: string, weight: number, source: string }} */
    STORED:      'value:stored',
    /** @payload {{ name: string, newWeight: number, reason: string }} */
    REINFORCED:  'value:reinforced',
  }),

  // ── Backup (v6.0.1) ──────────────────────────────────
  BACKUP: Object.freeze({
    /** @payload {{ path: string, files: number, rawSize: number, archiveSize: number }} */
    EXPORTED:  'backup:exported',
    /** @payload {{ source: string, imported: number, skipped: number, manifest: object }} */
    IMPORTED:  'backup:imported',
  }),

  // ── Update (v6.0.1) ──────────────────────────────────
  UPDATE: Object.freeze({
    /** @payload {{ current: string, latest: string, url: string, changelog?: string, publishedAt?: string }} */
    AVAILABLE: 'update:available',
  }),
});

// ── Event Naming Bridge ─────────────────────────────────────
// FIX v5.0.0: EventStore uses SCREAMING_SNAKE types, EventBus uses kebab-case.
// The v5.0.0 FitnessEvaluator bugs (CHAT_COMPLETED vs CHAT_MESSAGE, .data vs .payload)
// stem from this duality. This map is the single source of truth for consumers
// that need to query BOTH systems (e.g. FitnessEvaluator, IntrospectionEngine).
//
// Usage:
//   const { EVENT_STORE_BUS_MAP } = require('./EventTypes');
//   const busName   = EVENT_STORE_BUS_MAP.AGENT_LOOP_STARTED.bus;    // 'agent-loop:started'
//   const storeName = EVENT_STORE_BUS_MAP.AGENT_LOOP_STARTED.store;  // 'AGENT_LOOP_STARTED'
//
// EventStore events use { type, payload, source, timestamp }.
// EventBus  events use   { data,  meta }.
// When reading from EventStore, always use e.payload (not e.data).
const EVENT_STORE_BUS_MAP = Object.freeze({
  AGENT_LOOP_STARTED:   { store: 'AGENT_LOOP_STARTED',   bus: 'agent-loop:started' },
  AGENT_LOOP_COMPLETE:  { store: 'AGENT_LOOP_COMPLETE',  bus: 'agent-loop:complete' },
  CHAT_MESSAGE:         { store: 'CHAT_MESSAGE',         bus: 'chat:completed' },
  ERROR_OCCURRED:       { store: 'ERROR_OCCURRED',       bus: 'chat:error' },
  CODE_MODIFIED:        { store: 'CODE_MODIFIED',        bus: 'selfmod:success' },
  CODE_SAFETY_BLOCK:    { store: 'CODE_SAFETY_BLOCK',    bus: 'code:safety-blocked' },
  SHELL_PLAN_EXECUTED:  { store: 'SHELL_PLAN_EXECUTED',  bus: 'shell:complete' },
  HEALTH_ALERT:         { store: 'HEALTH_ALERT',         bus: 'health:alert' },
  SYSTEM_BOOT:          { store: 'SYSTEM_BOOT',          bus: 'agent:status' },
  SYSTEM_SHUTDOWN:      { store: 'SYSTEM_SHUTDOWN',       bus: 'agent:shutdown' },
  INTENT_CLASSIFIED:    { store: 'INTENT_CLASSIFIED',    bus: 'intent:classified' },
  TASK_DELEGATED:       { store: 'TASK_DELEGATED',       bus: 'task:delegated' },
  MCP_TOOL_CALL:        { store: 'MCP_TOOL_CALL',        bus: 'mcp:tool-call' },
  SURPRISE_NOVEL:       { store: 'SURPRISE_NOVEL',       bus: 'surprise:novel' },
  COGNITIVE_SNAPSHOT:   { store: 'COGNITIVE_SNAPSHOT',    bus: 'cognitive:snapshot' },
  SKILL_CREATED:        { store: 'SKILL_CREATED',        bus: 'daemon:skill-created' },
});

module.exports = { EVENTS, EVENT_STORE_BUS_MAP };
