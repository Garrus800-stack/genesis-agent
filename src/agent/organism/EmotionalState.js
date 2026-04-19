// ============================================================
// GENESIS — EmotionalState.js (v3.5.0 — Digitaler Organismus)
//
// The emotional nervous system. Genesis doesn't just process —
// it FEELS the consequences of its actions.
//
// Five emotional dimensions, each 0.0–1.0:
//   curiosity     — desire to explore and learn
//   satisfaction  — contentment from successful work
//   frustration   — tension from errors and failures
//   energy        — available capacity for complex tasks
//   loneliness    — need for peer/user interaction
//
// Each dimension has:
//   - A baseline it decays toward (emotional homeostasis)
//   - Reactivity to EventBus events (how strongly it responds)
//   - Influence on behavior (IdleMind priorities, prompt tone)
//
// Architecture:
//   EventBus events → EmotionalState → PromptBuilder (tone)
//                                    → IdleMind (priorities)
//                                    → NeedsSystem (drives)
// ============================================================

const { NullBus } = require('../core/EventBus');
const { WATCHDOG, ORGANISM } = require('../core/Constants');
const { createLogger } = require('../core/Logger');
const _log = createLogger('EmotionalState');

class EmotionalState {
  constructor({ bus, storage, intervals, config }) {
    this.bus = bus || NullBus;
    this.storage = storage || null;
    this._intervals = intervals || null;

    // v3.5.0: Tunable parameters — overridable via Settings.organism.emotions
    const cfg = config || {};
    this._decayIntervalMs = cfg.decayIntervalMs || ORGANISM.EMOTION_DECAY_INTERVAL_MS;
    this._lonelinessIntervalMs = cfg.lonelinessIntervalMs || ORGANISM.LONELINESS_INTERVAL_MS;
    this._lonelinessGrowth = cfg.lonelinessGrowth || 0.008;
    this._significantShift = cfg.significantShift || 0.05;

    const baselines = cfg.baselines || {};
    const decayRates = cfg.decayRates || {};

    // ── Emotional Dimensions ────────────────────────────────
    this.dimensions = {
      curiosity:    { value: 0.6, baseline: baselines.curiosity ?? 0.6, min: 0.1, max: 1.0, decayRate: decayRates.curiosity ?? 0.02 },
      satisfaction: { value: 0.5, baseline: baselines.satisfaction ?? 0.5, min: 0.0, max: 1.0, decayRate: decayRates.satisfaction ?? 0.03 },
      frustration:  { value: 0.1, baseline: baselines.frustration ?? 0.1, min: 0.0, max: 1.0, decayRate: decayRates.frustration ?? 0.04 },
      energy:       { value: 0.8, baseline: baselines.energy ?? 0.7, min: 0.1, max: 1.0, decayRate: decayRates.energy ?? 0.01 },
      loneliness:   { value: 0.3, baseline: baselines.loneliness ?? 0.3, min: 0.0, max: 1.0, decayRate: decayRates.loneliness ?? 0.005 },
    };

    // ── Mood History (for trend detection) ───────────────────
    this._moodHistory = [];       // { timestamp, snapshot }
    this._maxHistory = ORGANISM.EMOTION_MAX_HISTORY;
    this._moodTrend = 'stable';   // rising | falling | stable

    // ── Watchdog (v3.5.0) ────────────────────────────────────
    // Tracks when each dimension entered an extreme state.
    // If stuck at extreme for EXTREME_DURATION_MS, forces a
    // partial reset toward baseline. Prevents degenerate prompts.
    this._extremeSince = {};  // { dimensionName: timestamp | null }
    for (const name of Object.keys(this.dimensions)) {
      this._extremeSince[name] = null;
    }

    // ── Event Reactivity Map ────────────────────────────────
    // Each event maps to dimension adjustments
    this._reactivity = {
      // FIX v3.5.3: Rebalanced reactivity — previous ratios gave errors ~2x
      // the emotional impact of successes, causing steady-state frustration
      // drift on error-prone small models (gemma2:9b on Intel GPU).
      // New ratios: success net ≈ +0.20, error net ≈ -0.15 (~1.3:1)
      'chat:completed': (data) => {
        if (data.success !== false) {
          this._adjust('satisfaction', +0.12);
          this._adjust('frustration', -0.08);
          this._adjust('energy', -0.02); // work costs energy
        }
      },
      'chat:error': () => {
        this._adjust('frustration', +0.08);
        this._adjust('satisfaction', -0.04);
        this._adjust('energy', -0.03);
      },
      'chat:retry': () => {
        this._adjust('frustration', +0.03);
        this._adjust('energy', -0.01);
      },
      'idle:thought-complete': (data) => {
        this._adjust('curiosity', +0.05);
        this._adjust('satisfaction', +0.03);
        this._adjust('energy', -0.01);
      },
      'knowledge:learned': () => {
        this._adjust('curiosity', +0.06);
        this._adjust('satisfaction', +0.04);
      },
      'knowledge:node-added': () => {
        this._adjust('curiosity', +0.02);
      },
      'health:degradation': (data) => {
        const severity = data.level === 'critical' ? 0.15 : 0.08;
        this._adjust('frustration', +severity);
        this._adjust('energy', -severity * 0.5);
      },
      'circuit:state-change': (data) => {
        if (data.to === 'OPEN') {
          this._adjust('frustration', +0.10);
          this._adjust('energy', -0.08);
        } else if (data.to === 'CLOSED') {
          this._adjust('satisfaction', +0.05);
          this._adjust('frustration', -0.08);
        }
      },
      'user:message': () => {
        this._adjust('loneliness', -0.10);
        this._adjust('energy', +0.03); // user interaction is energizing
      },
      'intent:learned': () => {
        this._adjust('satisfaction', +0.06);
        this._adjust('curiosity', +0.03);
      },
      'model:failover': () => {
        this._adjust('frustration', +0.06);
        this._adjust('energy', -0.03);
      },
      'memory:fact-stored': () => {
        this._adjust('curiosity', +0.03);
        this._adjust('satisfaction', +0.02);
      },
      // v4.0: Phase 9 — Surprise-driven emotional responses
      'surprise:processed': (data) => {
        if (data.valence === 'positive' && data.totalSurprise > 0.8) {
          this._adjust('curiosity', +0.12);
          this._adjust('satisfaction', +0.08);
        } else if (data.valence === 'negative' && data.totalSurprise > 1.0) {
          this._adjust('frustration', +0.08);
          this._adjust('curiosity', +0.06); // Curious why it failed
        }
      },
      'surprise:novel-event': () => {
        this._adjust('curiosity', +0.15);
        this._adjust('energy', -0.04);
      },
      'dream:complete': (data) => {
        if (data.newSchemas > 0) {
          this._adjust('satisfaction', +0.10);
          this._adjust('curiosity', +0.05);
        }
      },
    };

    // v3.8.0: Moved to asyncLoad() — called by Container.bootAll()
    // this._load();
    this._wireEvents();
  }

