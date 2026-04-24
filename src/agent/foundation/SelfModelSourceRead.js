// ============================================================
// GENESIS — SelfModelSourceRead.js (v7.4.1)
//
// Extracted from SelfModel.js to keep the main file under the
// 700-LOC threshold. Contains all source-reading methods:
//   - readModule          — sync read by path or class name
//   - readModuleAsync     — async read with TTL cache (idle-time)
//   - readSourceSync      — budget-enforced sync read (chat-time)
//   - describeModule      — metadata lookup without disk read
//   - startReadSourceTurn — turn boundary signal
//   - getReadSourceBudget — budget state getter
//   - resetReadSourceSession — session reset
//   - wireHotReloadInvalidation — cache invalidation wiring
//   - clearReadCache      — explicit cache clear
//
// Prototype delegation from the bottom of SelfModel.js.
// External API unchanged.
// ============================================================

'use strict';

const path = require('path');
const fs = require('fs');
const fsp = require('fs').promises;
const { createLogger } = require('../core/Logger');
const _log = createLogger('SelfModel');

const selfModelSourceRead = {

  readModule(fileOrName) {
    let filePath = fileOrName;
    if (!fileOrName.includes('/') && !fileOrName.includes('\\')) {
      const entries = Object.entries(this.manifest.modules)
        .filter(([_, m]) => m.classes.includes(fileOrName) || m.file.includes(fileOrName));
      if (entries.length > 0) {
        const prioritized = entries.find(([p]) => p.replace(/\\/g, '/').startsWith('src/')) || entries[0];
        filePath = prioritized[0];
      }
    }

    const fullPath = path.join(this.rootDir, filePath);
    // FIX v6.1.1: Guard against EISDIR — skip directories
    if (fs.existsSync(fullPath) && fs.statSync(fullPath).isFile()) {
      return fs.readFileSync(fullPath, 'utf-8');
    }
    return null;
  },

  /**
   * v7.3.6 #9: Synchronous source read for chat context. Budget-enforced.
   *
   * Budget semantics:
   *   - Soft per-turn (5): warning event, content still returned.
   *   - Hard per-turn (10): block — returns null.
   *   - Hard per-session (20): block — session-wide cap.
   *   - File-size cap (20 KB): truncates content with a marker.
   *
   * @param {string} filePath - path relative to rootDir, or absolute
   * @param {{ bus?: object }} [opts]
   * @returns {string|null}
   */
  readSourceSync(filePath, opts = {}) {
    const state = this._readSourceState;
    const budget = this._readSourceBudget;

    // Hard per-session check
    if (state.sessionCount >= budget.hardPerSession) {
      return null;
    }
    // Hard per-turn check
    if (state.turnCount >= budget.hardPerTurn) {
      return null;
    }

    // Resolve path
    const absPath = path.isAbsolute(filePath)
      ? filePath
      : path.join(this.rootDir, filePath);

    // Cache hit
    const cached = state.sessionCache.get(absPath);
    if (cached !== undefined) {
      state.turnCount++;
      state.sessionCount++;
      return cached;
    }

    // Validate via SafeGuard
    try {
      this.guard.validateRead(absPath);
    } catch (_err) {
      return null;
    }

    // Read from disk
    let content;
    try {
      if (!fs.existsSync(absPath) || !fs.statSync(absPath).isFile()) {
        return null;
      }
      content = fs.readFileSync(absPath, 'utf-8');
    } catch (_err) {
      return null;
    }

    // Truncate if over size cap
    let bytes = Buffer.byteLength(content, 'utf-8');
    if (bytes > budget.maxFileBytes) {
      content = content.slice(0, budget.maxFileBytes) +
        `\n\n[... truncated, full file is ${bytes} bytes, cap is ${budget.maxFileBytes}]`;
      bytes = budget.maxFileBytes;
    }

    // Cache + increment counters
    state.sessionCache.set(absPath, content);
    state.turnCount++;
    state.sessionCount++;

    // Emit telemetry
    const bus = opts.bus;
    if (bus && typeof bus.fire === 'function') {
      try {
        const payload = { path: filePath, bytes };
        if (state.currentTurnId) payload.turnId = state.currentTurnId;
        bus.fire('read-source:called', payload, { source: 'SelfModel' });
        if (state.turnCount === budget.softPerTurn) {
          const softPayload = {
            turnCount: state.turnCount,
            softLimit: budget.softPerTurn,
            hardLimit: budget.hardPerTurn,
          };
          if (state.currentTurnId) softPayload.turnId = state.currentTurnId;
          bus.fire('read-source:soft-limit', softPayload, { source: 'SelfModel' });
        }
      } catch (_e) { /* bus may be NullBus */ }
    }

    return content;
  },

  startReadSourceTurn(turnId) {
    this._readSourceState.turnCount = 0;
    this._readSourceState.currentTurnId = turnId || null;
  },

  getReadSourceBudget() {
    return {
      ...this._readSourceBudget,
      turnCount: this._readSourceState.turnCount,
      sessionCount: this._readSourceState.sessionCount,
      currentTurnId: this._readSourceState.currentTurnId,
      cacheSize: this._readSourceState.sessionCache.size,
    };
  },

  resetReadSourceSession() {
    this._readSourceState.turnCount = 0;
    this._readSourceState.sessionCount = 0;
    this._readSourceState.currentTurnId = null;
    this._readSourceState.sessionCache.clear();
  },

  /**
   * v7.3.1: Async variant of readModule. Preferred for idle-time reads.
   * Uses TTL cache (5min) invalidated on hot-reload:success events.
   *
   * @param {string} fileOrName - full path or class name
   * @returns {Promise<string|null>}
   */
  async readModuleAsync(fileOrName) {
    let filePath = fileOrName;
    if (!fileOrName.includes('/') && !fileOrName.includes('\\')) {
      const entries = Object.entries(this.manifest.modules)
        .filter(([_, m]) => m.classes.includes(fileOrName) || m.file.includes(fileOrName));
      if (entries.length > 0) {
        const prioritized = entries.find(([p]) => p.replace(/\\/g, '/').startsWith('src/')) || entries[0];
        filePath = prioritized[0];
      }
    }

    // Check cache
    const cacheKey = filePath;
    const cached = this._readCache.get(cacheKey);
    if (cached && Date.now() - cached.loadedAt < this._readCacheTTL) {
      this._readCache.delete(cacheKey);
      this._readCache.set(cacheKey, cached);
      return cached.content;
    }

    // Cache miss or stale — read from disk
    const fullPath = path.join(this.rootDir, filePath);
    try {
      const stat = await fsp.stat(fullPath);
      if (!stat.isFile()) return null;
      const content = await fsp.readFile(fullPath, 'utf-8');

      this._readCache.set(cacheKey, { content, loadedAt: Date.now() });
      while (this._readCache.size > this._readCacheMax) {
        const firstKey = this._readCache.keys().next().value;
        this._readCache.delete(firstKey);
      }

      return content;
    } catch (_e) {
      return null;
    }
  },

  describeModule(fileOrName) {
    let filePath = fileOrName;
    if (!fileOrName.includes('/') && !fileOrName.includes('\\')) {
      const entries = Object.entries(this.manifest.modules)
        .filter(([_, m]) => m.classes.includes(fileOrName) || m.file.includes(fileOrName));
      if (entries.length === 0) return null;
      const prioritized = entries.find(([p]) => p.replace(/\\/g, '/').startsWith('src/')) || entries[0];
      filePath = prioritized[0];
    }

    const mod = this.manifest.modules[filePath];
    if (!mod) return null;

    const fileInfo = this.manifest.files[filePath] || {};
    const isCapability = (this.manifest.capabilitiesDetailed || [])
      .some(c => c.module === filePath.replace(/\\/g, '/'));

    return {
      file: filePath,
      classes: mod.classes || [],
      functions: (mod.functions || []).map(f => typeof f === 'string' ? f : f.name),
      requires: mod.requires || [],
      description: mod.description || '',
      exports: mod.exports || [],
      loc: fileInfo.lines || 0,
      protected: fileInfo.protected || false,
      isCapability,
    };
  },

  wireHotReloadInvalidation(bus) {
    if (!bus || typeof bus.on !== 'function') return;
    if (this._hotReloadUnsub) {
      try { this._hotReloadUnsub(); } catch (_e) { /* ignore */ }
      this._hotReloadUnsub = null;
    }
    const unsub = bus.on('hot-reload:success', (data) => {
      if (data && data.file) {
        this._readCache.delete(data.file);
      } else {
        this._readCache.clear();
      }
    }, { source: 'SelfModel' });
    this._hotReloadUnsub = typeof unsub === 'function' ? unsub : null;
  },

  clearReadCache() {
    this._readCache.clear();
  },
};

module.exports = { selfModelSourceRead };
