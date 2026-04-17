// @ts-checked-v5.8
// ============================================================
// GENESIS — Metabolism.js (v4.12.5 — Digitaler Organismus)
//
// PROBLEM: EmotionalState.energy decreases by a fixed -0.02
// per chat:completed, regardless of whether the LLM call used
// 200 or 50,000 tokens. Energy is decorative, not metabolic.
//
// SOLUTION: A metabolism module that tracks real resource costs
// and translates them into proportional energy expenditure.
// Energy becomes a REAL resource that reflects actual load.
//
// Metabolic inputs (per LLM call):
//   - Token count (prompt + completion)
//   - Latency (ms)
//   - Memory delta (heap change)
//
// These are normalized and converted to an energy cost 0.0–0.15
// per call. High-cost calls drain more energy. Idle periods
// restore energy (like biological rest).
//
// Architecture:
//   ChatOrchestrator → chat:completed (with token/latency data)
//   Metabolism._onChatCompleted() → compute real cost
//   Metabolism → EmotionalState._adjust('energy', -cost)
//   Metabolism → NeedsSystem (rest need grows with depletion)
//   IdleMind idle periods → Metabolism._restoreTick()
//
// The old fixed -0.02 in EmotionalState is preserved as
// fallback — Metabolism overrides it with the real value
// by applying a compensating adjustment.
// ============================================================

const { NullBus } = require('../core/EventBus');
const { createLogger } = require('../core/Logger');
const { ORGANISM } = require('../core/Constants');
const _log = createLogger('Metabolism');

// ── Cost normalization constants ────────────────────────────
// These define what "normal" resource usage looks like.
// Calls that exceed these values cost proportionally more energy.
const BASELINE = {
  tokens: 2000,       // A "normal" LLM call (prompt + completion)
  latencyMs: 3000,    // Normal response time
  heapDeltaMB: 10,    // Normal heap growth per call
};

// Weight of each factor in the total cost (sum = 1.0)
const WEIGHTS = {
  tokens: 0.50,       // Token count is the primary cost driver
  latency: 0.30,      // Latency indicates model strain
  memory: 0.20,       // Memory growth indicates complexity
};

// Energy cost range per call
const COST = {
  min: 0.005,         // Minimum cost even for trivial calls
  max: 0.15,          // Maximum cost for extreme calls
  baseFallback: 0.02, // The old fixed cost (for compensation)
};

// Recovery rate during idle
const RECOVERY = {
  ratePerMinute: 0.008,  // Energy restored per minute of idle
  maxRate: 0.015,        // Maximum recovery (even very long idle)
};

class Metabolism {
  constructor({ bus, storage, intervals, config }) {
    this.bus = bus || NullBus;
    this.storage = storage || null;
    this._intervals = intervals || null;

    // Late-bound
    this.emotionalState = null;
    this.needsSystem = null;
    this.homeostasis = null;
    this.genome = null; // v5.0.0: Genome traits influence regeneration rate

    // ── Configuration ────────────────────────────────────
    const cfg = config || {};
    this._baseline = { ...BASELINE, ...cfg.baseline };
    this._weights = { ...WEIGHTS, ...cfg.weights };
    this._cost = { ...COST, ...cfg.cost };
    this._recovery = { ...RECOVERY, ...cfg.recovery };
    this._recoveryIntervalMs = cfg.recoveryIntervalMs || ORGANISM.METABOLISM_RECOVERY_MS;

    // v5.0.0: Discrete energy pool config — must be set BEFORE _initEnergyPool()
    this._energyPoolConfig = cfg.energyPool || {};
    /** @type {number} */ this._energy = 0;
    /** @type {number} */ this._maxEnergy = ORGANISM.METABOLISM_INITIAL_MAX_ENERGY;
    /** @type {number} */ this._maxEnergyHistory = ORGANISM.METABOLISM_MAX_ENERGY_HISTORY;
    /** @type {Array<{ timestamp: number, energy: number, event: string, delta: number }>} */
    this._energyHistory = [];
    this._initEnergyPool();

    // ── State ────────────────────────────────────────────
    this._heapBefore = 0;
    this._lastCallTime = 0;
    this._lastTokenCount = 0;
    this._totalEnergySpent = 0;
    this._totalEnergyRecovered = 0;
    this._callCount = 0;
    this._recentCosts = [];     // Last 20 energy costs for trending
    this._maxRecentCosts = ORGANISM.METABOLISM_MAX_RECENT_COSTS;

    // FIX v5.0.0: Track energy spent since last FitnessEvaluator period reset.
    // Without this, energyEfficiency degrades monotonically to ~0 over time.
    this._periodEnergySpent = 0;

    this._wireEvents();
  }