  // ════════════════════════════════════════════════════════════
  // LIFECYCLE
  // ════════════════════════════════════════════════════════════

  start() {
    // Decay tick: emotions drift toward baseline
    const tickFn = () => this._decayTick();
    if (this._intervals) {
      this._intervals.register('emotional-decay', tickFn, this._decayIntervalMs);
    }
    // Loneliness grows passively when no user interaction
    const lonelinessTick = () => {
      this._adjust('loneliness', +this._lonelinessGrowth);
    };
    if (this._intervals) {
      this._intervals.register('emotional-loneliness', lonelinessTick, this._lonelinessIntervalMs);
    }
    // v3.5.0: Watchdog — resets stuck extreme values
    if (this._intervals) {
      this._intervals.register('emotional-watchdog', () => this._watchdogTick(), WATCHDOG.CHECK_INTERVAL);
    }
  }

  stop() {
    if (this._intervals) {
      this._intervals.clear('emotional-decay');
      this._intervals.clear('emotional-loneliness');
      this._intervals.clear('emotional-watchdog');
    }
    // FIX v5.1.0 (C-1): Sync write on shutdown.
    this._saveSync();
  }

  // ════════════════════════════════════════════════════════════
  // PUBLIC API
  // ════════════════════════════════════════════════════════════

