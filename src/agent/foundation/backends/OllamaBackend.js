// @ts-checked-v5.7
// ============================================================
// GENESIS — backends/OllamaBackend.js (v4.10.0)
//
// Extracted from ModelBridge.js (v4.10.0, 854 LOC monolith).
// Handles all Ollama-specific communication:
//   - Model listing (GET /api/tags)
//   - Non-streaming chat (POST /api/chat, stream:false)
//   - Streaming chat (POST /api/chat, stream:true)
//
// Uses only http (local) — Ollama doesn't support HTTPS.
// ============================================================

const http = require('http');
const { TIMEOUTS } = require('../../core/Constants');
const { createLogger } = require('../../core/Logger');
const _log = createLogger('OllamaBackend');

class OllamaBackend {
  /** @param {{ baseUrl?: string, keepAlive?: string|number, localTimeoutMs?: number, cloudTimeoutMs?: number }} [opts] */
  constructor({ baseUrl, keepAlive, localTimeoutMs, cloudTimeoutMs } = {}) {
    // v7.9.37 pass 4 (C1/C2): real model context via /api/show (cached),
    // honest num_predict default. Config injected by the bridge (settings).
    this._ctxCache = new Map();           // modelName → context tokens
    this._ctxConfig = { numCtxCap: 65536, maxTokensDefault: 0 }; // 0 = derive from ctx
    this.name = 'Ollama';
    this.type = 'ollama';
    this.baseUrl = baseUrl || 'http://127.0.0.1:11434';
    // v7.5.7-fix Phase 2: keep_alive sent to Ollama with each chat call.
    // Default null = use Ollama's own default (5 minutes). Strings like
    // "5m", "1h", "30s" or numeric seconds are valid Ollama values.
    // 0 or "0" tells Ollama to immediately unload the model after the call.
    // Genesis uses unloadModel() to actively unload a model when switching.
    this.keepAlive = keepAlive == null ? null : keepAlive;
    // v7.5.9 Linux-fix: per-instance HTTP timeout. Slow machines (older
    // CPUs, no GPU) need more than 180s for first inference, especially
    // for 7B+ models. Settings: `llm.localTimeoutMs` (default
    // TIMEOUTS.LLM_RESPONSE_LOCAL = 180000ms = 180s).
    this.localTimeoutMs = (typeof localTimeoutMs === 'number' && localTimeoutMs > 0)
      ? localTimeoutMs
      : TIMEOUTS.LLM_RESPONSE_LOCAL;
    // v7.9.12: separate, longer timeout for Ollama-proxied cloud models
    // (name matches /[:-]cloud/). qwen3-vl:235b-cloud was field-traced
    // hitting the 180s LOCAL ceiling before its first chunk. Settings:
    // `llm.cloudTimeoutMs` (default TIMEOUTS.LLM_RESPONSE_CLOUD_OLLAMA = 300s).
    this.cloudTimeoutMs = (typeof cloudTimeoutMs === 'number' && cloudTimeoutMs > 0)
      ? cloudTimeoutMs
      : TIMEOUTS.LLM_RESPONSE_CLOUD_OLLAMA;
    // v7.8.9 (llm-resilience-v789 contract): override stack for keep_alive.
    // Used by ContinuationLoop to keep the model loaded between sequence
    // re-calls without permanently changing the user-configured value.
    // Stack semantics support concurrent sequences (each push/pop pair).
    this._keepAliveOverrides = [];
  }

  /**
   * v7.8.9: Effective keep_alive for the next outbound call.
   * Returns the topmost override if any are active, else the constructor value.
   */
  _effectiveKeepAlive() {
    if (this._keepAliveOverrides.length > 0) {
      return this._keepAliveOverrides[this._keepAliveOverrides.length - 1];
    }
    return this.keepAlive;
  }

  /**
   * v7.9.12: Cloud-model name detection. Mirrors ModelBridge's
   * _isCloudModelName regex — Ollama proxies both local and cloud models, so
   * the backend itself must distinguish them to pick the right HTTP timeout.
   * Kept as a local copy (3-line regex) rather than a cross-module dependency
   * on the ModelBridge availability mixin.
   * @param {string} modelName
   * @returns {boolean}
   */
  _isCloudModel(modelName) {
    return typeof modelName === 'string' && /[:-]cloud(\b|$)/i.test(modelName);
  }

