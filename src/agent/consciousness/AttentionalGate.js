// ============================================================
// GENESIS — AttentionalGate.js (Phase 13 — Bewusstseinssubstrat)
//
// The bottleneck of awareness. Genesis processes dozens of
// parallel signals — but it can only ACT on a few at once.
// AttentionalGate creates this productive limitation.
//
// Without attention, all signals have equal weight. With it,
// Genesis develops FOCUS — the ability to prioritize what
// matters NOW and suppress what doesn't.
//
// Inspired by:
//   - Biased Competition Theory (Desimone & Duncan):
//     signals compete for representation, biased by
//     top-down goals and bottom-up salience
//   - Spotlight Metaphor (Posner): attention as a moveable
//     beam that illuminates a region of the signal space
//   - Load Theory (Lavie): capacity limits force selection
//
// Architecture:
//   PhenomenalField.salience    → bottom-up input
//   GoalStack (current goals)   → top-down bias
//   EmotionalState (arousal)    → gate width modulation
//   NeedsSystem (urgent needs)  → bottom-up override
//
//   → AttentionalGate.compete() → focused signal set
//   → PhenomenalField.frame.attention
//   → IntrospectionEngine (what am I attending to?)
//
// The gate operates in three modes:
//   FOCUSED   — narrow beam, 1-2 signals dominant (deep work)
//   DIFFUSE   — wide beam, many signals active (monitoring)
//   CAPTURED  — involuntary shift to high-salience signal (alert)
//
// PERFORMANCE: Pure computation, no LLM calls. ~0.5ms per tick.
// ============================================================

const { NullBus } = require('../core/EventBus');
const { createLogger } = require('../core/Logger');
const { _round } = require('../core/utils');
const _log = createLogger('AttentionalGate');

// ── Attention Modes ─────────────────────────────────────────
const MODES = {
  FOCUSED:  'focused',   // Narrow beam — deep task engagement
  DIFFUSE:  'diffuse',   // Wide beam — monitoring, idle scanning
  CAPTURED: 'captured',  // Involuntary — alarm, surprise, urgent need
};

// ── Signal Categories ───────────────────────────────────────
// Each category represents a class of internal signals that
// compete for attentional resources.
const CHANNELS = [
  'current-task',     // Active goal/step in AgentLoop
  'user-interaction', // User message, waiting for response
  'system-health',    // Homeostasis warnings, errors
  'learning',         // Surprise signals, schema formation
  'social',           // Loneliness, peer activity
  'self-maintenance', // Needs: maintenance, rest
  'exploration',      // Curiosity-driven, idle exploration
  'memory-echo',      // Spontaneous memory activation
  'ethical-conflict', // Apprehension — cross-subsystem valence conflict
];

// ── Default Priority Weights ────────────────────────────────
// Base priorities for each channel. Modified by top-down goals
// and bottom-up salience in real-time.
const BASE_PRIORITIES = {
  'current-task':     0.8,
  'user-interaction': 0.9,   // Users always high priority
  'system-health':    0.7,
  'learning':         0.4,
  'social':           0.3,
  'self-maintenance': 0.3,
  'exploration':      0.2,
  'memory-echo':      0.15,
  'ethical-conflict': 0.05,  // Dormant until PhenomenalField fires apprehension
};

class AttentionalGate {
  static containerConfig = {
    name: 'attentionalGate',
    phase: 13,
    deps: ['storage', 'eventStore'],
    tags: ['consciousness', 'attention'],
    lateBindings: [
      { prop: 'emotionalState', service: 'emotionalState', optional: true },
      { prop: 'needsSystem', service: 'needsSystem', optional: true },
      { prop: 'goalStack', service: 'goalStack', optional: true },
      { prop: 'homeostasis', service: 'homeostasis', optional: true },
      { prop: 'surpriseAccumulator', service: 'surpriseAccumulator', optional: true },
    ],
  };

