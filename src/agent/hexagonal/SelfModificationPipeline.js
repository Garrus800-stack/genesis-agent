// @ts-checked-v5.7
// ============================================================
// GENESIS — SelfModificationPipeline.js
// Handles all self-* operations. The ONLY module that
// modifies Genesis's own code.
//
// Pipeline: PLAN -> TEST -> SNAPSHOT -> APPLY -> VERIFY -> RELOAD
// ============================================================

const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const { NullBus } = require('../core/EventBus');
const { createLogger } = require('../core/Logger');
const { THRESHOLDS } = require('../core/Constants');
const _log = createLogger('SelfModificationPipeline');

// ── Atomic Write Helper ──────────────────────────────────────
// FIX v4.10.0: Writes to a temp file in the same directory, then
// renames atomically. Prevents half-written files on crash.
// rename() is atomic on POSIX and near-atomic on NTFS.
function _atomicWriteFileSync(filePath, content, encoding = 'utf-8') {
  const dir = path.dirname(filePath);
  const tmpName = `.genesis-tmp-${crypto.randomBytes(6).toString('hex')}`;
  const tmpPath = path.join(dir, tmpName);
  try {
    fs.writeFileSync(tmpPath, content, encoding);
    fs.renameSync(tmpPath, filePath);
  } catch (err) {
    // Clean up temp file on failure
    try { fs.unlinkSync(tmpPath); } catch { /* best effort */ }
    throw err;
  }
}

// v5.1.0: CodeSafety injected via lateBinding (_codeSafety), not direct import.

class SelfModificationPipeline {
  constructor({ lang, bus,  selfModel, model, prompts, sandbox, reflector, skills, cloner,
                reasoning, hotReloader, guard, tools, eventStore, rootDir, astDiff}) {
    this.lang = lang || { t: (k) => k, detect: () => {}, current: 'en' };
    this.bus = bus || NullBus;
    this.selfModel = selfModel;
    this.model = model;
    this.prompts = prompts;
    this.sandbox = sandbox;
    this.reflector = reflector;
    this.skills = skills;
    this.cloner = cloner;
    this.reasoning = reasoning;
    this.hotReloader = hotReloader;
    this.guard = guard;
    this.tools = tools;
    this.eventStore = eventStore;
    this.rootDir = rootDir;
    this.astDiff = astDiff;

    // ── Late-bound services ───────────────────────────────
    this.verifier = null;          // VerificationEngine
    this._genome = null;           // Genome (v5.0.0)
    this._metabolism = null;       // Metabolism (v5.0.0)
    this._awareness = null;        // AwarenessPort (v7.6.0)
    this._preservation = null;     // PreservationInvariants (v5.5.0)

    // ── Circuit breaker (v4.12.8) ─────────────────────────
    this._consecutiveFailures = 0;
    this._frozen = false;
    this._frozenReason = null;
    this._circuitBreakerThreshold = 3;
    this._pendingRetry = null;      // v5.9.1: last failed op for retry
    this._pendingRetryError = null;
    this._retryCount = 0;

    // ── Gate statistics (v6.1.0) ──────────────────────────
    this._gateStats = { totalAttempts: 0, consciousnessBlocked: 0, energyBlocked: 0, circuitBreakerBlocked: 0, passed: 0, lastBlockedAt: null, lastCoherence: null };
  }

  /** Dynamic circuit breaker threshold based on Genome riskTolerance (2–5, default 3). */
  _getCircuitBreakerThreshold() {
    if (!this._genome) return this._circuitBreakerThreshold;
    const risk = this._genome.trait('riskTolerance'); // 0–1
    return Math.max(2, Math.ceil(1 + risk * 4));      // 2–5
  }

  /**
   * Mandatory verification gate for all code writes. FAIL-CLOSED:
   * if verifier is not bound or throws, the write is BLOCKED.
   */
  _verifyCode(filePath, newCode) {
    if (!this.verifier) {
      _log.error('[SELF-MOD] VerificationEngine not bound — blocking write. Bind via lateBindings for self-modification to work.');
      return { pass: false, reason: 'VerificationEngine not available — self-modification blocked until verifier is bound' };
    }
    try {
      const result = this.verifier.verify({
        type: 'code',
        file: filePath,
        output: newCode,
        context: { rootDir: this.rootDir },
      });
      if (result.status === 'fail') {
        return { pass: false, reason: result.issues?.map(i => i.message || i).join('; ') || 'Verification failed' };
      }
      return { pass: true, status: result.status };
    } catch (err) {
      _log.error('[SELF-MOD] VerificationEngine threw during verify:', err.message);
      return { pass: false, reason: `VerificationEngine error: ${err.message}` };
    }
  }

