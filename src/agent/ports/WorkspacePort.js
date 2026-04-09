// ============================================================
// GENESIS — WorkspacePort.js (v5.5.0)
//
// Port adapter for CognitiveWorkspace.
//
// WHY: AgentLoop (phase 8) needs working memory but
// CognitiveWorkspace lives in phase 9 (cognitive/).
// Direct import = cross-phase coupling (fitness -1 point).
//
// SOLUTION: This port provides:
//   1. NullWorkspace — safe no-op when cognitive/ not loaded
//   2. WorkspaceFactory — injectable factory for real workspaces
//
// AgentLoop imports from ports/ (allowed), gets the real
// implementation injected via late-binding from phase 9 manifest.
// ============================================================

'use strict';

/**
 * Null-object pattern for when no workspace is active or
 * when cognitive layer is not loaded (--minimal boot profile).
 * All operations are safe no-ops.
 */
class NullWorkspace {
  /** @param {string} [_key] @param {*} [_value] @param {number} [_salience] */
  store(_key, _value, _salience) { return { stored: false, reason: 'null-workspace' }; }
  /** @param {string} [_key] */
  recall(_key) { return null; }
  /** @param {string} [_key] */
  has(_key) { return false; }
  /** @param {string} [_key] */
  remove(_key) { return false; }
  snapshot() { return []; }
  tick() {}
  /** @param {number} [_maxItems] */
  buildContext(_maxItems) { return ''; }
  getConsolidationCandidates() { return []; }
  clear() { return { itemsCleared: 0, consolidated: 0 }; }
  getStats() { return { goalId: null, slots: 0, capacity: 0, steps: 0 }; }
}

/**
 * Default workspace factory — creates NullWorkspace instances.
 * Replaced at runtime by phase 9 manifest with real CognitiveWorkspace factory.
 *
 * @param {object} _opts - { goalId, goalTitle }
 * @returns {NullWorkspace}
 */
function nullWorkspaceFactory(_opts) {
  return new NullWorkspace();
}

module.exports = { NullWorkspace, nullWorkspaceFactory };
