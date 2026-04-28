// @ts-checked-v5.8
// ============================================================
// GENESIS AGENT — FailureAnalyzer.js
// Phase 9: Cognitive CI — Self-Healing Pipeline
//
// The first AI agent module that understands its own CI.
// Parses test/CI failure logs, classifies root causes,
// and generates repair strategies.
//
// Architecture:
//   CI Log → Parser → Classifier → Strategy → RepairPlan
//
// Failure categories:
//   CROSS_PLATFORM  — Unix paths on Windows, shell differences
//   ASYNC_TIMING    — Race conditions, unresolved promises
//   DEPENDENCY      — npm audit, version conflicts
//   REGRESSION      — New code breaks existing tests
//   COVERAGE_GAP    — Mutation survives, no test catches it
//   SYNTAX          — Parse errors, missing semicolons
//   IMPORT          — Module not found, circular dependency
//   ASSERTION       — Test logic error, wrong expected value
//   TIMEOUT         — Test or sandbox exceeded time limit
//   ENVIRONMENT     — Node version, missing binary, OS-specific
// ============================================================

const path = require('path');
const fs = require('fs');
const { THRESHOLDS } = require('../core/Constants');

// ── Pattern Rules Table ───────────────────────────────────
// Declarative regex→confidence rules per failure category.
// Each entry: [regex, confidence]. First match wins.
// v6.0.5: Extracted from inline match() lambdas (CC=56→~12).
const PATTERN_RULES = [
  {
    category: 'CROSS_PLATFORM',
    rules: [
      [/\/etc\/|\/tmp\/|\/bin\/|\/dev\//, 0.95],
      [/ENOENT.*[\/\\](?:etc|tmp|bin)/, 0.9],
      [/path\.sep|path separator|backslash/, 0.8],
      [/wmic|Get-CimInstance|PowerShell/, 0.7],
      [/cmd\.exe|\.bat\b/, 0.6],
    ],
    rootCause: (f) => {
      if (/\/etc\//.test(f.message)) return 'Hardcoded Unix path /etc/';
      if (/\/tmp\//.test(f.message)) return 'Hardcoded Unix path /tmp/';
      return 'OS-specific path or command';
    },
    extractFile: (f) => {
      const m = (f.context || '').match(/at\s+.*?\((.+?):\d+:\d+\)/);
      return m ? m[1] : null;
    },
  },
  {
    category: 'ASYNC_TIMING',
    rules: [
      [/unhandled.*promise|unresolved|not a function.*then/, 0.9],
      [/fire.and.forget|ghost.*test|0 passed.*0 failed/, 0.85],
      [/race\s*condition|concurrent/, 0.7],
      [/timeout|ETIMEDOUT|timed?\s*out/, 0.6],
    ],
    rootCause: (f) => {
      if (/timeout/i.test(f.message)) return 'Test or operation timed out';
      if (/promise/i.test(f.message)) return 'Unhandled promise rejection';
      return 'Async timing issue';
    },
  },
  {
    category: 'DEPENDENCY',
    typeMatch: 'npm', typeScore: 0.85,
    rules: [
      [/npm audit|vulnerabilit/i, 0.9],
      [/Cannot find module|MODULE_NOT_FOUND/, 0.85],
      [/version.*mismatch|peer.*dep|ERESOLVE/, 0.8],
      [/ENOENT.*node_modules/, 0.7],
    ],
    rootCause: (f) => {
      const m = f.message.match(/Cannot find module '([^']+)'/);
      return m ? `Missing module: ${m[1]}` : 'Dependency issue';
    },
    extractFile: (f) => {
      const m = f.message.match(/Cannot find module '([^']+)'/);
      return m ? m[1] : null;
    },
  },
  {
    category: 'SYNTAX',
    typeMatch: 'syntax', typeScore: 0.95,
    rules: [
      [/SyntaxError|Unexpected token|Unexpected end/, 0.9],
      [/PARSE ERROR/, 0.85],
    ],
    rootCause: (f) => f.message,
    extractFile: (f) => f.file || null,
  },
  {
    category: 'IMPORT',
    rules: [
      [/circular.*dep/, 0.9],
      [/Cannot find module/, 0.85],
      [/is not exported/, 0.85],
      [/is not a function.*require/, 0.8],
    ],
    rootCause: (f) => {
      const m = f.message.match(/Cannot find module '([^']+)'/);
      if (m) return `Module not found: ${m[1]}`;
      if (/circular/i.test(f.message)) return 'Circular dependency';
      return 'Import/require error';
    },
  },
  {
    category: 'ASSERTION',
    rules: [
      [/Expected.*got|Assertion failed|should.*but/, 0.85],
    ],
    ctxRule: (_msg, f) => {
      if (/assertEqual|assertIncludes|assertThrows/.test(f.context || '')) return 0.7;
      if (f.type === 'test') return 0.5;
      return 0;
    },
    rootCause: (f) => f.message,
  },
  {
    category: 'ENVIRONMENT',
    rules: [
      [/node.*version|ENGINE.*unsupported/, 0.9],
      [/EACCES|permission denied/i, 0.8],
      [/electron.*not found|display.*not found/, 0.75],
    ],
    ctxRule: (msg, _f, ctx) => {
      if (/diagnostics_channel/.test(msg) && (ctx?.nodeVersion || 0) >= 22) return 0.9;
      return 0;
    },
    rootCause: (f) => {
      if (/diagnostics_channel/.test(f.message)) return 'Node 22+ module loader change';
      if (/EACCES/.test(f.message)) return 'Permission denied';
      return 'Environment incompatibility';
    },
  },
  {
    category: 'TIMEOUT',
    rules: [
      [/timed?\s*out|ETIMEDOUT|timeout/i, 0.85],
      [/exceeded.*time|took too long/i, 0.8],
    ],
    rootCause: () => 'Operation exceeded time limit',
  },
];

