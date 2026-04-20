// ============================================================
// GENESIS — HealthMonitor.js (P4: Modulare Selbst-Diagnose)
//
// Continuous health monitoring beyond the periodic 5-min check.
// Measures service latency, detects memory leaks, and auto-
// activates CircuitBreaker on degradation.
//
// Architecture:
//   HealthMonitor
//     ├── LatencyTracker    — rolling window per service
//     ├── MemoryWatcher     — heap snapshots, trend detection
//     ├── DegradationDetector — threshold-based auto-circuit
//     └── DiagnosticReport  — full health snapshot
//
// USAGE:
//   const hm = new HealthMonitor({ circuitBreaker, eventStore, bus });
//   hm.start(10000); // check every 10s
//   hm.recordLatency('intentRouter', 45);
//   hm.getReport(); // → { status, latency, memory, degradation }
// ============================================================

const { NullBus } = require('../core/EventBus');
const { createLogger } = require('../core/Logger');
const { applySubscriptionHelper } = require('../core/subscription-helper');
const _log = createLogger('HealthMonitor');

class HealthMonitor {
  constructor({ bus, circuitBreaker, eventStore, workerPool, container, intervals }) {
    this.bus = bus || NullBus;
    /** @type {Function[]} */ this._unsubs = [];
    this.cb = circuitBreaker;
    this.eventStore = eventStore || null;
    this.workerPool = workerPool || null;
    this.container = container || null;
    this._intervals = intervals || null;

    // ── Latency Tracking ──────────────────────────────────
    this._latency = new Map(); // DA-1: bounded by service count (~40), cap 100 // service → { samples: number[], p50, p95, p99, trend }
    this._latencyWindowSize = 100;  // Keep last N samples per service
    this._latencyThresholds = {
      warning: 2000,  // ms — emit warning
      critical: 5000, // ms — trigger degradation
    };

    // ── Memory Tracking ───────────────────────────────────
    this._memorySnapshots = []; // { timestamp, heapUsed, heapTotal, rss, external }
    this._memoryMaxSnapshots = 60;  // ~10 min at 10s intervals
    this._memoryLeakThresholdMB = 50; // Alert if heap grows by 50MB continuously

    // ── Degradation State ─────────────────────────────────
    this._degradationState = new Map(); // service → { level, since, reason }
    this._degradationLevels = { healthy: 0, degraded: 1, critical: 2 };

    // ── Interval Handle ───────────────────────────────────
    this._interval = null;
    this._started = false;
  }

  // ════════════════════════════════════════════════════════════
  // LIFECYCLE
  // ════════════════════════════════════════════════════════════

  /**
   * Start continuous monitoring.
   * @param {number} intervalMs - Check interval (default 10s)
   */
  start(intervalMs = 10000) {
    if (this._started) return;
    this._started = true;

    // Wire into EventBus for automatic latency capture
    this._wireEvents();

    if (this._intervals) {
      this._intervals.register('healthmonitor-tick', () => this._tick(), intervalMs);
    } else {
      this._interval = setInterval(() => this._tick(), intervalMs);
      // Don't prevent process exit
      if (this._interval.unref) this._interval.unref();
    }

    this.bus.emit('health:started', { intervalMs }, { source: 'HealthMonitor' });
  }


  /** @private Subscribe to bus event with auto-cleanup in stop() — see subscription-helper.js */

  stop() {
    this._unsubAll();
    if (this._intervals) {
      this._intervals.clear('healthmonitor-tick');
    } else if (this._interval) {
      clearInterval(this._interval);
      this._interval = null;
    }
    this._started = false;
  }

  // ════════════════════════════════════════════════════════════
  // PUBLIC API
  // ════════════════════════════════════════════════════════════

  /**
   * Record a latency measurement for a service.
   * Can be called externally or captured via EventBus.
   */
  recordLatency(service, latencyMs) {
    if (!this._latency.has(service)) {
      this._latency.set(service, { samples: [], p50: 0, p95: 0, p99: 0, avg: 0, trend: 'stable' });
      if (this._latency.size > 100) { const k = this._latency.keys().next().value; this._latency.delete(k); }
    }

    const entry = this._latency.get(service);
    entry.samples.push(latencyMs);

    // Trim to window
    if (entry.samples.length > this._latencyWindowSize) {
      entry.samples = entry.samples.slice(-this._latencyWindowSize);
    }

    // Recompute percentiles
    this._recomputePercentiles(entry);

    // Check thresholds
    if (latencyMs >= this._latencyThresholds.critical) {
      this._escalateDegradation(service, 'critical', `Latency ${latencyMs}ms exceeds critical threshold`);
    } else if (latencyMs >= this._latencyThresholds.warning) {
      this._escalateDegradation(service, 'degraded', `Latency ${latencyMs}ms exceeds warning threshold`);
    }
  }