  /**
   * Self-Preservation Invariants check. FAIL-CLOSED in all cases:
   * - Not bound → block (late-binding may have silently failed)
   * - Throws → block
   * - Violations found → block
   */
  _checkPreservation(filePath, oldCode, newCode) {
    // v7.2.1 (Adversarial Audit): Changed from fail-open to fail-closed.
    // Previously returned { pass: true } when _preservation was null, meaning
    // a silent late-binding failure would bypass ALL preservation checks.
    if (!this._preservation) {
      _log.error('[SELF-MOD] PreservationInvariants not bound — blocking write (fail-closed)');
      return { pass: false, reason: 'PreservationInvariants not available — self-modification blocked until preservation service is bound' };
    }
    try {
      const result = this._preservation.check(filePath, oldCode, newCode);
      if (!result.safe) {
        const summary = result.violations.map(v => `${v.invariant}: ${v.detail}`).join('; ');
        return { pass: false, reason: summary };
      }
      return { pass: true };
    } catch (err) {
      _log.error('[SELF-MOD] PreservationInvariants threw:', err.message);
      return { pass: false, reason: `PreservationInvariants error: ${err.message}` };
    }
  }

  /** Check if self-modification is frozen (circuit breaker tripped). */
  getCircuitBreakerStatus() {
    return {
      frozen: this._frozen,
      reason: this._frozenReason,
      failures: this._consecutiveFailures,
      threshold: (/** @type {any} */ (this))._getCircuitBreakerThreshold(),
    };
  }

  /** Gate statistics — aggregated view of all self-modification gates. */
  getGateStats() {
    const { totalAttempts, consciousnessBlocked, passed } = this._gateStats;
    // Awareness is "active" when a real implementation is wired up.
    // NullAwareness.getReport() returns { active: false } by contract.
    const awarenessActive = this._awareness
      ? (this._awareness.getReport?.()?.active ?? false)
      : false;
    return {
      ...this._gateStats,
      blockRate: totalAttempts > 0
        ? Math.round((1 - passed / totalAttempts) * 10000) / 100
        : 0,
      consciousnessBlockRate: totalAttempts > 0
        ? Math.round((consciousnessBlocked / totalAttempts) * 10000) / 100
        : 0,
      awarenessActive,
    };
  }

  /** Reset the circuit breaker — called by user command or after explicit approval. */
  resetCircuitBreaker() {
    this._frozen = false;
    this._frozenReason = null;
    this._consecutiveFailures = 0;
    _log.info('[SELF-MOD] Circuit breaker reset — self-modification re-enabled');
    this.bus.emit('selfmod:circuit-reset', {}, { source: 'SelfModPipeline' });
  }

  /** Record successful modification (resets counter). */
  _recordSuccess(file) {
    this._consecutiveFailures = 0;
    this.bus.emit('selfmod:success', { file }, { source: 'SelfModPipeline' });
  }

  /** Record failed modification. If threshold reached, freeze. */
  _recordFailure(reason) {
    this._consecutiveFailures++;
    const threshold = this._getCircuitBreakerThreshold();
    _log.warn(`[SELF-MOD] Failure #${this._consecutiveFailures}/${threshold}: ${reason}`);
    this.bus.emit('selfmod:failure', {
      count: this._consecutiveFailures,
      reason,
    }, { source: 'SelfModPipeline' });

    if (this._consecutiveFailures >= threshold) {
      this._frozen = true;
      this._frozenReason = `${this._consecutiveFailures} consecutive failures — last: ${reason}`;
      _log.error(`[SELF-MOD] ⛔ Circuit breaker TRIPPED — self-modification frozen`);
      _log.error(`[SELF-MOD]   Reason: ${this._frozenReason}`);
      _log.error(`[SELF-MOD]   To resume: user must run /self-repair-reset or approve in UI`);
      this.bus.emit('selfmod:frozen', {
        reason: this._frozenReason,
        failures: this._consecutiveFailures,
      }, { source: 'SelfModPipeline' });
    }
  }

