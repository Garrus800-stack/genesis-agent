// @ts-checked-v5.8
// ============================================================
// GENESIS AGENT — ModelBridge.js
//
// Orchestrates LLM backends (Ollama, Anthropic, OpenAI):
// dispatch + failover + concurrency (semaphore) + caching +
// MetaLearning integration + structured output (JSON mode).
// Backend implementations live in backends/.
// ============================================================

const path = require('path');
const { robustJsonParse } = require('../core/utils');
const { NullBus } = require('../core/EventBus');
const { TIMEOUTS, LIMITS } = require('../core/Constants');
const { LLMCache } = require('./LLMCache');
const { createLogger } = require('../core/Logger');
const _log = createLogger('ModelBridge');

// Backend implementations
const { OllamaBackend } = require('./backends/OllamaBackend');
const { AnthropicBackend } = require('./backends/AnthropicBackend');
const { OpenAIBackend } = require('./backends/OpenAIBackend');

// v7.8.9 (llm-resilience-v789 contract): continuation pipeline lives in
// the ModelBridgeContinuation mixin (lazy-loaded backends inside).

// v7.5.6/v7.5.7-fix: TTL by failover-reason for the unavailable-marker.
// 'connection-error' and 'other' are intentionally absent (transient).
// 'subscription-required' (v7.5.7-fix): 24h, Pro-gates don't fix in 1h.
// 'quota-exhausted' (v7.8.1): 24h, weekly/monthly limits reset on a slow
// cadence — retrying every 5min just burns more rate-limit responses.
const UNAVAILABLE_TTL_MAP = {
  'auth':                  60 * 60 * 1000,         // 1h
  'rate-limit':              5 * 60 * 1000,        // 5min
  'timeout':                10 * 60 * 1000,        // 10min
  'subscription-required': 24 * 60 * 60 * 1000,    // 24h
  'quota-exhausted':       24 * 60 * 60 * 1000,    // 24h
};

// ── Lightweight Semaphore ─────────────────────────────────
// FIX v3.5.0: Limits concurrent LLM requests. Without this,
// IdleMind + AgentLoop + Chat could flood Ollama simultaneously.
class _LLMSemaphore {
  constructor(maxConcurrent = 2, starvationMs = 5 * 60 * 1000) {
    this.max = maxConcurrent;
    this.active = 0;
    this.queue = [];     // { resolve, reject, priority, enqueueTime }
    this._starvationMs = starvationMs;
    this._stats = { acquired: 0, queued: 0, peakActive: 0, peakQueued: 0, timedOut: 0 };
  }

  async acquire(priority = 0) {
    if (this.active < this.max) {
      this.active++;
      this._stats.acquired++;
      this._stats.peakActive = Math.max(this._stats.peakActive, this.active);
      return;
    }
    this._stats.queued++;
    return new Promise((resolve, reject) => {
      const entry = { resolve, reject, priority, enqueueTime: Date.now() };
      let i = this.queue.findIndex(e => e.priority < priority);
      if (i === -1) i = this.queue.length;
      this.queue.splice(i, 0, entry);
      this._stats.peakQueued = Math.max(this._stats.peakQueued, this.queue.length);

      entry._timer = setTimeout(() => {
        const idx = this.queue.indexOf(entry);
        if (idx !== -1) {
          this.queue.splice(idx, 1);
          this._stats.timedOut++;
          reject(new Error(`LLM semaphore starvation: waited ${Math.round(this._starvationMs / 1000)}s at priority ${priority}`));
        }
      }, this._starvationMs);
    });
  }

  release() {
    if (this.active <= 0) {
      const trace = new Error('Double-release origin').stack;
      _log.warn('[LLM-SEMAPHORE] release() called with active=0 — possible double-release\n', trace);
      this._stats.doubleReleases = (this._stats.doubleReleases || 0) + 1;
      return;
    }
    this.active--;
    if (this.queue.length > 0) {
      const next = this.queue.shift();
      if (next._timer) clearTimeout(next._timer);
      this.active++;
      this._stats.acquired++;
      next.resolve();
    }
  }

