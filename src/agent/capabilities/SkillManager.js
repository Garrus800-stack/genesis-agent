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
    const execCode = `
      ${code}
      const SkillClass = Object.values(module.exports || {}).find(v => typeof v === 'function');
      if (SkillClass) {
        const instance = new SkillClass();
        const result = await instance.execute(${JSON.stringify(input)});
        console.log(JSON.stringify(result));
      } else {
        throw new Error('No exported class found in skill');
      }
    `;

    return await this.sandbox.execute(execCode, { allowRequire: true });
  }

  /** Create a new skill from a natural language description */
  async createSkill(description) {
    const existingSkills = this.listSkills()
      .map(s => `${s.name}: ${s.description}`)
      .join('\n') || 'Keine';

    // Step 1: Generate skill code via LLM
    const prompt = this.prompts.build('create-skill', {
      description,
      existingSkills,
    });

    const response = await this.model.chat(prompt, [], 'code');

    // Step 2: Extract manifest and code
    const manifestMatch = response.match(/```(?:json)?\n(\{[\s\S]*?"name"[\s\S]*?\})\n```/);
    const codeMatch = response.match(/```(?:javascript|js)\n([\s\S]+?)```/);

    if (!manifestMatch || !codeMatch) {
      return '❌ Could not create skill — model returned incomplete result. Try a more detailed description.';
    }

    let manifest;
    try {
      manifest = JSON.parse(manifestMatch[1]);
    } catch (err) {
      return '❌ Invalid manifest JSON from model.';
    }

    const skillCode = codeMatch[1].trim();
    const skillName = manifest.name || 'new-skill';
    const skillDir = path.join(this.skillsDir, skillName);

    // FIX v5.1.0 (DI-1): CodeSafety via port lateBinding (this._codeSafety)
    const safety = this._codeSafety.scanCode(skillCode, `skills/${skillName}/index.js`);
    if (!safety.safe) {
      return `❌ Skill "${skillName}" blocked by safety scanner:\n${safety.blocked.map(b => b.description).join('\n')}`;
    }

    // Step 3: Test in sandbox
    const testResult = await this.sandbox.testPatch(
      `skills/${skillName}/index.js`,
      skillCode
    );

    if (!testResult.success) {
      return `⚠️ Skill "${skillName}" failed the test:\n\n**Phase:** ${testResult.phase}\n**Error:** ${testResult.error}\n\nShould I try again?`;
    }

    // Step 4: Install
    // FIX v4.10.0 (Audit P1-03b): Path traversal protection + SafeGuard validation.
    // manifest.entry and skillName come from LLM output — must be sanitized.
    const safeEntry = path.basename(manifest.entry || 'index.js');
    const manifestPath = path.join(skillDir, 'skill-manifest.json');
    const codePath = path.join(skillDir, safeEntry);

    // Verify paths resolve inside skillsDir
    const skillsDirResolved = path.resolve(this.skillsDir);
    if (!path.resolve(manifestPath).startsWith(skillsDirResolved + path.sep)) {
      return `❌ Path traversal blocked: ${manifestPath}`;
    }
    if (!path.resolve(codePath).startsWith(skillsDirResolved + path.sep)) {
      return `❌ Path traversal blocked: ${codePath}`;
    }

    // SafeGuard validation (blocks kernel, critical files, node_modules, .git)
    if (this.guard) {
      try {
        this.guard.validateWrite(manifestPath);
        this.guard.validateWrite(codePath);
      } catch (err) {
        return `❌ SafeGuard blocked: ${err.message}`;
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

    return `✅ Skill "${skillName}" erstellt und installiert!\n\n**Beschreibung:** ${manifest.description}\n**Interface:** ${JSON.stringify(manifest.interface, null, 2)}\n**Test:** Bestanden`;
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