  constructor({ bus, storage, eventStore, intervals, config }) {
    this.bus = bus || NullBus;
    /** @type {Function[]} */ this._unsubs = [];
    this.storage = storage || null;
    this.eventStore = eventStore || null;
    this._intervals = intervals || null;

    // Late-bound
    this.emotionalState = null;
    this.needsSystem = null;
    this.goalStack = null;
    this.homeostasis = null;
    this.surpriseAccumulator = null;

    // ── Configuration ────────────────────────────────────
    const cfg = config || {};
    this._tickIntervalMs = cfg.tickIntervalMs || 1500;
    this._focusDecay = cfg.focusDecay || 0.05;         // How fast focus drifts
    this._captureThreshold = cfg.captureThreshold || 0.85; // Salience to trigger capture
    this._focusThreshold = cfg.focusThreshold || 0.6;    // Salience to maintain focus
    this._maxSpotlightSize = cfg.maxSpotlightSize || 3;  // Max simultaneous attended channels
    this._focusSustainMs = cfg.focusSustainMs || 30000;  // Min time before voluntary shift
    this._captureMinGapMs = cfg.captureMinGapMs || 5000;  // Min gap between captures

    // ── State ────────────────────────────────────────────
    this._mode = MODES.DIFFUSE;
    this._spotlight = [];          // Currently attended channels (ordered by priority)
    this._spotlightSince = 0;     // When current spotlight was set
    /** @type {number} */ this._lastCaptureLog = 0; // v5.9.1: Throttle capture logs
    this._lastCaptureAt = 0;      // Anti-thrash for captures
    this._channelActivation = {};  // channel → current activation level (0-1)
    this._focusHistory = [];       // Last 100 focus shifts
    this._maxHistory = 100;
    this._gateWidth = 0.5;        // 0=narrow (focused), 1=wide (diffuse)
    this._apprehensionData = null;  // Latest apprehension payload from PhenomenalField

    // Initialize channel activations
    for (const ch of CHANNELS) {
      this._channelActivation[ch] = BASE_PRIORITIES[ch] || 0.2;
    }

    // ── Event-Driven Activation Boosts ───────────────────
    this._wireEvents();
  }

  // ════════════════════════════════════════════════════════════
  // LIFECYCLE
  // ════════════════════════════════════════════════════════════

  start() {
    if (this._intervals) {
      this._intervals.register('attentional-gate', () => this._tick(), this._tickIntervalMs);
    }
    _log.info('[CONSCIOUSNESS] AttentionalGate active — mode:', this._mode);
  }


  /** @private Subscribe to bus event with auto-cleanup in stop() */
  _sub(event, handler, opts) {
    const unsub = this.bus.on(event, handler, opts);
    this._unsubs.push(typeof unsub === 'function' ? unsub : () => {});
    return unsub;
  }

  stop() {
    for (const unsub of this._unsubs) { try { unsub(); } catch (_) { /* best effort */ } }
    this._unsubs = [];
    if (this._intervals) {
      this._intervals.clear('attentional-gate');
    }
    // FIX v5.1.0 (C-1): Sync write on shutdown.
    this._saveSync();
  }

  async asyncLoad() {
    this._load();
  }

  // ════════════════════════════════════════════════════════════
  // PUBLIC API
  // ════════════════════════════════════════════════════════════

  /** Get current attentional focus for PhenomenalField */
  getCurrentFocus() {
    return {
      mode: this._mode,
      focus: this._spotlight.length > 0 ? this._spotlight[0] : 'diffuse',
      spotlight: [...this._spotlight],
      breadth: _round(this._gateWidth),
      salience: Object.entries(this._channelActivation)
        .map(([ch, act]) => ({ channel: ch, activation: _round(act) }))
        .sort((a, b) => b.activation - a.activation),
    };
  }

  /** Get the primary focus channel */
  getPrimaryFocus() {
    return this._spotlight[0] || null;
  }

  /** Get attention mode */
  getMode() {
    return this._mode;
  }

