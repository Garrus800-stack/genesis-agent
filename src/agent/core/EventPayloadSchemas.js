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
  // v4.12.5-fix: This is the ONLY completion event. Removed phantom 'agent-loop:completed'.
  'agent-loop:complete':        { goalId: 'required', title: 'required', steps: 'required', success: 'required' },
  // v4.12.5-fix: Schema now matches AgentLoop.js emission (stepIndex, result, type)
  'agent-loop:step-complete':   { goalId: 'required', stepIndex: 'required', type: 'required' },
  'agent-loop:approval-needed': { action: 'required', description: 'required' },
  'agent-loop:needs-input':     { goalId: 'required', question: 'required' },

  // Agent System
  'agent:status':   { state: 'required', detail: 'optional' },
  'agent:shutdown': { errors: 'optional' },

  // Chat
  'chat:completed': { message: 'required', response: 'required', intent: 'required', success: 'required' },
  'chat:error':     { error: 'required' },

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

  // Idle Mind
  'idle:thinking':         { activity: 'required', thought: 'required' },
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

  // Metabolism
  'metabolism:cost':        { cost: 'required', tokens: 'required' },

  // Immune System
  'immune:intervention':    { description: 'required' },
  'immune:quarantine':      { source: 'required', durationMs: 'required' },

  // Consciousness
  'consciousness:frame':    { epoch: 'required', valence: 'required', arousal: 'required' },
  'consciousness:shift':    { from: 'required', to: 'required', qualia: 'required' },

  // v5.7.0: Previously unschema'd events
  // Intent
  'intent:classified':       { type: 'required', confidence: 'optional' },

  // Surprise
  'surprise:novel-event':    { summary: 'required' },
  'surprise:novel':          { summary: 'optional' },

  // Self-Modification
  'selfmod:success':         { file: 'required' },

  // Daemon
  'daemon:skill-created':    { skill: 'required', reason: 'required' },

  // Reserved (registered in EventTypes, not yet emitted — schemas ready for use)
  'shell:complete':          { command: 'optional', exitCode: 'optional' },
  'health:alert':            { level: 'required', message: 'required' },
  'task:delegated':          { peerId: 'required', task: 'required' },
  'mcp:tool-call':           { server: 'required', tool: 'required' },
  'mcp:server-started':      { port: 'required' },
  'mcp:bridge-started':      { tools: 'required', resources: 'optional' },
  'mcp:resource-read':       { uri: 'required' },

  // v5.9.0: High-traffic event schemas
  'error:trend':                     { category: 'required', type: 'required' },
  'goal:completed':                  { id: 'required', description: 'required' },
  'cognitive:snapshot':      { type: 'optional' },

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