  /**
   * Register all self-* handlers with a ChatOrchestrator
   */
  registerHandlers(orchestrator) {
    orchestrator.registerHandler('self-inspect', (msg) => this.inspect());
    orchestrator.registerHandler('self-reflect', (msg) => this.reflect(msg));
    orchestrator.registerHandler('self-modify', (msg) => this.modify(msg));
    orchestrator.registerHandler('self-repair', () => this.repair());
    orchestrator.registerHandler('self-repair-reset', () => this.handleCircuitReset());
    orchestrator.registerHandler('create-skill', (msg) => this.createSkill(msg));
    orchestrator.registerHandler('clone', (msg, ctx) => this.clone(msg, ctx.history));
    orchestrator.registerHandler('greeting', (msg) => this._greeting(msg));
    // v5.9.1: Retry last failed operation
    orchestrator.registerHandler('retry', () => this._retry());
  }

  /** @private */
  async _retry() {
    if (!this._pendingRetry) return null; // v7.1.9: fall through to general chat
    if (this._retryCount >= 3) {
      this._pendingRetry = null;
      this._retryCount = 0;
      return '❌ Max retries (3) reached. Try a simpler description or different approach.';
    }
    this._retryCount++;
    const msg = this._pendingRetryError
      ? `${this._pendingRetry}. IMPORTANT: Previous attempt failed with: ${this._pendingRetryError}. Generate simpler code, avoid async/await, avoid process.exit, avoid file system operations in test().`
      : this._pendingRetry;
    return this.createSkill(msg);
  }

  // ── INSPECT ──────────────────────────────────────────────
  inspect() {
    const sm = this.selfModel;
    const model = sm.getFullModel();
    const health = this.guard.verifyIntegrity();
    const modules = sm.getModuleSummary();

    // Categorize modules by their src/agent/<layer>/ directory
    const categories = {};
    let testCount = 0, scriptCount = 0;
    for (const m of modules) {
      const parts = m.file.replace(/\\/g, '/').split('/');
      // Detect src/agent/<layer>/ pattern
      if (parts[0] === 'src' && parts[1] === 'agent' && parts.length >= 4) {
        const layer = parts[2]; // e.g. 'cognitive', 'autonomy', 'core'
        categories[layer] = (categories[layer] || 0) + 1;
      } else if (parts[0] === 'test') {
        testCount++;
      } else if (parts[0] === 'scripts') {
        scriptCount++;
      } else {
        categories['root'] = (categories['root'] || 0) + 1;
      }
    }

    // Build concise summary — only src/agent layers, sorted by count
    const layers = Object.entries(categories).filter(([k]) => k !== 'root');
    const layerSummary = layers
      .sort((a, b) => b[1] - a[1])
      .map(([k, v]) => `${k} (${v})`)
      .join(', ');

    const srcCount = Object.values(categories).reduce((s, v) => s + v, 0);

    const lines = [
      `**${this.lang.t('inspect.title')}**`, '',
      `**${this.lang.t('inspect.identity')}:** ${model.identity} v${model.version}`,
      `**Source:** ${srcCount} modules across ${layers.length} layers`,
      `**${this.lang.t('inspect.kernel')}:** ${health.ok ? this.lang.t('inspect.kernel_intact') : this.lang.t('inspect.kernel_compromised')}`,
      `**${this.lang.t('inspect.capabilities')}:** ${model.capabilities.join(', ')}`,
      `**${this.lang.t('inspect.skills')}:** ${this.skills.listSkills().map(s => s.name).join(', ') || this.lang.t('inspect.none')}`,
      `**${this.lang.t('inspect.tools')}:** ${this.tools.listTools().length} ${this.lang.t('inspect.tools_registered')}`,
      `**${this.lang.t('inspect.model')}:** ${this.model.activeModel || this.lang.t('health.none')}`,
      '',
      `**Layers:** ${layerSummary}`,
      testCount > 0 ? `**Tests:** ${testCount} suites` : '',
    ].filter(Boolean);
    return lines.join('\n');
  }

