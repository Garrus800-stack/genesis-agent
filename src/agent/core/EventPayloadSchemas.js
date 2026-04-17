// @ts-checked-v5.6
// ============================================================
// GENESIS — EventPayloadSchemas.js (v3.8.0)
//
// Machine-readable payload schemas for EventBus events.
// Installed as a dev-mode middleware on the EventBus — warns
// when events are emitted with missing required fields.
//
// This module is NOT in EventTypes.js (hash-locked critical file).
// Instead it reads the event names from EventTypes and defines

/** @typedef {import('../../../types/core').EventBus} EventBus */
// schemas separately, installed at boot time.
//
// Usage:
//   const { installPayloadValidation } = require('./EventPayloadSchemas');
//   installPayloadValidation(bus);
//
// Schemas use a minimal format:
//   { field: 'required' | 'optional' }
// ============================================================

const { createLogger } = require('../core/Logger');
const _log = createLogger('EventPayloadSchemas');
const SCHEMAS = {
  // Agent Loop
  'agent-loop:started':         { goalId: 'required', goal: 'required' },
  'agent-loop:complete':        { goalId: 'required', title: 'required', steps: 'required', success: 'required' },
  // v4.12.5-fix: Schema now matches AgentLoop.js emission (stepIndex, result, type)
  'agent-loop:step-complete':   { goalId: 'required', stepIndex: 'required', type: 'required' },
  'agent-loop:step-failed':     { goalId: 'required', stepIndex: 'required', type: 'required', error: 'required' },
  // v7.0.3 — C1: Colony auto-escalation
  'agentloop:colony-escalated': { runId: 'required', reason: 'required', subtasks: 'required' },
  'agent-loop:approval-needed': { action: 'required', description: 'required' },
  'agent-loop:auto-approved':   { action: 'required', description: 'required', reason: 'required' },
  'agent-loop:needs-input':     { goalId: 'required', question: 'required' },

  // Agent System
  'agent:status':   { state: 'required', detail: 'optional' },
  'agent:shutdown': { errors: 'optional' },

  // Chat
  'chat:completed': { message: 'required', response: 'required', intent: 'required', success: 'required' },
  'chat:error':     { message: 'required' },

  // Circuit Breaker
  'circuit:state-change': { from: 'required', to: 'required' },

  // Code Safety
  'code:safety-blocked': { file: 'optional', issues: 'required' },

  // Cognitive Monitor
  'cognitive:circularity-detected': { pattern: 'required', count: 'required' },
  'cognitive:overload':             { metric: 'required', value: 'required' },

  // Health
  'health:degradation':      { service: 'required', reason: 'required', level: 'required' },
  'health:memory-leak':      { heapUsedMB: 'required', trend: 'required' },
  'health:circuit-forced-open': { service: 'required', reason: 'required' },
  'health:recovery':           { service: 'required', strategy: 'required', reason: 'required', attemptsUsed: 'required' },
  'health:recovery-failed':    { service: 'required', strategy: 'required', error: 'required' },
  'health:recovery-exhausted': { service: 'required', totalAttempts: 'required' },

  // Idle Mind
  'idle:thinking':         { activity: 'required', thought: 'required' },
  // v7.1.6: Autonomous research
  'idle:research-started': { topic: 'required', source: 'required' },
  'idle:research-complete': { topic: 'required', source: 'required', insight: 'optional' },
  'idle:thought-complete': {},
  'idle:proactive-insight': { activity: 'required', insight: 'required' },

  // Model
  'model:ollama-unavailable': { error: 'required' },
  'model:no-models':          {},

  // Planner
  'planner:started':    { goal: 'required' },
  'planner:replanning': { issues: 'required' },

  // Reasoning
  'reasoning:started': { task: 'required', complexity: 'optional', strategy: 'optional' },
  'reasoning:step':    { step: 'required', total: 'required' },

  // Tools
  'tools:registered':   { name: 'required', source: 'required' },
  'tools:calling':      { name: 'required' },
  'tools:result':       { name: 'required', duration: 'required', success: 'required' },
  'tools:error':        { name: 'required', error: 'required' },

  // User
  'user:message': { length: 'optional' },

  // Verification
  'verification:complete': { result: 'required' },

  // Homeostasis
  'homeostasis:pause-autonomy': {},
  'homeostasis:state-change':   { to: 'required' },
  'homeostasis:prune-caches':   { memoryPressure: 'required' },
  'homeostasis:prune-knowledge': { nodeCount: 'required' },
  'homeostasis:reduce-context':  { latency: 'required' },
  'homeostasis:reduce-load':     { circuit: 'required' },
  'homeostasis:correction-applied': { type: 'required' },

  // Emotion
  'emotion:shift':          { dimension: 'required', from: 'required', to: 'required', mood: 'required' },

  // Emotional Frontier (v7.1.5)
  'emotional-frontier:imprint-written': { sessionId: 'required', peaks: 'required', sustained: 'required', dominantMood: 'required' },
  'emotional-frontier:boot-restored':   { shifted: 'required', imprintId: 'required' },

  // FrontierWriter (generic) — v7.2.4
  'frontier:unfinishedWork:written':    { sessionId: 'required', edgeType: 'required' },
  'frontier:suspicion:written':         { sessionId: 'required', edgeType: 'required' },
  'frontier:lessonTracking:written':    { sessionId: 'required', edgeType: 'required' },

  // Metabolism
  'metabolism:cost':        { cost: 'required', tokens: 'required' },

  // Immune System
  'immune:intervention':    { description: 'required' },
  'immune:quarantine':      { source: 'required', durationMs: 'required' },

  // v7.0.1: consciousness:frame, consciousness:shift schemas removed (Consciousness Layer removed in v7.0.0)

  // v5.7.0: Previously unschema'd events
  // Intent
  'intent:classified':       { type: 'required', confidence: 'optional' },

  // Surprise
  'surprise:novel-event':    { summary: 'required' },

  // Self-Modification
  'selfmod:success':         { file: 'required' },

  // Daemon
  'daemon:skill-created':    { skill: 'required', reason: 'required' },

  // Reserved (registered in EventTypes, not yet emitted — schemas ready for use)
  // v7.1.6: shell:complete removed — consolidated to shell:outcome (see line 322)
  'mcp:tool-call':           { server: 'required', tool: 'required' },
  'mcp:server-started':      { port: 'required' },
  'mcp:bridge-started':      { tools: 'required', resources: 'optional' },
  'mcp:resource-read':       { uri: 'required' },

  // v5.9.0: High-traffic event schemas
  'error:trend':                     { category: 'required', type: 'required' },
  'goal:completed':                  { id: 'required', description: 'required' },

  // v5.7.0 SA-P8: Tool Synthesis
  'tool:synthesized':        { name: 'required', description: 'required', attempt: 'required' },
  'tool:synthesis-failed':   { description: 'required' },

  // v5.9.2: Colony Mode
  'colony:run-started':      { id: 'required', goal: 'required' },
  'colony:run-completed':    { id: 'required', goal: 'required', subtasks: 'required', duration: 'required' },
  'colony:run-failed':       { id: 'required', error: 'required' },
  'colony:run-request':      { goal: 'required' },
  'colony:merge-completed':  { runId: 'required', merged: 'required', conflicts: 'required' },

  // v5.9.2: Deployment Manager
  'deploy:started':          { id: 'required', target: 'required', strategy: 'required' },
  'deploy:completed':        { id: 'required', target: 'required', strategy: 'required', duration: 'required' },
  'deploy:failed':           { id: 'required', target: 'required', error: 'required' },
  'deploy:request':          { target: 'required' },
  'deploy:rollback':         { id: 'required', target: 'required', snapshot: 'required' },
  'deploy:rollback-unavailable': { id: 'required', target: 'required', reason: 'required' },
  'deploy:swap':             { target: 'required', from: 'required', to: 'required' },

  // Task Outcomes (v5.9.7)
  'task-outcome:recorded':      { taskType: 'required', backend: 'required', success: 'required' },
  'task-outcome:stats-updated': { byTaskType: 'required', byBackend: 'required', total: 'required' },

  // Context Compression (v5.9.7)
  'context:compressed':         { originalTokens: 'required', compressedTokens: 'required', messagesCompressed: 'required', tokensSaved: 'required' },
  'context:overflow-prevented': { totalTokens: 'required', budget: 'required', messagesCompressed: 'required' },

  // Skill Registry (v5.9.8)
  'skill:installed':   { name: 'required', version: 'required', source: 'required' },
  'skill:uninstalled': { name: 'required' },

  // Memory Consolidation (v6.0.0 V6-7)
  'memory:consolidation-complete': { kgMerged: 'required', kgPruned: 'required', lessonsArchived: 'required', durationMs: 'required' },
  'memory:consolidation-failed':   { error: 'required' },

  // Workspace Eviction (v6.0.0 V6-5)
  'workspace:slot-evicted': { key: 'required', salience: 'required' },

  // Task Recorder (v6.0.0 V6-8)
  'replay:recording-complete': { id: 'required', goalId: 'required', steps: 'required', durationMs: 'required' },

  // CostGuard (v6.0.1)
  'llm:cost-cap-reached': { scope: 'required', used: 'required', limit: 'required', taskType: 'required' },
  'llm:cost-warning':     { scope: 'required', pct: 'required', used: 'required', limit: 'required' },

  // Backup (v6.0.1)
  'backup:exported': { path: 'required', files: 'required', rawSize: 'required', archiveSize: 'required' },
  'backup:imported': { source: 'required', imported: 'required', skipped: 'required' },

  // Update (v6.0.1)
  'update:available': { current: 'required', latest: 'required', url: 'required' },

  // Idle (v6.0.1)
  'idle:consolidate-memory': {},

  // Adaptation (v6.0.2 — V6-12 Meta-Cognitive Loop)
  'adaptation:proposed':            { id: 'required', type: 'required' },
  'adaptation:applied':             { id: 'required', type: 'required', revertAvailable: 'required' },
  'adaptation:validated':           { id: 'required', type: 'required', baselineScore: 'required', postScore: 'required', delta: 'required', decision: 'required' },
  'adaptation:rolled-back':         { id: 'required', type: 'required', reason: 'required', lessonStored: 'required' },
  'adaptation:validation-deferred': { id: 'required', reason: 'required' },
  'adaptation:cycle-complete':      { outcome: 'required', cyclesRun: 'required' },
  'router:empirical-strength-injected': { taskTypes: 'required' },

  // Network (v6.0.5 — V6-10 Offline-First)
  'network:status':   { online: 'required' },
  'network:failover': { from: 'required', to: 'required', reason: 'required' },
  'network:restored': { model: 'required', backend: 'required' },

  // Lesson (v6.0.2 — AdaptiveStrategy)
  'lesson:learned': { category: 'required', title: 'required', content: 'required' },
  // v7.1.6: Lesson tracking
  'lesson:applied':       { id: 'required', category: 'required' },
  // v7.1.7: Lesson confirmation loop
  'lesson:confirmed':     { id: 'required', category: 'required', confirmed: 'required' },
  'lesson:contradicted':  { id: 'required', category: 'required', contradicted: 'required' },

  // Prompt Strategy (v6.0.4 — AdaptivePromptStrategy)
  'prompt:strategy-updated': { intents: 'required', recommendations: 'required' },

  // Replay (v6.0.5 — V6-8 Deterministic Replay)
  'replay:started':   { id: 'required', totalEvents: 'required' },
  'replay:event':     { recordingId: 'required', index: 'required', kind: 'required' },
  'replay:completed': { id: 'required', eventsReplayed: 'required' },

  // Trust (v6.0.7 — Earned Autonomy)
  'trust:level-changed':      { from: 'required', to: 'required' },
  'trust:upgrades-available': { count: 'required', actions: 'required' },
  'trust:upgrade-accepted':   { actionType: 'required', newLevel: 'required' },

  // Earned Autonomy (v6.0.7)
  'autonomy:earned':  { actionType: 'required', wilsonLower: 'required', samples: 'required', successes: 'required' },
  'autonomy:revoked': { actionType: 'required', wilsonLower: 'required', samples: 'required', reason: 'required' },

  // Symbolic Resolution (v6.0.8)
  'symbolic:resolved': { level: 'required', stepType: 'required', confidence: 'required', source: 'required' },
  'symbolic:fallback': { reason: 'required', stepType: 'required' },

  // Consciousness Gate (v6.0.8)
  'selfmod:consciousness-blocked': { coherence: 'required' },

  // Directed Curiosity (v6.0.8)
  'idle:curiosity-targeted': { weakness: 'required', targetModule: 'required', insight: 'required' },

  // ── v7.0.1: Schema coverage sweep ──────────────────────

  // Goal lifecycle
  'goal:abandoned':        { id: 'required', description: 'optional' },
  'goal:created':          { goalId: 'required', description: 'required' },
  'goal:resumed':          { goalId: 'required' },

  // Shell
  'shell:plan-complete':   { task: 'required', success: 'required' },

  // Daemon
  'daemon:started':        {},
  'daemon:stopped':        {},
  'daemon:cycle-complete': {},
  'daemon:auto-repair':    { issues: 'required', fixed: 'required', trustLevel: 'required' },
  'daemon:suggestions':    { suggestions: 'required' },
  // V7-4A: Control channel
  'daemon:control-listening':    { path: 'required' },
  'daemon:control-closed':       {},
  'daemon:control-connected':    { clients: 'required' },
  'daemon:control-disconnected': { clients: 'required' },
  'daemon:control-command':      { method: 'required', id: 'optional' },
  'daemon:control-error':        { error: 'required' },

  // MCP — schemas already defined above (lines 131-134); duplicates removed in v7.0.1 post-release fix.

  // Cognitive health
  'cognitive:started':          {},
  'cognitive:service-recovered': { service: 'required', previousState: 'required', totalRecoveries: 'required' },
  'cognitive:service-degraded':  { service: 'required', failures: 'required', backoffMs: 'required' },
  'cognitive:service-disabled':  { service: 'required', failures: 'required', totalFailures: 'required' },
  'cognitive:token-budget-warning': { usage: 'required', estimated: 'required', max: 'required' },
  'cognitive:decision-evaluated':   { decision: 'required', outcome: 'required', rollingQuality: 'required' },

  // Model routing
  'model:failover':        { from: 'required', to: 'required', error: 'required' },

  // Values
  'value:stored':          { id: 'required', name: 'required', weight: 'required', source: 'required' },
  'value:reinforced':      { id: 'required', name: 'required', weight: 'required', evidence: 'required' },

  // Module integrity
  'module:signed':         { path: 'required', hash: 'required' },
  'module:tampered':       { path: 'required', expected: 'required', actual: 'required' },

  // Refactor
  'refactor:started':      { description: 'required' },
  'refactor:complete':     { description: 'required', filesChanged: 'required' },
  'refactor:rolled-back':  { description: 'required', error: 'required' },

  // Plugin
  'plugin:installed':      { name: 'required', type: 'required', version: 'required' },
  'plugin:uninstalled':    { name: 'required' },

  // Peer
  'peer:rejected':         { ip: 'required', reason: 'required' },
  'peer:fitness-score':    { genomeHash: 'required', score: 'required', generation: 'required' },

  // Self-modification
  'selfmod:failure':       { reason: 'required' },
  'selfmod:frozen':        { reason: 'required' },
  'selfmod:circuit-reset': {},

  // Agent-loop extended
  'agent-loop:step-delegating': { goalId: 'required', stepIndex: 'required' },
  'agent-loop:timeout':         { goalId: 'required', elapsed: 'optional' },

  // Agent system extended
  'agent:error':            { error: 'required', source: 'required' },
  'agent:status-update':    { state: 'required' },
  'agent:loop-approval-needed': { goalId: 'required', action: 'required' },
  'agent:loop-progress':    { goalId: 'required', step: 'required' },
  'agent:open-in-editor':   { path: 'required' },

  // Shell extended
  'shell:executed':         { command: 'required', exitCode: 'required', duration: 'optional' },
  'shell:failed':           { command: 'required', error: 'required' },
  'shell:blocked':          { command: 'required', reason: 'required' },
  'shell:planning':         { task: 'required' },
  'shell:step':             { step: 'required', command: 'required' },
  'shell:outcome':          { command: 'required', success: 'required', error: 'optional', platform: 'optional' },
  'shell:permission-changed': { command: 'required' },
  'shell:rate-limited':     { command: 'required' },

  // Goal extended
  'goal:failed':            { id: 'required', reason: 'required' },
  'goal:replanned':         { goalId: 'required' },
  'goal:unblocked':         { goalId: 'required' },
  'goal:step-start':        { goalId: 'required', stepIndex: 'required' },
  'goal:create-file':       { goalId: 'required', path: 'required' },

  // Memory
  'memory:fact-stored':     { key: 'required', source: 'optional' },
  'memory:unified-recall':  { query: 'required' },
  'memory:conflicts-resolved': { count: 'required' },
  'memory:consolidated':    { count: 'optional' },

  // MCP extended
  'mcp:connected':          { server: 'required' },
  'mcp:connecting':         { server: 'required' },
  'mcp:disconnected':       { server: 'required' },
  'mcp:degraded':           { name: 'required', failRate: 'required' },
  'mcp:error':              { server: 'required', error: 'required' },
  'mcp:tools-discovered':   { server: 'required', tools: 'required' },
  'mcp:server-removed':     { server: 'required' },
  'mcp:pattern-detected':   { pattern: 'required' },
  'mcp:notification':       { server: 'required', method: 'required' },

  // Homeostasis
  'homeostasis:critical':       {},
  'homeostasis:recovering':     {},
  'homeostasis:throttle':       {},
  'homeostasis:correction-lifted': { type: 'required' },
  'homeostasis:simplified-mode':   { recommendations: 'required' },
  'homeostasis:allostasis':        { vital: 'required', oldThreshold: 'optional', newThreshold: 'optional' },

  // Online learning
  'online-learning:streak-detected':    { actionType: 'required', consecutiveFailures: 'required', suggestion: 'required' },
  'online-learning:escalation-needed':  { actionType: 'required', currentModel: 'required', surprise: 'required', confidence: 'required' },
  'online-learning:temp-adjusted':      { actionType: 'required' },
  'online-learning:calibration-drift':  {},
  'online-learning:novelty-shift':      {},

  // Dream
  'dream:started':          { dreamNumber: 'required' },
  'dream:complete':         { dreamNumber: 'required', duration: 'required', newSchemas: 'required', insights: 'required' },

  // Insight (v7.0.3 — C4)
  'insight:actionable':     { source: 'required', type: 'required', description: 'required' },

  // Delegation
  'delegation:submitted':   { taskId: 'required', peerId: 'required', description: 'required', estimatedMs: 'required' },
  'delegation:completed':   { taskId: 'required', peerId: 'required', success: 'required' },
  'delegation:failed':      { taskId: 'required', peerId: 'required', error: 'required' },
  'delegation:received':    { taskId: 'required', description: 'required' },
  'delegation:rejected':    { taskId: 'required', peerId: 'required', reason: 'required' },

  // Peer extended
  'peer:discovered':        { peerId: 'required' },
  'peer:trusted':           { peerId: 'required' },
  'peer:evicted':           { peerId: 'required', reason: 'required' },
  'peer:unhealthy':         { peerId: 'required' },
  'peer:skill-imported':    { peerId: 'required', skill: 'required' },
  'peer:sync-applied':      { peerId: 'required' },

  // Schema store
  'schema:stored':          { name: 'required' },
  'schema:merged':          { name: 'required' },
  'schema:removed':         { name: 'required' },
  'schema:pruned':          { count: 'required' },

  'workspace:consolidate':  { goalId: 'required', items: 'required', workspaceStats: 'required' },

  // Hot-reload
  'hot-reload:success':     { module: 'required' },
  'hot-reload:failed':      { module: 'required', error: 'required' },
  'hot-reload:syntax-error': { module: 'required', error: 'required' },
  'hot-reload:rollback':    { module: 'required' },

  // Learning
  'learning:pattern-detected':    { pattern: 'required' },
  'learning:frustration-detected': { message: 'optional' },
  'learning:capability-gap':      { userRequest: 'required', response: 'required', timestamp: 'required' },
  'learning:intent-suggestion':   { intent: 'required' },
  'learning:performance-alert':   { type: 'required' },

  // LLM
  'llm:call-complete':      { model: 'optional', tokens: 'optional', durationMs: 'optional' },
  'llm:call-error':         { error: 'required' },
  'llm:rate-limited':       { model: 'required' },
  'llm:budget-warning':     { usage: 'required' },

  // Perception
  'perception:file-added':    { path: 'required' },
  'perception:file-changed':  { path: 'required' },
  'perception:file-removed':  { path: 'required' },
  'perception:memory-pressure': { heapUsedPct: 'required', rss: 'optional' },

  // Reasoning
  'reasoning:completed':      { task: 'required' },
  'reasoning:refined':        { task: 'required' },
  'reasoning:solve':          { task: 'required' },
  'reasoning:impact-analysis': { target: 'required' },

  // Simulation
  'simulation:started':     { plan: 'required' },
  'simulation:branched':    { branch: 'required' },
  'simulation:complete':    { result: 'required' },

  // Effector
  'effector:registered':    { name: 'required' },
  'effector:executed':      { name: 'required' },
  'effector:failed':        { name: 'required', error: 'required' },
  'effector:blocked':       { name: 'required', reason: 'required' },

  // Spawner
  'spawner:starting':       { task: 'required' },
  'spawner:completed':      { task: 'required', success: 'required' },
  'spawner:progress':       { task: 'required' },
  'spawner:error':          { task: 'required', error: 'required' },

  // Attention — removed in v7.0.3 (orphaned from old Consciousness layer, 0 emitters, 0 listeners)

  // File
  'file:import-blocked':    { path: 'required', resolved: 'required' },
  'file:imported':          { path: 'required' },
  'file:executed':          { path: 'required' },

  // Health
  'health:started':         {},
  'health:tick':            {},
  'health:metric':          { service: 'required', metric: 'required', value: 'required' },

  // HTN
  'htn:plan-validated':     { plan: 'required' },
  'htn:dry-run':            { plan: 'required' },
  'htn:cost-estimated':     { plan: 'required', cost: 'required' },

  // Embodied
  'embodied:panel-changed':      { panel: 'required' },
  'embodied:focus-changed':      { focus: 'required' },
  'embodied:engagement-changed': { engagement: 'required' },

  // Web
  'web:search':             { query: 'required' },
  'web:fetch':              { url: 'required' },
  'web:fetched':            { url: 'required', status: 'optional' },

  // Exec
  'exec:sandbox':           { code: 'required' },
  'exec:shell':             { command: 'required' },
  'exec:system':            { command: 'required' },

  // Expectation
  'expectation:formed':     { type: 'required' },
  'expectation:compared':   { type: 'required', match: 'required' },
  'expectation:calibrated': { type: 'required' },

  // Genome
  'genome:loaded':          {},
  'genome:trait-adjusted':  { trait: 'required', value: 'required' },
  'genome:reproduced':      { generation: 'required' },

  // Metabolism
  'metabolism:consumed':       { tokens: 'required' },
  'metabolism:insufficient':   { required: 'required', available: 'required' },
  'metabolism:state-changed':  { state: 'required' },

  // Prompt evolution
  'prompt-evolution:experiment-started':   { section: 'required', hypothesis: 'required' },
  'prompt-evolution:experiment-completed': { section: 'required', promoted: 'required' },
  'prompt-evolution:rollback':             { section: 'required', reason: 'required' },

  // Misc single-event domains
  'chat:retry':             { attempt: 'required', error: 'required', delayMs: 'required' },
  'ci:analyzed':            { totalFailures: 'required', autoFixable: 'required' },
  'container:replaced':     { name: 'required' },
  'container:binding-report': { timestamp: 'required', summary: 'required' }, // v7.2.1
  'context:built':          {},
  'editor:open':            { content: 'required', language: 'optional', filename: 'optional' },
  'embedding:ready':        { model: 'required', dimensions: 'required' },
  'episodic:recorded':      { episode: 'required' },
  'ui:heartbeat':           {},
  'router:routed':          { backend: 'required' },
  'store:integrity-violation': { key: 'required' },
  'worldstate:file-changed':   { path: 'required' },
  'narrative:updated':      { chapter: 'optional' },
  'goals:loaded':           { total: 'required', unfinished: 'optional', archived: 'optional' },
  'failure:classified':     { category: 'required', error: 'required' },
  'classifier:trained':     { samples: 'required' },
  // autonomy:status — removed in v7.0.3 (orphaned, 0 emitters, 0 listeners)
  'notification:show':      { message: 'required' },
  'fitness:evaluated':      { score: 'required' },
  'safety:degraded':        { reason: 'required' },
  'boot:degraded':          { reason: 'required' },
  'error:health-summary':   { errors: 'required' },
  'circuit:fallback':       { service: 'required' },
  'capability:issued':      { module: 'required', scope: 'required', tokenId: 'required' },
  'capability:revoked':     { tokenId: 'required' },
  'tool:native-call':       { name: 'required', round: 'required', input: 'required' },
  'tools:unregistered':     { name: 'required' },
  'worker:spawned':         { workerId: 'required' },
  'worker:error':           { workerId: 'required', error: 'required' },
  'fs:read':                { path: 'required' },
  'fs:write':               { path: 'required' },
  'net:external':           { url: 'required' },
  'net:local':              {},
  'surprise:processed':     { surprise: 'required' },
  'surprise:amplified-learning': { surprise: 'required' },
  'steering:model-escalation':   { frustration: 'required' },
  'steering:rest-mode':          {},
  'intent:llm-classified':  { intent: 'required', message: 'optional' },
  'intent:learned':         { type: 'required' },
  'knowledge:learned':      { count: 'optional', source: 'optional', text: 'optional' },
  'knowledge:node-added':   { id: 'required', type: 'optional', label: 'optional' },
  'meta:outcome-recorded':  { category: 'required', success: 'required', model: 'optional', total: 'optional' },
  'meta:recommendations-updated': {},
  'needs:high-drive':       { need: 'required' },
  'needs:satisfied':        { need: 'required' },
  'planner:complete':       { plan: 'required' },
  'planner:truncated':      { reason: 'required' },
  'preservation:violation': { rule: 'required' },
  'emotion:watchdog-reset': { dimension: 'required', from: 'required', to: 'required', stuckMs: 'required' },
  'emotion:watchdog-alert': { stuck: 'required' },
  'lessons:recorded':       { category: 'required' },
  'colony:ipc-spawn':       { runId: 'required', workerCount: 'required' },

  // Disclosure (v7.0.4 — Information Sovereignty)
  'disclosure:probe-detected': { count: 'required', pattern: 'required' },

  'fs:write:self':            { file: 'optional' },

  // ── v7.0.5: System kernel events ────────────────────────
  'system:security-degraded': { reason: 'required', preloadMode: 'required', mitigation: 'required' },

  // ── v7.0.5: EventStore-forwarded events (store:TYPE) ────
  // All emitted by EventStore.append() → bus.emit(`store:${type}`, event).
  // The payload is the full event object: { id, type, payload, source, timestamp, isoTime, prevHash, hash }.
  'store:AGENT_LOOP_COMPLETE':  { id: 'required', type: 'required', payload: 'required' },
  'store:CHAT_MESSAGE':         { id: 'required', type: 'required', payload: 'required' },
  'store:CODE_MODIFIED':        { id: 'required', type: 'required', payload: 'required' },
  'store:CODE_SAFETY_BLOCK':    { id: 'required', type: 'required', payload: 'required' },
  'store:CODE_SAFETY_WARN':     { id: 'required', type: 'required', payload: 'required' },
  'store:COGNITIVE_SNAPSHOT':   { id: 'required', type: 'required', payload: 'required' },
  'store:ERROR_OCCURRED':       { id: 'required', type: 'required', payload: 'required' },
  'store:HEALTH_ALERT':        { id: 'required', type: 'required', payload: 'required' },
  'store:HEALTH_CIRCUIT_FORCED': { id: 'required', type: 'required', payload: 'required' },
  'store:HEALTH_DEGRADATION':   { id: 'required', type: 'required', payload: 'required' },
  'store:IDLE_THOUGHT':         { id: 'required', type: 'required', payload: 'required' },
  'store:INTENT_CLASSIFIED':    { id: 'required', type: 'required', payload: 'required' },
  'store:MCP_TOOL_CALL':        { id: 'required', type: 'required', payload: 'required' },
  'store:MODEL_FAILOVER':       { id: 'required', type: 'required', payload: 'required' },
  'store:MULTI_FILE_REFACTOR':  { id: 'required', type: 'required', payload: 'required' },
  'store:SHELL_PLAN_EXECUTED':  { id: 'required', type: 'required', payload: 'required' },
  'store:SKILL_CREATED':        { id: 'required', type: 'required', payload: 'required' },
  'store:SURPRISE_NOVEL':      { id: 'required', type: 'required', payload: 'required' },
  'store:SYSTEM_BOOT':          { id: 'required', type: 'required', payload: 'required' },
  'store:SYSTEM_SHUTDOWN':      { id: 'required', type: 'required', payload: 'required' },
  'store:TASK_DELEGATED':      { id: 'required', type: 'required', payload: 'required' },

  // v7.1.2: Causal Annotation
  'causal:recorded':            { stepId: 'required', changes: 'required', relation: 'required' },
  'causal:promoted':            { action: 'required', suspicion: 'required', observations: 'required' },
  'causal:staleness-triggered': { file: 'required', diffPct: 'required', threshold: 'required' },

  // v7.1.2: Goal Synthesizer
  'goal:synthesized':           { title: 'required', weakness: 'required', priority: 'required' },
  'goal:circuit-breaker':       { regressions: 'required', pauseUntil: 'required' },

  // v7.1.2: Inference Engine
  'inference:contradictions-found': { count: 'required' },

  // v7.1.2: Structural Abstraction
  'abstraction:extracted':      { lessonId: 'required', category: 'required' },
  'abstraction:contradiction':  { lessonId: 'required', category: 'required' },
  'abstraction:obsolete':       { lessonId: 'required', retries: 'required', lastReason: 'required' },
};

