// @ts-checked-v5.8
// ============================================================
// GENESIS AGENT — ModelBridge.js (v4.10.0 — Backend Delegation)
//
// v4.10.0 REFACTOR: Backend implementations extracted to:
//   backends/OllamaBackend.js    — local LLM via Ollama
//   backends/AnthropicBackend.js — Anthropic Claude API
//   backends/OpenAIBackend.js    — OpenAI-compatible APIs
//
// ModelBridge is now purely orchestration:
//   - Backend routing (dispatch, failover)
//   - Concurrency (semaphore)
//   - Caching (LLMCache)
//   - MetaLearning integration
//   - Structured output (JSON mode)
//
// Previous: 854 LOC (3 backend implementations inline)
// Now:      ~350 LOC (orchestration only)
// ============================================================

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
  /** @param {{ bus?: *, maxConcurrentLLM?: number }} [deps] */
  constructor({ bus, maxConcurrentLLM } = {}) {
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
      // @ts-ignore — TS strict
      noCacheTaskTypes: ['chat', 'creative'],
    });

    // v4.10.0: Backend instances (replaces inline config objects)
    this.backends = {
      ollama: new OllamaBackend(),
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
  }

  /**
   * v5.1.0: Set per-task model roles from settings.
   * @param {{ chat?: string, code?: string, analysis?: string, creative?: string }} roles
   */
  setRoles(roles) {
    this._roles = roles || {};
    _log.info(`[MODEL] Roles updated: ${Object.entries(this._roles).filter(([,v]) => v).map(([k,v]) => `${k}→${v}`).join(', ') || 'all auto'}`);
  }

  /**
   * Resolve model+backend for a given task type.
   * Priority: role-assigned model → active model.
   * Returns { model, backend } or null if no override.
   */
  _resolveForTask(taskType) {
    const roleName = this._roles[taskType];
    if (!roleName) return null;
    const found = this.availableModels.find(m => m.name === roleName);
    if (!found) return null;
    return { model: found.name, backend: found.backend };
  }

  // ════════════════════════════════════════════════════════
  // MODEL MANAGEMENT
  // ════════════════════════════════════════════════════════

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
    if (this.availableModels.length > 0) {
      let chosen = null;

      // Priority 1: User-configured preferred model
      // @ts-ignore — TS strict
      const preferredName = this._settings?.get?.('models.preferred') || null;
      if (preferredName) {
        chosen = this.availableModels.find(m => m.name === preferredName);
        if (chosen) _log.info(`[MODEL] Using preferred model from settings: ${chosen.name}`);
      }

      // Priority 2: Cloud backends (configured = user actively chose them)
      if (!chosen) {
        chosen = this.availableModels.find(m => m.backend === 'anthropic')
              || this.availableModels.find(m => m.backend === 'openai');
        if (chosen) _log.info(`[MODEL] Auto-selected cloud model: ${chosen.name} (${chosen.backend})`);
      }

      // Priority 3: First local model
      if (!chosen) {
        chosen = this.availableModels[0];
        _log.info(`[MODEL] Using first available model: ${chosen.name} (${chosen.backend})`);
      }

      this.activeModel = chosen.name;
      this.activeBackend = chosen.backend;
    } else {
      this.bus.emit('model:no-models', {}, { source: 'ModelBridge' });
    }

    return this.availableModels;
  }

  async switchTo(modelName) {
    const model = this.availableModels.find(m => m.name === modelName);
    if (!model) throw new Error(`Model not found: ${modelName}`);
    this.activeModel = model.name;
    this.activeBackend = model.backend;
    return { ok: true, model: this.activeModel, backend: this.activeBackend };
  }

  configureBackend(backendName, { baseUrl, apiKey }) {
    const backend = this.backends[backendName];
    if (!backend) throw new Error(`Unknown backend: ${backendName}`);

    backend.configure({ baseUrl, apiKey });

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
  // ════════════════════════════════════════════════════════

  async chat(systemPrompt, messages = [], taskType = 'chat', options = {}) {
    let temp = this.temperatures[taskType] || this.temperatures.chat;

    // @ts-ignore — TS strict
    if (this.metaLearning && taskType !== 'chat') {
      try {
        // @ts-ignore — TS strict
        const rec = this.metaLearning.recommend(taskType, this.activeModel);
        if (rec && rec.temperature !== undefined) temp = rec.temperature;
      } catch (_e) { _log.debug('[catch] MetaLearning not ready:', _e.message); }
    }

    const cacheKey = options.noCache ? null : this._cache.buildKey(systemPrompt, messages, taskType);
    if (cacheKey) {
      const cached = this._cache.get(cacheKey);
      if (cached) return cached;
    }

    const priority = options.priority ?? (taskType === 'chat' ? 10 : 0);
    const startTime = Date.now();
    // v5.1.0: Role-based model dispatch — check if task has assigned model
    const roleOverride = this._resolveForTask(taskType);
    const targetBackend = roleOverride?.backend || this.activeBackend;
    await this._semaphore.acquire(priority);
    try {
      const result = await this._dispatchChat(targetBackend, systemPrompt, messages, temp, roleOverride?.model);
      this._recordMetaOutcome(taskType, temp, startTime, true, options);
      if (cacheKey) this._cache.set(cacheKey, result);
      return result;
    } catch (err) {
      const fallback = this._findFallbackBackend(targetBackend);
      if (fallback) {
        _log.warn(`[MODEL] ${targetBackend} failed, falling back to ${fallback}: ${err.message}`);
        this.bus.fire('model:failover', { from: targetBackend, to: fallback, error: err.message }, { source: 'ModelBridge' });
        const result = await this._dispatchChat(fallback, systemPrompt, messages, temp);
        this._recordMetaOutcome(taskType, temp, startTime, true, { ...options, failover: true });
        return result;
      }
      this._recordMetaOutcome(taskType, temp, startTime, false, options);
      throw err;
    } finally {
      this._semaphore.release();
    }
  }

  // ════════════════════════════════════════════════════════
  // STREAMING CHAT
  // ════════════════════════════════════════════════════════

  async streamChat(systemPrompt, messages = [], onChunk, abortSignal, taskType = 'chat', options = {}) {
    const temp = this.temperatures[taskType] || this.temperatures.chat;
    const priority = options.priority ?? (taskType === 'chat' ? 10 : 0);
    // v5.1.0: Role-based model dispatch
    const roleOverride = this._resolveForTask(taskType);
    const targetBackend = roleOverride?.backend || this.activeBackend;
    await this._semaphore.acquire(priority);
    try {
      return await this._dispatchStream(targetBackend, systemPrompt, messages, onChunk, abortSignal, temp, roleOverride?.model);
    } catch (err) {
      const fallback = this._findFallbackBackend(targetBackend);
      if (fallback) {
        _log.warn(`[MODEL] Stream ${targetBackend} failed, falling back to ${fallback}: ${err.message}`);
        this.bus.fire('model:failover', { from: targetBackend, to: fallback, error: err.message }, { source: 'ModelBridge' });
        return await this._dispatchStream(fallback, systemPrompt, messages, onChunk, abortSignal, temp);
      }
      throw err;
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

  _dispatchChat(backendName, systemPrompt, messages, temp, modelOverride) {
    const model = modelOverride || this._getModelForBackend(backendName);
    const backend = this.backends[backendName];
    if (!backend) throw new Error('No model backend configured');
    return backend.chat(systemPrompt, messages, temp, model);
  }

  _dispatchStream(backendName, systemPrompt, messages, onChunk, abortSignal, temp, modelOverride) {
    const model = modelOverride || this._getModelForBackend(backendName);
    const backend = this.backends[backendName];
    if (!backend) {
      return this._dispatchChat(backendName, systemPrompt, messages, temp, modelOverride)
        .then(result => { onChunk(result); return result; })
        .catch(err => {
          _log.error('[MODEL] Non-streaming fallback failed:', err.message);
          throw err;
        });
    }
    return backend.stream(systemPrompt, messages, onChunk, abortSignal, temp, model);
  }

  _findFallbackBackend(failedBackend) {
    // v5.1.0: Configurable fallback chain from settings
    // @ts-ignore — TS strict
    const chain = this._settings?.get?.('models.fallbackChain') || [];
    if (chain.length > 0) {
      for (const modelName of chain) {
        const model = this.availableModels.find(m => m.name === modelName);
        if (model && model.backend !== failedBackend) {
          // Switch to this model for the fallback
          this._fallbackModel = model;
          return model.backend;
        }
      }
    }
    // Default: try backends in priority order
    const order = ['ollama', 'anthropic', 'openai'];
    for (const b of order) {
      if (b === failedBackend) continue;
      if (b === 'ollama' && this.availableModels.some(m => m.backend === 'ollama')) return b;
      if (this.backends[b].isConfigured()) return b;
    }
    return null;
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

  _recordMetaOutcome(taskCategory, temperature, startTime, success, options = {}) {
    // @ts-ignore — TS strict
    if (!this.metaLearning) return;
    try {
      // @ts-ignore — TS strict
      this.metaLearning.recordOutcome({
        taskCategory,
        model: this.activeModel,
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

  /** @internal Called by Container.bootAll() */
  async asyncLoad() {
    await this.detectAvailable();

    // @ts-ignore — TS strict
    if (this._settings) {
      // @ts-ignore — TS strict
      if (this._settings.hasAnthropic()) {
        // @ts-ignore — TS strict
        this.configureBackend('anthropic', { apiKey: this._settings.get('models.anthropicApiKey') });
        _log.info('  [+] Anthropic API configured');
      }
      // @ts-ignore — TS strict
      if (this._settings.hasOpenAI()) {
        this.configureBackend('openai', {
          // @ts-ignore — TS strict
          baseUrl: this._settings.get('models.openaiBaseUrl'),
          // @ts-ignore — TS strict
          apiKey: this._settings.get('models.openaiApiKey'),
          // @ts-ignore — TS strict
          models: this._settings.get('models.openaiModels') || [],
        });
        _log.info('  [+] OpenAI API configured');
      }
      // v5.1.0: Re-detect after configuring cloud backends (adds their models to list)
      // @ts-ignore — TS strict
      if (this._settings.hasAnthropic() || this._settings.hasOpenAI()) {
        await this.detectAvailable();
      }
      // v5.1.0: Load per-task model roles
      // @ts-ignore — TS strict
      const roles = this._settings.get('models.roles');
      if (roles) this.setRoles(roles);
    }
  }
}

module.exports = { ModelBridge };
