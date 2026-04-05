// @ts-checked-v5.7
// ============================================================
// GENESIS — WebFetcher.js (v4.0.0 — DNS-Pinning SSRF Defense)
//
// FIX v4.0.0: Two critical SSRF hardening upgrades:
//
// 1. DNS-PINNING via lookup hook:
//    Node's http.get() does its own DNS resolution AFTER our
//    hostname check. An attacker can register a domain that
//    first resolves to a public IP (passes our check) then
//    resolves to 127.0.0.1 during the actual connection
//    (DNS rebinding attack). Fix: intercept the DNS lookup
//    via http.request's `lookup` option and validate the
//    RESOLVED IP before the TCP connection is established.
//    This is the definitive defense — it operates at the
//    socket layer, not the application layer.
//
// 2. REDIRECT IP VALIDATION:
//    _doFetch() followed redirects without re-validating the
//    target URL against SSRF patterns. A public server could
//    redirect to http://127.0.0.1:11434/api/... (Ollama).
//    Fix: Every redirect URL passes through _validateUrl()
//    before following — same rules as the initial request.
// ============================================================

const http = require('http');
const { TIMEOUTS } = require('../core/Constants');
const https = require('https');
const dns = require('dns');
const { URL } = require('url');
const { NullBus } = require('../core/EventBus');
const { safeJsonParse } = require('../core/utils');
class WebFetcher {
  /** @param {{ bus?: object }} [opts] */
  constructor({ bus } = {}) {
    this.bus = bus || NullBus;
    this.maxSize = 512 * 1024;     // 512KB max response
    this.timeoutMs = 10000;         // 10s timeout
    this.maxRedirects = 3;
    this.requestCount = 0;
    this.maxRequestsPerMinute = 10;
    this.requestTimes = [];

    // Domains that are always blocked
    this.blockedDomains = [
      'localhost', '127.0.0.1', '0.0.0.0', '192.168.', '10.', '172.16.',
    ];

    // FIX v4.0.0: Comprehensive private IP patterns for SSRF protection
    // Covers IPv4, IPv6, decimal, hex, and mapped addresses
    this._privateIPPatterns = [
      /^127\./,                           // 127.0.0.0/8 loopback
      /^10\./,                            // 10.0.0.0/8 private
      /^172\.(1[6-9]|2[0-9]|3[01])\./,   // 172.16.0.0/12 private
      /^192\.168\./,                      // 192.168.0.0/16 private
      /^169\.254\./,                      // link-local
      /^0\./,                             // 0.0.0.0/8
      /^fc[0-9a-f]{2}:/i,                // IPv6 unique local
      /^fd[0-9a-f]{2}:/i,                // IPv6 unique local
      /^fe80:/i,                          // IPv6 link-local
      /^::1$/,                            // IPv6 loopback
      /^::$/,                             // IPv6 unspecified
      /^::ffff:127\./i,                   // IPv4-mapped loopback
      /^::ffff:10\./i,                    // IPv4-mapped private
      /^::ffff:192\.168\./i,              // IPv4-mapped private
      /^::ffff:172\.(1[6-9]|2[0-9]|3[01])\./i, // IPv4-mapped private
    ];

    // Domains Genesis can always access
    this.trustedDomains = [
      'npmjs.com', 'registry.npmjs.org', 'developer.mozilla.org',
      'nodejs.org', 'electronjs.org', 'github.com', 'raw.githubusercontent.com',
      'api.github.com', 'docs.python.org', 'httpbin.org',
      'jsonplaceholder.typicode.com', 'deno.land',
    ];
  }

  /**
   * Fetch a URL (GET only)
   * @param {string} url
   * @param {object} options - { headers, timeout, maxSize }
   * @returns {Promise<object>}
   */
  async fetch(url, options = {}) {
    // Rate limiting
    if (!this._checkRateLimit()) {
      return { ok: false, status: 429, body: '', headers: {}, error: 'Rate limit: max 10 Anfragen pro Minute' };
    }

    // FIX v4.0.0: Centralized URL validation (reused for redirects)
    const validation = this._validateUrl(url);
    // @ts-ignore — validation shape differs from success return
    if (!validation.ok) return validation;

    const timeout = options.timeout || this.timeoutMs;
    const maxSize = options.maxSize || this.maxSize;

    this.requestCount++;
    const parsed = validation.parsed;
    if (!parsed) return { ok: false, status: 0, body: '', headers: {}, error: 'URL parse failed' };
    this.bus.emit('web:fetch', { url: parsed.hostname + parsed.pathname }, { source: 'WebFetcher' });

    try {
      const result = await this._doFetch(parsed.href, timeout, maxSize, 0);
      return result;
    } catch (err) {
      return { ok: false, status: 0, body: '', headers: {}, error: err.message };
    }
  }

  // FIX v4.0.0: Centralized URL + hostname validation.
  // Called for initial request AND every redirect target.
  _validateUrl(url) {
    let parsed;
    try {
      parsed = new URL(url);
    } catch (err) {
      return { ok: false, status: 0, body: '', headers: {}, error: 'Ungueltige URL' };
    }

    const hostname = parsed.hostname.replace(/^\[|\]$/g, '');
    for (const blocked of this.blockedDomains) {
      if (hostname.includes(blocked)) {
        return { ok: false, status: 403, body: '', headers: {}, error: 'Access to local networks blocked' };
      }
    }
    if (this._isPrivateIP(hostname)) {
      return { ok: false, status: 403, body: '', headers: {}, error: 'Access to private IP addresses blocked' };
    }
    if (/^\d{8,}$/.test(hostname) || /^0x[0-9a-f]+$/i.test(hostname)) {
      return { ok: false, status: 403, body: '', headers: {}, error: 'Numeric IP formats blocked' };
    }
    if (!['http:', 'https:'].includes(parsed.protocol)) {
      return { ok: false, status: 0, body: '', headers: {}, error: 'Nur HTTP/HTTPS erlaubt' };
    }

    return { ok: true, parsed };
  }

