// @ts-checked-v5.7
// ============================================================
// GENESIS — AgentCoreBoot.js (v5.0.0)
//
// Boot-phase delegate for AgentCore. Handles the four internal
// boot sub-phases so AgentCore.js stays a clean orchestrator.
//
// Follows the same delegate pattern as AgentLoop:
//   AgentLoop       → AgentLoopSteps / AgentLoopPlanner / etc.
//   AgentCore       → AgentCoreBoot / AgentCoreWire / AgentCoreHealth
//
// Receives `core` (AgentCore instance) — all properties accessed
// via reference. No ownership transfer, no circular requires.
//
// Responsibilities:
//   Phase 0: _bootstrapInstances()  — non-manifest singletons
//   Phase M: _registerFromManifest() — 131 DI services
//   Phase 3: _resolveAndInit()      — topological resolve + bootAll
//   Phase 4: _wireAndStart()        — late-bindings + handler reg
// ============================================================

'use strict';

const path = require('path');
const fs   = require('fs');

const { lang }          = require('./core/Language');
const { StorageService }= require('./foundation/StorageService');
const { Logger, createLogger } = require('./core/Logger');
const { buildManifest } = require('./ContainerManifest');
const { ModuleRegistry }= require('./revolution/ModuleRegistry');
const { ToolBootstrap } = require('./capabilities/ToolBootstrap');
const { safeJsonParse } = require('./core/utils');

const _log = createLogger('AgentCoreBoot');

class AgentCoreBoot {
  /** @param {import('./AgentCore').AgentCore} core */
  constructor(core) {
    this._core = core;
  }

  // ── Convenience getters ────────────────────────────────
  get _c()         { return this._core.container; }
  get _bus()       { return this._core._bus; }
  get _intervals() { return this._core.intervals; }

  // ════════════════════════════════════════════════════════
  // PHASE 0: Bootstrap non-manifest instances
  // ════════════════════════════════════════════════════════

  _bootstrapInstances() {
    const core = this._core;
    const c    = this._c;

    c.registerInstance('rootDir', core.rootDir);
    c.registerInstance('guard',   core.guard);
    c.registerInstance('bus',     this._bus);

    // v7.0.1: Typed Event Facades — reduce direct EventBus coupling
    const { OrganismEvents }  = require('./organism/OrganismEvents');
    const { CognitiveEvents } = require('./cognitive/CognitiveEvents');
    const { AutonomyEvents }  = require('./autonomy/AutonomyEvents');
    c.registerInstance('organismEvents',  new OrganismEvents(this._bus));
    c.registerInstance('cognitiveEvents', new CognitiveEvents(this._bus));
    c.registerInstance('autonomyEvents',  new AutonomyEvents(this._bus));

    c.registerInstance('storage', new StorageService(core.genesisDir));

    // Language
    lang.init(core.genesisDir);
    c.registerInstance('lang', lang);

    // Logger — read log level from settings.json without resolving Settings service
    // @ts-ignore — settingsPath may be null, acceptable
    const settingsPath = path.join(core.genesisDir, 'settings.json');
    let logLevel = 'info';
    try {
      if (fs.existsSync(settingsPath)) {
        const raw = safeJsonParse(fs.readFileSync(settingsPath, 'utf-8'), {}, 'AgentCoreBoot');
        logLevel = raw?.logging?.level || 'info';
      }
    } catch (_e) { /* use default */ }
    Logger.setLevel(logLevel);
    c.registerInstance('logger', Logger);

    // v6.0.1: CrashLog — rotating error/warn file sink
    try {
      const { CrashLog } = require('./core/CrashLog');
      const crashLog = new CrashLog(core.genesisDir);
      crashLog.start();
      Logger.setSink((entry) => crashLog.capture(entry));
      c.registerInstance('crashLog', crashLog);
    } catch (_e) { /* CrashLog is best-effort */ }

    // Event payload validation (dev-mode)
    try {
      const { installPayloadValidation } = require('./core/EventPayloadSchemas');
      // @ts-ignore — dynamic property + EventBus type mismatch
      core._payloadValidation = installPayloadValidation(this._bus);
    } catch (_e) { _log.warn('[catch] payload validation init:', _e.message); }

    _log.info('  [0] Bootstrap: rootDir, guard, bus, storage, lang, logger');
  }

  // ════════════════════════════════════════════════════════
  // PHASE M: Register all services from manifest
  // ════════════════════════════════════════════════════════