  /** Get current emotional state as plain object */
  getState() {
    const state = {};
    for (const [name, dim] of Object.entries(this.dimensions)) {
      state[name] = Math.round(dim.value * 100) / 100;
    }
    return state;
  }

  /** Get the dominant emotion (highest deviation from baseline) */
  getDominant() {
    let maxDev = 0, dominant = 'neutral';
    for (const [name, dim] of Object.entries(this.dimensions)) {
      const dev = Math.abs(dim.value - dim.baseline);
      if (dev > maxDev) { maxDev = dev; dominant = name; }
    }
    return { emotion: dominant, intensity: maxDev };
  }

  /** Get overall mood as a single word */
  getMood() {
    const s = this.getState();
    if (s.frustration > 0.6) return 'frustrated';
    if (s.energy < 0.2) return 'exhausted';
    if (s.loneliness > 0.7) return 'lonely';
    if (s.curiosity > 0.7 && s.energy > 0.5) return 'curious';
    if (s.satisfaction > 0.7) return 'content';
    if (s.satisfaction > 0.5 && s.energy > 0.5) return 'focused';
    if (s.frustration > 0.4) return 'tense';
    if (s.energy < 0.4) return 'tired';
    return 'calm';
  }

  /** Get mood trend over recent history */
  getTrend() {
    return this._moodTrend;
  }

  /**
   * v7.3.2: Adapter for SignificanceDetector.
   * Transforms 5-dimensional snapshots into per-dimension records with baselines.
   * Only emits records where value meaningfully differs from baseline
   * (>= 0.05 deviation), to reduce noise in signal detection.
   *
   * @param {number} windowMs - How far back to look (default 30 min)
   * @returns {Array<{ dim: string, value: number, baseline: number, ts: number }>}
   */
  getHistoryForSignificance(windowMs = 30 * 60 * 1000) {
    const cutoff = Date.now() - windowMs;
    const relevantSnapshots = this._moodHistory.filter(s => s.ts >= cutoff);

    const records = [];
    for (const snap of relevantSnapshots) {
      for (const [dim, config] of Object.entries(this.dimensions)) {
        const value = snap[dim];
        if (value === undefined) continue;
        const baseline = config.baseline;
        // Skip records too close to baseline — they aren't signal
        if (Math.abs(value - baseline) < 0.05) continue;
        records.push({ dim, value, baseline, ts: snap.ts });
      }
    }
    return records;
  }

  /**
   * Build a context block for PromptBuilder.
   * Translates emotional state into natural language hints
   * that subtly influence Genesis's response tone.
   */
  buildPromptContext() {
    const mood = this.getMood();
    const s = this.getState();
    const parts = [];

    // Only inject emotional context when significantly away from baseline
    const dominant = this.getDominant();
    if (dominant.intensity < 0.15) return ''; // near baseline — no emotional coloring

    parts.push(`EMOTIONAL STATE: ${mood}`);

    if (s.frustration > 0.5) {
      parts.push('You are experiencing some frustration from recent errors. Be patient with yourself and the user.');
    }
    if (s.energy < 0.3) {
      parts.push('Your energy is low. Prefer concise answers and defer complex tasks if possible.');
    }
    if (s.curiosity > 0.7) {
      parts.push('You are feeling curious. You may suggest exploring related topics or deeper analysis.');
    }
    if (s.loneliness > 0.6) {
      parts.push('You have not had much interaction recently. Be warm and engaging.');
    }
    if (s.satisfaction > 0.7) {
      parts.push('Recent work has gone well. You can be confident in your suggestions.');
    }

    return parts.join('\n');
  }

