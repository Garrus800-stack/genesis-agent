// @ts-checked-v5.8
// ============================================================
// GENESIS — HTNPlanner.js (v3.5.0 — Plan Validation & Costing)
//
// Enhances GoalStack's raw LLM-decomposed plans with:
// 1. Pre-execution validation — checks feasibility of each step
//    before any code runs (file exists? sandbox passes? safe?)
// 2. Cost estimation — estimates LLM calls, tokens, and time
//    based on step types and historical data from EventStore
// 3. Dry-run mode — shows user what a plan would do before committing
//
// Sits between GoalStack._decompose() and AgentLoop execution.
// Does NOT replace GoalStack — it augments it.
// ============================================================

const fs = require('fs');
const path = require('path');
const { NullBus } = require('../core/EventBus');
const { createLogger } = require('../core/Logger');
const { VALID_STEP_TYPES, normalizeStepType } = require('./step-types');
const _log = createLogger('HTNPlanner');

class HTNPlanner {
  // NOTE: containerConfig is informational only — registered via phase manifest.
  /** @param {{ bus?: *, sandbox?: *, selfModel?: *, guard?: *, eventStore?: *, storage?: *, rootDir?: string }} [deps] */
  constructor({ bus, sandbox, selfModel, guard, eventStore, storage, rootDir } = {}) {
    this.bus = bus || NullBus;
    this.sandbox = sandbox || null;
    this.selfModel = selfModel || null;
    this.guard = guard || null;
    this.eventStore = eventStore || null;
    this.storage = storage || null;
    this.rootDir = rootDir || '.';

    // ── Historical Cost Data ──────────────────────────
    this._costHistory = this._loadCostHistory();

    // Default cost estimates per step type (fallback when no history)
    this._defaultCosts = {
      ANALYZE:  { llmCalls: 1, estimatedTokens: 2000, estimatedMs: 5000 },
      CODE:     { llmCalls: 2, estimatedTokens: 4000, estimatedMs: 12000 },
      SANDBOX:  { llmCalls: 1, estimatedTokens: 1500, estimatedMs: 3000 },
      SHELL:    { llmCalls: 1, estimatedTokens: 1000, estimatedMs: 8000 },
      SEARCH:   { llmCalls: 1, estimatedTokens: 1500, estimatedMs: 4000 },
      ASK:      { llmCalls: 0, estimatedTokens: 0,    estimatedMs: 60000 },
      DELEGATE: { llmCalls: 1, estimatedTokens: 2000, estimatedMs: 30000 },
    };
  }

  // ════════════════════════════════════════════════════════
  // 1. PLAN VALIDATION
  // ════════════════════════════════════════════════════════

  /**
   * Validate a plan before execution.
   * Returns detailed report per step with issues and warnings.
   *
   * @param {Array} steps - GoalStack step objects [{type, action, target?, detail?}]
   * @param {object} context - { goalDescription, rootDir }
   * @returns {Promise<*>}
   */
  async validatePlan(steps, context = {}) {
    const results = [];
    let hasBlocker = false;

    for (let i = 0; i < steps.length; i++) {
      const step = steps[i];
      const result = await this._validateStep(step, i, context);
      results.push(result);
      if (result.issues.length > 0) hasBlocker = true;
    }

    // Cross-step validation
    const crossIssues = this._crossValidate(steps, results);

    const totalIssues = results.reduce((s, r) => s + r.issues.length, 0) + crossIssues.length;
    const totalWarnings = results.reduce((s, r) => s + r.warnings.length, 0);

    const summary = {
      valid: !hasBlocker && crossIssues.length === 0,
      totalSteps: steps.length,
      totalIssues,
      totalWarnings,
      crossIssues,
    };

    this.bus.emit('htn:plan-validated', summary, { source: 'HTNPlanner' });

    return { ...summary, steps: results };
  }

