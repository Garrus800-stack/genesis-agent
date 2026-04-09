// @ts-checked-v5.7
// ============================================================
// GENESIS — SelfOptimizer.js
// Analyzes Genesis's own response patterns and quality.
// Creates improvement goals based on real data.
//
// Tracks: response quality, error rates, intent accuracy,
// response times, user satisfaction signals, topic coverage.
// ============================================================

const fs = require('fs');
const path = require('path');
const { NullBus } = require('../core/EventBus');
const { createLogger } = require('../core/Logger');
const _log = createLogger('SelfOptimizer');
class SelfOptimizer {
  constructor({ bus,  eventStore, memory, goalStack, storageDir, storage }) {
    this.bus = bus || NullBus;
    this.es = eventStore;
    this.memory = memory;
    this.goalStack = goalStack;
    this.storage = storage || null;
    this.metricsPath = path.join(storageDir, 'metrics.json');
    // v3.8.0: Moved to asyncLoad() — called by Container.bootAll()
    // this.metrics = this._load();
    /** @type {{ responses: Array<{timestamp: number, intent: *, msgLength: number, respLength: number, success: boolean, hasCode: boolean}>, errors: Array<{timestamp: number, message: string}>, analysisCount: number, lastAnalysis?: * }} */
    this.metrics = { responses: [], errors: [], analysisCount: 0 };

    // Listen for completed chats to track quality
    this.bus.on('chat:completed', (data) => this._trackQuality(data), { source: 'SelfOptimizer', priority: -3 });
    this.bus.on('chat:error', (data) => this._trackError(data), { source: 'SelfOptimizer' });
  }

  /**
   * Run a full self-optimization analysis
   * Called periodically by AutonomousDaemon or IdleMind
   */
  async analyze() {
    const report = {
      timestamp: new Date().toISOString(),
      responseQuality: this._analyzeResponseQuality(),
      errorPatterns: this._analyzeErrors(),
      intentAccuracy: this._analyzeIntents(),
      topicCoverage: this._analyzeTopics(),
      /** @type {Array<{priority: string, area: string, description: string}>} */
      recommendations: [],
    };

    // Generate recommendations
    if (report.responseQuality.avgLength < 50) {
      report.recommendations.push({
        priority: 'high',
        area: 'response-depth',
        description: 'Responses are too short. Provide more context and explanations.',
      });
    }

    if (report.errorPatterns.errorRate > 0.2) {
      report.recommendations.push({
        priority: 'high',
        area: 'error-reduction',
        description: `Error rate at ${Math.round(report.errorPatterns.errorRate * 100)}%. Analyze and fix most frequent errors.`,
      });
    }

    if (report.intentAccuracy.unknownRate > 0.4) {
      report.recommendations.push({
        priority: 'medium',
        area: 'intent-coverage',
        description: 'Viele Nachrichten werden als "general" klassifiziert. Neue Intent-Patterns registrieren.',
      });
    }

    if (report.topicCoverage.gaps.length > 0) {
      report.recommendations.push({
        priority: 'medium',
        area: 'knowledge-gaps',
        description: `Wissensluecken bei: ${report.topicCoverage.gaps.slice(0, 3).join(', ')}`,
      });
    }

    // Create goals from high-priority recommendations
    if (this.goalStack && report.recommendations.length > 0) {
      const highPrio = report.recommendations.filter(r => r.priority === 'high');
      for (const rec of highPrio.slice(0, 1)) { // Max 1 auto-goal per analysis
        const activeGoals = this.goalStack.getActiveGoals();
        const alreadyExists = activeGoals.some(g => g.description.includes(rec.area));
        if (!alreadyExists && activeGoals.length < 3) {
          try {
            await this.goalStack.addGoal(
              `Selbstoptimierung: ${rec.description}`,
              'self-optimizer',
              rec.priority
            );
          } catch (err) { _log.debug('[OPTIMIZER] Goal creation failed:', err.message); }
        }
      }
    }

    // Save metrics
    this.metrics.lastAnalysis = report;
    this.metrics.analysisCount = (this.metrics.analysisCount || 0) + 1;
    this._save();

    return report;
  }

  /** Get the latest analysis */
  getLatestReport() {
    return this.metrics.lastAnalysis || null;
  }