// ── Stats ─────────────────────────────────────────────────
let _validationStats = { checked: 0, warnings: 0, events: new Set() };
const _warnedOnce = new Set(); // Only warn once per event+field combo

/**
 * Install payload validation as an EventBus middleware.
 * Only active in dev mode. Does not block events — only warns.
 *
 * @param {EventBus} bus
 * @returns {{ getStats: () => object, removeMiddleware: () => void }}
 */
function installPayloadValidation(bus) {
  const isDev = typeof process !== 'undefined' && process.env?.NODE_ENV !== 'production';
  if (!isDev) {
    return { getStats: () => _validationStats, removeMiddleware: () => {} };
  }

  const middleware = (event, data, meta) => {
    const schema = SCHEMAS[event];
    if (!schema) return; // No schema defined — skip silently

    _validationStats.checked++;
    _validationStats.events.add(event);

    if (!data || typeof data !== 'object') {
      const warnKey = `${event}:__null_data__`;
      if (!_warnedOnce.has(warnKey)) {
        _warnedOnce.add(warnKey);
        _validationStats.warnings++;
        _log.warn(`[EVENT:SCHEMA] "${event}" emitted with non-object data: ${typeof data}`);
      }
      return;
    }

    for (const [field, requirement] of Object.entries(schema)) {
      if (requirement === 'required' && (data[field] === undefined || data[field] === null)) {
        const warnKey = `${event}:${field}`;
        if (!_warnedOnce.has(warnKey)) {
          _warnedOnce.add(warnKey);
          _validationStats.warnings++;
          _log.warn(`[EVENT:SCHEMA] "${event}" missing required field "${field}". Source: ${meta?.source || '?'}`);
        }
      }
    }
  };

  bus.use(middleware);

  return {
    getStats: () => ({
      ..._validationStats,
      events: _validationStats.events.size,
      schemasLoaded: Object.keys(SCHEMAS).length,
    }),
    removeMiddleware: () => {
      // EventBus.middlewares is an array — remove by reference
      const idx = bus.middlewares ? bus.middlewares.indexOf(middleware) : -1;
      if (idx >= 0 && bus.middlewares) bus.middlewares.splice(idx, 1);
    },
  };
}

module.exports = { installPayloadValidation, SCHEMAS };
