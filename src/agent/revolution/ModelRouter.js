// @ts-checked-v5.7
// ============================================================
// GENESIS — ModelRouter.js (v3.5.0 — Cognitive Agent)
//
// SMART ROUTING: Small models for fast tasks, large models
// for complex reasoning. Automatically optimized by
// MetaLearning data.
//
// Routing strategy:
//   classification → prefer small (≤3B)  — fast intent detection
//   intent         → prefer small (≤3B)  — fast routing
//   code-gen       → prefer large (≥7B)  — needs reasoning
//   reasoning      → prefer large (≥7B)  — needs depth
//   analysis       → prefer large (≥7B)  — needs comprehension
//   planning       → prefer large (≥7B)  — needs decomposition
//   summarization  → prefer medium       — balanced
//   chat           → prefer medium       — balanced
//   embedding      → dedicated model     — separate pipeline
//
// Graceful fallback: if only 1 model → use it for everything.
// Scoring: size_match + meta_success_rate + latency_bonus
//
// Prerequisite: User has 2+ Ollama models installed.
// ============================================================

const { NullBus } = require('../core/EventBus');

class ModelRouter {
  constructor({ bus, modelBridge, metaLearning, worldState }) {
    this.bus = bus || NullBus;
    this.modelBridge = modelBridge;
    this.metaLearning = metaLearning;
    this.worldState = worldState;

    // v4.10.0: EmotionalSteering — set via late-binding
    this._emotionalSteering = null;

    // ── Routing Table ─────────────────────────────────────
    this.routes = {
      classification: { preferSize: 'small', maxParams: 3e9, weight: { speed: 3, accuracy: 1 } },
      intent:         { preferSize: 'small', maxParams: 3e9, weight: { speed: 3, accuracy: 1 } },
      'code-gen':     { preferSize: 'large', minParams: 7e9, weight: { speed: 1, accuracy: 3 } },
      reasoning:      { preferSize: 'large', minParams: 7e9, weight: { speed: 1, accuracy: 3 } },
      analysis:       { preferSize: 'large', minParams: 7e9, weight: { speed: 1, accuracy: 3 } },
      planning:       { preferSize: 'large', minParams: 7e9, weight: { speed: 1, accuracy: 3 } },
      summarization:  { preferSize: 'medium', weight: { speed: 2, accuracy: 2 } },
      chat:           { preferSize: 'medium', weight: { speed: 2, accuracy: 2 } },
      creative:       { preferSize: 'large', minParams: 7e9, weight: { speed: 1, accuracy: 2 } },
    };

    // ── Model Size Cache ──────────────────────────────────
    // Maps model name → estimated parameter count
    this._modelSizes = new Map();
    this._sizePatterns = [
      { pattern: /(\d+\.?\d*)b/i, extract: (m) => parseFloat(m[1]) * 1e9 },
      { pattern: /(\d+)m/i, extract: (m) => parseFloat(m[1]) * 1e6 },
    ];

    // ── Routing stats ─────────────────────────────────────
    this._stats = { routed: 0, fallbacks: 0 };

    // v6.0.2: Empirical strength data from CognitiveSelfModel via AdaptiveStrategy
    this._empiricalStrength = null;
    this._empiricalStrengthAt = 0;
  }

  // ════════════════════════════════════════════════════════
  // PUBLIC API
  // ════════════════════════════════════════════════════════

