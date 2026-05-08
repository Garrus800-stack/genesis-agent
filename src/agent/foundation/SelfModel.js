// @ts-checked-v5.7
// ============================================================
// GENESIS AGENT — SelfModel.js (v4.0.0 — Fully Async Git)
// The agent's living map of itself.
// Knows every file, module, dependency, capability.
//
// v7.4.1: Split into 4 files via prototype delegation:
//   SelfModel.js              — core (constructor, scan, public API)
//   SelfModelParsing.js       — _scanDir, _scanDirAsync, _parseModule
//   SelfModelCapabilities.js  — _detectCapabilities, helpers
//   SelfModelSourceRead.js    — readModule, readSourceSync, describeModule
//
// Same pattern as PromptBuilder, DreamCycle, ChatOrchestrator.
// External API unchanged.
// ============================================================

const path = require('path');
const { TIMEOUTS } = require('../core/Constants');
const fs = require('fs');
const fsp = require('fs').promises;
const { execFile } = require('child_process');
const { promisify } = require('util');
const { safeJsonParse } = require('../core/utils');
const { createLogger } = require('../core/Logger');
const _log = createLogger('SelfModel');
const execFileAsync = promisify(execFile);

// Shared options for all git operations
const _gitOpts = (cwd) => ({ cwd, stdio: 'pipe', timeout: TIMEOUTS.SANDBOX_EXEC, windowsHide: true, encoding: 'utf-8' });

class SelfModel {
  constructor(rootDir, guard) {
    this.rootDir = rootDir;
    this.guard = guard;
    /** @type {{ identity: string, version: string, scannedAt: string|null, modules: object, files: object, capabilities: string[], capabilitiesDetailed: object[], dependencies: object }} */
    this.manifest = {
      identity: 'genesis',
      version: '0.1.0',
      scannedAt: null,
      modules: {},
      files: {},
      capabilities: [],
      capabilitiesDetailed: [],
      dependencies: {},
    };
    this.gitAvailable = false;

    // v7.7.1-hotfix: settings injected by AgentCoreBoot before scan().
    // Used to gate git-mutation operations behind user-opt-in. When null
    // (e.g. early boot, tests), all git-mutation paths default to off.
    this._settings = null;

    // v7.3.0: Manifest metadata injected by AgentCoreBoot before scan().
    this._manifestMeta = null;

    // v7.3.1: readModule cache — TTL-based, invalidated on hot-reload:success.
    this._readCache = new Map();
    this._readCacheTTL = 5 * 60 * 1000;
    this._readCacheMax = 50;
    this._hotReloadUnsub = null;

    // v7.3.6 #9: Synchronous Source-Read — per-turn and per-session budget.
    // v7.5.9 ZIP1 Phase 6: defaults raised from 5/10/20 to 15/30/100. The
    // earlier numbers were tuned for v7.3.6 where source-read was rare; with
    // v7.5.8+ pattern coverage and tool-call retries the legitimate read
    // count per turn is much higher. The 100-session cap accommodates long
    // pair-programming sessions. File-cap (20KB per file) unchanged so
    // total context-window budget stays bounded.
    this._readSourceBudget = {
      softPerTurn: 15,
      hardPerTurn: 30,
      hardPerSession: 100,
      maxFileBytes: 20 * 1024,
    };
    this._readSourceState = {
      turnCount: 0,
      sessionCount: 0,
      currentTurnId: null,
      sessionCache: new Map(),
    };
  }

  /**
   * v7.3.0: Inject container metadata before scan().
   * @param {object} meta - Map of serviceName → { tags, phase, deps }
   */
  setManifestMeta(meta) {
    this._manifestMeta = meta || null;
    if (this.manifest.scannedAt) {
      this.manifest.capabilities = this._detectCapabilities();
    }
  }