  getStats() {
    return { ...this._stats, active: this.active, queued: this.queue.length };
  }
}

class ModelBridge {
  /** @param {{ bus?: *, maxConcurrentLLM?: number, genesisDir?: string, ollamaKeepAlive?: string|number|null, ollamaLocalTimeoutMs?: number }} [deps] */
  constructor({ bus, maxConcurrentLLM, genesisDir, ollamaKeepAlive, ollamaLocalTimeoutMs } = {}) {
    this.bus = bus || NullBus;
    this.activeModel = null;
    this.activeBackend = null;
    // v7.8.5: persistent state of the actually answering model.
    this.lastEffectiveModel = null;
    this.lastEffectiveBackend = null;
    this.lastFailoverReason = null;
    this.availableModels = [];
    this._semaphore = new _LLMSemaphore(
      maxConcurrentLLM || LIMITS.LLM_MAX_CONCURRENT,
      TIMEOUTS.SEMAPHORE_STARVATION
    );
    this._cache = new LLMCache({
      maxSize: 100,
      ttlMs: 5 * 60 * 1000,
      noCacheTaskTypes: ['chat', 'creative'],
    });
    // v4.10.0: Backend instances. v7.5.7-fix Phase 2: Ollama gets keepAlive
    // (null = Ollama default 5min; "30s"/"1h"/0 override).
    this.backends = {
      ollama: new OllamaBackend({
        keepAlive: ollamaKeepAlive == null ? null : ollamaKeepAlive,
        localTimeoutMs: ollamaLocalTimeoutMs,
      }),
      anthropic: new AnthropicBackend(),
      openai: new OpenAIBackend(),
    };

    this.temperatures = {
      code: 0.1,
      analysis: 0.3,
      chat: 0.7,
      creative: 0.9,
    };

    // v5.1.0: Per-task model roles — { chat: 'modelName', code: 'modelName', ... }
    this._roles = {};

    // Late-bound by Container — declared here for TypeScript visibility
    /** @type {*} */ this._settings = null;
    /** @type {*} */ this.metaLearning = null;
    /** @type {*} */ this._fallbackModel = null;
    /** @type {*} */ this._modelRouter = null;  // v7.5.2: late-bound for auto-routing

    // v7.5.6: model-availability tracking
    /** @type {Map<string, {until:number, reason:string, ttlMs:number}>} */
    this._unavailableUntil = new Map();
    this._unavailableFile = genesisDir
      ? path.join(genesisDir, 'model-unavailable.json')
      : null;
    this._loadUnavailable();

    // v7.9.0: persist genesisDir as instance field so the continuation mixin
    // (ModelBridgeContinuation) can pass it to LLMCapabilityDetector for the
    // capability cache. In v7.8.9 this was missing — detector ran but the
    // cache was never persisted, so every code-generation call re-ran the
    // expensive verification probe at boot.
    /** @type {string|null} */
    this._genesisDir = genesisDir || null;

    // v7.5.2: routing telemetry
    this._routingStats = { autoRouted: 0, lastRouted: null };
  }

  /**
   * v5.1.0 / v7.5.7-fix Phase 3: set per-task roles. Logs only on actual
   * change (UI saves used to send 4 individual IPCs → 4 identical log lines).
   * @param {{ chat?: string, code?: string, analysis?: string, creative?: string }} roles
   */
  setRoles(roles) {
    const newRoles = roles || {};
    const oldStr = JSON.stringify(this._roles || {});
    const newStr = JSON.stringify(newRoles);
    this._roles = newRoles;
    if (oldStr === newStr) return;
    _log.info(`[MODEL] Roles updated: ${Object.entries(this._roles).filter(([,v]) => v).map(([k,v]) => `${k}→${v}`).join(', ') || 'all auto'}`);
  }

