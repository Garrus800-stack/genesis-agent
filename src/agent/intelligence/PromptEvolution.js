// @ts-checked-v5.6
// ============================================================
// GENESIS — PromptEvolution.js (v5.2.0)
//
// A/B testing for PromptBuilder template sections.
// MetaLearning tracks success rates per prompt style.
// PromptEvolution takes this further: it generates alternative
// phrasings for prompt sections, measures their impact via
// MetaLearning outcomes, and auto-promotes winners.
//
// DESIGN PRINCIPLES:
// 1. Conservative — only 1 mutation active at a time
// 2. Reversible — original always available for rollback
// 3. Signed — all mutations signed by ModuleSigner
// 4. Observable — every decision logged to EventStore
//
// HOW IT WORKS:
// 1. PromptEvolution picks a section (e.g. 'formatting')
// 2. Generates a variant phrasing via LLM
// 3. Alternates between control (original) and variant
// 4. After N trials, compares success rates
// 5. If variant wins by >5%: promote. If loses: discard.
// 6. If inconclusive after 2N trials: discard (bias toward stability)
//
// INTEGRATION:
// - PromptBuilder calls getSection(name) instead of hardcoded text
// - MetaLearning.recordOutcome() now includes activeVariant metadata
// - ModuleSigner signs variant definitions for tamper detection
// ============================================================

const { NullBus } = require('../core/EventBus');
const { createLogger } = require('../core/Logger');
const _log = createLogger('PromptEvolution');

// Sections eligible for evolution (identity/safety are immutable)
const EVOLVABLE_SECTIONS = new Set([
  'formatting', 'capabilities', 'learning', 'solutions',
  'metacognition', 'anticipator', 'optimizer', 'organism',
]);

// Minimum trials per arm before evaluation
const MIN_TRIALS_PER_ARM = 25;
// Maximum trials before forced decision
const MAX_TRIALS_TOTAL = 100;
// Required improvement to promote (5 percentage points)
const PROMOTION_THRESHOLD = 0.05;
// Maximum concurrent experiments (always 1 for clean measurement)
const MAX_ACTIVE_EXPERIMENTS = 1;

class PromptEvolution {
  static containerConfig = {
    name: 'promptEvolution',
    phase: 9,
    deps: ['storage', 'metaLearning'],
    tags: ['cognitive', 'learning'],
    lateBindings: ['moduleSigner', 'model'],
  };

  constructor({ bus, storage, metaLearning }) {
    this.bus = bus || NullBus;
    this.storage = storage;
    this.metaLearning = metaLearning;

    // Late-bound
    this.moduleSigner = null;
    this.model = null;

    // ── State ───────────────────────────────────────────
    this._experiments = {};      // sectionName → Experiment
    this._promotedVariants = {}; // sectionName → { text, promotedAt, generation }
    this._history = [];          // Completed experiments log
    this._generation = 0;       // Monotonic counter for variant versions
    this._enabled = true;
  }

  // ════════════════════════════════════════════════════════
  // LIFECYCLE
  // ════════════════════════════════════════════════════════

  async asyncLoad() {
    try {
      const data = await this.storage?.readJSON('prompt-evolution.json');
      if (data) {
        this._promotedVariants = data.promotedVariants || {};
        this._history = data.history || [];
        this._generation = data.generation || 0;
        this._enabled = data.enabled !== false;
        _log.info(`[PROMPT-EVO] Loaded: ${Object.keys(this._promotedVariants).length} promoted variants, gen ${this._generation}`);
      }
    } catch (_e) { /* first run */ }
  }

  _save() {
    this.storage?.writeJSONDebounced('prompt-evolution.json', {
      promotedVariants: this._promotedVariants,
      history: this._history.slice(-200),
      generation: this._generation,
      enabled: this._enabled,
    });
  }

