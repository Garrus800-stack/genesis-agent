// ============================================================
// GENESIS — Logger.js (v4.10.0 — Dual-Mode Output)
//
// v4.10.0 UPGRADE: Added JSON output mode for machine-parseable logs.
//
// MODES:
//   'human' (default) — Colored, readable console output:
//     [11:07:47.659] [WARN ] [ModelBridge] message
//
//   'json' — Structured JSON, one object per line:
//     {"ts":"2026-03-24T11:07:47.659Z","level":"warn","module":"ModelBridge","msg":"message"}
//
// Switch mode via:
//   Logger.setFormat('json');    // Enable JSON mode
//   Logger.setFormat('human');   // Back to default
//
// Or at boot via settings: logging.format = 'json'
//
// JSON mode is useful for:
//   - Piping to log aggregators (ELK, Loki, Datadog)
//   - Automated EventStore analysis
//   - Debugging multi-service workflows (grep by module)
//
// BACKWARDS COMPATIBLE: All existing code works unchanged.
// ============================================================

// @ts-check

const LEVELS = { debug: 0, info: 1, warn: 2, error: 3 };

let globalLevel = LEVELS.info;
let globalFormat = 'human'; // 'human' | 'json'

// v4.10.0: Optional log sink for testing / external transport
let _logSink = null;

class Logger {
  constructor(module) {
    this.module = module;
  }

  debug(...args) { this._log('debug', args); }
  info(...args)  { this._log('info', args); }
  warn(...args)  { this._log('warn', args); }
  error(...args) { this._log('error', args); }

  _log(level, args) {
    if (LEVELS[level] < globalLevel) return;

    if (globalFormat === 'json') {
      this._logJson(level, args);
      return;
    }

    // Human-readable format (original)
    const timestamp = new Date().toISOString().slice(11, 23); // HH:MM:SS.mmm
    const prefix = `[${timestamp}] [${level.toUpperCase().padEnd(5)}] [${this.module}]`;

    const fn = level === 'error' ? console.error
             : level === 'warn'  ? console.warn
             : level === 'debug' ? console.debug
             : console.log;

    if (_logSink) {
      _logSink({ level, module: this.module, args, format: 'human' });
    }

    fn(prefix, ...args);
  }

  _logJson(level, args) {
    const entry = {
      ts: new Date().toISOString(),
      level,
      module: this.module,
      msg: args.map(a => {
        if (a instanceof Error) return { error: a.message, stack: a.stack };
        if (typeof a === 'object' && a !== null) {
          try { return a; } catch { return String(a); }
        }
        return String(a);
      }),
    };

    // Flatten single-element msg array
    if (entry.msg.length === 1) entry.msg = entry.msg[0];

    const fn = level === 'error' ? console.error
             : level === 'warn'  ? console.warn
             : level === 'debug' ? console.debug
             : console.log;

    if (_logSink) {
      _logSink({ level, module: this.module, entry, format: 'json' });
    }

    try {
      fn(JSON.stringify(entry));
    } catch (_e) {
      // Fallback if JSON.stringify fails (circular refs)
      fn(JSON.stringify({ ts: entry.ts, level, module: this.module, msg: '[unstringifiable]' }));
    }
  }

  /** Set the global minimum log level */
  static setLevel(level) {
    const normalized = String(level).toLowerCase();
    if (LEVELS[normalized] !== undefined) {
      globalLevel = LEVELS[normalized];
    }
  }

  /** Get current log level name */
  static getLevel() {
    return Object.keys(LEVELS).find(k => LEVELS[k] === globalLevel) || 'info';
  }

  /**
   * v4.10.0: Set output format.
   * @param {'human'|'json'} format
   */
  static setFormat(format) {
    if (format === 'json' || format === 'human') {
      globalFormat = format;
    }
  }

  /** Get current output format */
  static getFormat() {
    return globalFormat;
  }

  /**
   * v4.10.0: Set a log sink for testing or external transport.
   * The sink receives every log entry as an object before console output.
   * Set to null to disable.
   *
   * @param {Function|null} sink - (entry) => void
   */
  static setSink(sink) {
    _logSink = typeof sink === 'function' ? sink : null;
  }
}

function createLogger(module) {
  return new Logger(module);
}

module.exports = { Logger, createLogger };
