// ============================================================
// GENESIS AGENT — Reflector.js
// Self-analysis and self-repair loop.
// OBSERVE → ANALYZE → PLAN → TEST → APPLY → VERIFY
// ============================================================

const fs = require('fs');
const path = require('path');
const { atomicWriteFileSync } = require('../core/utils');

class Reflector {
  constructor(selfModel, model, prompts, sandbox, guard) {
    this.selfModel = selfModel;
    this.model = model;
    this.prompts = prompts;
    this.sandbox = sandbox;
    this.guard = guard;
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
            issues.push({
              type: 'missing-dependency',
              severity: 'high',
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

      // Large modules might benefit from splitting
      const fileInfo = this.selfModel.getFullModel().files[filePath];
      if (fileInfo && fileInfo.lines > 300) {
        suggestions.push({
          file: filePath,
          type: 'complexity',
          detail: `${fileInfo.lines} lines — could be split into smaller modules`,
        });
      }

      // Many dependencies might indicate tight coupling
      if (mod.requires && mod.requires.length > 6) {
        suggestions.push({
          file: filePath,
          type: 'coupling',
          detail: `${mod.requires.length} dependencies — may be too tightly coupled`,
        });
      }
    }

    return suggestions;
  }
}

module.exports = { Reflector };