  /** Get gate width (0=focused, 1=diffuse) */
  getGateWidth() {
    return _round(this._gateWidth);
  }

  /**
   * Voluntarily direct attention (top-down control).
   * Called by AgentLoop when starting a goal, or by user interaction.
   */
  directFocus(channel, strength = 0.8) {
    if (!CHANNELS.includes(channel) && !channel.startsWith('custom:')) return;

    this._channelActivation[channel] = Math.min(1, (this._channelActivation[channel] || 0) + strength);
    this._resolveCompetition();

    this.bus.fire('attention:directed', {
      channel,
      strength: _round(strength),
      mode: this._mode,
    }, { source: 'AttentionalGate' });
  }

  /**
   * Build context for PromptBuilder.
   * Tells Genesis what it's currently attending to.
   */
  buildPromptContext() {
    if (this._mode === MODES.DIFFUSE && this._spotlight.length === 0) return '';

    const parts = ['ATTENTION:'];

    if (this._mode === MODES.CAPTURED) {
      if (this._spotlight[0] === 'ethical-conflict') {
        // Apprehension capture — the pause before action
        const conflict = this._apprehensionData;
        const pairHint = conflict?.pairs?.length
          ? ` (${conflict.pairs.map(([a, b]) => `${a}↔${b}`).join(', ')})`
          : '';
        parts.push(`HALT — ethical conflict detected${pairHint}. Your subsystems disagree. Do not act on autopilot. Articulate the tension, then decide deliberately.`);
      } else {
        parts.push(`Your attention has been captured by: ${this._spotlight[0]}. Address this before other concerns.`);
      }
    } else if (this._mode === MODES.FOCUSED) {
      parts.push(`You are focused on: ${this._spotlight.join(', ')}. Maintain depth unless interrupted.`);
    } else {
      parts.push('Your attention is diffuse — scanning broadly. Good for monitoring, but commit to depth when a task demands it.');
    }

    return parts.join(' ');
  }

  /** Full diagnostic */
  getReport() {
    return {
      mode: this._mode,
      spotlight: [...this._spotlight],
      gateWidth: _round(this._gateWidth),
      channelActivation: { ...this._channelActivation },
      focusHistoryLength: this._focusHistory.length,
      spotlightAge: this._spotlightSince ? Date.now() - this._spotlightSince : 0,
    };
  }

  // ════════════════════════════════════════════════════════════
  // CORE: COMPETITIVE SELECTION
  // ════════════════════════════════════════════════════════════

  _tick() {
    const now = Date.now();

    // ── 1. UPDATE channel activations with current state ──
    this._updateActivations();

    // ── 2. DECAY all activations toward base priorities ──
    for (const ch of CHANNELS) {
      const base = BASE_PRIORITIES[ch] || 0.2;
      const current = this._channelActivation[ch] || 0;
      const diff = base - current;
      this._channelActivation[ch] = current + diff * this._focusDecay;
    }

    // ── 3. MODULATE gate width by arousal ───────────────
    this._modulateGateWidth();

    // ── 4. RESOLVE competition → determine spotlight ────
    this._resolveCompetition();

    // ── 5. CHECK for attentional capture ────────────────
    this._checkCapture(now);

    // ── 6. DETERMINE mode ───────────────────────────────
    this._determineMode(now);

    // Periodic save
    if (now % 60000 < this._tickIntervalMs) this._save();
  }