  /**
   * v7.9.12: HTTP idle-timeout for a given model — cloud-suffixed models get
   * the longer cloudTimeoutMs, everything else the localTimeoutMs.
   * @param {string} modelName
   * @returns {number} timeout in ms
   */
  _timeoutForModel(modelName) {
    return this._isCloudModel(modelName) ? this.cloudTimeoutMs : this.localTimeoutMs;
  }

  /**
   * v7.8.9: Push a temporary keep_alive override (e.g., "15m" for the duration
   * of a continuation sequence). Returns a release function — call it when
   * the sequence ends to restore the previous value. Stack-based so parallel
   * sequences each push their own override.
   *
   * @param {string|number} value - Ollama-compatible keep_alive value
   * @returns {Function} release function
   */
  pushKeepAliveOverride(value) {
    this._keepAliveOverrides.push(value);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      // Remove most recent occurrence (stack discipline)
      const idx = this._keepAliveOverrides.lastIndexOf(value);
      if (idx >= 0) this._keepAliveOverrides.splice(idx, 1);
    };
  }

  /**
   * v7.5.7-fix Phase 2: Explicitly unload a model from Ollama's RAM.
   * Used when Genesis switches from one model to another so we don't keep
   * the previous one cached for 5min (Ollama default) while the new one
   * loads — that's when users see "two models in RAM" issues.
   * Implemented via POST /api/generate with empty prompt and keep_alive=0.
   * Best-effort: errors are swallowed (model might not be loaded).
   */
  async unloadModel(modelName) {
    if (!modelName) return false;
    try {
      await this._httpPost(`${this.baseUrl}/api/generate`, {
        model: modelName,
        prompt: '',
        keep_alive: 0,
      }, {}, 5000);
      return true;
    } catch (_err) {
      return false;
    }
  }

  /** Check if this backend is configured and usable */
  isConfigured() {
    return !!this.baseUrl;
  }

  /** List available models via GET /api/tags */
  async listModels() {
    const data = await this._httpGet(`${this.baseUrl}/api/tags`);
    return (data.models || []).map(m => ({
      name: m.name,
      backend: 'ollama',
      size: m.size,
      quantization: m.details?.quantization_level || 'unknown',
    }));
  }

  /** Non-streaming chat */
  /** v7.9.37 pass 4 (C1): bridge injects caps/defaults from settings. */
  setContextConfig({ numCtxCap, maxTokensDefault } = {}) {
    if (Number.isFinite(numCtxCap) && numCtxCap > 0) this._ctxConfig.numCtxCap = numCtxCap;
    if (Number.isFinite(maxTokensDefault)) this._ctxConfig.maxTokensDefault = maxTokensDefault;
  }

  /** POST /api/show — returns raw show payload or null (best-effort). */
  async _fetchShow(modelName) {
    try {
      return await this._httpPost(`${this.baseUrl}/api/show`, { model: modelName }, {}, 15000);
    } catch (_e) { return null; }
  }

  /**
   * v7.9.37 pass 4 (C1): effective num_ctx for a model. Truth source is
   * /api/show model_info["<family>.context_length"] (covers every model,
   * cloud included); fallback: a num_ctx line in `parameters`; last resort
   * the old 8192. Result capped by settings llm.numCtxCap and cached.
   * The field run 2026-07-10 showed 48k prompts sent with num_ctx:8192 —
   * the server truncated the head (identity included) on every large call.
   */
  async _ctxFor(modelName) {
    if (/embed|minilm/i.test(modelName)) return 2048; // trained-context guard (v7.9.3)
    if (this._ctxCache.has(modelName)) return this._ctxCache.get(modelName);
    let ctx = 0;
    const show = await this._fetchShow(modelName);
    if (show && show.model_info && typeof show.model_info === 'object') {
      for (const [k, v] of Object.entries(show.model_info)) {
        if (k.endsWith('.context_length') && Number.isFinite(v) && v > 0) { ctx = v; break; }
      }
    }
    if (!ctx && show && typeof show.parameters === 'string') {
      const m = show.parameters.match(/num_ctx\s+(\d+)/);
      if (m) ctx = parseInt(m[1], 10);
    }
    if (!ctx) ctx = 8192;
    ctx = Math.min(ctx, this._ctxConfig.numCtxCap);
    this._ctxCache.set(modelName, ctx);
    return ctx;
  }

  /** v7.9.37 pass 4 (C2): honest response budget instead of server roulette. */
  _predictFor(maxTokens, ctxSize) {
    if (typeof maxTokens === 'number' && maxTokens > 0) return maxTokens;
    if (this._ctxConfig.maxTokensDefault > 0) return this._ctxConfig.maxTokensDefault;
    return Math.min(8192, Math.floor(ctxSize / 4));
  }

  /**
   * v7.9.49: recover from a 402 by asking the same question with fewer knobs.
   *
   * A field run showed `ollama run kimi-k2.7-code:cloud` answering normally
   * while Genesis got HTTP 402 for the same model on the same daemon, with
   * plan usage at 0.5%. The only difference between the two requests is what
   * we add: `options.num_ctx` (up to 65536) and `options.num_predict`. num_ctx
   * was introduced in v7.9.37 for a LOCAL problem — Ollama defaults to 8192
   * and truncated the head of large prompts — and cloud endpoints manage their
   * own window.
   *
   * We do NOT assume that is the cause. We retry once without those two knobs
   * and log which shape failed and which worked, so the field answers the
   * question instead of a guess deciding it. Nothing changes for a request
   * that succeeds: this path is only ever entered on a 402.
   *
   * @param {Error} err
   * @param {object} body
   * @returns {object|null} a body worth retrying, or null
   */
  _retryBodyFor402(err, body) {
    const msg = String(err && err.message);
    if (!/\b402\b/.test(msg)) return null;
    // v7.9.49 pass 2: the field answered the question the first retry was built
    // to ask. It fired four times and the success line never followed — dropping
    // num_ctx/num_predict changes nothing, the model itself is extra-usage-only.
    // So the retry is skipped for exactly that answer and kept for a 402 whose
    // wording does NOT say so, where a knob may still be the cause. One measured
    // case closes one door; it does not close the others.
    if (/extra usage|not included (in )?(your )?plan/.test(msg.toLowerCase())) return null;
    const opts = body && body.options;
    if (!opts || (opts.num_ctx === undefined && opts.num_predict === undefined)) return null;
    const { num_ctx: _ctx, num_predict: _pred, ...rest } = opts;
    return { ...body, options: rest };
  }

  async chat(systemPrompt, messages, temperature, modelName, maxTokens) {
    const ollamaMessages = [];

    // FIX v4.0.0: Ollama requires at least one user message.
    // When no user messages exist, send systemPrompt as user message.
    if (messages.length === 0 && systemPrompt) {
      ollamaMessages.push({ role: 'user', content: systemPrompt });
    } else {
      if (systemPrompt) {
        ollamaMessages.push({ role: 'system', content: systemPrompt });
      }
      for (const m of messages) {
        ollamaMessages.push({ role: m.role, content: m.content }); if (m.images && Array.isArray(m.images) && m.images.length) { ollamaMessages[ollamaMessages.length - 1].images = m.images; } // v7.9.44 A: the eye \u2014 images travel with the message
      }
    }

    // v7.9.37 pass 4 (C1): real window via /api/show (see _ctxFor).
    const ctxSize = await this._ctxFor(modelName);
    const body = {
      model: modelName,
      messages: ollamaMessages,
      stream: false,
      options: {
        temperature,
        num_ctx: ctxSize,
        // v7.5.1 cap; v7.9.37 pass 4 (C2): always explicit — no server default.
        num_predict: this._predictFor(maxTokens, ctxSize),
      },
      // v7.5.7-fix Phase 2: respect configured keep_alive (null = Ollama default).
      // v7.8.9: route through _effectiveKeepAlive() so ContinuationLoop's
      // temporary overrides take precedence over the constructor value.
      ...((() => {
        const eff = this._effectiveKeepAlive();
        return eff != null ? { keep_alive: eff } : {};
      })()),
    };

    const data = await this._httpPost(
      `${this.baseUrl}/api/chat`, body, {},
      this._timeoutForModel(modelName)   // v7.9.12: cloud models get longer timeout
    ).catch(async (err) => {
      const retry = this._retryBodyFor402(err, body);
      if (!retry) throw err;
      _log.warn(`[OLLAMA] 402 for "${modelName}" with num_ctx=${body.options.num_ctx} — retrying without num_ctx/num_predict`);
      const second = await this._httpPost(
        `${this.baseUrl}/api/chat`, retry, {}, this._timeoutForModel(modelName)
      );
      _log.warn(`[OLLAMA] retry WITHOUT those options succeeded for "${modelName}" — the window hint, not the plan, was refused`);
      return second;
    });

    return data.message?.content || '';
  }

  /** Streaming chat — calls onChunk(text) for each token */
  async stream(systemPrompt, messages, onChunk, abortSignal, temperature, modelName, maxTokens, onDone) {
    // v7.8.9 (llm-resilience-v789 contract): optional `onDone(reason)` callback.
    // Called once with the terminal NDJSON chunk's `done_reason` value
    // ('stop' | 'length' | etc.) before the promise resolves. Backward-compatible:
    // callers that don't pass onDone see identical behavior to v7.8.8.
    const ollamaMessages = [];
    if (systemPrompt) {
      ollamaMessages.push({ role: 'system', content: systemPrompt });
    }
    for (const m of messages) {
      ollamaMessages.push({ role: m.role, content: m.content });
    }

    // v7.9.37 pass 4 (C1): same real-window resolution as chat().
    const ctxSize = await this._ctxFor(modelName);
    const body = {
      model: modelName,
      messages: ollamaMessages,
      stream: true,
      options: { temperature, num_ctx: ctxSize },
      // v7.5.7-fix Phase 2: respect configured keep_alive.
      // v7.8.9: route through _effectiveKeepAlive() for ContinuationLoop overrides.
      ...((() => {
        const eff = this._effectiveKeepAlive();
        return eff != null ? { keep_alive: eff } : {};
      })()),
    };
    body.options.num_predict = this._predictFor(maxTokens, ctxSize); // (C2)

    // v7.9.49: one attempt as a function, so a 402 can be retried with fewer
    // knobs. The retry is only safe because the status check below runs before
    // any chunk is emitted — guarded explicitly by _emitted all the same.
    let _emitted = 0;
    const attempt = (b) => new Promise((resolve, reject) => {
      const url = new URL(`${this.baseUrl}/api/chat`);
      const postData = JSON.stringify(b);
      let _settled = false;
      let _doneReason = null;
      const _resolve = () => {
        if (!_settled) {
          _settled = true;
          if (typeof onDone === 'function') {
            try { onDone(_doneReason); } catch (_e) { /* swallow callback errors */ }
          }
          resolve(undefined);
        }
      };
      const _reject = (err) => {
        if (!_settled) {
          _settled = true;
          if (typeof onDone === 'function') {
            try { onDone(_doneReason || 'error'); } catch (_e) { /* swallow */ }
          }
          reject(err);
        }
      };

      const req = http.request(
        {
          hostname: url.hostname,
          port: url.port,
          path: url.pathname,
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(postData),
          },
        },
        (res) => {
          if (res.statusCode >= 400) {
            let errBody = '';
            res.on('data', (chunk) => (errBody += chunk));
            res.on('end', () => _reject(new Error(`[OLLAMA] HTTP ${res.statusCode}: ${errBody.slice(0, 200)}`)));
            return;
          }

          let buffer = '';
          let _consecutiveParseErrors = 0;
          res.on('data', (chunk) => {
            if (abortSignal?.aborted) { req.destroy(); return; }
            buffer += chunk.toString();
            const lines = buffer.split('\n');
            buffer = lines.pop() || "";
            for (const line of lines) {
              if (!line.trim()) continue;
              try {
                const parsed = JSON.parse(line);
                _consecutiveParseErrors = 0;
                if (parsed.message?.content) { _emitted++; onChunk(parsed.message.content); } // v7.9.49: a retry must never duplicate output
                if (parsed.done) {
                  // v7.8.9: capture done_reason from terminal chunk
                  _doneReason = parsed.done_reason || 'stop';
                  _resolve();
                }
              } catch (_e) {
                _consecutiveParseErrors++;
                // FIX v4.12.7 (Audit-01): Warn on persistent parse failures
                if (_consecutiveParseErrors >= 3) {
                  _log.warn(`[STREAM] ${_consecutiveParseErrors} consecutive JSON parse errors — possible protocol mismatch`);
                }
              }
            }
          });
          res.on('end', _resolve);
          res.on('error', _reject);
        }
      );

      if (abortSignal) {
        abortSignal.addEventListener('abort', () => {
          // v7.8.9: mark abort reason so onDone sees it
          if (!_doneReason) _doneReason = 'abort';
          req.destroy();
          _resolve();
        }, { once: true });
      }

      const streamTimeoutMs = this._timeoutForModel(modelName);  // v7.9.12
      req.setTimeout(streamTimeoutMs, () => {
        if (!_doneReason) _doneReason = 'timeout';
        req.destroy();
        _reject(new Error(`[TIMEOUT] Ollama not responding (${Math.round(streamTimeoutMs / 1000)}s)`));
      });
      req.on('error', (err) => _reject(new Error(`[NETWORK] Ollama: ${err.message}`)));
      req.write(postData);
      req.end();
    });

    return attempt(body).catch(async (err) => {
      const retry = this._retryBodyFor402(err, body);
      if (!retry || _emitted > 0) throw err;
      _log.warn(`[OLLAMA] 402 for "${modelName}" with num_ctx=${body.options.num_ctx} — retrying without num_ctx/num_predict`);
      const out = await attempt(retry);
      _log.warn(`[OLLAMA] retry WITHOUT those options succeeded for "${modelName}" — the window hint, not the plan, was refused`);
      return out;
    });
  }

  // ── HTTP Helpers ─────────────────────────────────────────

  _httpGet(urlStr) {
    // v7.8.4: test-mode guard. When GENESIS_OFFLINE_TESTS=1 is set
    // (typically by the test runner), reject real HTTP calls so that
    // tests never accidentally hit a developer's running Ollama
    // daemon — previously this would trigger model loads in Ollama's
    // RAM during npm test, especially when the user's preferred model
    // failed over to a local model. Tests that need network behavior
    // must use MockBackend instead.
    if (process.env.GENESIS_OFFLINE_TESTS === '1') {
      return Promise.reject(new Error(
        'OllamaBackend: real HTTP calls disabled in test mode (GENESIS_OFFLINE_TESTS=1)'
      ));
    }
    return new Promise((resolve, reject) => {
      const url = new URL(urlStr);
      const req = http.get(url, (res) => {
        if (res.statusCode >= 400) {
          let errBody = '';
          res.on('data', (chunk) => (errBody += chunk));
          res.on('end', () => reject(new Error(`HTTP ${res.statusCode} from ${urlStr}: ${errBody.slice(0, 200)}`)));
          return;
        }
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => {
          try { resolve(JSON.parse(data)); }
          catch (_e) { _log.debug('[catch] JSON parse:', _e.message); reject(new Error(`Invalid JSON from ${urlStr}`)); }
        });
      }).on('error', reject);
      req.setTimeout(30000, () => { req.destroy(); reject(new Error(`[TIMEOUT] GET ${urlStr} (30s)`)); });
    });
  }

  _httpPost(urlStr, body, extraHeaders = {}, timeoutMs = 30000) {
    // v7.8.4: test-mode guard — see _httpGet above.
    if (process.env.GENESIS_OFFLINE_TESTS === '1') {
      return Promise.reject(new Error(
        'OllamaBackend: real HTTP calls disabled in test mode (GENESIS_OFFLINE_TESTS=1)'
      ));
    }
    return new Promise((resolve, reject) => {
      const url = new URL(urlStr);
      const postData = JSON.stringify(body);
      const req = http.request(
        {
          hostname: url.hostname, port: url.port, path: url.pathname, method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(postData), ...extraHeaders },
        },
        (res) => {
          if (res.statusCode >= 400) {
            let errBody = '';
            res.on('data', (chunk) => (errBody += chunk));
            res.on('end', () => reject(new Error(`HTTP ${res.statusCode} from ${urlStr}: ${errBody.slice(0, 200)}`)));
            return;
          }
          let data = '';
          res.on('data', (chunk) => (data += chunk));
          res.on('end', () => {
            try { resolve(JSON.parse(data)); }
            catch (_e) { _log.debug('[catch] JSON parse:', _e.message); reject(new Error(`Invalid JSON from ${urlStr}`)); }
          });
        }
      );
      req.setTimeout(timeoutMs, () => { req.destroy(); reject(new Error(`[TIMEOUT] POST ${urlStr} (${Math.round(timeoutMs / 1000)}s)`)); });
      req.on('error', reject);
      req.write(postData);
      req.end();
    });
  }
}

module.exports = { OllamaBackend };
