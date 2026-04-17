// @ts-checked-v5.7
// ============================================================
// GENESIS AGENT — SelfModel.js (v4.0.0 — Fully Async Git)
// The agent's living map of itself.
// Knows every file, module, dependency, capability.
//
// FIX v3.8.0: All git operations migrated from execSync (shell=true)
// to execFileSync (no shell). Prevents shell injection via commit
// messages containing backticks, $(), newlines, or other shell
// metacharacters.
//
// FIX v4.0.0: commitSnapshot() and rollback() migrated from
// execFileSync to async execFileAsync. These are called during
// self-modification and shutdown — both paths where blocking the
// Electron main thread for 200-500ms causes visible UI freezes.
// Initial git setup in scan() remains sync (runs once at boot,
// before the window is interactive).
// ============================================================

const path = require('path');
const { TIMEOUTS } = require('../core/Constants');
const fs = require('fs');
const fsp = require('fs').promises;
const crypto = require('crypto');
const { execFileSync, execFile } = require('child_process');
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
    /** @type {{ identity: string, version: string, scannedAt: string|null, modules: object, files: object, capabilities: string[], dependencies: object }} */
    this.manifest = {
      identity: 'genesis',
      version: '0.1.0',
      scannedAt: null,
      modules: {},
      files: {},
      capabilities: [],
      dependencies: {},
    };
    this.gitAvailable = false;
  }

  /** Scan the entire project and build the self-model */
  async scan() {
    this.manifest.scannedAt = new Date().toISOString();
    this.manifest.modules = {};
    this.manifest.files = {};

    // Scan all JS files recursively
    // FIX v3.8.0: Async I/O — no longer blocks main thread during boot
    await this._scanDirAsync(this.rootDir, '');

    // Detect capabilities from module analysis
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
    // FIX v4.10.0 (L-2): Full async git init — replaces 6 sequential execFileSync calls.
    // Previous comment (v4.0.0 line 15) noted this was planned: "Initial git setup in
    // scan() remains sync (runs once at boot, before the window is interactive)."
    // On Windows with cold PowerShell, git init + config + add + commit can take 2-4s,
    // which blocks the main thread and delays window rendering.
    try {
      await execFileAsync('git', ['--version'], _gitOpts(this.rootDir));
      this.gitAvailable = true;

      // Init git if not already
      if (!fs.existsSync(path.join(this.rootDir, '.git'))) {
        await execFileAsync('git', ['init'], _gitOpts(this.rootDir));
        // Ensure git user is configured (required for commit on fresh Windows installs)
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

  // FIX v3.8.0: Async directory scan — replaces sync _scanDir().
  // Uses fs.promises to avoid blocking the main thread during boot.
  // On a 100+ module project, sync scan blocked for ~50-80ms.
  async _scanDirAsync(dir, relativeBase) {
    const IGNORE = ['node_modules', '.git', '.genesis', 'sandbox', 'dist'];
    let entries;
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch (err) { _log.debug('[SELF-MODEL] Cannot read dir:', dir, err.message); return; }

    for (const entry of entries) {
      if (IGNORE.includes(entry.name)) continue;
      const fullPath = path.join(dir, entry.name);
      const relativePath = path.join(relativeBase, entry.name).replace(/\\/g, '/');

      if (entry.isDirectory()) {
        await this._scanDirAsync(fullPath, relativePath);
      } else if (entry.isFile()) {
        const content = await fsp.readFile(fullPath, 'utf-8');
        const hash = crypto.createHash('sha256').update(content).digest('hex').slice(0, 12);
        const lines = content.split('\n').length;

        this.manifest.files[relativePath] = {
          hash,
          lines,
          size: content.length,
          protected: this.guard.isProtected(fullPath),
        };

        // Parse JS modules for deeper understanding
        if (entry.name.endsWith('.js')) {
          const moduleInfo = this._parseModule(content, relativePath);
          if (moduleInfo) {
            this.manifest.modules[relativePath] = moduleInfo;
          }
        }
      }
    }
  }

  // Sync fallback for callers that can't await (e.g. tests, quick checks)
  _scanDir(dir, relativeBase) {
    const IGNORE = ['node_modules', '.git', '.genesis', 'sandbox', 'dist'];
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (err) { _log.debug('[SELF-MODEL] Cannot read dir:', dir, err.message); return; }

    for (const entry of entries) {
      if (IGNORE.includes(entry.name)) continue;
      const fullPath = path.join(dir, entry.name);
      const relativePath = path.join(relativeBase, entry.name).replace(/\\/g, '/');

      if (entry.isDirectory()) {
        this._scanDir(fullPath, relativePath);
      } else if (entry.isFile()) {
        const content = fs.readFileSync(fullPath, 'utf-8');
        const hash = crypto.createHash('sha256').update(content).digest('hex').slice(0, 12);
        const lines = content.split('\n').length;

        this.manifest.files[relativePath] = {
          hash,
          lines,
          size: content.length,
          protected: this.guard.isProtected(fullPath),
        };

        if (entry.name.endsWith('.js')) {
          const moduleInfo = this._parseModule(content, relativePath);
          if (moduleInfo) {
            this.manifest.modules[relativePath] = moduleInfo;
          }
        }
      }
    }
  }

  _parseModule(code, filePath) {
    const info = {
      file: filePath,
      /** @type {string[]} */ classes: [],
      /** @type {string[]} */ functions: [],
      /** @type {string[]} */ exports: [],
      /** @type {string[]} */ requires: [],
      description: '',
    };

    // Extract header comment as description
    const headerMatch = code.match(/^\/\/[^\n]*\n(?:\/\/[^\n]*\n)*/);
    if (headerMatch) {
      info.description = headerMatch[0]
        .split('\n')
        .map(l => l.replace(/^\/\/\s*/, '').replace(/=+/g, '').trim())
        .filter(l => l && !l.startsWith('GENESIS'))
        .join(' ')
        .trim();
    }

    // Extract class names
    const classMatches = code.matchAll(/class\s+(\w+)/g);
    for (const m of classMatches) info.classes.push(m[1]);

    // Extract function names (top-level and method-like)
    const fnMatches = code.matchAll(/(?:async\s+)?(\w+)\s*\([^)]*\)\s*{/g);
    for (const m of fnMatches) {
      if (!['if', 'for', 'while', 'switch', 'catch'].includes(m[1])) {
        info.functions.push(m[1]);
      }
    }

    // Extract requires — skip those inside string literals (e.g. benchmark task inputs)
    // Strategy: strip string contents per line, then check if require() is at code level
    const lines = code.split('\n');
    for (const line of lines) {
      // Remove string contents (replace with empty) to detect code-level require()
      // This handles: 'string with require("x")' → '...' (require disappears)
      // But keeps: const x = require("./db") → const x = require("") (require stays)
      const stripped = line
        .replace(/'(?:[^'\\]|\\.)*'/g, "''")
        .replace(/"(?:[^"\\]|\\.)*"/g, '""')
        .replace(/`(?:[^`\\]|\\.)*`/g, '``');

      // If require() survives stripping, it's a real code-level call
      if (/\brequire\s*\(/.test(stripped)) {
        const lineReqs = line.matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g);
        for (const m of lineReqs) info.requires.push(m[1]);
      }
    }

    // Extract exports
    const expMatch = code.match(/module\.exports\s*=\s*{([^}]+)}/);
    if (expMatch) {
      info.exports = expMatch[1].split(',').map(s => s.trim()).filter(Boolean);
    }

    return info;
  }

  _detectCapabilities() {
    const caps = ['chat', 'self-awareness'];
    const modules = Object.values(this.manifest.modules);
    const allClasses = modules.flatMap(m => m.classes);

    if (allClasses.includes('Sandbox')) caps.push('code-execution');
    if (allClasses.includes('Reflector')) caps.push('self-reflection', 'self-repair');
    if (allClasses.includes('SkillManager')) caps.push('skill-creation');
    if (allClasses.includes('CloneFactory')) caps.push('self-cloning');
    if (allClasses.includes('ModelBridge')) caps.push('model-switching');
    if (allClasses.includes('CodeAnalyzer')) caps.push('code-analysis');

    return caps;
  }

  // ── Public API ───────────────────────────────────────────

  getFullModel() {
    return { ...this.manifest };
  }

  getModuleSummary() {
    // v7.1.9: Only source modules, not tests or scripts
    return Object.entries(this.manifest.modules)
      .filter(([file]) => file.startsWith('src/'))
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

  moduleCount() {
    // v7.1.9: Count only source modules (src/), not tests or scripts
    return Object.keys(this.manifest.modules)
      .filter(p => p.startsWith('src/'))
      .length;
  }

  readModule(fileOrName) {
    // Accept either full path or class name
    let filePath = fileOrName;
    if (!fileOrName.includes('/')) {
      const entry = Object.entries(this.manifest.modules)
        .find(([_, m]) => m.classes.includes(fileOrName) || m.file.includes(fileOrName));
      if (entry) filePath = entry[0];
    }

    const fullPath = path.join(this.rootDir, filePath);
    // FIX v6.1.1: Guard against EISDIR — skip directories
    if (fs.existsSync(fullPath) && fs.statSync(fullPath).isFile()) {
      return fs.readFileSync(fullPath, 'utf-8');
    }
    return null;
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

  // FIX v4.0.0: Fully async git commit — no main-thread blocking.
  // Previous: execFileSync blocked for 200-500ms per commit.
  // Called during self-modification (multiple times) and shutdown.
  async commitSnapshot(message) {
    if (!this.gitAvailable) return;
    try {
      await execFileAsync('git', ['add', '-A'], _gitOpts(this.rootDir));
      await execFileAsync('git', ['commit', '-m', String(message), '--allow-empty'], _gitOpts(this.rootDir));
    } catch (err) {
      // v7.2.3: Filter benign Git housekeeping output.
      // Git's `gc --auto` can trigger during commit and emit "Auto packing"
      // on stderr with a non-zero exit code, even though the commit itself
      // succeeded. That's Git being loud about housekeeping, not a failure.
      // Without this filter, every shutdown logged a WARN for a success.
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
    await execFileAsync('git', ['revert', 'HEAD', '--no-edit'], _gitOpts(this.rootDir));
    await this.scan();
  }
}

module.exports = { SelfModel };