class FailureAnalyzer {
  /** @param {{ bus?: *, memory?: *, knowledgeGraph?: *, selfModel?: * }} [deps] */
  constructor({ bus, memory, knowledgeGraph, selfModel } = {}) {
    this.bus = bus;
    this.memory = memory;
    this.kg = knowledgeGraph;
    this.selfModel = selfModel;

    // Pattern database — learned from Genesis's own CI history
    this.patterns = this._buildPatternDB();

    // Stats
    this.analysisCount = 0;
    this.repairsGenerated = 0;
  }

  // ── Static container config (for DI) ────────────────────
  // ════════════════════════════════════════════════════════
  // PUBLIC API
  // ════════════════════════════════════════════════════════

  /**
   * Analyze a CI failure log and return a structured diagnosis.
   * @param {string} log - Raw CI output (test runner, npm, etc.)
   * @param {object} context - { os, nodeVersion, branch, commitSha }
   * @returns {*}
   */
  analyze(log, context = {}) {
    this.analysisCount++;

    const failures = this._parseFailures(log);
    const classified = failures.map(f => this._classify(f, context));
    const strategies = classified.map(c => this._generateStrategy(c, context));

    const report = {
      timestamp: new Date().toISOString(),
      context,
      totalFailures: failures.length,
      categories: this._summarizeCategories(classified),
      failures: classified,
      strategies,
      autoFixable: strategies.filter(s => s.confidence >= THRESHOLDS.FAILURE_AUTOFIX_CONFIDENCE).length,
      needsHumanReview: strategies.filter(s => s.confidence < THRESHOLDS.FAILURE_HUMAN_REVIEW_CONFIDENCE).length,
    };

    // Learn from this analysis
    if (this.memory) {
      this.memory.learnFact(
        `ci.lastFailure.${context.os || 'unknown'}`,
        JSON.stringify({ count: failures.length, categories: report.categories }),
        0.8, 'ci-analysis'
      );
    }

    if (this.kg) {
      for (const c of classified) {
        this.kg.connect(c.category, 'caused-by', c.rootCause || 'unknown');
        if (c.file) this.kg.connect(c.file, 'had-failure', c.category);
      }
    }

    if (this.bus) {
      this.bus.fire('ci:analyzed', {
        totalFailures: report.totalFailures,
        autoFixable: report.autoFixable,
      });
    }

    return report;
  }

  /**
   * Generate a repair plan from a failure report.
   * @param {*} report
   * @returns {*}
   */
  generateRepairPlan(report) {
    const steps = [];

    for (const strategy of report.strategies) {
      if (strategy.confidence < 0.3) continue; // Skip low-confidence

      steps.push({
        priority: strategy.confidence >= THRESHOLDS.FAILURE_AUTOFIX_CONFIDENCE ? 'HIGH' : strategy.confidence >= THRESHOLDS.FAILURE_HUMAN_REVIEW_CONFIDENCE ? 'MEDIUM' : 'LOW',
        category: strategy.category,
        action: strategy.action,
        file: strategy.file,
        description: strategy.description,
        code: strategy.suggestedFix || null,
        requiresReview: strategy.confidence < 0.7,
        estimatedEffort: strategy.effort,
      });
    }

    // Sort by priority (HIGH first), then by confidence
    steps.sort((a, b) => {
      const prio = { HIGH: 3, MEDIUM: 2, LOW: 1 };
      return ((/** @type {any} */ (prio))[b.priority] - (/** @type {any} */ (prio))[a.priority]) || (b.confidence - a.confidence);
    });

    this.repairsGenerated++;

    return {
      timestamp: new Date().toISOString(),
      totalSteps: steps.length,
      autoFixable: steps.filter(s => !s.requiresReview).length,
      steps,
    };
  }

