// @ts-checked-v5.7
// ============================================================
// GENESIS — StorageService.js (v4.0.0 — Merge-Aware Debounced Writes)
//
// Centralized persistence. Every module that needs to read/write
// data goes through this service.
//
// v4.0.0 UPGRADE: writeJSONDebounced() now supports merge functions.
// When multiple autonomous systems (AgentLoop, IdleMind, DreamCycle)
// debounce-write to the same file, the default behavior is still
// last-write-wins. But callers can pass a merge function that combines
// the pending cached data with the new data, preventing silent overwrites.
//
// New: writeJSONQueued() — fully serialized async writes per key,
// guaranteeing ordering even under concurrent async callers.
// Each key gets its own Promise chain; writes execute in FIFO order.
//
// v4.0.0: Sync writeJSON() contention tracking.
// v3.7.0: Async I/O variants, debounced writes, flush().
// ============================================================

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { WriteLock } = require('../core/WriteLock');
const { createLogger } = require('../core/Logger');
const _log = createLogger('StorageService');

class StorageService {
  constructor(baseDir) {
    this.baseDir = baseDir;
    this._writeQueue = new Map(); // filename → Promise chain
    this._cache = new Map();      // filename → { data, ts }
    this._cacheTTL = 5000;        // 5s cache for reads
    // FIX v4.12.7 (Audit-04): LRU eviction to prevent unbounded heap growth
    this._cacheMaxSize = 200;
    // FIX v3.5.3: WriteLock prevents race between debounced timers and flush()
    this._flushLock = new WriteLock({ name: 'storage-flush', defaultTimeoutMs: 10000 });
    this._flushing = false;       // Guard flag

    // v3.7.0: I/O stats
    this._stats = { syncReads: 0, asyncReads: 0, syncWrites: 0, asyncWrites: 0, merges: 0 };

    // v4.0.0: Write contention tracking
    this._writeContention = new Map(); // filename → { writing: boolean, queued: number, totalContentions: number }
    this._contentionTotal = 0;

    // v4.0.0: Per-key debounce metadata for merge-aware writes
    this._debounceTimers = new Map(); // filename → timeoutId
    this._debouncePending = new Map(); // filename → { data, mergeFn? }

    // v7.1.9 S-1a: Integrity checksums — SHA-256 per file for corruption detection
    this._checksums = this._loadChecksums();

    if (!fs.existsSync(baseDir)) {
      fs.mkdirSync(baseDir, { recursive: true });
    }
  }

  /** Resolve a filename to full path within baseDir */
  _resolve(filename) {
    const resolved = path.resolve(this.baseDir, filename);
    if (!resolved.startsWith(this.baseDir)) {
      throw new Error(`[STORAGE] Path traversal blocked: ${filename}`);
    }
    return resolved;
  }

  // ── v7.1.9 S-1a: Integrity Checksums ────────────────

  /** Load checksums from disk, or return empty map if missing/corrupt */
  _loadChecksums() {
    try {
      const p = path.join(this.baseDir, '_checksums.json');
      if (fs.existsSync(p)) return new Map(Object.entries(JSON.parse(fs.readFileSync(p, 'utf8'))));
    } catch (_e) { /* regenerate */ }
    return new Map();
  }

  /** Save checksums to disk */
  _saveChecksums() {
    try {
      const p = path.join(this.baseDir, '_checksums.json');
      fs.writeFileSync(p, JSON.stringify(Object.fromEntries(this._checksums), null, 2), 'utf8');
    } catch (_e) { _log.debug('[STORAGE] Checksum save failed:', _e.message); }
  }

  /** Update checksum for a file after successful write.
   *  v7.2.3: Sync instead of debounced. The previous 2s debounce was a
   *  performance optimization with an unacceptable cost: if the process
   *  exited (crash or shutdown) before the timer fired, the on-disk hash
   *  stayed stale → next boot saw a bogus integrity mismatch → users
   *  learned to ignore the integrity guard that v7.1.9 introduced.
   *
   *  Sync checksums are <1ms for typical .genesis/ files. That's cheaper
   *  than the debounce bookkeeping we removed. Integrity warnings are now
   *  meaningful again: if the guard fires, the corruption is real. */
  _updateChecksum(filename, jsonStr) {
    try {
      const hash = require('crypto').createHash('sha256').update(jsonStr).digest('hex');
      this._checksums.set(filename, hash);
      this._saveChecksums();
    } catch (_e) { /* best-effort */ }
  }

