// @ts-check
// ============================================================
// GENESIS — BackupManager.js (v6.0.1)
//
// Export and import Genesis user data. Protects against data
// loss in ~/.genesis/ — the single point of failure for all
// persistent state.
//
// Exports:
//   settings.json, knowledge-graph.json, lessons.json,
//   conversation-memory.json, task-outcomes.json,
//   .genesis-replay/ files, .genesis-lessons/archive/
//
// Format: Single .tar.gz archive with manifest.json
//
// CLI:
//   /export           — export to ~/genesis-backup-<date>.tar.gz
//   /import <path>    — import from archive (merges, doesn't overwrite)
//
// IPC:
//   agent:export-data  — trigger export, returns path
//   agent:import-data  — trigger import from path
// ============================================================

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

// Windows tar (bsdtar) works best with forward-slash paths
function _tarPath(p) { return p.replace(/\\/g, '/'); }
const { createLogger } = require('../core/Logger');
const { TIMEOUTS } = require('../core/Constants');
const _log = createLogger('BackupManager');

const BACKUP_FILES = [
  'settings.json',
  'knowledge-graph.json',
  'lessons.json',
  'conversation-memory.json',
  'task-outcomes.json',
  'self-model.json',
  'consolidation-report.json',
  'metabolism.json',
  'session-persistence.json',
  'goal-persistence.json',
];

const BACKUP_DIRS = [
  '.genesis-replay',
  '.genesis-lessons',
];

class BackupManager {
  /**
   * @param {string} genesisDir - Path to ~/.genesis/
   * @param {{ bus?: * }} [opts]
   */
  constructor(genesisDir, opts = {}) {
    this._dir = genesisDir;
    this.bus = opts.bus || { emit() {}, fire() {} };
  }

  // ════════════════════════════════════════════════════════════
  // EXPORT
  // ════════════════════════════════════════════════════════════

  /**
   * Export all Genesis data to a .tar.gz archive.
   * @param {string} [outputPath] - Custom output path. Defaults to ~/genesis-backup-<date>.tar.gz
   * @returns {Promise<{ success: boolean, path?: string, error?: string, stats?: object }>}
   */
  async export(outputPath) {
    try {
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      const homeDir = require('os').homedir();
      const outPath = outputPath || path.join(homeDir, `genesis-backup-${timestamp}.tar.gz`);
      const tmpDir = path.join(this._dir, '.backup-tmp');

      // Clean tmp
      if (fs.existsSync(tmpDir)) fs.rmSync(tmpDir, { recursive: true });
      fs.mkdirSync(tmpDir, { recursive: true });

      let fileCount = 0;
      let totalSize = 0;

      // Copy individual files
      for (const file of BACKUP_FILES) {
        const src = path.join(this._dir, file);
        if (fs.existsSync(src)) {
          const dest = path.join(tmpDir, file);
          fs.copyFileSync(src, dest);
          totalSize += fs.statSync(src).size;
          fileCount++;
        }
      }

      // Copy directories
      for (const dir of BACKUP_DIRS) {
        const src = path.join(this._dir, dir);
        if (fs.existsSync(src) && fs.statSync(src).isDirectory()) {
          const dest = path.join(tmpDir, dir);
          this._copyDir(src, dest);
          const dirSize = this._dirSize(dest);
          totalSize += dirSize;
          fileCount += this._fileCount(dest);
        }
      }

      // Write manifest
      const manifest = {
        version: '6.0.1',
        timestamp: new Date().toISOString(),
        files: fileCount,
        totalSizeBytes: totalSize,
        genesisDir: this._dir,
        hostname: require('os').hostname(),
      };
      fs.writeFileSync(path.join(tmpDir, 'manifest.json'), JSON.stringify(manifest, null, 2));

      // Create tar.gz
      execFileSync('tar', ['-czf', _tarPath(outPath), '-C', _tarPath(tmpDir), '.'], { timeout: TIMEOUTS.BACKUP_TAR });

      // Cleanup
      fs.rmSync(tmpDir, { recursive: true });

      const archiveSize = fs.statSync(outPath).size;
      _log.info(`[BACKUP] Exported ${fileCount} files (${this._fmtSize(totalSize)}) → ${outPath} (${this._fmtSize(archiveSize)})`);

      this.bus.emit('backup:exported', {
        path: outPath, files: fileCount,
        rawSize: totalSize, archiveSize,
      }, { source: 'BackupManager' });

      return {
        success: true, path: outPath,
        stats: { files: fileCount, rawSize: totalSize, archiveSize },
      };
    } catch (err) {
      _log.error('[BACKUP] Export failed:', err.message);
      return { success: false, error: err.message };
    }
  }