  // ── REFLECT (self-analysis with genuine LLM reasoning) ──
  async reflect(message) {
    this.bus.emit('agent:status', { state: 'thinking', detail: 'Self-reflection...' }, { source: 'SelfModPipeline' });

    // v7.2.0: Data-driven reflection from self-identity, KG, and Journal
    // instead of dumping the full module tree into the prompt.
    const parts = [];

    // From self-identity.json (what Genesis thinks about itself)
    try {
      const self = this._storage?.readJSON('self-identity.json', null);
      if (self?.text) parts.push(self.text);
    } catch (_e) { /* no self-identity yet */ }

    // From IdleMind (what Genesis did between conversations)
    try {
      const idle = this._idleMind?.getStatus();
      if (idle?.thoughtCount > 0) {
        parts.push(`Seit dem letzten Gespräch: ${idle.thoughtCount} Gedanken, ${idle.journalEntries || 0} Journal-Einträge.`);
      }
      const journal = this._idleMind?.readJournal?.(3) || [];
      if (journal.length > 0) {
        parts.push('Letzte Gedanken: ' + journal.map(j => j.thought || '').filter(Boolean).join('; '));
      }
    } catch (_e) { /* no idleMind */ }

    // Compact architecture facts (not a module dump)
    const version = this.selfModel?.manifest?.version || 'unknown';
    const moduleCount = this.selfModel?.moduleCount() || 0;
    const capabilities = (this.selfModel?.getCapabilities() || []).join(', ');
    parts.push(`Version: ${version}, ${moduleCount} Module, Model: ${this.model?.activeModel || 'unknown'}`);
    parts.push(`Capabilities: ${capabilities}`);

    const context = parts.join('\n\n');
    const prompt = `Du bist Genesis. Ein User hat dich gefragt: "${message}"

Hier ist dein aktueller Kontext — antworte daraus, erfinde nichts:

${context}

Antworte ehrlich und spezifisch in der Sprache des Users. Keine Modullisten.`;

    try {
      const response = await this.model.chat(prompt, [], 'analysis');
      this.bus.emit('agent:status', { state: 'ready' }, { source: 'SelfModPipeline' });
      return response;
    } catch (err) {
      this.bus.emit('agent:status', { state: 'ready' }, { source: 'SelfModPipeline' });
      return `${this.lang.t('agent.error')}: ${err.message}`;
    }
  }

  // ── MODIFY ───────────────────────────────────────────────
  async modify(message) {
    this._gateStats.totalAttempts++;

    // FIX v4.12.8: Circuit breaker — refuse if frozen
    if (this._frozen) {
      this._gateStats.circuitBreakerBlocked++;
      return `⛔ **Self-modification is frozen** — ${this._consecutiveFailures} consecutive failures.\n\n` +
        `Reason: ${this._frozenReason}\n\n` +
        `To resume: say "/self-repair-reset" or restart Genesis.`;
    }

    // v7.6.0: Awareness gate — don't modify self when fragmented
    if (this._awareness) {
      try {
        const coherence = this._awareness.getCoherence();
        if (typeof coherence === 'number' && coherence < THRESHOLDS.SELFMOD_COHERENCE_MIN) {
          this._gateStats.consciousnessBlocked++;
          this._gateStats.lastBlockedAt = /** @type {*} */ (Date.now());
          this._gateStats.lastCoherence = /** @type {*} */ (coherence);
          _log.warn(`[SELFMOD] Blocked: awareness coherence too low (${coherence.toFixed(2)})`);
          this.bus.emit('selfmod:consciousness-blocked', {
            coherence: Math.round(coherence * 100) / 100,
          }, { source: 'SelfModPipeline' });
          return `⚠ **Self-modification deferred** — internal coherence is low (${(coherence * 100).toFixed(0)}%).\n\nGenesis is in a fragmented state. Self-modification is safer when coherence recovers above ${Math.round(THRESHOLDS.SELFMOD_COHERENCE_MIN * 100)}%. Try again shortly.`;
        }
      } catch (_e) { /* awareness optional — never block on error */ }
    }

    // v5.0.0: Metabolism energy gating — self-mod is expensive
    if (this._metabolism && !this._metabolism.canAfford('selfModification')) {
      this._gateStats.energyBlocked++;
      const level = this._metabolism.getEnergyLevel();
      return `⚡ **Insufficient energy for self-modification** (${level.current}/${level.max} AU).\n\nSelf-modification costs 50 AU. Wait for energy to regenerate or reduce activity.`;
    }
    if (this._metabolism) this._metabolism.consume('selfModification');

    this._gateStats.passed++;
    this.bus.emit('agent:status', { state: 'self-modifying' }, { source: 'SelfModPipeline' });

    // Detect target file from message
    const fileMatch = message.match(/(?:in|bei|datei)\s+(\S+\.js)/i);
    const targetFile = fileMatch?.[1] || null;

    // Strategy 1: Try ASTDiff for precise changes (less tokens, fewer errors)
    if (this.astDiff && targetFile) {
      const result = await this._modifyWithDiff(message, targetFile);
      if (result) return result;
    }

    // Strategy 2: Fall back to full-file patch generation
    return this._modifyFullFile(message);
  }

