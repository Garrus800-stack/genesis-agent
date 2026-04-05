// ============================================================
// GENESIS — UserModel.js (Phase 10 — Agency Layer)
//
// Theory of Mind for machines. Genesis doesn't just respond to
// what the user SAYS — it maintains a model of what the user
// likely THINKS, WANTS, and FEELS based on interaction patterns.
//
// This is NOT sentiment analysis of individual messages.
// It's a persistent, evolving model of the human Genesis
// interacts with, built from observable signals:
//
//   Communication Style:
//     - verbosity (terse ↔ detailed)
//     - technicality (casual ↔ expert)
//     - directiveness (exploratory ↔ commanding)
//
//   Inferred State:
//     - patience (estimated from response timing, re-asks)
//     - satisfaction (from feedback patterns, conversation length)
//     - expertise (from vocabulary, question complexity)
//
//   Interaction Patterns:
//     - typical session length
//     - preferred response style
//     - topics of recurring interest
//
// Architecture:
//   chat:user-message    → UserModel.observe(message, metadata)
//   chat:completed       → UserModel.observeOutcome(feedback)
//   UserModel            → PromptBuilder (adaptation context)
//
// PERFORMANCE: Pure heuristics on cached state. ~0.2ms per update.
// No LLM calls. No external API calls.
// ============================================================

const { NullBus } = require('../core/EventBus');
const { createLogger } = require('../core/Logger');
const _log = createLogger('UserModel');

class UserModel {
  static containerConfig = {
    name: 'userModel',
    phase: 10,
    deps: ['storage'],
    tags: ['intelligence', 'social', 'theory-of-mind'],
    lateBindings: [],
  };

  constructor({ bus, storage, config }) {
    this.bus = bus || NullBus;
    this.storage = storage || null;

    const cfg = config || {};
    this._decayRate = cfg.decayRate || 0.02;    // How fast inferences decay
    this._minObservations = cfg.minObservations || 3; // Min data before inferring

    // ── User Profile (evolves over time) ─────────────────
    this._profile = {
      // Communication style (0-1 scales)
      verbosity: 0.5,      // 0=terse, 1=verbose
      technicality: 0.5,   // 0=casual, 1=expert
      directiveness: 0.5,  // 0=exploratory, 1=commanding

      // Inferred emotional state (0-1 scales, decaying)
      patience: 0.7,       // Decreases with re-asks, short messages
      satisfaction: 0.5,   // Increases with long sessions, positive feedback
      engagement: 0.5,     // Increases with rapid exchanges

      // Accumulated observations
      totalMessages: 0,
      avgMessageLength: 0,
      avgResponseGap: 0,   // Avg ms between user messages
      reaskCount: 0,       // Times user rephrased same question
      sessionCount: 0,
      topicsOfInterest: {},  // topic → frequency
    };

    this._lastMessageAt = 0;
    this._sessionStart = Date.now();
    this._sessionMessages = 0;
    this._recentLengths = [];       // Last 20 message lengths
    this._recentGaps = [];          // Last 20 response gaps
    this._maxRecent = 20;

    this._wireEvents();
  }

  // ════════════════════════════════════════════════════════════
  // LIFECYCLE
  // ════════════════════════════════════════════════════════════

  async asyncLoad() {
    if (!this.storage) return;
    try {
      const data = this.storage.readJSON('user-model.json', null);
      if (data?.profile) {
        this._profile = { ...this._profile, ...data.profile };
      }
    } catch (err) { _log.debug('[USER-MODEL] Load error:', err.message); }
  }

  start() {
    _log.info('[USER-MODEL] Active — tracking interaction patterns');
  }

  // FIX D-1: Sync write on shutdown.
  stop() { this._saveSync(); }

  // ════════════════════════════════════════════════════════════
  // OBSERVATION — pure heuristics, no LLM
  // ════════════════════════════════════════════════════════════