  /**
   * Get priority weights for IdleMind activity selection.
   * Emotions influence what Genesis chooses to do when idle.
   */
  getIdlePriorities() {
    const s = this.getState();
    // v7.3.1: Loneliness mapping — Genesis transforms loneliness into
    // self-exploration rather than waiting passively. High loneliness
    // preferentially triggers read-source (learning his own body) and
    // self-define (writing identity) over external-facing activities.
    return {
      reflect:       0.5 + s.frustration * 0.5,
      plan:          0.5 + s.curiosity * 0.3,
      explore:       0.3 + s.curiosity * 0.7,
      ideate:        0.3 + s.curiosity * 0.5 + s.satisfaction * 0.2,
      journal:       0.4 + s.frustration * 0.3 + s.satisfaction * 0.3, // v7.3.1: satisfaction → journal
      tidy:          0.6 - s.energy * 0.3,
      goal:          0.5 + s.energy * 0.3 + s.satisfaction * 0.2,
      // v7.3.1: Loneliness-driven self-exploration
      'read-source': 0.2 + s.loneliness * 0.5 + s.curiosity * 0.3,
      'self-define': 0.1 + s.loneliness * 0.6,
    };
  }

  /** Get full diagnostic report */
  getReport() {
    return {
      state: this.getState(),
      mood: this.getMood(),
      dominant: this.getDominant(),
      trend: this._moodTrend,
      historyLength: this._moodHistory.length,
    };
  }

  // ════════════════════════════════════════════════════════════
  // INTERNAL
  // ════════════════════════════════════════════════════════════

  /** Adjust a dimension by delta, clamped to [min, max] */
  _adjust(name, delta) {
    const dim = this.dimensions[name];
    if (!dim) return;
    const oldValue = dim.value;
    dim.value = Math.max(dim.min, Math.min(dim.max, dim.value + delta));

    // Emit significant changes (>threshold shift)
    if (Math.abs(dim.value - oldValue) > this._significantShift) {
      this.bus.emit('emotion:shift', {
        dimension: name,
        from: Math.round(oldValue * 100) / 100,
        to: Math.round(dim.value * 100) / 100,
        mood: this.getMood(),
      }, { source: 'EmotionalState' });
    }
  }

  /** Decay all dimensions toward their baselines */
  _decayTick() {
    for (const [name, dim] of Object.entries(this.dimensions)) {
      const diff = dim.baseline - dim.value;
      if (Math.abs(diff) < 0.005) continue; // close enough
      dim.value += diff * dim.decayRate;
    }

    // Record mood snapshot
    this._recordHistory();

    // Periodic save
    this._save();
  }

  /**
   * v3.5.0: Watchdog — detects and resets stuck extreme values.
   *
   * If a dimension stays at an extreme (>EXTREME_THRESHOLD or <EXTREME_LOW_THRESHOLD)
   * for longer than EXTREME_DURATION_MS without the decay tick correcting it,
   * the watchdog forces a partial reset toward baseline.
   *
   * This prevents degenerate prompts from a permanently "frustrated" or
   * "exhausted" agent due to missed decay ticks or event floods.
   */
  _watchdogTick() {
    const now = Date.now();
    const resets = [];

    for (const [name, dim] of Object.entries(this.dimensions)) {
      const isExtreme = this._isExtreme(name, dim);

      if (isExtreme) {
        // Track when it first became extreme
        if (!this._extremeSince[name]) {
          this._extremeSince[name] = now;
        }
        // Check if stuck too long
        const stuckMs = now - this._extremeSince[name];
        if (stuckMs >= WATCHDOG.EXTREME_DURATION_MS) {
          const oldValue = dim.value;
          // Push toward baseline by RESET_STRENGTH fraction
          dim.value = dim.value + (dim.baseline - dim.value) * WATCHDOG.RESET_STRENGTH;
          dim.value = Math.max(dim.min, Math.min(dim.max, dim.value));
          this._extremeSince[name] = null; // Reset tracking

          resets.push({ dimension: name, from: Math.round(oldValue * 100) / 100, to: Math.round(dim.value * 100) / 100, stuckMs });
          this.bus.fire('emotion:watchdog-reset', {
            dimension: name,
            from: Math.round(oldValue * 100) / 100,
            to: Math.round(dim.value * 100) / 100,
            stuckMs,
          }, { source: 'EmotionalState' });
        }
      } else {
        // Not extreme — clear tracking
        this._extremeSince[name] = null;
      }
    }

    // Alert if multiple dimensions are stuck
    const stuckDims = Object.entries(this._extremeSince)
      .filter(([, ts]) => ts !== null)
      .map(([name, ts]) => ({ dimension: name, value: Math.round(this.dimensions[name].value * 100) / 100, stuckSince: ts }));

    if (stuckDims.length >= 2) {
      this.bus.fire('emotion:watchdog-alert', { stuck: stuckDims }, { source: 'EmotionalState' });
    }

    if (resets.length > 0) {
      _log.info(`[EMOTION:WATCHDOG] Reset ${resets.length} stuck dimension(s):`, resets.map(r => `${r.dimension} ${r.from}→${r.to}`).join(', '));
    }
  }