  _registerFromManifest() {
    const core = this._core;
    const manifest = buildManifest({
      rootDir:      core.rootDir,
      genesisDir:   core.genesisDir,
      guard:        core.guard,
      bus:          this._bus,
      intervals:    this._intervals,
      bootProfile:  core.bootProfile,
      skipPhases:   core.skipPhases,
    });

    let count = 0;
    for (const [name, config] of manifest) {
      const {
        factory, deps = [], tags = [], lateBindings = [],
        optional = false, singleton, phase = 0,
      } = config;
      this._c.register(name, factory, {
        deps, tags, lateBindings,
        singleton: singleton !== false,
        phase,
      });
      count++;
    }

    // ModuleRegistry is meta — not in manifest itself
    const registry = new ModuleRegistry(this._c, this._bus);
    this._c.registerInstance('moduleRegistry', registry);

    _log.info(`  [M] Manifest: ${count} services registered`);
  }

  // ════════════════════════════════════════════════════════
  // PHASE 3: Resolve services in phase order + asyncLoad
  // ════════════════════════════════════════════════════════

  async _resolveAndInit() {
    const c    = this._c;
    const core = this._core;

    // ── Pre-bootAll: eager resolution ───────────────────
    // SelfModel must scan before anything else reads module info
    const selfModel = c.resolve('selfModel');
    await selfModel.scan();

    // Eagerly resolve stateful foundation services
    for (const name of [
      'settings', 'model', 'prompts', 'sandbox', 'memory',
      'eventStore', 'knowledgeGraph', 'worldState',
    ]) {
      c.resolve(name);
    }
    _log.info(`  [1] Foundation resolved: ${selfModel.moduleCount()} modules`);

    // Intelligence
    const model = c.resolve('model');
    c.resolve('intentRouter').setModel(model);
    _log.info('  [2] Intelligence resolved');

    // Capabilities: tool bootstrap needs multiple services
    for (const name of ['skills', 'shellAgent']) { c.resolve(name); }
    const tools = c.resolve('tools');
    tools.registerBuiltins({
      sandbox:   c.resolve('sandbox'),
      selfModel,
      skills:    c.resolve('skills'),
      memory:    c.resolve('memory'),
      reflector: c.resolve('reflector'),
    });
    tools.registerSystemTools(core.rootDir, core.guard);
    _log.info('  [3] Capabilities resolved');

    // ── Essential services — fail-fast ───────────────────
    const ESSENTIAL = new Set([
      'chatOrchestrator', 'selfModPipeline', 'commandHandlers', 'agentLoop',
      'goalStack', 'unifiedMemory', 'episodicMemory', 'learningService',
    ]);
    for (const name of ESSENTIAL) {
      if (c.has(name)) c.resolve(name);
    }

    // ── Non-essential services — graceful degradation ────
    const NON_ESSENTIAL = [
      'embeddingService', 'network',
      'anticipator', 'solutionAccumulator', 'selfOptimizer', 'metaLearning',
      'daemon', 'idleMind', 'healthMonitor', 'cognitiveMonitor',
      'emotionalState', 'homeostasis', 'needsSystem',
      'nativeToolUse', 'vectorMemory', 'sessionPersistence', 'multiFileRefactor',
      'htnPlanner', 'taskDelegation', 'formalPlanner', 'modelRouter',
      'failureAnalyzer', 'cognitiveHealthTracker',
      'goalPersistence', 'failureTaxonomy', 'dynamicContextBudget',
      'emotionalSteering', 'localClassifier',
      'trustLevelSystem', 'effectorRegistry', 'webPerception',
      'graphReasoner',
    ];

    const degraded = [];
    for (const name of NON_ESSENTIAL) {
      if (!c.has(name)) continue;
      try {
        c.resolve(name);
      } catch (err) {
        degraded.push(name);
        _log.warn(`  [BOOT] Non-essential "${name}" degraded: ${err.message}`);
      }
    }

    ToolBootstrap.register(c);

    // ── bootAll: asyncLoad → boot on each resolved service ──
    const bootResults = await c.bootAll();
    const bootErrors  = bootResults.filter(r => r.status === 'error');
    if (bootErrors.length > 0) {
      _log.warn(`  [BOOT] ${bootErrors.length} service(s) failed asyncLoad/boot:`,
        bootErrors.map(e => `${e.name}: ${e.error}`).join('; '));
    }

    if (degraded.length > 0) {
      _log.warn(`  [BOOT] ${degraded.length} non-essential service(s) degraded: ${degraded.join(', ')}`);
      this._bus.emit('boot:degraded', { services: degraded, count: degraded.length }, { source: 'AgentCore' });
    }

    // Post-bootAll capability log
    const skills = c.resolve('skills');
    const mcp    = c.has('mcpClient') ? c.resolve('mcpClient') : null;
    _log.info(`  [+] Skills: ${skills.listSkills().length}, Tools: ${tools.listTools().length}`);
    if (mcp) {
      try {
        const s = mcp.getStatus();
        _log.info(`  [+] MCP: ${s.connectedCount}/${s.serverCount} servers, ${s.totalTools} tools`);
      } catch (_e) { _log.warn('[catch] MCP status:', _e.message); }
    }
    _log.info(`  [+] Model: ${model.activeModel || 'none'}`);

    // v5.1.0: Reconfigure ContextManager now that asyncLoad has detected the actual model.
    // Phase 2 configured with activeModel=null (8192 default). Now we know the real model.
    if (model.activeModel && c.has('contextManager')) {
      c.resolve('contextManager').configureForModel(model.activeModel);
    }

    _log.info('  [4-8] All phases resolved');
  }

