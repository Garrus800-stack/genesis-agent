// ============================================================
// GENESIS — src/agent/AgentCoreBootWire.js
//
// v7.9.29 (hygiene #1): the late-binding wire-and-start phase,
// extracted verbatim from AgentCoreBoot to keep that file under the
// architectural-fitness 700-LOC guard. Mixed back onto
// AgentCoreBoot.prototype (same pattern as IdleMind/GoalStack), so
// _wireAndStart stays a method on the instance and AgentCore.js's
// call (this._boot._wireAndStart(this._wire)) is unchanged. Uses only
// this.* plus fs/path; no behaviour change.
// ============================================================

const fs = require('fs');
const path = require('path');
const { createLogger } = require('./core/Logger');
const _log = createLogger('AgentCoreBoot');

const agentCoreBootWireMixin = {
  async _wireAndStart(wireDelegate) {
    const c    = this._c;
    const core = this._core;

    // Late-bindings
    const bindResult = c.wireLateBindings();
    // v7.9.5 live-fix: previously logged only the count ("1 optional skipped")
    // with no way to know which binding was missing. Now lists the names too
    // when skipped > 0, so boot-log diagnosis is immediate.
    if (bindResult.skipped > 0 && Array.isArray(bindResult.report?.optionalSkipped)) {
      const names = bindResult.report.optionalSkipped
        .map(o => `${o.consumer}.${o.prop}→${o.service}`)
        .slice(0, 8);
      const extra = bindResult.report.optionalSkipped.length > 8
        ? ` (+${bindResult.report.optionalSkipped.length - 8} more)`
        : '';
      _log.info(`  [WIRE] Late-bindings: ${bindResult.wired} wired, ${bindResult.skipped} optional skipped: ${names.join(', ')}${extra}`);
    } else {
      _log.info(`  [WIRE] Late-bindings: ${bindResult.wired} wired, ${bindResult.skipped} optional skipped`);
    }
    if (bindResult.errors.length > 0) {
      _log.warn('  [WIRE] Binding errors:', bindResult.errors);
    }

    // v7.3.7: Memory tools — mark-moment, journal-write, release-protected-memory.
    // Done here (after wireLateBindings) so all v7.3.7 services are resolved
    // and attached to their consumers. Registered conditionally: missing
    // backing services → tool simply not offered.
    try {
      const tools = c.tryResolve('tools');
      if (tools) {
        const { registerV737Tools } = require('./cognitive/tools/v737-memory-tools');
        const registered = registerV737Tools(tools, {
          pendingMomentsStore: c.tryResolve('pendingMomentsStore'),
          journalWriter:       c.tryResolve('journalWriter'),
          coreMemories:        c.tryResolve('coreMemories'),
          episodicMemory:      c.tryResolve('episodicMemory'),
          modelBridge:         c.tryResolve('model'), // v7.9.42 V2a: resonance-note needs one small model call
        });
        if (registered.length > 0) {
          _log.info(`  [WIRE] v7.3.7 memory tools: ${registered.join(', ')}`);
        }
      }
    } catch (e) {
      _log.debug('[v737-tools] registration skipped:', e.message);
    }

    // v7.2.1: Log expected-active bindings that are missing
    if (bindResult.expectedMissing && bindResult.expectedMissing.length > 0) {
      _log.warn(`  [WIRE] ⚠ ${bindResult.expectedMissing.length} expected-active binding(s) missing:`);
      for (const m of bindResult.expectedMissing) {
        const impactStr = m.impact ? ` — ${m.impact}` : '';
        _log.warn(`    ⚠ ${m.consumer}.${m.prop} → ${m.service}${impactStr}`);
      }
    }

    // v7.2.1: Emit binding report for Dashboard and self-awareness modules
    if (bindResult.report) {
      this._bus.fire('container:binding-report', bindResult.report, { source: 'AgentCoreBoot' });
    }

    const verify = c.verifyLateBindings();
    _log.info(`  [WIRE] Verification: ${verify.verified}/${verify.total} bindings OK`);
    if (verify.missing.length > 0) {
      _log.error(`  [WIRE] ⚠ ${verify.missing.length} required bindings null — agent may malfunction`);
      this._bus.fire('agent:status', {
        state: 'warning',
        detail: `${verify.missing.length} late-binding(s) failed verification`,
      }, { source: 'AgentCore' });
    }

    // Handler registrations
    const chat = c.resolve('chatOrchestrator');
    c.resolve('selfModPipeline').registerHandlers(chat);
    c.resolve('commandHandlers').registerHandlers(chat);
    // v7.9.20 (C): late-bind the skill registry onto the agent loop so an
    // autonomous, AST-cleared skill can fulfil a pursuit step (skill-step.js).
    c.resolve('agentLoop').skillManager = c.resolve('skills');
    c.resolve('agentLoop').registerHandlers(chat);

    // v5.7.0 SA-P3: Give ArchitectureReflection access to the container
    try { c.tryResolve('architectureReflection')?.setContainer(c); }
    catch (_e) { _log.debug('[catch] architectureReflection.setContainer:', _e.message); }

    // IntentRouter: agent-goal pattern
    // v7.0.3: Tightened patterns — removed ambiguous "ziel/goal" keywords that
    // caused fuzzy-match collisions with the "goals" intent (goal management).
    // agent-goal should only match explicit autonomous execution requests.
    // v7.9.22 Item 11: patterns + fuzzy keywords single-sourced so the registration test
    // cannot drift from the producer; the greedy-.* over-match is fixed in that module.
    const { AGENT_GOAL_PATTERNS, AGENT_GOAL_FUZZY } = require('./autonomy/AgentGoalPatterns');
    c.resolve('intentRouter').register('agent-goal', AGENT_GOAL_PATTERNS, 18, AGENT_GOAL_FUZZY);

    // Delegate event wiring to AgentCoreWire
    wireDelegate._wireEventHandlers();

    // Start autonomous services
    wireDelegate._startServices();

    // v7.1.9 S-1b: Auto-backup .genesis/ every 24h
    if (c.has('backupManager') && this._intervals) {
      try {
        const backupMgr = c.resolve('backupManager');
        const backupDir = require('path').join(c.resolve('storage').baseDir, 'backups');
        this._intervals.register('genesis-backup', async () => {
          try {
            const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
            const outPath = require('path').join(backupDir, `genesis-backup-${ts}.tar.gz`);
            await backupMgr.export(outPath);
            // Rotate: keep max 3 backups
            const fs = require('fs');
            if (fs.existsSync(backupDir)) {
              const files = fs.readdirSync(backupDir).filter(f => f.startsWith('genesis-backup-')).sort();
              while (files.length > 3) {
                fs.unlinkSync(require('path').join(backupDir, files.shift()));
              }
            }
          } catch (err) { _log.debug('[BACKUP] Auto-backup failed:', err.message); }
        }, 24 * 60 * 60 * 1000); // 24h
      } catch (_e) { _log.debug('[BACKUP] Auto-backup setup skipped:', _e.message); }
    }

    // Restore learned IntentRouter patterns
    try {
      const learned = c.resolve('storage').readJSON('intent-learned.json', null);
      if (learned) {
        c.resolve('intentRouter').importLearnedPatterns(learned);
        const count = Object.values(learned).reduce((s, v) => s + v.length, 0);
        if (count > 0) _log.info(`  [+] IntentRouter: restored ${count} learned keywords`);
      }
    } catch (err) { _log.debug('[GENESIS] Intent restore:', err.message); }

    // Wire UI events via AgentCoreWire
    wireDelegate._wireUIEvents();

    // GoalPersistence: resume unfinished goals
    if (c.has('goalPersistence')) {
      try {
        const resumed = await c.resolve('goalPersistence').resume();
        if (resumed.length > 0) {
          _log.info(`  [+] GoalPersistence: ${resumed.length} goal(s) resumed`);
          core._pushStatus({ state: 'ready', detail: `${resumed.length} goal(s) resumed` });
        }
      } catch (err) { _log.debug('[GENESIS] GoalPersistence resume:', err.message); }
    }

    // TrustLevelSystem: check auto-upgrades
    if (c.has('trustLevelSystem')) {
      try {
        const tls = c.resolve('trustLevelSystem');
        const upgrades = tls.checkAutoUpgrades();
        if (upgrades.length > 0) {
          _log.info(`  [+] Trust: ${upgrades.length} auto-upgrade suggestion(s)`);
        }
        _log.info(`  [+] Trust level: ${tls.getStatus().levelName}`);
      } catch (err) { _log.debug('[GENESIS] Trust check:', err.message); }
    }

    // WebPerception: log capabilities
    if (c.has('webPerception')) {
      try {
        _log.info(`  [+] WebPerception: ${c.resolve('webPerception').getCapabilities().mode}`);
      } catch (_e) { _log.debug('[catch] optional:', _e.message); }
    }

    // GitHubEffector: register if token available
    if (c.has('effectorRegistry')) {
      try {
        const er       = c.resolve('effectorRegistry');
        const { GitHubEffector } = require('./capabilities/GitHubEffector');
        const ghConfig = c.has('settings') ? (c.resolve('settings').get('github') || {}) : {};
        const gh       = new GitHubEffector({ bus: this._bus, storage: c.resolve('storage'), config: ghConfig });
        if (gh.token) {
          gh.registerWith(er);
          _log.info(`  [+] GitHubEffector: registered (${ghConfig.owner || 'no default owner'})`);
        }
      } catch (err) { _log.debug('[GENESIS] GitHubEffector:', err.message); }
    }

    // SelfSpawner: log status
    if (c.has('selfSpawner')) {
      _log.info(`  [+] SelfSpawner: ready (max ${c.resolve('selfSpawner')._maxWorkers} workers)`);
    }

    // Periodic health intervals
    const { INTERVALS } = require('./core/Constants');
    core.intervals.register('health-full', () => core._health._periodicHealthCheck(), INTERVALS.HEALTH_FULL);
    core.intervals.register('health-push', () => core._health._pushHealthTick(),      INTERVALS.HEALTH_PUSH);

    // v7.2.3: GenesisBackup boot-if-stale trigger.
    // Async, non-blocking — we don't want to delay boot for a 24h stale check.
    // If a backup is already running (from another trigger), this call returns fast.
    if (c.has('genesisBackup')) {
      setImmediate(async () => {
        try {
          const gb = c.resolve('genesisBackup');
          await gb.backupIfStale('boot-if-stale');
        } catch (err) {
          _log.debug('[BACKUP] boot-if-stale error:', err.message);
        }
      });
    }

    // Boot event
    c.resolve('eventStore').append('SYSTEM_BOOT', {
      duration: Date.now() - core._bootStart,
      services: Object.keys(c.getDependencyGraph()).length,
    }, 'AgentCore');
  }
};

module.exports = { agentCoreBootWireMixin };
