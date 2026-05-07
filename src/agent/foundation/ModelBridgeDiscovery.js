// ============================================================
// GENESIS — ModelBridgeDiscovery.js (v7.5.7)
//
// Model discovery + ranking — extracted from ModelBridge to keep
// the parent file under the architectural-fitness LOC limit. Same
// mixin pattern as ModelBridgeAvailability.js (v7.5.6).
//
// Responsibilities:
//   - detectAvailable(): query all configured backends, build the
//     activeModel/activeBackend with a 4-priority selection
//     (preferred → cloud → ranked → first-available)
//   - _scoreModel(name): tier-based capability score for a model
//     name; falls back to size-based scoring for unknown models
//   - _selectBestModel(models): pick highest-scored model from a list
//   - getRankedModels(): the available list sorted by score, with
//     tier note and active flag
//
// Wired into ModelBridge.prototype via Object.assign at the bottom
// of ModelBridge.js.
// ============================================================

'use strict';

const { createLogger } = require('../core/Logger');
const _log = createLogger('ModelBridge');

// ── v6.0.5: Smart Model Ranking ─────────────────────────────
// Models are scored by known capability tiers. This replaces the
// blind "first available" selection that picked minimax-m2.7.
//
// Scoring: higher = better. Patterns matched against model name.
// Unknown models get a neutral score (50) — never penalized.
//
// Module-private constant. Pre-v7.5.7 this was `ModelBridge.MODEL_TIERS`
// (static class property); moved here together with the methods that
// reference it. No external code referenced ModelBridge.MODEL_TIERS, so
// the move is internal-only.

/** @type {Array<{pattern: RegExp, score: number, note: string}>} */
const MODEL_TIERS = [
  // Tier 1: Known excellent code models (score 90-100)
  { pattern: /claude/i,                          score: 100, note: 'Anthropic Claude' },
  { pattern: /gpt-4o|gpt-4-turbo/i,             score: 95,  note: 'OpenAI GPT-4' },
  { pattern: /deepseek-coder|deepseek-v[23]/i,   score: 92,  note: 'DeepSeek Coder' },
  { pattern: /qwen-?2\.5.*(?:72|32|14)b/i,       score: 90,  note: 'Qwen 2.5 large' },
  { pattern: /qwen-?3.*coder/i,                  score: 90,  note: 'Qwen 3 Coder' },
  { pattern: /qwen-?3(?!.*vl).*(?:235|110|32)b/i, score: 89, note: 'Qwen 3 large' },
  { pattern: /kimi-k2/i,                         score: 88,  note: 'Kimi K2' },
  { pattern: /llama-?3.*(?:70|405)b/i,           score: 88,  note: 'Llama 3 large' },
  { pattern: /dolphin.*(?:70|405)b/i,            score: 87,  note: 'Dolphin large' },
  { pattern: /codellama|code-?llama/i,           score: 85,  note: 'Code Llama' },
  { pattern: /wizard.*coder/i,                   score: 85,  note: 'WizardCoder' },

  // Tier 2: Good general models (score 70-84)
  { pattern: /qwen-?2\.5.*(?:7b|3b)/i,          score: 80,  note: 'Qwen 2.5 medium' },
  { pattern: /qwen-?3(?!.*coder).*(?:8|14)b/i,  score: 80,  note: 'Qwen 3 medium' },
  { pattern: /llama-?3.*8b/i,                    score: 78,  note: 'Llama 3 8B' },
  { pattern: /llama-?3(?::latest)?$/i,           score: 78,  note: 'Llama 3' },
  { pattern: /dolphin.*(?:8b)/i,                 score: 77,  note: 'Dolphin 8B' },
  { pattern: /gemma-?2/i,                        score: 78,  note: 'Gemma 2' },
  { pattern: /mistral.*nemo/i,                   score: 76,  note: 'Mistral Nemo' },
  { pattern: /mistral(?::latest)?$/i,            score: 75,  note: 'Mistral' },
  { pattern: /mistral.*(?:7b)/i,                 score: 75,  note: 'Mistral 7B' },
  { pattern: /phi-?[34]/i,                       score: 75,  note: 'Microsoft Phi' },
  { pattern: /qwen-?3.*vl/i,                     score: 74,  note: 'Qwen 3 Vision (limited code)' },
  { pattern: /llama-?3\.2/i,                     score: 73,  note: 'Llama 3.2' },
  { pattern: /yi-/i,                             score: 72,  note: 'Yi' },
  { pattern: /command-r/i,                       score: 70,  note: 'Cohere Command-R' },
  { pattern: /glm-?4/i,                          score: 70,  note: 'GLM-4' },
  { pattern: /wizard.*(?:30|13)b/i,              score: 70,  note: 'Wizard large' },

  // Tier 3: Smaller / older models (score 40-69)
  { pattern: /qwen-?2\.5.*(?:1\.5|0\.5)b/i,     score: 60,  note: 'Qwen 2.5 small' },
  { pattern: /llama-?2/i,                        score: 55,  note: 'Llama 2 (older)' },
  { pattern: /vicuna|wizard(?!.*coder)/i,        score: 55,  note: 'Vicuna/Wizard' },
  { pattern: /gemma.*2b/i,                       score: 50,  note: 'Gemma 2B (small)' },
  { pattern: /tinyllama|phi-?2|orca-?mini|stablelm/i, score: 40, note: 'Tiny model' },

  // Tier 4: Known weak for code tasks (score 10-39)
  { pattern: /gpt-oss/i,                         score: 20,  note: 'GPT-OSS (unstable)' },
  { pattern: /minimax/i,                         score: 15,  note: 'MiniMax (weak at code)' },
];

