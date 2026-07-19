// @ts-checked-v5.8
// ============================================================
// GENESIS — VerificationEngine.js
// Programmatic truth over LLM opinion. Sub-verifiers: Code,
// Test, Shell, File, Plan. Results: PASS | FAIL | AMBIGUOUS.
// ============================================================

const path = require('path');
const fs = require('fs');
const { NullBus } = require('../core/EventBus');

const { getAcorn, PASS, FAIL, AMBIGUOUS, WARN, CodeVerifier, TestVerifier, ShellVerifier, FileVerifier, PlanVerifier } = require('./VerificationEngineVerifiers'); // v7.9.29 (hygiene #6)

class VerificationEngine {
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
   * @returns {{ status: string, details?: object, checks?: Array<*>, reason?: string }}
   */
  verify(type, step, result) {
    this._stats.total++;

    // v7.9.7 P10: pre-execution skip. When the step never actually
    // executed (e.g. P5's simulation hard-gate returns {success:false,
    // error: 'High simulation risk ...'} before the executor sees the
    // step), the result has an error string and no output/code/exitCode.
    // Pre-fix the verifier ran every check against the abort message,
    // marked every step FAIL, and the cumulative pass-rate dragged
    // from 11% → 8% → 0% as more goals hit the gate. SHELL still
    // carries exitCode so SHELL failures route normally; WRITE_FILE
    // still hits its file-existence verifier.
    const looksUnexecuted =
      result
      && typeof result.error === 'string'
      && result.error.length > 0
      && !result.output
      && !result.code
      && (result.exitCode === undefined || result.exitCode === null)
      && !/timeout/i.test(result.error);
    if (looksUnexecuted) {
      this._stats.ambiguous = (this._stats.ambiguous || 0) + 1;
      return {
        status: AMBIGUOUS,
        reason: `Step did not execute (pre-execution abort): ${(result.error || '').slice(0, 120)}`,
        checks: [],
      };
    }

    // v7.9.7 P10: route through normalizeStepType so the wider alias
    // set (REFACTOR, IMPLEMENT, FIX, UPDATE, PATCH, ...) reaches
    // CodeVerifier instead of falling to the default-AMBIGUOUS branch.
    // Explicit pre-check preserves WRITE_FILE → FileVerifier (intent
    // is file-existence, not code-content, so the alias mapping that
    // flattens it to CODE shouldn't change the verifier branch).
    const rawType = (type || '').toUpperCase();
    let normalizedType = rawType;
    if (rawType !== 'WRITE_FILE') {
      try {
        const { normalizeStepType } = require('../core/step-types');
        const n = normalizeStepType(rawType);
        if (n) normalizedType = n;
      } catch (_e) { /* fall through with rawType */ }
    }

    let verification;
    try {
      switch (normalizedType) {
        case 'CODE':
        case 'CODE_GENERATE':
          // v7.9.41 (D1/K1): prefer the CODE over the prose output — parsing the
          // neutral "Code written: …" sentence killed every successful step of
          // the whole alias family (CODE/REFACTOR/IMPLEMENT/FIX/UPDATE/PATCH).
          // v7.9.42 A2: a CODE step that produced NO code payload and whose
          // textual output does not look like code (field: "Allowed ...")
          // must not be syntax-parsed to death — accept as AMBIGUOUS text.
          const _codePayload = result.code || result.output || '';
          if (!result.code && _codePayload && !/[;{}]|=>|\bfunction\b|\bconst\b|\brequire\s*\(/.test(_codePayload)) {
            verification = { status: AMBIGUOUS, reason: 'no code payload — textual output accepted without syntax parse (v7.9.42 A2)' };
            break;
          }
          verification = this._verifiers.code.verify(_codePayload, {
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
          // ANALYZE/SEARCH/ASK are inherently content-producing or user-driven
          // steps with no deterministic verifier. v7.9.9 Fix 2 tried to FAIL
          // empty output here but field-test showed verification-pass-rate
          // dropped to 2% — the empty-detection was too aggressive (matched
          // structured outputs the verifier didn't recognize as content).
          // Returning AMBIGUOUS lets the LLM-driven goal-completion evaluator
          // judge the actual content against the goal; the per-pursuit
          // recovery path handles real failures via FailureTaxonomy.
          verification = {
            status: AMBIGUOUS,
            reason: `Step type "${normalizedType}" requires LLM evaluation`,
            checks: [],
          };
          break;

        case 'DELEGATE':
          // Colony delegation — content evaluation deferred to LLM goal-check.
          // Same reasoning as ANALYZE/SEARCH above.
          verification = {
            status: AMBIGUOUS,
            reason: 'DELEGATE result requires LLM evaluation against goal',
            checks: [],
          };
          break;

        default:
          // v7.9.9 Fix 2: unknown step-type emits telemetry so the catalog
          // mismatch is visible in the dashboard rather than silently AMBIGUOUS.
          try {
            this.bus?.fire?.('verification:unknown-step-type', {
              stepType: normalizedType,
              stepDescription: (step?.description || '').slice(0, 120),
            }, { source: 'VerificationEngine' });
          } catch (_e) { /* never let telemetry break the verifier */ }
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

    return verification;
  }

  /**
   * Verify plan preconditions against WorldState.
   * @param {Array} steps - Typed plan steps
   * @returns {{ valid: boolean, issues: Array<*>, note?: string, totalIssues?: number }}
   */
  verifyPlan(steps) {
    if (!this.worldState) {
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
    /** @type {Array<*>} */ const checks = [];

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
module.exports = {
  getAcorn,   // v7.9.22 Item 6: Reflector uses it to rank guarded missing-deps
  VerificationEngine,
  CodeVerifier,
  TestVerifier,
  ShellVerifier,
  FileVerifier,
  PlanVerifier,
  PASS, FAIL, AMBIGUOUS, WARN,
};
