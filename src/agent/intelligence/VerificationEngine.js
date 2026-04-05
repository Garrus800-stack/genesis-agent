// @ts-checked-v5.8
// ============================================================
// GENESIS — VerificationEngine.js (v3.5.0 — Cognitive Agent)
//
// THE FUNDAMENTAL SHIFT: Programmatic truth over LLM opinion.
//
// Every AgentLoop step gets a deterministic verifier that runs
// BEFORE any LLM evaluation. The LLM proposes, the machine
// verifies. Only ambiguous cases fall back to LLM judgment.
//
// Sub-verifiers:
//   CodeVerifier   — AST parse, import resolution, pattern lint
//   TestVerifier   — Exit code, stderr, assertion count
//   ShellVerifier  — Exit code, stderr patterns, timeout
//   FileVerifier   — Existence, non-empty, valid encoding
//   PlanVerifier   — Preconditions against WorldState
//
// Results: PASS | FAIL | AMBIGUOUS (only AMBIGUOUS goes to LLM)
//
// Dependency: acorn (~60KB, zero deps) for AST parsing.
// Install: npm install acorn
// ============================================================

const path = require('path');
const fs = require('fs');
const { NullBus } = require('../core/EventBus');

// Lazy-load acorn to avoid hard crash if not installed
let acorn = null;
let _acornWarned = false;
function getAcorn() {
  if (!acorn) {
    // Path 1: npm-installed acorn
    try { acorn = require('acorn'); return acorn; }
    catch { /* continue to fallback */ }

    // Path 2: Kernel-vendored acorn (FIX v5.1.0 — same fallback as CodeSafetyScanner)
    try {
      const path = require('path');
      acorn = require(path.resolve(__dirname, '../../kernel/vendor/acorn.js'));
      return acorn;
    } catch { /* continue to warn */ }

    if (!_acornWarned) {
      _acornWarned = true;
      console.warn('[VERIFICATION] acorn not installed — CodeVerifier falls back to pattern-only checks. Install: npm install acorn');
    }
  }
  return acorn;
}

// ── Status Constants ──────────────────────────────────────
const PASS = 'pass';
const FAIL = 'fail';
const AMBIGUOUS = 'ambiguous';
const WARN = 'warn';

class VerificationEngine {
  static containerConfig = {
    name: 'verifier',
    phase: 2,
    deps: [],
    tags: ['intelligence', 'verification'],
    lateBindings: [
      { prop: 'worldState', service: 'worldState', optional: true },
    ],
  };

  constructor({ bus, rootDir }) {
    this.bus = bus || NullBus;
    this.rootDir = rootDir;
    this.worldState = null; // late-bound

    // Statistics
    this._stats = { total: 0, pass: 0, fail: 0, ambiguous: 0 };

    // Sub-verifiers
    this._verifiers = {
      code:  new CodeVerifier(rootDir),
      test:  new TestVerifier(),
      shell: new ShellVerifier(),
      file:  new FileVerifier(rootDir),
      plan:  new PlanVerifier(),
    };
  }

  // ════════════════════════════════════════════════════════
  // PUBLIC API
  // ════════════════════════════════════════════════════════