  /**
   * Record an arbitrary metric for a service.
   */
  recordMetric(service, metric, value) {
    this.bus.emit('health:metric', { service, metric, value }, { source: 'HealthMonitor' });
  }

  /**
   * Get full diagnostic report.
   */
  getReport() {
    const memoryMB = this._getMemoryMB();

    return {
      status: this._overallStatus(),
      timestamp: new Date().toISOString(),

      latency: this._getLatencyReport(),

      memory: {
        current: memoryMB,
        trend: this._getMemoryTrend(),
        snapshots: this._memorySnapshots.length,
        leakSuspected: this._isMemoryLeakSuspected(),
      },

      degradation: Object.fromEntries(
        [...this._degradationState.entries()].map(([svc, state]) => [svc, { ...state }])
      ),

      workerPool: this.workerPool ? this.workerPool.getStatus() : null,

      circuitBreaker: this.cb ? this.cb.getStatus() : null,

      uptime: process.uptime(),
      pid: process.pid,
    };
  }

  /**
   * Get per-service latency summary.
   */
  getLatencyFor(service) {
    const entry = this._latency.get(service);
    if (!entry) return null;
    return {
      p50: entry.p50,
      p95: entry.p95,
      p99: entry.p99,
      avg: entry.avg,
      samples: entry.samples.length,
      trend: entry.trend,
    };
  }

  /**
   * Force check all health indicators NOW (instead of waiting for interval).
   */
  async checkNow() {
    return this._tick();
  }

  // ════════════════════════════════════════════════════════════
  // INTERNAL — Tick (periodic check)
  // ════════════════════════════════════════════════════════════

  _tick() {
    try {
      // 1. Memory snapshot
      this._captureMemorySnapshot();

      // 2. Check for memory leak
      if (this._isMemoryLeakSuspected()) {
        this.bus.emit('health:memory-leak', {
          heapUsedMB: this._getMemoryMB().heapUsed,
          trend: this._getMemoryTrend(),
        }, { source: 'HealthMonitor' });

        this._escalateDegradation('memory', 'degraded', 'Memory leak suspected');
      }

      // 3. Check WorkerPool health
      if (this.workerPool) {
        const wpStatus = this.workerPool.getStatus();
        if (wpStatus.queued > wpStatus.maxWorkers * 2) {
          this._escalateDegradation('workerPool', 'degraded', `Queue backlog: ${wpStatus.queued} tasks`);
        }
      }

      // 4. Check latency trends — auto-open circuit breaker on sustained degradation
      for (const [service, state] of this._degradationState) {
        if (state.level === 'critical' && this.cb && this.cb.state === 'CLOSED') {
          // Sustained critical degradation → open circuit breaker
          const durationMs = Date.now() - state.since;
          if (durationMs > 30000) { // 30s sustained
            this.cb._transition('OPEN');
            this.bus.emit('health:circuit-forced-open', {
              service, reason: state.reason, durationMs,
            }, { source: 'HealthMonitor' });

            this.eventStore?.append('HEALTH_CIRCUIT_FORCED', {
              service, reason: state.reason, durationMs,
            }, 'HealthMonitor');
          }
        }
      }

      // 5. Decay degradation levels (self-healing)
      this._decayDegradation();

      // 6. Emit health tick
      this.bus.emit('health:tick', {
        status: this._overallStatus(),
        memory: this._getMemoryMB(),
      }, { source: 'HealthMonitor' });

    } catch (err) {
      _log.debug('[HEALTH] Tick error:', err.message);
    }
  }

  // ════════════════════════════════════════════════════════════
  // INTERNAL — Latency
  // ════════════════════════════════════════════════════════════

  _recomputePercentiles(entry) {
    const sorted = [...entry.samples].sort((a, b) => a - b);
    const n = sorted.length;
    if (n === 0) return;

    entry.p50 = sorted[Math.floor(n * 0.5)];
    entry.p95 = sorted[Math.floor(n * 0.95)];
    entry.p99 = sorted[Math.floor(n * 0.99)];
    entry.avg = Math.round(sorted.reduce((s, v) => s + v, 0) / n);

    // Trend: compare first half avg to second half avg
    if (n >= 10) {
      const halfN = Math.floor(n / 2);
      const firstHalf = sorted.slice(0, halfN);
      const secondHalf = sorted.slice(halfN);
      const avgFirst = firstHalf.reduce((s, v) => s + v, 0) / firstHalf.length;
      const avgSecond = secondHalf.reduce((s, v) => s + v, 0) / secondHalf.length;

      if (avgSecond > avgFirst * 1.5) entry.trend = 'worsening';
      else if (avgSecond < avgFirst * 0.7) entry.trend = 'improving';
      else entry.trend = 'stable';
    }
  }

  _getLatencyReport() {
    const report = {};
    for (const [service, entry] of this._latency) {
      report[service] = {
        p50: entry.p50,
        p95: entry.p95,
        p99: entry.p99,
        avg: entry.avg,
        trend: entry.trend,
        samples: entry.samples.length,
      };
    }
    return report;
  }

