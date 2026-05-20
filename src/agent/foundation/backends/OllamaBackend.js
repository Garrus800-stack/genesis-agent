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
  /** @param {{ baseUrl?: string, keepAlive?: string|number, localTimeoutMs?: number }} [opts] */
  constructor({ baseUrl, keepAlive, localTimeoutMs } = {}) {
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
        ollamaMessages.push({ role: m.role, content: m.content });
      }
    }

    // v7.9.3: num_ctx is model-aware. Embedding/small-context models (nomic-
    // embed-text trained at 2048, all-minilm at 512) silently truncate when
    // sent 8192 and log [WARN] "requested context size too large for model".
    // For chat models 8192 stays the right default.
    const ctxSize = /embed|minilm/i.test(modelName) ? 2048 : 8192;
    const body = {
      model: modelName,
      messages: ollamaMessages,
      stream: false,
      options: {
        temperature,
        num_ctx: ctxSize,
        // v7.5.1: optional per-call max-token cap (used by dream/wakeup paths
        // for short one-word answers; saves cost on cloud-Ollama setups).
        ...(maxTokens ? { num_predict: maxTokens } : {}),
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
      this.localTimeoutMs
    );

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

    // v7.9.3: same model-aware num_ctx as chat() — see comment there.
    const ctxSize = /embed|minilm/i.test(modelName) ? 2048 : 8192;
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
    if (typeof maxTokens === 'number' && maxTokens > 0) body.options.num_predict = maxTokens;

    return new Promise((resolve, reject) => {
      const url = new URL(`${this.baseUrl}/api/chat`);
      const postData = JSON.stringify(body);
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
                if (parsed.message?.content) onChunk(parsed.message.content);
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

      req.setTimeout(this.localTimeoutMs, () => {
        if (!_doneReason) _doneReason = 'timeout';
        req.destroy();
        _reject(new Error(`[TIMEOUT] Ollama not responding (${Math.round(this.localTimeoutMs / 1000)}s)`));
      });
      req.on('error', (err) => _reject(new Error(`[NETWORK] Ollama: ${err.message}`)));
      req.write(postData);
      req.end();
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