  /**
   * Verify a step result. Returns { status, details, checks }
   *
   * @param {string} type - Step type: 'CODE'|'SANDBOX'|'SHELL'|'ANALYZE'|'SEARCH'|'ASK'
   * @param {object} step - The step definition { type, description, target, ... }
   * @param {object} result - The step result { output, error, exitCode, ... }
   * @returns {{ status: 'pass'|'fail'|'ambiguous', details: object, checks: Array }}
   */
  verify(type, step, result) {
    this._stats.total++;
    const normalizedType = (type || '').toUpperCase();

    let verification;
    try {
      switch (normalizedType) {
        case 'CODE':
        case 'CODE_GENERATE':
          verification = this._verifiers.code.verify(result.output || result.code || '', {
            rootDir: this.rootDir,
            targetFile: step.target,
          });
          break;

        case 'SANDBOX':
          verification = this._verifySandbox(step, result);
          break;

        case 'SHELL':
        case 'SHELL_EXEC':
          verification = this._verifiers.shell.verify(result);
          break;

        case 'WRITE_FILE':
          verification = this._verifiers.file.verify(step.target || step.path, result);
          break;

        case 'RUN_TESTS':
          verification = this._verifiers.test.verify(result);
          break;

        case 'ANALYZE':
        case 'SEARCH':
        case 'ASK':
          // These are inherently subjective — always ambiguous
          verification = {
            status: AMBIGUOUS,
            reason: `Step type "${normalizedType}" requires LLM evaluation`,
            checks: [],
          };
          break;

        default:
          verification = {
            status: AMBIGUOUS,
            reason: `Unknown step type "${normalizedType}"`,
            checks: [],
          };
      }
    } catch (err) {
      verification = {
        status: FAIL,
        reason: `Verification error: ${err.message}`,
        checks: [{ name: 'verifier-internal', passed: false, error: err.message }],
      };
    }

    // Update stats
    this._stats[verification.status] = (this._stats[verification.status] || 0) + 1;

    // Emit
    this.bus.fire('verification:complete', {
      type: normalizedType,
      status: verification.status,
      checks: verification.checks?.length || 0,
    }, { source: 'VerificationEngine' });

    // @ts-ignore — TS strict
    return verification;
  }

  /**
   * Verify plan preconditions against WorldState.
   * @param {Array} steps - Typed plan steps
   * @returns {{ valid: boolean, issues: Array }}
   */
  verifyPlan(steps) {
    if (!this.worldState) {
      // @ts-ignore — TS strict
      return { valid: true, issues: [], note: 'WorldState not available — skipping plan verification' };
    }
    return this._verifiers.plan.verifyPlan(steps, this.worldState);
  }

  /**
   * Quick syntax check for code (no full verification).
   * Useful for PromptBuilder to validate LLM output before using it.
   */
  checkSyntax(code) {
    return this._verifiers.code.checkSyntax(code);
  }

  getStats() { return { ...this._stats }; }

  // ── Internal ────────────────────────────────────────────

  _verifySandbox(step, result) {
    const checks = [];

    // 1. Check if sandbox execution itself failed
    if (result.error && /sandbox.*denied|restricted|blocked/i.test(result.error)) {
      checks.push({ name: 'sandbox-security', passed: true, note: 'Security restriction worked correctly' });
      return { status: FAIL, reason: 'Sandbox blocked the operation (security)', checks };
    }

    // 2. Check exit code if present
    if (result.exitCode !== undefined && result.exitCode !== 0) {
      checks.push({ name: 'exit-code', passed: false, value: result.exitCode });
      return { status: FAIL, reason: `Sandbox exited with code ${result.exitCode}`, checks };
    }

    // 3. If code was involved, verify it
    if (result.code || result.output) {
      const codeCheck = this._verifiers.code.checkSyntax(result.code || result.output);
      checks.push({ name: 'code-syntax', ...codeCheck });
      if (!codeCheck.passed) {
        return { status: FAIL, reason: `Code syntax error: ${codeCheck.error}`, checks };
      }
    }

    // 4. Sandbox output exists and is non-trivial
    if (result.output && result.output.trim().length > 0) {
      checks.push({ name: 'has-output', passed: true });
      return { status: PASS, reason: 'Sandbox executed successfully with output', checks };
    }

    return { status: AMBIGUOUS, reason: 'Sandbox executed but output is unclear', checks };
  }
}

// ════════════════════════════════════════════════════════════
// SUB-VERIFIERS
// ════════════════════════════════════════════════════════════

class CodeVerifier {
  constructor(rootDir) {
    this.rootDir = rootDir;
  }