  /** Build context for the prompt (so Genesis knows its own patterns) */
  buildContext() {
    const report = this.metrics.lastAnalysis;
    if (!report) return '';

    const lines = ['SELBSTANALYSE:'];
    if (report.responseQuality) {
      lines.push(`  Durchschnittliche Antwortlaenge: ${report.responseQuality.avgLength} Zeichen`);
      lines.push(`  Erfolgsrate: ${Math.round((1 - (report.errorPatterns?.errorRate || 0)) * 100)}%`);
    }
    if (report.recommendations.length > 0) {
      lines.push('  Verbesserungsbereiche: ' + report.recommendations.map(r => r.area).join(', '));
    }
    return lines.join('\n');
  }

  // ── Tracking ─────────────────────────────────────────────

  _trackQuality({ message, response, intent, success }) {
    if (!this.metrics.responses) this.metrics.responses = [];
    this.metrics.responses.push({
      timestamp: Date.now(),
      intent,
      msgLength: message?.length || 0,
      respLength: response?.length || 0,
      success: success !== false,
      hasCode: /```/.test(response || ''),
    });

    // Keep last 500
    if (this.metrics.responses.length > 500) {
      this.metrics.responses = this.metrics.responses.slice(-500);
    }
  }

  _trackError({ message }) {
    if (!this.metrics.errors) this.metrics.errors = [];
    this.metrics.errors.push({
      timestamp: Date.now(),
      message: (message || '').slice(0, 200),
    });
    if (this.metrics.errors.length > 100) {
      this.metrics.errors = this.metrics.errors.slice(-100);
    }
  }

  // ── Analysis ─────────────────────────────────────────────

  _analyzeResponseQuality() {
    const responses = this.metrics.responses || [];
    if (responses.length === 0) return { avgLength: 0, codeRate: 0, total: 0 };

    const recent = responses.slice(-50);
    const avgLength = Math.round(recent.reduce((sum, r) => sum + r.respLength, 0) / recent.length);
    const codeRate = recent.filter(r => r.hasCode).length / recent.length;

    return { avgLength, codeRate: Math.round(codeRate * 100) / 100, total: responses.length };
  }

  _analyzeErrors() {
    const responses = this.metrics.responses || [];
    const errors = this.metrics.errors || [];
    const recent = responses.slice(-50);
    const errorRate = recent.length > 0 ? recent.filter(r => !r.success).length / recent.length : 0;

    // Find common error patterns
    const errorMessages = errors.slice(-20).map(e => e.message);
    const patterns = {};
    for (const msg of errorMessages) {
      const key = msg.split(':')[0] || 'unknown';
      patterns[key] = (patterns[key] || 0) + 1;
    }

    return {
      errorRate: Math.round(errorRate * 100) / 100,
      totalErrors: errors.length,
      commonPatterns: Object.entries(patterns).sort((a, b) => b[1] - a[1]).slice(0, 3),
    };
  }

  _analyzeIntents() {
    const responses = this.metrics.responses || [];
    const recent = responses.slice(-50);
    if (recent.length === 0) return { unknownRate: 0, distribution: {} };

    const distribution = {};
    for (const r of recent) {
      distribution[r.intent || 'unknown'] = (distribution[r.intent || 'unknown'] || 0) + 1;
    }

    const unknownRate = (distribution['general'] || 0) / recent.length;
    return { unknownRate: Math.round(unknownRate * 100) / 100, distribution };
  }

  _analyzeTopics() {
    // Find topics where Genesis performed poorly
    const responses = this.metrics.responses || [];
    const failed = responses.filter(r => !r.success);

    // Simple gap detection based on failed intents
    const failedIntents = {};
    for (const r of failed) {
      failedIntents[r.intent || 'unknown'] = (failedIntents[r.intent || 'unknown'] || 0) + 1;
    }

    const gaps = Object.entries(failedIntents)
      .filter(([_, count]) => count > 2)
      .sort((a, b) => b[1] - a[1])
      .map(([intent]) => intent);

    return { gaps, totalFailed: failed.length };
  }

  // ── Persistence ──────────────────────────────────────────

  _save() {
    try {
      if (this.storage) this.storage.writeJSONDebounced('optimizer-metrics.json', this.metrics);
    } catch (err) { _log.debug('[OPTIMIZER] Metrics save failed:', err.message); }
  }

  /**
   * v3.8.0: Async boot-time data loading.
   * Called by Container.bootAll() after all services are resolved.
   */
  async asyncLoad() {
    this.metrics = this._load();
  }


  _load() {
    try {
      if (this.storage) return this.storage.readJSON('optimizer-metrics.json', { responses: [], errors: [], analysisCount: 0 });
    } catch (err) { _log.debug('[OPTIMIZER] Metrics load failed:', err.message); }
    return { responses: [], errors: [], analysisCount: 0 };
  }
}

module.exports = { SelfOptimizer };