  _saveSync() {
    this.storage?.writeJSON('prompt-evolution.json', {
      promotedVariants: this._promotedVariants,
      history: this._history.slice(-200),
      generation: this._generation,
      enabled: this._enabled,
    });
  }

  stop() {
    this._saveSync();
  }

  // ════════════════════════════════════════════════════════
  // PUBLIC API — Used by PromptBuilder
  // ════════════════════════════════════════════════════════

  /**
   * Get the active text for a prompt section.
   * Returns variant text if an experiment is active, otherwise
   * promoted text if available, otherwise null (use default).
   *
   * @param {string} sectionName - e.g. 'formatting'
   * @param {string} defaultText - PromptBuilder's default text
   * @returns {{ text: string, variantId: string|null }}
   */
  getSection(sectionName, defaultText) {
    if (!this._enabled || !EVOLVABLE_SECTIONS.has(sectionName)) {
      return { text: defaultText, variantId: null };
    }

    // Active experiment?
    const exp = this._experiments[sectionName];
    if (exp && exp.status === 'running') {
      // Alternate: even trial → control, odd trial → variant
      const totalTrials = exp.controlTrials + exp.variantTrials;
      const useVariant = totalTrials % 2 === 1;
      const text = useVariant ? exp.variantText : exp.controlText;
      const variantId = useVariant ? exp.variantId : null;
      return { text, variantId };
    }

    // Promoted variant?
    const promoted = this._promotedVariants[sectionName];
    if (promoted) {
      return { text: promoted.text, variantId: `promoted-${sectionName}-gen${promoted.generation}` };
    }

    return { text: defaultText, variantId: null };
  }

  /**
   * Record the outcome of a prompt that used a section variant.
   * Called by MetaLearning after outcome recording.
   *
   * @param {string} sectionName
   * @param {string|null} variantId - null = control arm
   * @param {boolean} success
   */
  recordOutcome(sectionName, variantId, success) {
    const exp = this._experiments[sectionName];
    if (!exp || exp.status !== 'running') return;

    if (variantId) {
      exp.variantTrials++;
      if (success) exp.variantSuccesses++;
    } else {
      exp.controlTrials++;
      if (success) exp.controlSuccesses++;
    }

    // Check if experiment is ready for evaluation
    const totalTrials = exp.controlTrials + exp.variantTrials;
    if (exp.controlTrials >= MIN_TRIALS_PER_ARM && exp.variantTrials >= MIN_TRIALS_PER_ARM) {
      this._evaluateExperiment(sectionName);
    } else if (totalTrials >= MAX_TRIALS_TOTAL) {
      // Forced evaluation — inconclusive → discard (bias toward stability)
      this._evaluateExperiment(sectionName);
    }
  }

  // ════════════════════════════════════════════════════════
  // EXPERIMENT MANAGEMENT
  // ════════════════════════════════════════════════════════