  // ════════════════════════════════════════════════════════
  // FAILURE PARSING
  // ════════════════════════════════════════════════════════

  _parseFailures(log) {
    const failures = [];
    const lines = log.split('\n');

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];

      // Pattern: ❌ test name: error message
      const testFail = line.match(/❌\s+(.+?):\s+(.+)/);
      if (testFail) {
        failures.push({
          type: 'test',
          name: testFail[1].trim(),
          message: testFail[2].trim(),
          line: i + 1,
          context: this._extractContext(lines, i, 5),
        });
        continue;
      }

      // Pattern: Error: message (from Node.js)
      const nodeErr = line.match(/^(?:.*?)(Error|TypeError|ReferenceError|SyntaxError):\s+(.+)/);
      if (nodeErr && !line.includes('✅')) {
        failures.push({
          type: 'runtime',
          errorType: nodeErr[1],
          message: nodeErr[2].trim(),
          line: i + 1,
          context: this._extractContext(lines, i, 5),
        });
        continue;
      }

      // Pattern: PARSE ERROR: file message
      const parseErr = line.match(/PARSE ERROR:\s+(.+?)\s+(.+)/);
      if (parseErr) {
        failures.push({
          type: 'syntax',
          file: parseErr[1],
          message: parseErr[2],
          line: i + 1,
        });
        continue;
      }