  // ════════════════════════════════════════════════════════════
  // LIFECYCLE
  // ════════════════════════════════════════════════════════════

  start() {
    // Recovery tick — energy slowly restores during idle
    if (this._intervals) {
      this._intervals.register('metabolism-recovery', () => {
        this._recoveryTick();
      }, this._recoveryIntervalMs);
    }
    _log.info('[METABOLISM] Active — real energy accounting enabled');
  }

  stop() {
    if (this._intervals) {
      this._intervals.clear('metabolism-recovery');
    }
    // FIX v5.1.0 (H-1): Persist energy state on shutdown.
    // Previously Metabolism had no persistence — all energy state was lost on restart.
    this._saveSync();
  }

  async asyncLoad() {
    // FIX v5.1.0 (H-1): Load persisted energy state.
    this._load();
  }

  // ════════════════════════════════════════════════════════════
  // CORE: ENERGY COST COMPUTATION
  // ════════════════════════════════════════════════════════════

  /**
   * Compute the real energy cost of an LLM call.
   * Returns a value between COST.min and COST.max.
   *
   * @param {{ tokens?: number, totalTokens?: number, latencyMs?: number, duration?: number }} data - LLM call metrics
   * @param {number} [heapDeltaMB] - Heap change during the call
   * @returns {number} Energy cost 0.005–0.15
   */
  computeCost(data, heapDeltaMB) {
    const tokens = data?.tokens || data?.totalTokens || this._baseline.tokens;
    const latency = data?.latencyMs || data?.duration || this._baseline.latencyMs;
    const heap = Math.max(0, heapDeltaMB || 0);

    // Normalize each factor: 1.0 = baseline, >1.0 = above normal
    const tokenRatio = Math.max(0.1, tokens / this._baseline.tokens);
    const latencyRatio = Math.max(0.1, latency / this._baseline.latencyMs);
    const memoryRatio = Math.max(0.1, heap / this._baseline.heapDeltaMB);

    // Weighted sum (will be ~1.0 for a "normal" call)
    const rawCost = (tokenRatio * this._weights.tokens)
                  + (latencyRatio * this._weights.latency)
                  + (memoryRatio * this._weights.memory);

    // Scale to energy range with diminishing returns above 2x
    const scaled = rawCost <= 1.0
      ? rawCost * this._cost.baseFallback          // Normal: linear
      : this._cost.baseFallback + Math.log2(rawCost) * 0.03; // Heavy: logarithmic

    return Math.max(this._cost.min, Math.min(this._cost.max, scaled));
  }

  // ════════════════════════════════════════════════════════════
  // EVENT HANDLERS
  // ════════════════════════════════════════════════════════════

  _onChatStarting() {
    // Snapshot heap before the call
    try {
      this._heapBefore = process.memoryUsage().heapUsed;
    } catch { /* memoryUsage unavailable — safe default */ this._heapBefore = 0; }
  }

  _onChatCompleted(data) {
    this._callCount++;
    this._lastCallTime = Date.now();
    this._lastTokenCount = (data?.tokens || data?.totalTokens || 0);

    // Compute heap delta
    let heapDeltaMB = 0;
    try {
      const heapAfter = process.memoryUsage().heapUsed;
      heapDeltaMB = (heapAfter - this._heapBefore) / (1024 * 1024);
    } catch { /* safe */ }

    // Compute real energy cost
    const cost = this.computeCost(data, heapDeltaMB);

    // EmotionalState already applies a fixed -0.02 in its own
    // chat:completed handler. We compensate:
    //   actual adjustment = -cost + baseFallback (to cancel the fixed one)
    //   net effect = -cost
    if (this.emotionalState) {
      const compensation = this._cost.baseFallback; // +0.02 to cancel the fixed -0.02
      const netAdjust = compensation - cost;         // positive if cost < 0.02, negative if cost > 0.02
      if (Math.abs(netAdjust) > 0.001) {
        this.emotionalState._adjust('energy', netAdjust);
      }
    }

    // Track costs
    this._totalEnergySpent += cost;
    this._periodEnergySpent += cost;
    this._recentCosts.push(cost);
    if (this._recentCosts.length > this._maxRecentCosts) {
      this._recentCosts.shift();
    }

    // High cost → push rest need
    if (this.needsSystem && cost > this._cost.baseFallback * 2) {
      this.needsSystem.needs.rest.value = Math.min(1.0,
        this.needsSystem.needs.rest.value + (cost * 0.5));
    }

    this.bus.emit('metabolism:cost', {
      cost: Math.round(cost * 1000) / 1000,
      tokens: data?.tokens || data?.totalTokens || 0,
      latencyMs: data?.latencyMs || data?.duration || 0,
      heapDeltaMB: Math.round(heapDeltaMB * 10) / 10,
    }, { source: 'Metabolism' });
  }

