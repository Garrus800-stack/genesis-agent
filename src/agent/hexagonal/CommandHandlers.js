// @ts-checked-v5.7
// ============================================================
// GENESIS — CommandHandlers.js
// Lightweight handlers for operational intents.
// Each method handles one intent type.
// Registers all handlers with a ChatOrchestrator in one call.
//
// v7.4.2 "Kassensturz": Split from 846 LOC monolith into 6 domain
// mixins via Prototype-Delegation. Same pattern as DreamCyclePhases,
// ChatOrchestratorSourceRead, SelfModel 4-way split.
//
// Domain split:
//   CommandHandlers.js           — core: constructor, registerHandlers, undo
//   CommandHandlersCode.js       — executeCode, executeFile, analyzeCode, runSkill
//   CommandHandlersShell.js      — shellTask, shellRun, projectScan, openPath
//   CommandHandlersGoals.js      — plans, goals, journal
//   CommandHandlersMemory.js     — memoryMark, memoryList, memoryVeto
//   CommandHandlersSystem.js     — handleSettings, daemonControl, trustControl
//   CommandHandlersNetwork.js    — peer, mcpControl, webLookup
//
// External API unchanged. Prototype-Delegation keeps all instance
// method access lexically identical.
// ============================================================

'use strict';

const { TIMEOUTS } = require('../core/Constants');

const { commandHandlersCode }    = require('./CommandHandlersCode');
const { commandHandlersShell }   = require('./CommandHandlersShell');
const { commandHandlersGoals }   = require('./CommandHandlersGoals');
const { commandHandlersMemory }  = require('./CommandHandlersMemory');
const { commandHandlersSystem }  = require('./CommandHandlersSystem');
const { commandHandlersNetwork } = require('./CommandHandlersNetwork');

class CommandHandlers {
  constructor({ bus, lang, sandbox, fileProcessor, network, daemon, idleMind, analyzer, goalStack, settings, webFetcher, shellAgent, mcpClient, coreMemories}) {
    this.bus = bus || null;
    this.lang = lang || { t: (k) => k, detect: () => {}, current: 'en' };
    this.sandbox = sandbox;
    this.fp = fileProcessor;
    this.network = network;
    this.daemon = daemon;
    this.idleMind = idleMind;
    this.analyzer = analyzer;
    this.goalStack = goalStack;
    this.settings = settings;
    this.web = webFetcher;
    this.shell = shellAgent;
    this.mcp = mcpClient;
    this.coreMemories = coreMemories || null; // v7.3.2
    /** @type {*} */ this.skillManager = null; // late-bound v5.9.1
  }

  /** Register all handlers with the orchestrator */
  registerHandlers(orchestrator) {
    orchestrator.registerHandler('execute-code', (msg) => this.executeCode(msg));
    orchestrator.registerHandler('execute-file', (msg) => this.executeFile(msg));
    orchestrator.registerHandler('analyze-code', (msg) => this.analyzeCode(msg));
    orchestrator.registerHandler('peer', (msg) => this.peer(msg));
    orchestrator.registerHandler('daemon', (msg) => this.daemonControl(msg));
    orchestrator.registerHandler('journal', () => this.journal());
    orchestrator.registerHandler('plans', () => this.plans());
    orchestrator.registerHandler('goals', (msg) => this.goals(msg));
    orchestrator.registerHandler('settings', (msg) => this.handleSettings(msg));
    orchestrator.registerHandler('web-lookup', (msg) => this.webLookup(msg));
    orchestrator.registerHandler('undo', () => this.undo());
    orchestrator.registerHandler('shell-task', (msg) => this.shellTask(msg));
    orchestrator.registerHandler('shell-run', (msg) => this.shellRun(msg));
    orchestrator.registerHandler('project-scan', (msg) => this.projectScan(msg));
    orchestrator.registerHandler('mcp', (msg) => this.mcpControl(msg));
    // v5.9.1: Run installed skill
    orchestrator.registerHandler('run-skill', (msg) => this.runSkill(msg));
    // v6.0.2: Trust level control via chat
    orchestrator.registerHandler('trust-control', (msg) => this.trustControl(msg));
    // v6.0.2: Open folder/file in OS file explorer
    orchestrator.registerHandler('open-path', (msg) => this.openPath(msg));
    // v7.3.2: Core Memory controls
    orchestrator.registerHandler('memory-mark', (msg) => this.memoryMark(msg));
    orchestrator.registerHandler('memory-list', (msg) => this.memoryList(msg));
    orchestrator.registerHandler('memory-veto', (msg) => this.memoryVeto(msg));
  }

  // ── Undo (Git Revert) ──────────────────────────────────
  //
  // Kept in the core because it's a shared operation with no clean
  // domain home (touches git via execFile, not any specific this.*
  // dependency).

  async undo() {
    try {
      // FIX v4.0.1: async execFile — no longer blocks the main thread.
      const { execFile } = require('child_process');
      const { promisify } = require('util');
      const execFileAsync = promisify(execFile);
      const cwd = this.fp?.rootDir || process.cwd();
      const opts = { cwd, encoding: 'utf-8', timeout: TIMEOUTS.GIT_OP, windowsHide: true };

      const { stdout: log } = await execFileAsync('git', ['log', '--oneline', '-5'], opts);
      if (!log.trim()) return this.lang.t('agent.undo_failed', { error: 'No git repository' });

      const lines = log.trim().split('\n');
      const lastCommit = lines[0];

      if (lines.length <= 1) return this.lang.t('agent.undo_only_one');

      await execFileAsync('git', ['revert', '--no-edit', 'HEAD'], { ...opts, timeout: TIMEOUTS.COMMAND_EXEC });

      return `**${this.lang.t('agent.undo_done', { commit: lastCommit })}**\n\n\`\`\`\n${lines.slice(0, 4).join('\n')}\n\`\`\``;
    } catch (err) {
      const msg = err.stderr || err.message || '';
      if (msg.includes('nothing to commit') || msg.includes('MERGE_HEAD')) {
        return this.lang.t('agent.undo_conflict');
      }
      return `**${this.lang.t('agent.undo_failed', { error: msg })}**`;
    }
  }
}

// ── Prototype-Delegation: wire up all 6 domain mixins ──────────
//
// Order matters only if mixins share method names (they don't).
// All 20 extracted methods become reachable on CommandHandlers
// instances via this.method() exactly as before the v7.4.2 split.

Object.assign(
  CommandHandlers.prototype,
  commandHandlersCode,
  commandHandlersShell,
  commandHandlersGoals,
  commandHandlersMemory,
  commandHandlersSystem,
  commandHandlersNetwork
);

module.exports = { CommandHandlers };