// ── Mixin object ────────────────────────────────────────────

const discovery = {
  /**
   * Query all configured backends for available models, then pick an
   * activeModel/activeBackend with 4-priority selection:
   *   1. user-preferred (from settings)
   *   2. cloud backend (anthropic / openai)
   *   3. ranked-best by capability score
   *   4. first-available (last resort)
   *
   * Models marked unavailable (auth/rate-limit/timeout TTL) are
   * skipped at every priority. If a previously-selected model still
   * exists in the refreshed list, it is kept (prevents periodic
   * health-check from resetting user selection).
   *
   * Mixin method — depends on:
   *   - this.activeModel / this.activeBackend (instance state)
   *   - this.availableModels (instance state)
   *   - this.backends.{ollama, anthropic, openai} (constructor-injected)
   *   - this.bus (constructor-injected event bus)
   *   - this._settings (constructor-injected Settings)
   *   - this.isMarkedUnavailable() / this._warnIfCloudWithoutFallback()
   *     (provided by ModelBridgeAvailability mixin)
   */
  async detectAvailable() {
    // FIX v4.10.0: Remember current user selection before refreshing list
    const previousModel = this.activeModel;
    const previousBackend = this.activeBackend;

    this.availableModels = [];

    // Ollama (local)
    try {
      const ollamaModels = await this.backends.ollama.listModels();
      this.availableModels.push(...ollamaModels);
    } catch (err) {
      _log.info('[MODEL] Ollama not available');
      this.bus.fire('model:ollama-unavailable', { error: err.message }, { source: 'ModelBridge' });
    }

    // Add cloud models if configured
    this.availableModels.push(...this.backends.anthropic.getModels());
    this.availableModels.push(...this.backends.openai.getModels());

    // FIX v4.10.0: If a model was already active AND it still exists in the
    // refreshed list, keep it. This prevents the periodic health check from
    // resetting the user's manual model selection every 5 minutes.
    if (previousModel) {
      const stillExists = this.availableModels.find(m => m.name === previousModel);
      if (stillExists) {
        this.activeModel = previousModel;
        this.activeBackend = previousBackend;
        _log.debug(`[MODEL] Kept user-selected model: ${previousModel}`);
        return this.availableModels;
      }
      // Previously selected model disappeared (e.g. Ollama stopped) — fall through to re-select
      _log.info(`[MODEL] Previously selected model "${previousModel}" no longer available, re-selecting...`);
    }

    // Set default model — v4.10.0: Settings-based + smart priority
    // 1. User-configured preferred model (Settings → models.preferred)
    // 2. Cloud backends (higher capability) before local
    // 3. First available as last resort
    // v7.5.6: All priorities skip models that are currently marked
    // unavailable (auth/rate-limit/timeout). Prevents Genesis from
    // re-selecting a known-broken model on every boot/refresh.
    if (this.availableModels.length > 0) {
      let chosen = null;

      // Priority 1: User-configured preferred model
      const preferredName = this._settings?.get?.('models.preferred') || null;
      if (preferredName) {
        if (this.isMarkedUnavailable(preferredName)) {
          _log.warn(`[MODEL] Preferred "${preferredName}" is marked unavailable — auto-selecting`);
        } else {
          // Exact match first, then partial match (handles tag variations like :latest vs :cloud)
          chosen = this.availableModels.find(m => m.name === preferredName)
                || this.availableModels.find(m => m.name.startsWith(preferredName.split(':')[0]) && m.name.includes(preferredName.split(':')[1] || ''));
          if (chosen) {
            _log.info(`[MODEL] Using preferred model from settings: ${chosen.name}`);
            // v7.5.7-fix: warn if cloud-preferred without fallback-chain
            this._warnIfCloudWithoutFallback(chosen);
          } else {
            _log.warn(`[MODEL] Preferred model "${preferredName}" not found in ${this.availableModels.length} available models`);
          }
        }
      }

      // Priority 2: Cloud backends (configured = user actively chose them)
      if (!chosen) {
        chosen = this.availableModels.find(m => m.backend === 'anthropic' && !this.isMarkedUnavailable(m.name))
              || this.availableModels.find(m => m.backend === 'openai' && !this.isMarkedUnavailable(m.name));
        if (chosen) _log.info(`[MODEL] Auto-selected cloud model: ${chosen.name} (${chosen.backend})`);
      }

      // Priority 3: v6.0.5 — Smart model ranking by known capability
      // Instead of picking the first model Ollama returns (which is alphabetical
      // and often a weak model like minimax-m2.7), rank by known quality tiers.
      if (!chosen) {
        const eligible = this.availableModels.filter(m => !this.isMarkedUnavailable(m.name));
        chosen = this._selectBestModel(eligible);
        if (chosen) _log.info(`[MODEL] Auto-selected best available: ${chosen.name} (score: ${this._scoreModel(chosen.name)})`);
      }

      // Priority 4: Absolute fallback — first available (gefiltert; wenn alle markiert → letzter Resort)
      if (!chosen) {
        const eligible = this.availableModels.filter(m => !this.isMarkedUnavailable(m.name));
        chosen = eligible[0] || this.availableModels[0];
        _log.info(`[MODEL] Using first available model: ${chosen.name} (${chosen.backend})`);
      }

      this.activeModel = chosen.name;
      this.activeBackend = chosen.backend;
    } else {
      this.bus.fire('model:no-models', {}, { source: 'ModelBridge' });
    }

    return this.availableModels;
  },

  /**
   * Score a model by name. Unknown models get size-based scoring.
   * @param {string} name
   * @returns {number}
   */
  _scoreModel(name) {
    for (const tier of MODEL_TIERS) {
      if (tier.pattern.test(name)) return tier.score;
    }
    // v6.0.5: Size-based fallback for unknown models.
    // Larger models are generally more capable — score by parameter count.
    const sizeMatch = name.match(/(\d+)b/i);
    if (sizeMatch) {
      const params = parseInt(sizeMatch[1], 10);
      if (params >= 70)  return 65; // Large unknown model — probably decent
      if (params >= 13)  return 55; // Medium unknown model
      if (params >= 7)   return 50; // Small-medium
      return 40;                     // Small unknown model
    }
    return 50; // No size info — neutral
  },

  /**
   * Select the best model from a list by score.
   * @param {Array<{name: string, backend: string}>} models
   * @returns {object|null}
   */
  _selectBestModel(models) {
    if (!models || models.length === 0) return null;
    let best = null;
    let bestScore = -1;
    for (const m of models) {
      const score = this._scoreModel(m.name);
      if (score > bestScore) {
        best = m;
        bestScore = score;
      }
    }
    return best;
  },

  /**
   * Get a ranked list of available models with scores.
   * @returns {Array<{name: string, backend: string, score: number, note: string}>}
   */
  getRankedModels() {
    return this.availableModels
      .map(m => {
        const score = this._scoreModel(m.name);
        const tier = MODEL_TIERS.find(t => t.pattern.test(m.name));
        return { ...m, score, note: tier?.note || 'Unknown model', active: m.name === this.activeModel };
      })
      .sort((a, b) => b.score - a.score);
  },
};

module.exports = { discovery, MODEL_TIERS };
