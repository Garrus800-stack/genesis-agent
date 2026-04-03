// @ts-checked-v5.7
// ============================================================
// GENESIS — AgentCoreHealth.js (v5.0.0)
//
// Health-check + lifecycle delegate for AgentCore.
//
// Responsibilities:
//   getHealth()            — Composite health snapshot (1s cache)
//   _periodicHealthCheck() — Kernel integrity + Ollama + disk
//   _checkDiskSpace()      — Cross-platform du / PowerShell
//   _pushHealthTick()      — Lightweight UI heartbeat
//   _rollbackBoot()        — Emergency stop on boot failure
//   shutdown()             — Ordered graceful teardown
// ============================================================

'use strict';

const path = require('path');
const { createLogger } = require('./core/Logger');
const { LIMITS, TIMEOUTS } = require('./core/Constants');

const _log = createLogger('AgentCoreHealth');

class AgentCoreHealth {
  /** @param {import('./AgentCore').AgentCore} core */
  constructor(core) {
    this._core = core;
    // 1-second health snapshot cache — avoids recomputing on every IPC call
    this._healthCache   = null;
    this._healthCacheTs = 0;
  }

  get _c()   { return this._core.container; }
  get _bus() { return this._core._bus; }

  // ════════════════════════════════════════════════════════
  // COMPOSITE HEALTH SNAPSHOT
  // ════════════════════════════════════════════════════════

  getHealth() {
    const now = Date.now();
    if (this._healthCache && (now - this._healthCacheTs) < 1000) {
      return this._healthCache;
    }

    const c    = this._c;
    const core = this._core;
    const safe = (name, fn) => {
      try { return c.has(name) ? fn(c.resolve(name)) : null; }
      catch (_e) { _log.debug('[catch] health resolve:', _e.message); return null; }
    };

    this._healthCache = {
      kernel:    core.guard.verifyIntegrity(),
      model:     { active: c.resolve('model').activeModel, available: c.resolve('model').availableModels },
      modules:   c.resolve('selfModel').moduleCount(),
      skills:    c.resolve('skills').listSkills(),
      memory:    c.resolve('memory').getStats(),
      userName:  c.resolve('memory')?.getUserName?.() || null,
      knowledgeGraph: c.resolve('knowledgeGraph').getStats(),
      eventStore:     c.resolve('eventStore').getStats(),
      tools:          c.resolve('tools').listTools().length,
      daemon:         c.resolve('daemon').getStatus(),
      idleMind:       c.resolve('idleMind').getStatus(),
      goals:    { active: c.resolve('goalStack').getActiveGoals().length, total: c.resolve('goalStack').getAll().length },
      circuit:  c.resolve('circuitBreaker').getStatus(),
      web:      c.resolve('webFetcher').getStats(),
      anthropicConfigured: c.resolve('settings').hasAnthropic(),
      sandboxAudit: c.resolve('sandbox').getAuditLog().length,
      shell:        c.resolve('shellAgent').getStats(),
      mcp:          safe('mcpClient',     m  => m.getStatus()),
      learning:     safe('learningService', l => l.getMetrics()),
      embeddings:   safe('embeddingService', e => e.getStats()),
      unifiedMemory:safe('unifiedMemory', u  => u.getStats()),
      healthMonitor:safe('healthMonitor', h  => h.getReport()),
      storage:      safe('storage',       s  => s.getStats()),
      organism: {
        emotions:    safe('emotionalState',      e  => e.getReport()),
        homeostasis: safe('homeostasis',          h  => h.getReport()),
        needs:       safe('needsSystem',          n  => n.getReport()),
        effectors:   safe('homeostasisEffectors', he => he.getReport()),
        metabolism:  safe('metabolism',           m  => m.getReport()),
        immune:      safe('immuneSystem',         is => is.getReport()),
        genome:      safe('genome',               g  => g.getReport?.() || { traits: g.getTraits() }),
        fitness:     safe('fitnessEvaluator',     fe => fe.getStats()),
      },
      cognitiveMonitor: safe('cognitiveMonitor', cm => cm.getReport()),
      cognitive: {
        verifier:       safe('verifier',             v  => v.getStats()),
        worldState:     safe('worldState',            ws => ({ ollamaStatus: ws.getOllamaStatus(), recentFiles: ws.getRecentlyModified().length })),
        formalPlanner:  safe('formalPlanner',         () => ({ loaded: true })),
        metaLearning:   safe('metaLearning',          m  => m.getStats?.() || { loaded: true }),
        episodicMemory: safe('episodicMemory',        e  => e.getStats?.() || { loaded: true }),
        modelRouter:    safe('modelRouter',           () => ({ loaded: true })),
        healthTracker:  safe('cognitiveHealthTracker',cht => cht.getReport()),
      },
      consciousness: {
        phenomenalField: safe('phenomenalField',       pf => pf.getReport()),
        attention:       safe('attentionalGate',       ag => ag.getReport()),
        temporalSelf:    safe('temporalSelf',          ts => ts.getReport()),
        introspection:   safe('introspectionEngine',   ie => ie.getReport()),
        extension:       safe('consciousnessExtension',ce => ({ state: ce.getState?.(), snapshot: !!ce.getSnapshot?.() })),
        values:          safe('valueStore',            vs => vs.getReport()),
        userModel:       safe('userModel',             um => um.getReport()),
        bodySchema:      safe('bodySchema',            bs => bs.getReport()),
      },
      intervals: core.intervals.getStatus(),
      services:  Object.keys(c.getDependencyGraph()).length,
      uptime:    process.uptime(),
    };
    this._healthCacheTs = now;
    return this._healthCache;
  }