  /**
   * v7.1.9: Verify integrity of all .genesis/ JSON files against stored checksums.
   * Called at boot after Phase 1.
   * @returns {{ ok: boolean, verified: number, mismatches: Array, missing: Array }}
   */
  verifyIntegrity() {
    const result = { ok: true, verified: 0, mismatches: [], missing: [] };
    for (const [filename, expectedHash] of this._checksums) {
      const fullPath = this._resolve(filename);
      try {
        if (!fs.existsSync(fullPath)) {
          result.missing.push(filename);
          continue;
        }
        const content = fs.readFileSync(fullPath, 'utf8');
        const actualHash = require('crypto').createHash('sha256').update(content).digest('hex');
        if (actualHash !== expectedHash) {
          result.mismatches.push({ filename, expected: expectedHash.slice(0, 12), actual: actualHash.slice(0, 12) });
          result.ok = false;
        } else {
          result.verified++;
        }
      } catch (err) {
        result.mismatches.push({ filename, error: err.message });
        result.ok = false;
      }
    }
    return result;
  }

  // ── Read (Sync) ───────────────────────────────────────

  readJSON(filename, defaultValue = null) {
    const cached = this._cache.get(filename);
    if (cached && (Date.now() - cached.ts) < this._cacheTTL) {
      return cached.data;
    }
    const fullPath = this._resolve(filename);
    try {
      if (!fs.existsSync(fullPath)) return defaultValue;
      const raw = fs.readFileSync(fullPath, 'utf-8');
      const data = JSON.parse(raw);
      this._cacheSet(filename, data);
      this._stats.syncReads++;
      return data;
    } catch (err) {
      _log.warn(`[STORAGE] Read failed: ${filename}:`, err.message);
      return defaultValue;
    }
  }

  readText(filename, defaultValue = '') {
    const fullPath = this._resolve(filename);
    try {
      if (!fs.existsSync(fullPath)) return defaultValue;
      this._stats.syncReads++;
      return fs.readFileSync(fullPath, 'utf-8');
    } catch (err) { return defaultValue; /* graceful: missing/corrupt file returns default */ }
  }

  // ── Read (Async — v3.7.0) ─────────────────────────────

  async readJSONAsync(filename, defaultValue = null) {
    const cached = this._cache.get(filename);
    if (cached && (Date.now() - cached.ts) < this._cacheTTL) {
      return cached.data;
    }
    const fullPath = this._resolve(filename);
    try {
      const raw = await fsp.readFile(fullPath, 'utf-8');
      const data = JSON.parse(raw);
      this._cacheSet(filename, data);
      this._stats.asyncReads++;
      return data;
    } catch (err) {
      if (err.code === 'ENOENT') return defaultValue;
      _log.warn(`[STORAGE] Async read failed: ${filename}:`, err.message);
      return defaultValue;
    }
  }

  async readTextAsync(filename, defaultValue = '') {
    const fullPath = this._resolve(filename);
    try {
      this._stats.asyncReads++;
      return await fsp.readFile(fullPath, 'utf-8');
    } catch (err) {
      return defaultValue; // graceful: missing/corrupt file returns default
    }
  }

  // ── Write (Sync) ──────────────────────────────────────
  // FIX v4.10.0 (M-7): Deprecation notice — prefer writeJSONAsync/writeJSONQueued.
  // Sync writes have TOCTOU risk under concurrent access and block the main thread.
  // Added fsync before rename to ensure data reaches disk before the atomic swap.

