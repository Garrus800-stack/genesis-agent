// ============================================================
// GENESIS — foundation/ModelBridgeDispatch.js (v7.9.50)
//
// How a call reaches a backend, and what is recorded when it returns:
// _dispatch and its two entry points, the model resolution behind them, the
// meta-learning outcome record and the two stats readers.
//
// Split out of ModelBridge.js, which stood at 698 lines against a 700-line
// guard. The block was checked for free identifiers BEFORE it was cut — the
// v7.9.48 split searched for five names it expected and missed _log, and every
// streamed answer ended in a reference error while every gate stayed green.
// This block needs exactly one name from the module head, and it travels here.
//
// Mixed onto ModelBridge.prototype. `this` is the bridge throughout.
// ============================================================

'use strict';

const { createLogger } = require('../core/Logger');
const _log = createLogger('ModelBridge');

const modelBridgeDispatch = {
  _dispatch({ mode, backendName, systemPrompt, messages, temp, modelOverride, maxTokens, onChunk, abortSignal, taskType }) {
    // v7.9.25: fail-soft for an unresolved backend. During the boot window the
    // active backend can still be null (Phase 2 configures activeModel=null until
    // the real model resolves). Rather than throw "No model backend configured" —
    // which the caller turns into a failover WARN on every call until switchTo
    // lands — fall back to ollama, the always-present local backend, at debug
    // level. A throw is reserved for genuine misconfiguration: ollama also absent.
    if (!this.backends[backendName] && this.backends.ollama) {
      _log.debug(`[MODEL] backend '${backendName}' unresolved — using ollama (boot/teardown window)`);
      backendName = 'ollama';
    }
    const model = modelOverride || this._getModelForBackend(backendName);
    const backend = this.backends[backendName];
    if (mode === 'chat') {
      if (!backend) throw new Error('No model backend configured');
      // v7.8.9 (llm-resilience-v789 contract): code-generation calls through
      // OllamaBackend get routed through ContinuationLoop so partial outputs
      // survive timeout/length truncations. Other taskTypes and other backends
      // (Anthropic/OpenAI) keep their original non-streaming path unchanged.
      if (taskType === 'code' && backendName === 'ollama') {
        return this._dispatchChatWithContinuation({
          backend, systemPrompt, messages, temp, model, maxTokens, taskType,
        });
      }
      return backend.chat(systemPrompt, messages, temp, model, maxTokens);
    }
    if (mode === 'stream') {
      if (!backend) {
        return this._dispatch({ mode: 'chat', backendName, systemPrompt, messages, temp, modelOverride, maxTokens, taskType })
          .then(result => { onChunk(result); return result; })
          .catch(err => {
            _log.error('[MODEL] Non-streaming fallback failed:', err.message);
            throw err;
          });
      }
      return backend.stream(systemPrompt, messages, onChunk, abortSignal, temp, model, maxTokens);
    }
    throw new Error(`Unknown dispatch mode: ${mode}`);
  },

  /**
   * v7.8.9: route a code-generation call through ContinuationLoop.
   * Implementation lives in ModelBridgeContinuation.js (mixin) to keep
   * this file under the 700-LOC architectural-fitness soft-guard.
   * @private
   */
  // _dispatchChatWithContinuation — mixed in from ModelBridgeContinuation.js

  _dispatchChat(backendName, systemPrompt, messages, temp, modelOverride, maxTokens, taskType) {
    return this._dispatch({ mode: 'chat', backendName, systemPrompt, messages, temp, modelOverride, maxTokens, taskType });
  },

  _dispatchStream(backendName, systemPrompt, messages, onChunk, abortSignal, temp, modelOverride, maxTokens, taskType) {
    return this._dispatch({ mode: 'stream', backendName, systemPrompt, messages, temp, modelOverride, maxTokens, onChunk, abortSignal, taskType });
  },

  // ── v7.5.6: Model-availability tracking — extracted to mixin ─────
  // Methods mixed in: markUnavailable, isMarkedUnavailable,
  // clearUnavailable, _loadUnavailable, _persistUnavailable,
  // _isCloudModelName, _warnIfCloudWithoutFallback.

  // ── v7.6.5 (A2 file-size-guard closeout): Failover helpers — extracted to mixin ─────
  // Methods mixed in via failoverMixin (see ModelBridgeFailover.js):
  //   _findFallbackBackend(failedBackend, failedModelName?)
  //   _classifyFailoverReason(err)
  //   _emitFailoverUnavailable(failedBackend, err)
  // Pre-v7.6.5 these lived inline here as ~58 LOC; ModelBridge.js was
  // 700 LOC (701 reported by File-Size-Guard due to trailing newline).
  // Pure structural extraction, runtime semantics unchanged.

  _getModelForBackend(backend) {
    // v5.1.0: Use specific fallback model if set by _findFallbackBackend
    if (this._fallbackModel && this._fallbackModel.backend === backend) {
      const model = this._fallbackModel;
      this._fallbackModel = null; // one-shot
      return model.name;
    }
    if (backend === this.activeBackend) return this.activeModel;
    if (backend === 'anthropic') return this.backends.anthropic.defaultModel;
    const fallbackModel = this.availableModels.find(m => m.backend === backend);
    return fallbackModel?.name || this.activeModel;
  },

  // ════════════════════════════════════════════════════════
  // META-LEARNING INTEGRATION
  // ════════════════════════════════════════════════════════

  // v7.5.6: `calledModel` parameter added so MetaLearning sees the model
  // that was actually invoked, not `this.activeModel`. The two diverge
  // during failover: chat() catches an error, calls _recordMetaOutcome
  // with `success: true` after the fallback dispatch — but `this.activeModel`
  // is still the originally-failed model name. Pre-v7.5.6 that meant the
  // dead model was logged with `success: true`, while the fallback model
  // got no record — biasing every per-model success-rate downstream of
  // MetaLearning. Callers in chat()/streamChat() pass `calledModel` for
  // the success path, `fallback` for the post-failover success path,
  // and `calledModel` again for the throw-path.
  _recordMetaOutcome(taskCategory, temperature, startTime, success, options = {}, calledModel = null) {
    if (!this.metaLearning) return;
    try {
      this.metaLearning.recordOutcome({
        taskCategory,
        model: calledModel || this.activeModel,
        promptStyle: options.promptStyle || 'free-text',
        temperature,
        outputFormat: options.outputFormat || 'text',
        success,
        latencyMs: Date.now() - startTime,
        inputTokens: 0,
        outputTokens: 0,
        verificationResult: options.verificationResult || (success ? 'pass' : 'fail'),
        retryCount: options.retryCount || 0,
      });
    } catch (_e) { _log.debug('[catch] MetaLearning recording is best-effort:', _e.message); }
  },

  // ════════════════════════════════════════════════════════
  // PUBLIC UTILS
  // ════════════════════════════════════════════════════════

  getConcurrencyStats() {
    return this._semaphore.getStats();
  },

  /**
   * v7.5.2: Public introspection for routing stats.
   * Returns counter, last routing event (defensive copy), router availability,
   * and live setting state.
   */
  getRoutingStats() {
    return {
      autoRouted: this._routingStats.autoRouted,
      lastRouted: this._routingStats.lastRouted
        ? { ...this._routingStats.lastRouted }
        : null,
      routerAvailable: !!this._modelRouter,
      enabled: this._settings?.get?.('agency.autoRouteByTask') !== false,
    };
  }
};

module.exports = { modelBridgeDispatch };
