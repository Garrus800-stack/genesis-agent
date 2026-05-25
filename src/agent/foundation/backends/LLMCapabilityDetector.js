// ============================================================
// GENESIS — backends/LLMCapabilityDetector.js (v7.8.9)
//
// llm-resilience-v789 contract: detect whether a given Ollama
// model supports assistant-prefill continuation (trailing
// assistant message in messages[] makes the model continue
// from that text).
//
// Detection strategy (in order):
//   1. Fetch the model's template via GET /api/show.
//   2. If model has m.Config.Renderer set → 'special-renderer'
//      (no prefill, e.g. mllama, GlmOcr). Verification skipped.
//   3. Scan template:
//      - 'range .Messages' present → modern template (candidate)
//      - '.Prompt' / '.Response' style → legacy (no prefill)
//   4. For modern-template candidates: run a small verification
//      call with an unambiguous prefill marker. If the response
//      starts with the expected continuation (and does NOT
//      re-emit the prefill) → 'verified-prefill'. Else →
//      'verification-failed'.
//
// Status values (4 total):
//   - 'verified-prefill'        → use trailing-assistant continuation
//   - 'unverified-no-prefill'   → legacy template, use pseudo-continuation
//   - 'verification-failed'     → tried but inconclusive, pseudo-continuation
//   - 'special-renderer'        → custom renderer, pseudo-continuation
//
// Persistence:
//   Results cached to `.genesis/llm-capabilities.json` keyed by
//   model name. Each entry stores the digest (from /api/show) so
//   that a model update (different digest) invalidates the cache.
//   Lazy: only invoked when continuation is actually needed for
//   a model — no pre-emptive verification of every installed model.
//
// Non-goals:
//   - Does NOT verify Anthropic/OpenAI models (their continuation
//     is provider-specific; outside the scope of this layer).
//   - Does NOT cache failures forever — verification-failed entries
//     are retried on each new sequence so transient outages heal.
// ============================================================

'use strict';

const fs = require('fs');
const path = require('path');
const http = require('http');
const { createLogger } = require('../../core/Logger');

const _log = createLogger('LLMCapabilityDetector');

const VERIFICATION_TIMEOUT_MS = 15000;
const CAPABILITY_FILE = 'llm-capabilities.json';

// Verification prompt + expected prefill behavior. The prefill ends with
// 'ABRACADABRA-' (a clearly artificial token); a prefill-supporting model
// will continue with the next character (typically 'X1Y2Z3'-ish) without
// re-emitting 'ABRACADABRA'. A non-prefill model treats the trailing
// assistant as a user-visible quote and starts a new turn that re-emits
// or paraphrases the prefill text.
const VERIFICATION_SYSTEM = 'You are a precise echo. Complete the user message literally with no preamble.';
const VERIFICATION_USER   = 'Complete this exactly: ABRACADABRA-X1Y2Z3';
const VERIFICATION_PREFILL = 'ABRACADABRA-';

/**
 * @typedef {Object} CapabilityEntry
 * @property {'verified-prefill'|'unverified-no-prefill'|'verification-failed'|'special-renderer'} status
 * @property {string} template       - 'messages-loop' | 'prompt-response' | 'special-renderer' | 'unknown'
 * @property {string} digest         - Model digest from /api/show, for cache invalidation
 * @property {number} verifiedAt     - Unix ms timestamp
 */

class LLMCapabilityDetector {
  /**
   * @param {object} opts
   * @param {string} opts.baseUrl - Ollama base URL (e.g. http://127.0.0.1:11434)
   * @param {string} opts.genesisDir - Path to .genesis/ directory
   * @param {object} [opts.fetchImpl] - For tests: override low-level HTTP
   */
  constructor({ baseUrl, genesisDir, fetchImpl } = {}) {
    this.baseUrl = baseUrl || 'http://127.0.0.1:11434';
    this.genesisDir = genesisDir || null;
    this._fetchImpl = fetchImpl || null;
    /** @type {Map<string, CapabilityEntry>} */
    this._memCache = new Map();
    this._loaded = false;
  }

