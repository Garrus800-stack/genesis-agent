// @ts-checked-v5.8
// ============================================================
// GENESIS — EffectorRegistry.js (Phase 11 — Extended Agency)
//
// PROBLEM: Genesis can only act within its own project dir.
// It can't send emails, create GitHub PRs, post to Slack,
// or trigger deployments. ShellAgent's blocklist actively
// prevents this.
//
// SOLUTION: An EffectorRegistry with typed, verifiable,
// approval-gated actions for the outside world. Each
// effector has:
//   - A schema (inputs, outputs, side effects)
//   - A risk level (feeds into TrustLevelSystem)
//   - Preconditions (checked against WorldState)
//   - A rollback strategy (optional)
//   - An approval gate (based on trust level)
//
// This is the action counterpart to ToolRegistry.
// Tools retrieve information. Effectors change the world.
//
// Built-in effectors:
//   - file:write-external  — Write files outside project dir
//   - clipboard:copy       — Copy text to system clipboard
//   - notification:send    — Show OS notification
//   - browser:open         — Open URL in default browser
//
// Plugin effectors (loaded from skills/effectors/):
//   - github:create-issue
//   - github:create-pr
//   - email:send
//   - slack:post
//   - deploy:trigger
//
// Integration:
//   FormalPlanner → can plan EFFECT steps
//   AgentLoop → executes via EffectorRegistry
//   TrustLevelSystem → gates approval
//   VerificationEngine → verifies outcomes
// ============================================================

const { NullBus } = require('../core/EventBus');
const { SAFETY } = require('../core/Constants');
const { execFile } = require('child_process');
const { promisify } = require('util');
const execFileAsync = promisify(execFile);
const path = require('path');
const fs = require('fs');
const { createLogger } = require('../core/Logger');
const _log = createLogger('EffectorRegistry');

class EffectorRegistry {
  static containerConfig = {
    name: 'effectorRegistry',
    phase: 3,
    deps: ['storage', 'eventStore'],
    tags: ['capabilities', 'effectors'],
    lateBindings: [
      { prop: 'trustLevel', service: 'trustLevelSystem', optional: true },
      { prop: 'worldState', service: 'worldState', optional: true },
    ],
  };

  constructor({ bus, storage, eventStore, rootDir, config }) {
    this.bus = bus || NullBus;
    this.storage = storage || null;
    this.eventStore = eventStore || null;
    this.trustLevel = null;  // lateBinding
    this.worldState = null;  // lateBinding
    this.rootDir = rootDir;

    const cfg = config || {};
    this._dryRun = cfg.dryRun || false; // For testing

    // ── Effector Store ───────────────────────────────────
    this._effectors = new Map();

    // ── Execution Log ────────────────────────────────────
    this._executionLog = [];
    this._maxLog = 200;

    // ── Stats ────────────────────────────────────────────
    this._stats = {
      registered: 0,
      executions: 0,
      successes: 0,
      failures: 0,
      blocked: 0,
    };

    // Register built-in effectors
    this._registerBuiltins();
  }

  // ════════════════════════════════════════════════════════
  // PUBLIC API
  // ════════════════════════════════════════════════════════

  /**
   * Register an effector.
   * @param {object} effector — { name, description, risk, schema, execute, verify?, rollback? }
   */
  register(effector) {
    if (!effector.name || !effector.execute) {
      throw new Error(`[EFFECTOR] Invalid effector: missing name or execute function`);
    }

    this._effectors.set(effector.name, {
      name: effector.name,
      description: effector.description || '',
      risk: effector.risk || 'high',
      schema: effector.schema || { inputs: {}, outputs: {} },
      preconditions: effector.preconditions || (effector.precondition ? [effector.precondition] : []),
      execute: effector.execute,
      verify: effector.verify || null,
      rollback: effector.rollback || null,
      enabled: effector.enabled !== false,
    });

    this._stats.registered++;
    this.bus.emit('effector:registered', { name: effector.name, risk: effector.risk }, { source: 'EffectorRegistry' });
  }

