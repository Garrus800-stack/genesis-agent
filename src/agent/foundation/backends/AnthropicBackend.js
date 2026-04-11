// @ts-checked-v5.7
// ============================================================
// GENESIS — backends/AnthropicBackend.js (v4.10.0)
//
// Extracted from ModelBridge.js (v4.10.0, 854 LOC monolith).
// Handles all Anthropic-specific communication:
//   - Non-streaming chat (POST /v1/messages)
//   - Streaming chat (POST /v1/messages, stream:true)
//
// Uses HTTPS — Anthropic API is always remote.
// ============================================================

const https = require('https');
const { TIMEOUTS } = require('../../core/Constants');
const { createLogger } = require('../../core/Logger');
const _log = createLogger('AnthropicBackend');

class AnthropicBackend {
  /** @param {{ baseUrl?: string, apiKey?: string }} [options] */
  constructor({ baseUrl, apiKey } = {}) {
    this.name = 'Anthropic';
    this.type = 'anthropic';
    this.baseUrl = baseUrl || 'https://api.anthropic.com';
    this.apiKey = apiKey || null;
    this.defaultModel = 'claude-sonnet-4-20250514';
  }

  /** Check if this backend is configured and usable */
  isConfigured() {
    return !!this.apiKey;
  }

  /** Configure API credentials */
  configure({ baseUrl, apiKey }) {
    if (baseUrl) this.baseUrl = baseUrl;
    if (apiKey) this.apiKey = apiKey;
  }

  /** Return available models when configured */
  getModels() {
    if (!this.apiKey) return [];
    // v4.10.0: Expose full model lineup — user chooses via Settings or switchTo()
    return [
      { name: 'claude-sonnet-4-20250514', backend: 'anthropic', size: 0, quantization: 'cloud', tier: 'standard' },
      { name: 'claude-opus-4-20250514', backend: 'anthropic', size: 0, quantization: 'cloud', tier: 'premium' },
      { name: 'claude-haiku-4-5-20251001', backend: 'anthropic', size: 0, quantization: 'cloud', tier: 'fast' },
    ];
  }

  /** Non-streaming chat */
  async chat(systemPrompt, messages, temperature, modelName) {
    if (!this.apiKey) throw new Error('Anthropic API key not configured');

    const body = {
      model: modelName || this.defaultModel,
      max_tokens: 4096,
      system: systemPrompt || undefined,
      messages: messages.map(m => ({ role: m.role, content: m.content })),
      temperature,
    };

    const data = await this._httpPost(
      `${this.baseUrl}/v1/messages`, body,
      { 'x-api-key': this.apiKey, 'anthropic-version': '2023-06-01' }
    );

    return data.content?.map(c => c.text).join('') || '';
  }

  /** Streaming chat — calls onChunk(text) for each token */
  async stream(systemPrompt, messages, onChunk, abortSignal, temperature, modelName) {
    if (!this.apiKey) throw new Error('Anthropic API key not configured');

    const body = {
      model: modelName || this.defaultModel,
      max_tokens: 4096,
      stream: true,
      system: systemPrompt || undefined,
      messages: messages.map(m => ({ role: m.role, content: m.content })),
      temperature,
    };

    return new Promise((resolve, reject) => {
      const url = new URL(`${this.baseUrl}/v1/messages`);
      const postData = JSON.stringify(body);
      let _settled = false;
      const _resolve = /** @type {() => void} */ (() => { if (!_settled) { _settled = true; resolve(); } });
      const _reject = (err) => { if (!_settled) { _settled = true; reject(err); } };

      const req = https.request(
        {
          hostname: url.hostname,
          port: url.port || 443,
          path: url.pathname,
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(postData),
            'x-api-key': this.apiKey,
            'anthropic-version': '2023-06-01',
          },
        },
        (res) => {
          if (res.statusCode >= 400) {
            let errBody = '';
            res.on('data', (chunk) => (errBody += chunk));
            res.on('end', () => _reject(new Error(`[ANTHROPIC] HTTP ${res.statusCode}: ${errBody.slice(0, 200)}`)));
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
                if (parsed.type === 'content_block_delta' && parsed.delta?.text) onChunk(parsed.delta.text);
                if (parsed.type === 'message_stop') { _resolve(); return; }
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
        _reject(new Error(`[TIMEOUT] Anthropic not responding (${Math.round(TIMEOUTS.LLM_RESPONSE_CLOUD / 1000)}s)`));
      });
      req.on('error', (err) => _reject(new Error(`[NETWORK] Anthropic: ${err.message}`)));
      req.write(postData);
      req.end();
    });
  }

  // ── HTTP Helper ──────────────────────────────────────────

  _httpPost(urlStr, body, extraHeaders = {}) {
    return new Promise((resolve, reject) => {
      const url = new URL(urlStr);
      const postData = JSON.stringify(body);
      const req = https.request(
        {
          hostname: url.hostname, port: url.port || 443, path: url.pathname, method: 'POST',
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

module.exports = { AnthropicBackend };