  // ════════════════════════════════════════════════════════
  // PHASE 4: Wire late-bindings + start services
  // ════════════════════════════════════════════════════════

  async _wireAndStart(wireDelegate) {
    const c    = this._c;
    const core = this._core;

    // Late-bindings
    const bindResult = c.wireLateBindings();
    _log.info(`  [WIRE] Late-bindings: ${bindResult.wired} wired, ${bindResult.skipped} optional skipped`);
    if (bindResult.errors.length > 0) {
      _log.warn('  [WIRE] Binding errors:', bindResult.errors);
    }

    const verify = c.verifyLateBindings();
    _log.info(`  [WIRE] Verification: ${verify.verified}/${verify.total} bindings OK`);
    if (verify.missing.length > 0) {
      _log.error(`  [WIRE] ⚠ ${verify.missing.length} required bindings null — agent may malfunction`);
      this._bus.emit('agent:status', {
        state: 'warning',
        detail: `${verify.missing.length} late-binding(s) failed verification`,
      }, { source: 'AgentCore' });
    }

    // Handler registrations
    const chat = c.resolve('chatOrchestrator');
    c.resolve('selfModPipeline').registerHandlers(chat);
    c.resolve('commandHandlers').registerHandlers(chat);
    c.resolve('agentLoop').registerHandlers(chat);

    // v5.7.0 SA-P3: Give ArchitectureReflection access to the container
    try { c.tryResolve('architectureReflection')?.setContainer(c); }
    catch (_e) { _log.debug('[catch] architectureReflection.setContainer:', _e.message); }

    // IntentRouter: agent-goal pattern
    c.resolve('intentRouter').register('agent-goal', [
      /(?:mach|bau|erstell|implementier|refaktor|schreib).*(?:fuer mich|komplett|fertig|ganz|vollstaendig)/i,
      /(?:kuemmer|sorg).*(?:dich|du).*(?:um|darum)/i,
      /(?:erledige?|ausfuehr|fuehr).*(?:das|diese?n?|alles|aufgabe|task)/i,
      /(?:arbeit|work).*(?:autonom|selbststaendig|eigenstaendig|allein)/i,
      /(?:build|create|implement|refactor|write).*(?:for me|complete|entire|whole)/i,
      /(?:take care|handle|manage|do).*(?:for me|it all|everything|autonomously)/i,
      /(?:work|operate|execute).*(?:autonom|independent|on your own)/i,
      /(?:dein|your).*(?:ziel|goal|aufgabe|task|mission).*(?:ist|is|:)/i,
      /(?:ich will|i want|i need).*(?:dass du|you to).*(?:komplett|complete|entire|fully)/i,
    ], 18, [
      'autonom', 'autonomous', 'eigenstaendig', 'independent',
      'erledigen', 'handle', 'komplett', 'complete', 'aufgabe',
      'task', 'mission', 'ziel', 'goal', 'implementieren', 'implement',
      'bauen', 'build', 'erstellen', 'create', 'alleine', 'alone',
    ]);

    // Delegate event wiring to AgentCoreWire
    wireDelegate._wireEventHandlers();

    // Start autonomous services
    wireDelegate._startServices();

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

    // Boot event
    c.resolve('eventStore').append('SYSTEM_BOOT', {
      duration: Date.now() - core._bootStart,
      services: Object.keys(c.getDependencyGraph()).length,
    }, 'AgentCore');
  }
}

module.exports = { AgentCoreBoot };
