// @ts-checked-v5.7
// ============================================================
// GENESIS — PeerHealth.js (v3.7.0 — extracted from PeerNetwork)
//
// Per-peer health tracking: latency, failures, last-seen,
// exponential backoff, health scoring for peer ranking.
// ============================================================

const { NullBus } = require('../core/EventBus');

class PeerHealth {
  /** @param {{ bus?: object }} [opts] */
  constructor({ bus } = {}) {
    this.bus = bus || NullBus;
    this.latencies = [];    // Last 10 RTTs in ms
    this.failures = 0;
    this.successes = 0;
    this.lastSeen = Date.now();
    this.lastFailure = null;
    this.backoffMs = 1000;
  }

  recordSuccess(latencyMs) {
    this.latencies.push(latencyMs);
    if (this.latencies.length > 10) this.latencies.shift();
    this.successes++;
    this.failures = 0;
    this.backoffMs = 1000;
    this.lastSeen = Date.now();
  }

  recordFailure() {
    this.failures++;
    this.lastFailure = Date.now();
    this.backoffMs = Math.min(this.backoffMs * 2, 60000);
  }

  get avgLatency() {
    if (this.latencies.length === 0) return Infinity;
    return this.latencies.reduce((a, b) => a + b, 0) / this.latencies.length;
  }

  get isHealthy() {
    return this.failures < 3 && (Date.now() - this.lastSeen) < 120000;
  }

  get score() {
    const latencyScore = this.avgLatency === Infinity ? 1000 : this.avgLatency;
    const failurePenalty = this.failures * 200;
    const agePenalty = Math.min((Date.now() - this.lastSeen) / 1000, 300);
    return latencyScore + failurePenalty + agePenalty;
  }
}

module.exports = { PeerHealth };
