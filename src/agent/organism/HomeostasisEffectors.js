// ============================================================
// GENESIS — HomeostasisEffectors.js (v4.12.5 — Organismus-Fix)
//
// PROBLEM: Homeostasis emits corrective events (prune-caches,
// prune-knowledge, reduce-context, reduce-load) but NO module
// listens to them. 4 of 5 correction pathways fire into void.
//
// SOLUTION: A central effector module that listens to every
// homeostasis correction event and dispatches real actions to
// the relevant subsystems via late-bound references.
//
// This is the motor cortex of homeostasis — the part that
// turns decisions into muscle contractions.
//
// Architecture:
//   Homeostasis → emit correction events
//   HomeostasisEffectors → listen + dispatch to:
//     prune-caches     → LLMCache.clear(), ConversationMemory trim
//     prune-knowledge  → KnowledgeGraph.pruneStale()
//     reduce-context   → DynamicContextBudget pressure mode
//     reduce-load      → CircuitBreaker state acknowledgment
//
// All targets are optional — missing subsystems are skipped.
// ============================================================

const { NullBus } = require('../core/EventBus');
const { createLogger } = require('../core/Logger');
const { ORGANISM } = require('../core/Constants');
const _log = createLogger('HomeostasisEffectors');

class HomeostasisEffectors {
  constructor({ bus, storage, config }) {
    this.bus = bus || NullBus;
    /** @type {Function[]} */ this._unsubs = [];
    this.storage = storage || null;

    // Late-bound targets
    this.llmCache = null;
    this.knowledgeGraph = null;
    this.dynamicContextBudget = null;
    this.vectorMemory = null;
    this.conversationMemory = null;
    this.homeostasis = null;

    // ── Stats ────────────────────────────────────────────
    this._stats = {
      cachePrunes: 0,
      knowledgePrunes: 0,
      contextReductions: 0,
      loadReductions: 0,
      totalNodesRemoved: 0,
      totalCacheCleared: 0,
    };
    /** @type {number} */ this._lastPruneLog = 0; // v5.9.1: Throttle prune logs

    // ── Configuration ────────────────────────────────────
    const cfg = config || {};
    this._kgPruneAgeDays = cfg.kgPruneAgeDays || 5;
    this._kgEmergencyAgeDays = cfg.kgEmergencyAgeDays || 2;
    this._contextPressureReduction = cfg.contextPressureReduction || 0.7; // 70% of normal budget
    this._contextPressureDurationMs = cfg.contextPressureDurationMs || ORGANISM.EFFECTOR_CONTEXT_PRESSURE_MS; // 2 min pressure window
    this._contextPressureActive = false;
    this._contextPressureTimeout = null;

    this._wireEvents();
  }

  // ════════════════════════════════════════════════════════════
  // LIFECYCLE
  // ════════════════════════════════════════════════════════════

  start() {
    _log.info('[EFFECTORS] Active — homeostasis corrections wired');
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
    if (this._contextPressureTimeout) {
      clearTimeout(this._contextPressureTimeout);
      this._contextPressureTimeout = null;
    }
  }

  async asyncLoad() {}

  // ════════════════════════════════════════════════════════════
  // EVENT HANDLERS — The actual corrections
  // ════════════════════════════════════════════════════════════

  /**
   * PRUNE-CACHES: Memory pressure is high.
   * Clear LLM cache, trim conversation history, evict vector memory.
   */
  _handlePruneCaches(data) {
    this._stats.cachePrunes++;
    const pressure = data?.memoryPressure || 80;
    const now = Date.now();
    const shouldLog = now - this._lastPruneLog > 120000; // v5.9.1: max 1x per 2min
    if (shouldLog) {
      _log.info(`[EFFECTORS] Pruning caches — memory pressure: ${pressure}%`);
      this._lastPruneLog = now;
    }

    let cleared = 0;

    // 1. LLM response cache — cheapest to rebuild
    if (this.llmCache) {
      try {
        const sizeBefore = this.llmCache._cache?.size || 0;
        this.llmCache.clear();
        cleared += sizeBefore;
        _log.debug(`[EFFECTORS] LLM cache cleared: ${sizeBefore} entries`);
      } catch (err) { _log.debug('[EFFECTORS] LLM cache clear failed:', err.message); }
    }

    // 2. Vector memory — trim oldest embeddings if available
    if (this.vectorMemory && pressure > 85) {
      try {
        const trimmed = this.vectorMemory.trimOldest?.(50) || 0;
        cleared += trimmed;
        _log.debug(`[EFFECTORS] Vector memory trimmed: ${trimmed} entries`);
      } catch (err) { _log.debug('[EFFECTORS] Vector memory trim failed:', err.message); }
    }

    // 3. Force garbage collection hint (Node.js)
    if (global.gc && pressure > 90) {
      try {
        global.gc();
        _log.info('[EFFECTORS] Forced garbage collection');
      } catch { /* gc not exposed */ }
    }

    this._stats.totalCacheCleared += cleared;

    this.bus.emit('homeostasis:correction-applied', {
      type: 'prune-caches',
      cleared,
      memoryPressure: pressure,
    }, { source: 'HomeostasisEffectors' });
  }

