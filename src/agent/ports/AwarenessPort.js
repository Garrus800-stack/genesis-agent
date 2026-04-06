// GENESIS — ports/AwarenessPort.js
// ═══════════════════════════════════════════════════════════════
// V7-6: Lightweight Awareness port replacing the 14-module
// Consciousness Layer. All consumers depend on this contract
// instead of 5 separate consciousness services.
//
// Replaces: AttentionalGate, PhenomenalField, TemporalSelf,
//           IntrospectionEngine, ConsciousnessExtension,
//           + 9 internal modules.
//
// Default: NullAwareness (no-op, ~0 overhead).
// Future:  A real implementation can be plugged in via DI.
// ═══════════════════════════════════════════════════════════════

'use strict';

/**
 * @typedef {object} AwarenessReport
 * @property {string}  mode       - 'diffuse' | 'focused' | 'captured'
 * @property {string|null} focus  - primary focus channel or null
 * @property {number}  coherence  - 0..1
 * @property {string|null} qualia - current qualia or null
 * @property {boolean} paused     - whether ethical deliberation is active
 * @property {string[]} concerns  - active ethical/apprehension concerns
 * @property {string}  valueContext - enrichment text from value system
 */

/**
 * Minimal awareness contract for Genesis.
 *
 * Every method has a safe default so consumers never need null-checks.
 * This is an abstract base — do not instantiate directly.
 */
class AwarenessPort {
  // ── Lifecycle ─────────────────────────────────────────────

  start() {}
  stop() {}
  async asyncLoad() {}

  // ── Core queries (used by SelfModPipeline, AgentLoopCognition) ──

  /** @returns {number} 0..1 coherence score */
  getCoherence() { return 1.0; }

  /** @returns {string} 'diffuse' | 'focused' | 'captured' */
  getMode() { return 'diffuse'; }

  /** @returns {string|null} primary attention focus */
  getPrimaryFocus() { return null; }

  /** @returns {string|null} current qualia */
  getQualia() { return null; }

  // ── Plan consultation (used by AgentLoopCognition) ────────

  /**
   * Consult awareness before plan execution.
   * @param {object} _plan
   * @returns {AwarenessReport}
   */
  consult(_plan) {
    return {
      mode: 'diffuse',
      focus: null,
      coherence: 1.0,
      qualia: null,
      paused: false,
      concerns: [],
      valueContext: '',
    };
  }

  // ── Prompt context (used by PromptBuilder) ────────────────

  /** @returns {string} text to inject into system prompt */
  buildPromptContext() { return ''; }

  // ── Health reporting (used by AgentCoreHealth, Dashboard) ──

  /** @returns {object} health/status report */
  getReport() {
    return {
      mode: 'diffuse',
      coherence: 1.0,
      qualia: null,
      focus: null,
      active: false,
    };
  }
}

module.exports = { AwarenessPort };