  /**
   * Select the best model for a task category.
   *
   * @param {string} taskCategory - 'code-gen'|'analysis'|'planning'|etc.
   * @returns {object}
   */
  route(taskCategory) {
    this._stats.routed++;
    const available = this._getAvailableModels();

    // v4.10.0: Check EmotionalSteering for model escalation
    let escalateToLarger = false;
    let suggestedPromptStyle = null;
    if (this._emotionalSteering) {
      try {
        const signals = this._emotionalSteering.getSignals();
        if (signals.modelEscalation) {
          escalateToLarger = true;
          this._stats.escalations = (this._stats.escalations || 0) + 1;
        }
        if (signals.suggestedPromptStyle) {
          suggestedPromptStyle = signals.suggestedPromptStyle;
        }
      } catch (_e) { console.debug('[catch] steering not available:', _e.message); }
    }

    // Fallback: only 1 model → use it
    if (available.length <= 1) {
      this._stats.fallbacks++;
      const model = available[0] || this.modelBridge?.activeModel || null;
      return { model, reason: 'Only one model available', score: 1, suggestedPromptStyle };
    }

    const routeConfig = this.routes[taskCategory] || this.routes.chat;

    // v4.10.0: If emotionally escalated, prefer larger models
    const effectiveConfig = escalateToLarger
      ? { ...routeConfig, preferSize: 'large', minParams: 7e9 }
      : routeConfig;

    // Score each model
    const scored = available.map(modelName => ({
      model: modelName,
      score: this._scoreModel(modelName, taskCategory, effectiveConfig),
    }));

    // Sort by score (highest first)
    scored.sort((a, b) => b.score - a.score);

    const best = scored[0];

    this.bus.emit('router:routed', {
      category: taskCategory,
      selected: best.model,
      score: Math.round(best.score * 100) / 100,
      candidates: scored.length,
      escalated: escalateToLarger,
    }, { source: 'ModelRouter' });

    return {
      model: best.model,
      reason: escalateToLarger
        ? `Escalated for ${taskCategory} (frustration high, score: ${Math.round(best.score * 100) / 100})`
        : `Best for ${taskCategory} (score: ${Math.round(best.score * 100) / 100})`,
      score: best.score,
      escalated: escalateToLarger,
      suggestedPromptStyle,
      alternatives: scored.slice(1, 3).map(s => ({ model: s.model, score: Math.round(s.score * 100) / 100 })),
    };
  }

  /**
   * Get model recommendation with the strategy from MetaLearning.
   * Combines model selection + prompt strategy.
   *
   * @param {string} taskCategory
   * @returns {object}
   */
  routeWithStrategy(taskCategory) {
    const routing = this.route(taskCategory);
    const strategy = this.metaLearning?.recommend(taskCategory, routing.model) || {};

    return {
      model: routing.model,
      promptStyle: strategy.promptStyle || 'free-text',
      temperature: strategy.temperature ?? 0.7,
      confidence: strategy.confidence || 0,
      successRate: strategy.successRate || null,
      reason: routing.reason,
    };
  }

  /**
   * v6.0.2: Inject empirical backend strength data from CognitiveSelfModel.
   * Called by AdaptiveStrategy when backend-mismatch bias detected.
   * Adds a scoring bonus to _scoreModel() based on real outcome data.
   *
   * @param {Record<string, {recommended: string, entries: Array<{backend: string, confidence: number}>}>} strengthMap
   */
  injectEmpiricalStrength(strengthMap) {
    this._empiricalStrength = strengthMap;
    this._empiricalStrengthAt = Date.now();
    this.bus.emit('router:empirical-strength-injected', {
      taskTypes: Object.keys(strengthMap).length,
    }, { source: 'ModelRouter' });
  }

  getStats() { return { ...this._stats }; }

  // ════════════════════════════════════════════════════════
  // SCORING
  // ════════════════════════════════════════════════════════

