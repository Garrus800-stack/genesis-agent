// @ts-checked-v5.6
// ============================================================
// GENESIS — CorrelationContext.js (v5.2.0)
//
// Lightweight causal tracing via correlation IDs.
// Uses Node.js AsyncLocalStorage to propagate a correlationId
// through the entire async call chain without manual threading.
//
// Usage:
//   CorrelationContext.run('goal-abc', async () => {
//     // Every EventBus emit, log call, and storage write
//     // in this async scope automatically carries 'goal-abc'
//     const id = CorrelationContext.getId(); // → 'goal-abc'
//   });
//
// WHY: After v5.1.1, Genesis has ~190 modules. When a goal
// fails, there's no way to trace whether the cause was in
// PromptBuilder (wrong context), VectorMemory (irrelevant
// recall), ContextManager (token budget), or the tool itself.
// Correlation IDs connect the dots across services without
// requiring each service to explicitly pass an ID parameter.
//
// DESIGN: Zero-dependency, zero-config. AsyncLocalStorage is
// built into Node.js since v16. No OpenTelemetry, no spans,
// no collector — just a string ID threaded through the async
// context. EventBus auto-injects it into meta. EventStore
// indexes by it. Logger prefixes it. That's the entire system.
// ============================================================

const { AsyncLocalStorage } = require('async_hooks');
const crypto = require('crypto');

const _store = new AsyncLocalStorage();

// Compact ID: 8-char hex + timestamp suffix for uniqueness + ordering
function _generateId(prefix) {
  const hex = crypto.randomBytes(4).toString('hex');
  const ts = Date.now().toString(36);
  return prefix ? `${prefix}-${hex}-${ts}` : `${hex}-${ts}`;
}

const CorrelationContext = {
  /**
   * Run an async function within a correlation scope.
   * All async descendants inherit the correlation ID.
   *
   * @param {string|null} id - Explicit ID or null to auto-generate
   * @param {(...args: any[]) => any} fn - Async function to execute
   * @param {string} [prefix='cor'] - Prefix for auto-generated IDs
   * @returns {*} Result of fn
   */
  run(id, fn, prefix = 'cor') {
    const correlationId = id || _generateId(prefix);
    return _store.run({ correlationId, startedAt: Date.now() }, fn);
  },

  /**
   * Get the current correlation ID, or null if outside a scope.
   * @returns {string|null}
   */
  getId() {
    return _store.getStore()?.correlationId || null;
  },

  /**
   * Get full context (id + timing).
   * @returns {{ correlationId: string, startedAt: number, elapsedMs: number }|null}
   */
  getContext() {
    const ctx = _store.getStore();
    if (!ctx) return null;
    return {
      correlationId: ctx.correlationId,
      startedAt: ctx.startedAt,
      elapsedMs: Date.now() - ctx.startedAt,
    };
  },

  /**
   * Fork a child correlation from the current scope.
   * Child ID = parentId/childSuffix for visual nesting.
   *
   * @param {(...args: any[]) => any} fn - Async function to run in child scope
   * @param {string} [label='sub'] - Label for the child
   * @returns {*} Result of fn
   */
  fork(fn, label = 'sub') {
    const parentId = this.getId();
    const childId = parentId
      ? `${parentId}/${label}-${crypto.randomBytes(2).toString('hex')}`
      : _generateId(label);
    return _store.run({ correlationId: childId, startedAt: Date.now(), parentId }, fn);
  },

  /**
   * Inject correlation ID into an object (meta, payload, etc.)
   * Non-destructive: only adds if a correlation scope is active.
   *
   * @param {object} obj - Object to enrich
   * @returns {object} Same object, with correlationId added if available
   */
  inject(obj) {
    const id = this.getId();
    if (id && obj && typeof obj === 'object') {
      obj.correlationId = id;
    }
    return obj;
  },

  /**
   * Generate a new correlation ID without entering a scope.
   * Useful for creating IDs to pass explicitly.
   *
   * @param {string} [prefix='cor'] - ID prefix
   * @returns {string}
   */
  generate(prefix = 'cor') {
    return _generateId(prefix);
  },
};

module.exports = { CorrelationContext };
