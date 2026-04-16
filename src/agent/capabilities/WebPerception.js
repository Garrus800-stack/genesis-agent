// @ts-checked-v5.8
// ============================================================
// GENESIS — WebPerception.js (Phase 11 — Extended Agency)
//
// PROBLEM: DesktopPerception sees files, Git, Ollama, system.
// That's a tiny slice of the world. Genesis can't browse the
// web, check API docs, read GitHub issues, or monitor services.
//
// SOLUTION: A perception module that fetches and parses web
// content. Two modes:
//
//   1. LIGHTWEIGHT (default) — HTTP fetch + cheerio parsing.
//      No browser needed. Works for APIs, docs, static pages.
//
//   2. HEADLESS (optional) — Puppeteer for JS-rendered pages.
//      Falls back to lightweight if Puppeteer isn't installed.
//
// Perception feeds into WorldState.external and provides
// searchable context for PromptBuilder.
//
// Integration:
//   IdleMind RESEARCH activity → WebPerception.fetch(url)
//   AgentLoop SEARCH step      → WebPerception.search(query)
//   WorldState.external        → cached web data
//   ContextManager             → web context for prompts
// ============================================================

const http = require('http');
const { TIMEOUTS } = require('../core/Constants');
const https = require('https');
const { URL } = require('url');
const { NullBus } = require('../core/EventBus');

// Try to load cheerio for HTML parsing (optional dep)
let cheerio = null;
try { cheerio = require('cheerio'); } catch (_e) { console.debug('[catch] will use regex fallback:', _e.message); }

// Puppeteer is fully optional
let puppeteer = null;
try { puppeteer = require('puppeteer'); } catch (_e) { console.debug('[catch] lightweight mode only:', _e.message); }

class WebPerception {
  constructor({ bus, storage, eventStore, config }) {
    this.bus = bus || NullBus;
    this.storage = storage || null;
    this.eventStore = eventStore || null;
    this.worldState = null; // lateBinding

    const cfg = config || {};
    this._timeoutMs = cfg.timeoutMs || 15000;
    this._maxBodyBytes = cfg.maxBodyBytes || 512 * 1024; // 512KB max
    this._maxCacheEntries = cfg.maxCacheEntries || 100;
    this._cacheTtlMs = cfg.cacheTtlMs || 5 * 60 * 1000; // 5 min cache
    this._userAgent = cfg.userAgent || 'Genesis-Agent/4.1 (Electron; Cognitive AI)';

    // ── Cache ────────────────────────────────────────────
    this._cache = new Map(); // url → { content, parsed, fetchedAt }

    // ── Headless browser (lazy init) ────────────────────
    this._browser = null;
    this._headlessAvailable = !!puppeteer;

    // ── Stats ────────────────────────────────────────────
    this._stats = {
      fetches: 0,
      cacheHits: 0,
      failures: 0,
      headlessFetches: 0,
    };
  }

  // ════════════════════════════════════════════════════════
  // PUBLIC API
  // ════════════════════════════════════════════════════════

  /**
   * Fetch and parse a web page.
   * @param {string} url — Full URL to fetch
   * @param {object} options — { headless, selector, maxLength }
   * @returns {Promise<*>}
   */
  async fetch(url, options = {}) {
    if (!url || typeof url !== 'string') {
      return { success: false, error: 'Invalid URL' };
    }

    // ── Cache check ─────────────────────────────────────
    const cached = this._cache.get(url);
    if (cached && (Date.now() - cached.fetchedAt) < this._cacheTtlMs) {
      this._stats.cacheHits++;
      return { success: true, ...cached.parsed, fromCache: true };
    }

    this._stats.fetches++;

    try {
      let html;

      if (options.headless && this._headlessAvailable) {
        html = await this._headlessFetch(url);
        this._stats.headlessFetches++;
      } else {
        html = await this._httpFetch(url);
      }

      const parsed = this._parseHTML(html, url, options);

      // Cache result
      this._cache.set(url, { content: html, parsed, fetchedAt: Date.now() });
      this._trimCache();

      // Update WorldState
      if (this.worldState) {
        this._updateWorldState(url, parsed);
      }

      this.bus.emit('web:fetched', {
        url,
        title: parsed.title,
        textLength: parsed.text?.length || 0,
      }, { source: 'WebPerception' });

      return { success: true, ...parsed };

    } catch (err) {
      this._stats.failures++;
      return { success: false, url, error: err.message };
    }
  }

