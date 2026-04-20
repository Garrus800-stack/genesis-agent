// @ts-checked-v5.8
// ============================================================
// GENESIS — LearningService.js (v2 — Closed-Loop Learning)
//
// v1 was passive fact-extraction only. v2 adds:
// 1. OUTCOME TRACKING — success/fail per intent with metrics
// 2. PATTERN GENERALIZATION — detect repeated sequences and
//    extract reusable patterns
// 3. CONVERSATION MINING — deeper fact/preference extraction
// 4. ADAPTIVE METRICS — track what works, surface insights
// 5. INTENT FEEDBACK LOOP — feed IntentRouter with observed
//    misclassifications for online learning
//
// Still event-driven — never called directly.
// ============================================================

const fs = require('fs');
const path = require('path');
const { NullBus } = require('../core/EventBus');
const { createLogger } = require('../core/Logger');
const { INTERVALS } = require('../core/Constants');
const { STOP_WORDS } = require('../core/utils');
const { applySubscriptionHelper } = require('../core/subscription-helper');
const _log = createLogger('LearningService');

class LearningService {
  constructor({ bus,  memory, knowledgeGraph, eventStore, storageDir, intervals, storage }) {
    this.bus = bus || NullBus;
    /** @type {Function[]} */ this._unsubs = [];
    this.memory = memory;
    this.kg = knowledgeGraph;
    this.es = eventStore;
    this.storageDir = storageDir || null;
    this.storage = storage || null;
    this._intervals = intervals || null;

    // ── Fact extraction patterns (DE + EN) ──────────────
    // v7.2.9: Unicode-aware (\p{L}) — captures German names/words with umlauts correctly
    this.factPatterns = [
      // German identity
      { regex: /ich heisse ([\p{L}]+)/iu, key: 'user.name' },
      { regex: /ich bin ([\p{L}]+)/iu, key: 'user.role' },
      { regex: /mein name ist ([\p{L}]+)/iu, key: 'user.name' },
      { regex: /nenn mich ([\p{L}]+)/iu, key: 'user.name' },
      { regex: /ich arbeite (?:an|mit|bei) (.+?)(?:\.|,|$)/i, key: 'user.work' },
      { regex: /ich benutze ([\p{L}][\p{L}\s]*[\p{L}])/iu, key: 'user.tool' },
      { regex: /mein.* (?:name|projekt) ist (.+?)(?:\.|,|$)/i, key: 'user.info' },
      { regex: /ich mag ([\p{L}][\p{L}\s]*[\p{L}])/iu, key: 'user.preference' },
      { regex: /ich spreche ([\p{L}]+)/iu, key: 'user.language' },
      { regex: /ich wohne (?:in|bei) (.+?)(?:\.|,|$)/i, key: 'user.location' },
      { regex: /mein betriebssystem ist ([\p{L}]+)/iu, key: 'user.os' },
      { regex: /ich programmiere (?:in|mit) ([\p{L}]+)/iu, key: 'user.language_prog' },
      // English identity
      { regex: /my name is ([\p{L}]+)/iu, key: 'user.name' },
      { regex: /call me ([\p{L}]+)/iu, key: 'user.name' },
      { regex: /i(?:'m| am) ([\p{L}]+)/iu, key: 'user.role' },
      { regex: /i work (?:at|on|with) (.+?)(?:\.|,|$)/i, key: 'user.work' },
      { regex: /i use ([\p{L}][\p{L}\s]*[\p{L}])/iu, key: 'user.tool' },
      { regex: /i live in (.+?)(?:\.|,|$)/i, key: 'user.location' },
      { regex: /i speak ([\p{L}]+)/iu, key: 'user.language' },
      { regex: /i prefer ([\p{L}][\p{L}\s]*[\p{L}])/iu, key: 'user.preference' },
      { regex: /my (?:favorite|fav) (?:[\p{L}]+ )?is ([\p{L}][\p{L}\s]*[\p{L}])/iu, key: 'user.preference' },
    ];

    // ── Outcome tracking ────────────────────────────────
    this._metrics = {
      intents: {},      // intent -> { total, success, fail, recentOutcomes }
      toolUsage: {},    // tool -> { calls, successes, failures }
      /** @type {Array<{message: string, intent: string, count: number, lastSeen: number}>} */
      errorPatterns: [], // recurring error messages
    };
    this._metricsPath = storageDir ? path.join(storageDir, 'learning-metrics.json') : null;
    this._loadMetrics();

    // ── Pattern tracking ────────────────────────────────
    this._recentIntentSequence = [];
    this._maxSequenceLen = 20;
    this._detectedPatterns = [];

    // ── LLM fallback tracking (for IntentRouter feedback) ──
    this._llmFallbacks = [];
    this._recentMessages = [];
  }

  /** Start listening — call once during boot */
  start() {
    this._sub('chat:completed', (data) => {
      this._learnFromChat(data);
    }, { source: 'LearningService', priority: -1 });

    this._sub('user:message', (data) => {
      this.es?.append('CHAT_MESSAGE', { role: 'user', length: data.length }, 'user');
    }, { source: 'LearningService' });

    this._sub('intent:classified', (data) => {
      this._trackIntent(data);
    }, { source: 'LearningService' });

    // v4.12.5-fix: Was 'tool:executed' — ToolRegistry emits 'tools:result'.
    this._sub('tools:result', (data) => {
      this._trackToolUsage(data);
    }, { source: 'LearningService' });

    this._sub('intent:llm-classified', (data) => {
      this._trackLLMFallback(data);
    }, { source: 'LearningService' });

    this._sub('model:failover', (data) => {
      this.es?.append('MODEL_FAILOVER', {
        from: data.from, to: data.to, error: (data.error || '').slice(0, 100),
      }, 'ModelBridge');
    }, { source: 'LearningService' });

    if (this._intervals) {
      this._intervals.register('learning-save', () => this._saveMetrics(), 5 * 60 * 1000);
    } else {
      // v4.12.1 [P2-04]: Clear any existing timer before setting a new one.
      // Prevents timer leak if start() is called twice without stop().
      if (this._saveInterval) clearInterval(this._saveInterval);
      this._saveInterval = setInterval(() => this._saveMetrics(), INTERVALS.LEARNING_SAVE);
    }

    _log.info('[LEARNING] v2 Service active — outcome tracking + pattern detection');
  }


  /** @private Subscribe to bus event with auto-cleanup in stop() — see subscription-helper.js */

  stop() {
    this._unsubAll();
    if (this._intervals) {
      this._intervals.clear('learning-save');
    } else if (this._saveInterval) {
      clearInterval(this._saveInterval);
    }
    // FIX v5.1.0 (C-1): Sync write on shutdown.
    this._saveMetricsSync();
  }

  // ════════════════════════════════════════════════════════
  // CORE: Learn from chat
  // ════════════════════════════════════════════════════════

  _learnFromChat({ message, response, intent, success }) {
    if (!message) return;

    // 1. Log to EventStore
    this.es?.append('CHAT_MESSAGE', {
      role: 'assistant', length: response?.length || 0, intent,
    }, 'Genesis');

    // 2. Extract facts
    this._extractFacts(message);

    // 3. Extract implicit preferences
    this._extractPreferences(message);

    // 4. Feed KnowledgeGraph
    if (this.kg) {
      this.kg.learnFromText(message, 'user');
      if (response) this.kg.learnFromText(response, 'genesis');
    }

    // 5. Track intent outcome
    this._recordIntentOutcome(intent, success);

    // 6. Detect intent sequences
    this._trackIntentSequence(intent);

    // 7. Learn procedural patterns
    if (this.memory && intent) {
      this.memory.learnPattern(`intent:${intent}`, intent, success !== false);
    }

    // 8. Track errors
    if (!success && response) {
      this._trackError(response, intent);
    }

    // 9. Detect repeated user requests (frustration)
    this._detectFrustration(message, intent);

    // 10. FIX v6.1.1: Detect capability gaps — when Genesis says "I can't"
    this._detectCapabilityGap(message, response);
  }

  // ════════════════════════════════════════════════════════
  // OUTCOME TRACKING
  // ════════════════════════════════════════════════════════

  _recordIntentOutcome(intent, success) {
    if (!intent) return;
    if (!this._metrics.intents[intent]) {
      this._metrics.intents[intent] = { total: 0, success: 0, fail: 0, recentOutcomes: [] };
    }
    const m = this._metrics.intents[intent];
    m.total++;
    if (success !== false) m.success++;
    else m.fail++;

    m.recentOutcomes.push({ success: success !== false, ts: Date.now() });
    if (m.recentOutcomes.length > 20) m.recentOutcomes.shift();

    // Performance alert: 4 out of 5 recent failures
    const recent5 = m.recentOutcomes.slice(-5);
    if (recent5.length >= 5 && recent5.filter(o => !o.success).length >= 4) {
      this.bus.emit('learning:performance-alert', {
        intent,
        successRate: m.success / m.total,
        message: `Intent "${intent}": ${m.fail} errors in last 5 requests`,
      }, { source: 'LearningService' });
    }
  }

  _trackIntent(data) {
    this.es?.append('INTENT_CLASSIFIED', { intent: data.type, confidence: data.confidence }, 'IntentRouter');
  }

  _trackToolUsage(data) {
    const name = data.name || 'unknown';
    if (!this._metrics.toolUsage[name]) {
      this._metrics.toolUsage[name] = { calls: 0, successes: 0, failures: 0 };
    }
    const t = this._metrics.toolUsage[name];
    t.calls++;
    if (data.success) t.successes++;
    else t.failures++;
  }

  _trackError(response, intent) {
    const errorMsg = response.slice(0, 150);
    this.es?.append('ERROR_OCCURRED', { message: errorMsg, context: 'chat', intent }, 'ChatOrchestrator');

    const existing = this._metrics.errorPatterns.find(e =>
      e.message === errorMsg || this._stringSimilarity(e.message, errorMsg) > 0.7
    );
    if (existing) {
      existing.count++;
      existing.lastSeen = Date.now();
    } else {
      this._metrics.errorPatterns.push({ message: errorMsg, intent, count: 1, lastSeen: Date.now() });
      if (this._metrics.errorPatterns.length > 50) {
        this._metrics.errorPatterns.sort((a, b) => b.count - a.count);
        this._metrics.errorPatterns = this._metrics.errorPatterns.slice(0, 30);
      }
    }
  }

  // ════════════════════════════════════════════════════════
  // PATTERN DETECTION
  // ════════════════════════════════════════════════════════

  _trackIntentSequence(intent) {
    if (!intent) return;
    this._recentIntentSequence.push(intent);
    if (this._recentIntentSequence.length > this._maxSequenceLen) {
      this._recentIntentSequence.shift();
    }

    // Check for repeating subsequences (length 2-4)
    for (let len = 2; len <= 4; len++) {
      if (this._recentIntentSequence.length < len * 2) continue;
      const recent = this._recentIntentSequence.slice(-len);
      const before = this._recentIntentSequence.slice(-(len * 2), -len);
      if (JSON.stringify(recent) === JSON.stringify(before)) {
        this._recordPattern(recent);
      }
    }
  }

  _recordPattern(sequence) {
    const key = sequence.join(' \u2192 ');
    const existing = this._detectedPatterns.find(p => p.key === key);
    if (existing) {
      existing.count++;
      existing.lastSeen = Date.now();
    } else {
      this._detectedPatterns.push({ key, sequence: [...sequence], count: 1, lastSeen: Date.now() });
    }

    // Emit skill suggestion at 5x, 10x, 15x ...
    if (existing && existing.count >= 5 && existing.count % 5 === 0) {
      this.bus.emit('learning:pattern-detected', {
        pattern: key, count: existing.count,
        suggestion: `Wiederkehrendes Muster: ${key} (${existing.count}x). Skill-Kandidat?`,
      }, { source: 'LearningService' });
    }
  }

  // ════════════════════════════════════════════════════════
  // DEEPER FACT & PREFERENCE EXTRACTION
  // ════════════════════════════════════════════════════════

  _extractFacts(message) {
    for (const { regex, key } of this.factPatterns) {
      const match = message.match(regex);
      if (match) {
        const value = match[1].trim();
        // v7.2.8: Skip stop words for role patterns ("ich bin oft" → skip "oft")
        if (key === 'user.role' && (STOP_WORDS.has(value.toLowerCase()) || value.length < 3)) continue;
        this.memory?.learnFact(key, value, 0.85, 'conversation');
        if (this.kg) {
          const type = key.startsWith('user.') ? 'preference' : 'fact';
          this.kg.addNode(type, `${key}: ${value}`, { source: 'conversation', key, value });
        }
      }
    }
  }

  _extractPreferences(message) {
    if (!this.memory) return;
    if (/(?:bitte|immer|am liebsten|bevorzug|prefer|always)/i.test(message)) {
      this.memory.learnFact(`pref.implicit.${Date.now()}`, message.slice(0, 200), 0.6, 'implicit-preference');
    }
  }

  // ════════════════════════════════════════════════════════
  // FRUSTRATION & MISCLASSIFICATION DETECTION
  // ════════════════════════════════════════════════════════

  _detectFrustration(message, intent) {
    this._recentMessages.push({ message: message.slice(0, 200), intent, ts: Date.now() });
    if (this._recentMessages.length > 10) this._recentMessages.shift();

    if (this._recentMessages.length >= 3) {
      const last3 = this._recentMessages.slice(-3);
      const similarities = [];
      for (let i = 0; i < last3.length - 1; i++) {
        similarities.push(this._stringSimilarity(last3[i].message, last3[i + 1].message));
      }
      const avgSim = similarities.reduce((a, b) => a + b, 0) / similarities.length;
      if (avgSim > 0.6) {
        this.bus.emit('learning:frustration-detected', {
          similarity: avgSim, intent,
          message: `User wiederholt sich (${Math.round(avgSim * 100)}% Aehnlichkeit).`,
        }, { source: 'LearningService' });
      }
    }
  }

  // FIX v6.1.1: Detect when Genesis admits inability — signal to Daemon for skill creation
  _detectCapabilityGap(message, response) {
    if (!response) return;
    const cannotPhrases = [
      /(?:kann ich nicht|nicht möglich|habe keinen zugriff|nicht in der lage)/i,
      /(?:I cannot|not possible|I don't have|unable to|I can't)/i,
      /(?:nicht unterstützt|not supported|no access to)/i,
    ];
    const isAdmission = cannotPhrases.some(p => p.test(response));
    if (isAdmission && message.length > 10) {
      this.bus.emit('learning:capability-gap', {
        userRequest: message.slice(0, 200),
        response: response.slice(0, 200),
        timestamp: Date.now(),
      }, { source: 'LearningService' });
    }
  }

  _trackLLMFallback(data) {
    this._llmFallbacks.push({ message: data.message, intent: data.intent, ts: Date.now() });
    if (this._llmFallbacks.length > 100) this._llmFallbacks.shift();

    const intentFallbacks = this._llmFallbacks.filter(f => f.intent === data.intent);
    if (intentFallbacks.length >= 5 && intentFallbacks.length % 5 === 0) {
      this.bus.emit('learning:intent-suggestion', {
        intent: data.intent, count: intentFallbacks.length,
        examples: intentFallbacks.slice(-3).map(f => f.message),
        suggestion: `Intent "${data.intent}" braucht ${intentFallbacks.length}x LLM-Fallback. Neue Regex empfohlen.`,
      }, { source: 'LearningService' });
    }
  }

  // ════════════════════════════════════════════════════════
  // METRICS API
  // ════════════════════════════════════════════════════════

  getMetrics() {
    const intentSummary = {};
    for (const [name, m] of Object.entries(this._metrics.intents)) {
      intentSummary[name] = {
        total: m.total,
        successRate: m.total > 0 ? Math.round((m.success / m.total) * 100) : 0,
        trend: this._getTrend(m.recentOutcomes),
      };
    }
    return {
      intents: intentSummary,
      toolUsage: this._metrics.toolUsage,
      topErrors: this._metrics.errorPatterns.slice(0, 5),
      detectedPatterns: this._detectedPatterns.filter(p => p.count >= 3),
      llmFallbackCount: this._llmFallbacks.length,
    };
  }

  /** Insights for PromptBuilder to include in system prompt */
  getInsightsForPrompt() {
    const parts = [];
    const weak = Object.entries(this._metrics.intents)
      .filter(([, m]) => m.total >= 3 && (m.success / m.total) < 0.6);
    if (weak.length > 0) {
      parts.push('LERNHINWEIS — Schwache Bereiche: ' +
        weak.map(([n, m]) => `${n} (${Math.round(m.success / m.total * 100)}%)`).join(', '));
    }
    const topErrors = this._metrics.errorPatterns.filter(e => e.count >= 3).slice(0, 3);
    if (topErrors.length > 0) {
      parts.push('HAEUFIGE FEHLER: ' + topErrors.map(e => `"${e.message.slice(0, 50)}..." (${e.count}x)`).join('; '));
    }
    return parts.join('\n');
  }

  // ── Helpers ──────────────────────────────────────────────

  _getTrend(outcomes) {
    if (!outcomes || outcomes.length < 5) return 'insufficient_data';
    const first5 = outcomes.slice(0, 5).filter(o => o.success).length / 5;
    const last5 = outcomes.slice(-5).filter(o => o.success).length / 5;
    if (last5 > first5 + 0.2) return 'improving';
    if (last5 < first5 - 0.2) return 'declining';
    return 'stable';
  }

  _stringSimilarity(a, b) {
    if (!a || !b) return 0;
    const wordsA = new Set(a.toLowerCase().split(/\s+/));
    const wordsB = new Set(b.toLowerCase().split(/\s+/));
    const intersection = [...wordsA].filter(w => wordsB.has(w)).length;
    const union = new Set([...wordsA, ...wordsB]).size;
    return union > 0 ? intersection / union : 0;
  }

  _loadMetrics() {
    try {
      if (this.storage) {
        const data = this.storage.readJSON('learning-metrics.json', null);
        if (data) this._metrics = { ...this._metrics, ...data };
      }
    } catch (err) { _log.debug('[LEARNING] Metrics load failed:', err.message); }
  }

  _saveMetrics() {
    try {
      if (this.storage) this.storage.writeJSONDebounced('learning-metrics.json', this._metrics);
    } catch (err) { _log.debug('[LEARNING] Metrics save failed:', err.message); }
  }

  /** FIX v5.1.0 (C-1): Sync write for shutdown. */
  _saveMetricsSync() {
    try {
      if (this.storage) this.storage.writeJSON('learning-metrics.json', this._metrics);
    } catch (err) { _log.debug('[LEARNING] Sync metrics save failed:', err.message); }
  }
}

applySubscriptionHelper(LearningService);

module.exports = { LearningService };