  /**
   * Full code verification.
   * @param {string} code - JavaScript source code
   * @param {object} context - { rootDir, targetFile }
   * @returns {{ status, reason, checks }}
   */
  verify(code, context = {}) {
    if (!code || typeof code !== 'string' || code.trim().length === 0) {
      return { status: FAIL, reason: 'Empty or missing code', checks: [{ name: 'non-empty', passed: false }] };
    }

    const checks = [];

    // 1. Syntax check (AST parse)
    const syntax = this.checkSyntax(code);
    checks.push({ name: 'syntax', ...syntax });

    // 2. Import resolution
    const imports = this._checkImports(code, context.rootDir || this.rootDir);
    checks.push(...imports.checks);

    // 3. Pattern-based lint
    const lint = this._lintPatterns(code);
    checks.push(...lint.checks);

    // Determine overall status
    // @ts-ignore — TS strict
    const hasFail = checks.some(c => !c.passed && c.severity !== 'warn');
    // @ts-ignore — TS strict
    const hasWarn = checks.some(c => c.severity === 'warn');

    if (hasFail) {
      // @ts-ignore — TS strict
      const failedCheck = checks.find(c => !c.passed && c.severity !== 'warn');
      // @ts-ignore — TS strict
      return { status: FAIL, reason: failedCheck.error || 'Code verification failed', checks };
    }

    return {
      status: hasWarn ? PASS : PASS, // Warnings don't block
      reason: hasWarn ? 'Code valid with warnings' : 'Code verified',
      checks,
      // @ts-ignore — TS strict
      warnings: checks.filter(c => c.severity === 'warn'),
    };
  }

  checkSyntax(code) {
    const parser = getAcorn();
    if (!parser) {
      return { passed: true, note: 'acorn not installed — syntax check skipped' };
    }

    try {
      parser.parse(code, {
        ecmaVersion: 2022,
        sourceType: 'module',
        allowReturnOutsideFunction: true,
        allowImportExportEverywhere: true,
      });
      return { passed: true };
    } catch (err) {
      return {
        passed: false,
        error: err.message,
        line: err.loc?.line || null,
        column: err.loc?.column || null,
      };
    }
  }

  _checkImports(code, rootDir) {
    const checks = [];
    // Match require('...') and require("...")
    const requirePattern = /require\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
    let match;
    const seen = new Set();

    while ((match = requirePattern.exec(code)) !== null) {
      const modulePath = match[1];
      if (seen.has(modulePath)) continue;
      seen.add(modulePath);

      // Skip Node.js built-ins
      if (this._isBuiltin(modulePath)) {
        checks.push({ name: `import:${modulePath}`, passed: true, note: 'Node.js built-in' });
        continue;
      }

      // Check relative requires
      if (modulePath.startsWith('.')) {
        const resolved = this._resolveRelative(modulePath, rootDir);
        checks.push({
          name: `import:${modulePath}`,
          passed: resolved.exists,
          error: resolved.exists ? undefined : `Module not found: ${modulePath}`,
          resolvedPath: resolved.path,
        });
      } else {
        // npm package — check node_modules
        const pkgName = modulePath.startsWith('@')
          ? modulePath.split('/').slice(0, 2).join('/')
          : modulePath.split('/')[0];

        const pkgPath = path.join(rootDir, 'node_modules', pkgName);
        const exists = fs.existsSync(pkgPath);
        checks.push({
          name: `import:${pkgName}`,
          passed: exists,
          error: exists ? undefined : `Package not installed: ${pkgName}`,
          severity: exists ? undefined : 'warn', // Missing npm package is a warning, not a hard fail
        });
      }
    }

    return { checks };
  }

  _resolveRelative(modulePath, rootDir) {
    const candidates = [
      path.resolve(rootDir, 'src', 'agent', modulePath),
      path.resolve(rootDir, 'src', 'agent', modulePath + '.js'),
      path.resolve(rootDir, 'src', 'agent', modulePath, 'index.js'),
      path.resolve(rootDir, modulePath),
      path.resolve(rootDir, modulePath + '.js'),
    ];

    for (const candidate of candidates) {
      if (fs.existsSync(candidate)) {
        return { exists: true, path: candidate };
      }
    }

    return { exists: false, path: candidates[0] };
  }

