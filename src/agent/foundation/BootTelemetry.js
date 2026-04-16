// @ts-checked-v5.6
// ============================================================
// GENESIS — BootTelemetry.js (v4.12.2)
//
// Opt-in telemetry that records boot timing, error rates,
// model latency, and session stats. Data stays LOCAL —
// written to .genesis/telemetry.json. Never sent anywhere.
//
// Usage:
//   settings.set('telemetry.enabled', true);
//   const t = container.resolve('telemetry');
//   t.recordBoot(durationMs);
//   t.recordModelLatency('chat', durationMs, modelName);
//   t.getReport(); // → { bootHistory, avgLatency, errorRate, ... }
// ============================================================

const { createLogger } = require('../core/Logger');
const _log = createLogger('BootTelemetry');

const MAX_HISTORY = 100;

class BootTelemetry {
  constructor({ storage, bus, enabled = false }) {
    this.storage = storage;
    this.bus = bus;
    this.enabled = enabled;
    this._data = null;
    this._sessionStart = Date.now();
  }

  async asyncLoad() {
    if (!this.enabled || !this.storage) return;
    try {
      this._data = this.storage.readJSON('telemetry.json', null) || this._emptyData();
    } catch (_e) {
      this._data = this._emptyData();
    }
  }

  _emptyData() {
    return {
      boots: [],          // [{ ts, durationMs, services, errors }]
      latency: [],        // [{ ts, op, durationMs, model }]
      errors: [],         // [{ ts, category, message }]
      sessions: [],       // [{ start, end, messages, goals }]
    };
  }

  // ════════════════════════════════════════════════════════
  // RECORDING
  // ════════════════════════════════════════════════════════

  /** @param {number} durationMs @param {number} [serviceCount] @param {number} [errorCount] @param {Array<{name:string,ms:number}>|null} [phaseTimings] */
  recordBoot(durationMs, serviceCount = 0, errorCount = 0, phaseTimings = null) {
    if (!this.enabled || !this._data) return;
    const entry = {
      ts: Date.now(), durationMs, services: serviceCount, errors: errorCount,
    };
    // FIX v4.12.7 (Audit-09): Per-phase timing for boot regression detection
    if (phaseTimings) entry.phases = phaseTimings;
    this._data.boots.push(entry);
    this._trim(this._data.boots);
    this._save();
    // Log phase breakdown for visibility
    if (phaseTimings && phaseTimings.length > 0) {
      const breakdown = phaseTimings.map(p => `${p.name}:${p.ms}ms`).join(', ');
      _log.info(`[BOOT] Phase timings: ${breakdown} (total: ${durationMs}ms)`);
    }
  }

  recordModelLatency(operation, durationMs, modelName) {
    if (!this.enabled || !this._data) return;
    this._data.latency.push({
      ts: Date.now(), op: operation, durationMs, model: modelName,
    });
    this._trim(this._data.latency);
    // Don't save on every latency record — batch via periodic flush
  }

  recordError(category, message) {
    if (!this.enabled || !this._data) return;
    this._data.errors.push({
      ts: Date.now(), category, message: String(message).slice(0, 200),
    });
    this._trim(this._data.errors);
  }

  endSession(messageCount = 0, goalCount = 0) {
    if (!this.enabled || !this._data) return;
    this._data.sessions.push({
      start: this._sessionStart, end: Date.now(),
      messages: messageCount, goals: goalCount,
    });
    this._trim(this._data.sessions);
    this._save();
  }

  // ════════════════════════════════════════════════════════
  // REPORTING
  // ════════════════════════════════════════════════════════

  getReport() {
    if (!this._data) return null;

    const d = this._data;
    const avgBoot = d.boots.length > 0
      ? Math.round(d.boots.reduce((s, b) => s + b.durationMs, 0) / d.boots.length)
      : null;

    const recentLatency = d.latency.slice(-50);
    const avgLatency = recentLatency.length > 0
      ? Math.round(recentLatency.reduce((s, l) => s + l.durationMs, 0) / recentLatency.length)
      : null;

    const last24h = Date.now() - 86400_000;
    const recentErrors = d.errors.filter(e => e.ts > last24h);

    return {
      totalBoots: d.boots.length,
      avgBootMs: avgBoot,
      lastBoot: d.boots[d.boots.length - 1] || null,
      avgModelLatencyMs: avgLatency,
      errorsLast24h: recentErrors.length,
      totalSessions: d.sessions.length,
      enabled: this.enabled,
    };
  }

  // ════════════════════════════════════════════════════════
  // INTERNAL
  // ════════════════════════════════════════════════════════

  _trim(arr) {
    while (arr.length > MAX_HISTORY) arr.shift();
  }

  _save() {
    if (!this.storage) return;
    try {
      this.storage.writeJSON('telemetry.json', this._data);
    } catch (err) {
      _log.debug('[Telemetry] save failed:', err.message);
    }
  }

  flush() {
    if (this.enabled) this._save();
  }
}

module.exports = { BootTelemetry };