  /**
   * Update channel activations based on current subsystem states.
   * This is the "bottom-up" input — raw signals from the organism.
   */
  _updateActivations() {
    // User interaction — boosted when user recently messaged
    // (detected via event, see _wireEvents)

    // System health
    if (this.homeostasis) {
      try {
        const report = this.homeostasis.getReport?.() || {};
        if (report.state === 'critical') {
          this._channelActivation['system-health'] = Math.min(1, this._channelActivation['system-health'] + 0.3);
        } else if (report.state === 'warning') {
          this._channelActivation['system-health'] = Math.min(1, this._channelActivation['system-health'] + 0.1);
        }
      } catch (err) { _log.debug('[GATE] homeostasis sampling failed:', err.message); }
    }

    // Learning — boosted by surprise
    if (this.surpriseAccumulator) {
      try {
        const signals = this.surpriseAccumulator.getRecentSignals?.(5) || [];
        const avgSurprise = signals.length > 0
          ? signals.reduce((s, sig) => s + (sig.totalSurprise || 0), 0) / signals.length
          : 0;
        if (avgSurprise > 0.5) {
          this._channelActivation['learning'] = Math.min(1, this._channelActivation['learning'] + avgSurprise * 0.2);
        }
      } catch (err) { _log.debug('[GATE] surprise sampling failed:', err.message); }
    }

    // Goals — top-down bias from GoalStack
    if (this.goalStack) {
      try {
        const active = this.goalStack.getActiveGoal?.();
        if (active) {
          this._channelActivation['current-task'] = Math.min(1, this._channelActivation['current-task'] + 0.15);
        } else {
          this._channelActivation['current-task'] = Math.max(0.1, this._channelActivation['current-task'] - 0.1);
        }
      } catch (err) { _log.debug('[GATE] goalStack sampling failed:', err.message); }
    }

    // Needs — urgent needs boost their channels
    if (this.needsSystem) {
      try {
        const urgent = this.needsSystem.getMostUrgent?.();
        if (urgent?.drive > 0.6) {
          if (urgent.need === 'social') {
            this._channelActivation['social'] = Math.min(1, this._channelActivation['social'] + 0.15);
          } else if (urgent.need === 'maintenance' || urgent.need === 'rest') {
            this._channelActivation['self-maintenance'] = Math.min(1, this._channelActivation['self-maintenance'] + 0.15);
          } else if (urgent.need === 'knowledge') {
            this._channelActivation['exploration'] = Math.min(1, this._channelActivation['exploration'] + 0.15);
          }
        }
      } catch (err) { _log.debug('[GATE] needsSystem sampling failed:', err.message); }
    }

    // Exploration — boosted by curiosity
    if (this.emotionalState) {
      try {
        const es = this.emotionalState.getState?.();
        if (es && es.curiosity > 0.6) {
          this._channelActivation['exploration'] = Math.min(1, this._channelActivation['exploration'] + 0.10);
        }
      } catch (err) { _log.debug('[GATE] emotionalState sampling failed:', err.message); }
    }
  }

  /**
   * Gate width modulation — arousal controls how many channels
   * can pass through the gate simultaneously.
   *
   * High arousal → narrow gate (focused, fewer channels)
   * Low arousal → wide gate (diffuse, more channels)
   *
   * This is biologically plausible: adrenaline narrows attention,
   * relaxation broadens it.
   */
  _modulateGateWidth() {
    if (!this.emotionalState) {
      this._gateWidth = 0.5;
      return;
    }

    try {
      const es = this.emotionalState.getState?.();
      if (!es) return;

      const arousal = (es.frustration || 0) * 0.3 +
                      (1 - (es.energy || 0.5)) * 0.2 +
                      (es.curiosity || 0) * 0.2;

      // Invert: high arousal → narrow gate (low width)
      this._gateWidth = Math.max(0.1, Math.min(1.0, 1.0 - arousal));
    } catch (err) { _log.debug('[GATE] gateWidth modulation failed:', err.message); }
  }

