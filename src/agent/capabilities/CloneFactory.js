// @ts-checked-v5.6
// ============================================================
// GENESIS AGENT — CloneFactory.js
// Creates improved copies of the entire agent.
// The ultimate self-evolution: build your successor.
// ============================================================

const fs = require('fs');
const path = require('path');
const { safeJsonParse, atomicWriteFileSync } = require('../core/utils');
const { createLogger } = require('../core/Logger');
const _log = createLogger('CloneFactory');
// FIX v5.1.0 (DI-1): CodeSafety injected via lateBinding (this._codeSafety)

class CloneFactory {
  constructor(rootDir, selfModel, model, prompts, guard) {
    this.rootDir = rootDir;
    this.selfModel = selfModel;
    this.model = model;
    this.prompts = prompts;
    // FIX v4.0.0: SafeGuard for write validation
    this.guard = guard || null;
    // v5.0.0: Genome — late-bound from Container. If bound, offspring
    // receive mutated trait values instead of exact copies.
    this.genome = null;
    /** @type {any} late-bound via DI (CodeSafetyPort) */
    this._codeSafety = null;
  }

  /**
   * Create an improved clone of the agent
   * @param {object} options
   * @param {string} options.improvements - What to improve
   * @param {Array} options.conversation - Recent conversation for context
   * @returns {Promise<string>} Status report
   */
  async createClone({ improvements, conversation }) {
    // Step 1: Plan the clone
    const plan = await this._planClone(improvements, conversation);

    // Step 2: Determine output directory
    // FIX v4.0.0: Strict clone name sanitization — strip path separators,
    // traversal patterns, and non-alphanumeric chars to prevent writes
    // outside the parent directory.
    let cloneName = this._extractCloneName(plan) || `genesis-clone-${Date.now()}`;
    cloneName = cloneName.replace(/[^a-z0-9_-]/gi, '-').replace(/^-+|-+$/g, '').slice(0, 64);
    if (!cloneName || cloneName === '.' || cloneName === '..') {
      cloneName = `genesis-clone-${Date.now()}`;
    }
    // FIX v4.10.0 (M-5): Create clones inside a dedicated 'clones/' directory
    // within the project root, not in the parent directory. Writing to the parent
    // gives the agent broader filesystem scope than any other module. The clones/
    // directory is excluded from self-model scanning and git tracking.
    const clonesBase = path.join(this.rootDir, 'clones');
    if (!fs.existsSync(clonesBase)) fs.mkdirSync(clonesBase, { recursive: true });
    const cloneDir = path.join(clonesBase, cloneName);

    // Verify clone dir stays within clones/
    if (!cloneDir.startsWith(clonesBase + path.sep)) {
      return `⚠️ Clone directory path traversal blocked: "${cloneName}"`;
    }

    if (fs.existsSync(cloneDir)) {
      return `⚠️ Directory "${cloneName}" already exists. Choose a different name.`;
    }

    // FIX D-3: Wrap clone creation in try/catch. On failure, clean up the
    // partial clone directory to avoid leaving orphaned half-copies on disk.
    try {
      // Step 3: Copy base structure
      this._copyRecursive(this.rootDir, cloneDir, [
        'node_modules', '.git', 'sandbox', '.genesis', 'clones',
      ]);

      // Step 4: Apply improvements based on the plan
      const modifications = await this._generateModifications(plan, cloneDir);

      // Step 5: Update package.json with new identity
      this._updateIdentity(cloneDir, cloneName, plan);

      // Step 6: Create a genesis log
      const genesisDir = path.join(cloneDir, '.genesis');
      if (!fs.existsSync(genesisDir)) fs.mkdirSync(genesisDir, { recursive: true });

      // FIX v5.0.0: Atomic writes prevent half-written files on crash.
      atomicWriteFileSync(
        path.join(genesisDir, 'origin.json'),
        JSON.stringify({
          parent: this.selfModel.getFullModel().identity,
          parentVersion: this.selfModel.getFullModel().version,
          createdAt: new Date().toISOString(),
          improvements,
          plan,
          modifications: modifications.map(m => m.file),
        }, null, 2),
        'utf-8'
      );

      // v5.0.0: Genome reproduction — offspring receives mutated traits
      let offspringGenome = null;
      if (this.genome) {
        try {
          offspringGenome = this.genome.reproduce();
          atomicWriteFileSync(
            path.join(genesisDir, 'genome.json'),
            JSON.stringify(offspringGenome, null, 2),
            'utf-8'
          );
        } catch (err) {
          // Non-fatal — clone works without genome, just won't have trait variation
          offspringGenome = null;
        }
      }

      const genomeInfo = offspringGenome
        ? `\n**Genome:** Generation ${offspringGenome.generation}, ${Object.keys(offspringGenome.traits).length} traits (mutated from parent)`
        : '';

      return `🧬 Clone "${cloneName}" created!

**Directory:** ${cloneDir}
**Base:** ${this.selfModel.getFullModel().identity} v${this.selfModel.getFullModel().version}
**Planned improvements:**
${plan}

**Modified files:**
${modifications.map(m => `- ${m.file}: ${m.status}`).join('\n')}${genomeInfo}

**Next steps:**
1. \`cd ${cloneName}\`
2. \`npm install\`
3. \`npm start\`

You can now interact with your clone and develop it further.`;

    } catch (err) {
      // FIX D-3: Rollback — remove partial clone directory
      this._removeRecursive(cloneDir);
      return `⚠️ Clone creation failed: ${err.message}\nPartial clone directory has been cleaned up.`;
    }
  }

