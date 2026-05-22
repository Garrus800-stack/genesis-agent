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
//   CommandHandlersSelf.js       — selfRecall (v7.5.5+)
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
const { commandHandlersSelf }    = require('./CommandHandlersSelf');
const { commandHandlersInstall } = require('./CommandHandlersInstall');
const { commandHandlersArchitecture } = require('./CommandHandlersArchitecture');
const { commandHandlersSlashHint } = require('./CommandHandlersSlashHint');
const { commandHandlersOpen } = require('./CommandHandlersOpen');
const { commandHandlersCleanup } = require('./CommandHandlersCleanup');   // v7.8.4

class CommandHandlers {
  constructor({ bus, lang, sandbox, fileProcessor, network, daemon, idleMind, analyzer, goalStack, settings, webFetcher, shellAgent, mcpClient, coreMemories, genesisDir, skillEffectivenessTracker}) {
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
    // v7.9.0 Phase 2: needed by /skills-pending slash.
    this._genesisDir = genesisDir || null;
    this.skillEffectivenessTracker = skillEffectivenessTracker || null;
    /** @type {*} */ this.skillManager = null; // late-bound v5.9.1
    /** @type {*} */ this.selfStatementLog = null; // late-bound v7.5.5
    /** @type {*} */ this.modelBridge = null; // late-bound v7.5.6 — for /model-reset
    /** @type {*} */ this.proactiveSelfExpression = null; // late-bound v7.7.9 Phase 2 — for /quiet, /proactive-status
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
    orchestrator.registerHandler('affect-trail', (msg) => this.affectTrail(msg));   // v7.8.9
    orchestrator.registerHandler('skills-pending', (msg) => this.skillsPending(msg)); // v7.9.0
    orchestrator.registerHandler('skill-info', (msg) => this.skillInfo(msg));    // v7.9.4
    orchestrator.registerHandler('skill-discard', (msg) => this.skillDiscard(msg)); // v7.9.4
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
    // v7.5.5: Self-Domain
    orchestrator.registerHandler('self-recall', (msg) => this.selfRecall(msg));
    // v7.8.4: Pre-deletion audit
    orchestrator.registerHandler('cleanup-check', (msg) => this.cleanupCheck(msg));
    // v7.5.6: Model availability marker reset
    orchestrator.registerHandler('model-reset', (msg) => this.modelReset(msg));
    // v7.7.9 Phase 2: ProactiveSelfExpression user controls.
    orchestrator.registerHandler('quiet',           (msg) => this.quietControl(msg));
    orchestrator.registerHandler('proactive-status', () => this.proactiveStatus());
    // v7.5.9 ZIP3 Phase 4a: Software-installation handler
    orchestrator.registerHandler('install-software', (msg) => this.installSoftware(msg));
    // v7.5.9 ZIP4 Phase 8: Architecture-diagram (deterministic mermaid)
    orchestrator.registerHandler('architecture-diagram', (msg) => this.architectureDiagram(msg));
    // v7.5.9 ZIP8: open installed application + pronoun resolution.
    orchestrator.registerHandler('open-software', (msg) => this.openSoftware(msg));
    // v7.5.9 ZIP7: Slash-Discipline-Hint — when a user types a free-text
    // form of a security-relevant intent (e.g. "installiere winrar"), the
    // slash-discipline guard rewrites the intent to `slash-hint` instead
    // of silently falling through to the LLM (which previously
    // confabulated refusals like "I cannot install software"). This
    // handler renders the correct slash command suggestion for the user.
    //
    // @virtual-handler — `slash-hint` is synthesized by ChatOrchestrator
    // (when intent._wasSlashOnlyRewrite is true), not produced by
    // IntentRouter classification. It is intentionally absent from
    // INTENT_DEFINITIONS. Audit §3.3 (v7.6.0) introduced this anchor
    // so validate-intent-wiring.js can recognize the convention without
    // an ad-hoc allowlist. Future synthesized handlers should use the
    // same anchor on their registerHandler call.
    orchestrator.registerHandler('slash-hint', (msg, ctx) => this.slashHint(msg, ctx));
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

  // ── /model-reset (v7.5.6) ─────────────────────────────────
  //
  // Clear unavailable-markers set by ModelBridge.markUnavailable when a
  // model failed with auth/rate-limit/timeout. Without this command,
  // markers expire only via TTL (1h auth / 5min rate-limit / 10min
  // timeout). When the user knows the underlying issue is resolved
  // (subscription renewed, rate-limit window passed) they can clear
  // markers immediately.

  async modelReset(msg) {
    const m = String(msg || '').match(/\/model-reset(?:\s+(\S+))?/i);
    const modelName = m?.[1];
    if (!this.modelBridge?.clearUnavailable) {
      return 'ModelBridge does not support unavailable-markers in this build.';
    }
    this.modelBridge.clearUnavailable(modelName);
    return modelName
      ? `Unavailable-marker cleared for ${modelName}.`
      : 'All unavailable-markers cleared.';
  }

  // v7.7.9 Phase 2: ProactiveSelfExpression user controls.
  //
  // /quiet [duration]
  //   off / 0 / unmute   → clear mute
  //   today              → quiet until end of local day
  //   30m / 2h / 90s     → relative duration
  //   (empty)            → 60 minutes default
  //
  // Hard mute. No soft-decay. No adaptive learning from this signal.
  // The user controls when Genesis can speak proactively; PSE never
  // re-derives this from user reactions.
  async quietControl(msg) {
    if (!this.proactiveSelfExpression || typeof this.proactiveSelfExpression.setMute !== 'function') {
      return 'Proactive self-expression service is not available in this build.';
    }
    const m = String(msg || '').match(/\/(?:quiet|silence)(?:\s+(.+))?/i);
    const arg = (m?.[1] || '').trim();
    return this.proactiveSelfExpression.setMute(arg);
  }

  // /proactive-status — debug output for Garrus. Surfaces the
  // suppression log so attempted-but-blocked candidates are visible.
  async proactiveStatus() {
    if (!this.proactiveSelfExpression || typeof this.proactiveSelfExpression.getStatus !== 'function') {
      return 'Proactive self-expression service is not available in this build.';
    }
    return this.proactiveSelfExpression.getStatus();
  }
}

// ── Prototype-Delegation: wire up all 7 domain mixins ──────────
//
// Order matters only if mixins share method names (they don't).
// All extracted methods become reachable on CommandHandlers
// instances via this.method() exactly as before the v7.4.2 split.

Object.assign(
  CommandHandlers.prototype,
  commandHandlersCode,
  commandHandlersShell,
  commandHandlersGoals,
  commandHandlersMemory,
  commandHandlersSystem,
  commandHandlersNetwork,
  commandHandlersSelf,        // v7.5.5
  commandHandlersInstall,     // v7.5.9 ZIP3 Phase 4a
  commandHandlersArchitecture, // v7.5.9 ZIP4 Phase 8
  commandHandlersSlashHint,   // v7.5.9 ZIP7
  commandHandlersOpen,        // v7.5.9 ZIP8
  commandHandlersCleanup      // v7.8.4
);

module.exports = { CommandHandlers };