  async _modifyWithDiff(message, targetFile) {
    const code = this.selfModel.readModule(targetFile);
    if (!code) return null;

    try {
      // Ask LLM for structured diff operations
      const diffPrompt = this.astDiff.buildDiffPrompt(targetFile, code, message);
      const response = await this.model.chat(diffPrompt, [], 'code');
      const diffs = this.astDiff.parseDiffs(response);

      if (diffs.length === 0) return null; // LLM didn't produce diffs, fall back

      // Apply diffs to code
      const { code: newCode, applied, errors } = this.astDiff.apply(code, diffs);

      if (applied === 0) return null; // Nothing changed, fall back

      // Test the modified code
      const test = await this.sandbox.testPatch(targetFile, newCode);
      if (!test.success) {
        this._recordFailure(`AST test failed: ${targetFile}`);
        this.bus.emit('agent:status', { state: 'ready' }, { source: 'SelfModPipeline' });
        return `ASTDiff test failed: ${test.error}\n\nChanges:\n${this.astDiff.describe(diffs)}`;
      }

      // FIX v3.5.0: Safety scan — reject dangerous patterns before writing
      const safety = /** @type {any} */ (this)._codeSafety.scanCode(newCode, targetFile);
      if (!safety.safe) {
        this.bus.emit('agent:status', { state: 'ready' }, { source: 'SelfModPipeline' });
        this.eventStore?.append('CODE_SAFETY_BLOCK', {
          file: targetFile, method: 'ast-diff',
          blocked: safety.blocked.map(b => b.description),
        }, 'SelfModPipeline');
        this.bus.emit('code:safety-blocked', { file: targetFile, issues: safety.blocked }, { source: 'SelfModPipeline' });
        this._recordFailure(`Safety block: ${targetFile}`);
        return `⛔ **Code Safety Block** — ${targetFile}\n\n${safety.blocked.map(b => `- **${b.description}** (${b.count}x)`).join('\n')}\n\nThe generated code contains patterns that could compromise system integrity. Modification rejected.`;
      }
      if (safety.warnings.length > 0) {
        _log.warn(`[SELF-MOD] Safety warnings for ${targetFile}:`, safety.warnings.map(w => w.description).join(', '));
        this.eventStore?.append('CODE_SAFETY_WARN', {
          file: targetFile, method: 'ast-diff', warnings: safety.warnings.map(w => w.description),
        }, 'SelfModPipeline');
      }

      // Apply — FIX v4.10.0: Atomic write (temp + rename)
      // v4.13.1 (Audit P1): Formal verification before disk write
      const verification = this._verifyCode(targetFile, newCode);
      if (!verification.pass) {
        this._recordFailure(`Verification failed: ${targetFile}: ${verification.reason}`);
        this.bus.emit('agent:status', { state: 'ready' }, { source: 'SelfModPipeline' });
        this.eventStore?.append('CODE_VERIFICATION_BLOCK', {
          file: targetFile, method: 'ast-diff', reason: verification.reason,
        }, 'SelfModPipeline');
        return `⛔ **Verification Failed** — ${targetFile}\n\n${verification.reason}\n\nCode changes rejected by VerificationEngine.`;
      }
      // v5.5.0: Self-Preservation Invariants — block changes that weaken safety
      const preservation = this._checkPreservation(targetFile, code, newCode);
      if (!preservation.pass) {
        this._recordFailure(`Preservation violation: ${targetFile}: ${preservation.reason}`);
        this.bus.emit('agent:status', { state: 'ready' }, { source: 'SelfModPipeline' });
        this.eventStore?.append('PRESERVATION_BLOCK', {
          file: targetFile, method: 'ast-diff', reason: preservation.reason,
        }, 'SelfModPipeline');
        return `⛔ **Self-Preservation Block** — ${targetFile}\n\n${preservation.reason}\n\nThis modification would weaken Genesis's safety systems. Rejected.`;
      }
      await this.selfModel.commitSnapshot('pre-diff: ' + message.slice(0, 40));
      const fullPath = path.join(this.rootDir, targetFile);
      this.guard.validateWrite(fullPath);
      _atomicWriteFileSync(fullPath, newCode, 'utf-8');
      await this.selfModel.commitSnapshot('post-diff: ' + message.slice(0, 40));
      await this.selfModel.scan();
      await this.hotReloader.reload(targetFile);

      this.eventStore?.append('CODE_MODIFIED', {
        file: targetFile, method: 'ast-diff', operations: diffs.length, success: true,
      }, 'SelfModPipeline');
      this._recordSuccess(targetFile);
      this.bus.emit('agent:status', { state: 'ready' }, { source: 'SelfModPipeline' });

      return `${this.lang.t('selfmod.astdiff_applied')}\n\n${this.astDiff.describe(diffs)}${errors.length > 0 ? '\n\n' + this.lang.t('selfmod.warnings') + ': ' + errors.join(', ') : ''}`;
    } catch (err) {
      _log.warn('[SELF-MOD] ASTDiff failed, falling back:', err.message);
      return null; // Fall back to full-file
    }
  }

