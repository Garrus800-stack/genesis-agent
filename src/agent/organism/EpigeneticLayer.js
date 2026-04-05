// ============================================================
// GENESIS — EpigeneticLayer.js (v5.0.0 — Digital Organism)
//
// Experience changes the organism. Not just what it knows
// (ConversationMemory), but what it IS (Genome traits).
//
// In biology, epigenetics is the mechanism by which environment
// alters gene expression without changing the DNA sequence.
// Stress upregulates cortisol receptors. Exercise epigenetically
// enhances muscle growth pathways. Trauma alters stress response
// for generations.
//
// In Genesis, epigenetics means: repeated success at self-
// modification increases riskTolerance. Repeated circuit breaker
// trips increase caution. Successful exploration increases
// curiosity. Positive user feedback increases socialDrive.
//
// The EpigeneticLayer listens to EventBus events, accumulates
// patterns in rolling windows, and applies conditioning rules
// during DreamCycle consolidation. Trait changes are small
// (capped at ±0.05 per cycle) but cumulative over time.
//
// Architecture:
//   EventBus events → EpigeneticLayer._onEvent() → rolling window
//   DreamCycle consolidation → EpigeneticLayer.consolidate()
//   EpigeneticLayer → Genome.adjustTrait() → persistent change
//   IntrospectionEngine → EpigeneticLayer.getHistory()
// ============================================================

const { NullBus } = require('../core/EventBus');
const { createLogger } = require('../core/Logger');
const _log = createLogger('EpigeneticLayer');

// ── Conditioning Rules ───────────────────────────────────
// Each rule defines: which events to watch, what pattern to
// detect, and what trait adjustment to apply when triggered.
const CONDITIONING_RULES = [
  {
    id: 'selfmod-success-streak',
    trigger: 'selfmod:success',
    evaluate: (window) => window.length >= 3,
    effect: { trait: 'riskTolerance', delta: +0.02 },
    cooldownMs: 3600000, // 1 hour
    description: 'Repeated self-mod success increases risk tolerance',
  },
  {
    id: 'selfmod-frozen',
    trigger: 'selfmod:frozen',
    evaluate: (window) => window.length >= 1,
    effect: { trait: 'caution', delta: +0.04 },
    cooldownMs: 7200000, // 2 hours
    description: 'Circuit breaker trip increases caution',
  },
  {
    id: 'selfmod-failure-trend',
    trigger: 'selfmod:failure',
    evaluate: (window) => window.length >= 5,
    effect: { trait: 'riskTolerance', delta: -0.03 },
    cooldownMs: 3600000,
    description: 'Repeated self-mod failures decrease risk tolerance',
  },
  {
    id: 'exploration-success',
    trigger: 'idle:thought-complete',
    evaluate: (window) => {
      const explores = window.filter(e => e.data?.activity === 'explore');
      return explores.length >= 5;
    },
    effect: { trait: 'curiosity', delta: +0.02 },
    cooldownMs: 7200000,
    description: 'Successful exploration reinforces curiosity',
  },
  {
    id: 'user-positive-feedback',
    trigger: 'chat:completed',
    evaluate: (window) => {
      // FIX v5.0.0: Require explicit positive signal. The previous condition
      // (success !== false) matched every event where success was undefined,
      // causing socialDrive to drift upward after any 10 messages.
      const positive = window.filter(e => e.data?.feedback === 'positive' || e.data?.success === true);
      return positive.length >= 10;
    },
    effect: { trait: 'socialDrive', delta: +0.015 },
    cooldownMs: 3600000,
    description: 'Positive interaction increases social drive',
  },
  {
    id: 'error-accumulation',
    trigger: 'agent:error',
    evaluate: (window) => window.length >= 10,
    effect: { trait: 'caution', delta: +0.02 },
    cooldownMs: 7200000,
    description: 'Accumulated errors increase caution',
  },
  {
    id: 'dream-consolidation-success',
    trigger: 'dream:complete',
    evaluate: (window) => {
      const withSchemas = window.filter(e => (e.data?.schemasCreated || 0) > 0);
      return withSchemas.length >= 3;
    },
    effect: { trait: 'consolidation', delta: +0.02 },
    cooldownMs: 14400000, // 4 hours
    description: 'Productive dream cycles reinforce consolidation tendency',
  },
  {
    id: 'energy-depletion-pattern',
    trigger: 'metabolism:state-changed',
    evaluate: (window) => {
      const depletions = window.filter(e => e.data?.to === 'depleted');
      return depletions.length >= 3;
    },
    effect: { trait: 'curiosity', delta: -0.02 },
    cooldownMs: 14400000,
    description: 'Repeated energy depletion dampens exploratory drive',
  },
];