  /**
   * Execute an effector.
   * @param {string} name — Effector name
   * @param {object} params — Input parameters
   * @param {object} context — { goalId, stepIndex, approval }
   * @returns {Promise<*>}
   */
  // @ts-ignore — TS strict
  async execute(name, params = {}, context = {}) {
    const effector = this._effectors.get(name);
    if (!effector) {
      // @ts-ignore — TS strict
      return { success: false, error: `Effector "${name}" not found`, verified: false };
    }

    if (!effector.enabled) {
      // @ts-ignore — TS strict
      return { success: false, error: `Effector "${name}" is disabled`, verified: false };
    }

    this._stats.executions++;

    // ── Trust level check ────────────────────────────────
    if (this.trustLevel && !context.approval) {
      const check = this.trustLevel.checkApproval('EXTERNAL_API', {
        description: `Execute effector: ${name}`,
        risk: effector.risk,
      });

      if (!check.approved) {
        this._stats.blocked++;
        this._log(name, params, { blocked: true, reason: check.reason });

        this.bus.emit('effector:blocked', {
          name,
          reason: check.reason,
        }, { source: 'EffectorRegistry' });

        return {
          success: false,
          error: check.reason,
          // @ts-ignore — TS strict
          needsApproval: true,
          verified: false,
        };
      }
    }

    // ── Precondition check ───────────────────────────────
    for (const precondition of effector.preconditions) {
      const met = await this._checkPrecondition(precondition);
      if (!met) {
        this._stats.failures++;

        this.bus.emit('effector:blocked', {
          name,
          reason: `Precondition not met: ${precondition.description || precondition.message || precondition}`,
        }, { source: 'EffectorRegistry' });

        return {
          success: false,
          // @ts-ignore — TS strict
          blocked: true,
          error: `Precondition not met: ${precondition.description || precondition.message || precondition}`,
          verified: false,
        };
      }
    }

    // ── Execute ──────────────────────────────────────────
    const startMs = Date.now();
    let result;

    try {
      if (this._dryRun) {
        result = { dryRun: true, effector: name, params };
      } else {
        result = await effector.execute(params, context);
      }
    } catch (err) {
      this._stats.failures++;
      this._log(name, params, { error: err.message, durationMs: Date.now() - startMs });

      this.bus.emit('effector:failed', {
        name,
        error: err.message,
      }, { source: 'EffectorRegistry' });

      // @ts-ignore — TS strict
      return { success: false, error: err.message, verified: false };
    }

    const durationMs = Date.now() - startMs;

    // ── Verify outcome ───────────────────────────────────
    let verified = false;
    if (effector.verify) {
      try {
        verified = await effector.verify(params, result);
      } catch (_e) { _log.debug("[catch] effector verify:", _e.message);
        verified = false;
      }
    } else {
      verified = true; // No verification = trust the result
    }

    this._stats.successes++;
    this._log(name, params, { result, durationMs, verified });

    this.bus.emit('effector:executed', {
      name,
      durationMs,
      verified,
      goalId: context.goalId,
    }, { source: 'EffectorRegistry' });

    // @ts-ignore — TS strict
    return { success: true, result, verified, durationMs };
  }

  /**
   * Rollback a previously executed effector (if supported).
   */
  async rollback(name, params, executionResult) {
    const effector = this._effectors.get(name);
    if (!effector?.rollback) {
      return { success: false, error: 'No rollback available' };
    }

    try {
      await effector.rollback(params, executionResult);
      return { success: true };
    } catch (err) {
      return { success: false, error: err.message };
    }
  }

  /**
   * List all registered effectors.
   */
  listEffectors() {
    return Array.from(this._effectors.values()).map(e => ({
      name: e.name,
      description: e.description,
      risk: e.risk,
      enabled: e.enabled,
      hasVerify: !!e.verify,
      hasRollback: !!e.rollback,
    }));
  }

  /**
   * Get effector schemas (for FormalPlanner integration).
   */
  getSchemas() {
    const schemas = {};
    for (const [name, e] of this._effectors) {
      schemas[name] = {
        description: e.description,
        risk: e.risk,
        inputs: e.schema.inputs,
        outputs: e.schema.outputs,
      };
    }
    return schemas;
  }

  getStats() { return { ...this._stats }; }

  // ════════════════════════════════════════════════════════
  // BUILT-IN EFFECTORS
  // ════════════════════════════════════════════════════════

