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
    // v7.9.18 (A1): code snapshots are HABITAT, not identity. They must live
    // beside the code, NOT inside .genesis/ — otherwise a habitat-swap (version
    // upgrade) carries the old habitat's snapshot into the new identity, and a
    // crash-recovery can restore old code over new (the v7.9.17 contamination).
    // Base is now rootDir-local and independent of storage.baseDir (.genesis/).
    this._snapshotBase = path.join(rootDir, SNAPSHOT_DIR);
    // Legacy location (pre-v7.9.18): snapshots used to live under .genesis/.
    // Kept only so migrateIfNeeded() can move a poisoned legacy folder aside.
    this._legacyBase = path.join(
      (storage && storage.baseDir) || path.join(rootDir, '.genesis'),
      SNAPSHOT_DIR
    );
  }

  /**
   * v7.9.18 (A1 migration): move a pre-v7.9.18 .genesis/snapshots/ folder
   * aside to .genesis/snapshots.deprecated.<timestamp>/ so it can never be
   * read or restored again, while staying forensically inspectable. Must be
   * called BEFORE any list()/restore() — BootRecovery invokes it first thing
   * in preBootCheck. Idempotent: does nothing if no legacy folder exists, or
   * if the legacy location is the same as the new one.
   * @returns {{ migrated: boolean, movedTo?: string }}
   */
  migrateIfNeeded() {
    try {
      if (this._legacyBase === this._snapshotBase) return { migrated: false };
      if (!fs.existsSync(this._legacyBase)) return { migrated: false };
      const movedTo = `${this._legacyBase}.deprecated.${Date.now()}`;
      fs.renameSync(this._legacyBase, movedTo);
      _log.warn(
        `[SNAPSHOT] Legacy snapshots moved out of identity layer: ` +
        `${this._legacyBase} -> ${movedTo} (v7.9.18 A1). ` +
        `New snapshots live at ${this._snapshotBase}.`
      );
      return { migrated: true, movedTo };
    } catch (err) {
      _log.error('[SNAPSHOT] Legacy snapshot migration failed:', err.message);
      return { migrated: false };
    }
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
      // v7.9.18 (A2): code-version fingerprint so restore() can refuse a
      // snapshot from a different habitat version (defense-in-depth on top of
      // A1). The pre-v7.9.16-over-v7.9.17 contamination would have been a
      // codeVersion mismatch and been skipped.
      codeVersion: this._codeVersion(),
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

    // v7.9.18 (A2): refuse to restore a snapshot from a different habitat
    // version. The pre-v7.9.16-over-v7.9.17 contamination was exactly this:
    // an older code tree copied over a newer one. Soft skip (no throw) so a
    // foreign snapshot never bricks the boot — the current code stays live.
    const current = this._codeVersion();
    const snapMeta = safeJsonParse(
      this._readFileSafe(path.join(snapshotDir, '_snapshot.json')),
      {}
    );
    if (snapMeta && snapMeta.codeVersion && current &&
        snapMeta.codeVersion !== current) {
      _log.error(
        `[SNAPSHOT] Restore of "${safeName}" SKIPPED: snapshot codeVersion ` +
        `${snapMeta.codeVersion} != current ${current}. Refusing to copy a ` +
        `foreign-version tree over the live habitat (v7.9.18 A2). ` +
        `Booting with current code.`
      );
      return { restored: 0, skipped: true, reason: 'version-mismatch', name: safeName };
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

  /**
   * v7.9.18 (A2): current habitat code version, read once from
   * <rootDir>/package.json and cached. Returns null if unreadable (in which
   * case the version gate in restore() simply does not fire).
   * @returns {string|null}
   */
  _codeVersion() {
    if (this.__cv !== undefined) return this.__cv;
    try {
      const pkg = safeJsonParse(
        this._readFileSafe(path.join(this.rootDir, 'package.json')),
        {}
      );
      this.__cv = (pkg && pkg.version) || null;
    } catch {
      this.__cv = null;
    }
    return this.__cv;
  }

  /** Read a file as utf-8, or return '' if it does not exist / fails. */
  _readFileSafe(p) {
    try { return fs.readFileSync(p, 'utf-8'); }
    catch { return ''; }
  }

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