  /**
   * Observe a user message and update the model.
   * Called automatically via EventBus.
   */
  observe(message) {
    if (!message || typeof message !== 'string') return;
    const now = Date.now();
    const len = message.length;

    this._profile.totalMessages++;
    this._sessionMessages++;

    // ── Verbosity ─────────────────────────────────────────
    this._recentLengths.push(len);
    if (this._recentLengths.length > this._maxRecent) {
      this._recentLengths.shift();
    }
    const avgLen = this._recentLengths.reduce((a, b) => a + b, 0) / this._recentLengths.length;
    this._profile.avgMessageLength = Math.round(avgLen);
    // Normalize: <20 chars = terse (0.1), >500 chars = verbose (0.9)
    this._profile.verbosity = _lerp(this._profile.verbosity, Math.min(0.95, Math.max(0.05, (avgLen - 20) / 480)), 0.15);

    // ── Response gap → patience/engagement ────────────────
    if (this._lastMessageAt > 0) {
      const gap = now - this._lastMessageAt;
      this._recentGaps.push(gap);
      if (this._recentGaps.length > this._maxRecent) {
        this._recentGaps.shift();
      }
      const avgGap = this._recentGaps.reduce((a, b) => a + b, 0) / this._recentGaps.length;
      this._profile.avgResponseGap = Math.round(avgGap);

      // Fast responses = high engagement
      if (gap < 10000) {
        this._profile.engagement = _lerp(this._profile.engagement, 0.9, 0.1);
      } else if (gap > 120000) {
        this._profile.engagement = _lerp(this._profile.engagement, 0.2, 0.1);
      }
    }
    this._lastMessageAt = now;

    // ── Technicality ──────────────────────────────────────
    const techSignals = (message.match(/(?:function|class|const|let|var|import|async|await|API|SDK|CLI|regex|lambda|config|deploy|endpoint|schema|refactor|debug|stack\s?trace)/gi) || []).length;
    if (techSignals > 0) {
      this._profile.technicality = _lerp(this._profile.technicality, Math.min(0.95, 0.5 + techSignals * 0.1), 0.1);
    }

    // ── Directiveness ─────────────────────────────────────
    const commanding = /^(mach|bau|erstell|fix|schreib|zeig|gib|tu|do|make|build|create|fix|write|show|give|run|deploy|delete)\b/i.test(message.trim());
    const questioning = /\?\s*$/.test(message.trim()) || /^(was|wie|warum|wann|wo|wer|what|how|why|when|where|who|can|could|would|is|are|does|do)\b/i.test(message.trim());
    if (commanding) {
      this._profile.directiveness = _lerp(this._profile.directiveness, 0.85, 0.1);
    } else if (questioning) {
      this._profile.directiveness = _lerp(this._profile.directiveness, 0.25, 0.1);
    }

    // ── Re-ask detection → patience ───────────────────────
    // Simple heuristic: very short messages after a response
    // might indicate dissatisfaction
    if (len < 30 && this._sessionMessages > 2) {
      this._profile.patience = _lerp(this._profile.patience, this._profile.patience - 0.05, 0.3);
    }
  }

  /**
   * Observe the outcome of an interaction (positive/negative feedback).
   */
  observeOutcome(positive = true) {
    if (positive) {
      this._profile.satisfaction = _lerp(this._profile.satisfaction, 0.85, 0.15);
      this._profile.patience = _lerp(this._profile.patience, 0.8, 0.1);
    } else {
      this._profile.satisfaction = _lerp(this._profile.satisfaction, 0.2, 0.15);
      this._profile.patience = _lerp(this._profile.patience, this._profile.patience - 0.1, 0.3);
      this._profile.reaskCount++;
    }
  }

  // ════════════════════════════════════════════════════════════
  // PROMPT CONTEXT
  // ════════════════════════════════════════════════════════════

  /**
   * Build prompt context — tells the LLM how to adapt to this user.
   * Only emits when we have enough data and the profile is noteworthy.
   */
  buildPromptContext() {
    if (this._profile.totalMessages < this._minObservations) return '';

    const parts = ['USER-ADAPTATION:'];
    const p = this._profile;

    // Communication style hints
    if (p.verbosity < 0.25) {
      parts.push('User is terse — match their brevity. Short, direct answers.');
    } else if (p.verbosity > 0.75) {
      parts.push('User writes detailed messages — they appreciate thorough responses.');
    }

    if (p.technicality > 0.7) {
      parts.push('User is technically proficient — use precise terminology, skip basics.');
    } else if (p.technicality < 0.3) {
      parts.push('User prefers plain language — avoid jargon, explain concepts.');
    }

    if (p.directiveness > 0.7) {
      parts.push('User gives direct commands — execute efficiently, minimize discussion.');
    } else if (p.directiveness < 0.3) {
      parts.push('User is exploratory — offer options, explain trade-offs.');
    }

    // State warnings
    if (p.patience < 0.3) {
      parts.push('User patience is LOW — be concise, avoid repetition, get to the point.');
    }

    if (p.engagement > 0.8) {
      parts.push('User is highly engaged — maintain momentum.');
    }

    return parts.length > 1 ? parts.join('\n') : '';
  }

  /** Full diagnostic */
  getReport() {
    return { ...this._profile };
  }

  // ════════════════════════════════════════════════════════════
  // EVENT WIRING
  // ════════════════════════════════════════════════════════════

  _wireEvents() {
    // v4.12.5-fix: Was 'chat:user-message' — ChatOrchestrator emits 'user:message'.
    // BUT: 'user:message' only carries { length }, not the message text.
    // Use 'chat:completed' which carries { message, response, intent, success }
    // for observe() — this records user patterns after each exchange.
    this.bus.on('chat:completed', (data) => {
      // Observe the user's message for pattern tracking
      const msg = data?.message || '';
      if (msg) this.observe(msg);
      // Also record outcome
      this.observeOutcome(data?.success !== false);
    }, { source: 'UserModel', priority: -10 });
  }

  // ════════════════════════════════════════════════════════════
  // PERSISTENCE
  // ════════════════════════════════════════════════════════════

  _save() {
    if (!this.storage) return;
    try {
      this.storage.writeJSONDebounced('user-model.json', this._saveData());
    } catch (err) { _log.debug('[USER-MODEL] Save error:', err.message); }
  }

  /** FIX D-1: Sync write for shutdown path. */
  _saveSync() {
    if (!this.storage) return;
    try {
      this.storage.writeJSON('user-model.json', this._saveData());
    } catch (err) { _log.debug('[USER-MODEL] Sync save error:', err.message); }
  }

  /** @private Shared payload for both save paths. */
  _saveData() {
    return { profile: this._profile };
  }
}

// ── Utility ─────────────────────────────────────────────────
function _lerp(current, target, rate) {
  return current + (target - current) * rate;
}

module.exports = { UserModel };
