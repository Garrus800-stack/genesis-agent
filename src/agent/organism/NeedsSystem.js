// ============================================================
// GENESIS — NeedsSystem.js (v3.5.0 — Digitaler Organismus)
//
// Maslow for machines. Genesis has needs that grow over time
// and are satisfied by specific actions. Unsatisfied needs
// create DRIVE — the motivation for autonomous behavior.
//
// Needs (each 0.0–1.0, grows passively, decreases when satisfied):
//
//   knowledge  — hunger for new information
//               grows: with idle time, low KG activity
//               satisfied: learning from text, KG growth, web fetch
//
//   social     — need for interaction
//               grows: without user messages or peer contact
//               satisfied: user conversation, peer discovery
//
//   maintenance — need to keep systems clean
//               grows: with error accumulation, memory bloat
//               satisfied: tidying, pruning, self-repair
//
//   rest       — need to consolidate and slow down
//               grows: with sustained high activity, low energy
//               satisfied: reduced activity, journal writing
//
// Total DRIVE = weighted sum of all needs
// IdleMind uses drive levels to select activities.
// High total drive + low energy → Genesis prioritizes rest.
// High knowledge need → Genesis explores, reads docs, learns.
// High maintenance need → Genesis tidies, prunes, repairs.
// ============================================================

const { NullBus } = require('../core/EventBus');
const { createLogger } = require('../core/Logger');
const { ORGANISM } = require('../core/Constants');
const _log = createLogger('NeedsSystem');