  writeJSON(filename, data) {
    const fullPath = this._resolve(filename);
    const tmpPath = fullPath + '.tmp';
    const dir = path.dirname(fullPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    // v4.0.0: Contention tracking
    let ct = this._writeContention.get(filename);
    if (!ct) {
      ct = { writing: false, queued: 0, totalContentions: 0 };
      this._writeContention.set(filename, ct);
    }
    if (ct.writing) {
      ct.totalContentions++;
      this._contentionTotal++;
      _log.debug(`[STORAGE] Write contention on ${filename} (total: ${ct.totalContentions})`);
    }
    ct.writing = true;

    try {
      const json = JSON.stringify(data, null, 2);
      fs.writeFileSync(tmpPath, json, 'utf-8');
      // FIX v4.10.0: fsync before rename ensures data is on disk
      // FIX v4.13.1: 'r+' required — Windows EPERM on fsync with read-only handle
      const fd = fs.openSync(tmpPath, 'r+');
      fs.fsyncSync(fd);
      fs.closeSync(fd);
      fs.renameSync(tmpPath, fullPath);
      this._cacheSet(filename, data);
      this._updateChecksum(filename, json); // v7.1.9 S-1a
      this._stats.syncWrites++;
    } catch (err) {
      try { if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath); } catch (_e) { _log.debug('[catch] tmp cleanup sync:', _e.message); }
      _log.warn(`[STORAGE] Write failed: ${filename}:`, err.message);
      throw err;
    } finally {
      ct.writing = false;
    }
  }

  writeText(filename, text) {
    const fullPath = this._resolve(filename);
    const tmpPath = fullPath + '.tmp';
    const dir = path.dirname(fullPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    try {
      fs.writeFileSync(tmpPath, text, 'utf-8');
      fs.renameSync(tmpPath, fullPath);
      this._stats.syncWrites++;
    } catch (err) {
      try { if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath); } catch (_e) { _log.debug('[catch] tmp cleanup sync:', _e.message); }
      throw err;
    }
  }

