// @ts-checked-v5.7
// ============================================================
// GENESIS — MultiFileRefactor.js (v3.5.0)
//
// PROBLEM: SelfModificationPipeline can only modify ONE file at
// a time. Real refactoring needs cross-file changes:
// "Extract this class into its own module" requires:
//   1. Create new file with the class
//   2. Remove class from old file
//   3. Add require() in old file
//   4. Update all other files that import from old file
//   5. Test everything still works
//   6. Commit atomically
//
// SOLUTION: A refactoring engine that:
// - Parses the dependency graph (who requires who)
// - Plans multi-file changes as a transaction
// - Applies changes atomically (all or nothing via git)
// - Tests after each file, rolls back on failure
// - Updates imports automatically
// ============================================================

const path = require('path');
const { TIMEOUTS } = require('../core/Constants');
const fs = require('fs');
const { NullBus } = require('../core/EventBus');
const { createLogger } = require('../core/Logger');
const _log = createLogger('MultiFileRefactor');

class MultiFileRefactor {
  constructor({ bus, selfModel, model, sandbox, guard, eventStore, rootDir, astDiff }) {
    this.bus = bus || NullBus;
    this.selfModel = selfModel;
    this.model = model;
    this.sandbox = sandbox;
    this.guard = guard;
    this.eventStore = eventStore;
    this.rootDir = rootDir;
    this.astDiff = astDiff || null;

    this._stats = { totalRefactors: 0, filesChanged: 0, rollbacks: 0 };
  }

  // ════════════════════════════════════════════════════════
  // PUBLIC API
  // ════════════════════════════════════════════════════════

  /**
   * Execute a multi-file refactoring operation.
   *
   * @param {string} description - Natural language description of what to refactor
   * @param {object} options - { dryRun, maxFiles, autoCommit }
   * @returns {Promise<object>} { success, changes, errors, committed }
   */
  async refactor(description, options = {}) {
    const { dryRun = false, maxFiles = 10, autoCommit = true } = options;

    this.bus.fire('refactor:started', { description }, { source: 'MultiFileRefactor' });

    try {
      // Phase 1: Analyze — understand the codebase graph
      const depGraph = this._buildDependencyGraph();
      const affectedFiles = await this._planRefactoring(description, depGraph);

      if (affectedFiles.length === 0) {
        return { success: false, error: 'Could not determine which files to change', changes: [] };
      }

      if (affectedFiles.length > maxFiles) {
        return { success: false, error: `Refactoring would touch ${affectedFiles.length} files (max: ${maxFiles})`, changes: [] };
      }

      // Phase 2: Generate — create the actual code changes
      const changeset = await this._generateChanges(description, affectedFiles, depGraph);

      if (dryRun) {
        return { success: true, dryRun: true, changes: changeset.map(c => ({ file: c.file, action: c.action, linesChanged: c.newCode?.split('\n').length || 0 })) };
      }

      // Phase 3: Snapshot (pre-change)
      await this._gitSnapshot('pre-refactor: ' + description.slice(0, 50));

      // Phase 4: Apply + Test (atomic)
      const result = await this._applyAndTest(changeset);

      if (!result.success) {
        // Rollback
        await this._gitRollback();
        this._stats.rollbacks++;
        this.bus.fire('refactor:rolled-back', { description, error: result.error }, { source: 'MultiFileRefactor' });
        return { success: false, error: result.error, changes: result.changes, rolledBack: true };
      }

      // Phase 5: Commit
      if (autoCommit) {
        await this._gitSnapshot('refactor: ' + description.slice(0, 50));
      }

      this._stats.totalRefactors++;
      this._stats.filesChanged += changeset.length;

      this.eventStore?.append('MULTI_FILE_REFACTOR', {
        description: description.slice(0, 100),
        files: changeset.map(c => c.file),
        success: true,
      }, 'MultiFileRefactor');

      this.bus.fire('refactor:complete', {
        description,
        filesChanged: changeset.length,
      }, { source: 'MultiFileRefactor' });

      return {
        success: true,
        changes: result.changes,
        committed: autoCommit,
      };

    } catch (err) {
      return { success: false, error: err.message, changes: [] };
    }
  }

  /**
   * Extract a class/function from one file into a new module.
   * The most common refactoring operation.
   */
  async extractToModule(sourceFile, symbolName, targetFile) {
    const description = `Extract "${symbolName}" from ${sourceFile} into new file ${targetFile}, update all imports`;
    return this.refactor(description, { maxFiles: 15 });
  }

  /**
   * Rename a module file and update all imports.
   */
  async renameModule(oldPath, newPath) {
    const description = `Rename ${oldPath} to ${newPath} and update all require() references`;
    return this.refactor(description, { maxFiles: 20 });
  }

  getStats() { return { ...this._stats }; }

  // ════════════════════════════════════════════════════════
  // DEPENDENCY GRAPH
  // ════════════════════════════════════════════════════════

