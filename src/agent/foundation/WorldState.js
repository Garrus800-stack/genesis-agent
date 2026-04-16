// @ts-checked-v5.8
// ============================================================
// GENESIS — WorldState.js (v3.5.0 — Cognitive Agent)
//
// Genesis stops being blind. WorldState is a typed, live model
// of the entire environment: project structure, git status,
// runtime state, user context, system resources.
//
// Purpose:
//   - FormalPlanner checks preconditions against this
//   - PromptBuilder injects relevant slices into context
//   - IdleMind uses it for intelligent activity selection
//   - AgentLoop updates it after every step (effects)
//
// Updated by: DesktopPerception (file watcher, polls)
//             AgentLoop (after each step)
//             SessionPersistence (user context across restarts)
//
// The key insight: Instead of asking the LLM "can we do X?",
// we CHECK the WorldState: "Is X's precondition met?"
// ============================================================

const path = require('path');
const { TIMEOUTS } = require('../core/Constants');
const fs = require('fs');
const { execFile } = require('child_process');
const { promisify } = require('util');
const execFileAsync = promisify(execFile);
const { NullBus } = require('../core/EventBus');
const { safeJsonParse } = require('../core/utils');
const { createLogger } = require('../core/Logger');
const _log = createLogger('WorldState');

class WorldState {
  constructor({ bus, storage, rootDir, settings, guard }) {
    this.bus = bus || NullBus;
    this.storage = storage || null;
    this.rootDir = rootDir;
    this.settings = settings || null;
    this.guard = guard || null;

    // ── The State ─────────────────────────────────────────
    this.state = {
      project: {
        root: rootDir,
        structure: null,          // Lazy-loaded
        /** @type {* | null} */ gitStatus: null,
        /** @type {* | null} */ packageJson: null,
        /** @type {Array<*>} */ recentlyModified: [],     // { path, mtime, size }
        /** @type {string | null} */ testScript: null,         // Extracted from package.json
      },

      runtime: {
        /** @type {Array<*>} */ ollamaModels: [],
        ollamaStatus: 'unknown',  // running | stopped | error | unknown
        memoryUsage: {},
        /** @type {number | null} */ uptime: 0,
        /** @type {Array<*>} */ activeGoals: [],
        circuitState: 'CLOSED',
        bootTime: Date.now(),
      },

      user: {
        name: null,
        preferences: {},
        /** @type {Array<*>} */ workPatterns: [],
        /** @type {Array<*>} */ recentTopics: [],
        expertise: {},
      },

      system: {
        platform: process.platform,
        arch: process.arch,
        nodeVersion: process.version,
        gpu: null,
        /** @type {number | null} */ totalRAM: null,
        /** @type {number | null} */ cpuCores: null,
      },
    };

    // Kernel files (immutable — never writable)
    this._kernelFiles = new Set();

    // Shell blocklist (dangerous commands)
    this._shellBlocklist = new Set([
      'rm -rf /', 'mkfs', 'dd if=', ':(){', 'fork bomb',
      'chmod -R 777', 'wget|bash', 'curl|sh',
    ]);

    // v3.8.0: Moved to asyncLoad() — called by Container.bootAll()
    // this._load();
    this._initProject();
    this._initSystem();
  }

  // Precondition + Query API extracted to WorldStateQueries.js (FIX v5.1.0 A-3)

  // ════════════════════════════════════════════════════════
  // QUERY + PRECONDITION API
  // FIX v5.1.0 (A-3): Extracted to WorldStateQueries.js
  // (CQRS-lite split to resolve God Object finding)
  // ════════════════════════════════════════════════════════

  /** Clone state for plan simulation (FormalPlanner uses this) */
  clone() {
    const cloned = new WorldStateSnapshot(this.state);
    cloned._kernelFiles = new Set(this._kernelFiles);
    cloned._shellBlocklist = new Set(this._shellBlocklist);
    cloned.rootDir = this.rootDir;
    return cloned;
  }

  // ════════════════════════════════════════════════════════
  // UPDATE API (called by DesktopPerception, AgentLoop, etc.)
  // ════════════════════════════════════════════════════════

  recordFileChange(filePath) {
    const entry = {
      path: path.relative(this.rootDir, filePath),
      mtime: Date.now(),
      size: (/** @type {any} */ (this))._getFileSize(filePath),
    };

    // Keep last 20
    this.state.project.recentlyModified = [
      entry,
      ...this.state.project.recentlyModified.filter(f => f.path !== entry.path),
    ].slice(0, 20);

    // Invalidate structure cache
    this.state.project.structure = null;

    this.bus.emit('worldstate:file-changed', { path: entry.path }, { source: 'WorldState' });
  }

  updateGitStatus(status) {
    this.state.project.gitStatus = status;
  }

  updateOllamaModels(models) {
    this.state.runtime.ollamaModels = models;
  }

  updateOllamaStatus(status) {
    this.state.runtime.ollamaStatus = status;
  }

