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

// v7.5.2: Alias-Map normalisiert Caller-taskTypes auf Router-Routes.
// Ohne diese Aliase würden Dream/Wakeup/Memory-Pfade auf chat-Route fallback
// und nie wirklich geroutet — genau die wären aber Hauptzielgruppe für Auto-Routing.
const TASK_TYPE_ROUTING_MAP = {
  'code':            'code-gen',
  'dream-judgment':  'classification',
  'dream-summarize': 'summarization',
  'memory-classify': 'classification',
  'wakeup':          'reasoning',
  // 'user' bleibt unrouted (siehe _userChat-Marker in ChatOrchestrator)
};

// v7.5.6/v7.5.7-fix: TTL by failover-reason for the unavailable-marker.
// 'connection-error' and 'other' are intentionally absent (transient).
// 'subscription-required' (v7.5.7-fix): 24h, Pro-gates don't fix in 1h.
const UNAVAILABLE_TTL_MAP = {
  'auth':                  60 * 60 * 1000,         // 1h
  'rate-limit':              5 * 60 * 1000,        // 5min
  'timeout':                10 * 60 * 1000,        // 10min
  'subscription-required': 24 * 60 * 60 * 1000,    // 24h
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
  /** @param {{ bus?: *, maxConcurrentLLM?: number, genesisDir?: string, ollamaKeepAlive?: string|number|null }} [deps] */
  constructor({ bus, maxConcurrentLLM, genesisDir, ollamaKeepAlive } = {}) {
    this.bus = bus || NullBus;
    this.activeModel = null;
    this.activeBackend = null;
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
      ollama: new OllamaBackend({ keepAlive: ollamaKeepAlive == null ? null : ollamaKeepAlive }),
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
      _log.warn(`[MODEL] ${label} ${targetBackend} failed, falling back to ${fallback}: ${err.message}`);
      this.bus.fire('model:failover', { from: targetBackend, to: fallback, error: err.message, reason }, { source: 'ModelBridge' });
      const result = await dispatch(fallback);
      this._recordMetaOutcome(taskType, temp, startTime, true, { ...options, failover: true }, fallbackModelName);
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

    let temp = this.temperatures[taskType] || this.temperatures.chat;

    // v7.5.1: per-call temperature override (used by dream/wakeup paths)
    if (typeof options.temperature === 'number') temp = options.temperature;

    if (this.metaLearning && taskType !== 'chat' && options.temperature === undefined) {
      try {
        const rec = this.metaLearning.recommend(taskType, this.activeModel);
        if (rec && rec.temperature !== undefined) temp = rec.temperature;
      } catch (_e) { _log.debug('[catch] MetaLearning not ready:', _e.message); }
    }

    // v7.5.2: optional auto-routing for background tasks (per-call modelOverride pattern)
    let routedSwitch = null;
    if (
      this._settings?.get?.('agency.autoRouteByTask') !== false &&
      this._modelRouter &&
      taskType &&
      options._userChat !== true   // direct user chat NEVER auto-routed
    ) {
      try {
        const routerCategory = TASK_TYPE_ROUTING_MAP[taskType] || taskType;
        const routed = this._modelRouter.route(routerCategory);
        if (routed?.model && routed.model !== this.activeModel) {
          // Resolve backend for routed model. Without this, routing in
          // multi-backend setups (Ollama local + Anthropic cloud) would send
          // routed-model to wrong backend → 404. Backend lives in availableModels[].
          const found = this.availableModels.find(m => m.name === routed.model);
          if (found?.backend) {
            routedSwitch = {
              originalModel: this.activeModel,
              routedModel: routed.model,
              routedBackend: found.backend,
              taskType,
              reason: routed.reason,
            };
            this._routingStats.autoRouted++;
            this._routingStats.lastRouted = { ...routedSwitch, at: Date.now() };
            this.bus.emit('model:auto-switched', routedSwitch, { source: 'ModelBridge' });
          }
          // If model exists in router but not in availableModels, silently abandon
          // routing — fall through to activeModel/activeBackend.
        }
      } catch (_e) {
        // Router error → silent fallback to activeModel, no crash
      }
    }

    // v7.5.2: when auto-routed, bypass cache because cache-key has no model.
    // Otherwise a code-gen request might return a cached chat-model result.
    const cacheKey = (options.noCache || routedSwitch)
      ? null
      : this._cache.buildKey(systemPrompt, messages, taskType);
    if (cacheKey) {
      const cached = this._cache.get(cacheKey);
      if (cached) return cached;
    }

    const priority = options.priority ?? (taskType === 'chat' ? 10 : 0);
    const startTime = Date.now();
    // v5.1.0: Role-based model dispatch - check if task has assigned model
    // v7.5.2: Priority routedSwitch > roleOverride > activeBackend.
    // Begründung: agency.autoRouteByTask ist eine *explizite* User-Setting.
    // Wenn an, gewinnt sie über Roles. Wer Auto-Routing nicht will: Setting=false.
    const roleOverride = this._resolveForTask(taskType);
    const targetBackend = routedSwitch?.routedBackend
                       || roleOverride?.backend
                       || this.activeBackend;
    const effectiveModel = routedSwitch?.routedModel
                        || roleOverride?.model;  // undefined → backend uses activeModel
    // v7.5.6: track which model was actually called, so we can mark
    // it unavailable in the catch-block and skip it in failover.
    const calledModel = effectiveModel || this.activeModel;
    await this._semaphore.acquire(priority);
    try {
      const result = await this._dispatchChat(targetBackend, systemPrompt, messages, temp, effectiveModel, options.maxTokens);
      this._recordMetaOutcome(taskType, temp, startTime, true, options, calledModel);
      if (cacheKey) this._cache.set(cacheKey, result);
      return result;
    } catch (err) {
      return this._handleFailoverError(err, {
        taskType, temp, startTime, options, calledModel, targetBackend, label: '',
        dispatch: (backend) => this._dispatchChat(backend, systemPrompt, messages, temp, undefined, options.maxTokens),
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
        ...(arg._userChat   !== undefined ? { _userChat:   arg._userChat   } : {}),  // v7.5.2
      };
    }

    let temp = this.temperatures[taskType] || this.temperatures.chat;
    // v7.5.1.x: per-call temperature override (parity with chat()).
    if (typeof options.temperature === 'number') temp = options.temperature;
    const maxTokens = (typeof options.maxTokens === 'number' && options.maxTokens > 0)
      ? options.maxTokens
      : undefined;

    // v7.5.2: optional auto-routing for background tasks (parity with chat())
    let routedSwitch = null;
    if (
      this._settings?.get?.('agency.autoRouteByTask') !== false &&
      this._modelRouter &&
      taskType &&
      options._userChat !== true
    ) {
      try {
        const routerCategory = TASK_TYPE_ROUTING_MAP[taskType] || taskType;
        const routed = this._modelRouter.route(routerCategory);
        if (routed?.model && routed.model !== this.activeModel) {
          const found = this.availableModels.find(m => m.name === routed.model);
          if (found?.backend) {
            routedSwitch = {
              originalModel: this.activeModel,
              routedModel: routed.model,
              routedBackend: found.backend,
              taskType,
              reason: routed.reason,
            };
            this._routingStats.autoRouted++;
            this._routingStats.lastRouted = { ...routedSwitch, at: Date.now() };
            this.bus.emit('model:auto-switched', routedSwitch, { source: 'ModelBridge' });
          }
        }
      } catch (_e) { /* silent fallback */ }
    }

    const priority = options.priority ?? (taskType === 'chat' ? 10 : 0);
    // v5.1.0: Role-based model dispatch
    // v7.5.2: routedSwitch > roleOverride > activeBackend (parity with chat())
    const roleOverride = this._resolveForTask(taskType);
    const targetBackend = routedSwitch?.routedBackend
                       || roleOverride?.backend
                       || this.activeBackend;
    const effectiveModel = routedSwitch?.routedModel
                        || roleOverride?.model;
    // v7.5.6: track which model was actually called
    const calledModel = effectiveModel || this.activeModel;
    // v7.5.6: streamChat now feeds MetaLearning too — pre-v7.5.6 only chat()
    // recorded outcomes, so streaming-failure rates were invisible to the
    // learner. Same calledModel/fallbackModelName attribution as chat().
    const startTime = Date.now();
    await this._semaphore.acquire(priority);
    try {
      const result = await this._dispatchStream(targetBackend, systemPrompt, messages, onChunk, abortSignal, temp, effectiveModel, maxTokens);
      this._recordMetaOutcome(taskType, temp, startTime, true, options, calledModel);
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

  _dispatchChat(backendName, systemPrompt, messages, temp, modelOverride, maxTokens) {
    const model = modelOverride || this._getModelForBackend(backendName);
    const backend = this.backends[backendName];
    if (!backend) throw new Error('No model backend configured');
    // v7.5.1: backends accept an optional 5th maxTokens arg. Older backends
    // ignoring it still work because JS just drops extra positional args.
    return backend.chat(systemPrompt, messages, temp, model, maxTokens);
  }

  _dispatchStream(backendName, systemPrompt, messages, onChunk, abortSignal, temp, modelOverride, maxTokens) {
    const model = modelOverride || this._getModelForBackend(backendName);
    const backend = this.backends[backendName];
    if (!backend) {
      // v7.5.1.x: forward maxTokens to the non-streaming fallback so streaming
      // callers' per-call cap is respected even when a backend lacks .stream().
      return this._dispatchChat(backendName, systemPrompt, messages, temp, modelOverride, maxTokens)
        .then(result => { onChunk(result); return result; })
        .catch(err => {
          _log.error('[MODEL] Non-streaming fallback failed:', err.message);
          throw err;
        });
    }
    return backend.stream(systemPrompt, messages, onChunk, abortSignal, temp, model, maxTokens);
  }

  /**
   * v5.1.0: Configurable fallback chain from settings.
   * v7.5.6: Same-backend fallback enabled. Skip the specific failed model
   * (not the entire backend) and any model marked unavailable. The cross-backend
   * escape hatch (ollama→anthropic→openai) remains as a last resort when the
   * chain is exhausted or empty.
   *
   * @param {string} failedBackend
   * @param {string|null} [failedModelName] — exact name of the model that just
   *   failed. When provided, that single model is skipped in the chain (instead
   *   of the entire backend, which made the chain useless when all configured
   *   fallbacks shared one backend with the primary).
   */
  _findFallbackBackend(failedBackend, failedModelName = null) {
    const chain = this._settings?.get?.('models.fallbackChain') || [];
    for (const modelName of chain) {
      if (modelName === failedModelName) continue;
      if (this.isMarkedUnavailable(modelName)) continue;
      const model = this.availableModels.find(m => m.name === modelName);
      if (model) {
        this._fallbackModel = model;
        return model.backend;
      }
    }
    // Cross-backend escape: try other backends in priority order
    const order = ['ollama', 'anthropic', 'openai'];
    for (const b of order) {
      if (b === failedBackend) continue;
      if (b === 'ollama' && this.availableModels.some(m =>
        m.backend === 'ollama' && !this.isMarkedUnavailable(m.name)
      )) return b;
      if (this.backends[b].isConfigured()) return b;
    }
    return null;
  }

  // v7.4.8: classify failover errors into structured categories so
  // consumers (dashboard, CostStream later, MetaLearning) can aggregate
  // without string-matching err.message themselves.
  _classifyFailoverReason(err) {
    const msg = (err?.message || '').toLowerCase();
    // v7.5.7-fix: subscription checked before generic 401/403 'auth'
    // — Ollama Cloud Pro-gates carry both. Without this, gated cloud
    // models would get the 1h auth-TTL not the 24h subscription-TTL.
    if (/subscription|requires.*upgrade|upgrade for access|ollama\.com\/upgrade/.test(msg)) return 'subscription-required';
    if (/rate.?limit|429|too many/.test(msg)) return 'rate-limit';
    if (/timeout|timed out|etimedout/.test(msg)) return 'timeout';
    if (/econnrefused|enotfound|eai_again|network|socket hang up|fetch failed/.test(msg)) return 'connection-error';
    if (/401|403|unauthor|invalid.*key|api.?key/.test(msg)) return 'auth';
    return 'other';
  }

  // ── v7.5.6: Model-availability tracking — extracted to mixin ─────
  // Methods mixed in: markUnavailable, isMarkedUnavailable,
  // clearUnavailable, _loadUnavailable, _persistUnavailable,
  // _isCloudModelName, _warnIfCloudWithoutFallback.

  // v7.4.8: emitted when _findFallbackBackend returns null. Closes the
  // observability gap — without this event, "Genesis tried to failover
  // but had nothing to switch to" was invisible in EventStore.
  _emitFailoverUnavailable(failedBackend, err) {
    const chain = this._settings?.get?.('models.fallbackChain') || [];
    const reason = chain.length === 0
      ? 'no-chain-configured'
      : 'all-other-backends-unavailable';
    this.bus.fire('model:failover-unavailable', {
      from: failedBackend,
      reason,
      error: err.message,
    }, { source: 'ModelBridge' });
  }

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
const { availability } = require('./ModelBridgeAvailability');
const { discovery } = require('./ModelBridgeDiscovery');
Object.assign(ModelBridge.prototype, availability, discovery);

module.exports = { ModelBridge };
