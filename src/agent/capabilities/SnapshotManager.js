// ============================================================
// GENESIS — SnapshotManager.js (v4.12.2)
//
// Named snapshots of the agent's source code state.
// Complements git-based versioning with lightweight, labeled
// checkpoints that the agent (or user) can create and restore.
//
// Usage:
//   snapshot.create('before-refactor');
//   // agent modifies code...
//   snapshot.list();  // → [{ name, timestamp, files }]
//   snapshot.restore('before-refactor');
//
// Storage: .genesis/snapshots/<name>/  (file copies)
// Limit: MAX_SNAPSHOTS — oldest auto-pruned
// ============================================================

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { createLogger } = require('../core/Logger');
const { safeJsonParse, atomicWriteFileSync } = require('../core/utils');
const _log = createLogger('SnapshotManager');

const MAX_SNAPSHOTS = 20;
const SNAPSHOT_DIR = 'snapshots';
// Directories to snapshot (relative to rootDir)
const SNAPSHOT_TARGETS = ['src/agent'];

class SnapshotManager {
  constructor({ rootDir, storage, guard }) {
    this.rootDir = rootDir;
    this.storage = storage;
    this.guard = guard;
    this._snapshotBase = storage
      ? path.join(storage.baseDir || path.join(rootDir, '.genesis'), SNAPSHOT_DIR)
      : path.join(rootDir, '.genesis', SNAPSHOT_DIR);
  }

  /**
   * Create a named snapshot of current agent source.
   * @param {string} name - Snapshot label (sanitized)
   * @param {string} [description] - Optional description
   * @returns {{ name: string, fileCount: number, timestamp: number }}
   */
  create(name, description = '') {
    const safeName = name.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 60);
    const snapshotDir = path.join(this._snapshotBase, safeName);

    if (fs.existsSync(snapshotDir)) {
      // Overwrite existing snapshot with same name
      fs.rmSync(snapshotDir, { recursive: true, force: true });
    }
    fs.mkdirSync(snapshotDir, { recursive: true });

    let fileCount = 0;
    for (const target of SNAPSHOT_TARGETS) {
      const srcDir = path.join(this.rootDir, target);
      if (!fs.existsSync(srcDir)) continue;
      fileCount += this._copyRecursive(srcDir, path.join(snapshotDir, target));
    }

    // Write metadata
    const meta = {
      name: safeName,
      description,
      timestamp: Date.now(),
      fileCount,
      hash: this._hashDir(snapshotDir),
    };
    // FIX v5.1.0 (N-3): Atomic write for snapshot metadata.
    atomicWriteFileSync(
      path.join(snapshotDir, '_snapshot.json'),
      JSON.stringify(meta, null, 2)
    );

    // Prune old snapshots
    this._prune();

    _log.info(`[SNAPSHOT] Created "${safeName}" — ${fileCount} files`);
    return meta;
  }

  /**
   * Restore a named snapshot (overwrites current source).
   * @param {string} name
   * @returns {{ restored: number, name: string }}
   */
  restore(name) {
    const safeName = name.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 60);
    const snapshotDir = path.join(this._snapshotBase, safeName);

    if (!fs.existsSync(snapshotDir)) {
      throw new Error(`[SNAPSHOT] Snapshot "${safeName}" not found`);
    }

    // Safety: create auto-snapshot of current state before restoring
    try {
      this.create(`_auto_before_restore_${Date.now()}`);
    } catch (_e) { /* best effort */ }

    let restored = 0;
    for (const target of SNAPSHOT_TARGETS) {
      const snapSrc = path.join(snapshotDir, target);
      if (!fs.existsSync(snapSrc)) continue;
      const destDir = path.join(this.rootDir, target);

      // Validate writes against SafeGuard
      const files = this._listFiles(snapSrc);
      for (const relFile of files) {
        const destPath = path.join(destDir, relFile);
        try {
          this.guard.validateWrite(destPath);
        } catch (err) {
          _log.warn(`[SNAPSHOT] Skipping protected file: ${relFile}`);
          continue;
        }
        const srcPath = path.join(snapSrc, relFile);
        const dir = path.dirname(destPath);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        fs.copyFileSync(srcPath, destPath);
        restored++;
      }
    }

    _log.info(`[SNAPSHOT] Restored "${safeName}" — ${restored} files`);
    return { restored, name: safeName };
  }

  /**
   * List all available snapshots.
   * @returns {Array<{ name, timestamp, fileCount, description }>}
   */
  list() {
    if (!fs.existsSync(this._snapshotBase)) return [];
    const entries = fs.readdirSync(this._snapshotBase, { withFileTypes: true });
    const snapshots = [];

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const metaPath = path.join(this._snapshotBase, entry.name, '_snapshot.json');
      if (!fs.existsSync(metaPath)) continue;
      const meta = safeJsonParse(fs.readFileSync(metaPath, 'utf-8'), null, 'SnapshotManager');
      if (meta) snapshots.push(meta);
    }

    return snapshots.sort((a, b) => b.timestamp - a.timestamp);
  }

  /**
   * Delete a named snapshot.
   * @param {string} name
   * @returns {boolean}
   */
  delete(name) {
    const safeName = name.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 60);
    const dir = path.join(this._snapshotBase, safeName);
    if (!fs.existsSync(dir)) return false;
    fs.rmSync(dir, { recursive: true, force: true });
    return true;
  }

  // ── Internal ─────────────────────────────────────────

  _copyRecursive(src, dest) {
    let count = 0;
    if (!fs.existsSync(src)) return count;
    fs.mkdirSync(dest, { recursive: true });
    for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
      const s = path.join(src, entry.name);
      const d = path.join(dest, entry.name);
      if (entry.isDirectory()) {
        count += this._copyRecursive(s, d);
      } else {
        fs.copyFileSync(s, d);
        count++;
      }
    }
    return count;
  }

  _listFiles(dir, prefix = '') {
    const files = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const rel = path.join(prefix, entry.name);
      if (entry.isDirectory()) {
        files.push(...this._listFiles(path.join(dir, entry.name), rel));
      } else if (entry.name !== '_snapshot.json') {
        files.push(rel);
      }
    }
    return files;
  }

  _hashDir(dir) {
    const hash = crypto.createHash('sha256');
    const files = this._listFiles(dir).sort();
    for (const f of files) {
      hash.update(fs.readFileSync(path.join(dir, f)));
    }
    return hash.digest('hex').slice(0, 16);
  }

  _prune() {
    const all = this.list();
    if (all.length <= MAX_SNAPSHOTS) return;
    const toDelete = all.slice(MAX_SNAPSHOTS);
    for (const snap of toDelete) {
      this.delete(snap.name);
    }
  }
}

module.exports = { SnapshotManager };