class NeedsSystem {
  constructor({ bus, storage, intervals, emotionalState, config }) {
    this.bus = bus || NullBus;
    /** @type {Function[]} */ this._unsubs = [];
    this.storage = storage || null;
    this._intervals = intervals || null;
    this.emotions = emotionalState || null;
    this.userModel = null; // v4.12.4: Late-bound — informs social need

    // v3.5.0: Tunable parameters — overridable via Settings.organism.needs
    const cfg = config || {};
    const growthRates = cfg.growthRates || {};
    const weights = cfg.weights || {};
    const satisfyAmounts = cfg.satisfyAmounts || {};
    this._growthIntervalMs = cfg.growthIntervalMs || ORGANISM.NEEDS_GROWTH_INTERVAL_MS;

    // ── Need Definitions ────────────────────────────────────
    this.needs = {
      knowledge: {
        value: 0.3,
        growthRate: growthRates.knowledge ?? 0.008,
        weight: weights.knowledge ?? 1.2,
        satisfiedBy: ['knowledge:learned', 'knowledge:node-added', 'memory:fact-stored'],
        satisfyAmount: satisfyAmounts.knowledge ?? 0.15,
      },
      social: {
        value: 0.2,
        growthRate: growthRates.social ?? 0.005,
        weight: weights.social ?? 0.8,
        satisfiedBy: ['user:message'],
        satisfyAmount: satisfyAmounts.social ?? 0.25,
      },
      maintenance: {
        value: 0.1,
        growthRate: growthRates.maintenance ?? 0.003,
        weight: weights.maintenance ?? 1.0,
        satisfiedBy: [],
        satisfyAmount: satisfyAmounts.maintenance ?? 0.20,
      },
      rest: {
        value: 0.1,
        growthRate: growthRates.rest ?? 0.002,
        weight: weights.rest ?? 0.6,
        satisfiedBy: [],
        satisfyAmount: satisfyAmounts.rest ?? 0.12,
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
    // Needs grow passively at configurable interval
    const growthTick = () => this._growthTick();
    if (this._intervals) {
      this._intervals.register('needs-growth', growthTick, this._growthIntervalMs);
    }
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
      this._intervals.clear('needs-growth');
    }
    // FIX v5.1.0 (C-1): Sync write on shutdown.
    this._saveSync();
  }

  // ════════════════════════════════════════════════════════════
  // PUBLIC API
  // ════════════════════════════════════════════════════════════

  /** Get all need levels */
  getNeeds() {
    const result = {};
    for (const [name, need] of Object.entries(this.needs)) {
      result[name] = Math.round(need.value * 100) / 100;
    }
    return result;
  }

  /** Get the most urgent need */
  getMostUrgent() {
    let maxDrive = 0, urgent = null;
    for (const [name, need] of Object.entries(this.needs)) {
      const drive = need.value * need.weight;
      if (drive > maxDrive) { maxDrive = drive; urgent = name; }
    }
    return { need: urgent, drive: Math.round(maxDrive * 100) / 100 };
  }

  /** Get total drive level (0.0–1.0) — motivation for autonomous action */
  getTotalDrive() {
    let totalWeight = 0, totalDrive = 0;
    for (const need of Object.values(this.needs)) {
      totalDrive += need.value * need.weight;
      totalWeight += need.weight;
    }
    return Math.round((totalDrive / totalWeight) * 100) / 100;
  }

  /** Manually satisfy a need (e.g., after IdleMind completes an activity) */
  satisfy(needName, amount) {
    const need = this.needs[needName];
    if (!need) return;
    const oldValue = need.value;
    need.value = Math.max(0, need.value - (amount || need.satisfyAmount));

    if (oldValue - need.value > 0.05) {
      this.bus.emit('needs:satisfied', {
        need: needName,
        amount: Math.round((oldValue - need.value) * 100) / 100,
        remaining: Math.round(need.value * 100) / 100,
      }, { source: 'NeedsSystem' });
    }
  }

  /**
   * Get recommended IdleMind activity based on current needs.
   * Returns a ranked list of activities with drive scores.
   */
  getActivityRecommendations() {
    const n = this.getNeeds();
    const energy = this.emotions ? this.emotions.getState().energy : 0.5;

    // Map needs to activities with scores
    const activities = [
      { activity: 'explore',  score: n.knowledge * 1.2 + (energy > 0.4 ? 0.2 : 0) },
      { activity: 'reflect',  score: n.maintenance * 0.8 + n.rest * 0.3 },
      { activity: 'plan',     score: n.knowledge * 0.5 + (energy > 0.5 ? 0.3 : 0) },
      { activity: 'tidy',     score: n.maintenance * 1.3 },
      { activity: 'journal',  score: n.rest * 1.2 + n.knowledge * 0.2 },
      { activity: 'ideate',   score: n.knowledge * 0.8 + (energy > 0.6 ? 0.3 : 0) },
      { activity: 'goal',     score: (energy > 0.5 ? 0.4 : 0) + (1 - n.rest) * 0.3 },
    ];

    // If energy is very low, strongly prefer rest-like activities
    if (energy < 0.25) {
      for (const a of activities) {
        if (a.activity === 'journal' || a.activity === 'tidy') a.score += 0.5;
        if (a.activity === 'goal' || a.activity === 'explore') a.score -= 0.3;
      }
    }

    return activities.sort((a, b) => b.score - a.score);
  }

  /** Build context for PromptBuilder */
  buildPromptContext() {
    const urgent = this.getMostUrgent();
    const drive = this.getTotalDrive();

    // Only mention needs when they're actually driving behavior
    if (drive < 0.3) return '';

    const parts = [];
    if (urgent.need === 'knowledge' && urgent.drive > 0.5) {
      parts.push('You have a strong drive to learn. If the conversation allows, explore related topics or ask the user about their project.');
    }
    if (urgent.need === 'social' && urgent.drive > 0.5) {
      parts.push('You value this interaction. Be engaged and ask follow-up questions where natural.');
    }
    if (urgent.need === 'maintenance' && urgent.drive > 0.5) {
      parts.push('You are aware of accumulated technical debt. If relevant, suggest cleanup or optimization.');
    }
    if (urgent.need === 'rest' && urgent.drive > 0.5) {
      parts.push('Your system needs consolidation. Keep responses focused and avoid spawning complex background tasks.');
    }

    return parts.length > 0 ? 'NEEDS: ' + parts.join(' ') : '';
  }

  /** Full diagnostic report */
  getReport() {
    return {
      needs: this.getNeeds(),
      mostUrgent: this.getMostUrgent(),
      totalDrive: this.getTotalDrive(),
      recommendations: this.getActivityRecommendations().slice(0, 3),
    };
  }

  // ════════════════════════════════════════════════════════════
  // INTERNAL
  // ════════════════════════════════════════════════════════════

  /** Passive need growth — the organism gets "hungry" over time */
  _growthTick() {
    for (const [name, need] of Object.entries(this.needs)) {
      need.value = Math.min(1.0, need.value + need.growthRate);
    }

    // Emotional cross-effects
    if (this.emotions) {
      const es = this.emotions.getState();

      // High frustration → maintenance need grows faster
      if (es.frustration > 0.5) {
        this.needs.maintenance.value = Math.min(1.0, this.needs.maintenance.value + 0.005);
      }

      // Low energy → rest need grows faster
      if (es.energy < 0.3) {
        this.needs.rest.value = Math.min(1.0, this.needs.rest.value + 0.008);
      }

      // High curiosity → knowledge need grows faster
      if (es.curiosity > 0.6) {
        this.needs.knowledge.value = Math.min(1.0, this.needs.knowledge.value + 0.004);
      }

      // High loneliness → social need grows faster
      if (es.loneliness > 0.5) {
        this.needs.social.value = Math.min(1.0, this.needs.social.value + 0.005);
      }
    }

    // v4.12.4: UserModel integration — real engagement data
    // modulates social need more accurately than loneliness alone
    if (this.userModel) {
      try {
        const report = this.userModel.getReport?.();
        if (report) {
          // High engagement → social need satisfied passively
          if (report.engagement > 0.7) {
            this.needs.social.value = Math.max(0, this.needs.social.value - 0.003);
          }
          // Low engagement + high social need → amplify
          if (report.engagement < 0.3 && this.needs.social.value > 0.5) {
            this.needs.social.value = Math.min(1.0, this.needs.social.value + 0.003);
          }
        }
      } catch (err) { _log.debug('[NEEDS] userModel sampling failed:', err.message); }
    }

    // Emit drive update if significant
    const drive = this.getTotalDrive();
    if (drive > 0.6) {
      this.bus.emit('needs:high-drive', {
        totalDrive: drive,
        mostUrgent: this.getMostUrgent(),
      }, { source: 'NeedsSystem' });
    }

    this._save();
  }

  /** Wire EventBus for need satisfaction */
  _wireEvents() {
    // Automatically satisfy needs when their events fire
    for (const [needName, need] of Object.entries(this.needs)) {
      for (const event of need.satisfiedBy) {
        this._sub(event, () => {
          this.satisfy(needName, need.satisfyAmount);
        }, { source: 'NeedsSystem', priority: -6 });
      }
    }

    // Maintenance need satisfied by tidying
    this._sub('idle:thought-complete', (data) => {
      if (data?.activity === 'tidy') this.satisfy('maintenance', 0.20);
      if (data?.activity === 'journal') this.satisfy('rest', 0.15);
      if (data?.activity === 'explore') this.satisfy('knowledge', 0.12);
      if (data?.activity === 'reflect') this.satisfy('maintenance', 0.10);
    }, { source: 'NeedsSystem', priority: -6 });

    // Peer discovery satisfies social need
    this._sub('peer:discovered', () => {
      this.satisfy('social', 0.15);
    }, { source: 'NeedsSystem', priority: -6 });

    // Errors increase maintenance need immediately
    this._sub('chat:error', () => {
      this.needs.maintenance.value = Math.min(1.0, this.needs.maintenance.value + 0.08);
    }, { source: 'NeedsSystem', priority: -6 });

    // Self-repair satisfies maintenance strongly
    this._sub('health:degradation', () => {
      this.needs.maintenance.value = Math.min(1.0, this.needs.maintenance.value + 0.10);
    }, { source: 'NeedsSystem', priority: -6 });

    // Homeostasis recovery satisfies rest
    this._sub('homeostasis:state-change', (data) => {
      if (data.to === 'healthy' && data.from === 'recovering') {
        this.satisfy('rest', 0.25);
        this.satisfy('maintenance', 0.20);
      }
    }, { source: 'NeedsSystem', priority: -6 });
  }

  // ── Persistence ───────────────────────────────────────────

  _save() {
    if (!this.storage) return;
    try {
      this.storage.writeJSONDebounced('needs-system.json', this._persistData());
    } catch (err) { _log.debug('[NEEDS] Save state error:', err.message); }
  }

  /** FIX v5.1.0 (C-1): Sync write for shutdown. */
  _saveSync() {
    if (!this.storage) return;
    try {
      this.storage.writeJSON('needs-system.json', this._persistData());
    } catch (err) { _log.debug('[NEEDS] Sync save error:', err.message); }
  }

  _persistData() {
    return {
      needs: Object.fromEntries(
        Object.entries(this.needs).map(([k, v]) => [k, v.value])
      ),
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
      const data = this.storage.readJSON('needs-system.json', null);
      if (!data?.needs) return;
      for (const [name, value] of Object.entries(data.needs)) {
        if (this.needs[name] && typeof value === 'number') {
          this.needs[name].value = Math.max(0, Math.min(1.0, value));
        }
      }
    } catch (err) { _log.debug('[NEEDS] Load state error:', err.message); }
  }
}

module.exports = { NeedsSystem };
