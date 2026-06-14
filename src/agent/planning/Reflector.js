// ============================================================
// GENESIS AGENT — Reflector.js
// Self-analysis and self-repair loop.
// OBSERVE → ANALYZE → PLAN → TEST → APPLY → VERIFY
// ============================================================

const fs = require('fs');
const path = require('path');
const { atomicWriteFileSync } = require('../core/utils');

// v7.9.22 Item 6: is the require(<literal>) for `req` lexically inside a try block? A
// guarded require with a fallback is not a defect, so its missing-dependency issue is
// informational rather than HIGH. Walks the acorn AST, tracking descent into a try block.
function _requireIsTryGuarded(ast, req) {
  let found = false, guarded = false;
  (function walk(node, inTry) {
    if (found || !node || typeof node !== 'object') return;
    if (node.type === 'CallExpression' && node.callee && node.callee.name === 'require'
        && node.arguments && node.arguments[0] && node.arguments[0].value === req) {
      found = true; guarded = inTry; return;
    }
    for (const k of Object.keys(node)) {
      if (k === 'type' || k === 'start' || k === 'end' || k === 'loc') continue;
      const child = node[k];
      const arr = Array.isArray(child) ? child : [child];
      for (const c of arr) {
        if (c && typeof c.type === 'string') walk(c, inTry || (node.type === 'TryStatement' && c === node.block));
      }
    }
  })(ast, false);
  return found && guarded;
}

class Reflector {
  constructor(selfModel, model, prompts, sandbox, guard) {
    this.selfModel = selfModel;
    this.model = model;
    this.prompts = prompts;
    this.sandbox = sandbox;
    this.guard = guard;
    // v7.9.7 P8: cross-cycle dedup. Each suggestion is keyed by
    // `${file}::${type}` and a second emission of the same key during
    // this Reflector instance's lifetime is dropped. Pre-fix the same
    // pair filled the daemon log every fifteen minutes for the whole
    // session because suggestOptimizations regenerated from scratch
    // each call.
    this._emittedSuggestions = new Set();
  }

  /**
   * Full diagnostic scan:
   * 1. Kernel integrity
   * 2. Module syntax check
   * 3. Dependency check
   * 4. Require-chain validation
   */
  async diagnose() {
    const issues = [];

    // 1. Kernel integrity
    const kernel = this.guard.verifyIntegrity();
    if (!kernel.ok) {
      for (const k of kernel.issues) {
        issues.push({
          type: 'kernel',
          severity: 'critical',
          file: k.file,
          detail: `Kernel file ${k.issue}: ${k.file}`,
        });
      }
    }

    // 2. Module syntax check — try to require each module
    const modules = this.selfModel.getFullModel().modules;
    for (const [filePath, mod] of Object.entries(modules)) {
      const fullPath = path.join(this.selfModel.rootDir, filePath);
      if (this.guard.isProtected(fullPath)) continue; // Skip kernel files
      // v7.9.19 (Strang D): skip ES modules — the CommonJS syntax check
      // (vm.Script, even wrapped) cannot parse `import`/`export` and would
      // misreport a valid .mjs (e.g. preload.mjs) as a syntax error.
      if (filePath.endsWith('.mjs')) continue;

      try {
        // Syntax check via sandbox
        const code = fs.readFileSync(fullPath, 'utf-8');
        const result = await this.sandbox.syntaxCheck(code);
        if (!result.valid) {
          issues.push({
            type: 'syntax',
            severity: 'high',
            file: filePath,
            detail: result.error,
            code,
          });
        }
      } catch (err) {
        issues.push({
          type: 'read-error',
          severity: 'high',
          file: filePath,
          detail: err.message,
        });
      }
    }

    // 3. Require-chain: check if all requires resolve
    for (const [filePath, mod] of Object.entries(modules)) {
      for (const req of mod.requires || []) {
        if (req.startsWith('.')) {
          // Relative require — check file exists
          const resolvedReq = path.resolve(
            path.dirname(path.join(this.selfModel.rootDir, filePath)),
            req
          );
          const candidates = [resolvedReq, resolvedReq + '.js', resolvedReq + '/index.js'];
          const exists = candidates.some(c => fs.existsSync(c));
          if (!exists) {
            // v7.9.22 Item 6: a try-guarded require with a fallback is not a defect — rank
            // it informational; an unguarded missing require stays HIGH (a boot-crash risk).
            // On no-acorn or a parse failure the severity stays HIGH conservatively.
            let severity = 'high';
            try {
              const { getAcorn } = require('../intelligence/VerificationEngine');
              const acorn = getAcorn();
              if (acorn) {
                const src = fs.readFileSync(path.join(this.selfModel.rootDir, filePath), 'utf-8');
                const ast = acorn.parse(src, { ecmaVersion: 'latest', allowReturnOutsideFunction: true, allowHashBang: true });
                if (_requireIsTryGuarded(ast, req)) severity = 'info';
              }
            } catch { /* read/parse failed — stay HIGH */ }
            issues.push({
              type: 'missing-dependency',
              severity,
              file: filePath,
              detail: `require('${req}') — file not found`,
            });
          }
        }
      }
    }

    return { issues, scannedModules: Object.keys(modules).length };
  }

