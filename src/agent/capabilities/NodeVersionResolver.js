// @ts-checked-v7.8.4
// ============================================================
// GENESIS — NodeVersionResolver.js (v7.8.4)
//
// Resolves the current Node.js v22 LTS version and corresponding
// installer URLs at runtime. Replaces the hardcoded v22.22.2 in
// CommandHandlersInstallDB._SOFTWARE_DB.nodejs with a lazy fetch
// from nodejs.org/dist/index.json, cached for 24 hours, with a
// hardcoded fallback for offline / fetch-fail scenarios.
//
// Filter is pinned to the v22 major: a bump to v24 (Active LTS)
// remains an explicit decision, not a silent drift.
//
// No DI: the module is pure-function from caller perspective;
// the cache lives on disk under cacheDir (typically .genesis/cache/).
// ============================================================

'use strict';

const fs = require('fs');
const path = require('path');
const https = require('https');
const { createLogger } = require('../core/Logger');
const { atomicWriteFileSync, safeJsonParse } = require('../core/utils');
const _log = createLogger('NodeVersionResolver');

const NODEJS_DIST_INDEX_URL = 'https://nodejs.org/dist/index.json';
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;   // 24 hours
const FETCH_TIMEOUT_MS = 5000;
const MAJOR = 'v22';                         // pinned major — v24 bump is its own decision

// Hardcoded fallback used when the cache is empty AND the live fetch
// fails (typically offline). Keeps Genesis able to install Node
// without network access. The value is updated occasionally; what
// matters is that it stays inside the v22 LTS line.
const FALLBACK = {
  version: 'v22.22.2',
  urls: {
    win32:  { url: 'https://nodejs.org/dist/v22.22.2/node-v22.22.2-x64.msi', filename: 'nodejs-v22.22.2.msi', label: 'Node.js v22 LTS' },
    darwin: { url: 'https://nodejs.org/dist/v22.22.2/node-v22.22.2.pkg',     filename: 'nodejs-v22.22.2.pkg', label: 'Node.js v22 LTS' },
  },
};

class NodeVersionResolver {
  /**
   * @param {object} deps
   * @param {string} deps.cacheDir - directory for node-latest.json cache
   * @param {object} [deps.httpsClient] - injectable for tests (must have .get)
   * @param {function} [deps.now] - clock injection for tests
   */
  constructor({ cacheDir, httpsClient = https, now = () => Date.now() } = {}) {
    if (!cacheDir) throw new Error('NodeVersionResolver requires cacheDir');
    this._cacheDir = cacheDir;
    this._cachePath = path.join(cacheDir, 'node-latest.json');
    this._https = httpsClient;
    this._now = now;
  }

  /**
   * Resolve the current Node v22 LTS installer URLs.
   * Priority: fresh cache (≤24h) → live fetch → stale cache → fallback.
   * Always returns; never throws. Source is logged.
   *
   * @returns {Promise<{version: string, urls: object, source: 'cache'|'live'|'stale-cache'|'fallback'}>}
   */
  async resolve() {
    // 1. Fresh cache wins
    const cached = this._readCache();
    if (cached && (this._now() - cached.fetchedAt) < CACHE_TTL_MS) {
      return { version: cached.version, urls: cached.urls, source: 'cache' };
    }

    // 2. Try live fetch
    try {
      const resolved = await this._fetchLatest();
      this._writeCache({ ...resolved, fetchedAt: this._now() });
      return { version: resolved.version, urls: resolved.urls, source: 'live' };
    } catch (err) {
      _log.warn(`[NODE-RESOLVER] nodejs.org fetch failed: ${err.message}`);
    }

    // 3. Stale cache is better than fallback if it ever succeeded
    if (cached) {
      return { version: cached.version, urls: cached.urls, source: 'stale-cache' };
    }

    // 4. Last resort — hardcoded
    return { version: FALLBACK.version, urls: FALLBACK.urls, source: 'fallback' };
  }

  /**
   * Fetch nodejs.org/dist/index.json and pick latest v22.* with lts: true.
   * @returns {Promise<{version: string, urls: object}>}
   */
  _fetchLatest() {
    return new Promise((resolve, reject) => {
      const req = this._https.get(NODEJS_DIST_INDEX_URL, {
        headers: { 'User-Agent': 'Genesis-Agent/7.8.4' },
        timeout: FETCH_TIMEOUT_MS,
      }, (res) => {
        if (res.statusCode !== 200) {
          reject(new Error(`HTTP ${res.statusCode} from nodejs.org`));
          res.resume();
          return;
        }
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
          try {
            const releases = JSON.parse(data);
            if (!Array.isArray(releases)) {
              reject(new Error('nodejs.org response is not an array'));
              return;
            }
            const latest22 = releases.find(
              (r) => typeof r.version === 'string' && r.version.startsWith(`${MAJOR}.`) && r.lts
            );
            if (!latest22) {
              reject(new Error(`No ${MAJOR}.* LTS release found in index`));
              return;
            }
            const v = latest22.version.replace(/^v/, '');
            resolve({
              version: latest22.version,
              urls: {
                win32:  { url: `https://nodejs.org/dist/v${v}/node-v${v}-x64.msi`, filename: `nodejs-v${v}.msi`, label: 'Node.js v22 LTS' },
                darwin: { url: `https://nodejs.org/dist/v${v}/node-v${v}.pkg`,     filename: `nodejs-v${v}.pkg`, label: 'Node.js v22 LTS' },
              },
            });
          } catch (err) {
            reject(new Error(`parse failed: ${err.message}`));
          }
        });
      });
      req.on('error', reject);
      req.on('timeout', () => {
        req.destroy();
        reject(new Error(`timeout after ${FETCH_TIMEOUT_MS}ms`));
      });
    });
  }

  /** @returns {{version: string, urls: object, fetchedAt: number}|null} */
  _readCache() {
    try {
      if (!fs.existsSync(this._cachePath)) return null;
      const raw = fs.readFileSync(this._cachePath, 'utf-8');
      const parsed = safeJsonParse(raw, null, 'NodeVersionResolver');
      if (!parsed || !parsed.version || !parsed.urls || typeof parsed.fetchedAt !== 'number') {
        return null;
      }
      return parsed;
    } catch (err) {
      _log.debug(`[NODE-RESOLVER] cache read failed: ${err.message}`);
      return null;
    }
  }

  _writeCache(entry) {
    try {
      if (!fs.existsSync(this._cacheDir)) {
        fs.mkdirSync(this._cacheDir, { recursive: true });
      }
      atomicWriteFileSync(this._cachePath, JSON.stringify(entry, null, 2), 'utf-8');
    } catch (err) {
      _log.debug(`[NODE-RESOLVER] cache write failed: ${err.message}`);
    }
  }
}

module.exports = { NodeVersionResolver, FALLBACK, NODEJS_DIST_INDEX_URL, MAJOR };
