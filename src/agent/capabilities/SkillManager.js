// @ts-checked-v5.6
// ============================================================
// GENESIS AGENT — SkillManager.js
// Creates, loads, tests, and manages modular skills.
// Each skill is an isolated module with a standard interface.
// ============================================================

const fs = require('fs');
const path = require('path');
const { safeJsonParse, atomicWriteFileSync } = require('../core/utils');
const { createLogger } = require('../core/Logger');
const { isCloudSyncPath } = require('../foundation/CloudSyncSafety');
const { mixin: koennenIntakeMixin } = require('./SkillManagerKoennenIntake');
const _log = createLogger('SkillManager');

class SkillManager {
  constructor(skillsDir, sandbox, model, prompts, guard, opts = {}) {
    this.skillsDir = skillsDir;
    this.sandbox = sandbox;
    this.model = model;
    this.prompts = prompts;
    this.guard = guard || null;
    this.loadedSkills = new Map();
    /** @type {any} late-bound via DI (CodeSafetyPort) */
    this._codeSafety = null;
    // v7.9.4: bus reference so forge events fire properly (was a latent
    // no-op before — this.bus?.fire?.() was always undefined).
    this.bus = opts.bus || null;
    // v7.9.4: secondary skill source — .genesis/koennen/skills-pending/.
    // Skills with status === 'promoted' there are loaded into loadedSkills
    // alongside the built-in skills from skillsDir. Pending and quarantined
    // and discarded ones stay in the directory but are not loaded; they
    // are only accessible via executeSkillByManifest for rehearsal.
    this.koennenDir = opts.koennenDir || null;
    // v7.9.4: late-bound via DI (SkillEffectivenessTracker).
    // When set, executeSkill records every invocation outcome.
    this.effectivenessTracker = null;

    if (!fs.existsSync(skillsDir)) {
      fs.mkdirSync(skillsDir, { recursive: true });
    }
    if (this.koennenDir && !fs.existsSync(this.koennenDir)) {
      try { fs.mkdirSync(this.koennenDir, { recursive: true }); }
      catch (_e) { /* best effort */ }
    }
  }

  /** Load all installed skills from disk. v7.9.4: dual-source loading. */
  loadSkills() {
    this.loadedSkills.clear();

    // Source 1: built-in skills under skillsDir (typically src/skills/).
    if (fs.existsSync(this.skillsDir)) {
      // v7.8.3: warn (but proceed) if skills live under a cloud-sync root.
      // Reading manifest/entry files may hang on first touch as the OS
      // pulls Files-On-Demand placeholders. The warning gives the user
      // a chance to move Genesis before they hit a slow boot.
      if (isCloudSyncPath(this.skillsDir)) {
        _log.warn(`[SKILLS] skillsDir is under a cloud-sync root (${this.skillsDir}) — skill loads may hang on Files-On-Demand placeholders`);
      }
      this._loadFromDir(this.skillsDir, null, true);
    }

    // Source 2 (v7.9.4): promoted Können skills under koennenDir.
    // Filter: only manifests with status === 'promoted' get loaded.
    // Pending/rehearsing/quarantined/discarded ones stay on disk but
    // are not in loadedSkills.
    if (this.koennenDir && fs.existsSync(this.koennenDir)) {
      this._loadFromDir(this.koennenDir, (manifest) => manifest.status === 'promoted', false);
    }

    _log.info(`[SKILLS] Loaded ${this.loadedSkills.size} skills`);
  }

  /**
   * v7.9.4: Internal loader for one skill source directory.
   *
   * @param {string} dir - Directory to scan for skill subdirectories
   * @param {Function|null} filter - Optional manifest filter; receives
   *   parsed manifest object, returns true to include, false to skip
   * @param {boolean} [trusted=false] - true only for first-party built-in
   *   skills shipped under skillsDir. A trusted skill whose manifest declares
   *   "sandbox": false runs natively (in-process); generated/Können skills are
   *   NEVER trusted, so their manifest can't opt them out of the VM sandbox.
   * @private
   */
  _loadFromDir(dir, filter, trusted = false) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;

      const manifestPath = path.join(dir, entry.name, 'skill-manifest.json');
      if (!fs.existsSync(manifestPath)) continue;