  /**
   * Start a new experiment for a section.
   * Generates a variant phrasing via LLM, signs it, and begins alternating.
   *
   * @param {string} sectionName
   * @param {string} currentText - Current section text
   * @param {string} [hypothesis] - Optional: what improvement to try
   * @returns {Promise<object|null>} Experiment descriptor, or null if not started
   */
  async startExperiment(sectionName, currentText, hypothesis) {
    if (!this._enabled) return null;
    if (!EVOLVABLE_SECTIONS.has(sectionName)) {
      _log.warn(`[PROMPT-EVO] Section "${sectionName}" is not evolvable`);
      return null;
    }
    if (this._experiments[sectionName]?.status === 'running') {
      _log.debug(`[PROMPT-EVO] Experiment already running for "${sectionName}"`);
      return null;
    }

    // Enforce max concurrent experiments
    const activeCount = Object.values(this._experiments).filter(e => e.status === 'running').length;
    if (activeCount >= MAX_ACTIVE_EXPERIMENTS) {
      _log.debug(`[PROMPT-EVO] Max concurrent experiments reached (${MAX_ACTIVE_EXPERIMENTS})`);
      return null;
    }

    // Generate variant via LLM
    const variantText = await this._generateVariant(sectionName, currentText, hypothesis);
    if (!variantText || variantText === currentText) {
      _log.debug(`[PROMPT-EVO] No valid variant generated for "${sectionName}"`);
      return null;
    }

    this._generation++;
    const variantId = `${sectionName}-gen${this._generation}`;

    const experiment = {
      sectionName,
      variantId,
      controlText: currentText,
      variantText,
      hypothesis: hypothesis || 'auto-generated improvement',
      status: 'running',
      startedAt: Date.now(),
      controlTrials: 0,
      controlSuccesses: 0,
      variantTrials: 0,
      variantSuccesses: 0,
      generation: this._generation,
    };

    // Sign variant if signer available
    if (this.moduleSigner) {
      try {
        experiment.signature = this.moduleSigner.signContent(variantText, {
          type: 'prompt-variant',
          section: sectionName,
          generation: this._generation,
        });
      } catch (err) {
        _log.warn(`[PROMPT-EVO] Could not sign variant: ${err.message}`);
      }
    }

    this._experiments[sectionName] = experiment;
    this._save();

    this.bus.emit('prompt-evolution:experiment-started', {
      section: sectionName,
      variantId,
      hypothesis: experiment.hypothesis,
      generation: this._generation,
    }, { source: 'PromptEvolution' });

    _log.info(`[PROMPT-EVO] Experiment started: ${variantId} — "${experiment.hypothesis}"`);
    return experiment;
  }

  /**
   * Evaluate an experiment and decide: promote, discard, or continue.
   */
  _evaluateExperiment(sectionName) {
    const exp = this._experiments[sectionName];
    if (!exp) return;

    const controlRate = exp.controlTrials > 0
      ? exp.controlSuccesses / exp.controlTrials : 0;
    const variantRate = exp.variantTrials > 0
      ? exp.variantSuccesses / exp.variantTrials : 0;
    const improvement = variantRate - controlRate;

    let decision;
    if (improvement >= PROMOTION_THRESHOLD) {
      decision = 'promote';
      this._promotedVariants[sectionName] = {
        text: exp.variantText,
        promotedAt: Date.now(),
        generation: exp.generation,
        improvement: Math.round(improvement * 100),
        controlRate: Math.round(controlRate * 100),
        variantRate: Math.round(variantRate * 100),
      };
      _log.info(`[PROMPT-EVO] ✓ PROMOTED: ${exp.variantId} (+${Math.round(improvement * 100)}%: ${Math.round(controlRate * 100)}% → ${Math.round(variantRate * 100)}%)`);
    } else if (improvement <= -PROMOTION_THRESHOLD) {
      decision = 'discard-worse';
      _log.info(`[PROMPT-EVO] ✗ DISCARDED (worse): ${exp.variantId} (${Math.round(improvement * 100)}%)`);
    } else {
      decision = 'discard-inconclusive';
      _log.info(`[PROMPT-EVO] ~ DISCARDED (inconclusive): ${exp.variantId} (${Math.round(improvement * 100)}%)`);
    }

    exp.status = 'completed';
    exp.decision = decision;
    exp.completedAt = Date.now();
    exp.controlRate = Math.round(controlRate * 100);
    exp.variantRate = Math.round(variantRate * 100);
    exp.improvement = Math.round(improvement * 100);

    this._history.push({ ...exp, controlText: undefined, variantText: undefined }); // Don't store full text in history
    delete this._experiments[sectionName];
    this._save();

    this.bus.emit('prompt-evolution:experiment-completed', {
      section: sectionName,
      variantId: exp.variantId,
      decision,
      controlRate: exp.controlRate,
      variantRate: exp.variantRate,
      improvement: exp.improvement,
    }, { source: 'PromptEvolution' });

    // v7.1.6: Emit promoted event for LessonsStore capture
    if (decision === 'promote') {
      this.bus.emit('prompt-evolution:promoted', {
        section: sectionName,
        variantId: exp.variantId,
        improvement: exp.improvement,
        generation: exp.generation,
      }, { source: 'PromptEvolution' });
    }
  }

