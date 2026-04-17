// @ts-checked-v5.7
// ============================================================
// GENESIS — AgentCore.js (v5.0.0 — Delegate Architecture)
//
// Pure orchestrator. Delegates all sub-responsibilities:
//
//   AgentCoreBoot   — 4 boot phases (bootstrap → manifest → resolve → wire)
//   AgentCoreWire   — event handler wiring + UI relay + service start
//   AgentCoreHealth — health snapshot + periodic checks + shutdown
//
// Same pattern as AgentLoop → AgentLoopDelegate/Steps/Planner/Cognition.
// Public API is identical to v5.0.0 — no IPC changes required.
//
// Previous: 1,036 lines / 4 responsibilities
// Now:      ~150 lines / orchestration only
// ============================================================

'use strict';

const path = require('path');
const { TIMEOUTS } = require('./core/Constants');
const fs   = require('fs');

const { bus }           = require('./core/EventBus');
const { Container }     = require('./core/Container');
const { IntervalManager }= require('./core/IntervalManager');
const { createLogger }  = require('./core/Logger');
const { lang }          = require('./core/Language');
const { LIMITS }        = require('./core/Constants');

const { AgentCoreBoot }   = require('./AgentCoreBoot');
const { AgentCoreWire }   = require('./AgentCoreWire');
const { AgentCoreHealth } = require('./AgentCoreHealth');

const _log = createLogger('AgentCore');

class AgentCore {
  constructor({ rootDir, guard, window, bootProfile, skipPhases }) {
    this.rootDir   = rootDir;
    this.guard     = guard;
    this.window    = window;
    this._bus      = bus;
    this.container = new Container({ bus });
    this.intervals = new IntervalManager();
    this.booted    = false;
    this._shutdownCalled = false;
    this._writeLocks     = new Map();
    this._bootStart      = 0;
    this.genesisDir      = null;

    // v5.2.0: Boot profile — 'cognitive' (default since v6.0.4), 'full', 'minimal'
    // v6.0.4: Consciousness A/B benchmark showed 0pp impact → cognitive is default
    this.bootProfile = bootProfile || 'cognitive';
    // v6.0.4: Skip specific phases for A/B benchmarking
    this.skipPhases = skipPhases || [];

    // Delegates — created here so health/wire are available to boot
    this._boot   = new AgentCoreBoot(this);
    this._wire   = new AgentCoreWire(this);
    this._health = new AgentCoreHealth(this);
  }

  // ════════════════════════════════════════════════════════
  // BOOT
  // ════════════════════════════════════════════════════════

  async boot() {
    _log.info('[GENESIS] ======================================');
    _log.info('[GENESIS] Boot sequence starting...');
    this._bootStart = Date.now();
    this.genesisDir = path.join(this.rootDir, '.genesis');

    // Create required directories
    for (const d of ['.genesis', 'sandbox', 'src/skills', 'uploads']) {
      const full = path.join(this.rootDir, d);
      if (!fs.existsSync(full)) fs.mkdirSync(full, { recursive: true });
    }

    // Crash recovery
    let recoveryResult = { recovered: false, snapshot: null };
    try {
      const { BootRecovery }   = require('./foundation/BootRecovery');
      const { SnapshotManager }= require('./capabilities/SnapshotManager');
      const snapshotMgr = new SnapshotManager({ rootDir: this.rootDir, storage: null, guard: this.guard });
      this._bootRecovery = new BootRecovery({ genesisDir: this.genesisDir, snapshotManager: snapshotMgr, rootDir: this.rootDir });
      recoveryResult = this._bootRecovery.preBootCheck();
      if (recoveryResult.recovered) {
        _log.warn(`[GENESIS] Recovered from crash — restored snapshot "${recoveryResult.snapshot}"`);
        this._pushStatus({ state: 'warning', detail: `Crash recovery: restored "${recoveryResult.snapshot}"` });
      }
    } catch (err) { _log.debug('[GENESIS] Boot recovery init:', err.message); }

    try {
      const _phaseTimings = [];
      const _time  = (name, fn)       => { const t0 = Date.now(); const r = fn();      _phaseTimings.push({ name, ms: Date.now() - t0 }); return r; };
      const _timeA = async (name, fn) => { const t0 = Date.now(); const r = await fn();_phaseTimings.push({ name, ms: Date.now() - t0 }); return r; };

      _time('bootstrap', () => this._boot._bootstrapInstances());
      _time('manifest',  () => this._boot._registerFromManifest());

      _time('validate', () => {
        const v = this.container.validateRegistrations();
        if (!v.valid) {
          _log.error(`[GENESIS] Validation failed: ${v.errors.length} error(s)`);
          for (const e of v.errors) _log.error(`  ✗ ${e}`);
        }
        if (v.warnings.length > 0) _log.warn(`[GENESIS] Validation: ${v.warnings.length} warning(s)`);
      });

      await _timeA('resolve', () => this._boot._resolveAndInit());
      await _timeA('wire',    () => this._boot._wireAndStart(this._wire));

      this.booted = true;
      const dt           = Date.now() - this._bootStart;
      const serviceCount = Object.keys(this.container.getDependencyGraph()).length;
      _log.info(`[GENESIS] Boot complete in ${dt}ms — ${serviceCount} services`);
      _log.info('[GENESIS] ======================================');

      // Telemetry
      if (this.container.has('telemetry')) {
        try { this.container.resolve('telemetry').recordBoot(dt, serviceCount, 0, _phaseTimings); }
        catch (_e) { _log.debug('[catch] telemetry:', _e.message); }
      }

      // Safety degradation notification
      try {
        const codeSafety = this.container.tryResolve('codeSafety');
        if (codeSafety && !codeSafety.available) {
          this._bus.emit('safety:degraded', {
            module: 'CodeSafetyScanner',
            reason: 'acorn not installed — AST scanning disabled, self-modification blocked',
          }, { source: 'AgentCore' });
          this._pushStatus({ state: 'warning', detail: 'Safety degraded: acorn missing' });
        }
      } catch (_e) { _log.warn('[catch] safety check:', _e.message); }

      this._pushStatus({ state: 'ready', model: this.container.resolve('model').activeModel });

      // v7.1.0: Fix "booting" badge stuck — the ready status may be sent before
      // the renderer has registered its IPC listener. Re-send when renderer loads.
      if (this.window && !this.window.isDestroyed()) {
        const readyPayload = { state: 'ready', model: this.container.resolve('model').activeModel };
        this.window.webContents.on('did-finish-load', () => this._pushStatus(readyPayload));
        // Also re-send after a short delay as fallback for already-loaded renderers
        setTimeout(() => this._pushStatus(readyPayload), 500);
      }

      if (this._bootRecovery) {
        try { this._bootRecovery.postBootSuccess(); }
        catch (_e) { _log.debug('[GENESIS] Post-boot recovery:', _e.message); }
      }

    } catch (err) {
      _log.error('[GENESIS] Boot failed:', err);
      this._pushStatus({ state: 'error', detail: err.message });
      await this._health._rollbackBoot();
      throw err;
    }
  }

