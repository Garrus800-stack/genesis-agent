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
const _log = createLogger('SkillManager');

class SkillManager {
  constructor(skillsDir, sandbox, model, prompts, guard) {
    this.skillsDir = skillsDir;
    this.sandbox = sandbox;
    this.model = model;
    this.prompts = prompts;
    this.guard = guard || null;
    this.loadedSkills = new Map();
    /** @type {any} late-bound via DI (CodeSafetyPort) */
    this._codeSafety = null;

    if (!fs.existsSync(skillsDir)) {
      fs.mkdirSync(skillsDir, { recursive: true });
    }
  }

  /** Load all installed skills from disk */
  loadSkills() {
    this.loadedSkills.clear();
    if (!fs.existsSync(this.skillsDir)) return;

    // v7.8.3: warn (but proceed) if skills live under a cloud-sync root.
    // Reading manifest/entry files may hang on first touch as the OS
    // pulls Files-On-Demand placeholders. The warning gives the user
    // a chance to move Genesis before they hit a slow boot.
    if (isCloudSyncPath(this.skillsDir)) {
      _log.warn(`[SKILLS] skillsDir is under a cloud-sync root (${this.skillsDir}) — skill loads may hang on Files-On-Demand placeholders`);
    }

    for (const entry of fs.readdirSync(this.skillsDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;

      const manifestPath = path.join(this.skillsDir, entry.name, 'skill-manifest.json');
      if (!fs.existsSync(manifestPath)) continue;

      try {
        const manifest = safeJsonParse(fs.readFileSync(manifestPath, 'utf-8'), null, 'SkillManager');
        if (!manifest) { _log.warn('[SKILLS] Invalid manifest:', manifestPath); continue; }
        this.loadedSkills.set(manifest.name, {
          ...manifest,
          dir: path.join(this.skillsDir, entry.name),
          loaded: true,
        });
      } catch (err) {
        _log.warn(`[SKILLS] Failed to load skill ${entry.name}: ${err.message}`);
      }
    }

    _log.info(`[SKILLS] Loaded ${this.loadedSkills.size} skills`);
  }

  /** List all skills */
  listSkills() {
    return Array.from(this.loadedSkills.values()).map(s => ({
      name: s.name,
      version: s.version,
      description: s.description,
      interface: s.interface,
    }));
  }

  /** Execute a skill by name */
  async executeSkill(name, input) {
    const skill = this.loadedSkills.get(name);
    if (!skill) throw new Error(`Skill not found: ${name}`);

    const entryPath = path.join(skill.dir, skill.entry);
    if (!fs.existsSync(entryPath)) {
      throw new Error(`Skill entry point not found: ${entryPath}`);
    }

    // Run in sandbox for safety
    const code = fs.readFileSync(entryPath, 'utf-8');
    // v7.9.0 final: format-tolerant skill invocation. Accept four export
    // shapes so the LLM is not constrained to one rigid class pattern:
    //   1. class with execute() method        — `class Foo { execute() }`
    //   2. plain function or arrow function    — `module.exports = (i) => ...`
    //   3. object with execute() method        — `module.exports = { execute }`
    //   4. legacy: any constructable function  — fallback
    // Detection happens inside the sandbox after the skill module loads.
    const execCode = `
      ${code}
      const _exported = Object.values(module.exports || {});
      const _direct = typeof module.exports === 'function' ? module.exports : null;
      const _input = ${JSON.stringify(input)};
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

    return await this.sandbox.execute(execCode, {
      allowRequire: true,
      // FIX v6.1.1: Skills need read access to project files (fs path restrictions still enforced)
      env: { GENESIS_SANDBOX_ALLOW_READ_ROOT: this.sandbox?.rootDir || process.cwd() },
    });
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
        response, description, desiredName, attempt,
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
  async _runForgeAttempt({ response, description, desiredName, attempt }) {
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
    const skillDir = path.join(this.skillsDir, skillName);

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

    // Step 4: Install
    return this._installForgedSkill(manifest, skillCode, skillName, skillDir, attempt);
  }

  /**
   * Write a verified skill to disk and reload the registry.
   * Returns { ok: true, skillName, message } on success or
   * { ok: false, lastError, lastCode } on install-time failure (rare).
   * @private
   */
  async _installForgedSkill(manifest, skillCode, skillName, skillDir, attempts) {
    // FIX v4.10.0 (Audit P1-03b): Path traversal protection + SafeGuard validation.
    // manifest.entry and skillName come from LLM output — must be sanitized.
    const safeEntry = path.basename(manifest.entry || 'index.js');
    const manifestPath = path.join(skillDir, 'skill-manifest.json');
    const codePath = path.join(skillDir, safeEntry);

    // Verify paths resolve inside skillsDir
    const skillsDirResolved = path.resolve(this.skillsDir);
    if (!path.resolve(manifestPath).startsWith(skillsDirResolved + path.sep)) {
      return { ok: false, lastError: `path traversal blocked: ${manifestPath}`, lastCode: skillCode };
    }
    if (!path.resolve(codePath).startsWith(skillsDirResolved + path.sep)) {
      return { ok: false, lastError: `path traversal blocked: ${codePath}`, lastCode: skillCode };
    }

    // SafeGuard validation (blocks kernel, critical files, node_modules, .git)
    if (this.guard) {
      try {
        this.guard.validateWrite(manifestPath);
        this.guard.validateWrite(codePath);
      } catch (err) {
        return { ok: false, lastError: `SafeGuard blocked: ${err.message}`, lastCode: skillCode };
      }
    }

    if (!fs.existsSync(skillDir)) {
      fs.mkdirSync(skillDir, { recursive: true });
    }

    // FIX v5.1.0 (N-3): Atomic writes for skill installation.
    atomicWriteFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf-8');
    atomicWriteFileSync(codePath, skillCode, 'utf-8');

    // Reload skills
    await this.loadSkills();

    const attemptNote = attempts > 1 ? `\n**Attempts:** ${attempts}` : '';
    return {
      ok: true,
      skillName,
      message: `✅ Skill "${skillName}" erstellt und installiert!\n\n**Beschreibung:** ${manifest.description}${attemptNote}\n**Interface:** ${JSON.stringify(manifest.interface, null, 2)}\n**Test:** Bestanden`,
    };
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

module.exports = { SkillManager };
