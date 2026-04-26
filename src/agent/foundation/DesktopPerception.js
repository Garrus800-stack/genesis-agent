// ============================================================
// GENESIS — DesktopPerception.js (v3.5.0 — Cognitive Agent)
//
// The sensory layer. Genesis becomes aware of its environment
// without being told. File changes, git status, Ollama health,
// system resources — all flow into WorldState automatically.
//
// Perception sources:
//   - File watcher (chokidar) — real-time file change detection
//   - Git poller — branch, dirty state, last commit
//   - Ollama poller — available models, health status
//   - System poller — memory, CPU, disk
//
// All perception flows through EventBus → WorldState updates.
//
// Dependency: chokidar (~12KB) for file watching.
// Install: npm install chokidar
// Falls back gracefully if chokidar is not installed.
// ============================================================

const path = require('path');
const { TIMEOUTS } = require('../core/Constants');
const { execFile } = require('child_process');
const http = require('http');
const { NullBus } = require('../core/EventBus');
const { createLogger } = require('../core/Logger');
const _log = createLogger('DesktopPerception');

// Lazy-load chokidar (v3.x — v4 is ESM-only and incompatible with require())
let chokidar = null;
function getChokidar() {
  if (chokidar === undefined) return null;
  if (!chokidar) {
    try { chokidar = require('chokidar'); }
    catch (_e) {
      chokidar = undefined;
      _log.warn('[PERCEPTION] chokidar not installed — file watching disabled. Install: npm install chokidar@3');
    }
  }
  return chokidar;
}

class DesktopPerception {
  constructor({ bus, worldState, rootDir, intervals }) {
    this.bus = bus || NullBus;
    this.worldState = worldState;
    this.rootDir = rootDir;
    this._intervals = intervals || null;

    this._watcher = null;
    this._running = false;

    // Polling intervals (ms)
    this._gitPollInterval = 30000;     // 30s
    this._ollamaPollInterval = 60000;  // 60s
    this._systemPollInterval = 120000; // 2min
  }

  // ════════════════════════════════════════════════════════
  // LIFECYCLE
  // ════════════════════════════════════════════════════════

  start() {
    if (this._running) return;
    this._running = true;

    // ── File Watcher ──────────────────────────────────────
    this._startFileWatcher();

    // ── Git Status Polling ────────────────────────────────
    const gitPoll = () => this._pollGitStatus();
    if (this._intervals) {
      this._intervals.register('perception-git', gitPoll, this._gitPollInterval);
    }

    // ── Ollama Health Polling ──────────────────────────────
    const ollamaPoll = () => this._pollOllamaStatus();
    if (this._intervals) {
      this._intervals.register('perception-ollama', ollamaPoll, this._ollamaPollInterval);
    }

    // ── System Resources Polling ──────────────────────────
    const systemPoll = () => this._pollSystemResources();
    if (this._intervals) {
      this._intervals.register('perception-system', systemPoll, this._systemPollInterval);
    }

    // Initial polls
    this._pollGitStatus();
    this._pollOllamaStatus();
    this._pollSystemResources();

    _log.info('[PERCEPTION] Active — watching project + polling git/ollama/system');
  }

  stop() {
    this._running = false;

    if (this._watcher) {
      this._watcher.close();
      this._watcher = null;
    }

    if (this._intervals) {
      this._intervals.clear('perception-git');
      this._intervals.clear('perception-ollama');
      this._intervals.clear('perception-system');
    }
  }

  // ════════════════════════════════════════════════════════
  // FILE WATCHER
  // ════════════════════════════════════════════════════════

  _startFileWatcher() {
    const watcher = getChokidar();
    if (!watcher) {
      _log.debug('[PERCEPTION] chokidar not installed — file watching disabled. Install: npm install chokidar');
      return;
    }

    try {
      this._watcher = watcher.watch(this.rootDir, {
        ignored: [
          '**/node_modules/**',
          '**/.git/**',
          '**/.genesis/**',
          '**/*.log',
          '**/sandbox/**',
        ],
        persistent: true,
        ignoreInitial: true,
        depth: 5,
        awaitWriteFinish: {
          stabilityThreshold: 500,
          pollInterval: 100,
        },
      });

      this._watcher.on('change', (filePath) => {
        this.worldState.recordFileChange(filePath);
        this.bus.emit('perception:file-changed', {
          path: path.relative(this.rootDir, filePath),
          event: 'change',
        }, { source: 'DesktopPerception' });
      });

      this._watcher.on('add', (filePath) => {
        this.worldState.recordFileChange(filePath);
        this.bus.emit('perception:file-added', {
          path: path.relative(this.rootDir, filePath),
          event: 'add',
        }, { source: 'DesktopPerception' });
      });

      this._watcher.on('unlink', (filePath) => {
        this.bus.emit('perception:file-removed', {
          path: path.relative(this.rootDir, filePath),
          event: 'unlink',
        }, { source: 'DesktopPerception' });
      });

      this._watcher.on('error', (err) => {
        _log.warn('[PERCEPTION] File watcher error:', err.message);
      });

    } catch (err) {
      _log.warn('[PERCEPTION] File watcher failed to start:', err.message);
    }
  }

