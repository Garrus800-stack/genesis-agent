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

// v7.5.8: Cloud-sync placeholder awareness.
//
// Live-Befund (2026-05-03 Daniel-Win-Rechner): Genesis copy in
// `C:\Users\Danie\OneDrive\Desktop\...\Genesis\` triggered a 30s+ hang
// when ReadSource (idle-time) picked a file that was a OneDrive
// Files-On-Demand placeholder (`fs.existsSync` returns true, but reading
// the file forces an implicit cloud download). The hang blocked the
// idle-cycle and degraded the whole chat experience.
//
// On Windows, Node `fs.statSync().blocks` is undefined, so we cannot
// detect placeholders structurally. Two-layer defence instead:
//   (a) cheap path-heuristic: filenames under known cloud-sync roots
//       (\OneDrive\, \iCloudDrive\, \Dropbox\, \Google Drive\) are
//       treated as potentially cloud-backed.
//   (b) defensive read-timeout: idle-time reads use Promise.race with
//       a 1500ms cap. Chat-time reads stay synchronous (user-initiated,
//       cloud-fetch is acceptable) but log a warning if we're under a
//       cloud-sync root.
const CLOUD_SYNC_PATH_MARKERS = [
  /\\OneDrive(\s-\s[^\\/]+)?\\/i,    // \OneDrive\ or \OneDrive - Personal\
  /\/OneDrive(\s-\s[^/]+)?\//i,      // /OneDrive/ (Mac path)
  /\\iCloudDrive\\/i,
  /\\Dropbox\\/i,
  /\\Google\s+Drive\\/i,
  /\/Google\s+Drive\//i,
];

function _isCloudSyncPath(fullPath) {
  return CLOUD_SYNC_PATH_MARKERS.some(re => re.test(fullPath));
}

const READ_TIMEOUT_IDLE_MS = 1500;

function _readFileWithTimeout(fullPath, timeoutMs) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      const err = new Error(`Read timeout (${timeoutMs}ms) — likely cloud-sync placeholder: ${fullPath}`);
      err.code = 'CLOUD_PLACEHOLDER_TIMEOUT';
      reject(err);
    }, timeoutMs);
    fsp.readFile(fullPath, 'utf-8').then(
      (content) => { if (!settled) { settled = true; clearTimeout(timer); resolve(content); } },
      (err)     => { if (!settled) { settled = true; clearTimeout(timer); reject(err); } }
    );
  });
}

// v7.5.8 Hotfix: Filename-Resolution with variants.
//
// Live-Befund (2026-05-03 Garrus-Win-Rechner): User asked Genesis to
// summarise "die readme" / "die ONTOGENESIS". The LLM passed those
// strings through to read-source as-is; resolveFile saw `<rootDir>/readme`
// (no extension) and `<rootDir>/ONTOGENESIS` (no extension, wrong dir),
// returned null, and the LLM then confabulated "size 0" — claiming a
// concrete fact (file size!) it had never observed.
//
// Fix: when the requested path doesn't exist as-is, try variants in this
// order before giving up:
//   1. Append common extensions (.md .txt .js .json .yml .yaml)
//   2. Case-insensitive exact match in the parent directory
//   3. Case-insensitive base-name match with any extension
//   4. Fuzzy match (Levenshtein <= 1) — only if exactly one candidate
//   5. If still no hit and filename looks doc-like, retry under <rootDir>/docs
// Each step short-circuits on first hit. Multiple-fuzzy-candidates is
// considered ambiguous and returns null rather than guessing.

const COMMON_FILE_EXTS = ['.md', '.txt', '.js', '.json', '.yml', '.yaml'];

function _levenshtein(a, b) {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  // Use single-row DP for memory efficiency on small strings.
  let prev = new Array(a.length + 1);
  let curr = new Array(a.length + 1);
  for (let j = 0; j <= a.length; j++) prev[j] = j;
  for (let i = 1; i <= b.length; i++) {
    curr[0] = i;
    for (let j = 1; j <= a.length; j++) {
      curr[j] = b[i - 1] === a[j - 1]
        ? prev[j - 1]
        : Math.min(prev[j - 1] + 1, curr[j - 1] + 1, prev[j] + 1);
    }
    [prev, curr] = [curr, prev];
  }
  return prev[a.length];
}