  /** Resolve role-assigned model+backend for taskType, or null. */
  _resolveForTask(taskType) {
    const roleName = this._roles[taskType];
    if (!roleName) return null;
    const found = this.availableModels.find(m => m.name === roleName);
    if (!found) return null;
    return { model: found.name, backend: found.backend };
  }

  // ── MODEL MANAGEMENT ────────────────────────────────────
  // detectAvailable / _scoreModel / _selectBestModel / getRankedModels
  // live in ModelBridgeDiscovery.js (mixin via Object.assign at bottom).

  async switchTo(modelName) {
    const model = this.availableModels.find(m => m.name === modelName);
    if (!model) throw new Error(`Model not found: ${modelName}`);
    // v7.5.7-fix Phase 2: when switching Ollama models, unload the previous
    // one so Ollama doesn't keep both in RAM for 5min (default keep_alive).
    // Best-effort — silent on failure.
    const previousModel = this.activeModel;
    if (
      previousModel && previousModel !== model.name &&
      this.activeBackend === 'ollama' &&
      this.backends?.ollama?.unloadModel
    ) {
      try { await this.backends.ollama.unloadModel(previousModel); } catch (_e) { /* swallow */ }
    }
    this.activeModel = model.name;
    this.activeBackend = model.backend;
    return { ok: true, model: this.activeModel, backend: this.activeBackend };
  }

  /** @param {string} backendName @param {{ baseUrl?: *, apiKey?: *, models?: Array<*> }} config */
  configureBackend(backendName, config) {
    const backend = this.backends[backendName];
    if (!backend) throw new Error(`Unknown backend: ${backendName}`);

    backend.configure(config);

    // Refresh available models from this backend
    const newModels = backend.getModels();
    for (const m of newModels) {
      if (!this.availableModels.find(am => am.name === m.name)) {
        this.availableModels.push(m);
      }
    }
  }

  // ════════════════════════════════════════════════════════
  // CHAT (non-streaming)
  //
  // v7.5.1: two call shapes accepted.
  //   POSITIONAL (canonical):
  //     chat(systemPrompt: string, messages: Array, taskType?: string, options?: object)
  //   OBJECT-FORM (compatibility adapter):
  //     chat({ messages, systemPrompt?, taskType?, maxTokens?, temperature?, ... })
  //
  // Background: WakeUpRoutine, DreamCyclePhases, CoreMemories were
  // written against object-form before it was supported. Their calls
  // reached _dispatchChat with `systemPrompt = {messages, maxTokens,
  // temperature}` - backends rejected that with HTTP 400 or returned
  // garbage. Errors were swallowed by the callers' try/catch so the
  // LLM-path silently fell back to stubs (re-entry stub on boot,
  // dream-judgment 'keep' default, memory-classify 'other'). Visible
  // symptom: those features never actually ran the LLM.
  //
  // The adapter normalises object-form to positional. Per-call
  // maxTokens / temperature overrides are now honoured via options.
  // ════════════════════════════════════════════════════════