  // ════════════════════════════════════════════════════════
  // PERIODIC HEALTH CHECK
  // ════════════════════════════════════════════════════════

  async _periodicHealthCheck() {
    try {
      const integrity = this._core.guard.verifyIntegrity();
      if (!integrity.ok) {
        this._bus.emit('agent:status', { state: 'error', detail: 'Kernel integrity check FAILED' }, { source: 'HealthCheck' });
        this._c.resolve('eventStore').append('HEALTH_ALERT', { type: 'kernel', detail: integrity }, 'HealthCheck');
      }
      const model = this._c.resolve('model');
      if (model.activeBackend === 'ollama') {
        try {
          await model.detectAvailable();
          if (model.availableModels.filter(m => m.backend === 'ollama').length === 0) {
            this._bus.emit('model:ollama-unavailable', { error: 'No Ollama models found' }, { source: 'HealthCheck' });
          }
        } catch (_e) {
          this._bus.emit('model:ollama-unavailable', { error: 'Ollama unreachable' }, { source: 'HealthCheck' });
        }
      }
      await this._checkDiskSpace();
    } catch (err) { _log.debug('[HEALTH] Periodic check failed:', err.message); }
  }

  // ════════════════════════════════════════════════════════
  // DISK SPACE CHECK  (cross-platform: du / PowerShell)
  // ════════════════════════════════════════════════════════

