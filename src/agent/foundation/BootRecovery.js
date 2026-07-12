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
const os = require('os');
const { createLogger } = require('../core/Logger');
const { safeJsonParse } = require('../core/utils');
const { LOCK } = require('../core/Constants');
const _log = createLogger('BootRecovery');

const SENTINEL_FILE = 'boot-sentinel.json';
const LOCK_FILENAME = '.genesis.lock'; // v7.9.23: single-instance lock, sibling of .genesis/
const MAX_CRASH_RECOVERIES = 3; // After 3 failed recoveries, boot clean

class BootRecovery {
  constructor({ genesisDir, snapshotManager, rootDir }) {
    this._genesisDir = genesisDir;
    this._snapshotManager = snapshotManager;
    this._rootDir = rootDir || null; // v7.2.3: for direct GenesisBackup instantiation
    this._sentinelPath = path.join(genesisDir, SENTINEL_FILE);
  }

  // ── Pre-Boot: Check for crash and recover ─────────────

  /**
   * Called BEFORE the main boot sequence.
   * Returns { recovered: bool, snapshot: string|null, crashCount: number }
   */
  preBootCheck() {
    // v7.9.18 (A1): move any pre-v7.9.18 .genesis/snapshots/ aside BEFORE
    // any list()/restore() can read it. Idempotent; runs on every boot.
    if (this._snapshotManager && typeof this._snapshotManager.migrateIfNeeded === 'function') {
      this._snapshotManager.migrateIfNeeded();
    }

    const sentinel = this._readSentinel();

    if (!sentinel) {
      // Clean state — no crash detected
      this._writeSentinel({ phase: 'booting', ts: Date.now(), crashCount: 0 });
      return { recovered: false, snapshot: null, crashCount: 0 };
    }

    // v7.9.30 (S7): a sentinel tagged from a test-boot — or ANY boot currently
    // running under test — is not a crash. Clear it quietly and start clean,
    // so the test harness never surfaces a phantom "Crash detected! — crash
    // #1" from a prior test-boot's un-cleaned sentinel. Production
    // crash-recovery is untouched: a real crash outside test still trips below.
    if (sentinel.test === true || process.env.NODE_ENV === 'test' || process.env.GENESIS_TEST) {
      _log.info('[RECOVERY] Test-boot sentinel — clean start (not a crash)');
      this._writeSentinel({ phase: 'booting', ts: Date.now(), crashCount: 0 });
      return { recovered: false, snapshot: null, crashCount: 0 };
    }

    // Sentinel exists → last boot didn't complete
    const crashCount = (sentinel.crashCount || 0) + 1;
    _log.warn(`[RECOVERY] Crash detected! Boot sentinel from ${new Date(sentinel.ts).toISOString()} — crash #${crashCount}`);
    // v7.9.37 pass 6 (S-E): the crash leaves a trace — field 11.07.: crash #1
    // had no line in flight-recorder (the recorder transport starts later).
    try {
      const _p = require('path');
      const _fs = require('fs');
      const _gen = _p.join(this.rootDir || process.cwd(), '.genesis');
      let _extra = '';
      try {
        const _cl = _p.join(_gen, 'crash.log');
        if (_fs.existsSync(_cl)) {
          const _lines = _fs.readFileSync(_cl, 'utf8').trim().split('\n');
          _extra = ` — last crash.log entry: ${_lines[_lines.length - 1].slice(0, 200)}`;
        }
      } catch (_e2) { /* best-effort */ }
      _fs.appendFileSync(_p.join(_gen, 'flight-recorder.log'),
        `[${new Date().toISOString()}] [WARN ] [BootRecovery] [RECOVERY] crash #${crashCount} detected at boot (sentinel ${new Date(sentinel.ts).toISOString()})${_extra}\n`);
    } catch (_e) { /* best-effort */ }

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

      // v7.2.3: Pre-recovery backup of .genesis/ data.
      // Even though we're about to restore from a good snapshot, the current
      // (possibly damaged) .genesis/ state might contain evidence worth keeping —
      // recent journal entries, emotional imprints, error patterns. Snapshot it
      // before the restore overwrites anything.
      // Direct instantiation because DI container is not yet built at this phase.
      if (this._rootDir) {
        try {
          const { GenesisBackup } = require('./GenesisBackup');
          const gb = new GenesisBackup({
            genesisDir: this._genesisDir,
            rootDir: this._rootDir,
          });
          // Sync-await: we want the backup to complete before restore overwrites
          gb.backup('pre-recovery').catch(err => {
            _log.debug('[RECOVERY] Pre-recovery backup failed (non-fatal):', err.message);
          });
        } catch (err) {
          _log.debug('[RECOVERY] Pre-recovery backup init failed:', err.message);
        }
      }

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
   *
   * v7.9.18 (A3): only freezes _last_good_boot when the boot was clean.
   * If any service.start() failed (startFailures non-empty, supplied by
   * AgentCore from AgentCoreWire), the snapshot is SKIPPED so a degraded
   * boot is never frozen as the recovery target — the previous healthy
   * _last_good_boot stays untouched, and the next clean boot can update it.
   * @param {string[]} [startFailures] - names of services whose start() threw
   */
  postBootSuccess(startFailures = []) {
    this._clearSentinel();

    if (Array.isArray(startFailures) && startFailures.length > 0) {
      _log.error(
        `[RECOVERY] last-good-boot skipped: ${startFailures.length} service start failure(s) ` +
        `[${startFailures.join(', ')}] — not freezing a degraded boot as recovery target`
      );
      return;
    }

    // Create a "last-known-good" snapshot (overwrite previous).
    // v7.9.37 (T3): scheduled OFF the boot path. create() copies ~400 files with
    // copyFileSync — measured at 4.8s of a 6.7s boot in the field. The snapshot
    // describes a boot that already succeeded, so writing it a tick later is both
    // faster and semantically truer. Boot returns immediately; the disk catches up.
    if (this._snapshotManager) {
      setTimeout(() => {
        try {
          const t0 = Date.now();
          this._snapshotManager.create('_last_good_boot');
          _log.info(`[RECOVERY] Last-known-good snapshot updated (background, ${Date.now() - t0}ms)`);
        } catch (err) {
          _log.debug('[RECOVERY] Snapshot creation failed:', err.message);
        }
      }, 0).unref?.();
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
      // v7.9.30 (S7): tag sentinels written under test, so a leftover from a
      // test-boot that didn't tear down cleanly is not misread as a crash on
      // the next boot.
      if ((process.env.NODE_ENV === 'test' || process.env.GENESIS_TEST) && data && data.test === undefined) {
        data = { ...data, test: true };
      }
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

  // ── Single-instance lock (v7.9.23) ────────────────────
  // The lock file lives as a SIBLING of .genesis/ (in rootDir, beside .genesis-backups) so a
  // GenesisBackup of .genesis/ never captures it. Content: { pid, ts, host }. A live holder keeps the
  // ts fresh via an unref'd heartbeat. acquireLock() is called from AgentCore BEFORE preBootCheck.

  _lockFilePath() {
    return this._rootDir ? path.join(this._rootDir, LOCK_FILENAME) : null;
  }

  /**
   * Liveness of an existing lock record. The stale check runs FIRST (guards pid reuse): a heartbeat
   * ts older than LOCK.STALE_MS means the holder is gone regardless of which process now owns that
   * pid. On a fresh ts a different host cannot be probed, so it is taken as alive; on the same host
   * the pid is probed (ESRCH = dead, EPERM = alive-but-not-ours, success = alive).
   */
  _isLockAlive(held) {
    if (!held || typeof held.pid !== 'number' || typeof held.ts !== 'number') return false;
    if (Date.now() - held.ts > LOCK.STALE_MS) return false;
    if (held.host && held.host !== os.hostname()) return true;
    try {
      process.kill(held.pid, 0);
      return true;
    } catch (err) {
      if (err.code === 'ESRCH') return false;
      return true; // EPERM or unknown → conservatively alive
    }
  }

  _writeLock() {
    const p = this._lockFilePath();
    if (!p) return;
    try {
      fs.writeFileSync(p, JSON.stringify({ pid: process.pid, ts: Date.now(), host: os.hostname() }), 'utf8');
    } catch (err) {
      _log.warn('[LOCK] Failed to write lock file:', err.message);
    }
  }

  _startHeartbeat() {
    if (this._heartbeatTimer) return;
    // Raw setInterval (pre-DI, before IntervalManager exists) — kept unref'd so it never holds the
    // process open. Exempt in scripts/architectural-fitness.js alongside CrashLog.
    this._heartbeatTimer = setInterval(() => { this._writeLock(); }, LOCK.HEARTBEAT_MS);
    if (this._heartbeatTimer && typeof this._heartbeatTimer.unref === 'function') this._heartbeatTimer.unref();
  }

  /**
   * Acquire the single-instance lock. Throws an Error tagged { code: 'GENESIS_LOCK_HELD' } when a
   * live instance already holds it (the caller aborts the boot). A stale or unreadable lock is
   * reclaimed. No-op when rootDir is unavailable (cannot place a sibling lock).
   */
  acquireLock() {
    const p = this._lockFilePath();
    if (!p) { _log.debug('[LOCK] No rootDir — single-instance lock skipped'); return; }
    try {
      if (fs.existsSync(p)) {
        const held = safeJsonParse(fs.readFileSync(p, 'utf8'), null);
        if (this._isLockAlive(held)) {
          const e = new Error(`Another Genesis instance is already running (pid ${held.pid} on ${held.host}, last beat ${new Date(held.ts).toISOString()}). Refusing to start a second instance.`);
          e.code = 'GENESIS_LOCK_HELD';
          throw e;
        }
        _log.warn(`[LOCK] Reclaiming stale lock (pid ${held && held.pid}, age ${held ? Math.round((Date.now() - held.ts) / 1000) : '?'}s)`);
      }
    } catch (err) {
      if (err.code === 'GENESIS_LOCK_HELD') throw err;
      _log.warn('[LOCK] Lock read failed, reclaiming:', err.message);
    }
    this._writeLock();
    this._startHeartbeat();
    _log.info(`[LOCK] Acquired single-instance lock (pid ${process.pid})`);
  }

  /** Release the lock: stop the heartbeat and remove the file if it is still ours. */
  releaseLock() {
    if (this._heartbeatTimer) {
      clearInterval(this._heartbeatTimer);
      this._heartbeatTimer = null;
    }
    const p = this._lockFilePath();
    if (!p) return;
    try {
      if (fs.existsSync(p)) {
        const held = safeJsonParse(fs.readFileSync(p, 'utf8'), null);
        if (!held || held.pid === process.pid) fs.unlinkSync(p);
      }
    } catch (err) {
      _log.warn('[LOCK] Failed to release lock file:', err.message);
    }
  }
}

module.exports = { BootRecovery };