  /**
   * Passive energy recovery during idle periods.
   * Like biological rest — energy regenerates when not working.
   */
  _recoveryTick() {
    // v5.0.0: Discrete energy pool regeneration (genome-influenced)
    const consolidation = this.genome?.trait('consolidation') ?? 0.5;
    this.regenerate(consolidation);

    if (!this.emotionalState) return;

    const energy = this.emotionalState.dimensions.energy.value;
    const timeSinceCall = Date.now() - this._lastCallTime;

    // Only recover if idle for > 30 seconds
    if (timeSinceCall < ORGANISM.METABOLISM_CALL_COOLDOWN_MS) return;

    // Recovery rate scales with how depleted we are
    // Very low energy → faster recovery (the body demands rest)
    const depletionFactor = energy < 0.3 ? 1.5 : (energy < 0.5 ? 1.2 : 1.0);
    const rate = Math.min(this._recovery.maxRate,
      this._recovery.ratePerMinute * depletionFactor);

    if (energy < this.emotionalState.dimensions.energy.baseline) {
      this.emotionalState._adjust('energy', rate);
      this._totalEnergyRecovered += rate;
    }
  }

  // ════════════════════════════════════════════════════════════
  // EVENT WIRING
  // ════════════════════════════════════════════════════════════

  _wireEvents() {
    // Snapshot before call
    this.bus.on('user:message', () => {
      this._onChatStarting();
    }, { source: 'Metabolism', priority: -20 });

    // Process after call (lower priority so EmotionalState reacts first)
    this.bus.on('chat:completed', (data) => {
      this._onChatCompleted(data);
    }, { source: 'Metabolism', priority: -15 });
  }

  // ════════════════════════════════════════════════════════════
  // PUBLIC API
  // ════════════════════════════════════════════════════════════

  /** Get current metabolic rate (average cost per call) */
  getMetabolicRate() {
    if (this._recentCosts.length === 0) return 0;
    const sum = this._recentCosts.reduce((a, b) => a + b, 0);
    return Math.round((sum / this._recentCosts.length) * 1000) / 1000;
  }

  // ════════════════════════════════════════════════════════════
  // v5.0.0: DISCRETE ENERGY BUDGET
  //
  // The original Metabolism tracked proportional energy costs for
  // LLM calls via EmotionalState.energy (0.0–1.0). This extension
  // adds a discrete energy pool that gates ALL observable actions.
  //
  // Energy is measured in abstract units (AU). The pool starts at
  // maxEnergy and drains as activities are performed. It regenerates
  // over time. When energy is low, the organism shifts behavior.
  //
  // This is the mechanism that makes Homeostasis real: low energy
  // directly constrains what the organism CAN do, not just what
  // it SHOULD do.
  // ════════════════════════════════════════════════════════════

  /**
   * Activity cost matrix (in energy units).
   * Can be overridden via config.activityCosts.
   */
  static ACTIVITY_COSTS = {
    llmCall:           10,
    llmCallHeavy:      20,  // reasoning, code-gen
    sandboxExec:        5,
    selfModification:  50,
    idleMindCycle:      2,
    peerSync:           8,
    dreamCycleFull:    30,
    dreamCycleLight:    3,  // heuristic phases only
    webFetch:           4,
    skillExecution:     6,
  };

  /**
   * Energy state thresholds (as percentage of max).
   */
  static ENERGY_STATES = {
    FULL:     { min: 0.80, label: 'full' },
    NORMAL:   { min: 0.40, label: 'normal' },
    LOW:      { min: 0.15, label: 'low' },
    DEPLETED: { min: 0.00, label: 'depleted' },
  };

