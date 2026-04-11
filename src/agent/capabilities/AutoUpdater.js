// @ts-check
// ============================================================
// GENESIS — AutoUpdater.js (v6.0.1)
//
// Lightweight update checker using GitHub Releases API.
// No electron-updater dependency — checks for new versions
// and notifies the user. Does NOT auto-install (safety first
// for a self-modifying agent).
//
// Flow:
//   1. On boot (if enabled), check GitHub Releases API
//   2. Compare current version with latest release tag
//   3. If newer version exists → emit update:available event
//   4. Dashboard shows notification with changelog + download link
//   5. User decides when to update
//
// Configuration (settings.json → updates):
//   checkOnBoot: true
//   checkIntervalHours: 24
//   owner: 'Garrus800-stack'
//   repo: 'genesis-agent'
//
// Why not electron-updater?
//   electron-updater auto-downloads and applies updates.
//   For a self-modifying agent, silent binary replacement is
//   a security risk. We prefer explicit user consent.
//
// CLI: /update — check for updates now
// IPC: agent:check-update — trigger check, returns result
// ============================================================

const https = require('https');
const { createLogger } = require('../core/Logger');
const { swallow } = require('../core/utils');
const _log = createLogger('AutoUpdater');

const DEFAULTS = {
  checkOnBoot: true,
  checkIntervalHours: 24,
  owner: 'Garrus800-stack',
  repo: 'genesis-agent',
};

class AutoUpdater {
  /**
   * @param {{ bus?: *, settings?: *, intervals?: *, config?: Partial<typeof DEFAULTS> }} opts
   */
  constructor({ bus, settings, intervals, config } = {}) {
    this.bus = bus || { emit() {}, fire() {} };
    this._settings = settings || null;
    this._intervals = intervals || null;
    this._deploymentManager = null; // v7.1.1: injected via lateBinding (V7-4B bridge)

    const cfg = { ...DEFAULTS, ...config };
    this._owner = cfg.owner;
    this._repo = cfg.repo;
    this._checkOnBoot = cfg.checkOnBoot;
    this._checkIntervalHours = cfg.checkIntervalHours;
    /** @type {boolean} Apply update via DeploymentManager when available (default: false) */
    this._autoApply = cfg.autoApply === true;

    this._currentVersion = this._loadCurrentVersion();
    this._latestRelease = null;
    this._lastCheck = null;
  }

  // ════════════════════════════════════════════════════════════
  // LIFECYCLE
  // ════════════════════════════════════════════════════════════

  start() {
    // Load config from settings
    if (this._settings) {
      const cfg = this._settings.get?.('updates') || {};
      if (typeof cfg.checkOnBoot === 'boolean') this._checkOnBoot = cfg.checkOnBoot;
      if (typeof cfg.checkIntervalHours === 'number') this._checkIntervalHours = cfg.checkIntervalHours;
      if (cfg.owner) this._owner = cfg.owner;
      if (cfg.repo) this._repo = cfg.repo;
      if (typeof cfg.autoApply === 'boolean') this._autoApply = cfg.autoApply;
    }

    _log.info(`[AUTO-UPDATE] v${this._currentVersion} — checking ${this._owner}/${this._repo}`);

    // Check on boot (non-blocking)
    if (this._checkOnBoot) {
      const { TIMEOUTS } = require('../core/Constants');
      setTimeout(() => swallow(this.checkForUpdate(), 'boot-update'), TIMEOUTS.UPDATE_BOOT_DELAY); // 10s after boot
    }

    // Periodic check
    if (this._intervals && this._checkIntervalHours > 0) {
      this._intervals.register('auto-update-check', () => {
        swallow(this.checkForUpdate(), 'periodic-update');
      }, this._checkIntervalHours * 3600000);
    }
  }

  stop() {
    if (this._intervals) {
      this._intervals.clear('auto-update-check');
    }
  }

  // ════════════════════════════════════════════════════════════
  // CHECK
  // ════════════════════════════════════════════════════════════

