// @ts-checked-v5.8
// ============================================================
// GENESIS — CognitiveMonitor.js (v3.5.0 — Metakognitive Schicht)
//
// Upgrade from Reflector's static code diagnostics to runtime
// metacognition. Monitors HOW the agent reasons, not just
// whether its code compiles.
//
// Capabilities:
// 1. Tool usage analytics — tracks which tools are called,
//    success rates, patterns, redundant calls
// 2. Reasoning chain circularity detection — detects when
//    the agent repeats the same reasoning or oscillates
// 3. Token budget awareness — tracks context window usage,
//    warns when approaching limits
// 4. Decision quality tracking — post-hoc evaluation of
//    whether agent decisions led to goal progress
// 5. Cognitive load estimation — how "taxed" is the system
//
// Integrates with: EventStore (historical data), LLMPort
// (call metrics), ToolRegistry (tool stats), AgentLoop
// (step outcomes), ReasoningEngine (reasoning chains)
// ============================================================

const { NullBus } = require('../core/EventBus');
const { createLogger } = require('../core/Logger');
const _log = createLogger('CognitiveMonitor');

class CognitiveMonitor {
  static containerConfig = {
    name: 'cognitiveMonitor',
    phase: 6,
    deps: ['bus', 'eventStore', 'storage'],
    tags: ['metacognition', 'autonomy'],
    lateBindings: [
      { target: 'promptBuilder', property: 'cognitiveMonitor' },
    ],
  };

  /** @param {{ bus?: *, eventStore?: *, storage?: *, intervals?: *, config?: * }} [deps] */
  constructor({ bus, eventStore, storage, intervals, config } = {}) {
    this.bus = bus || NullBus;
    this.eventStore = eventStore || null;
    this.storage = storage || null;
    this.intervals = intervals || null;

    // ── Injected via late-binding ─────────────────────
    this.llmPort = null;        // LLMPort (for call metrics)
    this.toolRegistry = null;   // ToolRegistry (for tool stats)
    this.agentLoop = null;      // AgentLoop (for step outcomes)

    // ── Configuration ─────────────────────────────────
    const cfg = config || {};
    this._maxContextTokens = cfg.maxContextTokens || 8192;
    this._circularityThreshold = cfg.circularityThreshold || 0.75;
    this._maxReasoningHistory = cfg.maxReasoningHistory || 50;
    this._analyzeIntervalMs = cfg.analyzeIntervalMs || 60000;

    // ── Runtime State ─────────────────────────────────

    // Tool usage tracking
    this._toolCalls = [];       // { name, timestamp, success, durationMs }
    this._toolStats = new Map(); // name -> { calls, successes, failures, avgMs }

    // Reasoning chain history (for circularity detection)
    this._reasoningChains = []; // { summary, timestamp, hash }
    this._circularityAlerts = [];

    // Token budget tracking
    this._tokenUsage = {
      currentEstimate: 0,
      peakEstimate: 0,
      warningCount: 0,
      /** @type {number | null} */ lastWarningAt: null,
    };

    // Decision quality log
    this._decisions = [];       // { decision, goalId, timestamp, outcome, quality }
    this._qualityScore = 1.0;   // Rolling 0.0 - 1.0

    // Cognitive load
    this._cognitiveLoad = 0;    // 0.0 - 1.0

    /** @type {*} */ this._intervalHandle = null;
    // @ts-ignore — prototype delegation (CognitiveMonitorAnalysis)
    this._wireEvents();
  }

  // ════════════════════════════════════════════════════════
  // LIFECYCLE
  // ════════════════════════════════════════════════════════

  start() {
    if (this.intervals) {
      // @ts-ignore — prototype delegation (CognitiveMonitorAnalysis)
      this.intervals.register('cognitive-monitor', () => this._periodicAnalysis(), this._analyzeIntervalMs);
    } else {
      // @ts-ignore — prototype delegation (CognitiveMonitorAnalysis)
      this._intervalHandle = setInterval(() => this._periodicAnalysis(), this._analyzeIntervalMs);
    }
    this.bus.fire('cognitive:started', {}, { source: 'CognitiveMonitor' });
  }