  /** Scan the entire project and build the self-model */
  async scan() {
    this.manifest.scannedAt = new Date().toISOString();
    this.manifest.modules = {};
    this.manifest.files = {};

    await this._scanDirAsync(this.rootDir, '');
    this.manifest.capabilities = this._detectCapabilities();

    // Parse package.json for dependencies
    const pkgPath = path.join(this.rootDir, 'package.json');
    try {
      const pkgRaw = await fsp.readFile(pkgPath, 'utf-8');
      const pkg = safeJsonParse(pkgRaw, {}, 'SelfModel');
      this.manifest.dependencies = pkg.dependencies || {};
      this.manifest.version = pkg.version || this.manifest.version;
    } catch (_e) { _log.debug('[catch] no package.json — keep defaults:', _e.message); }

    // Check git availability
    try {
      await execFileAsync('git', ['--version'], _gitOpts(this.rootDir));
      this.gitAvailable = true;

      // v7.7.1-hotfix: gate auto-init + initial commit behind setting.
      // Default off — Genesis must not create a .git in the user's working
      // directory without explicit consent. SnapshotManager + GenesisBackup
      // cover state-preservation without git.
      const gitAutoInit = this._settings?.get?.('agency.gitAutoInit') === true;
      if (gitAutoInit && !fs.existsSync(path.join(this.rootDir, '.git'))) {
        await execFileAsync('git', ['init'], _gitOpts(this.rootDir));
        try {
          await execFileAsync('git', ['config', 'user.name'], _gitOpts(this.rootDir));
        } catch (err) {
          await execFileAsync('git', ['config', 'user.name', 'Genesis'], _gitOpts(this.rootDir));
          await execFileAsync('git', ['config', 'user.email', 'genesis@local'], _gitOpts(this.rootDir));
        }
        await execFileAsync('git', ['add', '-A'], _gitOpts(this.rootDir));
        await execFileAsync('git', ['commit', '-m', 'genesis: initial', '--allow-empty'], _gitOpts(this.rootDir));
      }
    } catch (err) {
      _log.warn('[SELF-MODEL] Git not available:', err.message);
      this.gitAvailable = false;
    }

    // Save manifest
    const genesisDir = path.join(this.rootDir, '.genesis');
    await fsp.mkdir(genesisDir, { recursive: true });
    await fsp.writeFile(
      path.join(genesisDir, 'self-model.json'),
      JSON.stringify(this.manifest, null, 2),
      'utf-8'
    );
  }

  // ── Public API ───────────────────────────────────────────

  getFullModel() {
    return { ...this.manifest };
  }

  getModuleSummary() {
    return Object.entries(this.manifest.modules)
      .filter(([file]) => file.replace(/\\/g, '/').startsWith('src/'))
      .map(([file, mod]) => ({
      file,
      classes: mod.classes,
      functions: mod.functions.length,
      requires: mod.requires,
      description: mod.description,
      protected: this.manifest.files[file]?.protected || false,
    }));
  }

  getCapabilities() {
    return this.manifest.capabilities;
  }

  getCapabilitiesDetailed() {
    return this.manifest.capabilitiesDetailed || [];
  }

  moduleCount() {
    return Object.keys(this.manifest.modules)
      .filter(p => p.replace(/\\/g, '/').startsWith('src/'))
      .length;
  }

  getFileTree() {
    const tree = [];
    for (const [file, info] of Object.entries(this.manifest.files)) {
      tree.push({
        path: file,
        lines: info.lines,
        protected: info.protected,
        isModule: !!this.manifest.modules[file],
      });
    }
    return tree.sort((a, b) => a.path.localeCompare(b.path));
  }

  async commitSnapshot(message) {
    if (!this.gitAvailable) return;
    // v7.7.1-hotfix: gated behind agency.gitAutoCommit (default off).
    // SnapshotManager (.genesis/snapshots/) and GenesisBackup (.genesis-backups/)
    // are the active state-preservation layers when this is off — same
    // semantic coverage via file-copy without touching git.
    if (this._settings?.get?.('agency.gitAutoCommit') !== true) {
      _log.debug('[SELF-MODEL] commitSnapshot skipped — agency.gitAutoCommit is disabled (fallback: SnapshotManager + GenesisBackup)');
      return;
    }
    try {
      await execFileAsync('git', ['add', '-A'], _gitOpts(this.rootDir));
      await execFileAsync('git', ['commit', '-m', String(message), '--allow-empty'], _gitOpts(this.rootDir));
    } catch (err) {
      const stderr = err.stderr || '';
      if (stderr.includes('Auto packing') || stderr.includes('git help gc')) {
        _log.debug('[SELF-MODEL] Git housekeeping notice (commit likely succeeded):', stderr.trim().slice(0, 100));
        return;
      }
      _log.warn('[SELF-MODEL] Git commit failed:', err.message);
    }
  }

  async rollback() {
    if (!this.gitAvailable) throw new Error('Git not available for rollback');
    // v7.7.1-hotfix: gated behind agency.gitAutoCommit. When off, callers
    // (DeploymentManager, Reflector recovery) should fall back to
    // .genesis-backups/ for state restoration.
    if (this._settings?.get?.('agency.gitAutoCommit') !== true) {
      throw new Error('rollback unavailable — agency.gitAutoCommit is disabled (fallback: restore from .genesis-backups/)');
    }
    await execFileAsync('git', ['revert', 'HEAD', '--no-edit'], _gitOpts(this.rootDir));
    await this.scan();
  }
}

// ── Prototype Delegation ─────────────────────────────────────
// v7.4.1: Methods delegated from extracted files.
// Same pattern as PromptBuilder, DreamCycle, ChatOrchestrator.
const { selfModelParsing } = require('./SelfModelParsing');
const { selfModelCapabilities } = require('./SelfModelCapabilities');
const { selfModelSourceRead } = require('./SelfModelSourceRead');
Object.assign(SelfModel.prototype, selfModelParsing);
Object.assign(SelfModel.prototype, selfModelCapabilities);
Object.assign(SelfModel.prototype, selfModelSourceRead);

module.exports = { SelfModel };