function _resolveInDir(dir, targetBase) {
  if (!fs.existsSync(dir)) return null;
  let entries;
  try { entries = fs.readdirSync(dir); } catch { return null; }
  const targetLower = targetBase.toLowerCase();

  // v7.5.9 ZIP2 fix: prefer readdir-match before existsSync.
  // On Windows the FS is case-insensitive, so existsSync('readme.md')
  // returns true even when the real file is 'README.md'. That returned
  // the user-typed case ('readme.md'), which broke callers expecting
  // the real on-disk case (e.g. test asserts endsWith('README.md')).
  // Reading entries with readdirSync gives us the real case, so we
  // try that first.

  // Step 0: case-insensitive base+ext match against actual entries.
  for (const ext of COMMON_FILE_EXTS) {
    const wantedLower = (targetBase + ext).toLowerCase();
    for (const entry of entries) {
      if (entry.toLowerCase() === wantedLower) {
        const candidate = path.join(dir, entry);
        try {
          if (fs.statSync(candidate).isFile()) return candidate;
        } catch { /* skip */ }
      }
    }
  }

  // Step 1: append common extension to original case (Linux fallback).
  for (const ext of COMMON_FILE_EXTS) {
    const candidate = path.join(dir, targetBase + ext);
    try {
      if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
    } catch { /* fall through */ }
  }

  // Step 2: case-insensitive exact filename match.
  for (const entry of entries) {
    if (entry.toLowerCase() === targetLower) {
      const candidate = path.join(dir, entry);
      try {
        if (fs.statSync(candidate).isFile()) return candidate;
      } catch { /* fall through */ }
    }
  }

  // Step 3: case-insensitive base-name match (any extension).
  for (const entry of entries) {
    const entryLower = entry.toLowerCase();
    const entryBase = entryLower.replace(/\.[^.]*$/, '');
    if (entryBase === targetLower) {
      const candidate = path.join(dir, entry);
      try {
        if (fs.statSync(candidate).isFile()) return candidate;
      } catch { /* fall through */ }
    }
  }

  // Step 4: fuzzy match (Levenshtein <= 1, base-name only).
  // Skip if target is too short (false-positive rate too high under 4 chars).
  if (targetLower.length >= 4) {
    const candidates = [];
    for (const entry of entries) {
      const entryLower = entry.toLowerCase();
      const entryBase = entryLower.replace(/\.[^.]*$/, '');
      if (entryBase.length < 4) continue;
      const dist = _levenshtein(targetLower, entryBase);
      if (dist <= 1) candidates.push({ entry, dist });
    }
    if (candidates.length === 1) {
      const candidate = path.join(dir, candidates[0].entry);
      try {
        if (fs.statSync(candidate).isFile()) return candidate;
      } catch { /* fall through */ }
    }
    // Multiple equal-distance hits = ambiguous, do NOT guess.
  }

  return null;
}