  /**
   * v7.5.6: Shared failover handler used by chat() and streamChat().
   * Classifies → marks-if-sticky → records failure → looks up fallback →
   * dispatches retry → records success (or emits failover-unavailable +
   * rethrows). `dispatch` is the transport-specific retry callback.
   * @private
   */
  async _handleFailoverError(err, ctx) {
    const { taskType, temp, startTime, options, calledModel, targetBackend, dispatch, label } = ctx;
    const reason = this._classifyFailoverReason(err);
    if (UNAVAILABLE_TTL_MAP[reason] && calledModel) {
      this.markUnavailable(calledModel, UNAVAILABLE_TTL_MAP[reason], reason);
    }
    // Record failure on the actual called model (pre-v7.5.6: lost).
    this._recordMetaOutcome(taskType, temp, startTime, false, options, calledModel);
    const fallback = this._findFallbackBackend(targetBackend, calledModel);
    if (fallback) {
      const fallbackModelName = this._fallbackModel?.name || null;
      // v7.8.5: log + payload identify the actual answering model.
      _log.warn(`[MODEL] ${label} ${targetBackend} failed, falling back to ${fallback}${fallbackModelName ? ` (${fallbackModelName})` : ''}: ${err.message}`);
      this.bus.fire('model:failover', {
        from: targetBackend,
        to: fallback,
        effectiveModel: fallbackModelName,
        preferredModel: calledModel,
        error: err.message,
        reason,
      }, { source: 'ModelBridge' });
      // v7.8.3: stamp the failover reason on the options object so the
      // subsequent _emitCallComplete (in LLMPort) can pick it up. We
      // mutate `options` directly because LLMPort holds the same
      // reference — `{...options, _failoverReason: reason}` would only
      // update the local copy. Default for non-failover calls is `'none'`
      // set in LLMPort._emitCallComplete.
      // v7.8.3 follow-up (F5): renamed from `failover` to
      // `_failoverReason` so the meta-outcome retry marker below
      // (`isFailoverRetry: true`) can live on the same options bag
      // without semantic collision.
      // v7.8.5: also stamp _effectiveModel for llm:call-complete + cost rows.
      if (options && typeof options === 'object') {
        options._failoverReason = reason;
        options._effectiveModel = fallbackModelName;
      }
      const result = await dispatch(fallback);
      this._recordMetaOutcome(taskType, temp, startTime, true, { ...options, isFailoverRetry: true }, fallbackModelName);
      // v7.8.5: failover succeeded — record state.
      this.lastEffectiveModel = fallbackModelName;
      this.lastEffectiveBackend = fallback;
      this.lastFailoverReason = reason;
      return result;
    }
    this._emitFailoverUnavailable(targetBackend, err);
    throw err;
  }

  async chat(systemPrompt, messages = [], taskType = 'chat', options = {}) {
    // v7.5.1: object-form adapter
    if (systemPrompt && typeof systemPrompt === 'object' && !Array.isArray(systemPrompt)) {
      const arg = systemPrompt;
      systemPrompt = typeof arg.systemPrompt === 'string' ? arg.systemPrompt : '';
      messages     = Array.isArray(arg.messages) ? arg.messages : [];
      taskType     = arg.taskType || 'chat';
      options      = {
        ...(arg.options || {}),
        ...(arg.maxTokens   !== undefined ? { maxTokens:   arg.maxTokens   } : {}),
        ...(arg.temperature !== undefined ? { temperature: arg.temperature } : {}),
        ...(arg.priority    !== undefined ? { priority:    arg.priority    } : {}),
        ...(arg.noCache     !== undefined ? { noCache:     arg.noCache     } : {}),
        ...(arg._userChat   !== undefined ? { _userChat:   arg._userChat   } : {}),  // v7.5.2
      };
    }

    // v7.6.1 Track A #4: routing/temp/role context shared with streamChat().
    // _prepareCallContext returns { temp, routedSwitch, roleOverride,
    // targetBackend, effectiveModel, calledModel, priority } and emits
    // 'model:auto-switched' (plus _routingStats++) when auto-routing fires.
    const { temp, routedSwitch, targetBackend, effectiveModel, calledModel, priority } =
      this._prepareCallContext({ taskType, options });

    // v7.5.2: when auto-routed, bypass cache because cache-key has no model.
    // Otherwise a code-gen request might return a cached chat-model result.
    const cacheKey = (options.noCache || routedSwitch)
      ? null
      : this._cache.buildKey(systemPrompt, messages, taskType);
    if (cacheKey) {
      const cached = this._cache.get(cacheKey);
      if (cached) {
        // v7.8.3 follow-up (F9): explicit cache-hit marker on the
        // options bag so LLMPort can emit the right cached:true on
        // the call-complete event instead of guessing via latency
        // heuristic. Pre-fix LLMPort used `latency < 5` which gave
        // false-positives on fast local Ollama calls — leading to
        // cost rows that claimed cached:true with non-zero tokens.
        if (options && typeof options === 'object') options._cached = true;
        return cached;
      }
    }

    const startTime = Date.now();
    await this._semaphore.acquire(priority);
    try {
      const result = await this._dispatchChat(targetBackend, systemPrompt, messages, temp, effectiveModel, options.maxTokens, taskType);
      this._recordMetaOutcome(taskType, temp, startTime, true, options, calledModel);
      // v7.8.5: clean call resets all failover state.
      this.lastEffectiveModel = calledModel;
      this.lastEffectiveBackend = targetBackend;
      this.lastFailoverReason = null;
      if (cacheKey) this._cache.set(cacheKey, result);
      return result;
    } catch (err) {
      return this._handleFailoverError(err, {
        taskType, temp, startTime, options, calledModel, targetBackend, label: '',
        dispatch: (backend) => this._dispatchChat(backend, systemPrompt, messages, temp, undefined, options.maxTokens, taskType),
      });
    } finally {
      this._semaphore.release();
    }
  }

