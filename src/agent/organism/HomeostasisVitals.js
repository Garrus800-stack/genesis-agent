// @ts-checked-v5.7 — unbound `this` in prototype-delegation object
// ============================================================
// GENESIS — organism/HomeostasisVitals.js (v5.6.0)
// Extracted via prototype delegation.
// ============================================================

const { createLogger } = require('../core/Logger');
const _log = createLogger('Homeostasis');

// Use V8 heap limit (actual max ~1.4-4GB) instead of dynamic heapTotal.
// heapUsed/heapTotal naturally sits at 85-95% because V8 sizes heapTotal close
// to heapUsed. This caused constant false alarms on machines with plenty of RAM.
let _heapLimit = 0;
try {
  const v8 = require('v8');
  _heapLimit = v8.getHeapStatistics().heap_size_limit;
} catch { /* v8 module not available — fallback below */ }



const vitals = {

  /**
   * v4.12.5: Allostatic set-point adaptation.
   * When a vital stays in WARNING for > _allostasisWindowMs without
   * going critical, shift healthy.max toward the current value.
   * This is how Genesis acclimatizes to environments that run
   * hotter than the initial defaults (e.g., memory-constrained
   * systems, slower models).
   *
   * The shift is gradual (10% per tick) and bounded (max 30%
   * above original). If the vital returns to healthy, the
   * adaptation timer resets but the shifted threshold STAYS
   * (no hysteresis — once adapted, stay adapted until restart).
   */
  _allostasisTick() {
    const now = Date.now();

    for (const [name, vital] of Object.entries(this.vitals)) {
      // Skip circuitState — binary, no continuous adaptation
      if (name === 'circuitState') continue;

      const allo = this._allostasisState[name];
      if (!allo) continue;

      const status = this._classifyVital(vital);

      if (status === 'warning') {
        // Start warning timer if not already running
        if (!allo.warningStart) {
          allo.warningStart = now;
        }

        // Check if sustained long enough
        if (now - allo.warningStart >= this._allostasisWindowMs) {
          const maxAllowed = allo.originalMax * (1 + this._allostasisMaxShift);

          if (vital.healthy.max < maxAllowed) {
            // Shift healthy.max 10% toward current value
            const shift = (vital.value - vital.healthy.max) * this._allostasisShiftRate;
            const newMax = Math.min(maxAllowed, vital.healthy.max + Math.abs(shift));

            _log.info(`[ALLOSTASIS] ${name}: healthy.max ${vital.healthy.max.toFixed(1)} → ${newMax.toFixed(1)} (adapted to sustained ${vital.value.toFixed(1)})`);

            vital.healthy.max = newMax;
            vital.warning.min = newMax; // Warning starts where healthy ends
            allo.shifts++;
            allo.warningStart = now; // Reset timer for next potential shift

            this.bus.fire('homeostasis:allostasis', {
              vital: name,
              oldMax: vital.healthy.max - Math.abs(shift),
              newMax,
              originalMax: allo.originalMax,
              shifts: allo.shifts,
            }, { source: 'Homeostasis' });
          }
        }
      } else {
        // Not in warning — reset timer (but keep shifted threshold)
        allo.warningStart = null;
      }
    }
  },

  _updateVitals() {
    // Error rate from sliding window
    this.vitals.errorRate.value = this._calculateErrorRate();

    // Memory pressure — measured against V8 heap limit, not dynamic heapTotal
    const mem = process.memoryUsage();
    const limit = _heapLimit || mem.heapTotal; // fallback to heapTotal if v8 unavailable
    this.vitals.memoryPressure.value = Math.round((mem.heapUsed / limit) * 100);

    // KG node count (set externally via event)
    // Circuit state (set externally via event)
    // Response latency (set externally via event)
  },

  _classifyVital(vital) {
    const v = vital.value;
    if (v >= vital.healthy.min && v <= vital.healthy.max) return 'healthy';
    if (v >= vital.warning.min && v <= vital.warning.max) return 'warning';
    return 'critical';
  },

  _calculateErrorRate() {
    const now = Date.now();
    this._errorWindow = this._errorWindow.filter(t => now - t < this._errorWindowMs);
    return this._errorWindow.length; // errors in last minute
  },

  // ── Corrective Actions ────────────────────────────────────

  _applyCorrections() {
    for (const [name, vital] of Object.entries(this.vitals)) {
      const status = this._classifyVital(vital);
      if (status === 'healthy') continue;

      const action = vital.correction;
      this._logCorrection(name, status, action);

      switch (action) {
        case 'throttle-autonomy':
          this.bus.fire('homeostasis:throttle', { reason: name, level: status }, { source: 'Homeostasis' });
          break;
        case 'prune-caches':
          this.bus.fire('homeostasis:prune-caches', { memoryPressure: vital.value }, { source: 'Homeostasis' });
          break;
        case 'prune-knowledge':
          this.bus.fire('homeostasis:prune-knowledge', { nodeCount: vital.value }, { source: 'Homeostasis' });
          break;
        case 'reduce-load':
          this.bus.fire('homeostasis:reduce-load', { circuit: vital.value }, { source: 'Homeostasis' });
          break;
        case 'reduce-context':
          this.bus.fire('homeostasis:reduce-context', { latency: vital.value }, { source: 'Homeostasis' });
          break;
      }
    }
  },

  _logCorrection(vital, status, action) {
    this._corrections.push({
      ts: Date.now(),
      vital, status, action,
      organismState: this.state,
    });
    if (this._corrections.length > this._maxCorrections) {
      this._corrections = this._corrections.slice(-this._maxCorrections);
    }
  },

  // ── Event Wiring ──────────────────────────────────────────

  _wireEvents() {
    // v7.6.4 L1 fix: this._sub is grafted onto the host prototype by
    // applySubscriptionHelper(Homeostasis, ...) before Object.assign merges
    // this mixin in. At runtime `this` is a Homeostasis instance so _sub
    // resolves via the prototype chain. Each subscription is tracked on
    // this._unsubs and torn down by Homeostasis.stop().

    // Track errors for error rate calculation
    this._sub('chat:error', () => {
      this._errorWindow.push(Date.now());
    }, { source: 'Homeostasis', priority: -10 });

    this._sub('circuit:state-change', (data) => {
      const stateMap = { CLOSED: 0, HALF_OPEN: 1, OPEN: 2 };
      this.vitals.circuitState.value = stateMap[data.to] ?? 0;
    }, { source: 'Homeostasis', priority: -10 });

    // Track KG size
    this._sub('knowledge:node-added', () => {
      // v7.9.22 Item 5: mirror the real graph size; fall back to the increment only
      // when no graph is injected.
      this.vitals.kgNodeCount.value = (this.kg && this.kg.graph && this.kg.graph.nodes)
        ? this.kg.graph.nodes.size
        : this.vitals.kgNodeCount.value + 1;
    }, { source: 'Homeostasis', priority: -10 });

    // v7.9.22 Item 5: KnowledgeGraph fires nodes-pruned with `remaining`; mirror the
    // real size so the vital decrements on a prune instead of running away.
    this._sub('knowledge:nodes-pruned', () => {
      if (this.kg && this.kg.graph && this.kg.graph.nodes) {
        this.vitals.kgNodeCount.value = this.kg.graph.nodes.size;
      }
    }, { source: 'Homeostasis', priority: -10 });

    // Response to prune requests from self
    this._sub('homeostasis:prune-knowledge', (data) => {
      // IdleMind or KnowledgeGraph can listen and act
    });

    // Throttle requests pause IdleMind
    this._sub('homeostasis:throttle', () => {
      this.bus.fire('homeostasis:pause-autonomy', {}, { source: 'Homeostasis' });
    });
  },

};

module.exports = { vitals };