  // ════════════════════════════════════════════════════════
  // IPC BRIDGE  (public API — unchanged from v5.0.0)
  // ════════════════════════════════════════════════════════

  handleChat(message) {
    this.container.resolve('promptBuilder').setQuery(message);
    return this.container.resolve('chatOrchestrator').handleChat(message);
  }

  handleChatStream(message, onChunk, onDone) {
    this.container.resolve('promptBuilder').setQuery(message);
    return this.container.resolve('chatOrchestrator').handleStream(message, onChunk, onDone);
  }

  stopGeneration() { this.container.resolve('chatOrchestrator').stop(); }

  readOwnFile(p) {
    const f = path.resolve(this.rootDir, p);
    if (!f.startsWith(this.rootDir + path.sep) && f !== this.rootDir) return null;
    if (!fs.existsSync(f)) return null;
    if (fs.statSync(f).size > LIMITS.READ_FILE_MAX_BYTES) return null;
    return fs.readFileSync(f, 'utf-8');
  }

  async writeOwnFile(p, content) {
    const { atomicWriteFile } = require('./core/utils');
    const { WriteLock }       = require('./core/WriteLock');
    const f = path.resolve(this.rootDir, p);
    if (!f.startsWith(this.rootDir + path.sep) && f !== this.rootDir) {
      return { ok: false, error: `[SAFEGUARD] Path traversal blocked: ${p}` };
    }
    this.guard.validateWrite(f);
    const dir = path.dirname(f);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    if (!this._writeLocks.has(f)) this._writeLocks.set(f, new WriteLock({ name: `file:${path.basename(f)}` }));
    const lock = this._writeLocks.get(f);
    await lock.acquire();
    try { await atomicWriteFile(f, content, 'utf-8'); }
    finally { lock.release(); }
    this._debouncedScan();
    return { ok: true };
  }

  _debouncedScan() {
    if (this._scanTimer) clearTimeout(this._scanTimer);
    this._scanTimer = setTimeout(() => {
      this._scanTimer = null;
      try { this.container.resolve('selfModel')?.scan(); }
      catch (err) { _log.debug('[GENESIS] Rescan:', err.message); }
    }, 500);
  }

  runInSandbox(code)  { return this.container.resolve('sandbox').execute(code); }
  getFileTree()       { return this.container.resolve('selfModel').getFileTree(); }
  getSelfModel()      { return this.container.resolve('selfModel').getFullModel(); }
  getHealth()         { return this._health.getHealth(); }
  async switchModel(m){
    const r = await this.container.resolve('model').switchTo(m);
    if (this.container.has('contextManager')) this.container.resolve('contextManager').configureForModel(m);
    return r;
  }
  listModels()        { return this.container.resolve('model').availableModels; }
  cloneSelf(cfg)      {
    return this.container.resolve('selfModPipeline').clone(
      cfg?.improvements || 'Klon',
      this.container.resolve('chatOrchestrator').getHistory()
    );
  }

  async undo() {
    try {
      const { promisify }   = require('util');
      const execFileAsync   = promisify(require('child_process').execFile);
      const opts = { cwd: this.rootDir, encoding: 'utf-8', timeout: TIMEOUTS.COMMAND_EXEC, windowsHide: true };
      const { stdout }      = await execFileAsync('git', ['log', '--oneline', '-1'], opts);
      const lastCommit      = stdout.trim();
      if (!lastCommit || lastCommit.includes('Initial') || lastCommit.includes('init')) {
        return { ok: false, error: lang.t('chat.no_revertable_commit') };
      }
      await execFileAsync('git', ['revert', '--no-edit', 'HEAD'], opts);
      this.container.resolve('selfModel')?.scan();
      return { ok: true, reverted: lastCommit, detail: `Revert: ${lastCommit}` };
    } catch (err) {
      return { ok: false, error: err.stderr || err.message };
    }
  }

  async shutdown() {
    if (this._shutdownCalled) return;
    this._shutdownCalled = true;
    await this._health.shutdown();
  }

  _pushStatus(s) {
    if (this.window && !this.window.isDestroyed()) {
      this.window.webContents.send('agent:status-update', s);
    }
  }
}

module.exports = { AgentCore };