  stop() {
    if (this.intervals) {
      this.intervals.clear('cognitive-monitor');
    } else if (this._intervalHandle) {
      clearInterval(this._intervalHandle);
      /** @type {*} */ this._intervalHandle = null;
    }
  }

  // ════════════════════════════════════════════════════════
  // 1. TOOL USAGE ANALYTICS
  // ════════════════════════════════════════════════════════

  recordToolCall(name, success, durationMs = 0) {
    const entry = { name, timestamp: Date.now(), success, durationMs };
    this._toolCalls.push(entry);
    if (this._toolCalls.length > 500) this._toolCalls.shift();

    // Update per-tool stats
    if (!this._toolStats.has(name)) {
      this._toolStats.set(name, { calls: 0, successes: 0, failures: 0, totalMs: 0 });
    }
    const stat = this._toolStats.get(name);
    stat.calls++;
    if (success) stat.successes++;
    else stat.failures++;
    stat.totalMs += durationMs;
    // DA-1: Cap tool stats map
    if (this._toolStats.size > 200) {
      const oldest = [...this._toolStats.entries()].sort((a, b) => a[1].calls - b[1].calls)[0];
      if (oldest) this._toolStats.delete(oldest[0]);
    }
  }

  getToolAnalytics() {
    const analytics = {};
    for (const [name, stat] of this._toolStats) {
      analytics[name] = {
        calls: stat.calls,
        successRate: stat.calls > 0 ? Math.round((stat.successes / stat.calls) * 100) : 0,
        avgDurationMs: stat.calls > 0 ? Math.round(stat.totalMs / stat.calls) : 0,
        failures: stat.failures,
      };
    }

    // Detect redundant tool patterns (same tool called 3+ times in 10s window)
    // @ts-ignore — prototype delegation (CognitiveMonitorAnalysis)
    const redundant = this._detectRedundantToolCalls();

    return { perTool: analytics, redundantPatterns: redundant, totalCalls: this._toolCalls.length };
  }


  // ════════════════════════════════════════════════════════
  // 2. REASONING CHAIN CIRCULARITY DETECTION
  // ════════════════════════════════════════════════════════

  /**
   * Record a reasoning step/conclusion for circularity analysis.
   * Call this from ReasoningEngine, AgentLoop, or IdleMind after
   * each reasoning cycle produces a conclusion.
   *
   * @param {string} summary - Short text summary of the reasoning output
   * @param {object} context - { source, goalId, stepIndex }
   */
  recordReasoning(summary, context = {}) {
    // @ts-ignore — prototype delegation (CognitiveMonitorAnalysis)
    const hash = this._hashText(summary);
    const entry = {
      summary: summary.substring(0, 200),
      hash,
      timestamp: Date.now(),
      source: context.source || 'unknown',
      goalId: context.goalId || null,
    };

    this._reasoningChains.push(entry);
    if (this._reasoningChains.length > this._maxReasoningHistory) {
      this._reasoningChains.shift();
    }

    // Check for circularity
    // @ts-ignore — prototype delegation (CognitiveMonitorAnalysis)
    const circular = this._checkCircularity(hash);
    if (circular) {
      this._circularityAlerts.push({
        ...circular,
        timestamp: Date.now(),
        summary: entry.summary,
      });
      if (this._circularityAlerts.length > 20) this._circularityAlerts.shift();

      this.bus.fire('cognitive:circularity-detected', {
        similarity: circular.similarity,
        matchedIndex: circular.matchedIndex,
        summary: entry.summary,
        source: context.source,
      }, { source: 'CognitiveMonitor' });

      return { circular: true, similarity: circular.similarity };
    }

    return { circular: false };
  }