  /**
   * PRUNE-KNOWLEDGE: Knowledge graph is too large.
   * Remove stale nodes that haven't been accessed recently.
   */
  _handlePruneKnowledge(data) {
    this._stats.knowledgePrunes++;
    const nodeCount = data?.nodeCount || 0;
    _log.info(`[EFFECTORS] Pruning knowledge graph — ${nodeCount} nodes`);

    if (!this.knowledgeGraph) {
      _log.debug('[EFFECTORS] No KnowledgeGraph available for pruning');
      return;
    }

    try {
      // Standard prune: nodes older than 5 days without access
      const ageDays = nodeCount > ORGANISM.EFFECTOR_LARGE_PROJECT_NODES
        ? this._kgEmergencyAgeDays   // Emergency: aggressive prune
        : this._kgPruneAgeDays;      // Normal: conservative prune

      const removed = this.knowledgeGraph.pruneStale(ageDays);
      this._stats.totalNodesRemoved += (removed || 0);

      _log.info(`[EFFECTORS] KG pruned: ${removed || 0} stale nodes (>${ageDays}d), remaining: ${nodeCount - (removed || 0)}`);

      // Update the vital sign after pruning
      if (this.homeostasis?.vitals?.kgNodeCount) {
        this.homeostasis.vitals.kgNodeCount.value = Math.max(0,
          this.homeostasis.vitals.kgNodeCount.value - (removed || 0));
      }
    } catch (err) {
      _log.warn('[EFFECTORS] KG prune failed:', err.message);
    }

    this.bus.emit('homeostasis:correction-applied', {
      type: 'prune-knowledge',
      nodeCount,
    }, { source: 'HomeostasisEffectors' });
  }

  /**
   * REDUCE-CONTEXT: LLM response latency is too high.
   * Temporarily reduce context budget to speed up inference.
   */
  _handleReduceContext(data) {
    this._stats.contextReductions++;
    const latency = data?.latency || 0;
    _log.info(`[EFFECTORS] Reducing context budget — latency: ${latency}ms`);

    if (!this.dynamicContextBudget) {
      _log.debug('[EFFECTORS] No DynamicContextBudget available');
      return;
    }

    try {
      // Apply temporary pressure multiplier to the budget
      if (!this._contextPressureActive) {
        this._contextPressureActive = true;

        // Store original budget
        const original = this.dynamicContextBudget._totalBudget;
        const reduced = Math.round(original * this._contextPressureReduction);
        this.dynamicContextBudget._totalBudget = reduced;

        _log.info(`[EFFECTORS] Context budget: ${original} → ${reduced} tokens (${this._contextPressureReduction * 100}%)`);

        // Auto-restore after pressure window
        if (this._contextPressureTimeout) clearTimeout(this._contextPressureTimeout);
        this._contextPressureTimeout = setTimeout(() => {
          this.dynamicContextBudget._totalBudget = original;
          this._contextPressureActive = false;
          _log.info(`[EFFECTORS] Context budget restored: ${reduced} → ${original} tokens`);

          this.bus.emit('homeostasis:correction-lifted', {
            type: 'reduce-context',
          }, { source: 'HomeostasisEffectors' });
        }, this._contextPressureDurationMs);
      }
    } catch (err) {
      _log.warn('[EFFECTORS] Context reduction failed:', err.message);
    }

    this.bus.emit('homeostasis:correction-applied', {
      type: 'reduce-context',
      latency,
    }, { source: 'HomeostasisEffectors' });
  }

  /**
   * REDUCE-LOAD: Circuit breaker is open or half-open.
   * Signal AgentLoop to use simpler strategies.
   */
  _handleReduceLoad(data) {
    this._stats.loadReductions++;
    _log.info(`[EFFECTORS] Reducing load — circuit state: ${data?.circuit}`);

    // Emit a more specific event that AgentLoop can consume
    this.bus.emit('homeostasis:simplified-mode', {
      reason: 'circuit-breaker',
      recommendations: [
        'Avoid multi-step plans',
        'Skip tool calls if possible',
        'Use cached results when available',
        'Defer autonomous tasks',
      ],
    }, { source: 'HomeostasisEffectors' });

    this.bus.emit('homeostasis:correction-applied', {
      type: 'reduce-load',
      circuit: data?.circuit,
    }, { source: 'HomeostasisEffectors' });
  }

  // ════════════════════════════════════════════════════════════
  // EVENT WIRING
  // ════════════════════════════════════════════════════════════

  _wireEvents() {
    this._sub('homeostasis:prune-caches', (data) => {
      this._handlePruneCaches(data);
    }, { source: 'HomeostasisEffectors', priority: -5 });

    this._sub('homeostasis:prune-knowledge', (data) => {
      this._handlePruneKnowledge(data);
    }, { source: 'HomeostasisEffectors', priority: -5 });

    this._sub('homeostasis:reduce-context', (data) => {
      this._handleReduceContext(data);
    }, { source: 'HomeostasisEffectors', priority: -5 });

    this._sub('homeostasis:reduce-load', (data) => {
      this._handleReduceLoad(data);
    }, { source: 'HomeostasisEffectors', priority: -5 });

    // Listen for correction results (for reporting)
    this._sub('homeostasis:correction-applied', (data) => {
      _log.debug(`[EFFECTORS] Correction applied: ${data.type}`);
    }, { source: 'HomeostasisEffectors', priority: -10 });
  }

  // ════════════════════════════════════════════════════════════
  // PUBLIC API
  // ════════════════════════════════════════════════════════════

  getReport() {
    return {
      stats: { ...this._stats },
      contextPressureActive: this._contextPressureActive,
      wired: {
        llmCache: !!this.llmCache,
        knowledgeGraph: !!this.knowledgeGraph,
        dynamicContextBudget: !!this.dynamicContextBudget,
        vectorMemory: !!this.vectorMemory,
        conversationMemory: !!this.conversationMemory,
      },
    };
  }
}

module.exports = { HomeostasisEffectors };
