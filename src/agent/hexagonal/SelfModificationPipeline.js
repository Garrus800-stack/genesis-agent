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

// ── Code Safety Scanner ─────────────────────────────────────
// FIX v3.5.0: AST-based scanner replaces regex-only scanning.
// Uses acorn to parse the syntax tree, catching obfuscated patterns
// (string concatenation, variable aliasing, computed properties)
// that regex alone cannot detect. Falls back to regex if acorn
// is not installed.
// FIX v5.1.0 (DI-1): CodeSafety injected via lateBinding (/** @type {any} */ (this)._codeSafety)
// instead of direct cross-layer import from intelligence/.

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

    // v4.13.1 (Audit P1): VerificationEngine — late-bound from Container.
    this.verifier = null; // late-bound
    // v5.0.0: Genome + Metabolism — late-bound from Container.
    this._genome = null;
    this._metabolism = null;
    // v5.5.0: PreservationInvariants — late-bound from Container.
    // Semantic safety: detects modifications that weaken safety systems.
    this._preservation = null;

    // FIX v4.12.8: Self-modification circuit breaker.
    this._consecutiveFailures = 0;
    this._frozen = false;
    this._frozenReason = null;
    this._circuitBreakerThreshold = 3;
    /** @type {string|null} */ this._pendingRetry = null; // v5.9.1: Last failed operation for retry
    /** @type {string|null} */ this._pendingRetryError = null;
    /** @type {number} */ this._retryCount = 0;
  }

  /**
   * v5.0.0: Dynamic circuit breaker threshold based on Genome riskTolerance.
   * High riskTolerance (0.8) → threshold 4 (more tolerant of failures).
   * Low riskTolerance (0.2) → threshold 2 (freezes faster).
   * Default (no genome): 3.
   */
  _getCircuitBreakerThreshold() {
    if (!this._genome) return this._circuitBreakerThreshold;
    const risk = this._genome.trait('riskTolerance'); // 0–1
    return Math.max(2, Math.ceil(1 + risk * 4));      // 2–5
  }

  /**
   * v4.13.2 (Audit P1): Mandatory verification gate for all code writes.
   * Runs VerificationEngine.verify() with type 'code' on the proposed new code.
   * Returns { pass: true } or { pass: false, reason: string }.
   *
   * FAIL-CLOSED: If verifier is not bound or throws, the write is BLOCKED.
   * Previous behaviour (v4.13.1) allowed writes when the verifier was missing
   * (graceful degradation). This was a security gap — unverified self-modification
   * is worse than no self-modification. The circuit breaker already handles the
   * "self-mod unavailable" UX; this gate should never silently pass.
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
   * v5.5.0: Self-Preservation Invariants — semantic safety check.
   * Compares old vs new code to detect modifications that would
   * weaken Genesis's safety systems (rule removal, gate bypass, etc.).
   *
   * FAIL-CLOSED: If PreservationInvariants is not bound, the write proceeds
   * (preserves backward compat). If bound and check throws, the write is BLOCKED.
   *
   * @param {string} filePath — relative path
   * @param {string} oldCode — current contents
   * @param {string} newCode — proposed contents
   * @returns {{ pass: boolean, reason?: string }}
   */
  _checkPreservation(filePath, oldCode, newCode) {
    if (!this._preservation) return { pass: true }; // not bound — degrade gracefully
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

  /**
   * Check if self-modification is frozen (circuit breaker tripped).
   * @returns {{ frozen: boolean, reason: string|null, failures: number }}
   */
  getCircuitBreakerStatus() {
    return {
      frozen: this._frozen,
      reason: this._frozenReason,
      failures: this._consecutiveFailures,
      // @ts-ignore
      threshold: this._getCircuitBreakerThreshold(),
    };
  }

  /**
   * Reset the circuit breaker — called by user command or after explicit approval.
   */
  resetCircuitBreaker() {
    this._frozen = false;
    this._frozenReason = null;
    this._consecutiveFailures = 0;
    _log.info('[SELF-MOD] Circuit breaker reset — self-modification re-enabled');
    this.bus.emit('selfmod:circuit-reset', {}, { source: 'SelfModPipeline' });
  }

  /**
   * Internal: record a successful modification (resets counter).
   */
  _recordSuccess(file) {
    this._consecutiveFailures = 0;
    this.bus.emit('selfmod:success', { file }, { source: 'SelfModPipeline' });
  }

  /**
   * Internal: record a failed modification. If threshold reached, freeze.
   */
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
    if (!this._pendingRetry) return 'Nothing to retry.';
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
    const layerSummary = Object.entries(categories)
      .filter(([k]) => k !== 'root')
      .sort((a, b) => b[1] - a[1])
      .map(([k, v]) => `${k} (${v})`)
      .join(', ');

    const srcCount = Object.values(categories).reduce((s, v) => s + v, 0);

    const lines = [
      `**${this.lang.t('inspect.title')}**`, '',
      `**${this.lang.t('inspect.identity')}:** ${model.identity} v${model.version}`,
      `**Source:** ${srcCount} modules across ${Object.keys(categories).length} layers`,
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

    const sm = this.selfModel;
    const fullModel = sm.getFullModel();
    const health = this.guard.verifyIntegrity();
    const toolList = this.tools.listTools();
    const skillList = this.skills.listSkills();

    // Build a compact but informative self-context for the LLM
    const moduleSummary = sm.getModuleSummary()
      .map(m => `${m.file}: ${m.classes.join(', ')} (${m.functions} fn)${m.protected ? ' [kernel]' : ''}`)
      .join('\n');

    const capabilities = fullModel.capabilities.join(', ');
    const tools = toolList.map(t => t.name || t).join(', ');
    const skills = skillList.map(s => `${s.name}: ${s.description || 'no description'}`).join('\n') || 'none';

    // Read a few strategic files for deeper analysis
    const keyFiles = ['src/agent/AgentCore.js', 'src/agent/ChatOrchestrator.js', 'src/agent/IntentRouter.js'];
    const codeSnippets = [];
    for (const f of keyFiles) {
      const code = sm.readModule(f);
      if (code) {
        // Just the first 60 lines to give structure without token overload
        codeSnippets.push(`--- ${f} (first 60 lines) ---\n${code.split('\n').slice(0, 60).join('\n')}`);
      }
    }

    const reflectionPrompt = `You are Genesis, a self-aware AI agent (v${fullModel.version}).
You have been asked by the user to reflect on yourself — what you would improve, what's missing, or what you would change.

Your current architecture:
- ${Object.keys(fullModel.modules).length} modules, ${Object.keys(fullModel.files).length} files
- Kernel: ${health.ok ? 'intact' : 'COMPROMISED'}
- Capabilities: ${capabilities}
- Tools (${toolList.length}): ${tools}
- Skills: ${skills}
- Active model: ${this.model.activeModel || 'none'}

Module overview:
${moduleSummary}

${codeSnippets.length > 0 ? 'Key source files:\n' + codeSnippets.join('\n\n') : ''}

USER QUESTION: "${message}"

Now reflect HONESTLY and SPECIFICALLY. Do NOT just list your modules — the user already sees those.
Instead, analyze:
1. What concrete weaknesses or gaps do you see in your architecture?
2. What features are missing that would make you significantly more capable?
3. What existing modules could be improved and how?
4. What would you prioritize if you could modify yourself?

Be specific. Reference actual module names and actual limitations. Think like a senior developer doing a code review of yourself. Respond in the same language the user used.`;

    try {
      const response = await this.model.chat(reflectionPrompt, [], 'analysis');
      this.bus.emit('agent:status', { state: 'ready' }, { source: 'SelfModPipeline' });
      return response;
    } catch (err) {
      this.bus.emit('agent:status', { state: 'ready' }, { source: 'SelfModPipeline' });
      return `${this.lang.t('agent.error')}: ${err.message}`;
    }
  }

  // ── MODIFY ───────────────────────────────────────────────

  async modify(message) {
    // FIX v4.12.8: Circuit breaker — refuse if frozen
    if (this._frozen) {
      return `⛔ **Self-modification is frozen** — ${this._consecutiveFailures} consecutive failures.\n\n` +
        `Reason: ${this._frozenReason}\n\n` +
        `To resume: say "/self-repair-reset" or restart Genesis.`;
    }

    // v5.0.0: Metabolism energy gating — self-mod is expensive
    if (this._metabolism && !this._metabolism.canAfford('selfModification')) {
      const level = this._metabolism.getEnergyLevel();
      return `⚡ **Insufficient energy for self-modification** (${level.current}/${level.max} AU).\n\nSelf-modification costs 50 AU. Wait for energy to regenerate or reduce activity.`;
    }
    if (this._metabolism) this._metabolism.consume('selfModification');

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