  getCircularityReport() {
    return {
      totalReasoningChains: this._reasoningChains.length,
      alerts: this._circularityAlerts.slice(-10),
      alertCount: this._circularityAlerts.length,
    };
  }

  // ════════════════════════════════════════════════════════
  // 3. TOKEN BUDGET AWARENESS
  // ════════════════════════════════════════════════════════

  /**
   * Update estimated token usage for current context.
   * Call from PromptBuilder or ChatOrchestrator before each LLM call.
   *
   * @param {number} estimatedTokens - Estimated total tokens in context
   */
  updateTokenUsage(estimatedTokens) {
    this._tokenUsage.currentEstimate = estimatedTokens;
    this._tokenUsage.peakEstimate = Math.max(this._tokenUsage.peakEstimate, estimatedTokens);

    const usage = estimatedTokens / this._maxContextTokens;

    if (usage > 0.85) {
      this._tokenUsage.warningCount++;
      this._tokenUsage.lastWarningAt = Date.now();
      this.bus.fire('cognitive:token-budget-warning', {
        usage: Math.round(usage * 100),
        estimated: estimatedTokens,
        max: this._maxContextTokens,
      }, { source: 'CognitiveMonitor' });
    }
  }

  setMaxContextTokens(max) {
    this._maxContextTokens = max;
  }

  getTokenBudget() {
    return {
      current: this._tokenUsage.currentEstimate,
      max: this._maxContextTokens,
      usagePercent: this._maxContextTokens > 0
        ? Math.round((this._tokenUsage.currentEstimate / this._maxContextTokens) * 100)
        : 0,
      peak: this._tokenUsage.peakEstimate,
      warnings: this._tokenUsage.warningCount,
    };
  }

  // ════════════════════════════════════════════════════════
  // 4. DECISION QUALITY TRACKING
  // ════════════════════════════════════════════════════════

  /**
   * Record a decision for later quality evaluation.
   * @param {string} decision - What was decided
   * @param {string} goalId - Related goal
   * @param {string} rationale - Why this was chosen
   */
  recordDecision(decision, goalId = /** @type {*} */ (null), rationale = '') {
    this._decisions.push({
      decision,
      goalId,
      rationale,
      timestamp: Date.now(),
      outcome: null,    // Set later by evaluateDecision()
      quality: null,
    });
    if (this._decisions.length > 100) this._decisions.shift();
  }

  /**
   * Evaluate a past decision's outcome.
   * @param {number} index - Decision index (or -1 for last)
   * @param {string} outcome - 'success' | 'failure' | 'neutral'
   * @param {string} notes - What happened
   */
  evaluateDecision(index, outcome, notes = '') {
    const idx = index === -1 ? this._decisions.length - 1 : index;
    if (idx < 0 || idx >= this._decisions.length) return;

    const decision = this._decisions[idx];
    decision.outcome = outcome;
    decision.quality = outcome === 'success' ? 1.0 : outcome === 'failure' ? 0.0 : 0.5;

    // Update rolling quality score
    const recent = this._decisions.filter(d => d.quality !== null).slice(-20);
    if (recent.length > 0) {
      this._qualityScore = recent.reduce((sum, d) => sum + d.quality, 0) / recent.length;
    }

    this.bus.fire('cognitive:decision-evaluated', {
      decision: decision.decision,
      outcome,
      rollingQuality: Math.round(this._qualityScore * 100),
    }, { source: 'CognitiveMonitor' });
  }

  getDecisionQuality() {
    const evaluated = this._decisions.filter(d => d.quality !== null);
    return {
      totalDecisions: this._decisions.length,
      evaluated: evaluated.length,
      rollingQuality: Math.round(this._qualityScore * 100),
      recentDecisions: this._decisions.slice(-5),
    };
  }

  // ════════════════════════════════════════════════════════
  // 5. COGNITIVE LOAD ESTIMATION
  // ════════════════════════════════════════════════════════