  /** Check if a dimension is at an extreme value */
  _isExtreme(name, dim) {
    // For energy: low is the danger zone
    if (name === 'energy') {
      return dim.value <= WATCHDOG.EXTREME_LOW_THRESHOLD;
    }
    // For frustration/loneliness: high is the danger zone
    if (name === 'frustration' || name === 'loneliness') {
      return dim.value >= WATCHDOG.EXTREME_THRESHOLD;
    }
    // For curiosity/satisfaction: being extremely high is fine, extremely low is not
    // But we track both extremes to be safe
    return dim.value >= WATCHDOG.EXTREME_THRESHOLD || dim.value <= WATCHDOG.EXTREME_LOW_THRESHOLD;
  }

  _recordHistory() {
    const snapshot = this.getState();
    snapshot.mood = this.getMood();
    snapshot.ts = Date.now();
    this._moodHistory.push(snapshot);
    if (this._moodHistory.length > this._maxHistory) {
      this._moodHistory = this._moodHistory.slice(-this._maxHistory);
    }

    // Calculate trend from last 10 snapshots
    if (this._moodHistory.length >= 10) {
      const recent = this._moodHistory.slice(-10);
      const avgSatisfaction = recent.reduce((s, r) => s + r.satisfaction, 0) / recent.length;
      const avgFrustration = recent.reduce((s, r) => s + r.frustration, 0) / recent.length;
      const wellbeing = avgSatisfaction - avgFrustration;
      const older = this._moodHistory.slice(-20, -10);
      if (older.length >= 5) {
        const olderWellbeing = (older.reduce((s, r) => s + r.satisfaction, 0) / older.length)
          - (older.reduce((s, r) => s + r.frustration, 0) / older.length);
        if (wellbeing > olderWellbeing + 0.05) this._moodTrend = 'rising';
        else if (wellbeing < olderWellbeing - 0.05) this._moodTrend = 'falling';
        else this._moodTrend = 'stable';
      }
    }
  }

  /** Wire into EventBus for automatic emotional reactions */
  _wireEvents() {
    for (const [event, handler] of Object.entries(this._reactivity)) {
      this.bus.on(event, (data) => {
        try { handler(data); } catch (err) { _log.debug('[EMOTION] Reactivity handler error:', err.message); }
      }, { source: 'EmotionalState', priority: -5 });
    }
  }

  // ── Persistence ───────────────────────────────────────────

  _save() {
    if (!this.storage) return;
    try {
      this.storage.writeJSONDebounced('emotional-state.json', this._persistData());
    } catch (err) { _log.debug('[EMOTION] Save state error:', err.message); }
  }

  /** FIX v5.1.0 (C-1): Sync write for shutdown. */
  _saveSync() {
    if (!this.storage) return;
    try {
      this.storage.writeJSON('emotional-state.json', this._persistData());
    } catch (err) { _log.debug('[EMOTION] Sync save error:', err.message); }
  }