  async _planClone(improvements, conversation) {
    const prompt = this.prompts.build('clone-plan', {
      selfModel: this.selfModel.getModuleSummary(),
      conversation,
      improvements,
    });

    return await this.model.chat(prompt, [], 'analysis');
  }

  async _generateModifications(plan, cloneDir) {
    const results = [];

    // Parse plan for specific file changes
    const fileChanges = plan.match(/(?:src\/[\w/.-]+\.js)/g) || [];
    const uniqueFiles = [...new Set(fileChanges)];

    for (const file of uniqueFiles) {
      const fullPath = path.join(cloneDir, file);
      if (!fs.existsSync(fullPath)) {
        results.push({ file, status: 'skipped (not found)' });
        continue;
      }

      try {
        const currentCode = fs.readFileSync(fullPath, 'utf-8');
        const modPrompt = this.prompts.build('generate-modification', {
          plan,
          files: { [file]: currentCode },
          request: `Improve this file according to the clone plan: ${plan.slice(0, 500)}`,
        });

        const response = await this.model.chat(modPrompt, [], 'code');
        const codeMatch = response.match(/```(?:javascript|js)?\n([\s\S]+?)```/);

        if (codeMatch) {
          // FIX v4.10.0 (L-5): Safety scan LLM-generated code before writing to clone.
          // Although clones are separate projects, they may be imported back or inspected
          // by the parent agent, and should not contain eval(), kernel imports, etc.
          const cloneCode = codeMatch[1].trim();
          const safety = this._codeSafety.scanCode(cloneCode, file);
          if (!safety.safe) {
            results.push({ file, status: `⛔ Safety block: ${safety.blocked.map(b => b.description).join(', ')}` });
          } else {
            atomicWriteFileSync(fullPath, cloneCode, 'utf-8');
            results.push({ file, status: '✅ modified' });
          }
        } else {
          results.push({ file, status: 'no changes generated' });
        }
      } catch (err) {
        results.push({ file, status: `❌ Error: ${err.message}` });
      }
    }

    return results;
  }

  _updateIdentity(cloneDir, cloneName, plan) {
    const pkgPath = path.join(cloneDir, 'package.json');
    if (fs.existsSync(pkgPath)) {
      const pkg = safeJsonParse(fs.readFileSync(pkgPath, 'utf-8'), {}, 'CloneFactory');
      pkg.name = cloneName;
      pkg.version = this._bumpVersion(pkg.version || '0.1.0');
      pkg.description = `Clone of Genesis -- ${plan.slice(0, 100)}`;
      atomicWriteFileSync(pkgPath, JSON.stringify(pkg, null, 2), 'utf-8');
    }
  }

  _extractCloneName(plan) {
    const match = plan.match(/NAME:\s*(\S+)/i);
    return match?.[1]?.toLowerCase().replace(/[^a-z0-9-]/g, '-') || null;
  }

  _bumpVersion(version) {
    const parts = version.split('.').map(Number);
    parts[1] = (parts[1] || 0) + 1;
    return parts.join('.');
  }

  _copyRecursive(src, dest, ignore = []) {
    if (!fs.existsSync(dest)) fs.mkdirSync(dest, { recursive: true });

    for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
      if (ignore.includes(entry.name)) continue;

      const srcPath = path.join(src, entry.name);
      const destPath = path.join(dest, entry.name);

      if (entry.isDirectory()) {
        this._copyRecursive(srcPath, destPath, ignore);
      } else {
        fs.copyFileSync(srcPath, destPath);
      }
    }
  }

  /**
   * FIX D-3: Remove a directory tree. Used to clean up partial clones on failure.
   * @param {string} dir - Directory to remove
   */
  _removeRecursive(dir) {
    try {
      if (fs.existsSync(dir)) {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    } catch (err) {
      // Best effort — log but don't throw during cleanup
      _log.warn(`[CLONE] Failed to clean up partial clone at ${dir}: ${err.message}`);
    }
  }
}

module.exports = { CloneFactory };
