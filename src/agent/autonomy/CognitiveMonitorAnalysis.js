// @ts-checked-v5.7 — unbound `this` in prototype-delegation object
// ============================================================
// GENESIS — autonomy/CognitiveMonitorAnalysis.js (v5.6.0)
// Extracted via prototype delegation.
// ============================================================

const { createLogger } = require('../core/Logger');
const _log = createLogger('CognitiveMonitor');



const analysis = {

  _detectRedundantToolCalls() {
    const patterns = [];
    const windowMs = 10000;
    const threshold = 3;

    // Group calls by 10s windows
    const now = Date.now();
    const recent = this._toolCalls.filter(c => now - c.timestamp < 60000);

    const windows = new Map();
    for (const call of recent) {
      const windowKey = Math.floor(call.timestamp / windowMs);
      if (!windows.has(windowKey)) windows.set(windowKey, []);
      windows.get(windowKey).push(call);
    }

    for (const [, calls] of windows) {
      const counts = {};
      for (const c of calls) {
        counts[c.name] = (counts[c.name] || 0) + 1;
      }
      for (const [name, count] of Object.entries(counts)) {
        if (count >= threshold) {
          patterns.push({ tool: name, count, window: `${windowMs / 1000}s` });
        }
      }
    }

    return patterns;
  },

  _checkCircularity(currentHash) {
    // Look at last 10 reasoning outputs for repeating patterns
    const recent = this._reasoningChains.slice(-11, -1); // Exclude the one we just added
    if (recent.length < 2) return null;

    for (let i = recent.length - 1; i >= 0; i--) {
      const similarity = this._hashSimilarity(currentHash, recent[i].hash);
      if (similarity >= this._circularityThreshold) {
        return {
          similarity: Math.round(similarity * 100) / 100,
          matchedIndex: i,
          matchedSummary: recent[i].summary,
        };
      }
    }

    // Also check for A→B→A oscillation pattern
    if (recent.length >= 3) {
      const last3 = this._reasoningChains.slice(-3);
      const sim_0_2 = this._hashSimilarity(last3[0].hash, last3[2].hash);
      if (sim_0_2 >= this._circularityThreshold) {
        return {
          similarity: sim_0_2,
          matchedIndex: -1,
          pattern: 'oscillation',
          matchedSummary: `Oscillating: "${last3[0].summary}" ↔ "${last3[1].summary}"`,
        };
      }
    }

    return null;
  },

  /**
   * Simple text hashing for fast comparison.
   * Uses trigram frequency as a poor-man's embedding.
   */
  _hashText(text) {
    const normalized = text.toLowerCase().replace(/[^a-z0-9äöüß\s]/g, '').trim();
    const words = normalized.split(/\s+/).filter(w => w.length > 2);
    const trigrams = {};
    for (const word of words) {
      for (let i = 0; i <= word.length - 3; i++) {
        const tri = word.substring(i, i + 3);
        trigrams[tri] = (trigrams[tri] || 0) + 1;
      }
    }
    return trigrams;
  },

  _hashSimilarity(a, b) {
    const allKeys = new Set([...Object.keys(a), ...Object.keys(b)]);
    if (allKeys.size === 0) return 0;

    let dotProduct = 0, magA = 0, magB = 0;
    for (const key of allKeys) {
      const va = a[key] || 0;
      const vb = b[key] || 0;
      dotProduct += va * vb;
      magA += va * va;
      magB += vb * vb;
    }

    const denom = Math.sqrt(magA) * Math.sqrt(magB);
    return denom === 0 ? 0 : dotProduct / denom;
  },

  // ── Event Wiring ────────────────────────────────────────

  _wireEvents() {
    // v4.12.5-fix: Was 'tool:executed' — ToolRegistry emits 'tools:result'
    // with { name, duration, success }. Adapted field: duration (not durationMs).
    this.bus.on('tools:result', (data) => {
      this.recordToolCall(data.name, data.success !== false, data.duration || 0);
    }, { source: 'CognitiveMonitor' });

    // Listen for LLM call metrics
    this.bus.on('llm:call-complete', (data) => {
      this.updateTokenUsage(
        (data.promptTokens || 0) + (data.responseTokens || 0)
      );
    }, { source: 'CognitiveMonitor' });

    // Listen for reasoning results
    this.bus.on('reasoning:step', (data) => {
      if (data.conclusion) {
        this.recordReasoning(data.conclusion, { source: 'ReasoningEngine' });
      }
    }, { source: 'CognitiveMonitor' });

    // Listen for agent loop steps
    // v4.12.5-fix: agent-loop:step-complete is only emitted on successful steps
    // (errors break out of the loop). Removed false data.success check.
    this.bus.on('agent-loop:step-complete', (data) => {
      if (data.result) {
        this.recordReasoning(
          `Step ${data.stepIndex}: ${data.type} → OK`,
          { source: 'AgentLoop', goalId: data.goalId }
        );
      }
    }, { source: 'CognitiveMonitor' });

    // Listen for goal completions (decision quality feedback)
    this.bus.on('goal:completed', (data) => {
      // Find decisions related to this goal
      for (let i = this._decisions.length - 1; i >= 0; i--) {
        if (this._decisions[i].goalId === data.id && this._decisions[i].quality === null) {
          this.evaluateDecision(i, data.success ? 'success' : 'failure');
        }
      }
    }, { source: 'CognitiveMonitor' });
  },

  // ── Periodic Analysis ───────────────────────────────────

  _periodicAnalysis() {
    const report = this.getReport();

    // Persist snapshot to storage (v3.7.1: non-blocking)
    if (this.storage) {
      try {
        this.storage.writeJSONAsync('cognitive-snapshot.json', {
          timestamp: new Date().toISOString(),
          cognitiveLoad: report.cognitiveLoad,
          tokenBudget: report.tokenBudget,
          decisionQuality: report.decisionQuality,
          toolCallCount: report.toolAnalytics.totalCalls,
          circularityAlerts: report.circularity.alertCount,
        }).catch(err => _log.debug('[COGNITIVE] Snapshot save failed:', err.message));
      } catch (err) {
        _log.debug('[COGNITIVE] Snapshot save failed:', err.message);
      }
    }

    // Log to EventStore
    if (this.eventStore) {
      this.eventStore.append('COGNITIVE_SNAPSHOT', {
        load: report.cognitiveLoad.overall,
        quality: report.decisionQuality.rollingQuality,
        tokenUsage: report.tokenBudget.usagePercent,
      }, 'CognitiveMonitor');
    }

    // Emit if load is critical
    if (report.cognitiveLoad.overall > 85) {
      this.bus.fire('cognitive:overload', {
        metric: 'overall',
        value: report.cognitiveLoad.overall,
        components: report.cognitiveLoad.components || {},
      }, { source: 'CognitiveMonitor' });
    }
  },

};

module.exports = { analysis };