  /**
   * Check GitHub Releases for a newer version.
   * @returns {Promise<{ available: boolean, current: string, latest?: string, url?: string, changelog?: string }>}
   */
  async checkForUpdate() {
    try {
      const release = await this._fetchLatestRelease();
      this._lastCheck = new Date().toISOString();
      this._latestRelease = release;

      if (!release || !release.tag_name) {
        return { available: false, current: this._currentVersion };
      }

      const latestVersion = release.tag_name.replace(/^v/, '');

      if (this._isNewer(latestVersion, this._currentVersion)) {
        _log.info(`[AUTO-UPDATE] New version available: v${latestVersion} (current: v${this._currentVersion})`);

        this.bus.emit('update:available', {
          current: this._currentVersion,
          latest: latestVersion,
          url: release.html_url,
          changelog: (release.body || '').slice(0, 500),
          publishedAt: release.published_at,
        }, { source: 'AutoUpdater' });

        // v7.1.1: V7-4B bridge — trigger DeploymentManager when autoApply is enabled.
        // autoApply defaults to false; user must opt in via settings.json → updates.autoApply.
        // The deployment runs fire-and-forget: outcome is reported via deploy:completed /
        // deploy:failed events, not by blocking checkForUpdate().
        if (this._autoApply && this._deploymentManager) {
          _log.info(`[AUTO-UPDATE] autoApply enabled — triggering deployment for v${latestVersion}`);
          const deployOpts = { strategy: 'direct', env: `v${latestVersion}` };
          this._deploymentManager.deploy('self', deployOpts)
            .then(d => _log.info(`[AUTO-UPDATE] Deployment ${d.id.slice(0, 8)} completed (v${latestVersion})`))
            .catch(err => _log.warn(`[AUTO-UPDATE] Deployment failed: ${err.message}`));
        }

        return {
          available: true,
          current: this._currentVersion,
          latest: latestVersion,
          url: release.html_url,
          changelog: (release.body || '').slice(0, 500),
        };
      }

      _log.info(`[AUTO-UPDATE] Up to date (v${this._currentVersion})`);
      return { available: false, current: this._currentVersion, latest: latestVersion };
    } catch (err) {
      _log.debug(`[AUTO-UPDATE] Check failed: ${err.message}`);
      return { available: false, current: this._currentVersion };
    }
  }

  /**
   * Get current update status.
   */
  getStatus() {
    return {
      currentVersion: this._currentVersion,
      latestRelease: this._latestRelease ? {
        version: this._latestRelease.tag_name?.replace(/^v/, ''),
        url: this._latestRelease.html_url,
        publishedAt: this._latestRelease.published_at,
      } : null,
      lastCheck: this._lastCheck,
      checkOnBoot: this._checkOnBoot,
      checkIntervalHours: this._checkIntervalHours,
      autoApply: this._autoApply,
      deploymentManagerAvailable: !!this._deploymentManager,
    };
  }

  // ════════════════════════════════════════════════════════════
  // INTERNALS
  // ════════════════════════════════════════════════════════════

  /**
   * Fetch latest release from GitHub API.
   * @returns {Promise<object|null>}
   */
  _fetchLatestRelease() {
    return new Promise((resolve, reject) => {
      const options = {
        hostname: 'api.github.com',
        path: `/repos/${this._owner}/${this._repo}/releases/latest`,
        headers: {
          'User-Agent': `Genesis-Agent/${this._currentVersion}`,
          'Accept': 'application/vnd.github.v3+json',
        },
        timeout: 10000,
      };

      const req = https.get(options, (res) => {
        if (res.statusCode === 404) {
          resolve(null); // No releases yet
          return;
        }
        if (res.statusCode !== 200) {
          reject(new Error(`GitHub API returned ${res.statusCode}`));
          return;
        }

        let data = '';
        res.on('data', chunk => { data += chunk; });
        res.on('end', () => {
          try { resolve(JSON.parse(data)); }
          catch (e) { reject(e); }
        });
      });

      req.on('error', reject);
      req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
    });
  }

  /**
   * Compare semver strings. Returns true if a > b.
   * @param {string} a
   * @param {string} b
   * @returns {boolean}
   */
  _isNewer(a, b) {
    const pa = a.split('.').map(Number);
    const pb = b.split('.').map(Number);
    for (let i = 0; i < 3; i++) {
      const va = pa[i] || 0;
      const vb = pb[i] || 0;
      if (va > vb) return true;
      if (va < vb) return false;
    }
    return false;
  }

  /**
   * Read current version from package.json.
   * @returns {string}
   */
  _loadCurrentVersion() {
    try {
      const pkgPath = require('path').resolve(__dirname, '../../../package.json');
      const pkg = require(pkgPath);
      return pkg.version || '0.0.0';
    } catch { /* package.json unreadable — safe default */
      return '0.0.0';
    }
  }
}

module.exports = { AutoUpdater };