  /**
   * Generate a variant phrasing for a prompt section via LLM.
   * The LLM is asked to improve clarity, conciseness, or effectiveness.
   */
  async _generateVariant(sectionName, currentText, hypothesis) {
    if (!this.model) {
      _log.debug('[PROMPT-EVO] No model available for variant generation');
      return null;
    }

    const systemPrompt = [
      'You are a prompt engineering assistant.',
      'Your task: rewrite a system prompt section to be more effective.',
      'Rules:',
      '- Keep the same intent and meaning',
      '- Be more concise OR more precise — pick one',
      '- Do NOT add new instructions not in the original',
      '- Do NOT remove safety-relevant instructions',
      '- Output ONLY the rewritten text, no explanation',
      '- Keep similar length (±30%)',
    ].join('\n');

    const userMsg = hypothesis
      ? `Rewrite this "${sectionName}" section. Goal: ${hypothesis}\n\nCurrent:\n${currentText}`
      : `Rewrite this "${sectionName}" section to be more effective:\n\n${currentText}`;

    try {
      const result = await this.model.chat(systemPrompt, [{ role: 'user', content: userMsg }], 0.4);
      const variant = (result?.text || result || '').trim();

      // Sanity checks
      if (!variant || variant.length < 20) return null;
      if (variant.length > currentText.length * 1.5) return null; // Too long
      if (variant.length < currentText.length * 0.3) return null; // Too short
      if (variant === currentText) return null;

      return variant;
    } catch (err) {
      _log.debug(`[PROMPT-EVO] Variant generation failed: ${err.message}`);
      return null;
    }
  }

  // ════════════════════════════════════════════════════════
  // ADMIN API
  // ════════════════════════════════════════════════════════

  /** Rollback a promoted variant to the default */
  rollback(sectionName) {
    if (this._promotedVariants[sectionName]) {
      const old = this._promotedVariants[sectionName];
      delete this._promotedVariants[sectionName];
      this._save();
      _log.info(`[PROMPT-EVO] Rolled back "${sectionName}" gen${old.generation}`);
      this.bus.emit('prompt-evolution:rollback', { section: sectionName, generation: old.generation }, { source: 'PromptEvolution' });
      return true;
    }
    return false;
  }

  /** Cancel a running experiment */
  cancelExperiment(sectionName) {
    const exp = this._experiments[sectionName];
    if (exp?.status === 'running') {
      exp.status = 'cancelled';
      this._history.push({ ...exp, controlText: undefined, variantText: undefined });
      delete this._experiments[sectionName];
      this._save();
      return true;
    }
    return false;
  }

  /** Get full status */
  getStatus() {
    return {
      enabled: this._enabled,
      generation: this._generation,
      activeExperiments: Object.keys(this._experiments),
      promotedSections: Object.keys(this._promotedVariants),
      experiments: { ...this._experiments },
      promotedVariants: { ...this._promotedVariants },
      historyCount: this._history.length,
      recentHistory: this._history.slice(-10),
    };
  }

  /** Enable/disable the system */
  setEnabled(enabled) {
    this._enabled = enabled;
    this._save();
  }

  /** Build prompt context (for PromptBuilder consciousness injection) */
  buildPromptContext() {
    const active = Object.keys(this._experiments).filter(k => this._experiments[k]?.status === 'running');
    if (active.length === 0) return '';
    return `[PROMPT-EVO] Active experiment: ${active.join(', ')}. Variant arm may be active — observe quality.`;
  }
}

module.exports = { PromptEvolution, EVOLVABLE_SECTIONS, MIN_TRIALS_PER_ARM };