  // ════════════════════════════════════════════════════════
  // STREAMING CHAT
  // ════════════════════════════════════════════════════════

  async streamChat(systemPrompt, messages = [], onChunk, abortSignal, taskType = 'chat', options = {}) {
    // v7.5.1.x: object-form adapter — mirrors chat() so streamChat can also
    // be called as streamChat({ systemPrompt, messages, onChunk, abortSignal,
    // taskType, maxTokens, temperature, priority }). No active caller used
    // this form yet, but keeping the two paths symmetric closes the
    // documented v7.6+ deferred parity-gap inside v7.5.1.
    if (systemPrompt && typeof systemPrompt === 'object' && !Array.isArray(systemPrompt)) {
      const arg = systemPrompt;
      systemPrompt = typeof arg.systemPrompt === 'string' ? arg.systemPrompt : '';
      messages     = Array.isArray(arg.messages) ? arg.messages : [];
      onChunk      = typeof arg.onChunk === 'function' ? arg.onChunk : onChunk;
      abortSignal  = arg.abortSignal !== undefined ? arg.abortSignal : abortSignal;
      taskType     = arg.taskType || 'chat';
      options      = {
        ...(arg.options || {}),
        ...(arg.maxTokens   !== undefined ? { maxTokens:   arg.maxTokens   } : {}),
        ...(arg.temperature !== undefined ? { temperature: arg.temperature } : {}),
        ...(arg.priority    !== undefined ? { priority:    arg.priority    } : {}),
        ...(arg.noCache     !== undefined ? { noCache:     arg.noCache     } : {}),  // v7.5.9 B5: parity with chat()
        ...(arg._userChat   !== undefined ? { _userChat:   arg._userChat   } : {}),  // v7.5.2
      };
    }

    // v7.6.1 Track A #4: routing/temp/role context shared with chat().
    // _prepareCallContext returns { temp, routedSwitch, roleOverride,
    // targetBackend, effectiveModel, calledModel, priority } and emits
    // 'model:auto-switched' (plus _routingStats++) when auto-routing fires.
    // Pre-extract, streamChat() drifted from chat() three times: v7.5.6
    // (MetaLearning), v7.5.9 B5 (noCache parity), v7.6.0 §4.1 (recommend).
    // Each fix was symptomatic — this extract makes drift structurally
    // impossible.
    // Drift-risk (v7.6.1 audit): streamChat skips routedSwitch — streams
    // don't cache. If a stream-cache is ever added, destructure it here
    // and replicate the cache-bypass from chat() (auto-routed code-model
    // calls would otherwise return cached chat-model results).
    const { temp, targetBackend, effectiveModel, calledModel, priority } =
      this._prepareCallContext({ taskType, options });

    const maxTokens = (typeof options.maxTokens === 'number' && options.maxTokens > 0)
      ? options.maxTokens
      : undefined;

    const startTime = Date.now();
    await this._semaphore.acquire(priority);
    try {
      const result = await this._dispatchStream(targetBackend, systemPrompt, messages, onChunk, abortSignal, temp, effectiveModel, maxTokens);
      this._recordMetaOutcome(taskType, temp, startTime, true, options, calledModel);
      // v7.8.5: mirror chat() — clean call resets failover state.
      this.lastEffectiveModel = calledModel;
      this.lastEffectiveBackend = targetBackend;
      this.lastFailoverReason = null;
      return result;
    } catch (err) {
      return this._handleFailoverError(err, {
        taskType, temp, startTime, options, calledModel, targetBackend, label: 'Stream',
        dispatch: (backend) => this._dispatchStream(backend, systemPrompt, messages, onChunk, abortSignal, temp, undefined, maxTokens),
      });
    } finally {
      this._semaphore.release();
    }
  }