  /**
   * Build a graph of require() dependencies across all source files.
   * Returns: { 'src/agent/AgentCore.js': { requires: ['./EventBus', './Container', ...], requiredBy: [...] } }
   */
  _buildDependencyGraph() {
    const graph = {};
    const files = this.selfModel?.getFileTree?.() || [];
    const jsFiles = this._collectJsFiles(files);

    for (const file of jsFiles) {
      const fullPath = path.join(this.rootDir, file);
      if (!fs.existsSync(fullPath)) continue;

      try {
        const code = fs.readFileSync(fullPath, 'utf-8');
        const requires = this._extractRequires(code);
        graph[file] = {
          requires: requires.map(r => this._resolveRequirePath(file, r)),
          rawRequires: requires,
          exports: this._extractExports(code),
          requiredBy: [], // filled in second pass
        };
      } catch (err) { _log.debug('[REFACTOR] Parse error:', err.message); }
    }

    // Second pass: fill requiredBy
    for (const [file, info] of Object.entries(graph)) {
      for (const dep of info.requires) {
        if (graph[dep]) {
          graph[dep].requiredBy.push(file);
        }
      }
    }

    return graph;
  }

  /** Extract require('./...') paths from source code */
  _extractRequires(code) {
    const requires = [];
    const rx = /require\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
    let match;
    while ((match = rx.exec(code))) {
      requires.push(match[1]);
    }
    return requires;
  }

