// @ts-check
// ============================================================
// GENESIS — CrashLog.js (v6.0.1)
//
// Rotating file-based error/warn log for crash reporting.
// Ring buffer of the last N entries written to ~/.genesis/crash.log.
//
// When a user reports a bug, this file contains the last 1000
// warn/error entries with timestamps, module names, and stack
// traces — enough to diagnose most issues.
//
// Architecture:
//   Logger._logSink → CrashLog.capture(entry)
//   CrashLog writes to disk on flush interval (5s) or on error
//   File rotates at 500KB → crash.log.1 (keeps 1 old file)
//
// CLI: /crashlog — show last 20 entries
// IPC: agent:get-crash-log — returns recent entries
//
// No external dependencies. No network. Local-only.
// ============================================================

const fs = require('fs');
const path = require('path');

const MAX_ENTRIES = 1000;
const MAX_FILE_SIZE = 512 * 1024; // 500KB
const FLUSH_INTERVAL_MS = 5000;

class CrashLog {
  /**
   * @param {string} genesisDir - Path to ~/.genesis/
   */
  constructor(genesisDir) {
    this._logPath = path.join(genesisDir, 'crash.log');
    this._rotatedPath = path.join(genesisDir, 'crash.log.1');
    /** @type {Array<{ ts: string, level: string, module: string, msg: string, stack?: string }>} */
    this._buffer = [];
    this._dirty = false;
    this._flushTimer = null;
    this._started = false;
  }

  // ════════════════════════════════════════════════════════════
  // LIFECYCLE
  // ════════════════════════════════════════════════════════════

  start() {
    // Load existing entries from disk
    this._loadExisting();

    // Periodic flush
    this._flushTimer = setInterval(() => {
      if (this._dirty) this._flush();
    }, FLUSH_INTERVAL_MS);

    // Unref so it doesn't block shutdown
    if (this._flushTimer.unref) this._flushTimer.unref();

    this._started = true;
  }

  stop() {
    if (this._flushTimer) {
      clearInterval(this._flushTimer);
      this._flushTimer = null;
    }
    // Final flush
    if (this._dirty) this._flushSync();
    this._started = false;
  }

  // ════════════════════════════════════════════════════════════
  // CAPTURE — Called by Logger sink
  // ════════════════════════════════════════════════════════════

  /**
   * Capture a log entry. Only keeps warn and error.
   * @param {{ level: string, module: string, args: Array<*>, format: string }} entry
   */
  capture(entry) {
    if (entry.level !== 'warn' && entry.level !== 'error') return;

    const record = {
      ts: new Date().toISOString(),
      level: entry.level,
      module: entry.module || 'unknown',
      msg: this._formatArgs(entry.args),
    };

    // Extract stack trace from Error objects
    for (const arg of entry.args) {
      if (arg instanceof Error && arg.stack) {
        record.stack = arg.stack;
        break;
      }
    }

    this._buffer.push(record);
    this._dirty = true;

    // Ring buffer eviction
    while (this._buffer.length > MAX_ENTRIES) {
      this._buffer.shift();
    }

    // Flush immediately on errors
    if (entry.level === 'error' && this._started) {
      this._flush();
    }
  }

  // ════════════════════════════════════════════════════════════
  // QUERY
  // ════════════════════════════════════════════════════════════

  /**
   * Get recent crash log entries.
   * @param {number} [count=20] - Number of entries to return
   * @param {string} [level] - Filter by level ('error' | 'warn')
   * @returns {Array<{ ts: string, level: string, module: string, msg: string, stack?: string }>}
   */
  getRecent(count = 20, level) {
    let entries = this._buffer;
    if (level) entries = entries.filter(e => e.level === level);
    return entries.slice(-count);
  }

  /**
   * Get summary statistics.
   * @returns {{ totalEntries: number, errors: number, warns: number, oldestEntry?: string, newestEntry?: string }}
   */
  getStats() {
    const errors = this._buffer.filter(e => e.level === 'error').length;
    const warns = this._buffer.filter(e => e.level === 'warn').length;
    return {
      totalEntries: this._buffer.length,
      errors,
      warns,
      oldestEntry: this._buffer[0]?.ts,
      newestEntry: this._buffer[this._buffer.length - 1]?.ts,
    };
  }

  /** Clear all entries */
  clear() {
    this._buffer = [];
    this._dirty = true;
    this._flush();
  }

  // ════════════════════════════════════════════════════════════
  // PERSISTENCE
  // ════════════════════════════════════════════════════════════

  _flush() {
    try {
      this._rotateIfNeeded();
      const lines = this._buffer.map(e => {
        const base = `[${e.ts}] [${e.level.toUpperCase().padEnd(5)}] [${e.module}] ${e.msg}`;
        return e.stack ? `${base}\n${e.stack}` : base;
      });
      fs.writeFileSync(this._logPath, lines.join('\n') + '\n', 'utf8');
      this._dirty = false;
    } catch (_err) {
      // Silent — logging infra must never throw
    }
  }

  _flushSync() {
    this._flush();
  }

  _rotateIfNeeded() {
    try {
      if (fs.existsSync(this._logPath)) {
        const stat = fs.statSync(this._logPath);
        if (stat.size > MAX_FILE_SIZE) {
          // Rotate: crash.log → crash.log.1
          if (fs.existsSync(this._rotatedPath)) {
            fs.unlinkSync(this._rotatedPath);
          }
          fs.renameSync(this._logPath, this._rotatedPath);
        }
      }
    } catch (_err) {
      // Silent
    }
  }

  _loadExisting() {
    try {
      if (fs.existsSync(this._logPath)) {
        const content = fs.readFileSync(this._logPath, 'utf8');
        const lines = content.split('\n').filter(l => l.trim());
        for (const line of lines) {
          const match = line.match(/^\[(\d{4}-\d{2}-\d{2}T[\d:.]+Z)\]\s+\[(\w+)\s*\]\s+\[(\w+)\]\s+(.*)/);
          if (match) {
            this._buffer.push({
              ts: match[1],
              level: match[2].toLowerCase().trim(),
              module: match[3],
              msg: match[4],
            });
          }
        }
        // Trim to max
        while (this._buffer.length > MAX_ENTRIES) this._buffer.shift();
      }
    } catch (_err) {
      // Start fresh if file is corrupt
      this._buffer = [];
    }
  }

  // ════════════════════════════════════════════════════════════
  // HELPERS
  // ════════════════════════════════════════════════════════════

  _formatArgs(args) {
    return args.map(a => {
      if (a instanceof Error) return a.message;
      if (typeof a === 'object' && a !== null) {
        try { return JSON.stringify(a); }
        catch { return String(a); }
      }
      return String(a);
    }).join(' ');
  }
}

module.exports = { CrashLog };