  updateMemoryUsage() {
    const os = require('os');
    this.state.runtime.memoryUsage = process.memoryUsage();
    // FIX v4.12.8: Include system memory so LLM doesn't need to shell out
    // for `free -h` (Linux) or `wmic` (Windows). Available in prompt context.
    this.state.runtime.systemMemory = {
      totalMB: Math.round(os.totalmem() / (1024 * 1024)),
      freeMB: Math.round(os.freemem() / (1024 * 1024)),
      usedPercent: Math.round((1 - os.freemem() / os.totalmem()) * 100),
    };
  }

  updateCircuitState(state) {
    this.state.runtime.circuitState = state;
  }

  recordUserTopic(topic) {
    this.state.user.recentTopics = [
      topic,
      ...this.state.user.recentTopics.filter(t => t !== topic),
    ].slice(0, 10);
  }

  updateUserExpertise(topic, level) {
    this.state.user.expertise[topic] = Math.max(0, Math.min(1, level));
  }

  setUserName(name) {
    this.state.user.name = name;
  }

  markFileModified(filePath) {
    this.recordFileChange(
      path.isAbsolute(filePath) ? filePath : path.resolve(this.rootDir, filePath)
    );
  }

  // ════════════════════════════════════════════════════════
  // CAUSAL TRACKING: SNAPSHOT / DIFF (v7.0.9 Phase 1)
  // ════════════════════════════════════════════════════════

  /**
   * Capture a deep copy of the current state for before/after comparison.
   * Used by CausalAnnotation to attribute WorldState changes to specific Steps.
   * @returns {{ project: *, runtime: *, user: *, system: *, timestamp: number }}
   */
  snapshot() {
    return {
      project: {
        recentlyModified: [...(this.state.project.recentlyModified || [])].map(f => ({ ...f })),
        gitStatus: this.state.project.gitStatus ? { ...this.state.project.gitStatus } : null,
        testScript: this.state.project.testScript,
      },
      runtime: {
        ollamaStatus: this.state.runtime.ollamaStatus,
        circuitState: this.state.runtime.circuitState,
        activeGoals: [...(this.state.runtime.activeGoals || [])],
      },
      user: {
        recentTopics: [...(this.state.user.recentTopics || [])],
        expertise: { ...this.state.user.expertise },
      },
      system: {}, // system rarely changes — omit from diff
      timestamp: Date.now(),
    };
  }

  /**
   * Compute the delta between two snapshots.
   * Returns a list of concrete changes: { field, type, before, after }
   * @param {object} before - Snapshot from before step execution
   * @param {object} after - Snapshot from after step execution
   * @returns {{ changes: Array<{ field: string, type: string, before: *, after: * }> }}
   */
  diff(before, after) {
    const changes = [];
    this._diffObj(before, after, '', changes);
    return { changes };
  }

  /** @private Recursive diff helper */
  _diffObj(a, b, prefix, changes) {
    if (a === b) return;
    if (a == null || b == null || typeof a !== typeof b) {
      if (a !== b) changes.push({ field: prefix || 'root', type: a == null ? 'add' : b == null ? 'remove' : 'change', before: a, after: b });
      return;
    }
    if (Array.isArray(a) && Array.isArray(b)) {
      if (JSON.stringify(a) !== JSON.stringify(b)) {
        changes.push({ field: prefix, type: 'change', before: `[${a.length} items]`, after: `[${b.length} items]` });
      }
      return;
    }
    if (typeof a === 'object') {
      const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
      for (const key of keys) {
        this._diffObj(a[key], b[key], prefix ? `${prefix}.${key}` : key, changes);
      }
      return;
    }
    if (a !== b) {
      changes.push({ field: prefix, type: 'change', before: a, after: b });
    }
  }

  // ════════════════════════════════════════════════════════
  // CONTEXT BUILDING (for PromptBuilder)
  // ════════════════════════════════════════════════════════

  // buildContextSlice() extracted to WorldStateQueries.js (FIX v5.1.0 A-3)

  // ════════════════════════════════════════════════════════
  // PERSISTENCE
  // ════════════════════════════════════════════════════════

  save() {
    if (!this.storage) return;
    try {
      this.storage.writeJSONDebounced('world-state.json', this._persistData());
    } catch (err) { _log.debug('[WORLD-STATE] Save error:', err.message); }
  }

  /** FIX v5.1.0 (C-1): Sync write for shutdown. */
  saveSync() {
    if (!this.storage) return;
    try {
      this.storage.writeJSON('world-state.json', this._persistData());
    } catch (err) { _log.debug('[WORLD-STATE] Sync save error:', err.message); }
  }

  _persistData() {
    return {
      user: this.state.user,
      recentlyModified: this.state.project.recentlyModified,
    };
  }

  // ════════════════════════════════════════════════════════
  // INTERNAL
  // ════════════════════════════════════════════════════════