  // ════════════════════════════════════════════════════════
  // SHARED CALL-CONTEXT PREPARATION
  // ════════════════════════════════════════════════════════

  /**
   * Prepares the per-call routing context shared between chat() and streamChat().
   * v7.6.1 Track A #4: extracted from chat()/streamChat() to eliminate ~70 LOC
   * of structural duplication. Pre-extract, the two paths drifted multiple
   * times — v7.5.6 added MetaLearning to chat() but not streamChat() (silently
   * lost streaming-failure data); v7.5.9 B5 added noCache parity to streamChat;
   * v7.6.0 §4.1 added MetaLearning recommend to streamChat. Each fix was
   * symptomatic, none addressed the structural root cause. This method is
   * the root-cause fix.
   *
   * Resolves, in order:
   *   1. Temperature: this.temperatures[taskType] → options.temperature override
   *      → MetaLearning.recommend (non-chat tasks only, no override given)
   *   2. Auto-routing: ModelRouter.route(taskType) if enabled and not _userChat
   *      → routedSwitch with backend resolved from availableModels
   *   3. Role/Target/Effective: routedSwitch > roleOverride > activeBackend
   *      precedence chain. effectiveModel may be undefined (backend uses default).
   *   4. Priority: options.priority || (chat:10, otherwise:0)
   *
   * @param {{ taskType: string, options: object }} args
   * @returns {{ temp, routedSwitch, roleOverride, targetBackend, effectiveModel, calledModel, priority }}
   */
  _prepareCallContext({ taskType, options }) {
    // v7.8.6: thin orchestrator over four mixin helpers in ModelBridgeContext.js.
    const temp        = this._resolveTemperature(taskType, options);
    const routedSwitch = this._resolveRouting(taskType, options);
    const { targetBackend, effectiveModel, calledModel, roleOverride } =
      this._resolveBackendTarget(taskType, routedSwitch);
    const priority    = this._resolvePriority(taskType, options);
    return { temp, routedSwitch, roleOverride, targetBackend, effectiveModel, calledModel, priority };
  }

  // ════════════════════════════════════════════════════════
  // STRUCTURED OUTPUT (JSON mode)
  // ════════════════════════════════════════════════════════

  async chatStructured(systemPrompt, messages = [], taskType = 'analysis') {
    const enhancedPrompt = systemPrompt + '\n\nIMPORTANT: Respond ONLY with valid JSON. No explanatory text, no Markdown backticks, just the JSON object.';
    const raw = await this.chat(enhancedPrompt, messages, taskType);
    const parsed = this._robustJsonParse(raw);
    if (parsed !== null) return parsed;

    const fixPrompt = `The following was supposed to be JSON but is not valid JSON. Repair it. Respond ONLY with the repaired JSON:\n\n${raw.slice(0, 2000)}`;
    const fixRaw = await this.chat(fixPrompt, [], 'code');
    const fixParsed = this._robustJsonParse(fixRaw);
    if (fixParsed !== null) return fixParsed;

    return { _raw: raw, _parseError: true };
  }