  _isBuiltin(moduleName) {
    const builtins = new Set([
      'assert', 'buffer', 'child_process', 'cluster', 'console', 'constants',
      'crypto', 'dgram', 'dns', 'domain', 'events', 'fs', 'http', 'http2',
      'https', 'module', 'net', 'os', 'path', 'perf_hooks', 'process',
      'punycode', 'querystring', 'readline', 'repl', 'stream', 'string_decoder',
      'sys', 'timers', 'tls', 'tty', 'url', 'util', 'v8', 'vm', 'worker_threads', 'zlib',
      'node:fs', 'node:path', 'node:child_process', 'node:crypto', 'node:os',
      'node:util', 'node:events', 'node:stream', 'node:http', 'node:https',
      'node:url', 'node:net', 'node:worker_threads', 'node:buffer',
    ]);
    return builtins.has(moduleName) || moduleName.startsWith('node:');
  }

  _lintPatterns(code) {
    const checks = [];

    // Async function without await
    const asyncFns = code.match(/async\s+(?:function\s+\w+|\w+)\s*\([^)]*\)\s*\{/g) || [];
    for (const fn of asyncFns) {
      const fnName = fn.match(/(?:function\s+)?(\w+)\s*\(/)?.[1] || 'anonymous';
      // Very rough heuristic — check if 'await' appears within ~500 chars
      const fnIndex = code.indexOf(fn);
      const fnSlice = code.slice(fnIndex, fnIndex + 500);
      if (!fnSlice.includes('await')) {
        checks.push({
          name: `lint:async-no-await:${fnName}`,
          passed: true, // Don't fail on this
          severity: 'warn',
          note: `Async function "${fnName}" may not use await`,
        });
      }
    }

    // console.log in production code (warn only)
    const consoleLogs = (code.match(/console\.log\(/g) || []).length;
    if (consoleLogs > 5) {
      checks.push({
        name: 'lint:excessive-console-log',
        passed: true,
        severity: 'warn',
        note: `${consoleLogs} console.log calls found`,
      });
    }

    // Unreachable code after return (simple pattern)
    if (/return\s+[^;]+;\s*\n\s*[a-zA-Z]/.test(code)) {
      checks.push({
        name: 'lint:possible-unreachable',
        passed: true,
        severity: 'warn',
        note: 'Possible unreachable code after return',
      });
    }

    // Empty catch blocks
    const emptyCatch = (code.match(/catch\s*\([^)]*\)\s*\{\s*\}/g) || []).length;
    if (emptyCatch > 0) {
      checks.push({
        name: 'lint:empty-catch',
        passed: true,
        severity: 'warn',
        note: `${emptyCatch} empty catch block(s)`,
      });
    }

    return { checks };
  }
}

class TestVerifier {
  verify(result) {
    const checks = [];
    const output = result.output || result.stdout || '';
    const stderr = result.stderr || '';
    const exitCode = result.exitCode ?? (result.error ? 1 : 0);

    // 1. Exit code
    checks.push({
      name: 'exit-code',
      passed: exitCode === 0,
      value: exitCode,
    });

    // 2. Parse test output for pass/fail counts
    const passMatch = output.match(/(\d+)\s+(?:passing|passed|tests?\s+passed|✓)/i);
    const failMatch = output.match(/(\d+)\s+(?:failing|failed|tests?\s+failed|✗)/i);

    const passed = passMatch ? parseInt(passMatch[1], 10) : null;
    const failed = failMatch ? parseInt(failMatch[1], 10) : null;

    if (passed !== null) {
      checks.push({ name: 'tests-passed', passed: true, count: passed });
    }
    if (failed !== null) {
      checks.push({ name: 'tests-failed', passed: failed === 0, count: failed });
    }

    // 3. Check for common error patterns in stderr
    const errorPatterns = [
      { pattern: /AssertionError/i, name: 'assertion-error' },
      { pattern: /TypeError/i, name: 'type-error' },
      { pattern: /ReferenceError/i, name: 'reference-error' },
      { pattern: /SyntaxError/i, name: 'syntax-error' },
      { pattern: /ENOENT/i, name: 'file-not-found' },
      { pattern: /MODULE_NOT_FOUND/i, name: 'module-not-found' },
      { pattern: /Cannot find module/i, name: 'module-not-found' },
    ];

    for (const { pattern, name } of errorPatterns) {
      if (pattern.test(stderr) || pattern.test(output)) {
        checks.push({ name: `error:${name}`, passed: false });
      }
    }

    // Determine status
    const hasFail = checks.some(c => !c.passed);
    if (hasFail) {
      const reason = failed ? `${failed} test(s) failed` : 'Test execution failed';
      return { status: FAIL, reason, checks };
    }

    if (passed === null && exitCode === 0) {
      return { status: AMBIGUOUS, reason: 'Tests exited 0 but no pass/fail count found', checks };
    }

    return { status: PASS, reason: `${passed || 'All'} tests passed`, checks };
  }
}

class ShellVerifier {
  verify(result) {
    const checks = [];
    const exitCode = result.exitCode ?? (result.error ? 1 : 0);
    const stderr = result.stderr || '';
    const stdout = result.output || result.stdout || '';

    // 1. Exit code
    checks.push({
      name: 'exit-code',
      passed: exitCode === 0,
      value: exitCode,
    });

    // 2. Timeout detection
    if (result.timedOut || /ETIMEDOUT|timed?\s*out/i.test(stderr)) {
      checks.push({ name: 'timeout', passed: false });
      return { status: FAIL, reason: 'Command timed out', checks };
    }

    // 3. Permission denied
    if (/EACCES|permission denied|access denied/i.test(stderr)) {
      checks.push({ name: 'permission', passed: false });
      return { status: FAIL, reason: 'Permission denied', checks };
    }

    // 4. Command not found
    if (exitCode === 127 || /command not found|not recognized/i.test(stderr)) {
      checks.push({ name: 'command-exists', passed: false });
      return { status: FAIL, reason: 'Command not found', checks };
    }

    // 5. Stderr warnings (not failures)
    if (stderr.trim().length > 0 && exitCode === 0) {
      checks.push({
        name: 'stderr-warnings',
        passed: true,
        severity: 'warn',
        note: `stderr: ${stderr.slice(0, 200)}`,
      });
    }

    // 6. Has output?
    if (stdout.trim().length > 0) {
      checks.push({ name: 'has-output', passed: true });
    }

    const hasFail = checks.some(c => !c.passed);
    if (hasFail) {
      return { status: FAIL, reason: `Shell command failed (exit ${exitCode})`, checks };
    }

    return { status: PASS, reason: `Command succeeded (exit ${exitCode})`, checks };
  }
}

class FileVerifier {
  constructor(rootDir) {
    this.rootDir = rootDir;
  }