  async _modifyFullFile(message) {
    // Original approach: generate full file via reasoning engine
    const result = await this.reasoning.solve(message, {
      history: [], memory: null, selfModel: this.selfModel,
    });

    const patches = this._extractPatches(result.answer);
    if (patches.length === 0) {
      this.bus.emit('agent:status', { state: 'ready' }, { source: 'SelfModPipeline' });
      return result.answer;
    }

    // Test each patch
    const tests = [];
    for (const p of patches) {
      tests.push({ file: p.file, ...(await this.sandbox.testPatch(p.file, p.code)) });
    }

    if (!tests.every(t => t.success)) {
      this._recordFailure(`Tests failed: ${tests.filter(t => !t.success).map(t => t.file).join(', ')}`);
      this.bus.emit('agent:status', { state: 'ready' }, { source: 'SelfModPipeline' });
      this.eventStore?.append('CODE_MODIFIED', { files: patches.map(p => p.file), success: false }, 'SelfModPipeline');
      return `${this.lang.t('selfmod.tests_failed')}\n${tests.filter(t => !t.success).map(t => `- ${t.file}: ${t.error}`).join('\n')}`;
    }

    // FIX v3.5.0: Safety scan all patches before writing any of them
    const allBlocked = [];
    const allWarnings = [];
    for (const p of patches) {
      const safety = /** @type {any} */ (this)._codeSafety.scanCode(p.code, p.file);
      if (!safety.safe) allBlocked.push(...safety.blocked);
      allWarnings.push(...safety.warnings);
    }
    if (allBlocked.length > 0) {
      this.bus.emit('agent:status', { state: 'ready' }, { source: 'SelfModPipeline' });
      this.eventStore?.append('CODE_SAFETY_BLOCK', {
        files: patches.map(p => p.file), method: 'full-file',
        blocked: allBlocked.map(b => b.description),
      }, 'SelfModPipeline');
      this.bus.emit('code:safety-blocked', { files: patches.map(p => p.file), issues: allBlocked }, { source: 'SelfModPipeline' });
      this._recordFailure(`Safety block: ${patches.map(p => p.file).join(', ')}`);
      return `⛔ **Code Safety Block**\n\n${allBlocked.map(b => `- **${b.description}** in \`${b.file}\` (${b.count}x)`).join('\n')}\n\nModification rejected.`;
    }
    if (allWarnings.length > 0) {
      _log.warn('[SELF-MOD] Safety warnings:', allWarnings.map(w => `${w.file}: ${w.description}`).join(', '));
      this.eventStore?.append('CODE_SAFETY_WARN', {
        files: patches.map(p => p.file), method: 'full-file',
        warnings: allWarnings.map(w => w.description),
      }, 'SelfModPipeline');
    }

    // v4.13.1 (Audit P1): Formal verification for all patches before writing
    const verifyFailed = [];
    for (const p of patches) {
      const v = this._verifyCode(p.file, p.code);
      if (!v.pass) verifyFailed.push({ file: p.file, reason: v.reason });
    }
    if (verifyFailed.length > 0) {
      this._recordFailure(`Verification failed: ${verifyFailed.map(f => f.file).join(', ')}`);
      this.bus.emit('agent:status', { state: 'ready' }, { source: 'SelfModPipeline' });
      this.eventStore?.append('CODE_VERIFICATION_BLOCK', {
        files: verifyFailed.map(f => f.file), method: 'full-file',
        reasons: verifyFailed.map(f => f.reason),
      }, 'SelfModPipeline');
      return `⛔ **Verification Failed**\n\n${verifyFailed.map(f => `- \`${f.file}\`: ${f.reason}`).join('\n')}\n\nCode changes rejected by VerificationEngine.`;
    }

    // v5.5.0: Self-Preservation Invariants — block changes that weaken safety
    const preservationFailed = [];
    for (const p of patches) {
      const oldCode = this.selfModel.readModule(p.file) || '';
      const pres = this._checkPreservation(p.file, oldCode, p.code);
      if (!pres.pass) preservationFailed.push({ file: p.file, reason: pres.reason });
    }
    if (preservationFailed.length > 0) {
      this._recordFailure(`Preservation violation: ${preservationFailed.map(f => f.file).join(', ')}`);
      this.bus.emit('agent:status', { state: 'ready' }, { source: 'SelfModPipeline' });
      this.eventStore?.append('PRESERVATION_BLOCK', {
        files: preservationFailed.map(f => f.file), method: 'full-file',
        reasons: preservationFailed.map(f => f.reason),
      }, 'SelfModPipeline');
      return `⛔ **Self-Preservation Block**\n\n${preservationFailed.map(f => `- \`${f.file}\`: ${f.reason}`).join('\n')}\n\nThese modifications would weaken Genesis's safety systems. Rejected.`;
    }

    // Snapshot + Apply — FIX v4.10.0: Atomic writes (temp + rename)
    // Validate ALL paths before writing ANY file to fail fast.
    await this.selfModel.commitSnapshot('pre: ' + message.slice(0, 40));
    for (const p of patches) {
      this.guard.validateWrite(path.join(this.rootDir, p.file));
    }
    for (const p of patches) {
      _atomicWriteFileSync(path.join(this.rootDir, p.file), p.code, 'utf-8');
    }
    await this.selfModel.commitSnapshot('post: ' + message.slice(0, 40));
    await this.selfModel.scan();
    for (const p of patches) await this.hotReloader.reload(p.file);

    this.eventStore?.append('CODE_MODIFIED', {
      files: patches.map(p => p.file), method: 'full-file', success: true,
    }, 'SelfModPipeline');
    this._recordSuccess(patches.map(p => p.file).join(', '));
    this.bus.emit('agent:status', { state: 'ready' }, { source: 'SelfModPipeline' });

    return `${this.lang.t('selfmod.applied')}\n\n${result.answer}\n\n**${this.lang.t('selfmod.files')}:** ${patches.map(p => p.file).join(', ')}`;
  }

  // ── REPAIR ───────────────────────────────────────────────

  async repair() {
    // FIX v4.12.8: Check circuit breaker before self-repair too
    if (this._frozen) {
      return `⛔ **Self-modification is frozen** — ${this._consecutiveFailures} consecutive failures.\n\n` +
        `Say "/self-repair-reset" to unfreeze.`;
    }

    this.bus.emit('agent:status', { state: 'self-repairing' }, { source: 'SelfModPipeline' });

    const diag = await this.reflector.diagnose();
    if (diag.issues.length === 0) {
      this.bus.emit('agent:status', { state: 'ready' }, { source: 'SelfModPipeline' });
      return this.lang.t('selfmod.all_intact');
    }

    const repairs = await this.reflector.repair(diag.issues);
    await this.selfModel.scan();

    this.bus.emit('agent:status', { state: 'ready' }, { source: 'SelfModPipeline' });
    return `${this.lang.t('selfmod.repair')}:\n${repairs.map(r => `**${r.file}:** ${r.fixed ? '✅' : '⏳'} -- ${r.detail}`).join('\n')}`;
  }

  // ── CIRCUIT BREAKER RESET ───────────────────────────────
  handleCircuitReset() {
    if (!this._frozen) {
      return `Self-modification is not frozen. Circuit breaker status: ${this._consecutiveFailures}/${this._circuitBreakerThreshold} failures.`;
    }
    this.resetCircuitBreaker();
    return `✅ **Circuit breaker reset.** Self-modification re-enabled.\n\n` +
      `Previous state: ${this._frozenReason || 'unknown'}\n` +
      `Failures cleared. Next failure will start counting from 0.`;
  }

  // ── CREATE SKILL ─────────────────────────────────────────
  async createSkill(message) {
    this.bus.emit('agent:status', { state: 'creating-skill' }, { source: 'SelfModPipeline' });

    const result = await this.skills.createSkill(message);

    // v5.9.1: Store message for retry if skill creation failed
    if (result.includes('⚠️') || result.includes('❌') || result.includes('failed') || result.includes('blocked')) {
      this._pendingRetry = message;
      // Extract error for LLM hint on retry
      const errMatch = result.match(/\*\*Error:\*\*\s*(.+)/);
      this._pendingRetryError = errMatch ? errMatch[1].slice(0, 200) : null;
    } else {
      this._pendingRetry = null;
      this._pendingRetryError = null;
      this._retryCount = 0;
    }

    // Re-register new skills as tools
    if (result.includes('✅') || result.toLowerCase().includes('installed') || result.toLowerCase().includes('created') || result.toLowerCase().includes('erstellt')) {
      for (const sk of this.skills.listSkills()) {
        if (!this.tools.hasTool(`skill:${sk.name}`)) {
          this.tools.register(`skill:${sk.name}`, {
            description: sk.description,
            input: sk.interface?.input || {},
            output: sk.interface?.output || {},
          }, (input) => this.skills.executeSkill(sk.name, input), 'skill');
        }
      }
      this.eventStore?.append('SKILL_CREATED', { name: result.match(/"([^"]+)"/)?.[1] || 'unknown' }, 'SelfModPipeline');
    }

    this.bus.emit('agent:status', { state: 'ready' }, { source: 'SelfModPipeline' });
    return result;
  }

  // ── CLONE ────────────────────────────────────────────────
  async clone(message, history) {
    this.bus.emit('agent:status', { state: 'cloning' }, { source: 'SelfModPipeline' });
    const result = await this.cloner.createClone({ improvements: message, conversation: history || [] });
    this.bus.emit('agent:status', { state: 'ready' }, { source: 'SelfModPipeline' });
    return result;
  }

  // ── GREETING ─────────────────────────────────────────────
  async _greeting(message) {
    // v5.1.0: Use LLM for natural greeting instead of static string.
    // Minimal system prompt — no consciousness/organism/knowledge overhead.
    try {
      const lang = this.lang.get?.() || 'en';
      const systemPrompt = lang === 'de'
        ? 'Du bist Genesis. Antworte kurz und freundlich auf die Begrüßung. Kein Smalltalk, keine Aufzählung deiner Fähigkeiten.'
        : 'You are Genesis. Reply briefly and warmly to the greeting. No small talk, no listing capabilities.';
      const response = await this.model.chat(systemPrompt, [{ role: 'user', content: message }], 'chat');
      return response;
    } catch (err) {
      _log.debug('[GREETING] LLM fallback:', err.message);
      return this.lang.t('selfmod.greeting');
    }
  }

  // ── Helpers ──────────────────────────────────────────────
  _extractPatches(response) {
    const patches = [];
    const rx = /(?:\/\/\s*FILE:\s*(\S+)|---\s*(\S+\.js)\s*---)\n```(?:\w+)?\n([\s\S]+?)```/g;
    let m;
    while ((m = rx.exec(response))) patches.push({ file: m[1] || m[2], code: m[3].trim() });
    return patches;
  }
}

module.exports = { SelfModificationPipeline };