  // ════════════════════════════════════════════════════════
  // POLLERS
  // ════════════════════════════════════════════════════════

  _pollGitStatus() {
    this._execFileQuiet('git', ['rev-parse', '--abbrev-ref', 'HEAD'], (err, branch) => {
      if (err) {
        this.worldState.updateGitStatus(null);
        return;
      }

      this._execFileQuiet('git', ['status', '--porcelain'], (err2, status) => {
        const dirtyFiles = (status || '').trim().split('\n').filter(Boolean);

        this._execFileQuiet('git', ['log', '-1', '--pretty=%s'], (err3, lastMsg) => {
          this.worldState.updateGitStatus({
            branch: branch.trim(),
            dirty: dirtyFiles.length > 0 && dirtyFiles[0] !== '',
            dirtyCount: dirtyFiles[0] === '' ? 0 : dirtyFiles.length,
            lastCommitMsg: (lastMsg || '').trim(),
            stagedFiles: dirtyFiles.filter(l =>
              l.startsWith('A ') || l.startsWith('M ') || l.startsWith('D ')
            ).length,
          });
        });
      });
    });
  }

  _pollOllamaStatus() {
    // FIX v4.0.1: Native HTTP instead of exec('curl ...') — no shell spawned.
    const req = http.get('http://127.0.0.1:11434/api/tags', { timeout: TIMEOUTS.QUICK_CHECK }, (res) => {
      let body = '';
      res.on('data', chunk => { body += chunk; });
      res.on('end', () => {
        try {
          const data = JSON.parse(body);
          const models = (data.models || []).map(m => m.name || m.model);
          this.worldState.updateOllamaStatus('running');
          this.worldState.updateOllamaModels(models);
        } catch (_e) { _log.debug("[catch] ollama JSON parse:", _e.message);
          // Ollama responded but invalid JSON — probably running but error
          this.worldState.updateOllamaStatus('error');
        }
        // v7.4.5 Baustein C: notify ResourceRegistry of completed poll
        this._emitOllamaTick();
      });
    });
    req.on('error', () => {
      this.worldState.updateOllamaStatus('stopped');
      this.worldState.updateOllamaModels([]);
      this._emitOllamaTick();
    });
    req.on('timeout', () => {
      req.destroy();
      this.worldState.updateOllamaStatus('stopped');
      this.worldState.updateOllamaModels([]);
      this._emitOllamaTick();
    });
  }

  _emitOllamaTick() {
    try {
      this.bus.fire('perception:ollama-tick', {
        status: this.worldState.state?.runtime?.ollamaStatus || 'unknown',
      }, { source: 'DesktopPerception' });
    } catch (_e) { /* best-effort */ }
  }

  _pollSystemResources() {
    this.worldState.updateMemoryUsage();

    // Emit periodic system health for other modules to react
    const mem = process.memoryUsage();
    const heapUsedPct = mem.heapUsed / mem.heapTotal;

    if (heapUsedPct > 0.85) {
      this.bus.emit('perception:memory-pressure', {
        heapUsedPct: Math.round(heapUsedPct * 100),
        rss: Math.round(mem.rss / (1024 * 1024)),
      }, { source: 'DesktopPerception' });
    }
  }

  // ════════════════════════════════════════════════════════
  // HELPERS
  // ════════════════════════════════════════════════════════

  // FIX v4.0.1: execFile with array args — no shell spawned.
  // Previous: exec(command) which passed everything through a shell.
  _execFileQuiet(bin, args, callback) {
    execFile(bin, args, {
      cwd: this.rootDir,
      timeout: TIMEOUTS.GIT_OP,
      encoding: 'utf-8',
      windowsHide: true,
    }, (err, stdout, stderr) => {
      callback(err, stdout, stderr);
    });
  }

  getStatus() {
    return {
      running: this._running,
      fileWatcher: this._watcher !== null,
      chokidarAvailable: getChokidar() !== null && getChokidar() !== undefined,
    };
  }
}

module.exports = { DesktopPerception };