  // ════════════════════════════════════════════════════════════
  // INTERNAL — Memory
  // ════════════════════════════════════════════════════════════

  _captureMemorySnapshot() {
    const mem = process.memoryUsage();
    this._memorySnapshots.push({
      timestamp: Date.now(),
      heapUsed: mem.heapUsed,
      heapTotal: mem.heapTotal,
      rss: mem.rss,
      external: mem.external || 0,
    });

    if (this._memorySnapshots.length > this._memoryMaxSnapshots) {
      this._memorySnapshots = this._memorySnapshots.slice(-this._memoryMaxSnapshots);
    }
  }

  _getMemoryMB() {
    const mem = process.memoryUsage();
    return {
      heapUsed: Math.round(mem.heapUsed / 1024 / 1024 * 10) / 10,
      heapTotal: Math.round(mem.heapTotal / 1024 / 1024 * 10) / 10,
      rss: Math.round(mem.rss / 1024 / 1024 * 10) / 10,
      external: Math.round((mem.external || 0) / 1024 / 1024 * 10) / 10,
    };
  }

  _getMemoryTrend() {
    if (this._memorySnapshots.length < 5) return 'insufficient-data';

    const recent = this._memorySnapshots.slice(-5);
    const oldest = recent[0].heapUsed;
    const newest = recent[recent.length - 1].heapUsed;
    const diffMB = (newest - oldest) / 1024 / 1024;

    if (diffMB > 20) return 'growing';
    if (diffMB < -10) return 'shrinking';
    return 'stable';
  }

  _isMemoryLeakSuspected() {
    if (this._memorySnapshots.length < 10) return false;

    // Check if heap has been monotonically increasing over last 10 snapshots
    const recent = this._memorySnapshots.slice(-10);
    let increasing = 0;
    for (let i = 1; i < recent.length; i++) {
      if (recent[i].heapUsed > recent[i - 1].heapUsed) increasing++;
    }

    // If >80% of snapshots show increase AND total growth exceeds threshold
    const growthMB = (recent[recent.length - 1].heapUsed - recent[0].heapUsed) / 1024 / 1024;
    return increasing >= 8 && growthMB > this._memoryLeakThresholdMB;
  }

  // ════════════════════════════════════════════════════════════
  // INTERNAL — Degradation
  // ════════════════════════════════════════════════════════════

  _escalateDegradation(service, level, reason) {
    const current = this._degradationState.get(service);
    const numLevel = this._degradationLevels[level] || 0;
    const currentNumLevel = current ? (this._degradationLevels[current.level] || 0) : 0;

    if (numLevel > currentNumLevel) {
      this._degradationState.set(service, {
        level,
        since: Date.now(),
        reason,
      });

      this.bus.emit('health:degradation', { service, level, reason }, { source: 'HealthMonitor' });
      this.eventStore?.append('HEALTH_DEGRADATION', { service, level, reason }, 'HealthMonitor');
    }
  }

  _decayDegradation() {
    const now = Date.now();
    for (const [service, state] of this._degradationState) {
      const age = now - state.since;

      // After 2 minutes without re-escalation, reduce level
      if (age > 120000) {
        if (state.level === 'critical') {
          state.level = 'degraded';
          state.since = now;
        } else if (state.level === 'degraded') {
          this._degradationState.delete(service);
        }
      }
    }
  }

  _overallStatus() {
    let worst = 'healthy';
    for (const [, state] of this._degradationState) {
      if (state.level === 'critical') return 'critical';
      if (state.level === 'degraded') worst = 'degraded';
    }
    return worst;
  }

  // ════════════════════════════════════════════════════════════
  // INTERNAL — EventBus Wiring
  // ════════════════════════════════════════════════════════════

  _wireEvents() {
    // Capture chat latency automatically
    this._sub('chat:completed', (data, meta) => {
      if (meta?.timestamp) {
        // Estimate chat processing time from event emission
        this.recordLatency('chatOrchestrator', Date.now() - meta.timestamp);
      }
    }, { source: 'HealthMonitor' });

    // Capture intent classification latency
    this._sub('intent:classified', (data, meta) => {
      if (meta?.timestamp) {
        this.recordLatency('intentRouter', Date.now() - meta.timestamp);
      }
    }, { source: 'HealthMonitor' });

    // Capture circuit breaker state changes
    this._sub('circuit:state-change', (data) => {
      if (data.to === 'OPEN') {
        this._escalateDegradation(data.name, 'critical', `Circuit breaker opened: ${data.from} → ${data.to}`);
      }
    }, { source: 'HealthMonitor' });

    // Worker pool task timeouts
    this._sub('worker:error', (data) => {
      this.recordMetric('workerPool', 'error', 1);
    }, { source: 'HealthMonitor' });
  }
}

applySubscriptionHelper(HealthMonitor);

module.exports = { HealthMonitor };