const WINDOW_SIZE = 100;  // Max events per trigger type
const WINDOW_MAX_AGE_MS = 24 * 60 * 60 * 1000; // FIX D-2: Expire events older than 24h
const MAX_DELTA_PER_CONSOLIDATION = 0.05; // Total trait change cap per cycle

class EpigeneticLayer {
  static containerConfig = {
    name: 'epigeneticLayer',
    phase: 9, // After cognitive layer, needs DreamCycle integration
    deps: ['eventStore', 'storage'],
    tags: ['organism', 'epigenetic', 'conditioning'],
    lateBindings: [
      { prop: 'genome', service: 'genome', optional: false },
      { prop: 'dreamCycle', service: 'dreamCycle', optional: true },
    ],
  };

  constructor({ bus, eventStore, storage }) {
    this.bus = bus || NullBus;
    this.eventStore = eventStore || null;
    this.storage = storage || null;

    // Late-bound
    this.genome = null;
    this.dreamCycle = null;

    // ── Rolling event windows per trigger type ───────────
    this._windows = new Map(); // DA-1: bounded by rule count, cap 200 // trigger → [{data, timestamp}]
    for (const rule of CONDITIONING_RULES) {
      if (!this._windows.has(rule.trigger)) {
        this._windows.set(rule.trigger, []);
      }
    }

    // ── Cooldown tracking ────────────────────────────────
    this._lastFired = new Map(); // DA-1: bounded by rule count, cap 200 // ruleId → timestamp

    // ── History ──────────────────────────────────────────
    this._conditioningHistory = []; // { ruleId, trait, delta, timestamp }
    this._maxHistory = 200;

    // ── Stats ────────────────────────────────────────────
    this._stats = { evaluations: 0, adjustments: 0, cooldownSkips: 0 };

    this._wireEvents();
  }

  // ════════════════════════════════════════════════════════════
  // LIFECYCLE
  // ════════════════════════════════════════════════════════════

  start() {
    // Hook into DreamCycle consolidation if available
    this.bus.on('dream:complete', () => {
      this.consolidate();
    }, { source: 'EpigeneticLayer', priority: -10 });

    _log.info(`[EPIGENETIC] Active — ${CONDITIONING_RULES.length} conditioning rules, window size ${WINDOW_SIZE}`);
  }

  stop() {
    // FIX D-1: Sync write on shutdown — debounced timer won't fire after process exit.
    this._persistHistorySync();
  }

  async asyncLoad() {
    if (!this.storage) return;
    try {
      const saved = await this.storage.readJSONAsync('epigenetic-history.json');
      if (saved?.history) {
        this._conditioningHistory = saved.history.slice(-this._maxHistory);
      }
      if (saved?.lastFired) {
        for (const [k, v] of Object.entries(saved.lastFired)) {
          this._lastFired.set(k, v);
        }
      }
    } catch { /* first boot */ }
  }

  // ════════════════════════════════════════════════════════════
  // CORE: CONSOLIDATION — evaluate all rules and adjust traits
  // ════════════════════════════════════════════════════════════