  /**
   * Fetch multiple URLs in parallel.
   * @param {string[]} urls
   * @param {object} options
   * @returns {Promise<*>}
   */
  async fetchMany(urls, options = {}) {
    const maxConcurrent = options.maxConcurrent || 3;
    const results = [];

    for (let i = 0; i < urls.length; i += maxConcurrent) {
      const batch = urls.slice(i, i + maxConcurrent);
      const batchResults = await Promise.allSettled(
        batch.map(url => this.fetch(url, options))
      );
      results.push(...batchResults.map(r => r.status === 'fulfilled' ? r.value : { success: false, error: r.reason?.message }));
    }

    return results;
  }

  /**
   * Extract specific data from a page using CSS selectors.
   * Requires cheerio.
   * @param {string} url
   * @param {object} selectors — { title: 'h1', items: '.item', ... }
   * @returns {Promise<*>}
   */
  async extract(url, selectors) {
    if (!cheerio) {
      return { success: false, error: 'cheerio not installed — npm install cheerio' };
    }

    const result = await this.fetch(url);
    if (!result.success) return result;

    const cached = this._cache.get(url);
    if (!cached?.content) return { success: false, error: 'No cached content' };

    const $ = cheerio.load(cached.content);
    const data = Object.create(null);

    for (const [key, selector] of Object.entries(selectors)) {
      // Guard: reject prototype pollution keys
      if (key === '__proto__' || key === 'constructor' || key === 'prototype') continue;
      const elements = $(selector);
      if (elements.length === 1) {
        data[key] = elements.text().trim();
      } else if (elements.length > 1) {
        data[key] = elements.map((_, el) => $(el).text().trim()).get();
      } else {
        data[key] = null;
      }
    }

    return { success: true, url, data };
  }

  /**
   * Check if a URL is reachable (HEAD request).
   */
  async ping(url) {
    try {
      const parsed = new URL(url);
      const mod = parsed.protocol === 'https:' ? https : http;

      return new Promise((resolve) => {
        const req = mod.request(parsed, { method: 'HEAD', timeout: TIMEOUTS.GIT_OP }, (res) => {
          resolve({ reachable: true, status: res.statusCode });
        });
        req.on('error', () => resolve({ reachable: false }));
        req.on('timeout', () => { req.destroy(); resolve({ reachable: false }); });
        req.end();
      });
    } catch (_e) {
      console.debug('[catch] req.end:', _e.message);
      return { reachable: false };
    }
  }

  /**
   * Get capabilities info.
   */
  getCapabilities() {
    return {
      cheerioAvailable: !!cheerio,
      puppeteerAvailable: this._headlessAvailable,
      mode: this._headlessAvailable ? 'headless + lightweight' : 'lightweight only',
    };
  }

  getStats() { return { ...this._stats, cacheSize: this._cache.size }; }

  async shutdown() {
    if (this._browser) {
      try { await this._browser.close(); } catch (_e) { console.debug('[catch] browser close:', _e.message); }
      this._browser = null;
    }
  }

  // ════════════════════════════════════════════════════════
  // HTTP FETCH (Lightweight)
  // ════════════════════════════════════════════════════════

  _httpFetch(url) {
    return new Promise((resolve, reject) => {
      const parsed = new URL(url);
      const mod = parsed.protocol === 'https:' ? https : http;

      const req = mod.get(url, {
        headers: { 'User-Agent': this._userAgent, 'Accept': 'text/html,application/json' },
        timeout: this._timeoutMs,
      }, (res) => {
        // Follow redirects (up to 3)
        if ([301, 302, 307, 308].includes(res.statusCode) && res.headers.location) {
          const redirectUrl = new URL(res.headers.location, url).href;
          this._httpFetch(redirectUrl).then(resolve).catch(reject);
          return;
        }

        if (res.statusCode >= 400) {
          reject(new Error(`HTTP ${res.statusCode} for ${url}`));
          return;
        }

        const chunks = [];
        let totalBytes = 0;

        res.on('data', (chunk) => {
          totalBytes += chunk.length;
          if (totalBytes > this._maxBodyBytes) {
            res.destroy();
            reject(new Error(`Response too large (>${this._maxBodyBytes} bytes)`));
            return;
          }
          chunks.push(chunk);
        });

        res.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
        res.on('error', reject);
      });

      req.on('error', reject);
      req.on('timeout', () => { req.destroy(); reject(new Error(`Timeout fetching ${url}`)); });
    });
  }