  verify(targetPath, result) {
    const checks = [];

    if (!targetPath) {
      return { status: FAIL, reason: 'No target file path specified', checks: [{ name: 'path-specified', passed: false }] };
    }

    const fullPath = path.isAbsolute(targetPath)
      ? targetPath
      : path.resolve(this.rootDir, targetPath);

    // 1. File exists
    const exists = fs.existsSync(fullPath);
    checks.push({ name: 'exists', passed: exists });
    if (!exists) {
      return { status: FAIL, reason: `File does not exist: ${targetPath}`, checks };
    }

    // 2. Non-empty
    const stat = fs.statSync(fullPath);
    checks.push({ name: 'non-empty', passed: stat.size > 0, size: stat.size });
    if (stat.size === 0) {
      return { status: FAIL, reason: `File is empty: ${targetPath}`, checks };
    }

    // 3. Readable (valid UTF-8 for text files)
    if (this._isTextFile(targetPath)) {
      try {
        const content = fs.readFileSync(fullPath, 'utf-8');
        checks.push({ name: 'readable', passed: true, chars: content.length });

        // 4. If it's JS, check syntax
        if (targetPath.endsWith('.js')) {
          const parser = getAcorn();
          if (parser) {
            try {
              parser.parse(content, {
                ecmaVersion: 2022, sourceType: 'module',
                allowReturnOutsideFunction: true,
              });
              checks.push({ name: 'js-syntax', passed: true });
            } catch (err) {
              checks.push({ name: 'js-syntax', passed: false, error: err.message });
              return { status: FAIL, reason: `JS syntax error in ${targetPath}: ${err.message}`, checks };
            }
          }
        }

        // 5. JSON validation for .json files
        if (targetPath.endsWith('.json')) {
          try {
            JSON.parse(content);
            checks.push({ name: 'json-valid', passed: true });
          } catch (err) {
            checks.push({ name: 'json-valid', passed: false, error: err.message });
            return { status: FAIL, reason: `Invalid JSON in ${targetPath}: ${err.message}`, checks };
          }
        }
      } catch (err) {
        checks.push({ name: 'readable', passed: false, error: err.message });
        return { status: FAIL, reason: `File not readable: ${err.message}`, checks };
      }
    }

    return { status: PASS, reason: `File verified: ${targetPath} (${stat.size} bytes)`, checks };
  }