  /**
   * Evaluate all conditioning rules against accumulated event windows.
   * Called during DreamCycle consolidation or manually.
   * @returns {{ evaluated: number, adjusted: string[], skipped: string[] }}
   */
  consolidate() {
    if (!this.genome) {
      _log.debug('[EPIGENETIC] No genome bound — skipping consolidation');
      return { evaluated: 0, adjusted: [], skipped: [] };
    }

    const now = Date.now();
    const adjusted = [];
    const skipped = [];
    let totalDelta = 0;

    // FIX D-2: Prune stale events from rolling windows. Without this,
    // events from days ago could trigger conditioning rules the moment
    // their cooldown expires — the pattern should reflect recent behavior.
    for (const [trigger, window] of this._windows) {
      const fresh = window.filter(e => now - e.timestamp < WINDOW_MAX_AGE_MS);
      if (fresh.length < window.length) {
        this._windows.set(trigger, fresh);
      }
    }

    for (const rule of CONDITIONING_RULES) {
      this._stats.evaluations++;

      // Check cooldown
      const lastFired = this._lastFired.get(rule.id) || 0;
      if (now - lastFired < rule.cooldownMs) {
        this._stats.cooldownSkips++;
        skipped.push(rule.id);
        continue;
      }

      // Check total delta cap for this cycle
      if (Math.abs(totalDelta) >= MAX_DELTA_PER_CONSOLIDATION) {
        skipped.push(rule.id);
        continue;
      }

      // Get the event window for this rule's trigger
      const window = this._windows.get(rule.trigger) || [];

      // Evaluate the pattern
      try {
        if (rule.evaluate(window)) {
          // Apply trait adjustment
          const result = this.genome.adjustTrait(
            rule.effect.trait,
            rule.effect.delta,
            `epigenetic:${rule.id}`
          );

          if (result.applied) {
            this._lastFired.set(rule.id, now);
            totalDelta += Math.abs(rule.effect.delta);
            adjusted.push(rule.id);
            this._stats.adjustments++;

            this._conditioningHistory.push({
              ruleId: rule.id,
              trait: rule.effect.trait,
              delta: rule.effect.delta,
              before: result.before,
              after: result.after,
              timestamp: now,
              description: rule.description,
            });
            if (this._conditioningHistory.length > this._maxHistory) {
              this._conditioningHistory.shift();
            }

            _log.info(`[EPIGENETIC] Rule "${rule.id}" fired: ${rule.effect.trait} ${rule.effect.delta > 0 ? '+' : ''}${rule.effect.delta}`);
          }

          // Clear the window after firing (prevents re-triggering on same events)
          this._windows.set(rule.trigger, []);
        }
      } catch (err) {
        _log.warn(`[EPIGENETIC] Rule "${rule.id}" evaluation error:`, err.message);
      }
    }

    if (adjusted.length > 0) {
      this.bus.emit('epigenetic:consolidation', {
        adjusted,
        skipped,
        totalDelta: Math.round(totalDelta * 1000) / 1000,
      }, { source: 'EpigeneticLayer' });
    }

    this._persistHistory();
    return { evaluated: CONDITIONING_RULES.length, adjusted, skipped };
  }

  // ════════════════════════════════════════════════════════════
  // EVENT WIRING
  // ════════════════════════════════════════════════════════════

  _wireEvents() {
    // Collect unique triggers from all rules
    const triggers = new Set(CONDITIONING_RULES.map(r => r.trigger));

    for (const trigger of triggers) {
      this.bus.on(trigger, (data) => {
        const window = this._windows.get(trigger);
        if (!window) return;
        window.push({ data: data || {}, timestamp: Date.now() });
        if (window.length > WINDOW_SIZE) window.shift();
      }, { source: 'EpigeneticLayer', priority: -20 });
    }
  }

  // ════════════════════════════════════════════════════════════
  // PUBLIC API
  // ════════════════════════════════════════════════════════════

  /** Get conditioning history for IntrospectionEngine */
  getHistory() {
    return [...this._conditioningHistory];
  }

  /** Get recent trait shifts (last N) */
  getRecentShifts(n = 10) {
    return this._conditioningHistory.slice(-n);
  }

  getStats() {
    return { ...this._stats, historySize: this._conditioningHistory.length };
  }

  /** Get all conditioning rules (for dashboard display) */
  getRules() {
    const now = Date.now();
    return CONDITIONING_RULES.map(rule => ({
      id: rule.id,
      trigger: rule.trigger,
      effect: rule.effect,
      description: rule.description,
      windowSize: (this._windows.get(rule.trigger) || []).length,
      cooldownRemaining: Math.max(0, (this._lastFired.get(rule.id) || 0) + rule.cooldownMs - now),
    }));
  }

  // ════════════════════════════════════════════════════════════
  // PERSISTENCE
  // ════════════════════════════════════════════════════════════

  _persistHistory() {
    if (!this.storage) return;
    try {
      // FIX v5.0.0: Debounced write — consolidate() runs during DreamCycle
      // which is already a heavy I/O phase. Avoid blocking main thread.
      this.storage.writeJSONDebounced('epigenetic-history.json', this._persistData(), 2000);
    } catch (err) {
      _log.warn('[EPIGENETIC] Persist failed:', err.message);
    }
  }

  /** FIX D-1: Sync write for shutdown path — guarantees data reaches disk before exit. */
  _persistHistorySync() {
    if (!this.storage) return;
    try {
      this.storage.writeJSON('epigenetic-history.json', this._persistData());
    } catch (err) {
      _log.warn('[EPIGENETIC] Sync persist failed:', err.message);
    }
  }

  /** @private Shared payload for both persist paths. */
  _persistData() {
    return {
      history: this._conditioningHistory.slice(-50),
      lastFired: Object.fromEntries(this._lastFired),
    };
  }
}

module.exports = { EpigeneticLayer, CONDITIONING_RULES };