  _registerBuiltins() {
    // ── Clipboard ────────────────────────────────────────
    this.register({
      name: 'clipboard:copy',
      description: 'Copy text to system clipboard',
      risk: 'safe',
      schema: { inputs: { text: 'string' }, outputs: { copied: 'boolean' } },
      execute: async (params) => {
        const { text } = params;
        if (!text) throw new Error('No text provided');

        if (process.platform === 'win32') {
          // PowerShell clip
          await execFileAsync('powershell', ['-command', `Set-Clipboard -Value "${text.replace(/"/g, '`"')}"`]);
        } else if (process.platform === 'darwin') {
          const proc = require('child_process').spawn('pbcopy');
          proc.stdin.write(text);
          proc.stdin.end();
          await new Promise((res) => proc.on('close', res));
        } else {
          // xclip or xsel on Linux
          try {
            const proc = require('child_process').spawn('xclip', ['-selection', 'clipboard']);
            proc.stdin.write(text);
            proc.stdin.end();
            await new Promise((res) => proc.on('close', res));
          } catch (_e) { _log.debug('[catch] new:', _e.message); throw new Error('xclip not available'); }
        }

        return { copied: true, length: text.length };
      },
    });

    // ── OS Notification ──────────────────────────────────
    this.register({
      name: 'notification:send',
      description: 'Show OS notification',
      risk: 'safe',
      schema: { inputs: { title: 'string', body: 'string' }, outputs: { sent: 'boolean' } },
      execute: async (params) => {
        const { title, body } = params;
        // Use Electron's notification if available, otherwise node-notifier
        try {
          const { Notification } = require('electron');
          if (Notification.isSupported()) {
            new Notification({ title, body }).show();
            return { sent: true };
          }
        } catch (_e) { _log.debug('[catch] not in Electron main process:', _e.message); }

        // Fallback: emit event for UI to handle
        this.bus.emit('notification:show', { title, body }, { source: 'EffectorRegistry' });
        return { sent: true, method: 'event' };
      },
    });

    // ── Browser Open ─────────────────────────────────────
    this.register({
      name: 'browser:open',
      description: 'Open URL in default browser',
      risk: 'medium',
      schema: { inputs: { url: 'string' }, outputs: { opened: 'boolean' } },
      execute: async (params) => {
        const { url } = params;
        // FIX v4.10.0 (M-3): Strict URL validation for openExternal.
        // Previous: only checked url.startsWith('http') — allowed any domain.
        // Now: parse URL properly, reject non-http(s) schemes, reject IPs,
        // and block known-dangerous patterns.
        if (!url) throw new Error('URL is required');
        let parsed;
        try { parsed = new URL(url); } catch { throw new Error(`Invalid URL: ${url}`); }
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
          throw new Error(`Blocked URL scheme: ${parsed.protocol} (only http/https allowed)`);
        }
        // Block raw IP addresses (common in phishing/exfiltration)
        if (/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(parsed.hostname)) {
          throw new Error(`Blocked: raw IP address URLs not allowed (${parsed.hostname})`);
        }
        // Block localhost/internal
        if (['localhost', '127.0.0.1', '0.0.0.0', '[::1]'].includes(parsed.hostname)) {
          throw new Error(`Blocked: localhost URLs not allowed`);
        }

        // FIX v5.1.0 (N-1): Domain allowlist — mirrors Kernel setWindowOpenHandler.
        // Without this check, LLM-generated effector calls could open arbitrary URLs
        // via shell.openExternal(), bypassing the Kernel's domain gate.
        if (!SAFETY.EXTERNAL_ALLOWED_DOMAINS.has(parsed.hostname)) {
          throw new Error(`Blocked: domain "${parsed.hostname}" not in allowlist`);
        }

        try {
          const { shell } = require('electron');
          await shell.openExternal(url);
        } catch (_e) {
          // Headless: fallback to child_process
          const { exec } = require('child_process');
          const cmd = process.platform === 'win32' ? `start "" "${url}"` : process.platform === 'darwin' ? `open "${url}"` : `xdg-open "${url}"`;
          exec(cmd);
        }
        return { opened: true, url };
      },
    });

    // ── File Write External ──────────────────────────────
    this.register({
      name: 'file:write-external',
      description: 'Write file outside project directory',
      risk: 'high',
      schema: {
        inputs: { filePath: 'string', content: 'string', encoding: 'string?' },
        outputs: { written: 'boolean', bytes: 'number' },
      },
      preconditions: [{ description: 'Target path must be absolute', check: (p) => path.isAbsolute(p.filePath) }],
      execute: async (params) => {
        const { filePath, content, encoding } = params;
        const dir = path.dirname(filePath);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        // FIX v4.10.0: Async atomic write
        const { atomicWriteFile } = require('../core/utils');
        await atomicWriteFile(filePath, content, encoding || 'utf-8');
        return { written: true, bytes: Buffer.byteLength(content), path: filePath };
      },
      verify: async (params) => {
        return fs.existsSync(params.filePath) && fs.statSync(params.filePath).size > 0;
      },
    });
  }

  async _checkPrecondition(precondition) {
    if (typeof precondition === 'function') return precondition();
    if (precondition.check) return precondition.check();
    return true;
  }

  _log(name, params, result) {
    this._executionLog.push({
      name,
      params: JSON.stringify(params).slice(0, 200),
      result: JSON.stringify(result).slice(0, 200),
      timestamp: Date.now(),
    });
    if (this._executionLog.length > this._maxLog) {
      this._executionLog = this._executionLog.slice(-this._maxLog);
    }
  }
}

module.exports = { EffectorRegistry };
