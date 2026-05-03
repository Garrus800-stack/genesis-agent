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

  async detectAvailable() {
    // FIX v4.10.0: Remember current user selection before refreshing list
    const previousModel = this.activeModel;
    const previousBackend = this.activeBackend;

    this.availableModels = [];

    // Ollama (local)
    try {
      const ollamaModels = await this.backends.ollama.listModels();
      this.availableModels.push(...ollamaModels);
    } catch (err) {
      _log.info('[MODEL] Ollama not available');
      this.bus.emit('model:ollama-unavailable', { error: err.message }, { source: 'ModelBridge' });
    }

    // Add cloud models if configured
    this.availableModels.push(...this.backends.anthropic.getModels());
    this.availableModels.push(...this.backends.openai.getModels());

    // FIX v4.10.0: If a model was already active AND it still exists in the
    // refreshed list, keep it. This prevents the periodic health check from
    // resetting the user's manual model selection every 5 minutes.
    if (previousModel) {
      const stillExists = this.availableModels.find(m => m.name === previousModel);
      if (stillExists) {
        this.activeModel = previousModel;
        this.activeBackend = previousBackend;
        _log.debug(`[MODEL] Kept user-selected model: ${previousModel}`);
        return this.availableModels;
      }
      // Previously selected model disappeared (e.g. Ollama stopped) — fall through to re-select
      _log.info(`[MODEL] Previously selected model "${previousModel}" no longer available, re-selecting...`);
    }

    // Set default model — v4.10.0: Settings-based + smart priority
    // 1. User-configured preferred model (Settings → models.preferred)
    // 2. Cloud backends (higher capability) before local
    // 3. First available as last resort
    // v7.5.6: All priorities skip models that are currently marked
    // unavailable (auth/rate-limit/timeout). Prevents Genesis from
    // re-selecting a known-broken model on every boot/refresh.
    if (this.availableModels.length > 0) {
      let chosen = null;

      // Priority 1: User-configured preferred model
      const preferredName = this._settings?.get?.('models.preferred') || null;
      if (preferredName) {
        if (this.isMarkedUnavailable(preferredName)) {
          _log.warn(`[MODEL] Preferred "${preferredName}" is marked unavailable — auto-selecting`);
        } else {
          // Exact match first, then partial match (handles tag variations like :latest vs :cloud)
          chosen = this.availableModels.find(m => m.name === preferredName)
                || this.availableModels.find(m => m.name.startsWith(preferredName.split(':')[0]) && m.name.includes(preferredName.split(':')[1] || ''));
          if (chosen) {
            _log.info(`[MODEL] Using preferred model from settings: ${chosen.name}`);
            // v7.5.7-fix: warn if cloud-preferred without fallback-chain
            this._warnIfCloudWithoutFallback(chosen);
          } else {
            _log.warn(`[MODEL] Preferred model "${preferredName}" not found in ${this.availableModels.length} available models`);
          }
        }
      }

      // Priority 2: Cloud backends (configured = user actively chose them)
      if (!chosen) {
        chosen = this.availableModels.find(m => m.backend === 'anthropic' && !this.isMarkedUnavailable(m.name))
              || this.availableModels.find(m => m.backend === 'openai' && !this.isMarkedUnavailable(m.name));
        if (chosen) _log.info(`[MODEL] Auto-selected cloud model: ${chosen.name} (${chosen.backend})`);
      }

      // Priority 3: v6.0.5 — Smart model ranking by known capability
      // Instead of picking the first model Ollama returns (which is alphabetical
      // and often a weak model like minimax-m2.7), rank by known quality tiers.
      if (!chosen) {
        const eligible = this.availableModels.filter(m => !this.isMarkedUnavailable(m.name));
        chosen = this._selectBestModel(eligible);
        if (chosen) _log.info(`[MODEL] Auto-selected best available: ${chosen.name} (score: ${this._scoreModel(chosen.name)})`);
      }

      // Priority 4: Absolute fallback — first available (gefiltert; wenn alle markiert → letzter Resort)
      if (!chosen) {
        const eligible = this.availableModels.filter(m => !this.isMarkedUnavailable(m.name));
        chosen = eligible[0] || this.availableModels[0];
        _log.info(`[MODEL] Using first available model: ${chosen.name} (${chosen.backend})`);
      }

      this.activeModel = chosen.name;
      this.activeBackend = chosen.backend;
    } else {
      this.bus.emit('model:no-models', {}, { source: 'ModelBridge' });
    }

    return this.availableModels;
  }

  // ── v6.0.5: Smart Model Ranking ─────────────────────────
  // Models are scored by known capability tiers. This replaces
  // the blind "first available" selection that picked minimax-m2.7.
  //
  // Scoring: higher = better. Patterns matched against model name.
  // Unknown models get a neutral score (50) — never penalized.

  /** @type {Array<{pattern: RegExp, score: number, note: string}>} */
  static MODEL_TIERS = [
    // Tier 1: Known excellent code models (score 90-100)
    { pattern: /claude/i,                          score: 100, note: 'Anthropic Claude' },
    { pattern: /gpt-4o|gpt-4-turbo/i,             score: 95,  note: 'OpenAI GPT-4' },
    { pattern: /deepseek-coder|deepseek-v[23]/i,   score: 92,  note: 'DeepSeek Coder' },
    { pattern: /qwen-?2\.5.*(?:72|32|14)b/i,       score: 90,  note: 'Qwen 2.5 large' },
    { pattern: /qwen-?3.*coder/i,                  score: 90,  note: 'Qwen 3 Coder' },
    { pattern: /qwen-?3(?!.*vl).*(?:235|110|32)b/i, score: 89, note: 'Qwen 3 large' },
    { pattern: /kimi-k2/i,                         score: 88,  note: 'Kimi K2' },
    { pattern: /llama-?3.*(?:70|405)b/i,           score: 88,  note: 'Llama 3 large' },
    { pattern: /dolphin.*(?:70|405)b/i,            score: 87,  note: 'Dolphin large' },
    { pattern: /codellama|code-?llama/i,           score: 85,  note: 'Code Llama' },
    { pattern: /wizard.*coder/i,                   score: 85,  note: 'WizardCoder' },

    // Tier 2: Good general models (score 70-84)
    { pattern: /qwen-?2\.5.*(?:7b|3b)/i,          score: 80,  note: 'Qwen 2.5 medium' },
    { pattern: /qwen-?3(?!.*coder).*(?:8|14)b/i,  score: 80,  note: 'Qwen 3 medium' },
    { pattern: /llama-?3.*8b/i,                    score: 78,  note: 'Llama 3 8B' },
    { pattern: /llama-?3(?::latest)?$/i,           score: 78,  note: 'Llama 3' },
    { pattern: /dolphin.*(?:8b)/i,                 score: 77,  note: 'Dolphin 8B' },
    { pattern: /gemma-?2/i,                        score: 78,  note: 'Gemma 2' },
    { pattern: /mistral.*nemo/i,                   score: 76,  note: 'Mistral Nemo' },
    { pattern: /mistral(?::latest)?$/i,            score: 75,  note: 'Mistral' },
    { pattern: /mistral.*(?:7b)/i,                 score: 75,  note: 'Mistral 7B' },
    { pattern: /phi-?[34]/i,                       score: 75,  note: 'Microsoft Phi' },
    { pattern: /qwen-?3.*vl/i,                     score: 74,  note: 'Qwen 3 Vision (limited code)' },
    { pattern: /llama-?3\.2/i,                     score: 73,  note: 'Llama 3.2' },
    { pattern: /yi-/i,                             score: 72,  note: 'Yi' },
    { pattern: /command-r/i,                       score: 70,  note: 'Cohere Command-R' },
    { pattern: /glm-?4/i,                          score: 70,  note: 'GLM-4' },
    { pattern: /wizard.*(?:30|13)b/i,              score: 70,  note: 'Wizard large' },

    // Tier 3: Smaller / older models (score 40-69)
    { pattern: /qwen-?2\.5.*(?:1\.5|0\.5)b/i,     score: 60,  note: 'Qwen 2.5 small' },
    { pattern: /llama-?2/i,                        score: 55,  note: 'Llama 2 (older)' },
    { pattern: /vicuna|wizard(?!.*coder)/i,        score: 55,  note: 'Vicuna/Wizard' },
    { pattern: /gemma.*2b/i,                       score: 50,  note: 'Gemma 2B (small)' },
    { pattern: /tinyllama|phi-?2|orca-?mini|stablelm/i, score: 40, note: 'Tiny model' },

    // Tier 4: Known weak for code tasks (score 10-39)
    { pattern: /gpt-oss/i,                         score: 20,  note: 'GPT-OSS (unstable)' },
    { pattern: /minimax/i,                         score: 15,  note: 'MiniMax (weak at code)' },
  ];

  /**
   * Score a model by name. Unknown models get size-based scoring.
   * @param {string} name
   * @returns {number}
   */
  _scoreModel(name) {
    for (const tier of ModelBridge.MODEL_TIERS) {
      if (tier.pattern.test(name)) return tier.score;
    }
    // v6.0.5: Size-based fallback for unknown models.
    // Larger models are generally more capable — score by parameter count.
    const sizeMatch = name.match(/(\d+)b/i);
    if (sizeMatch) {
      const params = parseInt(sizeMatch[1], 10);
      if (params >= 70)  return 65; // Large unknown model — probably decent
      if (params >= 13)  return 55; // Medium unknown model
      if (params >= 7)   return 50; // Small-medium
      return 40;                     // Small unknown model
    }
    return 50; // No size info — neutral
  }

  /**
   * Select the best model from a list by score.
   * @param {Array<{name: string, backend: string}>} models
   * @returns {object|null}
   */
  _selectBestModel(models) {
    if (!models || models.length === 0) return null;
    let best = null;
    let bestScore = -1;
    for (const m of models) {
      const score = this._scoreModel(m.name);
      if (score > bestScore) {
        best = m;
        bestScore = score;
      }
    }
    return best;
  }

  /**
   * Get a ranked list of available models with scores.
   * @returns {Array<{name: string, backend: string, score: number, note: string}>}
   */
  getRankedModels() {
    return this.availableModels
      .map(m => {
        const score = this._scoreModel(m.name);
        const tier = ModelBridge.MODEL_TIERS.find(t => t.pattern.test(m.name));
        return { ...m, score, note: tier?.note || 'Unknown model', active: m.name === this.activeModel };
      })
      .sort((a, b) => b.score - a.score);
  }

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
Object.assign(ModelBridge.prototype, availability);

module.exports = { ModelBridge };