  /**
   * Attempt to repair detected issues
   */
  async repair(issues) {
    const results = [];

    for (const issue of issues) {
      if (issue.type === 'kernel') {
        // Cannot repair kernel — report only
        results.push({
          file: issue.file,
          fixed: false,
          detail: 'Kernel files cannot be repaired automatically. Manual intervention required.',
        });
        continue;
      }

      if (issue.type === 'syntax') {
        const repaired = await this._repairSyntax(issue);
        results.push(repaired);
        continue;
      }

      if (issue.type === 'missing-dependency') {
        results.push({
          file: issue.file,
          fixed: false,
          detail: `Missing dependency: ${issue.detail}. Module must be created or path corrected.`,
        });
        continue;
      }

      results.push({
        file: issue.file || 'unknown',
        fixed: false,
        detail: `Unknown issue type: ${issue.type}`,
      });
    }

    return results;
  }

  async _repairSyntax(issue) {
    const { file, code, detail } = issue;

    // Ask the model to fix it
    const prompt = this.prompts.build('repair-code', {
      file,
      code,
      issue: detail,
      context: 'Syntax error detected during self-diagnosis',
    });

    try {
      const response = await this.model.chat(prompt, [], 'code');

      // Extract code from response
      const codeMatch = response.match(/```(?:javascript|js)?\n([\s\S]+?)```/);
      if (!codeMatch) {
        return { file, fixed: false, detail: 'Model returned no code block' };
      }

      const fixedCode = codeMatch[1].trim();

      // Syntax-check the fix
      const checkResult = await this.sandbox.syntaxCheck(fixedCode);
      if (!checkResult.valid) {
        return {
          file,
          fixed: false,
          detail: `Repair attempt still has syntax errors: ${checkResult.error}`,
        };
      }

      // Commit snapshot before applying
      await this.selfModel.commitSnapshot(`pre-repair: ${file}`);

      // Apply the fix
      const fullPath = path.join(this.selfModel.rootDir, file);
      this.guard.validateWrite(fullPath);
      // FIX v5.1.0 (N-2): Atomic write — prevents half-written files on crash.
      atomicWriteFileSync(fullPath, fixedCode, 'utf-8');

      await this.selfModel.commitSnapshot(`post-repair: ${file}`);

      return { file, fixed: true, detail: 'Syntax error fixed and git snapshot created' };
    } catch (err) {
      return { file, fixed: false, detail: `Repair failed: ${err.message}` };
    }
  }

  /**
   * Proactive optimization — looks for improvements
   * without explicit issues
   */
  suggestOptimizations() {
    const modules = this.selfModel.getFullModel().modules;
    const suggestions = [];

    for (const [filePath, mod] of Object.entries(modules)) {
      if (this.guard.isProtected(path.join(this.selfModel.rootDir, filePath))) continue;

      // Large modules might benefit from splitting.
      // v7.9.7 P8: raised threshold 300→500. Pre-fix flagged 372 of
      // 377 modules — useful as a measurement, meaningless as a
      // feedback signal because nothing in Genesis can act differently
      // when "almost every module" is flagged.
      const fileInfo = this.selfModel.getFullModel().files[filePath];
      if (fileInfo && fileInfo.lines > 500) {
        const key = `${filePath}::complexity`;
        if (!this._emittedSuggestions.has(key)) {
          this._emittedSuggestions.add(key);
          suggestions.push({
            file: filePath,
            type: 'complexity',
            detail: `${fileInfo.lines} lines — could be split into smaller modules`,
          });
        }
      }

      // Many dependencies might indicate tight coupling.
      // v7.9.7 P8: raised threshold 6→10.
      if (mod.requires && mod.requires.length > 10) {
        const key = `${filePath}::coupling`;
        if (!this._emittedSuggestions.has(key)) {
          this._emittedSuggestions.add(key);
          suggestions.push({
            file: filePath,
            type: 'coupling',
            detail: `${mod.requires.length} dependencies — may be too tightly coupled`,
          });
        }
      }
    }

    return suggestions;
  }
}

module.exports = { Reflector };
