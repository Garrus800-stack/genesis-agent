// @ts-checked-v5.7
// ============================================================
// GENESIS — GenesisBackup.js (v7.2.3)
//
// Standalone backup system for the .genesis/ folder. NOT an extension of
// SnapshotManager — SnapshotManager handles source code via Git, this
// handles data (.genesis/ contents) via copy-to-sibling-folder.
//
// Why this module exists:
//   Genesis' identity lives in .genesis/ (knowledge graph, emotional state,
//   self-identity, journal, genome, etc.). The source code is replaceable;
//   .genesis/ is not. See docs/ONTOGENESIS.md for why this matters.
//
// Four triggers:
//   1. Boot-if-stale — on startup, backup if the last one is > 24h old.
//   2. Pre-self-mod  — before SelfModificationPipeline writes begin.
//   3. Pre-recovery  — before BootRecovery rolls back current state.
//   4. On shutdown   — after all services have flushed, before exit.
//
// Storage:
//   Location: <rootDir>/.genesis-backups/     (sibling of .genesis/)
//   Format:   .genesis-backups/<ISO-timestamp>/<all files from .genesis/>
//   Rotation: keep at most 5 most recent, rotate oldest out after each new backup.
//
// Concurrency:
//   Simple in-process mutex. If a backup is already running (e.g. async
//   boot-backup started, then pre-self-mod backup requested), the second
//   caller returns { skipped: true, reason: 'already running' } rather
//   than starting a parallel copy.
//
// Failure mode:
//   Backup failures log at ERROR (not WARN) and emit safety:degraded.
//   Genesis continues to run — backup failure must not crash the process.
//   But the user MUST see a clear signal; silent failure is not acceptable.
// ============================================================

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { createLogger } = require('../core/Logger');
const _log = createLogger('GenesisBackup');

const STALE_THRESHOLD_MS = 24 * 60 * 60 * 1000; // 24h
const DEFAULT_MAX_BACKUPS = 5;

class GenesisBackup {
  /**
   * @param {Object} opts
   * @param {string} opts.genesisDir  - Absolute path to .genesis/ folder
   * @param {string} opts.rootDir     - Absolute path to project root (sibling of .genesis/)
   * @param {Object} [opts.bus]       - EventBus (optional, for safety:degraded events)
   * @param {number} [opts.maxBackups=5] - Retention count
   */
  constructor(opts = {}) {
    this.genesisDir = opts.genesisDir;
    this.rootDir = opts.rootDir;
    this.bus = opts.bus || null;
    this.maxBackups = opts.maxBackups || DEFAULT_MAX_BACKUPS;

    if (!this.genesisDir || !this.rootDir) {
      throw new Error('GenesisBackup requires genesisDir and rootDir');
    }

    this.backupsDir = path.join(this.rootDir, '.genesis-backups');

    // In-process mutex — prevents parallel backup operations
    this._running = false;

    this._stats = {
      created: 0,
      skipped: 0,
      failed: 0,
      lastBackupAt: null,
      lastError: null,
    };

    // Ensure backup directory exists (first boot creates it)
    this._ensureBackupsDir();
  }

  _ensureBackupsDir() {
    try {
      if (!fs.existsSync(this.backupsDir)) {
        fs.mkdirSync(this.backupsDir, { recursive: true });
      }
    } catch (err) {
      _log.error('Failed to create .genesis-backups/ folder:', err.message);
    }
  }

  // ────────────────────────────────────────────────────────────
  // Public API
  // ────────────────────────────────────────────────────────────

  /**
   * Make a backup. Returns a result object, never throws.
   * @param {string} reason - Why this backup is being made (for logging).
   * @returns {Promise<{ok: boolean, path?: string, reason?: string, skipped?: boolean}>}
   */
  async backup(reason = 'manual') {
    if (this._running) {
      this._stats.skipped++;
      _log.debug(`[BACKUP] Skipped (${reason}) — another backup in progress`);
      return { ok: false, skipped: true, reason: 'already running' };
    }

    this._running = true;
    try {
      const result = await this._doBackup(reason);
      return result;
    } finally {
      this._running = false;
    }
  }

  /**
   * Make a backup IF the last one is older than the stale threshold.
   * Used at boot.
   * @param {string} reason
   * @returns {Promise<{ok: boolean, skipped?: boolean, reason?: string}>}
   */
  async backupIfStale(reason = 'stale-check') {
    const lastMs = this._getLastBackupMs();
    const age = lastMs === null ? Infinity : Date.now() - lastMs;

    if (age < STALE_THRESHOLD_MS) {
      _log.debug(`[BACKUP] Skipped stale-check — last backup ${Math.round(age / 60000)}min old`);
      return { ok: true, skipped: true, reason: 'not stale yet' };
    }

    _log.info(`[BACKUP] Stale-check triggers backup (last was ${lastMs === null ? 'never' : Math.round(age / 3600000) + 'h ago'})`);
    return this.backup(reason);
  }