  _isTextFile(filePath) {
    const textExtensions = new Set([
      '.js', '.mjs', '.cjs', '.ts', '.json', '.md', '.txt', '.html',
      '.css', '.xml', '.yaml', '.yml', '.toml', '.ini', '.cfg',
      '.sh', '.bat', '.cmd', '.ps1', '.env', '.gitignore',
    ]);
    return textExtensions.has(path.extname(filePath).toLowerCase());
  }
}

class PlanVerifier {
  /**
   * Verify plan steps against WorldState.
   * @param {Array} steps - Typed plan steps with preconditions
   * @param {object} worldState - WorldState instance
   * @returns {{ valid: boolean, issues: Array }}
   */
  verifyPlan(steps, worldState) {
    const issues = [];

    for (let i = 0; i < steps.length; i++) {
      const step = steps[i];
      const stepIssues = [];

      // Check file write preconditions
      if (step.type === 'WRITE_FILE' && step.target) {
        if (!worldState.canWriteFile(step.target)) {
          stepIssues.push(`Cannot write to ${step.target} (kernel file or outside project)`);
        }
      }

      // Check shell preconditions
      if (step.type === 'SHELL_EXEC' && step.command) {
        if (!worldState.canRunShell(step.command)) {
          stepIssues.push(`Shell command blocked: ${step.command}`);
        }
      }

      // Check test preconditions
      if (step.type === 'RUN_TESTS') {
        if (!worldState.canRunTests()) {
          stepIssues.push('No test script found in package.json');
        }
      }

      // Check model availability
      if ((step.type === 'CODE_GENERATE' || step.type === 'ANALYZE') && step.model) {
        if (!worldState.canUseModel(step.model)) {
          stepIssues.push(`Model not available: ${step.model}`);
        }
      }

      if (stepIssues.length > 0) {
        issues.push({
          stepIndex: i,
          description: step.description,
          issues: stepIssues,
        });
      }
    }

    return {
      valid: issues.length === 0,
      issues,
      // @ts-ignore — TS strict
      totalIssues: issues.reduce((sum, i) => sum + i.issues.length, 0),
    };
  }
}

module.exports = {
  VerificationEngine,
  CodeVerifier,
  TestVerifier,
  ShellVerifier,
  FileVerifier,
  PlanVerifier,
  PASS, FAIL, AMBIGUOUS, WARN,
};