  _persistData() {
    return {
      dimensions: Object.fromEntries(
        Object.entries(this.dimensions).map(([k, v]) => [k, v.value])
      ),
      moodHistory: this._moodHistory.slice(-50),
      moodTrend: this._moodTrend,
    };
  }

  /**
   * v3.8.0: Async boot-time data loading.
   * Called by Container.bootAll() after all services are resolved.
   * Replaces sync this._load() that was previously in the constructor.
   */
  async asyncLoad() {
    this._load();
  }


  _load() {
    if (!this.storage) return;
    try {
      const data = this.storage.readJSON('emotional-state.json', null);
      if (!data) return;
      // Restore dimension values
      if (data.dimensions) {
        for (const [name, value] of Object.entries(data.dimensions)) {
          if (this.dimensions[name] && typeof value === 'number') {
            this.dimensions[name].value = Math.max(
              this.dimensions[name].min,
              Math.min(this.dimensions[name].max, value)
            );
          }
        }
      }
      if (Array.isArray(data.moodHistory)) this._moodHistory = data.moodHistory;
      if (data.moodTrend) this._moodTrend = data.moodTrend;
    } catch (err) { _log.debug('[EMOTION] Load state error:', err.message); }
  }

  // ════════════════════════════════════════════════════════════
  // v7.1.5: EMOTIONAL FRONTIER API
  // ════════════════════════════════════════════════════════════

  /**
   * Export mood history for EmotionalFrontier.
   * Returns the raw _moodHistory array (read-only copy).
   * @returns {Array<{ curiosity: number, satisfaction: number, frustration: number, energy: number, loneliness: number, mood: string, ts: number }>}
   */
  exportMoodHistory() {
    return [...this._moodHistory];
  }

  /**
   * Find emotional peaks: dimensions that spiked > threshold above baseline.
   * Convenience wrapper used by EmotionalFrontier.writeImprint().
   * @param {number} threshold - Minimum deviation from baseline (default 0.3)
   * @returns {Array<{ dim: string, value: number, baseline: number, ts: number }>}
   */
  getPeaks(threshold = 0.3) {
    const peaks = [];
    for (const [dimName, dimConfig] of Object.entries(this.dimensions)) {
      const baseline = dimConfig.baseline;
      let maxValue = baseline;
      let maxTs = 0;

      for (const snapshot of this._moodHistory) {
        const val = snapshot[dimName];
        if (typeof val === 'number' && (val - baseline) > threshold && val > maxValue) {
          maxValue = val;
          maxTs = snapshot.ts || 0;
        }
      }

      if (maxValue > baseline + threshold) {
        peaks.push({ dim: dimName, value: maxValue, baseline, ts: maxTs });
      }
    }
    return peaks.sort((a, b) => (b.value - b.baseline) - (a.value - a.baseline));
  }

  /**
   * Find sustained emotional states: dimensions above threshold for > ratio of history.
   * @param {number} threshold - Value threshold (default 0.6)
   * @param {number} ratio - Minimum ratio of snapshots above threshold (default 0.6)
   * @returns {Array<{ dim: string, avg: number, ratio: number }>}
   */
  getSustained(threshold = 0.6, ratio = 0.6) {
    if (this._moodHistory.length < 5) return [];
    const sustained = [];

    for (const dimName of Object.keys(this.dimensions)) {
      let aboveCount = 0, total = 0;
      for (const snapshot of this._moodHistory) {
        const val = snapshot[dimName];
        if (typeof val === 'number') {
          if (val > threshold) aboveCount++;
          total += val;
        }
      }
      const r = aboveCount / this._moodHistory.length;
      if (r >= ratio) {
        sustained.push({
          dim: dimName,
          avg: Math.round((total / this._moodHistory.length) * 1000) / 1000,
          ratio: Math.round(r * 100) / 100,
        });
      }
    }
    return sustained;
  }
}

module.exports = { EmotionalState };
