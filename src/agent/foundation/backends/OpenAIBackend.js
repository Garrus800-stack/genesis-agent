// @ts-checked-v5.7
// ============================================================
// GENESIS — backends/OpenAIBackend.js (v4.10.0)
//
// Extracted from ModelBridge.js (v4.10.0, 854 LOC monolith).
// Handles all OpenAI-compatible API communication:
//   - Non-streaming chat (POST /v1/chat/completions)
//   - Streaming chat (POST /v1/chat/completions, stream:true)
//
// Supports both HTTP and HTTPS (user-configurable baseUrl).
// ============================================================

const http = require('http');
const https = require('https');
const { TIMEOUTS } = require('../../core/Constants');
const { createLogger } = require('../../core/Logger');
const _log = createLogger('OpenAIBackend');

class OpenAIBackend {
  // @ts-ignore — genuine TS error, fix requires type widening
  constructor({ baseUrl, apiKey, models } = {}) {
    this.name = 'OpenAI-Compatible';
    this.type = 'openai';
    this.baseUrl = baseUrl || null;
    this.apiKey = apiKey || null;
    // v4.10.0: Configurable model list — supports any OpenAI-compatible API
    // (OpenAI, Azure, LM Studio, text-generation-webui, vLLM, etc.)
    this._models = models || [];
  }

  /** Check if this backend is configured and usable */
  isConfigured() {
    return !!(this.apiKey && this.baseUrl);
  }

  /** Configure API credentials */
  configure({ baseUrl, apiKey, models }) {
    if (baseUrl) this.baseUrl = baseUrl;
    if (apiKey) this.apiKey = apiKey;
    if (models) this._models = models;
  }

  /** Return available models when configured */
  getModels() {
    if (!this.isConfigured()) return [];
    if (this._models.length > 0) {
      return this._models.map(m => typeof m === 'string'
        ? { name: m, backend: 'openai', size: 0, quantization: 'cloud' }
        : { backend: 'openai', size: 0, quantization: 'cloud', ...m }
      );
    }
    return [
      { name: 'openai-default', backend: 'openai', size: 0, quantization: 'cloud' },
    ];
  }

  /** Non-streaming chat */
  async chat(systemPrompt, messages, temperature, modelName) {
    if (!this.baseUrl) throw new Error('OpenAI backend not configured');

    const body = {
      model: modelName,
      messages: [
        ...(systemPrompt ? [{ role: 'system', content: systemPrompt }] : []),
        ...messages,
      ],
      temperature,
    };

    const data = await this._httpPost(
      `${this.baseUrl}/v1/chat/completions`, body,
      { Authorization: `Bearer ${this.apiKey}` }
    );

    return data.choices?.[0]?.message?.content || '';
  }

  /** Streaming chat — calls onChunk(text) for each token */
  async stream(systemPrompt, messages, onChunk, abortSignal, temperature, modelName) {
    if (!this.baseUrl) throw new Error('OpenAI backend not configured');

    const body = {
      model: modelName,
      stream: true,
      messages: [
        ...(systemPrompt ? [{ role: 'system', content: systemPrompt }] : []),
        ...messages,
      ],
      temperature,
    };

    return new Promise((resolve, reject) => {
      const url = new URL(`${this.baseUrl}/v1/chat/completions`);
      const isHttps = url.protocol === 'https:';
      const client = isHttps ? https : http;
      const postData = JSON.stringify(body);
      let _settled = false;
      // @ts-ignore — genuine TS error, fix requires type widening
      const _resolve = () => { if (!_settled) { _settled = true; resolve(); } };
      const _reject = (err) => { if (!_settled) { _settled = true; reject(err); } };

      const req = client.request(
        {
          hostname: url.hostname,
          port: url.port || (isHttps ? 443 : 80),
          path: url.pathname,
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(postData),
            'Authorization': `Bearer ${this.apiKey}`,
          },
        },
        (res) => {
          if (res.statusCode >= 400) {
            let errBody = '';
            res.on('data', (chunk) => (errBody += chunk));
            res.on('end', () => _reject(new Error(`[OPENAI] HTTP ${res.statusCode}: ${errBody.slice(0, 200)}`)));
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
              if (!line.startsWith('data: ')) continue;
              const payload = line.slice(6).trim();
              if (payload === '[DONE]') { _resolve(); return; }
              try {
                const parsed = JSON.parse(payload);
                _consecutiveParseErrors = 0;
                const delta = parsed.choices?.[0]?.delta?.content;
                if (delta) onChunk(delta);
                if (parsed.choices?.[0]?.finish_reason) { _resolve(); return; }
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
      req.setTimeout(TIMEOUTS.LLM_RESPONSE_CLOUD, () => {
        req.destroy();
        _reject(new Error(`[TIMEOUT] OpenAI not responding (${Math.round(TIMEOUTS.LLM_RESPONSE_CLOUD / 1000)}s)`));
      });
      req.on('error', (err) => _reject(new Error(`[NETWORK] OpenAI: ${err.message}`)));
      req.write(postData);
      req.end();
    });
  }

  // ── HTTP Helper ──────────────────────────────────────────

  _httpPost(urlStr, body, extraHeaders = {}) {
    return new Promise((resolve, reject) => {
      const url = new URL(urlStr);
      const isHttps = url.protocol === 'https:';
      const client = isHttps ? https : http;
      const postData = JSON.stringify(body);
      const req = client.request(
        {
          hostname: url.hostname,
          port: url.port || (isHttps ? 443 : 80),
          path: url.pathname, method: 'POST',
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
      req.setTimeout(TIMEOUTS.LLM_RESPONSE_CLOUD, () => {
        req.destroy();
        reject(new Error(`[TIMEOUT] POST ${urlStr} (${Math.round(TIMEOUTS.LLM_RESPONSE_CLOUD / 1000)}s)`));
      });
      req.on('error', reject);
      req.write(postData);
      req.end();
    });
  }
}

module.exports = { OpenAIBackend };