  // ════════════════════════════════════════════════════════
  // HEADLESS FETCH (Puppeteer)
  // ════════════════════════════════════════════════════════

  async _headlessFetch(url) {
    if (!this._browser) {
      this._browser = await puppeteer.launch({
        headless: 'new',
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-gpu'],
      });
    }

    const page = await this._browser.newPage();
    try {
      await page.setUserAgent(this._userAgent);
      await page.goto(url, { waitUntil: 'networkidle2', timeout: this._timeoutMs });
      return await page.content();
    } finally {
      await page.close();
    }
  }

  // ════════════════════════════════════════════════════════
  // HTML PARSING
  // ════════════════════════════════════════════════════════

  _parseHTML(html, url, options = {}) {
    if (cheerio) {
      return this._parseWithCheerio(html, url, options);
    }
    return this._parseWithRegex(html, url, options);
  }

  _parseWithCheerio(html, url, options) {
    const $ = cheerio.load(html);

    // Remove noise
    $('script, style, nav, footer, header, iframe, noscript, svg').remove();

    const title = $('title').first().text().trim() || $('h1').first().text().trim() || '';

    let text;
    if (options.selector) {
      text = $(options.selector).text().trim();
    } else {
      // Get main content area or body
      const main = $('main, article, [role="main"], .content, .post-content, #content').first();
      text = (main.length > 0 ? main : $('body')).text().trim();
    }

    // Clean up whitespace
    text = text.replace(/\s+/g, ' ').trim();
    const maxLength = options.maxLength || 5000;
    if (text.length > maxLength) text = text.slice(0, maxLength) + '...';

    // Extract links
    const links = [];
    $('a[href]').each((_, el) => {
      const href = $(el).attr('href');
      const linkText = $(el).text().trim();
      if (href && linkText && !href.startsWith('#') && !href.startsWith('javascript:')) {
        try {
          links.push({ text: linkText.slice(0, 100), url: new URL(href, url).href });
        } catch (_e) { console.debug('[catch] invalid URL:', _e.message); }
      }
    });

    // Extract metadata
    const metadata = {
      description: $('meta[name="description"]').attr('content') || '',
      keywords: $('meta[name="keywords"]').attr('content') || '',
      ogTitle: $('meta[property="og:title"]').attr('content') || '',
    };

    return { url, title, text, links: links.slice(0, 30), metadata };
  }

  _parseWithRegex(html, url, options) {
    // Fallback regex-based parser (no cheerio)
    const title = html.match(/<title[^>]*>(.*?)<\/title>/is)?.[1]?.trim() || '';

    // Strip tags
    let text = html
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/<style[\s\S]*?<\/style>/gi, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/\s+/g, ' ')
      .trim();

    const maxLength = options.maxLength || 5000;
    if (text.length > maxLength) text = text.slice(0, maxLength) + '...';

    return { url, title, text, links: [], metadata: {} };
  }

  // ════════════════════════════════════════════════════════
  // WORLD STATE INTEGRATION
  // ════════════════════════════════════════════════════════

  _updateWorldState(url, parsed) {
    if (!this.worldState?.state) return;

    if (!this.worldState.state.external) {
      this.worldState.state.external = { recentFetches: [], apiStatuses: {} };
    }

    const ext = this.worldState.state.external;
    ext.recentFetches.push({
      url,
      title: parsed.title,
      fetchedAt: Date.now(),
      textLength: parsed.text?.length || 0,
    });

    // Keep only last 10
    if (ext.recentFetches.length > 10) {
      ext.recentFetches = ext.recentFetches.slice(-10);
    }
  }

  _trimCache() {
    if (this._cache.size <= this._maxCacheEntries) return;
    const entries = [...this._cache.entries()].sort((a, b) => a[1].fetchedAt - b[1].fetchedAt);
    while (this._cache.size > this._maxCacheEntries && entries.length > 0) {
      this._cache.delete(/** @type {*} */ (entries.shift())[0]);
    }
  }
}

module.exports = { WebPerception };