function _resolveFileWithVariants(absPath, rootDir) {
  // First try as-is (this is the fast path; all existing call sites already
  // checked existsSync but we re-check here to keep the helper standalone).
  try {
    if (fs.existsSync(absPath) && fs.statSync(absPath).isFile()) return absPath;
  } catch { /* fall through to variants */ }

  const dir = path.dirname(absPath);
  const baseName = path.basename(absPath);

  // Steps 1-4 in original directory.
  const inOriginal = _resolveInDir(dir, baseName);
  if (inOriginal) return inOriginal;

  // Step 5: docs/ fallback. v7.5.9 ZIP2 v5: dropped the "looks like doc"
  // filter (was a regex `^[A-Za-z][A-Za-z_-]{2,}$` that excluded any
  // filename with digits or dots — e.g. "phase9-cognitive-architecture"
  // failed because of the 9). The filter was an arbitrary restriction
  // that surprised users; if a file isn't at the original location,
  // just try docs/ — cheap, deterministic, no false-positives because
  // _resolveInDir only returns files that actually exist.
  if (rootDir && path.resolve(dir) === path.resolve(rootDir)) {
    const docsDir = path.join(rootDir, 'docs');
    const inDocs = _resolveInDir(docsDir, baseName);
    if (inDocs) return inDocs;
  }

  return null;
}

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
    // FIX v6.1.1: Guard against EISDIR — skip directories.
    // v7.5.8 hotfix: fall back to filename-variant resolution when the literal
    // path doesn't exist (handles "readme" → README.md, "ontogenesis" →
    // docs/ONTOGENESIS.md, fuzzy "redme" → README.md).
    try {
      if (fs.existsSync(fullPath) && fs.statSync(fullPath).isFile()) {
        return fs.readFileSync(fullPath, 'utf-8');
      }
    } catch { /* fall through */ }
    const resolved = _resolveFileWithVariants(fullPath, this.rootDir);
    if (resolved) {
      try { return fs.readFileSync(resolved, 'utf-8'); } catch { return null; }
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
    let absPath = path.isAbsolute(filePath)
      ? filePath
      : path.join(this.rootDir, filePath);

    // v7.5.8 hotfix: filename-variant resolution. If the literal path doesn't
    // exist, try common-extension append, case-insensitive match, fuzzy match,
    // and well-known docs/ retry. Closes the live-discovered hole where
    // read-source('readme') / read-source('ONTOGENESIS') returned null and
    // the LLM then confabulated "size 0".
    if (!fs.existsSync(absPath) || !fs.statSync(absPath).isFile()) {
      const resolved = _resolveFileWithVariants(absPath, this.rootDir);
      if (resolved) absPath = resolved;
    }

    // Cache hit — return cached content WITHOUT counting against budget.
    // v7.5.9 ZIP1 Phase 6: previously cache-hits incremented turnCount and
    // sessionCount. That's a bug: re-reading the same file later in the
    // same turn (legitimate when the LLM references it twice) consumed
    // budget for zero new I/O work. With the higher budgets (15/30/100)
    // this matters less but the principle is wrong either way — budget
    // limits I/O cost, and a cache-hit IS the savings, not the cost.
    const cached = state.sessionCache.get(absPath);
    if (cached !== undefined) {
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
      // v7.5.8: Chat-time reads are user-initiated — cloud-fetch is OK,
      // but warn so the user understands why a read might take longer.
      // Cannot timeout sync I/O, so this is informational only.
      const isCloud = _isCloudSyncPath(absPath);
      if (isCloud) {
        _log.warn(`[READ-SOURCE] Reading from cloud-sync path may trigger download: ${absPath}`);
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
    let fullPath = path.join(this.rootDir, filePath);
    // v7.5.8 hotfix: filename-variant resolution before stat.
    if (!fs.existsSync(fullPath)) {
      const resolved = _resolveFileWithVariants(fullPath, this.rootDir);
      if (resolved) fullPath = resolved;
    }
    try {
      const stat = await fsp.stat(fullPath);
      if (!stat.isFile()) return null;

      // v7.5.8: Idle-time reads use a timeout to avoid hanging on cloud-sync
      // placeholders (OneDrive Files-On-Demand etc.). On a normal local file
      // the read returns in <50ms; the 1500ms cap only triggers when the
      // OS is actually fetching from the cloud, which is exactly what we
      // want to skip during idle reads.
      const content = await _readFileWithTimeout(fullPath, READ_TIMEOUT_IDLE_MS);

      this._readCache.set(cacheKey, { content, loadedAt: Date.now() });
      while (this._readCache.size > this._readCacheMax) {
        const firstKey = this._readCache.keys().next().value;
        this._readCache.delete(firstKey);
      }

      return content;
    } catch (err) {
      // v7.5.8: Distinguish cloud-placeholder timeout from generic read errors.
      if (err && err.code === 'CLOUD_PLACEHOLDER_TIMEOUT') {
        _log.info(`[READ-SOURCE] Skipped cloud-sync placeholder: ${filePath}`);
      } else if (_isCloudSyncPath(fullPath)) {
        _log.debug(`[READ-SOURCE] Read failed under cloud-sync root: ${filePath}: ${err && err.message}`);
      }
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

module.exports = { selfModelSourceRead, _resolveFileWithVariants };