  /**
   * Initialize the energy pool. Called after asyncLoad() or from constructor.
   * @private
   */
  _initEnergyPool() {
    const cfg = this._energyPoolConfig || {};
    this._maxEnergy = cfg.maxEnergy || ORGANISM.METABOLISM_MAX_ENERGY;
    this._energy = cfg.startEnergy || this._maxEnergy;
    this._regenPerMinute = cfg.regenPerMinute || 3;
    this._regenIdleMultiplier = cfg.regenIdleMultiplier || 2.5; // Bonus when idle > 5min
    this._activityCosts = { ...Metabolism.ACTIVITY_COSTS, ...(cfg.activityCosts || {}) };
    this._energyHistory = [];   // { timestamp, energy, event }
    this._maxEnergyHistory = ORGANISM.METABOLISM_MAX_ENERGY_HISTORY;
    this._lastEnergyState = 'full';
  }

  /**
   * Check if an activity can be afforded.
   * @param {string} activity - Key from ACTIVITY_COSTS
   * @returns {boolean}
   */
  canAfford(activity) {
    if (this._energy === undefined) this._initEnergyPool();
    const cost = this._activityCosts[activity] || 0;
    return this._energy >= cost;
  }

  /**
   * Consume energy for an activity. Returns false if insufficient.
   * @param {string} activity - Key from ACTIVITY_COSTS
   * @param {number} [costOverride] - Optional custom cost
   * @returns {{ ok: boolean, cost: number, remaining: number, state: string }}
   */
  consume(activity, costOverride) {
    if (this._energy === undefined) this._initEnergyPool();
    const cost = costOverride ?? (this._activityCosts[activity] || 0);

    if (this._energy < cost) {
      _log.debug(`[METABOLISM] Cannot afford "${activity}" (need ${cost}, have ${Math.round(this._energy)})`);
      this.bus.emit('metabolism:insufficient', {
        activity, cost, available: Math.round(this._energy),
      }, { source: 'Metabolism' });
      return { ok: false, cost, remaining: Math.round(this._energy), state: this.getEnergyState() };
    }

    this._energy = Math.max(0, this._energy - cost);
    this._totalEnergySpent += cost;
    this._periodEnergySpent += cost;

    this._recordEnergyEvent(`consume:${activity}`, -cost);

    const state = this.getEnergyState();
    const prevState = this._lastEnergyState;
    if (state !== prevState) {
      this._lastEnergyState = state;
      _log.info(`[METABOLISM] Energy state: ${prevState} → ${state} (${Math.round(this._energy)}/${this._maxEnergy})`);
      this.bus.emit('metabolism:state-changed', {
        state: state, from: prevState, to: state,
        energy: Math.round(this._energy),
        max: this._maxEnergy,
      }, { source: 'Metabolism' });
    }

    this.bus.emit('metabolism:consumed', {
      activity, cost,
      tokens: this._lastTokenCount || 0,
      remaining: Math.round(this._energy),
      state,
    }, { source: 'Metabolism' });

    return { ok: true, cost, remaining: Math.round(this._energy), state };
  }

  /**
   * Get current energy state label.
   * @returns {string}
   */
  getEnergyState() {
    if (this._energy === undefined) this._initEnergyPool();
    const ratio = this._energy / this._maxEnergy;
    const states = Metabolism.ENERGY_STATES;
    if (ratio >= states.FULL.min)   return states.FULL.label;
    if (ratio >= states.NORMAL.min) return states.NORMAL.label;
    if (ratio >= states.LOW.min)    return states.LOW.label;
    return states.DEPLETED.label;
  }

  /**
   * Get current energy level.
   * @returns {{ current: number, max: number, percent: number, state: string }}
   */
  getEnergyLevel() {
    if (this._energy === undefined) this._initEnergyPool();
    return {
      current: Math.round(this._energy),
      max: this._maxEnergy,
      percent: Math.round((this._energy / this._maxEnergy) * 100),
      state: this.getEnergyState(),
    };
  }