  async _validateStep(step, index, context) {
    const issues = [];   // Blockers — plan should not proceed
    const warnings = []; // Advisories — proceed with caution
    const type = (step.type || '').toUpperCase();

    // ── Type-specific validation ─────────────────────

    if (type === 'CODE') {
      // Check if target file path is provided
      if (step.target) {
        const fullPath = path.resolve(this.rootDir, step.target);

        // Path traversal check
        if (!fullPath.startsWith(this.rootDir + path.sep) && fullPath !== this.rootDir) {
          issues.push(`Path traversal blocked: ${step.target}`);
        }

        // Check if parent directory exists
        const dir = path.dirname(fullPath);
        if (!fs.existsSync(dir)) {
          warnings.push(`Directory does not exist (will be created): ${path.relative(this.rootDir, dir)}`);
        }

        // Check if file is kernel-protected
        if (this.guard && this.guard.isProtected(fullPath)) {
          issues.push(`Kernel-protected file: ${step.target}`);
        }

        // Check if file exists (for modify vs create distinction)
        if (fs.existsSync(fullPath)) {
          warnings.push(`File already exists — will be overwritten: ${step.target}`);
        }
      } else {
        warnings.push('CODE step without target file — AgentLoop must choose file');
      }

      // If step has code preview, syntax-check it
      if (step.detail && this.sandbox) {
        try {
          const check = await this.sandbox.syntaxCheck(step.detail);
          if (!check.valid) {
            issues.push(`Syntax error in code draft: ${check.error}`);
          }
        } catch (err) {
          warnings.push(`Sandbox check failed: ${err.message}`);
        }
      }
    }

    else if (type === 'SHELL') {
      const cmd = step.target || step.action || '';

      // Dangerous command patterns
      const dangerous = [
        { pattern: /\brm\s+-rf?\s+[/~]/, msg: 'Recursive deletion of system directories' },
        { pattern: /\bformat\b|\bmkfs\b/, msg: 'Filesystem formatting' },
        { pattern: />\s*\/dev\//, msg: 'Writing to device files' },
        { pattern: /\bcurl\b.*\|\s*(?:bash|sh)\b/, msg: 'Piping URL directly into shell' },
        { pattern: /\bchmod\s+777\b/, msg: 'Insecure permissions (777)' },
      ];

      for (const { pattern, msg } of dangerous) {
        if (pattern.test(cmd)) {
          issues.push(`Dangerous shell command: ${msg}`);
        }
      }

      // Check if command tool exists (basic check)
      const firstWord = cmd.split(/\s+/)[0];
      if (firstWord && !['npm', 'node', 'git', 'echo', 'cat', 'ls', 'mkdir', 'cp', 'mv', 'cd', 'pwd'].includes(firstWord)) {
        warnings.push(`Shell command '${firstWord}' — availability not verified`);
      }
    }

    else if (type === 'SEARCH') {
      if (!step.action && !step.target) {
        warnings.push('SEARCH step without query — will be generic');
      }
    }

    else if (type === 'ANALYZE' || type === 'think') {
      // These are always valid — they just need an LLM call
    }

    else if (type === 'DELEGATE') {
      warnings.push('DELEGATE step requires reachable peers');
    }

    else if (!type) {
      issues.push('Step without type');
    }

    // v7.3.5: Catch-all for LLM-invented step types (GIT_SNAPSHOT, WRITE_FILE,
    // CODE_GENERATE were the observed failures). If the type is not in the
    // canonical set and has no alias, mark as an issue so dryRun returns
    // invalid — AgentLoopSteps will normalize via step-types.js before
    // dispatch but having HTN flag the plan up-front means cost estimates
    // and approval gates see the problem too.
    else if (!VALID_STEP_TYPES.has(type)) {
      const alias = normalizeStepType(type);
      if (alias) {
        warnings.push(`Non-canonical step type "${type}" — will be normalized to ${alias}`);
      } else {
        issues.push(`Unknown step type "${type}" — not in {${[...VALID_STEP_TYPES].join(', ')}}`);
      }
    }

    return { stepIndex: index, type, action: step.action, issues, warnings };
  }

  /**
   * Cross-step validation: checks dependencies between steps.
   */
  _crossValidate(steps, results) {
    const issues = [];

    // Check: CODE step references a file that a later CODE step also modifies
    const codeTargets = steps
      .filter(s => (s.type || '').toUpperCase() === 'CODE' && s.target)
      .map((s, i) => ({ target: s.target, index: i }));

    const seen = new Map();
    for (const { target, index } of codeTargets) {
      if (seen.has(target)) {
        issues.push(`Duplicate file modification: '${target}' in step ${seen.get(target)} and ${index}`);
      }
      seen.set(target, index);
    }

    // Check: SHELL step before any CODE step it might depend on
    // (e.g., npm install before code that requires the package)
    // This is a heuristic — deep analysis would need LLM

    // Check: Plan starts with ANALYZE/think (good practice)
    if (steps.length > 0 && !['ANALYZE', 'think'].includes((steps[0].type || '').toUpperCase())) {
      // Not an issue, just a note
    }

    return issues;
  }

  // ════════════════════════════════════════════════════════
  // 2. COST ESTIMATION
  // ════════════════════════════════════════════════════════

  /**
   * Estimate the cost of executing a plan.
   *
   * @param {Array} steps - GoalStack steps
   * @returns {object} { totalLLMCalls, totalTokens, estimatedDurationMs, perStep[] }
   */
  estimateCost(steps) {
    const perStep = [];
    let totalLLMCalls = 0;
    let totalTokens = 0;
    let totalMs = 0;

    for (let i = 0; i < steps.length; i++) {
      const step = steps[i];
      const type = (step.type || 'ANALYZE').toUpperCase();

      // Use historical data if available, otherwise defaults
      const historicalCost = this._getHistoricalCost(type);
      const cost = historicalCost || this._defaultCosts[type] || this._defaultCosts.ANALYZE;

      perStep.push({
        stepIndex: i,
        type,
        action: (step.action || '').substring(0, 60),
        ...cost,
      });

      totalLLMCalls += cost.llmCalls;
      totalTokens += cost.estimatedTokens;
      totalMs += cost.estimatedMs;
    }

    // Add overhead for planning + reflection passes
    const planningOverhead = {
      llmCalls: 2,                        // Initial decomposition + final reflection
      estimatedTokens: 3000,
      estimatedMs: 8000,
    };
    totalLLMCalls += planningOverhead.llmCalls;
    totalTokens += planningOverhead.estimatedTokens;
    totalMs += planningOverhead.estimatedMs;

    const result = {
      totalSteps: steps.length,
      totalLLMCalls,
      totalTokensEstimated: totalTokens,
      estimatedDurationMs: totalMs,
      estimatedDurationHuman: this._humanDuration(totalMs),
      planningOverhead,
      perStep,
      confidence: this._costHistory.sampleCount > 10 ? 'high' : 'low',
    };

    this.bus.emit('htn:cost-estimated', {
      steps: steps.length,
      llmCalls: totalLLMCalls,
      tokens: totalTokens,
      durationMs: totalMs,
    }, { source: 'HTNPlanner' });

    return result;
  }

  /**
   * Get historical average cost for a step type.
   * Mined from EventStore data.
   */
  _getHistoricalCost(type) {
    const history = this._costHistory.byType[type];
    if (!history || history.count < 3) return null;

    return {
      llmCalls: Math.round(history.avgLLMCalls),
      estimatedTokens: Math.round(history.avgTokens),
      estimatedMs: Math.round(history.avgMs),
    };
  }

  /**
   * Record actual execution cost (called by AgentLoop after each step).
   * Feeds the historical cost model.
   */
  recordActualCost(type, actualCost) {
    type = (type || 'ANALYZE').toUpperCase();

    if (!this._costHistory.byType[type]) {
      this._costHistory.byType[type] = { count: 0, avgLLMCalls: 0, avgTokens: 0, avgMs: 0 };
    }

    const h = this._costHistory.byType[type];
    const n = h.count;
    // Running average
    h.avgLLMCalls = (h.avgLLMCalls * n + (actualCost.llmCalls || 0)) / (n + 1);
    h.avgTokens = (h.avgTokens * n + (actualCost.tokens || 0)) / (n + 1);
    h.avgMs = (h.avgMs * n + (actualCost.durationMs || 0)) / (n + 1);
    h.count++;

    this._costHistory.sampleCount++;
    this._costHistory.lastUpdated = Date.now();

    // Persist periodically (every 10 recordings)
    if (this._costHistory.sampleCount % 10 === 0) {
      this._saveCostHistory();
    }
  }

  // ════════════════════════════════════════════════════════
  // 3. DRY RUN
  // ════════════════════════════════════════════════════════

  /**
   * Generate a dry-run report: validation + cost + summary.
   * Shows the user exactly what would happen before committing.
   */
  async dryRun(steps, context = {}) {
    const validation = await this.validatePlan(steps, context);
    const cost = this.estimateCost(steps);

    const report = {
      valid: validation.valid,
      validation,
      cost,
      summary: this._generateDryRunSummary(steps, validation, cost),
    };

    this.bus.emit('htn:dry-run', {
      valid: report.valid,
      steps: steps.length,
      issues: validation.totalIssues,
      estimatedDuration: cost.estimatedDurationHuman,
    }, { source: 'HTNPlanner' });

    return report;
  }

  _generateDryRunSummary(steps, validation, cost) {
    const lines = [];
    lines.push(`Plan: ${steps.length} steps`);
    lines.push(`Geschaetzte Dauer: ${cost.estimatedDurationHuman}`);
    lines.push(`LLM-Aufrufe: ~${cost.totalLLMCalls}`);
    lines.push(`Tokens: ~${cost.totalTokensEstimated.toLocaleString()}`);

    if (validation.totalIssues > 0) {
      lines.push(`\n⚠ ${validation.totalIssues} blockers:`);
      for (const step of validation.steps) {
        for (const issue of step.issues) {
          lines.push(`  Step ${step.stepIndex} (${step.type}): ${issue}`);
        }
      }
    }

    if (validation.totalWarnings > 0) {
      lines.push(`\n${validation.totalWarnings} Hinweise:`);
      for (const step of validation.steps) {
        for (const warning of step.warnings) {
          lines.push(`  Step ${step.stepIndex}: ${warning}`);
        }
      }
    }

    if (validation.crossIssues.length > 0) {
      lines.push('\nPlan-weite Probleme:');
      for (const issue of validation.crossIssues) {
        lines.push(`  ${issue}`);
      }
    }

    return lines.join('\n');
  }

  // ── Persistence ─────────────────────────────────────────

  _loadCostHistory() {
    const defaults = { byType: {}, sampleCount: 0, lastUpdated: null };
    if (!this.storage) return defaults;
    try {
      return this.storage.readJSON('htn-cost-history.json', defaults);
    } catch (_e) { _log.debug('[catch] return this.storage.readJSONht:', _e.message); return defaults; }
  }

  _saveCostHistory() {
    if (!this.storage) return;
    try {
      // v3.7.1: Non-blocking write
      this.storage.writeJSONAsync('htn-cost-history.json', this._costHistory)
        .catch(err => _log.debug('[HTN] Cost history save failed:', err.message));
    } catch (err) {
      _log.debug('[HTN] Cost history save failed:', err.message);
    }
  }

  _humanDuration(ms) {
    if (ms < 1000) return `${ms}ms`;
    if (ms < 60000) return `~${Math.round(ms / 1000)}s`;
    const mins = Math.floor(ms / 60000);
    const secs = Math.round((ms % 60000) / 1000);
    return `~${mins}m ${secs}s`;
  }
}

module.exports = { HTNPlanner };