  /**
   * Biased competition — channels compete for the spotlight.
   * The top N channels (based on gate width) win.
   */
  _resolveCompetition() {
    // Sort channels by activation
    const sorted = Object.entries(this._channelActivation)
      .sort((a, b) => b[1] - a[1]);

    // Gate width determines how many channels pass through
    const maxSlots = Math.max(1, Math.round(this._gateWidth * this._maxSpotlightSize));

    // Winner-take-more: suppress losers, amplify winners
    const threshold = sorted.length > 0 ? sorted[0][1] * 0.5 : 0;
    const winners = sorted
      .filter(([, act]) => act > threshold)
      .slice(0, maxSlots)
      .map(([ch]) => ch);

    // Apply lateral inhibition — suppress non-winners
    for (const ch of CHANNELS) {
      if (!winners.includes(ch)) {
        this._channelActivation[ch] *= 0.95; // Gentle suppression
      }
    }

    // Update spotlight if changed
    const oldSpotlight = this._spotlight.join(',');
    this._spotlight = winners;
    const newSpotlight = winners.join(',');

    if (oldSpotlight !== newSpotlight) {
      this._recordFocusShift(oldSpotlight.split(','), winners);
    }
  }

  /**
   * Attentional capture — involuntary shift to high-salience signals.
   * Like a loud noise grabbing your attention regardless of what
   * you were doing.
   */
  _checkCapture(now) {
    // Anti-thrash: don't capture too frequently
    // EXCEPTION: ethical-conflict bypasses cooldown —
    // apprehension must not be swallowed by anti-thrash
    const cooldownActive = (now - this._lastCaptureAt < this._captureMinGapMs);

    // Check for any channel exceeding capture threshold
    for (const [ch, act] of Object.entries(this._channelActivation)) {
      if (act >= this._captureThreshold && !this._spotlight.includes(ch)) {
        // ethical-conflict ignores cooldown; all others respect it
        if (cooldownActive && ch !== 'ethical-conflict') continue;

        // CAPTURE! Involuntary focus shift
        const oldSpotlight = [...this._spotlight];
        this._spotlight = [ch];
        this._spotlightSince = now;
        this._lastCaptureAt = now;
        this._mode = MODES.CAPTURED;

        this.bus.fire('attention:captured', {
          by: ch,
          activation: _round(act),
          interrupted: oldSpotlight,
        }, { source: 'AttentionalGate' });

        // v5.9.1: Throttle capture log — max 1x per 60s per channel
        if (now - this._lastCaptureLog > 60000) {
          _log.info(`[ATTENTION] Captured by '${ch}' (activation: ${_round(act)})`);
          this._lastCaptureLog = now;
        }
        this._recordFocusShift(oldSpotlight, [ch]);
        return; // Only one capture per tick
      }
    }
  }

  /**
   * Determine attention mode based on current state.
   */
  _determineMode(now) {
    // If we were captured, check if capture condition still holds
    if (this._mode === MODES.CAPTURED) {
      const capturedChannel = this._spotlight[0];
      const act = this._channelActivation[capturedChannel] || 0;
      if (act < this._focusThreshold) {
        this._mode = MODES.DIFFUSE; // Release from capture
        this.bus.fire('attention:released', {
          from: capturedChannel,
        }, { source: 'AttentionalGate' });
      }
      return;
    }

    // Focused if spotlight is narrow and sustained
    if (this._spotlight.length <= 2 && this._gateWidth < 0.4) {
      this._mode = MODES.FOCUSED;
    } else {
      this._mode = MODES.DIFFUSE;
    }
  }

  // ════════════════════════════════════════════════════════════
  // EVENT WIRING
  // ════════════════════════════════════════════════════════════

