// ============================================================
// GENESIS — BootRecovery.js (v4.12.8)
//
// Crash-resilient boot. Solves the problem that SnapshotManager
// exists but is never used for boot recovery.
//
// Strategy:
//   1. Before boot: write a "boot-in-progress" sentinel file
//   2. After successful boot: delete the sentinel
//   3. On next boot: if sentinel exists → last boot crashed
//      → restore from last known-good snapshot
//
// The sentinel is a simple JSON file in .genesis/boot-sentinel.json
// containing the timestamp and a crash counter.
//
// Integration: Called from AgentCore.boot() — wraps the existing
// boot sequence with crash detection and recovery.
// ============================================================

const path = require('path');
const fs = require('fs');
const { createLogger } = require('../core/Logger');
const { safeJsonParse } = require('../core/utils');
const _log = createLogger('BootRecovery');

const SENTINEL_FILE = 'boot-sentinel.json';
const MAX_CRASH_RECOVERIES = 3; // After 3 failed recoveries, boot clean

class BootRecovery {
  constructor({ genesisDir, snapshotManager }) {
    this._genesisDir = genesisDir;
    this._snapshotManager = snapshotManager;
    this._sentinelPath = path.join(genesisDir, SENTINEL_FILE);
  }

  // ── Pre-Boot: Check for crash and recover ─────────────

  /**
   * Called BEFORE the main boot sequence.
   * Returns { recovered: bool, snapshot: string|null, crashCount: number }
   */
  preBootCheck() {
    const sentinel = this._readSentinel();

    if (!sentinel) {
      // Clean state — no crash detected
      this._writeSentinel({ phase: 'booting', ts: Date.now(), crashCount: 0 });
      return { recovered: false, snapshot: null, crashCount: 0 };
    }

    // Sentinel exists → last boot didn't complete
    const crashCount = (sentinel.crashCount || 0) + 1;
    _log.warn(`[RECOVERY] Crash detected! Boot sentinel from ${new Date(sentinel.ts).toISOString()} — crash #${crashCount}`);

    if (crashCount > MAX_CRASH_RECOVERIES) {
      // Too many recovery attempts — boot clean to avoid infinite loop
      _log.warn(`[RECOVERY] ${crashCount} consecutive crashes — booting clean (no restore)`);
      this._writeSentinel({ phase: 'booting', ts: Date.now(), crashCount });
      return { recovered: false, snapshot: null, crashCount };
    }

    // Try to restore from last good snapshot
    if (!this._snapshotManager) {
      _log.warn('[RECOVERY] No SnapshotManager available — cannot restore');
      this._writeSentinel({ phase: 'booting', ts: Date.now(), crashCount });
      return { recovered: false, snapshot: null, crashCount };
    }

    const snapshots = this._snapshotManager.list();
    // Find the last "good" snapshot (not an auto-restore backup)
    const goodSnapshot = snapshots.find(s =>
      !s.name.startsWith('_auto_before_restore') &&
      !s.name.startsWith('_crash_recovery')
    );

    if (!goodSnapshot) {
      _log.warn('[RECOVERY] No suitable snapshot found — booting with current code');
      this._writeSentinel({ phase: 'booting', ts: Date.now(), crashCount });
      return { recovered: false, snapshot: null, crashCount };
    }

    try {
      // Create a safety snapshot of the current (crashing) state
      try {
        this._snapshotManager.create(`_crash_recovery_${Date.now()}`);
      } catch (_e) { /* best effort */ }

      // Restore the good snapshot
      const result = this._snapshotManager.restore(goodSnapshot.name);
      _log.info(`[RECOVERY] Restored snapshot "${goodSnapshot.name}" — ${result.restored} files`);

      this._writeSentinel({ phase: 'booting', ts: Date.now(), crashCount, restoredFrom: goodSnapshot.name });
      return { recovered: true, snapshot: goodSnapshot.name, crashCount };
    } catch (err) {
      _log.error(`[RECOVERY] Restore failed: ${err.message}`);
      this._writeSentinel({ phase: 'booting', ts: Date.now(), crashCount });
      return { recovered: false, snapshot: null, crashCount };
    }
  }

  // ── Post-Boot: Mark success ───────────────────────────

  /**
   * Called AFTER successful boot. Clears the sentinel and creates
   * a "last-known-good" snapshot for future recoveries.
   */
  postBootSuccess() {
    this._clearSentinel();

    // Create a "last-known-good" snapshot (overwrite previous)
    if (this._snapshotManager) {
      try {
        this._snapshotManager.create('_last_good_boot');
        _log.info('[RECOVERY] Last-known-good snapshot updated');
      } catch (err) {
        _log.debug('[RECOVERY] Snapshot creation failed:', err.message);
      }
    }
  }

  // ── Internal ──────────────────────────────────────────

  _readSentinel() {
    try {
      if (!fs.existsSync(this._sentinelPath)) return null;
      const raw = fs.readFileSync(this._sentinelPath, 'utf-8');
      return safeJsonParse(raw, null, 'BootRecovery');
    } catch (_e) {
      return null;
    }
  }

  _writeSentinel(data) {
    try {
      fs.mkdirSync(path.dirname(this._sentinelPath), { recursive: true });
      fs.writeFileSync(this._sentinelPath, JSON.stringify(data, null, 2));
    } catch (err) {
      _log.debug('[RECOVERY] Cannot write sentinel:', err.message);
    }
  }

  _clearSentinel() {
    try {
      if (fs.existsSync(this._sentinelPath)) {
        fs.unlinkSync(this._sentinelPath);
      }
    } catch (_e) { /* best effort */ }
  }
}

module.exports = { BootRecovery };
