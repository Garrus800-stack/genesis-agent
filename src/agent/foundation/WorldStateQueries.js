// @ts-checked-v5.7
// ============================================================
// GENESIS — WorldStateQueries.js (FIX v5.1.0 — A-3)
//
// Extracted query/read methods from WorldState.js to resolve
// the God Object finding (53 methods → threshold 50).
//
// This module defines methods on WorldState.prototype so they
// are available on every WorldState instance. WorldState.js
// requires this module at the end of the file.
//
// Pattern: Query/Command Separation (CQRS-lite)
//   WorldState.js       → state mutations, lifecycle, persistence
//   WorldStateQueries.js → read-only queries, preconditions, context
// ============================================================

'use strict';

const path = require('path');
const { TIMEOUTS } = require('../core/Constants');
const fs = require('fs');
const { createLogger } = require('../core/Logger');
const _log = createLogger('WorldState');

/**
 * Apply query methods to WorldState.prototype.
 * @param {Function} WorldState - The WorldState class
 */
function applyQueries(WorldState) {
  const proto = WorldState.prototype;

  // ════════════════════════════════════════════════════════
  // QUERY API (read current state)
  // ════════════════════════════════════════════════════════

  proto.getProjectStructure = function() {
    if (!this.state.project.structure) {
      this.state.project.structure = this._scanStructure(/** @type {any} */ (this).rootDir, 2);
    }
    return this.state.project.structure;
  };

  proto.getGitStatus = function() { return this.state.project.gitStatus; };
  proto.getAvailableModels = function() { return this.state.runtime.ollamaModels; };
  proto.getOllamaStatus = function() { return this.state.runtime.ollamaStatus; };
  proto.getUserExpertise = function(topic) { return this.state.user.expertise[topic] || 0; };
  proto.getRecentTopics = function() { return this.state.user.recentTopics; };
  proto.getRecentlyModified = function() { return this.state.project.recentlyModified; };

  proto.getRuntime = function() {
    return { ...this.state.runtime, uptime: Date.now() - this.state.runtime.bootTime };
  };

  proto.getSystem = function() { return { ...this.state.system }; };

  proto.getFullState = function() {
    return JSON.parse(JSON.stringify(this.state));
  };

  // ════════════════════════════════════════════════════════
  // PRECONDITION API (used by FormalPlanner + PlanVerifier)
  // ════════════════════════════════════════════════════════

  proto.canWriteFile = function(filePath) {
    if (!filePath) return false;
    const resolved = path.isAbsolute(filePath)
      ? filePath
      : path.resolve(/** @type {any} */ (this).rootDir, filePath);
    if (!resolved.startsWith(/** @type {any} */ (this).rootDir + path.sep) && resolved !== /** @type {any} */ (this).rootDir) return false;
    if (this._isKernelFile(resolved)) return false;
    if (resolved.includes(path.sep + 'node_modules' + path.sep)) return false;
    if (resolved.includes(path.sep + '.git' + path.sep)) return false;
    return true;
  };

  proto.isKernelFile = function(filePath) {
    const resolved = path.isAbsolute(filePath)
      ? filePath
      : path.resolve(/** @type {any} */ (this).rootDir, filePath);
    return this._isKernelFile(resolved);
  };

  proto.canRunTests = function() {
    return this.state.project.testScript !== null;
  };

  proto.canUseModel = function(modelName) {
    if (!modelName) return this.state.runtime.ollamaStatus === 'running';
    return this.state.runtime.ollamaModels.some(m =>
      m === modelName || m.startsWith(modelName + ':')
    );
  };

  proto.canRunShell = function(command) {
    if (!command) return false;
    const lower = command.toLowerCase();
    for (const blocked of this._shellBlocklist) {
      if (lower.includes(blocked)) return false;
    }
    return true;
  };

  proto.isGitClean = function() {
    return this.state.project.gitStatus?.dirty === false;
  };

  proto.hasFreeDiskSpace = function(requiredMB = 100) {
    if (typeof this._cachedFreeMB === 'number') {
      return this._cachedFreeMB >= requiredMB;
    }
    try {
      const isWin = process.platform === 'win32';
      let freeMB = 0;
      const { execFileSync } = require('child_process');
      if (isWin) {
        const drive = /** @type {any} */ (this).rootDir.charAt(0);
        const psScript = `(Get-PSDrive ${drive}).Free`;
        const encoded = Buffer.from(psScript, 'utf16le').toString('base64');
        const stdout = execFileSync('powershell',
          ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded],
          { timeout: TIMEOUTS.GIT_OP, windowsHide: true, encoding: 'utf-8' }
        ).toString().trim();
        freeMB = Math.floor(parseInt(stdout) / (1024 * 1024));
      } else {
        const stdout = execFileSync('df', ['-Pm', /** @type {any} */ (this).rootDir],
          { timeout: TIMEOUTS.QUICK_CHECK, encoding: 'utf-8' }
        ).toString().trim();
        const lines = stdout.split('\n');
        const parts = (lines[1] || '').split(/\s+/);
        freeMB = parseInt(parts[3]) || 0;
      }
      this._cachedFreeMB = freeMB;
      return freeMB >= requiredMB;
    } catch (_e) {
      _log.debug("[catch] disk check:", _e.message);
      return true;
    }
  };

  proto.refreshDiskSpace = async function() {
    try {
      const { execFile } = require('child_process');
      const { promisify } = require('util');
      const execFileAsync = promisify(execFile);
      const isWin = process.platform === 'win32';
      if (isWin) {
        const drive = /** @type {any} */ (this).rootDir.charAt(0);
        const psScript = `(Get-PSDrive ${drive}).Free`;
        const encoded = Buffer.from(psScript, 'utf16le').toString('base64');
        const { stdout } = await execFileAsync('powershell',
          ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded],
          { timeout: TIMEOUTS.GIT_OP, windowsHide: true, encoding: 'utf-8' }
        );
        this._cachedFreeMB = Math.floor(parseInt(stdout.toString().trim()) / (1024 * 1024));
      } else {
        const { stdout } = await execFileAsync('df', ['-Pm', /** @type {any} */ (this).rootDir],
          { timeout: TIMEOUTS.QUICK_CHECK, encoding: 'utf-8' }
        );
        const parts = (stdout.toString().trim().split('\n')[1] || '').split(/\s+/);
        this._cachedFreeMB = parseInt(parts[3]) || 0;
      }
    } catch (_e) {
      _log.debug('[catch] async disk check:', _e.message);
    }
  };

  // ════════════════════════════════════════════════════════
  // CONTEXT BUILDER
  // ════════════════════════════════════════════════════════

  proto.buildContextSlice = function(relevantKeys = []) {
    const parts = [];
    if (relevantKeys.includes('project') || relevantKeys.length === 0) {
      const modified = this.state.project.recentlyModified.slice(0, 5);
      if (modified.length > 0) {
        parts.push(`RECENT FILES: ${modified.map(f => f.path).join(', ')}`);
      }
    }
    if (relevantKeys.includes('git')) {
      const git = this.state.project.gitStatus;
      if (git) {
        parts.push(`GIT: branch=${git.branch}, dirty=${git.dirty}, last=${git.lastCommitMsg || 'unknown'}`);
      }
    }
    if (relevantKeys.includes('models')) {
      parts.push(`OLLAMA: ${this.state.runtime.ollamaStatus}, models=[${this.state.runtime.ollamaModels.join(', ')}]`);
    }
    if (relevantKeys.includes('user')) {
      const u = this.state.user;
      if (u.name) parts.push(`USER: ${u.name}`);
      if (u.recentTopics.length > 0) {
        parts.push(`RECENT TOPICS: ${u.recentTopics.slice(0, 3).join(', ')}`);
      }
    }
    if (relevantKeys.includes('system')) {
      parts.push(`SYSTEM: ${this.state.system.platform}/${this.state.system.arch}, Node ${this.state.system.nodeVersion}`);
      const sysMem = this.state.runtime.systemMemory;
      if (sysMem) {
        parts.push(`RAM: ${sysMem.freeMB}MB free / ${sysMem.totalMB}MB total (${sysMem.usedPercent}% used)`);
      }
    }
    return parts.length > 0 ? parts.join('\n') : '';
  };

  // ════════════════════════════════════════════════════════
  // PRIVATE HELPERS (used by queries)
  // ════════════════════════════════════════════════════════

  proto._isKernelFile = function(resolvedPath) {
    return this._kernelFiles.has(resolvedPath);
  };

  proto._getFileSize = function(filePath) {
    try { return fs.statSync(filePath).size; }
    catch (_e) { _log.debug('[catch] filesystem op:', _e.message); return 0; }
  };

  proto._scanStructure = function(dir, depth) {
    if (depth <= 0) return null;
    const result = {};
    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
        if (entry.isDirectory()) {
          result[entry.name + '/'] = this._scanStructure(path.join(dir, entry.name), depth - 1);
        } else {
          result[entry.name] = null;
        }
      }
    } catch (_e) { _log.debug('[catch] permission denied etc:', _e.message); }
    return result;
  };
}

module.exports = { applyQueries };