  /**
   * v3.8.0: Async boot-time data loading.
   * Called by Container.bootAll() after all services are resolved.
   * Replaces sync this._load() that was previously in the constructor.
   */
  async asyncLoad() {
    this._load();
  }


  _load() {
    if (!this.storage) return;
    try {
      const data = this.storage.readJSON('world-state.json', null);
      if (!data) return;
      // FIX v4.13.1 (Audit F-02): Safe merge — filters __proto__, constructor,
      // and prototype keys to prevent Prototype Pollution via crafted JSON.
      if (data.user && typeof data.user === 'object' && !Array.isArray(data.user)) {
        for (const key of Object.keys(data.user)) {
          if (key === '__proto__' || key === 'constructor' || key === 'prototype') continue;
          this.state.user[key] = data.user[key];
        }
      }
      if (data.recentlyModified) this.state.project.recentlyModified = data.recentlyModified;
    } catch (err) { _log.debug('[WORLD-STATE] Load error:', err.message); }
  }

  _initProject() {
    // Read package.json
    const pkgPath = path.join(this.rootDir, 'package.json');
    if (fs.existsSync(pkgPath)) {
      try {
        const pkg = safeJsonParse(fs.readFileSync(pkgPath, 'utf-8'), {}, 'WorldState');
        this.state.project.packageJson = {
          name: pkg.name,
          version: pkg.version,
          scripts: Object.keys(pkg.scripts || {}),
          dependencies: Object.keys(pkg.dependencies || {}),
          devDependencies: Object.keys(pkg.devDependencies || {}),
        };
        this.state.project.testScript = pkg.scripts?.test || null;
      } catch (err) { _log.debug('[WORLD-STATE] package.json parse error:', err.message); }
    }

    // Identify kernel files
    if (this.guard) {
      try {
        const integrity = this.guard.verifyIntegrity();
        if (integrity.files) {
          for (const f of integrity.files) {
            this._kernelFiles.add(path.resolve(this.rootDir, f));
          }
        }
      } catch (_e) { _log.debug('[catch] guard might not expose file list:', _e.message); }
    }

    // Fallback: known kernel files
    for (const kernelFile of ['main.js', 'preload.js', 'src/kernel/SafeGuard.js', 'src/kernel/bootstrap.js']) {
      this._kernelFiles.add(path.resolve(this.rootDir, kernelFile));
    }

    // Initial git status (async, fire-and-forget from constructor)
    this._pollGitStatus().catch(() => { /* best effort */ });
  }

  _initSystem() {
    const os = require('os');
    this.state.system.totalRAM = Math.round(os.totalmem() / (1024 * 1024));
    this.state.system.cpuCores = os.cpus().length;
  }

  // _isKernelFile, _getFileSize, _scanStructure → WorldStateQueries.js

  // FIX v3.5.0: Async git polling — no longer blocks main thread
  // FIX v4.0.1: execFileAsync with array args — no shell spawned
  async _pollGitStatus() {
    const opts = { cwd: this.rootDir, encoding: 'utf-8', timeout: TIMEOUTS.QUICK_CHECK, windowsHide: true };
    try {
      // FIX v6.0.3 (M-3): Use allSettled so branch failure doesn't lose status data
      const [branchResult, statusResult] = await Promise.allSettled([
        execFileAsync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], opts),
        execFileAsync('git', ['status', '--porcelain'], opts),
      ]);

      const branch = branchResult.status === 'fulfilled' ? branchResult.value.stdout.trim() : 'unknown';
      const status = statusResult.status === 'fulfilled' ? statusResult.value.stdout.trim() : '';

      let lastCommitMsg = '';
      try {
        const logResult = await execFileAsync('git', ['log', '-1', '--pretty=%s'], opts);
        lastCommitMsg = logResult.stdout.trim();
      } catch (_e) { _log.debug('[catch] no commits yet:', _e.message); }

      const dirtyFiles = status ? status.split('\n').map(l => l.trim()).filter(Boolean) : [];

      this.state.project.gitStatus = {
        branch,
        dirty: dirtyFiles.length > 0,
        dirtyCount: dirtyFiles.length,
        lastCommitMsg,
        stagedFiles: dirtyFiles.filter(l => l.startsWith('A ') || l.startsWith('M ')).length,
      };
    } catch (_e) { _log.debug("[catch] git status:", _e.message);
      this.state.project.gitStatus = null; // Not a git repo
    }
  }
}

// v5.4.0: WorldStateSnapshot extracted to WorldStateSnapshot.js
const { WorldStateSnapshot } = require('./WorldStateSnapshot');

// FIX v5.1.0 (A-3): Apply extracted query methods to prototype.
// This keeps WorldState.js focused on mutations/lifecycle and WorldStateQueries.js
// on read-only queries - CQRS-lite split that resolves the God Object finding.
const { applyQueries } = require('./WorldStateQueries');
applyQueries(WorldState);

module.exports = { WorldState, WorldStateSnapshot };