  // FIX v4.0.0: Extracted from inline checks — single source of truth
  // for private/reserved IP detection.
  _isPrivateIP(ip) {
    for (const pattern of this._privateIPPatterns) {
      if (pattern.test(ip)) return true;
    }
    return false;
  }

  // FIX v4.0.0: DNS-pinning lookup function.
  // Passed to http.request({ lookup }) to intercept DNS resolution.
  // Validates the RESOLVED IP address before Node opens the socket.
  // This defeats DNS rebinding: the attacker's domain resolves to
  // 127.0.0.1, but we reject it AFTER resolution, BEFORE connection.
  _safeLookup(hostname, options, callback) {
    dns.lookup(hostname, options, (err, address, family) => {
      if (err) return callback(err);
      if (this._isPrivateIP(address)) {
        return callback(new Error(`DNS resolved ${hostname} to private IP ${address} — SSRF blocked`));
      }
      callback(null, address, family);
    });
  }

  /**
   * Fetch and extract text content (strip HTML tags)
   */
  async fetchText(url) {
    const result = await this.fetch(url);
    if (!result.ok) return result;

    // Strip HTML to get readable text
    result.body = this._stripHtml(result.body);
    // Trim to reasonable size for LLM context
    if (result.body.length > 8000) {
      result.body = result.body.slice(0, 8000) + '\n\n... (gekuerzt auf 8000 Zeichen)';
    }
    return result;
  }

  /**
   * Search npm for a package
   */
  async npmSearch(query) {
    const url = `https://registry.npmjs.org/-/v1/search?text=${encodeURIComponent(query)}&size=5`;
    const result = await this.fetch(url);
    if (!result.ok) return { error: result.error, packages: [] };

    const data = safeJsonParse(result.body, null, 'WebFetcher');
    if (!data) return { error: 'JSON parse failed', packages: [] };
    return {
      packages: (data.objects || []).map(o => ({
        name: o.package.name,
        version: o.package.version,
        description: o.package.description,
        author: o.package.author?.name || 'unknown',
      })),
    };
  }

  /**
   * Check if a URL is reachable (HEAD request basically)
   */
  async ping(url) {
    const result = await this.fetch(url, { maxSize: 1024, timeout: TIMEOUTS.GIT_OP });
    return { reachable: result.ok, status: result.status, error: result.error };
  }

  // ── Internal ─────────────────────────────────────────────

  _doFetch(url, timeout, maxSize, redirectCount) {
    return new Promise((resolve, reject) => {
      if (redirectCount > this.maxRedirects) {
        return reject(new Error('Zu viele Weiterleitungen'));
      }

      const client = url.startsWith('https') ? https : http;
      // FIX v4.0.0: DNS-pinning — validate resolved IP at socket level
      const reqOpts = {
        timeout,
        headers: { 'User-Agent': 'Genesis/1.1' },
        lookup: (hostname, options, cb) => this._safeLookup(hostname, options, cb),
      };
      const req = client.get(url, reqOpts, (res) => {
        // Handle redirects — FIX v4.0.0: validate redirect target
        if ([301, 302, 307, 308].includes(res.statusCode) && res.headers.location) {
          const newUrl = new URL(res.headers.location, url).href;
          const validation = this._validateUrl(newUrl);
          if (!validation.ok) {
            return resolve(validation); // Blocked redirect → return error response
          }
          return this._doFetch(newUrl, timeout, maxSize, redirectCount + 1).then(resolve).catch(reject);
        }

        const chunks = [];
        let totalSize = 0;

        res.on('data', (chunk) => {
          totalSize += chunk.length;
          if (totalSize > maxSize) {
            res.destroy();
            reject(new Error(`Antwort zu gross (>${Math.round(maxSize / 1024)}KB)`));
          }
          chunks.push(chunk);
        });

        res.on('end', () => {
          const body = Buffer.concat(chunks).toString('utf-8');
          resolve({
            ok: res.statusCode >= 200 && res.statusCode < 400,
            status: res.statusCode,
            body,
            headers: res.headers,
            error: null,
          });
        });

        res.on('error', (err) => reject(err));
      });

      req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
      req.on('error', (err) => reject(err));
    });
  }

  _stripHtml(html) {
    return html
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/<style[\s\S]*?<\/style>/gi, '')
      .replace(/<nav[\s\S]*?<\/nav>/gi, '')
      .replace(/<header[\s\S]*?<\/header>/gi, '')
      .replace(/<footer[\s\S]*?<\/footer>/gi, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/\s{2,}/g, ' ')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  _checkRateLimit() {
    const now = Date.now();
    this.requestTimes = this.requestTimes.filter(t => now - t < 60000);
    if (this.requestTimes.length >= this.maxRequestsPerMinute) return false;
    this.requestTimes.push(now);
    return true;
  }

  getStats() {
    return { totalRequests: this.requestCount, recentRequests: this.requestTimes.length };
  }
}

module.exports = { WebFetcher };
