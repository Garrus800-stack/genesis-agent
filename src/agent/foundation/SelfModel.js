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

    // v7.3.0: Manifest metadata injected by AgentCoreBoot before scan().
    // Maps serviceName → { tags: string[], phase: number, deps: string[] }.
    // Used by _detectCapabilities() to derive semantic tags from the DI
    // container's curated registration data.
    this._manifestMeta = null;

    // v7.3.1: readModule cache — TTL-based, invalidated on hot-reload:success.
    // Key: normalized file path. Value: { content, loadedAt }.
    // Caps total size at 50 entries (LRU via Map insertion order) to prevent
    // unbounded growth during long idle sessions of _read-source activity.
    this._readCache = new Map();
    this._readCacheTTL = 5 * 60 * 1000; // 5min
    this._readCacheMax = 50;

    // v7.3.1: hot-reload listener unsubscribe; wired lazily when bus is available.
    this._hotReloadUnsub = null;
  }

  /**
   * v7.3.0: Inject container metadata (service registrations with tags) before scan().
   * Called once from AgentCoreBoot after buildManifest() populates the container,
   * but before selfModel.scan() runs. Keeps SelfModel uncoupled from the Container —
   * it just receives data.
   *
   * v7.3.1: If scan() already ran, re-derives capabilities from the updated meta
   * without re-walking the filesystem. This is important both for correctness
   * (late-injected meta should be visible) and for testability (unit tests can
   * inject different meta against a single scanned fixture).
   *
   * @param {object} meta - Map of serviceName → { tags, phase, deps }
   */
  setManifestMeta(meta) {
    this._manifestMeta = meta || null;
    // If we've already scanned, re-run capability detection with the new meta.
    // scan() populated manifest.modules — which is all _detectCapabilities needs
    // besides the meta injection.
    if (this.manifest.scannedAt) {
      this.manifest.capabilities = this._detectCapabilities();
    }
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
    const IGNORE = ['node_modules', '.git', '.genesis', '.genesis-backups', 'sandbox', 'dist', 'vendor', 'coverage'];
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
    const IGNORE = ['node_modules', '.git', '.genesis', '.genesis-backups', 'sandbox', 'dist', 'vendor', 'coverage'];
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
    // v7.3.3 fix: Strip strings and comments first so class names inside a
    // string literal or comment (e.g. acorn's "class enum extends super") are
    // not mistaken for real class declarations. Also filter JS reserved words
    // that would otherwise end up as bogus "capabilities" like enum, static,
    // extends, method, field, getters, identifiers, foo.
    //
    // Important: string stripping is done PER LINE. Applied to the full file,
    // greedy string matches can span across regex literals containing quote
    // characters (e.g. /["']?X/) and accidentally consume real code including
    // actual `class Foo` declarations. Per-line stripping bounds that risk.
    const JS_RESERVED_AND_NOISE = new Set([
      'enum', 'extends', 'super', 'static', 'const', 'let', 'var',
      'function', 'return', 'if', 'else', 'for', 'while', 'do', 'switch',
      'case', 'break', 'continue', 'default', 'typeof', 'instanceof',
      'new', 'delete', 'void', 'yield', 'async', 'await', 'true', 'false',
      'null', 'undefined', 'this', 'try', 'catch', 'finally', 'throw',
      'import', 'export', 'from', 'as', 'of', 'in',
      // common noise that's not a class name but appears as 'class X' in docs
      'method', 'field', 'getters', 'identifiers', 'escape', 'declaration',
      'definition', 'double', 'size', 'names', 'name', 'may', 'matching',
      'rolling', 'found', 'foo', 'bar', 'baz', 'to', 'for', 'into',
      // Specific example-class names embedded in template-string code snippets
      // (e.g. PromptEngine's "class SkillName { ... }" example)
      'skillname', 'mycomponent', '_unsafe_html', 'genesiselement',
    ]);
    // Strip block comments globally (they're by-design multi-line).
    // Template literals are NOT stripped — they can contain backticks in regex
    // literals (e.g. /^```/) that confuse any ungrammared strip pass and cause
    // it to consume real code including class declarations.
    let codeStripped = code.replace(/\/\*[\s\S]*?\*\//g, '');
    // Strip line comments and quote-delimited strings per-line. Per-line bounds
    // a risk where a greedy quote match (e.g. due to quotes in regex literals)
    // would otherwise span from one side of the file to the other, swallowing
    // real code like `class Foo` along the way.
    codeStripped = codeStripped.split('\n').map((line) => {
      return line
        .replace(/\/\/[^\n]*$/, '')
        .replace(/'(?:[^'\\]|\\.)*'/g, "''")
        .replace(/"(?:[^"\\]|\\.)*"/g, '""');
    }).join('\n');
    const classMatches = codeStripped.matchAll(/\bclass\s+([A-Z]\w*)/g);
    for (const m of classMatches) {
      const name = m[1];
      // Only accept PascalCase class names — anonymous or lowercase identifiers
      // after 'class' are either parser artifacts or keyword noise.
      if (!JS_RESERVED_AND_NOISE.has(name.toLowerCase()) && /^[A-Z]/.test(name)) {
        info.classes.push(name);
      }
    }

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

  // v7.3.0: Capability Honesty — systematic derivation from four signals
  // (file path, class name, header comment, manifest tags) instead of a
  // hardcoded 9-element list. See CHANGELOG v7.3.0 for rationale.
  //
  // Produces two outputs:
  //   manifest.capabilities          → string[] (IDs only, backward compatible)
  //   manifest.capabilitiesDetailed  → object[] (full detail for richer consumers)
  _detectCapabilities() {
    const detailed = [];
    const seenIds = new Set();

    // Seed: always-present core capabilities (not tied to specific modules)
    const seeds = [
      { id: 'chat', category: 'core', description: 'Converse with the user', keywords: ['chat', 'talk', 'conversation', 'dialogue'] },
      { id: 'self-awareness', category: 'core', description: 'Reflect on own state', keywords: ['self', 'aware', 'introspect', 'reflect'] },
    ];
    for (const s of seeds) {
      detailed.push({ id: s.id, module: null, class: null, category: s.category, tags: [], description: s.description, keywords: s.keywords });
      seenIds.add(s.id);
    }

    // Build serviceName → tags lookup from injected manifest meta
    const metaByClass = new Map();
    if (this._manifestMeta) {
      for (const [svcName, svcMeta] of Object.entries(this._manifestMeta)) {
        // Heuristic: serviceName is typically camelCase(ClassName)
        // e.g. 'homeostasis' ↔ 'Homeostasis', 'cognitiveSelfModel' ↔ 'CognitiveSelfModel'
        const candidateClass = svcName.charAt(0).toUpperCase() + svcName.slice(1);
        metaByClass.set(candidateClass, svcMeta);
      }
    }

    // Iterate all source modules
    for (const [filePath, mod] of Object.entries(this.manifest.modules)) {
      if (!filePath.startsWith('src/')) continue;
      if (!mod.classes || mod.classes.length === 0) continue;

      for (const className of mod.classes) {
        const id = this._classToCapId(className);
        if (seenIds.has(id)) continue;
        seenIds.add(id);

        // Signal 1: path → category
        // e.g. "src/agent/organism/Homeostasis.js" → "organism"
        const pathParts = filePath.split(/[\\/]/);
        const agentIdx = pathParts.indexOf('agent');
        const category = (agentIdx >= 0 && pathParts[agentIdx + 1]) ? pathParts[agentIdx + 1] : 'misc';

        // Signal 2: class name → id (already computed above) + keyword seed
        // e.g. "CognitiveSelfModel" → ["cognitive", "self", "model"]
        const classKeywords = this._splitCamelCase(className).map(w => w.toLowerCase());

        // Signal 3: header comment → description + keywords
        const description = (mod.description || '').trim();
        const headerKeywords = this._extractKeywordsFromHeader(description);

        // Signal 4: manifest tags → curated semantic labels
        const meta = metaByClass.get(className);
        const manifestTags = meta ? [...(meta.tags || [])] : [];

        // Compose unified keyword set
        const keywords = new Set([
          id,
          ...classKeywords,
          ...headerKeywords,
          ...manifestTags.map(t => t.toLowerCase()),
          category.toLowerCase(),
        ]);
        // Filter stop-words and 1-2 char noise
        const STOP = new Set(['a', 'an', 'the', 'of', 'to', 'for', 'and', 'or', 'is', 'as', 'on', 'in', 'at', 'by', 'js', 'misc']);
        const cleanKeywords = [...keywords].filter(k => k && k.length >= 3 && !STOP.has(k));

        detailed.push({
          id,
          module: filePath.replace(/\\/g, '/'),
          class: className,
          category,
          tags: manifestTags,
          description: description.slice(0, 200),
          keywords: cleanKeywords.sort(),
        });
      }
    }

    // Store detailed form; derive id-only list for backward compatibility
    this.manifest.capabilitiesDetailed = detailed;
    return detailed.map(c => c.id);
  }

  // v7.3.0: Convert "HomeostasisV2" → "homeostasis-v2", "IdleMind" → "idle-mind"
  _classToCapId(className) {
    return className
      .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
      .replace(/([A-Z]+)([A-Z][a-z])/g, '$1-$2')
      .toLowerCase();
  }

  // v7.3.0: Split "CognitiveSelfModel" → ["Cognitive", "Self", "Model"]
  _splitCamelCase(s) {
    return s
      .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
      .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
      .split(/\s+/)
      .filter(Boolean);
  }

  // v7.3.0: Parse header description for meaningful keywords.
  // "Regulates internal state via corrective feedback" →
  //    ["regulate", "internal", "state", "corrective", "feedback"]
  _extractKeywordsFromHeader(description) {
    if (!description) return [];
    const STOP_HEADER = new Set([
      'the', 'a', 'an', 'of', 'to', 'for', 'and', 'or', 'is', 'as', 'on', 'in', 'at', 'by',
      'via', 'with', 'from', 'into', 'that', 'this', 'can', 'are', 'was', 'be', 'has', 'its',
      'it', 'all', 'any', 'not', 'but', 'also', 'when', 'then', 'if', 'how', 'what', 'who',
      'genesis', 'agent', 'module', 'class', 'file', 'code', 'line', 'see',
    ]);
    const words = description
      .toLowerCase()
      .replace(/[^\p{L}\s-]/gu, ' ')
      .split(/\s+/)
      .filter(w => w.length >= 4 && !STOP_HEADER.has(w));
    const uniq = [...new Set(words)];
    return uniq.slice(0, 12);
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

  // v7.3.0: Backward-compatible string[] getter. Consumers using .join(','),
  // .includes(), .slice() etc. keep working unchanged. List is now longer
  // and more accurate because _detectCapabilities() derives from 4 signals.
  getCapabilities() {
    return this.manifest.capabilities;
  }

  // v7.3.0: New detailed getter. Returns Array<{id, module, class, category,
  // tags, description, keywords}>. For consumers that want to match goals
  // against capabilities (v7.3.1 GoalStack Capability-Gate will use this).
  getCapabilitiesDetailed() {
    return this.manifest.capabilitiesDetailed || [];
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
      // v7.3.1: Prefer src/ over .genesis-backups snapshot copies
      const entries = Object.entries(this.manifest.modules)
        .filter(([_, m]) => m.classes.includes(fileOrName) || m.file.includes(fileOrName));
      if (entries.length > 0) {
        const prioritized = entries.find(([p]) => p.startsWith('src/')) || entries[0];
        filePath = prioritized[0];
      }
    }

    const fullPath = path.join(this.rootDir, filePath);
    // FIX v6.1.1: Guard against EISDIR — skip directories
    if (fs.existsSync(fullPath) && fs.statSync(fullPath).isFile()) {
      return fs.readFileSync(fullPath, 'utf-8');
    }
    return null;
  }

  /**
   * v7.3.1: Async variant of readModule. Preferred for idle-time reads
   * (_read-source activity) to keep the Electron main thread responsive.
   * Uses TTL cache (5min) invalidated on hot-reload:success events.
   *
   * @param {string} fileOrName - full path or class name
   * @returns {Promise<string|null>}
   */
  async readModuleAsync(fileOrName) {
    let filePath = fileOrName;
    if (!fileOrName.includes('/')) {
      // v7.3.1: Prefer src/ over .genesis-backups snapshot copies
      const entries = Object.entries(this.manifest.modules)
        .filter(([_, m]) => m.classes.includes(fileOrName) || m.file.includes(fileOrName));
      if (entries.length > 0) {
        const prioritized = entries.find(([p]) => p.startsWith('src/')) || entries[0];
        filePath = prioritized[0];
      }
    }

    // Check cache
    const cacheKey = filePath;
    const cached = this._readCache.get(cacheKey);
    if (cached && Date.now() - cached.loadedAt < this._readCacheTTL) {
      // LRU bump: remove + re-insert
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

      // Insert into cache with LRU eviction
      this._readCache.set(cacheKey, { content, loadedAt: Date.now() });
      while (this._readCache.size > this._readCacheMax) {
        const firstKey = this._readCache.keys().next().value;
        this._readCache.delete(firstKey);
      }

      return content;
    } catch (_e) {
      return null;
    }
  }

  /**
   * v7.3.1: Structured description of a module using already-parsed metadata
   * from scan(). Answers "what do I know about X?" without re-reading the
   * source file. For _read-source activity to decide whether to deep-read.
   *
   * @param {string} fileOrName - full path or class name
   * @returns {object|null} { file, classes, functions, requires, description,
   *   exports, loc, protected, isCapability } or null if not found.
   */
  describeModule(fileOrName) {
    let filePath = fileOrName;
    if (!fileOrName.includes('/')) {
      // v7.3.1: Prefer src/ paths. A class may appear in both the live
      // source tree AND in .genesis-backups/*/snapshots/, and without
      // this filter the snapshot copy wins by enumeration order.
      const entries = Object.entries(this.manifest.modules)
        .filter(([_, m]) => m.classes.includes(fileOrName) || m.file.includes(fileOrName));
      if (entries.length === 0) return null;
      const prioritized = entries.find(([p]) => p.startsWith('src/')) || entries[0];
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
  }

  /**
   * v7.3.1: Wire cache invalidation to the event bus.
   * Called by AgentCoreBoot after the bus is constructed. Safe to call
   * multiple times — previous subscription is cleaned up first.
   *
   * @param {object} bus - EventBus with .on()/.off() or returning unsub from .on()
   */
  wireHotReloadInvalidation(bus) {
    if (!bus || typeof bus.on !== 'function') return;
    if (this._hotReloadUnsub) {
      try { this._hotReloadUnsub(); } catch (_e) { /* ignore */ }
      this._hotReloadUnsub = null;
    }
    const unsub = bus.on('hot-reload:success', (data) => {
      if (data && data.file) {
        // Invalidate specific file (and any class-name-based key pointing to it)
        this._readCache.delete(data.file);
      } else {
        // No file specified — invalidate all
        this._readCache.clear();
      }
    }, { source: 'SelfModel' });
    this._hotReloadUnsub = typeof unsub === 'function' ? unsub : null;
  }

  /**
   * v7.3.1: Clear the read cache explicitly. Called on teardown or when
   * stale-data suspicion arises (e.g. external git checkout).
   */
  clearReadCache() {
    this._readCache.clear();
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