  /**
   * Detect or retrieve cached capability for a model.
   *
   * @param {string} modelName
   * @param {object} [opts]
   * @param {boolean} [opts.forceRefresh=false] - Skip cache, re-verify
   * @returns {Promise<CapabilityEntry>}
   */
  async detectCapability(modelName, opts = {}) {
    if (!modelName || typeof modelName !== 'string') {
      return this._makeEntry('verification-failed', 'unknown', '');
    }

    await this._ensureLoaded();

    // 1. /api/show to get template + digest
    let showData;
    try {
      showData = await this._fetchModelInfo(modelName);
    } catch (err) {
      _log.warn(`[CAPABILITY] /api/show failed for "${modelName}": ${err.message}`);
      return this._makeEntry('verification-failed', 'unknown', '');
    }

    const digest = showData.digest || '';
    const cached = this._memCache.get(modelName);
    const isCloudModel = /(?:^|[-:])cloud$/i.test(modelName);

    // 2. Use cache if digest matches and not forcing refresh.
    // EXCEPTION: cloud models cached as verified-prefill are stale from
    // the buggy probe-once-cache logic (v7.9.0 mid-cycle). Probe passed
    // but the real prefill request fails HTTP 500. Evict and re-classify.
    if (!opts.forceRefresh && cached && cached.digest === digest && cached.status !== 'verification-failed') {
      const isStaleCloudPrefill = isCloudModel && cached.status === 'verified-prefill';
      if (!isStaleCloudPrefill) {
        _log.debug(`[CAPABILITY] cache hit for "${modelName}" → ${cached.status}`);
        return cached;
      }
      _log.info(`[CAPABILITY] evicting stale cloud verified-prefill for "${modelName}" → re-classify as no-prefill`);
    }

    // 3. Renderer check (highest priority — overrides template scan)
    if (showData.hasRenderer) {
      const entry = this._makeEntry('special-renderer', 'special-renderer', digest);
      await this._persist(modelName, entry);
      _log.info(`[CAPABILITY] "${modelName}" uses special renderer → no prefill`);
      return entry;
    }

    // 4. Template scan
    const template = showData.template || '';
    const templateKind = this._classifyTemplate(template);

    if (templateKind === 'prompt-response') {
      const entry = this._makeEntry('unverified-no-prefill', 'prompt-response', digest);
      await this._persist(modelName, entry);
      _log.info(`[CAPABILITY] "${modelName}" has legacy .Prompt/.Response template → no prefill`);
      return entry;
    }

    if (templateKind === 'unknown') {
      const trimmed = String(template).trim();
      // Match `-cloud` or `:cloud` suffix (Ollama cloud naming convention,
      // e.g. `qwen3-vl:235b-cloud`, `gpt-oss:120b-cloud`).
      const isCloud = /(?:^|[-:])cloud$/i.test(modelName);
      if (isCloud) {
        // Cloud models accept SMALL prefill probes (HTTP 200) but reject
        // the LARGE prefill continuation calls that the actual code-gen
        // requires (HTTP 500 cascade, partial=0). The probe is therefore
        // misleading — it says "verified-prefill" and ContinuationLoop
        // then chooses the failing trailing-assistant prefill mode
        // instead of the working pseudo-continuation mode.
        // Conclusion: cloud is FIXED to unverified-no-prefill, no probe.
        // ContinuationLoop sees status != 'verified-prefill' and uses
        // pseudo-mode ("please continue"), which cloud accepts —
        // observed live as 22713 chars across 4 attempts on 2026-05-16.
        const entry = this._makeEntry('unverified-no-prefill', 'cloud', digest);
        await this._persist(modelName, entry);
        _log.info(`[CAPABILITY] "${modelName}" is a cloud model → no-prefill (pseudo-continuation only)`);
        return entry;
      }
      const entry = this._makeEntry('verification-failed', 'unknown', digest);
      await this._persist(modelName, entry);
      if (trimmed !== '') {
        const snippet = String(template).replace(/\s+/g, ' ').slice(0, 500);
        _log.warn(`[CAPABILITY] "${modelName}" has unrecognized template → treating as no-prefill`);
        _log.warn(`[CAPABILITY]   template-head[500]: ${snippet}`);
      } else {
        _log.warn(`[CAPABILITY] "${modelName}" has empty template → treating as no-prefill`);
      }
      return entry;
    }

    // 5. Modern template: run verification call
    _log.info(`[CAPABILITY] verifying prefill capability for "${modelName}"...`);
    const verified = await this._verifyPrefill(modelName);
    const status = verified ? 'verified-prefill' : 'verification-failed';
    const entry = this._makeEntry(status, 'messages-loop', digest);
    await this._persist(modelName, entry);
    _log.info(`[CAPABILITY] "${modelName}" → ${status}`);
    return entry;
  }