  _checkDiskSpace() {
    return new Promise((resolve) => {
      const genesisDir = this._core.genesisDir;
      if (!genesisDir) { resolve(undefined); return; }
      const isWin      = process.platform === 'win32';
      const opts       = { timeout: TIMEOUTS.DISK_CHECK, windowsHide: true, encoding: 'utf-8' };
      const cb = (err, stdout) => {
        // @ts-ignore — resolve() without args
        if (err) { resolve(); return; }
        const bytes = parseInt(String(stdout).trim()) || 0;
        if (bytes > LIMITS.DISK_WARN_BYTES) {
          this._bus.emit('agent:status', {
            state: 'warning',
            detail: `.genesis dir is ${Math.round(bytes / 1024 / 1024)}MB — consider cleanup`,
          }, { source: 'HealthCheck' });
        }
        // @ts-ignore — resolve without args
        resolve();
      };
      const { execFile: ef } = require('child_process');
      if (isWin) {
        // Base64-encoded ScriptBlock prevents injection via path special chars
        const psScript = `(Get-ChildItem -LiteralPath '${genesisDir.replace(/'/g, "''")}' -Recurse -File -ErrorAction SilentlyContinue | Measure-Object -Property Length -Sum).Sum`;
        const encoded  = Buffer.from(psScript, 'utf16le').toString('base64');
        ef('powershell', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], opts, cb);
      } else {
        ef('du', ['-sb', genesisDir], opts, cb);
      }
    });
  }

  // ════════════════════════════════════════════════════════
  // LIGHTWEIGHT UI HEARTBEAT
  // ════════════════════════════════════════════════════════

  _pushHealthTick() {
    const core = this._core;
    if (!core.window || core.window.isDestroyed()) return;
    try {
      const c = this._c;
      core.window.webContents.send('agent:status-update', {
        state:   'health-tick',
        model:   c.resolve('model').activeModel,
        memory:  c.resolve('memory').getStats(),
        goals:   c.resolve('goalStack').getActiveGoals().length,
        uptime:  process.uptime(),
        circuit: c.resolve('circuitBreaker').getStatus(),
      });
    } catch (_e) { _log.warn('[catch] health tick push:', _e.message); }
  }

  // ════════════════════════════════════════════════════════
  // EMERGENCY BOOT ROLLBACK
  // ════════════════════════════════════════════════════════

  async _rollbackBoot() {
    const c     = this._c;
    const safeStop = (name, method = 'stop') => {
      try { c.tryResolve(name)?.[method](); }
      catch (err) { _log.debug('[ROLLBACK]', name, err.message); }
    };
    safeStop('healthMonitor');
    safeStop('idleMind');
    safeStop('daemon');
    safeStop('cognitiveMonitor');
    safeStop('desktopPerception');
    try { await c.tryResolve('workerPool')?.shutdown(); }   catch (err) { _log.debug('[ROLLBACK] workerPool', err.message); }
    safeStop('hotReloader', 'unwatchAll');
    try { await c.tryResolve('network')?.shutdown(); }      catch (err) { _log.debug('[ROLLBACK] network', err.message); }
    try { await c.tryResolve('mcpClient')?.shutdown(); }    catch (err) { _log.debug('[ROLLBACK] mcpClient', err.message); }
    safeStop('sandbox', 'cleanup');
    this._core.intervals.shutdown();
    _log.info('[GENESIS] Boot rollback completed');
  }

  // ════════════════════════════════════════════════════════
  // GRACEFUL SHUTDOWN
  // ════════════════════════════════════════════════════════

  async shutdown() {
    _log.info('[GENESIS] Shutting down...');

    this._core.intervals.shutdown();
    const c      = this._c;
    const errors = [];

    const safe      = (name, fn)       => { try { fn(); } catch (err) { errors.push(`${name}: ${err.message}`); _log.warn(`[SHUTDOWN] ${name}:`, err.message); } };
    const safeAsync = async (name, fn) => { try { await fn(); } catch (err) { errors.push(`${name}: ${err.message}`); _log.warn(`[SHUTDOWN] ${name}:`, err.message); } };
    const safeRetry = async (name, fn, maxRetries = 2) => {
      for (let attempt = 0; attempt <= maxRetries; attempt++) {
        try { await fn(); return; }
        catch (err) {
          if (attempt === maxRetries) { errors.push(`${name}: ${err.message}`); _log.error(`[SHUTDOWN] ${name} FAILED:`, err.message); }
          else { await new Promise(r => setTimeout(r, 200)); }
        }
      }
    };

    // Session summary (needs LLM alive)
    await safeAsync('sessionSummary', async () => {
      const sp = c.tryResolve('sessionPersistence');
      if (sp) {
        const history = c.tryResolve('chatOrchestrator')?.getHistory() || [];
        await sp.generateSessionSummary(history);
      }
    });

    // Stop autonomous services
    try { await c.tryResolve('agentLoop')?.stop(); } catch (_e) { _log.debug('[catch] agentLoop stop:', _e.message); }

    const TO_STOP = [
      'desktopPerception', 'cognitiveMonitor', 'healthMonitor', 'needsSystem',
      'homeostasis', 'emotionalState', 'idleMind', 'daemon', 'learningService',
      'introspectionEngine', 'temporalSelf', 'phenomenalField', 'attentionalGate',
      'valueStore', 'userModel', 'bodySchema', 'consciousnessExtension',
      'homeostasisEffectors', 'metabolism', 'immuneSystem',
      'genome', 'epigeneticLayer', 'fitnessEvaluator',
      // FIX D-1: Previously missing — these services have stop() methods that
      // persist state (sync write) or clear intervals / unsubscribe events.
      'emotionalSteering', 'errorAggregator',
      'dreamCycle', 'selfNarrative', 'schemaStore', 'surpriseAccumulator',
      // v5.2.0: PromptEvolution persists promoted variants + experiment history
      'promptEvolution',
      // v5.3.0 (SA-P5): OnlineLearner — unsubscribes event listeners
      'onlineLearner',
      // v5.3.0 (SA-P7): LessonsStore — saves to global dir
      'lessonsStore',
      // v5.5.0: ReasoningTracer — unsubscribes event listeners
      'reasoningTracer',
      // FIX v5.5.0 (H-2): ChatOrchestrator — sync history persist on shutdown
      'chatOrchestrator',
      // FIX v5.5.0 (H-3): CognitiveHealthTracker — sync health state persist
      'cognitiveHealthTracker',
      // v5.2.0: HealthServer HTTP endpoint (if enabled)
      'healthServer',
      // v5.6.0 SA-P4: EmbodiedPerception — UI embodiment
      'embodiedPerception',
      // v5.7.0 SA-P3: ArchitectureReflection — no-op stop, lifecycle compliance
      'architectureReflection',
      // v5.7.0 SA-P8: DynamicToolSynthesis — persists synthesized tools
      'dynamicToolSynthesis',
      // v5.7.0: ProjectIntelligence — no-op stop, lifecycle compliance
      'projectIntelligence',
      // v5.8.0: McpServerToolBridge — unregisters bridge tools
      'mcpToolBridge',
      // v5.9.3: ServiceRecovery — unsubscribes degradation listener
      'serviceRecovery',
      // v5.9.7 (V6-11): TaskOutcomeTracker — sync persist outcomes on shutdown
      'taskOutcomeTracker',
      // v5.9.7 (V6-5): ConversationCompressor — clears cache
      'conversationCompressor',
    ];
    for (const name of TO_STOP) {
      safe(name, () => { c.tryResolve(name)?.stop(); });
    }
    // FIX v5.1.0 (C-1): Use sync write for WorldState on shutdown.
    safe('worldState', () => { c.tryResolve('worldState')?.saveSync(); });

    // Persist critical data
    let history = [];
    try {
      const orch = c.tryResolve('chatOrchestrator');
      if (orch) history = orch.getHistory() || [];
    } catch (err) {
      _log.warn('[SHUTDOWN] getHistory() failed:', err.message);
      errors.push(`chatOrchestrator.getHistory: ${err.message}`);
    }

    await safeRetry('memory', async () => {
      const mem = c.tryResolve('memory');
      if (mem) { if (history.length > 0) mem.addEpisode(history); await mem.flush(); }
    });
    await safeRetry('knowledgeGraph', async () => { await c.tryResolve('knowledgeGraph')?.flush(); });
    await safeRetry('intentRouter', async () => {
      const ir      = c.tryResolve('intentRouter');
      const storage = c.tryResolve('storage');
      if (ir && storage) {
        const learned = ir.getLearnedPatterns();
        if (Object.keys(learned).length > 0) storage.writeJSON('intent-learned.json', learned);
      }
    });

    safe('eventStore', () => {
      c.tryResolve('eventStore')?.append('SYSTEM_SHUTDOWN', { uptime: process.uptime(), shutdownErrors: errors.length }, 'AgentCore');
    });
    await safeAsync('eventStore-flush', async () => {
      const es = c.tryResolve('eventStore');
      if (es && typeof es.flushPending === 'function') await es.flushPending();
    });

    await safeAsync('workerPool', async () => { await c.tryResolve('workerPool')?.shutdown(); });
    safe('hotReloader', () => { c.tryResolve('hotReloader')?.unwatchAll(); });
    await safeAsync('network',    async () => { await c.tryResolve('network')?.shutdown(); });
    await safeAsync('mcpClient',  async () => { await c.tryResolve('mcpClient')?.shutdown(); });
    await safeAsync('selfModel',  async () => { await c.tryResolve('selfModel')?.commitSnapshot('shutdown'); });
    await safeRetry('storage',    async () => { await c.tryResolve('storage')?.flush(); });
    safe('sandbox', () => { c.tryResolve('sandbox')?.cleanup(); });

    if (errors.length > 0) {
      _log.warn(`[GENESIS] Shutdown with ${errors.length} error(s):`, errors.join('; '));
    } else {
      _log.info('[GENESIS] Clean shutdown complete.');
    }
    this._bus.fire('agent:shutdown', { errors }, { source: 'AgentCore' });
  }
}

module.exports = { AgentCoreHealth };