  // ════════════════════════════════════════════════════════════
  // IMPORT
  // ════════════════════════════════════════════════════════════

  /**
   * Import Genesis data from a backup archive.
   * Merges with existing data — does NOT overwrite settings.
   * @param {string} archivePath - Path to .tar.gz backup
   * @param {{ overwrite?: boolean }} [opts] - If true, overwrite existing files
   * @returns {Promise<{ success: boolean, error?: string, stats?: object }>}
   */
  async import(archivePath, opts = {}) {
    try {
      if (!fs.existsSync(archivePath)) {
        return { success: false, error: `Archive not found: ${archivePath}` };
      }

      const tmpDir = path.join(this._dir, '.import-tmp');
      if (fs.existsSync(tmpDir)) fs.rmSync(tmpDir, { recursive: true });
      fs.mkdirSync(tmpDir, { recursive: true });

      // Extract
      execFileSync('tar', ['-xzf', _tarPath(archivePath), '-C', _tarPath(tmpDir)], { timeout: TIMEOUTS.BACKUP_TAR });

      // Validate manifest
      const manifestPath = path.join(tmpDir, 'manifest.json');
      if (!fs.existsSync(manifestPath)) {
        fs.rmSync(tmpDir, { recursive: true });
        return { success: false, error: 'Invalid backup — no manifest.json found' };
      }

      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      _log.info(`[BACKUP] Importing backup from ${manifest.timestamp} (${manifest.files} files)`);

      let imported = 0;
      let skipped = 0;

      // Import files
      for (const file of BACKUP_FILES) {
        const src = path.join(tmpDir, file);
        const dest = path.join(this._dir, file);
        if (fs.existsSync(src)) {
          if (fs.existsSync(dest) && !opts.overwrite) {
            // Merge strategy: skip settings, merge others
            if (file === 'settings.json') {
              _log.info(`[BACKUP] Skipped ${file} (existing settings preserved)`);
              skipped++;
              continue;
            }
          }
          fs.copyFileSync(src, dest);
          imported++;
        }
      }

      // Import directories
      for (const dir of BACKUP_DIRS) {
        const src = path.join(tmpDir, dir);
        const dest = path.join(this._dir, dir);
        if (fs.existsSync(src) && fs.statSync(src).isDirectory()) {
          if (!fs.existsSync(dest)) fs.mkdirSync(dest, { recursive: true });
          this._copyDir(src, dest);
          imported += this._fileCount(src);
        }
      }

      // Cleanup
      fs.rmSync(tmpDir, { recursive: true });

      _log.info(`[BACKUP] Import complete — ${imported} files imported, ${skipped} skipped`);

      this.bus.emit('backup:imported', {
        source: archivePath, imported, skipped,
        manifest,
      }, { source: 'BackupManager' });

      return { success: true, stats: { imported, skipped, manifest } };
    } catch (err) {
      _log.error('[BACKUP] Import failed:', err.message);
      return { success: false, error: err.message };
    }
  }

  // ════════════════════════════════════════════════════════════
  // HELPERS
  // ════════════════════════════════════════════════════════════

  _copyDir(src, dest) {
    if (!fs.existsSync(dest)) fs.mkdirSync(dest, { recursive: true });
    for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
      const s = path.join(src, entry.name);
      const d = path.join(dest, entry.name);
      if (entry.isDirectory()) {
        this._copyDir(s, d);
      } else {
        fs.copyFileSync(s, d);
      }
    }
  }

  _dirSize(dir) {
    let size = 0;
    if (!fs.existsSync(dir)) return size;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) size += this._dirSize(p);
      else size += fs.statSync(p).size;
    }
    return size;
  }

  _fileCount(dir) {
    let count = 0;
    if (!fs.existsSync(dir)) return count;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) count += this._fileCount(path.join(dir, entry.name));
      else count++;
    }
    return count;
  }

  _fmtSize(bytes) {
    if (bytes >= 1048576) return `${(bytes / 1048576).toFixed(1)} MB`;
    if (bytes >= 1024) return `${(bytes / 1024).toFixed(0)} KB`;
    return `${bytes} B`;
  }
}

module.exports = { BackupManager };