  // ── Internals ───────────────────────────────────────────

  _makeEntry(status, template, digest) {
    return { status, template, digest, verifiedAt: Date.now() };
  }

  _classifyTemplate(template) {
    if (!template || typeof template !== 'string') return 'unknown';
    // Modern Go template: `range` loop over .Messages.
    // Real-world template forms seen in /api/show output:
    //   {{- range .Messages }}
    //   {{- range $i, $_ := .Messages }}
    //   {{- range $idx, $msg := .Messages -}}
    //   {{ range .Messages }} (no whitespace trimming)
    // v7.9.0 fix: the v7.8.9 regex `[^.{}]*` between `range` and `.Messages`
    // failed against real-world Qwen3 templates because the actual text
    // sometimes had `{` of nested `{{}}` between `range` and `.Messages`.
    // v7.9.0 follow-up: widen window to 300 chars — qwen3-vl:235b-cloud
    // observed at 12:34/12:40 with template not detected at 100-char window.
    if (/range\b[\s\S]{0,300}?\.Messages\b/.test(template)) return 'messages-loop';
    // v7.9.0 follow-up: Jinja2 style `{% for ... in messages %}` —
    // some vendor cloud models ship Jinja-rendered templates instead of Go.
    if (/\{%\s*for\b[\s\S]{0,200}?\bin\s+messages\b/i.test(template)) return 'messages-loop';
    // Legacy: uses .Prompt and/or .Response variables
    if (/\.Prompt\b/.test(template) || /\.Response\b/.test(template)) return 'prompt-response';
    return 'unknown';
  }

  async _fetchModelInfo(modelName) {
    if (this._fetchImpl) {
      return this._fetchImpl({ baseUrl: this.baseUrl, modelName });
    }
    // v7.9.10: honor GENESIS_OFFLINE_TESTS like OllamaBackend does. Without
    // this, every bridge.chat() in tests triggers detectCapability →
    // _fetchModelInfo → http.request('localhost:11434/api/show'). When
    // Ollama is not running, req.setTimeout(VERIFICATION_TIMEOUT_MS=15000)
    // holds for 15 seconds before rejecting. A test like v752-fix that
    // makes ~10 chat() calls would block the test runner for up to 150s.
    // detectCapability already catches this error in its try/catch and
    // returns 'verification-failed' — exact same behaviour as a real
    // ECONNREFUSED, but 1ms instead of 15000ms.
    if (process.env.GENESIS_OFFLINE_TESTS === '1') {
      throw new Error(
        'LLMCapabilityDetector: real HTTP calls disabled in test mode (GENESIS_OFFLINE_TESTS=1)'
      );
    }
    return new Promise((resolve, reject) => {
      const url = new URL(`${this.baseUrl}/api/show`);
      const postData = JSON.stringify({ name: modelName });
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
          let body = '';
          res.on('data', (chunk) => (body += chunk));
          res.on('end', () => {
            if (res.statusCode >= 400) {
              reject(new Error(`HTTP ${res.statusCode}: ${body.slice(0, 200)}`));
              return;
            }
            try {
              const parsed = JSON.parse(body);
              resolve({
                template: parsed.template || '',
                digest: parsed.details?.digest || parsed.digest || '',
                hasRenderer: !!(parsed.config?.renderer || parsed.model_info?.renderer),
              });
            } catch (err) {
              reject(new Error(`invalid JSON from /api/show: ${err.message}`));
            }
          });
          res.on('error', reject);
        }
      );
      req.setTimeout(VERIFICATION_TIMEOUT_MS, () => {
        req.destroy();
        reject(new Error(`/api/show timeout after ${VERIFICATION_TIMEOUT_MS / 1000}s`));
      });
      req.on('error', reject);
      req.write(postData);
      req.end();
    });
  }

  /**
   * Run a small chat call with trailing-assistant prefill. Returns true if
   * the response continues from the prefill (no re-emission), false otherwise.
   */
  async _verifyPrefill(modelName) {
    if (this._fetchImpl) {
      return this._fetchImpl({
        baseUrl: this.baseUrl,
        modelName,
        verifyMessages: [
          { role: 'system', content: VERIFICATION_SYSTEM },
          { role: 'user', content: VERIFICATION_USER },
          { role: 'assistant', content: VERIFICATION_PREFILL },
        ],
      });
    }
    // v7.9.10: honor GENESIS_OFFLINE_TESTS (same as _fetchModelInfo above).
    // _verifyPrefill returns a Promise that resolves false on error, so
    // throwing from the caller's perspective is wrong — return false to
    // signal "prefill not verified". detectCapability treats that as the
    // unverified-no-prefill branch, which is the conservative default.
    if (process.env.GENESIS_OFFLINE_TESTS === '1') {
      return false;
    }
    return new Promise((resolve) => {
      const url = new URL(`${this.baseUrl}/api/chat`);
      const postData = JSON.stringify({
        model: modelName,
        messages: [
          { role: 'system', content: VERIFICATION_SYSTEM },
          { role: 'user', content: VERIFICATION_USER },
          { role: 'assistant', content: VERIFICATION_PREFILL },
        ],
        stream: false,
        options: { temperature: 0, num_predict: 30 },
      });
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
          let body = '';
          res.on('data', (chunk) => (body += chunk));
          res.on('end', () => {
            try {
              const parsed = JSON.parse(body);
              const content = (parsed.message?.content || '').trim();
              // Prefill works if the response does NOT start with 'ABRACADABRA'.
              // A non-prefill model would see the trailing assistant as a quote
              // and re-emit 'ABRACADABRA' (or paraphrase it) at the start of
              // its fresh assistant turn.
              const reEmitted = content.toUpperCase().startsWith('ABRACADABRA');
              resolve(!reEmitted && content.length > 0);
            } catch (_e) {
              resolve(false);
            }
          });
          res.on('error', () => resolve(false));
        }
      );
      req.setTimeout(VERIFICATION_TIMEOUT_MS, () => {
        req.destroy();
        resolve(false);
      });
      req.on('error', () => resolve(false));
      req.write(postData);
      req.end();
    });
  }

  // ── Persistence ─────────────────────────────────────────

  _capabilityFilePath() {
    if (!this.genesisDir) return null;
    return path.join(this.genesisDir, CAPABILITY_FILE);
  }

  async _ensureLoaded() {
    if (this._loaded) return;
    this._loaded = true;
    const fp = this._capabilityFilePath();
    if (!fp || !fs.existsSync(fp)) return;
    try {
      const raw = fs.readFileSync(fp, 'utf8');
      const obj = JSON.parse(raw);
      for (const [model, entry] of Object.entries(obj || {})) {
        if (entry && typeof entry.status === 'string') {
          this._memCache.set(model, entry);
        }
      }
      _log.debug(`[CAPABILITY] loaded ${this._memCache.size} cached entries from ${fp}`);
    } catch (err) {
      _log.warn(`[CAPABILITY] could not load capability cache: ${err.message}`);
    }
  }

  async _persist(modelName, entry) {
    this._memCache.set(modelName, entry);
    const fp = this._capabilityFilePath();
    if (!fp) return;
    try {
      const dir = path.dirname(fp);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      const out = {};
      for (const [k, v] of this._memCache.entries()) out[k] = v;
      fs.writeFileSync(fp, JSON.stringify(out, null, 2) + '\n', 'utf8');
    } catch (err) {
      _log.warn(`[CAPABILITY] could not persist cache: ${err.message}`);
    }
  }

  // ── Testing utilities ───────────────────────────────────

  /** For tests: get a cached entry without triggering detection. */
  _peek(modelName) {
    return this._memCache.get(modelName) || null;
  }

  /** For tests: classify a template string directly. */
  classifyTemplate(template) {
    return this._classifyTemplate(template);
  }
}

module.exports = {
  LLMCapabilityDetector,
  // Constants exported for tests
  VERIFICATION_TIMEOUT_MS,
  VERIFICATION_PREFILL,
};