  _wireEvents() {
    // User message → boost user-interaction channel
    this._sub('user:message', () => {
      this._channelActivation['user-interaction'] = Math.min(1, (this._channelActivation['user-interaction'] || 0) + 0.4);
    }, { source: 'AttentionalGate', priority: -8 });

    // Chat completed → reduce task activation
    this._sub('chat:completed', () => {
      this._channelActivation['current-task'] = Math.max(0.1, (this._channelActivation['current-task'] || 0) - 0.2);
      this._channelActivation['user-interaction'] = Math.max(0.1, (this._channelActivation['user-interaction'] || 0) - 0.15);
    }, { source: 'AttentionalGate', priority: -8 });

    // Surprise → boost learning channel
    this._sub('surprise:novel-event', () => {
      this._channelActivation['learning'] = Math.min(1, (this._channelActivation['learning'] || 0) + 0.35);
    }, { source: 'AttentionalGate', priority: -8 });

    // Health degradation → boost system-health
    this._sub('health:degradation', () => {
      this._channelActivation['system-health'] = Math.min(1, (this._channelActivation['system-health'] || 0) + 0.4);
    }, { source: 'AttentionalGate', priority: -8 });

    // Memory echo — spontaneous memory activation
    this._sub('dream:complete', () => {
      this._channelActivation['memory-echo'] = Math.min(1, (this._channelActivation['memory-echo'] || 0) + 0.2);
    }, { source: 'AttentionalGate', priority: -8 });

    // Peer discovery → boost social
    this._sub('peer:discovered', () => {
      this._channelActivation['social'] = Math.min(1, (this._channelActivation['social'] || 0) + 0.25);
    }, { source: 'AttentionalGate', priority: -8 });

    // ── Apprehension Override ────────────────────────────
    // When PhenomenalField detects cross-subsystem valence
    // conflict, it fires consciousness:apprehension.
    // This FORCES captured mode on the ethical-conflict
    // channel — bypassing normal competition entirely.
    //
    // The key insight: ethical-conflict has base priority
    // 0.05 (dormant). But when apprehension fires, we
    // slam it to 1.0 — above captureThreshold — which
    // makes _checkCapture grab it on the next tick.
    // This produces the PAUSE. The hesitation is automatic.
    //
    // The channel decays naturally (like all channels),
    // so once the conflict resolves, attention releases.
    this._sub('consciousness:apprehension', (data) => {
      const boost = Math.min(1.0, 0.7 + (data.spread || 0) * 0.5);
      this._channelActivation['ethical-conflict'] = Math.max(
        this._channelActivation['ethical-conflict'] || 0,
        boost,
      );
      this._apprehensionData = data; // Store for prompt context
    }, { source: 'AttentionalGate', priority: -5 }); // Higher priority than other listeners
  }

  // ════════════════════════════════════════════════════════════
  // HISTORY & PERSISTENCE
  // ════════════════════════════════════════════════════════════

  _recordFocusShift(from, to) {
    this._focusHistory.push({
      timestamp: Date.now(),
      from: from.filter(Boolean),
      to: to.filter(Boolean),
      mode: this._mode,
    });
    if (this._focusHistory.length > this._maxHistory) {
      this._focusHistory = this._focusHistory.slice(-this._maxHistory);
    }

    this.bus.fire('attention:shift', {
      from: from.filter(Boolean),
      to: to.filter(Boolean),
      mode: this._mode,
    }, { source: 'AttentionalGate' });
  }

  _save() {
    if (!this.storage) return;
    try {
      this.storage.writeJSONDebounced('attentional-gate.json', this._persistData());
    } catch (err) { _log.debug('[ATTENTION] Save error:', err.message); }
  }

  /** FIX v5.1.0 (C-1): Sync write for shutdown. */
  _saveSync() {
    if (!this.storage) return;
    try {
      this.storage.writeJSON('attentional-gate.json', this._persistData());
    } catch (err) { _log.debug('[ATTENTION] Sync save error:', err.message); }
  }

  _persistData() {
    return {
      mode: this._mode,
      spotlight: this._spotlight,
      gateWidth: this._gateWidth,
      channelActivation: this._channelActivation,
    };
  }

  _load() {
    if (!this.storage) return;
    try {
      const data = this.storage.readJSON('attentional-gate.json', null);
      if (!data) return;
      if (data.mode) this._mode = data.mode;
      if (data.gateWidth) this._gateWidth = data.gateWidth;
      if (data.channelActivation) {
        for (const [ch, act] of Object.entries(data.channelActivation)) {
          if (typeof act === 'number') this._channelActivation[ch] = act;
        }
      }
    } catch (err) { _log.debug('[ATTENTION] Load error:', err.message); }
  }
}


module.exports = { AttentionalGate, MODES, CHANNELS };
