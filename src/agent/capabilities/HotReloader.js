// @ts-checked-v5.7
// ============================================================
// GENESIS AGENT — HotReloader.js
// Hot-reload modules without restarting the agent.
// When the agent modifies its own code, HotReloader can
// swap the module live — with rollback on failure.
// ============================================================

const fs = require('fs');
const path = require('path');
const { NullBus } = require('../core/EventBus');
const { createLogger } = require('../core/Logger');
const _log = createLogger('HotReloader');

// FIX v4.0.0 (F-02): Use acorn for syntax checking instead of new Function().
// new Function() is flagged as 'block' severity by our own CodeSafetyScanner.
// acorn is already a project dependency and provides the same syntax validation
// without touching the JS engine's code compilation pipeline.
let _acorn = null;
function _getAcorn() {
  if (_acorn) return _acorn;
  try { _acorn = require('acorn'); return _acorn; }
  catch (_e) { _log.debug('[catch] module load:', _e.message); return null; }
}

class HotReloader {
  constructor(rootDir, guard, bus) {
    this.bus = bus || NullBus;
    this.rootDir = rootDir;
    this.guard = guard;
    this.moduleCache = new Map();  // file → { module, hash, loadedAt }
    this.watchers = new Map();     // file → FSWatcher
    this.reloadCallbacks = new Map(); // file → callback(newModule)
  }

  /**
   * Register a module for hot-reloading
   * @param {string} filePath - Relative path from project root
   * @param {Function} onReload - Callback when module is reloaded: (newExports) => void
   */
  watch(filePath, onReload) {
    const fullPath = path.resolve(this.rootDir, filePath);

    // Don't watch kernel files
    if (this.guard.isProtected(fullPath)) {
      _log.info(`[HOT-RELOAD] Skipping protected file: ${filePath}`);
      return;
    }

    this.reloadCallbacks.set(filePath, onReload);

    // Cache current version
    if (fs.existsSync(fullPath)) {
      try {
        this._cacheModule(filePath, fullPath);
      } catch (err) {
        _log.warn(`[HOT-RELOAD] Initial cache failed for ${filePath}:`, err.message);
      }
    }

    // Watch for changes
    try {
      let debounceTimer = null;
      const watcher = fs.watch(fullPath, (eventType) => {
        if (eventType !== 'change') return;

        // Debounce: wait 200ms for writes to finish
        if (debounceTimer) clearTimeout(debounceTimer);
        debounceTimer = setTimeout(() => {
          this._handleChange(filePath, fullPath);
        }, 200);
      });

      this.watchers.set(filePath, watcher);
    } catch (err) {
      _log.warn(`[HOT-RELOAD] Watch failed for ${filePath}:`, err.message);
    }
  }

  /**
   * Manually trigger a reload (e.g., after self-modification)
   */
  async reload(filePath) {
    const fullPath = path.resolve(this.rootDir, filePath);
    return this._handleChange(filePath, fullPath);
  }

  /**
   * Stop watching a file
   */
  unwatch(filePath) {
    const watcher = this.watchers.get(filePath);
    if (watcher) {
      watcher.close();
      this.watchers.delete(filePath);
    }
    this.reloadCallbacks.delete(filePath);
    this.moduleCache.delete(filePath);
  }

  /**
   * Stop all watchers
   */
  unwatchAll() {
    for (const [file, watcher] of this.watchers) {
      watcher.close();
    }
    this.watchers.clear();
    this.reloadCallbacks.clear();
  }

  // ── Internal ─────────────────────────────────────────────

  async _handleChange(filePath, fullPath) {
    try {
      // Read new content
      if (!fs.existsSync(fullPath)) {
        _log.warn(`[HOT-RELOAD] File disappeared: ${filePath}`);
        return { success: false, error: 'File not found' };
      }

      const newContent = fs.readFileSync(fullPath, 'utf-8');
      const newHash = this._hash(newContent);

      // Check if actually changed
      const cached = this.moduleCache.get(filePath);
      if (cached && cached.hash === newHash) {
        return { success: true, changed: false };
      }

      // Syntax check before reloading
      // FIX v4.0.0 (F-02): acorn.parse() replaces new Function().
      // Consistent with CodeSafetyScanner which blocks new Function() at 'block' severity.
      try {
        const acorn = _getAcorn();
        if (acorn) {
          acorn.parse(newContent, { ecmaVersion: 'latest', sourceType: 'script', allowReturnOutsideFunction: true });
        } else {
          // Fallback: vm.Script is safer than new Function — no code compilation into a callable
          const vm = require('vm');
          new vm.Script(newContent, { filename: filePath });
        }
      } catch (syntaxErr) {
        _log.warn(`[HOT-RELOAD] Syntax error in ${filePath}, skipping reload`);
        this.bus.emit('hot-reload:syntax-error', {
          file: filePath,
          error: syntaxErr.message,
        }, { source: 'HotReloader' });
        return { success: false, error: `Syntax: ${syntaxErr.message}` };
      }

      // Clear from Node's require cache
      const resolvedPath = require.resolve(fullPath);
      const oldModule = require.cache[resolvedPath];
      delete require.cache[resolvedPath];

      // Try to require the new version
      let newModule;
      try {
        newModule = require(fullPath);
      } catch (err) {
        // Rollback: restore old module
        if (oldModule) {
          require.cache[resolvedPath] = oldModule;
        }
        _log.error(`[HOT-RELOAD] Load failed for ${filePath}, rolled back:`, err.message);
        this.bus.emit('hot-reload:failed', { file: filePath, error: err.message }, { source: 'HotReloader' });
        return { success: false, error: err.message };
      }

      // Success — update cache
      this.moduleCache.set(filePath, {
        module: newModule,
        hash: newHash,
        loadedAt: new Date().toISOString(),
        previousModule: oldModule || null, // v3.5.0: Keep for watchdog rollback
      });

      // Notify callback
      const callback = this.reloadCallbacks.get(filePath);
      if (callback) {
        try {
          await callback(newModule);
        } catch (cbErr) {
          _log.warn(`[HOT-RELOAD] Callback error for ${filePath}:`, cbErr.message);
        }
      }

      // v3.5.0: Watchdog — monitor for errors within 30s after reload.
      // If errors fire for this module, auto-rollback to previous version.
      this._startWatchdog(filePath, fullPath, resolvedPath, oldModule);

      _log.info(`[HOT-RELOAD] Reloaded: ${filePath}`);
      this.bus.emit('hot-reload:success', { file: filePath }, { source: 'HotReloader' });
      return { success: true, changed: true };
    } catch (err) {
      _log.error(`[HOT-RELOAD] Error:`, err.message);
      return { success: false, error: err.message };
    }
  }