      // Pattern: npm ERR!
      const npmErr = line.match(/npm ERR!\s+(.*)/);
      if (npmErr) {
        failures.push({
          type: 'npm',
          message: npmErr[1],
          line: i + 1,
          context: this._extractContext(lines, i, 3),
        });
      }
    }

    return failures;
  }

  _extractContext(lines, idx, radius) {
    const start = Math.max(0, idx - radius);
    const end = Math.min(lines.length, idx + radius + 1);
    return lines.slice(start, end).join('\n');
  }

  // ════════════════════════════════════════════════════════
  // CLASSIFICATION ENGINE
  // ════════════════════════════════════════════════════════

  _classify(failure, context) {
    let bestMatch = { category: 'UNKNOWN', confidence: 0, rootCause: null, file: null, ...failure };

    for (const pattern of this.patterns) {
      const score = pattern.match(failure, context);
      if (score > bestMatch.confidence) {
        bestMatch = {
          ...failure,
          category: pattern.category,
          confidence: score,
          rootCause: pattern.rootCause(failure),
          file: pattern.extractFile ? pattern.extractFile(failure) : (failure.file || null),
        };
      }
    }

    return bestMatch;
  }

  _buildPatternDB() {
    return PATTERN_RULES.map(rule => ({
      category: rule.category,
      match: (f, ctx) => {
        const msg = f.message || '';
        // Type-based short-circuit
        if (rule.typeMatch && f.type === rule.typeMatch) return rule.typeScore;
        // Regex rules — first match wins
        for (const [regex, score] of rule.rules) {
          if (/** @type {RegExp} */ (regex).test(msg)) return score;
        }
        // Context-aware rules (e.g. ENVIRONMENT checks nodeVersion)
        if (rule.ctxRule) return rule.ctxRule(msg, f, ctx);
        return 0;
      },
      rootCause: rule.rootCause,
      extractFile: rule.extractFile || undefined,
    }));
  }

  // ════════════════════════════════════════════════════════
  // STRATEGY GENERATION
  // ════════════════════════════════════════════════════════

  _generateStrategy(classified, context) {
    const strategies = {
      CROSS_PLATFORM: this._strategyCrossPlatform,
      ASYNC_TIMING: this._strategyAsyncTiming,
      DEPENDENCY: this._strategyDependency,
      SYNTAX: this._strategySyntax,
      IMPORT: this._strategyImport,
      ASSERTION: this._strategyAssertion,
      ENVIRONMENT: this._strategyEnvironment,
      TIMEOUT: this._strategyTimeout,
    };

    const fn = strategies[classified.category];
    if (fn) return fn.call(this, classified, context);

    return {
      category: classified.category,
      action: 'MANUAL_REVIEW',
      description: `Unclassified failure: ${classified.message}`,
      confidence: 0.1,
      effort: 'unknown',
    };
  }

  _strategyCrossPlatform(failure) {
    const msg = failure.message || '';
    const file = failure.file;

    if (/\/tmp\//.test(msg)) {
      return {
        category: 'CROSS_PLATFORM',
        action: 'REPLACE_PATH',
        file,
        description: 'Replace hardcoded /tmp/ with os.tmpdir()',
        suggestedFix: "path.join(require('os').tmpdir(), 'genesis-...')",
        confidence: 0.95,
        effort: 'minutes',
      };
    }

    if (/\/etc\//.test(msg)) {
      return {
        category: 'CROSS_PLATFORM',
        action: 'REPLACE_PATH',
        file,
        description: 'Replace hardcoded /etc/ with cross-platform equivalent',
        suggestedFix: "process.platform === 'win32' ? 'C:\\\\Windows\\\\...' : '/etc/...'",
        confidence: 0.9,
        effort: 'minutes',
      };
    }

    return {
      category: 'CROSS_PLATFORM',
      action: 'OS_DETECTION',
      file,
      description: 'Add OS detection and platform-specific handling',
      confidence: 0.6,
      effort: 'hours',
    };
  }

  _strategyAsyncTiming(failure) {
    return {
      category: 'ASYNC_TIMING',
      action: /timeout/i.test(failure.message) ? 'INCREASE_TIMEOUT' : 'ADD_AWAIT',
      file: failure.file,
      description: /timeout/i.test(failure.message)
        ? 'Increase timeout or optimize operation'
        : 'Ensure all async operations are properly awaited',
      suggestedFix: 'await Promise.resolve(result)',
      confidence: 0.7,
      effort: 'minutes',
    };
  }

  _strategyDependency(failure) {
    const m = failure.message && failure.message.match(/Cannot find module '([^']+)'/);
    return {
      category: 'DEPENDENCY',
      action: m ? 'INSTALL_MODULE' : 'UPDATE_DEPS',
      file: failure.file,
      description: m ? `Install missing module: ${m[1]}` : 'Update or fix dependencies',
      suggestedFix: m ? `npm install ${m[1]}` : 'npm install',
      confidence: m ? 0.9 : 0.6,
      effort: 'minutes',
    };
  }

  _strategySyntax(failure) {
    return {
      category: 'SYNTAX',
      action: 'FIX_SYNTAX',
      file: failure.file,
      description: `Fix syntax error: ${failure.message}`,
      confidence: 0.5, // Needs actual code analysis
      effort: 'minutes',
    };
  }

  _strategyImport(failure) {
    return {
      category: 'IMPORT',
      action: /circular/i.test(failure.message) ? 'BREAK_CYCLE' : 'FIX_REQUIRE',
      file: failure.file,
      description: failure.rootCause || failure.message,
      confidence: 0.6,
      effort: 'hours',
    };
  }

  _strategyAssertion(failure) {
    return {
      category: 'ASSERTION',
      action: 'UPDATE_ASSERTION',
      file: failure.file,
      description: `Test assertion failed: ${failure.message}`,
      confidence: 0.4, // Low — could be test bug or code bug
      effort: 'minutes',
    };
  }

  _strategyEnvironment(failure) {
    if (/diagnostics_channel/.test(failure.message)) {
      return {
        category: 'ENVIRONMENT',
        action: 'NODE_COMPAT_FIX',
        file: failure.file,
        description: 'Node 22+ broke module.constructor._load override',
        suggestedFix: 'Remove module.constructor._load/._resolveFilename destruction; rely on _safeRequire allowlist',
        confidence: 0.95,
        effort: 'minutes',
      };
    }
    return {
      category: 'ENVIRONMENT',
      action: 'ENV_CHECK',
      file: failure.file,
      description: failure.rootCause || 'Environment-specific issue',
      confidence: 0.5,
      effort: 'hours',
    };
  }

  _strategyTimeout(failure) {
    return {
      category: 'TIMEOUT',
      action: 'OPTIMIZE_OR_INCREASE',
      file: failure.file,
      description: 'Operation timed out — optimize or increase limit',
      confidence: 0.5,
      effort: 'hours',
    };
  }

  // ════════════════════════════════════════════════════════
  // HELPERS
  // ════════════════════════════════════════════════════════

  _summarizeCategories(classified) {
    const counts = {};
    for (const c of classified) {
      counts[c.category] = (counts[c.category] || 0) + 1;
    }
    return counts;
  }

  getStats() {
    return {
      analysisCount: this.analysisCount,
      repairsGenerated: this.repairsGenerated,
      patternCount: this.patterns.length,
    };
  }
}

module.exports = { FailureAnalyzer };