  /** Extract module.exports names */
  _extractExports(code) {
    const exports = [];
    // module.exports = { Foo, Bar }
    const destructMatch = code.match(/module\.exports\s*=\s*\{([^}]+)\}/);
    if (destructMatch) {
      exports.push(...destructMatch[1].split(',').map(s => s.trim().split(':')[0].trim()).filter(Boolean));
    }
    // class Foo { ... } module.exports = { Foo }
    const classRx = /class\s+(\w+)/g;
    let cm;
    while ((cm = classRx.exec(code))) exports.push(cm[1]);
    return [...new Set(exports)];
  }

  /** Resolve a relative require path to a project-relative path */
  _resolveRequirePath(fromFile, requirePath) {
    if (!requirePath.startsWith('.')) return requirePath; // external module
    const fromDir = path.dirname(fromFile);
    let resolved = path.join(fromDir, requirePath).replace(/\\/g, '/');
    if (!resolved.endsWith('.js')) resolved += '.js';
    return resolved;
  }

  /** Recursively collect .js files from the file tree */
  _collectJsFiles(tree, prefix = '') {
    const files = [];
    for (const item of tree) {
      const fullPath = prefix ? `${prefix}/${item.name || item}` : (item.name || item);
      if (typeof item === 'string') {
        if (item.endsWith('.js')) files.push(fullPath);
      } else if (item.children) {
        files.push(...this._collectJsFiles(item.children, fullPath));
      } else if (item.name?.endsWith('.js')) {
        files.push(fullPath);
      }
    }
    return files;
  }

  // ════════════════════════════════════════════════════════
  // PLANNING
  // ════════════════════════════════════════════════════════

  async _planRefactoring(description, depGraph) {
    const fileList = Object.keys(depGraph).join('\n');

    const prompt = `You are Genesis. You need to plan a multi-file refactoring.

REFACTORING: "${description}"

PROJECT FILES AND THEIR DEPENDENCIES:
${Object.entries(depGraph).slice(0, 30).map(([file, info]) =>
  `${file}: requires [${info.requires.filter(r => r.startsWith('src/')).join(', ')}] exports [${info.exports.join(', ')}]`
).join('\n')}

Which files need to be MODIFIED or CREATED? List ONLY the files that need changes.
For each file, specify the action: MODIFY, CREATE, or DELETE.

Respond ONLY with JSON:
[
  { "file": "src/agent/Example.js", "action": "MODIFY", "reason": "Remove extracted class" },
  { "file": "src/agent/NewModule.js", "action": "CREATE", "reason": "New home for extracted class" }
]`;

    try {
      const response = await this.model.chatStructured(prompt, [], 'code');
      if (Array.isArray(response)) return response;
      if (response._parseError) return [];
      return [];
    } catch (err) {
      _log.debug('[REFACTOR] Analysis request failed:', err.message);
      return [];
    }
  }

  // ════════════════════════════════════════════════════════
  // CODE GENERATION
  // ════════════════════════════════════════════════════════

  async _generateChanges(description, affectedFiles, depGraph) {
    const changeset = [];

    for (const af of affectedFiles) {
      const file = af.file;
      const action = af.action;

      if (action === 'DELETE') {
        changeset.push({ file, action: 'DELETE', newCode: null });
        continue;
      }

      const existingCode = action === 'MODIFY' ? this._readFile(file) : '';
      const relatedFiles = this._getRelatedContext(file, depGraph);

      const prompt = `You are Genesis performing a multi-file refactoring.

OVERALL GOAL: "${description}"
CURRENT FILE: ${file} (${action})
REASON: ${af.reason || 'Part of refactoring'}

${existingCode ? `CURRENT CODE:\n\`\`\`javascript\n${existingCode.slice(0, 6000)}\n\`\`\`` : 'This is a NEW file.'}

${relatedFiles ? `RELATED FILES (for import context):\n${relatedFiles}` : ''}

Generate the COMPLETE ${action === 'CREATE' ? 'new' : 'updated'} file content.
- Keep all existing functionality unless the refactoring explicitly changes it
- Update require() paths as needed
- Maintain module.exports
- Add proper file header comments

Respond ONLY with the complete file inside a code block.`;

      const response = await this.model.chat(prompt, [], 'code');
      const codeMatch = response.match(/```(?:\w+)?\n([\s\S]+?)```/);

      if (codeMatch) {
        changeset.push({ file, action, newCode: codeMatch[1].trim() });
      }
    }

    return changeset;
  }

  _getRelatedContext(file, depGraph) {
    const info = depGraph[file];
    if (!info) return '';

    const related = [];
    for (const dep of [...info.requires, ...info.requiredBy].slice(0, 5)) {
      if (dep.startsWith('src/') && depGraph[dep]) {
        const code = this._readFile(dep);
        if (code) {
          // Just the first 20 lines + exports
          const head = code.split('\n').slice(0, 20).join('\n');
          const exportsLine = depGraph[dep].exports.length > 0
            ? `\nexports: ${depGraph[dep].exports.join(', ')}`
            : '';
          related.push(`--- ${dep} (first 20 lines) ---\n${head}${exportsLine}`);
        }
      }
    }
    return related.join('\n\n');
  }

  // ════════════════════════════════════════════════════════
  // APPLY & TEST
  // ════════════════════════════════════════════════════════

  async _applyAndTest(changeset) {
    const applied = [];
    const errors = [];

    for (const change of changeset) {
      const fullPath = path.join(this.rootDir, change.file);

      try {
        // Security check
        this.guard.validateWrite(fullPath);

        if (change.action === 'DELETE') {
          if (fs.existsSync(fullPath)) fs.unlinkSync(fullPath);
          applied.push({ file: change.file, action: 'DELETE', success: true });
          continue;
        }

        // Syntax check before writing
        const syntaxResult = await this.sandbox.syntaxCheck(change.newCode);
        if (!syntaxResult.valid) {
          errors.push({ file: change.file, error: `Syntax: ${syntaxResult.error}` });
          return { success: false, error: `Syntax error in ${change.file}: ${syntaxResult.error}`, changes: applied };
        }

        // Write — FIX v4.10.0: Async atomic write
        const dir = path.dirname(fullPath);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        const { atomicWriteFile } = require('../core/utils');
        await atomicWriteFile(fullPath, change.newCode, 'utf-8');

        applied.push({
          file: change.file,
          action: change.action,
          lines: change.newCode.split('\n').length,
          success: true,
        });

      } catch (err) {
        errors.push({ file: change.file, error: err.message });
        return { success: false, error: `Failed on ${change.file}: ${err.message}`, changes: applied };
      }
    }

    // Cross-file require test: try to load each changed file
    for (const change of changeset.filter(c => c.action !== 'DELETE')) {
      const testResult = await this.sandbox.testPatch(change.file, change.newCode);
      if (!testResult.success) {
        return {
          success: false,
          error: `Require-test failed for ${change.file}: ${testResult.error}`,
          changes: applied,
        };
      }
    }

    return { success: true, changes: applied, errors };
  }

  // ════════════════════════════════════════════════════════
  // GIT OPERATIONS
  // ════════════════════════════════════════════════════════

  // FIX v3.5.0: Shell injection prevention — use execFile with array args
  // FIX v4.0.1: Async — no longer blocks the main thread during git operations.
  async _gitSnapshot(message) {
    try {
      const { execFile } = require('child_process');
      const { promisify } = require('util');
      const execFileAsync = promisify(execFile);
      const opts = { cwd: this.rootDir, encoding: 'utf-8', windowsHide: true, timeout: TIMEOUTS.COMMAND_EXEC };
      await execFileAsync('git', ['add', '-A'], opts);
      // Sanitize: strip control chars, limit length
      const safeMsg = String(message).replace(/[\x00-\x1f\x7f]/g, '').slice(0, 200);
      await execFileAsync('git', ['commit', '-m', safeMsg, '--allow-empty'], opts);
    } catch (err) { _log.warn('[REFACTOR] Git commit failed:', err.message); }
  }

  async _gitRollback() {
    try {
      const { execFile } = require('child_process');
      const { promisify } = require('util');
      const execFileAsync = promisify(execFile);
      const opts = { cwd: this.rootDir, encoding: 'utf-8', windowsHide: true, timeout: TIMEOUTS.COMMAND_EXEC };
      await execFileAsync('git', ['checkout', '--', '.'], opts);
      // Also clean untracked new files from the refactor
      await execFileAsync('git', ['clean', '-fd', 'src/'], opts);
    } catch (err) { _log.warn('[REFACTOR] Git rollback failed:', err.message); }
  }

  _readFile(relPath) {
    const fullPath = path.join(this.rootDir, relPath);
    try { return fs.readFileSync(fullPath, 'utf-8'); } catch (err) { _log.debug('[REFACTOR] Read failed:', relPath, err.message); return ''; }
  }
}

module.exports = { MultiFileRefactor };