  _scoreModel(modelName, taskCategory, routeConfig) {
    let score = 0;
    const params = this._estimateParams(modelName);
    const weights = routeConfig.weight || { speed: 1, accuracy: 1 };

    // 1. Size match (does model size fit the task?)
    const sizeScore = this._scoreSizeMatch(params, routeConfig);
    score += sizeScore * 3;

    // 2. MetaLearning success rate (historical performance)
    if (this.metaLearning) {
      const rankings = this.metaLearning.getModelRankings(taskCategory);
      const ranking = rankings.find(r => r.model === modelName);
      if (ranking) {
        // Success rate (0-100) → 0-5 score
        score += (ranking.successRate / 100) * 5 * weights.accuracy;
        // Latency bonus for speed-sensitive tasks
        if (ranking.avgLatency > 0) {
          const latencyScore = Math.max(0, 1 - (ranking.avgLatency / 10000)); // 10s = 0 bonus
          score += latencyScore * 2 * weights.speed;
        }
      }
    }

    // 3. Active model bonus (avoids model switching overhead)
    if (this.modelBridge?.activeModel === modelName) {
      score += 1; // Small bonus for the already-loaded model
    }

    // 4. v6.0.2: Empirical strength bonus (from CognitiveSelfModel via AdaptiveStrategy)
    if (this._empiricalStrength && (Date.now() - this._empiricalStrengthAt < 7 * 86400_000)) {
      const rec = this._empiricalStrength[taskCategory];
      if (rec && rec.entries) {
        const entry = rec.entries.find(e =>
          e.backend === modelName || modelName.includes(e.backend)
        );
        if (entry) {
          score += entry.confidence * 0.3; // Max +0.3 bonus from empirical data
        }
      }
    }

    return score;
  }

  _scoreSizeMatch(params, routeConfig) {
    if (!params) return 0.5; // Unknown size → neutral

    switch (routeConfig.preferSize) {
      case 'small':
        if (routeConfig.maxParams && params <= routeConfig.maxParams) return 1;
        if (params <= 4e9) return 0.8;
        if (params <= 7e9) return 0.4;
        return 0.2; // Large model for small task → wasteful
      case 'large':
        if (routeConfig.minParams && params >= routeConfig.minParams) return 1;
        if (params >= 7e9) return 0.9;
        if (params >= 3e9) return 0.5;
        return 0.2; // Small model for complex task → risky
      case 'medium':
        if (params >= 3e9 && params <= 13e9) return 1;
        return 0.5;
      default:
        return 0.5;
    }
  }

  // ════════════════════════════════════════════════════════
  // HELPERS
  // ════════════════════════════════════════════════════════

  _getAvailableModels() {
    // From WorldState (preferred — live data)
    if (this.worldState) {
      const models = this.worldState.getAvailableModels();
      if (models && models.length > 0) return models;
    }

    // From ModelBridge (fallback)
    if (this.modelBridge?.availableModels) {
      return this.modelBridge.availableModels.map(m => m.name || m);
    }

    // Last resort: just the active model
    if (this.modelBridge?.activeModel) {
      return [this.modelBridge.activeModel];
    }

    return [];
  }

  _estimateParams(modelName) {
    // Cache check
    if (this._modelSizes.has(modelName)) {
      return this._modelSizes.get(modelName);
    }

    // Extract from model name (e.g., 'gemma2:9b' → 9e9)
    const lower = (modelName || '').toLowerCase();
    for (const { pattern, extract } of this._sizePatterns) {
      const match = lower.match(pattern);
      if (match) {
        const params = extract(match);
        this._modelSizes.set(modelName, params);
        return params;
      }
    }

    // Known models without explicit size in name
    const knownSizes = {
      'llama3': 8e9, 'llama3.1': 8e9, 'llama3.2': 3e9,
      'mistral': 7e9, 'mixtral': 47e9,
      'phi3': 3.8e9, 'phi3:mini': 3.8e9,
      'codellama': 7e9,
      'deepseek-coder': 6.7e9,
      'qwen2': 7e9, 'qwen2.5': 7e9,
    };

    // Try matching base name (strip :tag)
    const baseName = lower.split(':')[0];
    if (knownSizes[baseName]) {
      this._modelSizes.set(modelName, knownSizes[baseName]);
      return knownSizes[baseName];
    }

    return null; // Unknown
  }
}

module.exports = { ModelRouter };