  /**
   * Regenerate energy. Called by the recovery tick.
   * Genome.consolidation trait scales regen rate.
   * @param {number} [genomeConsolidation=0.5] - Genome trait value
   */
  regenerate(genomeConsolidation = 0.5) {
    if (this._energy === undefined) this._initEnergyPool();
    if (this._energy >= this._maxEnergy) return;

    const timeSinceCall = Date.now() - this._lastCallTime;
    const idleBonus = timeSinceCall > ORGANISM.METABOLISM_IDLE_THRESHOLD_MS ? this._regenIdleMultiplier : 1.0;
    const traitBonus = 0.5 + genomeConsolidation; // 0.5–1.5x based on consolidation trait

    const regen = this._regenPerMinute * idleBonus * traitBonus;
    const prev = this._energy;
    this._energy = Math.min(this._maxEnergy, this._energy + regen);
    this._totalEnergyRecovered += (this._energy - prev);

    if (this._energy - prev > 0.01) {
      this._recordEnergyEvent('regen', this._energy - prev);
    }
  }

  /** @private */
  _recordEnergyEvent(event, delta) {
    this._energyHistory.push({
      timestamp: Date.now(),
      energy: Math.round(this._energy),
      event,
      delta: Math.round(delta * 10) / 10,
    });
    if (this._energyHistory.length > this._maxEnergyHistory) {
      this._energyHistory.shift();
    }
  }

  /**
   * Get energy history for dashboard/introspection.
   */
  getEnergyHistory() {
    return this._energyHistory.slice(-50);
  }

  getReport() {
    if (this._energy === undefined) this._initEnergyPool();
    return {
      callCount: this._callCount,
      totalEnergySpent: Math.round(this._totalEnergySpent * 1000) / 1000,
      // FIX v5.0.0: Expose period-scoped spend for FitnessEvaluator.energyEfficiency.
      periodEnergySpent: Math.round(this._periodEnergySpent * 1000) / 1000,
      totalEnergyRecovered: Math.round(this._totalEnergyRecovered * 1000) / 1000,
      metabolicRate: this.getMetabolicRate(),
      recentCosts: this._recentCosts.slice(-5).map(c => Math.round(c * 1000) / 1000),
      // v5.0.0: discrete energy pool
      energy: this.getEnergyLevel(),
    };
  }

  /**
   * FIX v5.0.0: Reset the period energy counter.
   * Called by FitnessEvaluator after each evaluation so energyEfficiency
   * reflects only the current eval period, not the entire lifetime.
   */
  resetPeriod() {
    this._periodEnergySpent = 0;
  }

  // ════════════════════════════════════════════════════════════
  // PERSISTENCE (FIX v5.1.0 — H-1)
  // Previously Metabolism had no persistence. Energy, cost history,
  // and call counts were lost on every restart — the organism had
  // no metabolic memory across sessions.
  // ════════════════════════════════════════════════════════════

  _persistData() {
    return {
      energy: this._energy,
      totalEnergySpent: this._totalEnergySpent,
      totalEnergyRecovered: this._totalEnergyRecovered,
      periodEnergySpent: this._periodEnergySpent,
      callCount: this._callCount,
      recentCosts: this._recentCosts,
      lastEnergyState: this._lastEnergyState,
    };
  }

  _saveSync() {
    if (!this.storage) return;
    try {
      this.storage.writeJSON('metabolism.json', this._persistData());
    } catch (err) { _log.debug('[METABOLISM] Sync save error:', err.message); }
  }

  _load() {
    if (!this.storage) return;
    try {
      const data = this.storage.readJSON('metabolism.json', null);
      if (!data) return;
      if (typeof data.energy === 'number')               this._energy = Math.max(0, Math.min(this._maxEnergy, data.energy));
      if (typeof data.totalEnergySpent === 'number')      this._totalEnergySpent = data.totalEnergySpent;
      if (typeof data.totalEnergyRecovered === 'number')  this._totalEnergyRecovered = data.totalEnergyRecovered;
      if (typeof data.periodEnergySpent === 'number')     this._periodEnergySpent = data.periodEnergySpent;
      if (typeof data.callCount === 'number')             this._callCount = data.callCount;
      if (Array.isArray(data.recentCosts))                this._recentCosts = data.recentCosts.slice(-this._maxRecentCosts);
      if (data.lastEnergyState)                           this._lastEnergyState = data.lastEnergyState;
      _log.info(`[METABOLISM] Loaded — energy ${Math.round(this._energy)}/${this._maxEnergy}, ${this._callCount} historical calls`);
    } catch (err) { _log.warn('[METABOLISM] Load error:', err.message); }
  }
}

module.exports = { Metabolism };