  _cacheModule(filePath, fullPath) {
    const content = fs.readFileSync(fullPath, 'utf-8');
    this.moduleCache.set(filePath, {
      module: require(fullPath),
      hash: this._hash(content),
      loadedAt: new Date().toISOString(),
    });
  }

  _hash(content) {
    const crypto = require('crypto');
    return crypto.createHash('md5').update(content).digest('hex').slice(0, 10);
  }

  /** Get status of all watched modules */
  getStatus() {
    const status = {};
    for (const [file, cached] of this.moduleCache) {
      status[file] = {
        hash: cached.hash,
        loadedAt: cached.loadedAt,
        watching: this.watchers.has(file),
      };
    }
    return status;
  }

  // ── v3.5.0: Watchdog — auto-rollback on post-reload errors ──

  /**
   * Start a 30-second watchdog after a successful reload.
   * If uncaught errors referencing this module fire during the window,
   * automatically rollback to the previous version.
   */
  _startWatchdog(filePath, fullPath, resolvedPath, oldModule) {
    if (!oldModule) return; // Nothing to rollback to

    // Clear any existing watchdog for this file
    if (!this._watchdogTimers) this._watchdogTimers = new Map();
    const existing = this._watchdogTimers.get(filePath);
    if (existing) {
      clearTimeout(existing.timer);
      if (existing.unsub) existing.unsub();
    }

    let errorCount = 0;
    const WATCHDOG_WINDOW_MS = 30000;
    const ERROR_THRESHOLD = 3;

    // Listen for errors that reference this file
    const unsub = this.bus.on('agent:error', (data) => {
      const errStr = (data?.error || data?.message || data?.detail || '');
      const stack = data?.stack || '';
      if (errStr.includes(filePath) || stack.includes(filePath)) {
        errorCount++;
        if (errorCount >= ERROR_THRESHOLD) {
          this._rollbackModule(filePath, fullPath, resolvedPath, oldModule);
        }
      }
    }, { source: 'HotReloader:Watchdog', priority: 100 });

    const timer = setTimeout(() => {
      // Window passed without enough errors — watchdog stands down
      unsub();
      (/** @type {any} */ (this._watchdogTimers)).delete(filePath);
    }, WATCHDOG_WINDOW_MS);

    this._watchdogTimers.set(filePath, { timer, unsub });
  }

  /**
   * Rollback a hot-reloaded module to its previous version.
   */
  _rollbackModule(filePath, fullPath, resolvedPath, oldModule) {
    _log.warn(`[HOT-RELOAD:WATCHDOG] Rolling back ${filePath} — too many post-reload errors`);

    // Clear watchdog
    const wd = this._watchdogTimers?.get(filePath);
    if (wd) {
      clearTimeout(wd.timer);
      if (wd.unsub) wd.unsub();
      (/** @type {any} */ (this._watchdogTimers)).delete(filePath);
    }

    // Restore old module in require cache
    try {
      require.cache[resolvedPath] = oldModule;
      // Re-run callback with old module exports
      const callback = this.reloadCallbacks.get(filePath);
      if (callback && oldModule.exports) {
        callback(oldModule.exports);
      }
      this.bus.emit('hot-reload:rollback', { file: filePath, reason: 'watchdog' }, { source: 'HotReloader' });
      _log.info(`[HOT-RELOAD:WATCHDOG] Rollback complete: ${filePath}`);
    } catch (err) {
      _log.error(`[HOT-RELOAD:WATCHDOG] Rollback failed for ${filePath}:`, err.message);
    }
  }
}

module.exports = { HotReloader };