      try {
        const manifest = safeJsonParse(fs.readFileSync(manifestPath, 'utf-8'), null, 'SkillManager');
        if (!manifest) { _log.warn('[SKILLS] Invalid manifest:', manifestPath); continue; }
        if (filter && !filter(manifest)) continue;
        this.loadedSkills.set(manifest.name, {
          ...manifest,
          dir: path.join(dir, entry.name),
          loaded: true,
          _trusted: trusted === true,
        });
      } catch (err) {
        _log.warn(`[SKILLS] Failed to load skill ${entry.name}: ${err.message}`);
      }
    }
  }

  /** List all skills */
  listSkills() {
    return Array.from(this.loadedSkills.values()).map(s => ({
      name: s.name,
      version: s.version,
      description: s.description,
      interface: s.interface,
      autonomous: s.autonomous === true,   // v7.9.20 (C): skill-step opt-in
    }));
  }

  /**
   * Execute a skill by name. v7.9.4 changes:
   *   - third argument opts={source} for invocation source tagging
   *   - invocations of Können skills (manifest.koennen present) record
   *     outcome to effectivenessTracker if late-bound
   *   - sandbox-success semantic: success = !result.error
   *
   * Existing callers (ToolRegistry, CommandHandlersCode, PluginRegistry,
   * SelfModificationPipeline) pass two arguments and get production
   * source tagging by default.
   */
  async executeSkill(name, input, opts = {}) {
    const skill = this.loadedSkills.get(name);
    if (!skill) throw new Error(`Skill not found: ${name}`);

    const entryPath = path.join(skill.dir, skill.entry);
    if (!fs.existsSync(entryPath)) {
      throw new Error(`Skill entry point not found: ${entryPath}`);
    }

    const code = fs.readFileSync(entryPath, 'utf-8');
    const execCode = this._buildExecCode(code, input);

    const startedAt = Date.now();
    let result;
    let success = false;

    try {
      if (skill._trusted === true && skill.sandbox === false) {
        // Trusted first-party skill that opts out of sandboxing (e.g. git-status,
        // system-info) — run it in-process. The VM sandbox blocks the
        // child_process/fs these skills legitimately need, which previously made
        // them fail with "child process not allowed" and dead-ended the agent
        // loop. Only src/skills/ built-ins are _trusted, so a generated skill
        // cannot escape the sandbox by declaring "sandbox": false.
        result = await this._runSkillNative(entryPath, input);
      } else {
        result = await this.sandbox.execute(execCode, {
          allowRequire: true,
          // FIX v6.1.1: Skills need read access to project files (fs path restrictions still enforced)
          env: { GENESIS_SANDBOX_ALLOW_READ_ROOT: this.sandbox?.rootDir || process.cwd() },
        });
      }
      // v7.9.4: sandbox.execute returns { output, error, duration, ... }.
      // success = no execution error.
      success = !result.error;
    } catch (err) {
      // Re-throw — callers (ToolRegistry, CommandHandlersCode) expect
      // throws on infrastructure failure. But record the failure first.
      if (this.effectivenessTracker && skill.koennen) {
        try {
          this.effectivenessTracker.recordInvocation(name, false, {
            latencyMs: Date.now() - startedAt,
            source: opts.source || 'production',
          });
        } catch (_e) { /* tracker errors must not mask original */ }
      }
      throw err;
    }

    // v7.9.4: record Können skill invocations to effectiveness tracker.
    // Only Können skills (with manifest.koennen) are tracked — built-in
    // skills (code-stats, etc.) are not in the Wilson-LB system.
    if (this.effectivenessTracker && skill.koennen) {
      try {
        this.effectivenessTracker.recordInvocation(name, success, {
          latencyMs: Date.now() - startedAt,
          source: opts.source || 'production',
        });
      } catch (e) {
        _log.debug(`[SKILLS] tracker recordInvocation failed: ${e.message}`);
      }
    }

    return result;
  }

  /**
   * v7.9.4: Backdoor execution for pending skills not in loadedSkills.
   * Used by SkillRehearsal to execute pending/rehearsing skills directly
   * from their manifest directory without needing them in the loadedSkills
   * map.
   *
   * @param {string} name - skill name (for tracker tagging)
   * @param {string} manifestDir - directory containing skill-manifest.json + entry file
   * @param {object} input - input object to pass to the skill
   * @param {object} opts - { source: 'rehearsal' | 'production' }
   * @returns {Promise<{output: any, error: string|null, duration: number}>}
   */
  async executeSkillByManifest(name, manifestDir, input, opts = {}) {
    const manifestPath = path.join(manifestDir, 'skill-manifest.json');
    if (!fs.existsSync(manifestPath)) {
      throw new Error(`Skill manifest not found: ${manifestPath}`);
    }

    const manifest = safeJsonParse(fs.readFileSync(manifestPath, 'utf-8'), null, 'SkillManager');
    if (!manifest) throw new Error(`Skill manifest invalid: ${manifestPath}`);

    const entryPath = path.join(manifestDir, manifest.entry || 'index.js');
    if (!fs.existsSync(entryPath)) {
      throw new Error(`Skill entry point not found: ${entryPath}`);
    }

    const code = fs.readFileSync(entryPath, 'utf-8');
    const execCode = this._buildExecCode(code, input);

    const startedAt = Date.now();
    let result;
    let success = false;

    try {
      result = await this.sandbox.execute(execCode, {
        allowRequire: true,
        env: { GENESIS_SANDBOX_ALLOW_READ_ROOT: this.sandbox?.rootDir || process.cwd() },
      });
      success = !result.error;
    } catch (err) {
      result = { output: '', error: err.message, duration: Date.now() - startedAt };
      success = false;
    }

    if (this.effectivenessTracker) {
      try {
        this.effectivenessTracker.recordInvocation(name, success, {
          latencyMs: Date.now() - startedAt,
          source: opts.source || 'rehearsal',
        });
      } catch (e) {
        _log.debug(`[SKILLS] tracker recordInvocation failed: ${e.message}`);
      }
    }

    return result;
  }

  /**
   * v7.9.4: Build the sandbox-execution wrapper code. Extracted from
   * executeSkill so executeSkillByManifest can reuse it without code
   * duplication. Accepts four export shapes — see comments below.
   *
   * @param {string} code - raw skill code (contents of index.js)
   * @param {*} input - input object to inject as _input
   * @returns {string} wrapped JS ready for sandbox.execute()
   * @private
   */
  _buildExecCode(code, input) {
    // v7.9.0 final: format-tolerant skill invocation. Accept four export
    // shapes so the LLM is not constrained to one rigid class pattern:
    //   1. class with execute() method        — `class Foo { execute() }`
    //   2. plain function or arrow function    — `module.exports = (i) => ...`
    //   3. object with execute() method        — `module.exports = { execute }`
    //   4. legacy: any constructable function  — fallback
    // Detection happens inside the sandbox after the skill module loads.
    return `
      ${code}
      const _exported = Object.values(module.exports || {});
      const _direct = typeof module.exports === 'function' ? module.exports : null;
      const _input = ${JSON.stringify({ cwd: this.sandbox?.rootDir, ...input })};
      let _result;
      // 1. Class with execute() on prototype
      const _SkillClass = _exported.find(v =>
        typeof v === 'function' && v.prototype && typeof v.prototype.execute === 'function'
      );
      if (_SkillClass) {
        const _instance = new _SkillClass();
        _result = await _instance.execute(_input);
      } else {
        // 3. Object with execute() method (also covers module.exports = { execute })
        const _objWithExecute = _exported.find(v =>
          v && typeof v === 'object' && typeof v.execute === 'function'
        );
        if (_objWithExecute) {
          _result = await _objWithExecute.execute(_input);
        } else if (_direct && typeof _direct === 'function') {
          // 2. module.exports is itself the function (arrow / plain)
          _result = await _direct(_input);
        } else {
          // 2b. Plain function exported by name (no prototype.execute)
          const _plainFn = _exported.find(v =>
            typeof v === 'function' && (!v.prototype || typeof v.prototype.execute !== 'function')
          );
          if (_plainFn) {
            _result = await _plainFn(_input);
          } else {
            throw new Error('Skill has no callable export (expected: class with execute(), plain function, or object with execute())');
          }
        }
      }
      console.log(JSON.stringify(_result));
    `;
  }

  /**
   * v7.9.28: run a TRUSTED first-party skill in-process (not in the VM sandbox).
   * Mirrors the four export shapes _buildExecCode accepts. Only reached for
   * skills marked _trusted (loaded from the built-in skillsDir) whose manifest
   * declares "sandbox": false — these legitimately need child_process/fs that
   * the sandbox blocks. Returns the same { output, error, duration } shape as
   * sandbox.execute so downstream success/telemetry logic is unchanged.
   */
  async _runSkillNative(entryPath, input) {
    let mod;
    try { delete require.cache[require.resolve(entryPath)]; } catch { /* fresh load best-effort */ }
    // eslint-disable-next-line global-require, import/no-dynamic-require
    mod = require(entryPath);
    const _input = { cwd: this.sandbox?.rootDir || process.cwd(), ...input };
    const exported = Object.values(mod || {});
    const direct = typeof mod === 'function' ? mod : null;
    let out;
    const SkillClass = exported.find((v) => typeof v === 'function' && v.prototype && typeof v.prototype.execute === 'function');
    if (SkillClass) {
      out = await new SkillClass().execute(_input);
    } else {
      const objWithExecute = exported.find((v) => v && typeof v === 'object' && typeof v.execute === 'function');
      if (objWithExecute) out = await objWithExecute.execute(_input);
      else if (direct && typeof direct === 'function') out = await direct(_input);
      else {
        const plainFn = exported.find((v) => typeof v === 'function' && (!v.prototype || typeof v.prototype.execute !== 'function'));
        if (plainFn) out = await plainFn(_input);
        else throw new Error('Skill has no callable export (expected: class with execute(), plain function, or object with execute())');
      }
    }
    return { output: typeof out === 'string' ? out : JSON.stringify(out), error: null, duration: 0, mode: 'native' };
  }

  /**
   * v7.9.4: Soft-discard a skill with reason. Sets manifest.status to
   * 'discarded' (no physical deletion — different from removeSkill which
   * does fs.rmSync). Fires skill:discarded for CoreMemories pickup.
   *
   * @param {string} name - skill name (must exist in koennenDir)
   * @param {string} reason - required, min 10 chars, max 300 chars
   * @returns {Promise<{ok: boolean, name: string, status: string}>}
   */
  async discardSkill(name, reason) {
    if (!name || typeof name !== 'string') {
      throw new Error('discardSkill: name required');
    }
    if (!reason || typeof reason !== 'string' || reason.length < 10) {
      throw new Error('discardSkill: reason required (min 10 chars)');
    }
    if (!this.koennenDir) {
      throw new Error('discardSkill: koennenDir not configured');
    }

    const skillDir = path.join(this.koennenDir, name);
    const manifestPath = path.join(skillDir, 'skill-manifest.json');
    if (!fs.existsSync(manifestPath)) {
      throw new Error(`Skill not found in Können directory: ${name}`);
    }

    const manifest = safeJsonParse(fs.readFileSync(manifestPath, 'utf-8'), null, 'SkillManager');
    if (!manifest) throw new Error(`Skill manifest invalid: ${name}`);

    manifest.status = 'discarded';
    manifest.koennen = manifest.koennen || {};
    manifest.koennen.discardedAt = Date.now();
    manifest.koennen.discardedReason = String(reason).slice(0, 300);

    atomicWriteFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf-8');

    // If the skill was promoted (in loadedSkills), remove it so future
    // calls fail clean. Discarded skills are gone from production use.
    if (this.loadedSkills.has(name)) {
      this.loadedSkills.delete(name);
    }

    if (this.bus) {
      this.bus.fire('skill:discarded', {
        skillName: name,
        reason: manifest.koennen.discardedReason,
      }, { source: 'SkillManager' });
    }

    return { ok: true, name, status: 'discarded' };
  }

  /**
   * Create a new skill from a natural language description.
   *
   * @param {string} description — natural-language spec of the skill
   * @param {object} [opts]
   * @param {string} [opts.desiredName] — v7.7.9 Phase 1c: when callers
   *   (e.g. AutonomousDaemon's capability-gap detector) need the loaded
   *   skill to land under a specific name so a later `check()` can find
   *   it, pass desiredName. The LLM is told to use that name; if the
   *   manifest the LLM produces uses a different name, we override it.
   *   Without this, the LLM picks names freely and the gap-detector
   *   keeps re-detecting the same gaps every cycle because it can't
   *   find the skill it just created.
   * @returns {Promise<string>} status message
   */
  async createSkill(description, opts = {}) {
    const desiredName = typeof opts.desiredName === 'string' && opts.desiredName.trim()
      ? opts.desiredName.trim()
      : null;
    const maxAttempts = typeof opts.maxAttempts === 'number' && opts.maxAttempts > 0
      ? opts.maxAttempts
      : 3;

    // v7.9.31 (AP-1): intake collision rule — when the target name is already
    // a loaded tool or a maturing candidate, answer without forging (saves the
    // whole LLM iteration); a quarantined/discarded name is archived here and
    // the forge proceeds as the next generation.
    if (desiredName) {
      const collisionEarly = this._candidateCollisionResponse(desiredName);
      if (collisionEarly) return collisionEarly;
    }

    // v7.9.0 final: iteration loop with error feedback (Voyager pattern).
    // The configured model stays configured — no auto-routing. Errors from
    // parser / safety / sandbox flow back into the next prompt so the LLM
    // can correct its own output. Three attempts: if the LLM can't produce
    // a working skill in three tries with this model, an honest failure
    // message is returned. The configured model is NEVER silently switched.
    const augmentedDescription = desiredName
      ? `${description}\n\nIMPORTANT: the skill manifest's "name" field MUST be exactly "${desiredName}".`
      : description;

    let lastError = null;
    let lastCode = null;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const prompt = this.prompts.build('create-skill', {
        description: augmentedDescription,
        attempt,
        lastError,
        lastCode,
      });

      this.bus?.fire?.('skill:forge-attempt', {
        source: 'create-skill',
        attempt,
        maxAttempts,
      }, { source: 'SkillManager' });

      const response = await this.model.chat(prompt, [], 'code');

      const result = await this._runForgeAttempt({
        response, description, desiredName, attempt, origin: opts.origin,
      });

      if (result.ok) {
        this.bus?.fire?.('skill:forge-succeeded', {
          source: 'create-skill',
          skillName: result.skillName,
          attempts: attempt,
        }, { source: 'SkillManager' });
        return result.message;
      }

      lastError = result.lastError;
      lastCode = result.lastCode;
    }

    this.bus?.fire?.('skill:forge-failed', {
      source: 'create-skill',
      attempts: maxAttempts,
      lastError: String(lastError || 'unknown'),
    }, { source: 'SkillManager' });

    return `❌ Could not forge a working skill after ${maxAttempts} attempts with the configured model.\n\n**Last error:** ${lastError}\n\nThe configured model was not switched. Consider: (1) a more detailed description, (2) a different configured model in settings, or (3) a different skill scope.`;
  }

  /**
   * Single forge attempt: parse → safety → sandbox → install.
   * Returns { ok: true, skillName, message } on success, or
   * { ok: false, lastError, lastCode } on failure (feeds next iteration).
   * @private
   */
  async _runForgeAttempt({ response, description, desiredName, attempt, origin }) {
    // Step 1: Extract manifest and code — with fallback strategies.
    // Order matters: the LLM often emits a closed ```json manifest fence
    // FIRST and an unclosed ```javascript code fence SECOND (truncated
    // mid-output by cloud token caps). A naive generic ```\w* fence
    // grabber would catch the *manifest* JSON as "code". So we prefer
    // explicit `javascript|js` tags at every level, accept truncated JS
    // before falling back to any generic fence, and reject any code
    // capture that starts with `{` (those are manifest leakages).
    let manifestMatch = response.match(/```(?:json)?\n(\{[\s\S]*?"name"[\s\S]*?\})\n```/);

    // (a) Strict: closed `javascript` or `js` fence
    let codeMatch = response.match(/```(?:javascript|js)\n([\s\S]+?)```/);

    // (b) Truncated `javascript|js` fence (no closing fence — cloud cut off)
    if (!codeMatch) {
      codeMatch = response.match(/```(?:javascript|js)\n([\s\S]+)$/);
    }

    // (c) Closed generic ```\w* fence — but reject if the capture starts
    //     with `{` (a manifest leaked through). The actual JS fence may
    //     still be truncated later in the response.
    if (!codeMatch) {
      const generic = response.match(/```(?!json\b)\w*\n([\s\S]+?)```/);
      if (generic && !generic[1].trim().startsWith('{')) {
        codeMatch = generic;
      }
    }

    // (d) Truncated generic fence to EOF — last resort, still reject JSON
    if (!codeMatch) {
      const truncGeneric = response.match(/```(?!json\b)\w*\n([\s\S]+)$/);
      if (truncGeneric && !truncGeneric[1].trim().startsWith('{')) {
        codeMatch = truncGeneric;
      }
    }

    // (e) Bare code without any fences. Accept the response as code if it
    //     contains function/exports/module patterns and no markdown fences.
    if (!codeMatch && !response.includes('```')) {
      const looksLikeCode = /(?:^|\n)\s*(?:async\s+)?function\s+\w+\s*\(|=>\s*[\{(]|module\.exports\s*=|exports\.\w+\s*=/.test(response);
      if (looksLikeCode) {
        codeMatch = [null, response.trim()];
      }
    }

    // Bare manifest JSON (no fences) — recoverable if the LLM dropped fences
    if (!manifestMatch) {
      manifestMatch = response.match(/(\{[\s\S]*?"name"\s*:[\s\S]*?\})/);
    }

    // If we have code but no manifest, generate a manifest from the description.
    // v7.7.9 Phase 1c: if a desiredName was provided, use that as the canonical
    // name instead of the awkward auto-derived one.
    if (codeMatch && !manifestMatch) {
      const autoName = desiredName || description.toLowerCase()
        .replace(/[^a-z0-9\s]/g, '').trim()
        .split(/\s+/).slice(0, 3).join('-') || 'custom-skill';
      manifestMatch = [null, JSON.stringify({
        name: autoName,
        version: '1.0.0',
        description: description.slice(0, 200),
        entry: 'index.js',
      })];
    }

    if (!codeMatch) {
      return { ok: false, lastError: 'response contained no parseable code block', lastCode: null };
    }

    let manifest;
    try {
      manifest = JSON.parse(manifestMatch[1]);
    } catch (_err) {
      return {
        ok: false,
        lastError: `manifest JSON malformed: ${_err.message}`,
        lastCode: codeMatch[1].trim(),
      };
    }

    // v7.7.9 Phase 1c: if desiredName was provided and the LLM still chose a
    // different name, override it. This is the contract callers rely on —
    // the loaded skill must be findable under desiredName afterwards.
    if (desiredName && manifest.name !== desiredName) {
      manifest.name = desiredName;
    }

    const skillCode = codeMatch[1].trim();
    const skillName = manifest.name || 'new-skill';

    // FIX v5.1.0 (DI-1): CodeSafety via port lateBinding (this._codeSafety)
    const safety = this._codeSafety.scanCode(skillCode, `skills/${skillName}/index.js`);
    if (!safety.safe) {
      return {
        ok: false,
        lastError: `code safety scanner blocked: ${safety.blocked.map(b => b.description).join('; ')}`,
        lastCode: skillCode,
      };
    }

    // Step 3: Test in sandbox
    const testResult = await this.sandbox.testPatch(
      `skills/${skillName}/index.js`,
      skillCode,
    );

    if (!testResult.success) {
      return {
        ok: false,
        lastError: `sandbox test failed (${testResult.phase || 'unknown'}): ${testResult.error}`,
        lastCode: skillCode,
      };
    }

    // Step 4: persist as a maturing candidate (v7.9.31, AP-1) — the forge
    // no longer installs into the live registry; promotion does that.
    return this._installCandidateSkill(manifest, skillCode, skillName, {
      origin, description, attempts: attempt,
    });
  }

  /** Remove a skill */
  removeSkill(name) {
    const skill = this.loadedSkills.get(name);
    if (!skill) return false;

    fs.rmSync(skill.dir, { recursive: true, force: true });
    this.loadedSkills.delete(name);
    return true;
  }

  // ── v3.8.0: Boot-time auto-init ──────────────────────────
  // Called by Container.bootAll(). Absorbs loadSkills() from AgentCore.

  /** @internal Called by Container.bootAll() */
  async asyncLoad() {
    await this.loadSkills();
  }
}

// v7.9.31 (AP-1): Koennen-intake mixin — candidate installer, coverage
// predicate, generation path, and the shared rehearsal-outcome vocabulary.
Object.assign(SkillManager.prototype, koennenIntakeMixin);

module.exports = { SkillManager };
