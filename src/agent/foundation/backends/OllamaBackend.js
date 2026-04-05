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
  /** @param {{ baseUrl?: string }} [opts] */
  constructor({ baseUrl } = {}) {
    this.name = 'Ollama';
    this.type = 'ollama';
    this.baseUrl = baseUrl || 'http://127.0.0.1:11434';
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
  async chat(systemPrompt, messages, temperature, modelName) {
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

    const body = {
      model: modelName,
      messages: ollamaMessages,
      stream: false,
      options: { temperature, num_ctx: 8192 },
    };

    const data = await this._httpPost(
      `${this.baseUrl}/api/chat`, body, {},
      TIMEOUTS.LLM_RESPONSE_LOCAL
    );

    return data.message?.content || '';
  }

  /** Streaming chat — calls onChunk(text) for each token */
  async stream(systemPrompt, messages, onChunk, abortSignal, temperature, modelName) {
    const ollamaMessages = [];
    if (systemPrompt) {
      ollamaMessages.push({ role: 'system', content: systemPrompt });
    }
    for (const m of messages) {
      ollamaMessages.push({ role: m.role, content: m.content });
    }

    const body = {
      model: modelName,
      messages: ollamaMessages,
      stream: true,
      options: { temperature, num_ctx: 8192 },
    };

      // @ts-ignore — resolve() without args is intentional
    // @ts-ignore — resolve() called without args intentionally
    return new Promise((resolve, reject) => {
      // @ts-ignore — resolve() without args is intentional
      const url = new URL(`${this.baseUrl}/api/chat`);
      const postData = JSON.stringify(body);
      let _settled = false;
      const _resolve = () => { if (!_settled) { _settled = true; resolve(undefined); } };
      const _reject = (err) => { if (!_settled) { _settled = true; reject(err); } };

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
                if (parsed.done) _resolve();
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
        abortSignal.addEventListener('abort', () => { req.destroy(); _resolve(); }, { once: true });
      }

      req.setTimeout(TIMEOUTS.LLM_RESPONSE_LOCAL, () => {
        req.destroy();
        _reject(new Error(`[TIMEOUT] Ollama not responding (${Math.round(TIMEOUTS.LLM_RESPONSE_LOCAL / 1000)}s)`));
      });
      req.on('error', (err) => _reject(new Error(`[NETWORK] Ollama: ${err.message}`)));
      req.write(postData);
      req.end();
    });
  }

  // ── HTTP Helpers ─────────────────────────────────────────

  _httpGet(urlStr) {
    // @ts-ignore — resolve() called without args intentionally
    return new Promise((resolve, reject) => {
      // @ts-ignore — resolve() without args is intentional
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
    // @ts-ignore — resolve() called without args intentionally
    return new Promise((resolve, reject) => {
      // @ts-ignore — resolve() without args is intentional
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
