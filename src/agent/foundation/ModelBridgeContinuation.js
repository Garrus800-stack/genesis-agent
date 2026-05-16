// ============================================================
// GENESIS — foundation/ModelBridgeContinuation.js (v7.8.9)
//
// llm-resilience-v789 contract: continuation-helper mixin extracted
// from ModelBridge.js to keep the parent file under the 700-LOC
// architectural-fitness soft-guard. Holds the single method that
// wraps an Ollama code-generation call in a ContinuationLoop +
// LLMCapabilityDetector pipeline.
//
// Why split (same rationale as ModelBridgeFailover):
//   ModelBridge.js touched 710 LOC after the v7.8.9 continuation
//   hook landed inline. File-Size-Guard counts trailing newline,
//   so a soft-guard hit was inevitable. The continuation pathway
//   is a coherent cluster — it always runs together (capability
//   detect → continuation loop), reads only `this.backends`,
//   `this.bus`, and `this._genesisDir` via standard mixin
//   conventions, and writes only a private lazy field
//   (`this._capabilityDetector`).
//
// Coupling note: methods read/write
//   this._capabilityDetector   write — lazily-constructed singleton per bridge
//   this._genesisDir            read  — set by ModelBridge constructor / caller
//   this.bus                    read  — passed into ContinuationLoop as eventBus
//
// Mixed onto ModelBridge.prototype at module-load via Object.assign
// — see ModelBridge.js bottom + the canonical Mixin Convention in
// ARCHITECTURE.md § 5.8.
// ============================================================

'use strict';

const { createLogger } = require('../core/Logger');
const _log = createLogger('ModelBridgeContinuation');

// Lazy-loaded continuation pieces. Loaded on first use so the module
// graph remains tree-shakeable for callers that never invoke
// code-generation paths (e.g. embedding-only setups).
let _continuationLoop = null;
let _capabilityDetectorClass = null;

function _loadContinuation() {
  if (!_continuationLoop) {
    _continuationLoop = require('./backends/ContinuationLoop');
  }
  return _continuationLoop;
}

function _loadCapabilityDetectorClass() {
  if (!_capabilityDetectorClass) {
    _capabilityDetectorClass = require('./backends/LLMCapabilityDetector').LLMCapabilityDetector;
  }
  return _capabilityDetectorClass;
}

const continuationMixin = {

  /**
   * v7.8.9: route a code-generation call through ContinuationLoop.
   *
   * Only invoked from ModelBridge._dispatch when both conditions hold:
   *   - taskType === 'code'
   *   - backendName === 'ollama'
   *
   * Other taskTypes and other backends keep their original non-streaming
   * path unchanged. The capability detector is constructed lazily on first
   * code call against this bridge, then memoized for subsequent calls.
   *
   * @private
   * @param {object} args
   * @param {object} args.backend      OllamaBackend instance
   * @param {string} args.systemPrompt
   * @param {Array}  args.messages
   * @param {number} args.temp
   * @param {string} args.model        Effective model name (post-routing)
   * @param {number} [args.maxTokens]
   * @param {string} [args.taskType]
   * @returns {Promise<string>}        Final response text
   */
  async _dispatchChatWithContinuation({ backend, systemPrompt, messages, temp, model, maxTokens, taskType }) {
    const { runContinuation } = _loadContinuation();
    if (!this._capabilityDetector) {
      const Cls = _loadCapabilityDetectorClass();
      this._capabilityDetector = new Cls({
        baseUrl: backend.baseUrl,
        genesisDir: this._genesisDir || null,
      });
    }
    let capability = null;
    try {
      capability = await this._capabilityDetector.detectCapability(model);
    } catch (err) {
      _log.debug(`[CONTINUATION] capability detection failed: ${err.message}`);
    }
    const result = await runContinuation({
      backend,
      systemPrompt,
      messages,
      options: {
        modelName: model,
        temperature: temp,
        maxTokens,
        capability,
        taskType,
        eventBus: this.bus || null,
      },
    });
    return result.content;
  },

};

module.exports = { continuationMixin };