  /**
   * Estimate current cognitive load (0.0 = idle, 1.0 = overloaded).
   * Combines: token usage, tool call rate, error rate, circularity.
   */
  getCognitiveLoad() {
    const tokenLoad = this._tokenUsage.currentEstimate / this._maxContextTokens;

    // Tool call rate (calls in last 60s)
    const now = Date.now();
    const recentToolCalls = this._toolCalls.filter(c => now - c.timestamp < 60000).length;
    const toolLoad = Math.min(recentToolCalls / 15, 1.0); // 15 calls/min = full load

    // Error rate from recent tool calls
    const recentErrors = this._toolCalls.filter(c => now - c.timestamp < 60000 && !c.success).length;
    const errorLoad = recentToolCalls > 0 ? recentErrors / recentToolCalls : 0;

    // Circularity pressure
    const recentCircular = this._circularityAlerts.filter(a => now - a.timestamp < 120000).length;
    const circularLoad = Math.min(recentCircular / 3, 1.0);

    // Weighted combination
    this._cognitiveLoad = Math.min(1.0,
      tokenLoad * 0.3 +
      toolLoad * 0.25 +
      errorLoad * 0.25 +
      circularLoad * 0.2
    );

    return {
      overall: Math.round(this._cognitiveLoad * 100),
      components: {
        tokenUsage: Math.round(tokenLoad * 100),
        toolActivity: Math.round(toolLoad * 100),
        errorRate: Math.round(errorLoad * 100),
        circularity: Math.round(circularLoad * 100),
      },
    };
  }

  // ════════════════════════════════════════════════════════
  // COMBINED REPORT
  // ════════════════════════════════════════════════════════

  // ── Analysis → CognitiveMonitorAnalysis.js (v5.6.0) ──
  // (prototype delegation, see bottom of file)

  getReport() {
    return {
      cognitiveLoad: this.getCognitiveLoad(),
      toolAnalytics: this.getToolAnalytics(),
      circularity: this.getCircularityReport(),
      tokenBudget: this.getTokenBudget(),
      decisionQuality: this.getDecisionQuality(),
    };
  }

  /**
   * Generate metacognitive insights for PromptBuilder injection.
   * Returns a compact string the agent can use for self-awareness.
   */
  getInsightsForPrompt() {
    const load = this.getCognitiveLoad();
    const lines = [];

    if (load.overall > 70) {
      lines.push(`[META] Hohe kognitive Last (${load.overall}%) — fokussierter arbeiten, weniger parallele Tool-Aufrufe.`);
    }

    const circ = this.getCircularityReport();
    if (circ.alertCount > 0) {
      const lastAlert = circ.alerts[circ.alerts.length - 1];
      lines.push(`[META] Circular reasoning detected (${lastAlert.similarity * 100}% similarity). Choose a new approach.`);
    }

    const budget = this.getTokenBudget();
    if (budget.usagePercent > 75) {
      lines.push(`[META] Token-Budget bei ${budget.usagePercent}% — Kontext komprimieren oder zusammenfassen.`);
    }

    const quality = this.getDecisionQuality();
    if (quality.rollingQuality < 50 && quality.evaluated >= 3) {
      lines.push(`[META] Entscheidungsqualitaet niedrig (${quality.rollingQuality}%) — mehr analysieren vor Aktion.`);
    }

    const toolAnalytics = this.getToolAnalytics();
    if (toolAnalytics.redundantPatterns.length > 0) {
      const pattern = toolAnalytics.redundantPatterns[0];
      lines.push(`[META] Redundante Tool-Aufrufe: ${pattern.tool} ${pattern.count}x in ${pattern.window}.`);
    }

    return lines.length > 0 ? lines.join('\n') : null;
  }


}

module.exports = { CognitiveMonitor };

const { analysis: _cmAnalysis } = require('./CognitiveMonitorAnalysis');
Object.assign(CognitiveMonitor.prototype, _cmAnalysis);