  /** @returns {{created: number, skipped: number, failed: number, lastBackupAt: number|null, lastError: string|null, running: boolean}} */
  getStats() {
    return { ...this._stats, running: this._running };
  }

  /**
   * List all existing backup directories (newest first).
   * @returns {Array<{name: string, path: string, timestamp: number}>}
   */
  listBackups() {
    try {
      if (!fs.existsSync(this.backupsDir)) return [];
      const entries = fs.readdirSync(this.backupsDir, { withFileTypes: true });
      const backups = [];
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const fullPath = path.join(this.backupsDir, entry.name);
        try {
          const stat = fs.statSync(fullPath);
          backups.push({
            name: entry.name,
            path: fullPath,
            timestamp: stat.mtimeMs,
          });
        } catch (_e) { /* skip unreadable */ }
      }
      return backups.sort((a, b) => b.timestamp - a.timestamp);
    } catch (err) {
      _log.error('Failed to list backups:', err.message);
      return [];
    }
  }

  // ────────────────────────────────────────────────────────────
  // Internal
  // ────────────────────────────────────────────────────────────

  async _doBackup(reason) {
    // Verify source exists
    if (!fs.existsSync(this.genesisDir)) {
      this._stats.failed++;
      this._stats.lastError = '.genesis/ folder does not exist';
      _log.error(`[BACKUP] Source missing: ${this.genesisDir}`);
      this._emitDegraded('backup source missing');
      return { ok: false, reason: 'source missing' };
    }

    const timestamp = this._timestampFolderName();
    const targetDir = path.join(this.backupsDir, timestamp);

    try {
      this._ensureBackupsDir(); // just in case it was deleted between calls
      await fsp.mkdir(targetDir, { recursive: true });
      await this._copyDir(this.genesisDir, targetDir);

      this._stats.created++;
      this._stats.lastBackupAt = Date.now();
      _log.info(`[BACKUP] .genesis/ snapshotted to .genesis-backups/${timestamp} (reason: ${reason})`);

      // Rotate after successful backup (best-effort — rotation failure shouldn't fail the backup)
      try {
        await this._rotate();
      } catch (err) {
        _log.warn(`[BACKUP] Rotation failed (non-fatal): ${err.message}`);
      }

      return { ok: true, path: targetDir };
    } catch (err) {
      this._stats.failed++;
      this._stats.lastError = err.message;
      _log.error(`[BACKUP] Failed (${reason}):`, err.message);
      this._emitDegraded(`backup failed: ${err.message}`);
      // Try to clean up incomplete backup
      try { await fsp.rm(targetDir, { recursive: true, force: true }); } catch (_e) { /* best effort */ }
      return { ok: false, reason: err.message };
    }
  }

  _timestampFolderName() {
    // ISO 8601 with ':' and '.' replaced by '-' (valid on Windows)
    return new Date().toISOString().replace(/[:.]/g, '-');
  }

  async _copyDir(src, dst) {
    // Node 16.7+: fs.cp is available. Fallback manual if not.
    if (typeof fsp.cp === 'function') {
      await fsp.cp(src, dst, { recursive: true, force: true, errorOnExist: false });
      return;
    }
    // Manual recursive copy
    const entries = await fsp.readdir(src, { withFileTypes: true });
    for (const entry of entries) {
      const srcPath = path.join(src, entry.name);
      const dstPath = path.join(dst, entry.name);
      if (entry.isDirectory()) {
        await fsp.mkdir(dstPath, { recursive: true });
        await this._copyDir(srcPath, dstPath);
      } else if (entry.isFile()) {
        await fsp.copyFile(srcPath, dstPath);
      }
      // Symlinks and other file types are skipped intentionally
    }
  }

  async _rotate() {
    const backups = this.listBackups();
    if (backups.length <= this.maxBackups) return;

    // Delete oldest (anything beyond maxBackups)
    const toDelete = backups.slice(this.maxBackups);
    for (const backup of toDelete) {
      try {
        await fsp.rm(backup.path, { recursive: true, force: true });
        _log.debug(`[BACKUP] Rotated out: ${backup.name}`);
      } catch (err) {
        _log.warn(`[BACKUP] Failed to rotate out ${backup.name}: ${err.message}`);
      }
    }
  }

  _getLastBackupMs() {
    const backups = this.listBackups();
    if (backups.length === 0) return null;
    return backups[0].timestamp;
  }

  _emitDegraded(reason) {
    if (!this.bus) return;
    try {
      this.bus.emit('safety:degraded', {
        service: 'genesisBackup',
        level: 'warning',
        reason,
      }, { source: 'GenesisBackup' });
    } catch (_e) { /* emit best-effort */ }
  }
}

module.exports = { GenesisBackup };