  appendText(filename, text) {
    const fullPath = this._resolve(filename);
    const dir = path.dirname(fullPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(fullPath, text, 'utf-8');
    // v7.0.2: fsync after append — ensures complete lines on disk before returning.
    // Without this, a crash during flush can leave half-written JSONL lines.
    try {
      const fd = fs.openSync(fullPath, 'r+');
      fs.fsyncSync(fd);
      fs.closeSync(fd);
    } catch (_e) { /* best effort — file may be read-only or locked */ }
    this._stats.syncWrites++;
  }

  // ── Write (Async — v3.7.0) ────────────────────────────

  /**
   * v3.7.0: Async atomic JSON write. Queued per-file to serialize
   * concurrent writes. Uses fs.promises — non-blocking.
   */
  async writeJSONAsync(filename, data) {
    const prev = this._writeQueue.get(filename) || Promise.resolve();
    const task = prev.then(() => this._doAsyncWrite(filename, data))
      .catch(async (err) => {
        // FIX v4.12.7 (Audit-03): Retry once on transient I/O failure
        _log.warn(`[STORAGE] Async write failed: ${filename}: ${err.message} — retrying once...`);
        try {
          await this._doAsyncWrite(filename, data);
        } catch (retryErr) {
          _log.error(`[STORAGE] Async write FAILED after retry: ${filename}: ${retryErr.message}`);
          this._stats.writeErrors = (this._stats.writeErrors || 0) + 1;
        }
      });
    this._writeQueue.set(filename, task);
    return task;
  }

  async _doAsyncWrite(filename, data) {
    const fullPath = this._resolve(filename);
    const tmpPath = fullPath + '.tmp';
    await fsp.mkdir(path.dirname(fullPath), { recursive: true });
    try {
      const json = JSON.stringify(data, null, 2);
      await fsp.writeFile(tmpPath, json, 'utf-8');
      // FIX v4.13.1 (Audit F-06): fsync before rename ensures data is on disk
      // before the atomic swap — matches the sync path behavior (v4.10.0).
      // Note: 'r+' required — Windows EPERM on fsync with read-only handle.
      const fh = await fsp.open(tmpPath, 'r+');
      await fh.sync();
      await fh.close();
      await fsp.rename(tmpPath, fullPath);
      this._cacheSet(filename, data);
      this._updateChecksum(filename, json); // v7.1.9 S-1a
      this._stats.asyncWrites++;
    } catch (err) {
      try { await fsp.unlink(tmpPath); } catch (_e) { _log.debug('[catch] tmp cleanup sync 2:', _e.message); }
      throw err;
    }
  }

  async writeTextAsync(filename, text) {
    const fullPath = this._resolve(filename);
    const tmpPath = fullPath + '.tmp';
    await fsp.mkdir(path.dirname(fullPath), { recursive: true });
    try {
      await fsp.writeFile(tmpPath, text, 'utf-8');
      // FIX v4.13.1 (Audit F-06): fsync before rename — see _doAsyncWrite
      const fh = await fsp.open(tmpPath, 'r+');
      await fh.sync();
      await fh.close();
      await fsp.rename(tmpPath, fullPath);
      this._stats.asyncWrites++;
    } catch (err) {
      try { await fsp.unlink(tmpPath); } catch (_e) { _log.debug('[catch] tmp cleanup async:', _e.message); }
      throw err;
    }
  }

  async appendTextAsync(filename, text) {
    const fullPath = this._resolve(filename);
    await fsp.mkdir(path.dirname(fullPath), { recursive: true });
    await fsp.appendFile(fullPath, text, 'utf-8');
    // v7.0.2: fsync after append — matches sync path. Prevents half-written
    // JSONL lines (events.jsonl) on crash during OS buffer flush.
    try {
      const fh = await fsp.open(fullPath, 'r+');
      await fh.sync();
      await fh.close();
    } catch (_e) { /* best effort */ }
    this._stats.asyncWrites++;
  }

  // ── Debounced (v4.0.0: merge-aware) ───────────────────

  /**
   * Debounced JSON write with optional merge function.
   *
   * When multiple callers debounce-write to the same file within the
   * delay window, the default behavior is last-write-wins. With a
   * mergeFn, the pending data is merged with new data instead of replaced.
   *
   * @param {string} filename - Target file
   * @param {*} data - Data to write
   * @param {number} [delayMs=2000] - Debounce delay
   * @param {Function|null} [mergeFn] - (existingData, newData) => mergedData
   *   Called when there's already a pending write for this file.
   *   If not provided, newData overwrites existingData (last-write-wins).
   */
  writeJSONDebounced(filename, data, delayMs = 2000, mergeFn = null) {
    // Cancel existing timer for this file
    const existingTimer = this._debounceTimers.get(filename);
    if (existingTimer) clearTimeout(existingTimer);

    // Merge or replace pending data
    const pending = this._debouncePending.get(filename);
    let finalData = data;

    if (pending && mergeFn) {
      try {
        finalData = mergeFn(pending.data, data);
        this._stats.merges++;
      } catch (err) {
        _log.debug(`[STORAGE] Merge failed for ${filename}, using new data:`, err.message);
        finalData = data;
      }
    }

    // Store pending data and update cache immediately (for reads)
    this._debouncePending.set(filename, { data: finalData });
    this._cacheSet(filename, finalData);

    // Set new timer
    const timer = setTimeout(() => {
      this._debounceTimers.delete(filename);
      this._debouncePending.delete(filename);
      if (this._flushing) return;
      this.writeJSONAsync(filename, finalData).catch(err =>
        _log.warn(`[STORAGE] Debounced write failed: ${filename}:`, err.message)
      );
    }, delayMs);

    this._debounceTimers.set(filename, timer);
  }

  /**
   * v4.0.0: Fully serialized async write per key.
   * Unlike writeJSONAsync (which chains but doesn't merge),
   * writeJSONQueued accepts an updater function that receives
   * the current value and returns the new value. This prevents
   * lost updates when multiple callers modify the same file.
   *
   * @param {string} filename - Target file
   * @param {Function} updater - (currentData) => newData
   * @returns {Promise<void>}
   */
  async writeJSONQueued(filename, updater) {
    const prev = this._writeQueue.get(filename) || Promise.resolve();
    const task = prev.then(async () => {
      const current = await this.readJSONAsync(filename, null);
      const updated = updater(current);
      await this._doAsyncWrite(filename, updated);
    }).catch(err => _log.warn(`[STORAGE] Queued write failed: ${filename}:`, err.message));
    this._writeQueue.set(filename, task);
    return task;
  }

  // ── Utilities ─────────────────────────────────────────

  exists(filename) { return fs.existsSync(this._resolve(filename)); }

  async existsAsync(filename) {
    try { await fsp.access(this._resolve(filename)); return true; }
    catch (_e) { _log.debug('[catch] fsp.accessthis._resolvefilename:', _e.message); return false; }
  }

  delete(filename) {
    const fullPath = this._resolve(filename);
    this._cache.delete(filename);
    try {
      if (fs.existsSync(fullPath)) fs.unlinkSync(fullPath);
      return true;
    } catch (_e) { _log.debug('[catch] file exists check:', _e.message); return false; }
  }

  list(prefix = '') {
    try {
      return fs.readdirSync(this.baseDir).filter(f => f.startsWith(prefix));
    } catch (_e) { _log.debug('[catch] filesystem op:', _e.message); return []; }
  }

  getPath(filename) { return this._resolve(filename); }

  /**
   * Flush all pending debounced writes.
   * v4.0.0: Drains debounce map + write queue.
   * @returns {Promise<void>}
   */
  async flush() {
    this._flushing = true;
    try {
      const writes = [];

      // Drain debounced writes
      for (const [filename, timer] of this._debounceTimers) {
        clearTimeout(timer);
        const pending = this._debouncePending.get(filename);
        if (pending) {
          writes.push(
            this._doAsyncWrite(filename, pending.data)
              .catch(err => _log.warn('[STORAGE] Flush failed: ' + filename + ':', err.message))
          );
        }
      }
      this._debounceTimers.clear();
      this._debouncePending.clear();

      if (writes.length > 0) await Promise.all(writes);

      // Drain write queue
      const drains = [];
      for (const [, p] of this._writeQueue) drains.push(p.catch(() => { /* best effort */ }));
      if (drains.length > 0) await Promise.all(drains);
      this._writeQueue.clear();

      // v7.2.3: Checksum updates are now synchronous (see _updateChecksum),
      // so no checksum timer to drain here. Removed obsolete drain code.
    } finally {
      this._flushing = false;
    }
  }

  clearCache() { this._cache.clear(); }

  /**
   * v4.0.0: Write contention statistics.
   */
  getWriteStats() {
    const hotFiles = [];
    for (const [filename, ct] of this._writeContention) {
      if (ct.totalContentions > 0) {
        hotFiles.push({ filename, contentions: ct.totalContentions });
      }
    }
    hotFiles.sort((a, b) => b.contentions - a.contentions);
    return {
      totalContentions: this._contentionTotal,
      asyncQueueDepth: this._writeQueue.size,
      pendingDebounced: this._debouncePending.size,
      merges: this._stats.merges,
      hotFiles: hotFiles.slice(0, 10),
    };
  }

  // FIX v4.12.7 (Audit-04): LRU-style eviction when cache exceeds max size.
  // Evicts oldest entries (by timestamp) to keep memory bounded.
  _cacheSet(filename, data) {
    if (this._cache.size >= this._cacheMaxSize) {
      let oldestKey = null, oldestTs = Infinity;
      for (const [k, v] of this._cache) {
        if (v.ts < oldestTs) { oldestTs = v.ts; oldestKey = k; }
      }
      if (oldestKey) this._cache.delete(oldestKey);
    }
    this._cache.set(filename, { data, ts: Date.now() });
  }

  getStats() {
    let totalSize = 0;
    let fileCount = 0;
    try {
      for (const file of fs.readdirSync(this.baseDir)) {
        const stat = fs.statSync(path.join(this.baseDir, file));
        if (stat.isFile()) { totalSize += stat.size; fileCount++; }
      }
    } catch (err) { _log.debug('[STORAGE] Stats error:', err.message); }
    return {
      baseDir: this.baseDir,
      fileCount,
      totalSizeKB: Math.round(totalSize / 1024),
      cacheEntries: this._cache.size,
      ioStats: { ...this._stats },
    };
  }
}

module.exports = { StorageService };