  _robustJsonParse(text) {
    return robustJsonParse(text);
  }

  // ════════════════════════════════════════════════════════
  // DISPATCH & FAILOVER
  // ════════════════════════════════════════════════════════

  // v7.8.6: unified dispatch for chat and stream modes. Thin wrappers below
  // preserve positional signature for 5 v7xx source-presence contract tests.
  _dispatch({ mode, backendName, systemPrompt, messages, temp, modelOverride, maxTokens, onChunk, abortSignal, taskType }) {
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
  }

  /**
   * v7.8.9: route a code-generation call through ContinuationLoop.
   * Implementation lives in ModelBridgeContinuation.js (mixin) to keep
   * this file under the 700-LOC architectural-fitness soft-guard.
   * @private
   */
  // _dispatchChatWithContinuation — mixed in from ModelBridgeContinuation.js

  _dispatchChat(backendName, systemPrompt, messages, temp, modelOverride, maxTokens, taskType) {
    return this._dispatch({ mode: 'chat', backendName, systemPrompt, messages, temp, modelOverride, maxTokens, taskType });
  }

  _dispatchStream(backendName, systemPrompt, messages, onChunk, abortSignal, temp, modelOverride, maxTokens, taskType) {
    return this._dispatch({ mode: 'stream', backendName, systemPrompt, messages, temp, modelOverride, maxTokens, onChunk, abortSignal, taskType });
  }

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
  }

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
  }

  // ════════════════════════════════════════════════════════
  // PUBLIC UTILS
  // ════════════════════════════════════════════════════════

  getConcurrencyStats() {
    return this._semaphore.getStats();
  }

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

  /** @internal Called by Container.bootAll() */
  async asyncLoad() {
    await this.detectAvailable();

    if (this._settings) {
      if (this._settings.hasAnthropic()) {
        this.configureBackend('anthropic', { apiKey: this._settings.get('models.anthropicApiKey') });
        _log.info('  [+] Anthropic API configured');
      }
      if (this._settings.hasOpenAI()) {
        this.configureBackend('openai', {
          baseUrl: this._settings.get('models.openaiBaseUrl'),
          apiKey: this._settings.get('models.openaiApiKey'),
          models: this._settings.get('models.openaiModels') || [],
        });
        _log.info('  [+] OpenAI API configured');
      }
      // v5.1.0: Re-detect after configuring cloud backends (adds their models to list)
      if (this._settings.hasAnthropic() || this._settings.hasOpenAI()) {
        await this.detectAvailable();
      }
      // v5.1.0: Load per-task model roles
      const roles = this._settings.get('models.roles');
      if (roles) this.setRoles(roles);
    }
  }
}

// v7.5.6: Mix in availability methods (markUnavailable, isMarkedUnavailable,
// clearUnavailable, _loadUnavailable, _persistUnavailable). Same pattern as
// CommandHandlers' helper-mixin composition. Keeps ModelBridge.js under the
// architectural-fitness LOC limit.
// v7.6.5: Mix in failover helpers (_findFallbackBackend, _classifyFailoverReason,
// _emitFailoverUnavailable). Pure structural extraction for File-Size-Guard
// closeout — runtime semantics unchanged. See ModelBridgeFailover.js.
// v7.8.9: Mix in continuation pipeline (_dispatchChatWithContinuation).
// See ModelBridgeContinuation.js for the llm-resilience-v789 contract.
const { availability } = require('./ModelBridgeAvailability');
const { discovery } = require('./ModelBridgeDiscovery');
const { failoverMixin } = require('./ModelBridgeFailover');
const { contextMixin } = require('./ModelBridgeContext');
const { continuationMixin } = require('./ModelBridgeContinuation');
Object.assign(ModelBridge.prototype, availability, discovery, failoverMixin, contextMixin, continuationMixin);

module.exports = { ModelBridge };
