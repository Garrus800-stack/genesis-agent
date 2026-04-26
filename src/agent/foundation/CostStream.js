// ============================================================
// GENESIS — CostStream.js (v7.4.5 "Durchhalten" — Baustein B)
//
// Single source of truth for LLM cost tracking.
//
// Architecture:
//   - Listens to llm:call-complete on the bus (already emitted by
//     LLMPort with promptTokens, responseTokens, taskType, latency)
//   - Persists to .genesis/cost/YYYY-MM-DD.jsonl (one JSON object
//     per line — append-only, crash-safe, daily-rotated)
//   - Retains 30 days, prunes older shards on boot + weekly
//   - queryCost({goalId?, since?, until?, taskType?}) for aggregates
//   - Emits cost:recorded after each persist (for downstream
//     consumers like dashboards or budget guards)
//
// Why a separate service rather than extending EventStore:
//   - Cost data needs different retention (30d vs forever)
//   - Cost queries have different access patterns (range scans
//     by goalId / time, not by event-type)
//   - Keeping concerns separated means EventStore's append-only
//     hashing chain is not polluted by ephemeral cost rows
//
// Persistence format (one line per LLM call):
//   {"ts":"2026-04-25T19:11:21Z","taskType":"chat","model":"qwen3-vl",
//    "backend":"ollama","promptTokens":150,"responseTokens":42,
//    "latencyMs":1240,"cached":false,"goalId":"g_abc","correlationId":"..."}
// ============================================================

'use strict';

const fs = require('fs');
const path = require('path');
const { Logger } = require('../core/Logger.js');
const _log = new Logger('CostStream');

const RETENTION_DAYS = 30;
const PRUNE_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000;  // weekly

class CostStream {
  /**
   * @param {{ bus: any, storage: any, genesisDir: string,
   *           intervals?: any, correlationContext?: any }} ctx
   */
  constructor({ bus, storage, genesisDir, intervals = null, correlationContext = null }) {
    this.bus = bus;
    this.storage = storage;
    this.genesisDir = genesisDir;
    this._intervals = intervals;
    this._correlationContext = correlationContext;
    this._costDir = path.join(genesisDir, 'cost');
    this._currentShardDate = null;
    this._writeQueue = [];          // pending writes (in-memory buffer)
    this._flushScheduled = false;
    this._unsubBus = null;
    this._pruneIntervalId = null;
    this._stopped = false;

    // In-memory tally per goalId for fast queryCost (last 24h)
    // Goals beyond 24h fall back to disk read.
    this._goalTally = new Map();    // goalId → {tokensIn, tokensOut, calls, latencyMs}
  }

  async asyncLoad() {
    try {
      fs.mkdirSync(this._costDir, { recursive: true });
    } catch (err) {
      _log.warn('[COST] could not create cost dir:', err.message);
    }

    // Subscribe AFTER directory exists
    this._unsubBus = this.bus.on(
      'llm:call-complete',
      (data) => this._onCallComplete(data),
      { source: 'CostStream' }
    );

    // Initial prune of old shards
    this._pruneOldShards();

    // Schedule periodic prune via IntervalManager (or fallback to setInterval)
    if (this._intervals && this._intervals.set) {
      this._pruneIntervalId = this._intervals.set(
        'cost-prune',
        () => this._pruneOldShards(),
        PRUNE_INTERVAL_MS
      );
    }

    _log.info('[COST] active — retention 30d, dir:', this._costDir);
  }

  // ── Event ingestion ──────────────────────────────────

  _onCallComplete(data) {
    if (this._stopped) return;

    const now = new Date();
    const goalId = data.goalId
      || (this._correlationContext && this._correlationContext.get?.('goalId'))
      || null;

    const row = {
      ts: now.toISOString(),
      taskType: data.taskType || 'unknown',
      model: data.model || 'unknown',
      backend: data.backend || 'unknown',
      promptTokens: Number(data.promptTokens || 0),
      responseTokens: Number(data.responseTokens || 0),
      latencyMs: Number(data.latencyMs || 0),
      cached: Boolean(data.cached),
      goalId,
      correlationId: data.correlationId || null,
    };

    this._writeQueue.push(row);
    this._scheduleFlush();

    // Update in-memory tally for fast queryCost
    if (goalId) {
      const t = this._goalTally.get(goalId) || {
        tokensIn: 0, tokensOut: 0, calls: 0, latencyMs: 0, cachedCalls: 0,
      };
      t.tokensIn += row.promptTokens;
      t.tokensOut += row.responseTokens;
      t.latencyMs += row.latencyMs;
      t.calls += 1;
      if (row.cached) t.cachedCalls += 1;
      this._goalTally.set(goalId, t);
    }

    // Forward as cost:recorded (downstream may listen)
    try {
      this.bus.fire('cost:recorded', row, { source: 'CostStream' });
    } catch (_e) { /* best-effort */ }
  }

  // ── Persistence (batched) ─────────────────────────────

  _scheduleFlush() {
    if (this._flushScheduled) return;
    this._flushScheduled = true;
    setImmediate(() => {
      this._flushScheduled = false;
      this._flush();
    });
  }

  _flush() {
    if (this._writeQueue.length === 0) return;
    const rows = this._writeQueue;
    this._writeQueue = [];

    // Group by date so a midnight-spanning batch goes to two shards
    const byDate = new Map();
    for (const row of rows) {
      const d = row.ts.slice(0, 10);  // YYYY-MM-DD
      if (!byDate.has(d)) byDate.set(d, []);
      byDate.get(d).push(row);
    }

    for (const [date, dateRows] of byDate) {
      const shardPath = path.join(this._costDir, `${date}.jsonl`);
      const text = dateRows.map(r => JSON.stringify(r)).join('\n') + '\n';
      try {
        fs.appendFileSync(shardPath, text, 'utf8');
      } catch (err) {
        _log.warn('[COST] write failed:', err.message);
        // re-queue for next flush attempt
        this._writeQueue.unshift(...dateRows);
      }
    }
  }

  // ── Synchronous shutdown flush ────────────────────────

  shutdownPersist() {
    this._flush();
  }

  // ── Query API ─────────────────────────────────────────

  /**
   * Aggregate cost for a goal (or any filter).
   * Reads from in-memory tally first; falls back to disk for older.
   * @param {{goalId?: string, since?: string|Date, until?: string|Date,
   *          taskType?: string}} filter
   * @returns {{tokensIn: number, tokensOut: number, calls: number,
   *            latencyMs: number, cachedCalls: number}}
   */
  queryCost(filter = {}) {
    // Fast path: only goalId, fresh enough → in-memory tally
    if (filter.goalId && !filter.since && !filter.until && !filter.taskType) {
      const t = this._goalTally.get(filter.goalId);
      if (t) return { ...t };
    }

    const totals = {
      tokensIn: 0, tokensOut: 0, calls: 0, latencyMs: 0, cachedCalls: 0,
    };

    const sinceMs = filter.since ? new Date(filter.since).getTime() : 0;
    const untilMs = filter.until ? new Date(filter.until).getTime() : Date.now() + 1;

    for (const row of this._iterateAllRows()) {
      const tsMs = new Date(row.ts).getTime();
      if (tsMs < sinceMs || tsMs > untilMs) continue;
      if (filter.goalId && row.goalId !== filter.goalId) continue;
      if (filter.taskType && row.taskType !== filter.taskType) continue;
      totals.tokensIn += Number(row.promptTokens || 0);
      totals.tokensOut += Number(row.responseTokens || 0);
      totals.latencyMs += Number(row.latencyMs || 0);
      totals.calls += 1;
      if (row.cached) totals.cachedCalls += 1;
    }
    return totals;
  }

  /** Yield all rows from all shards (oldest → newest). */
  *_iterateAllRows() {
    let files;
    try {
      files = fs.readdirSync(this._costDir).filter(f => f.endsWith('.jsonl')).sort();
    } catch (_e) { return; }

    for (const file of files) {
      const fullPath = path.join(this._costDir, file);
      let content;
      try { content = fs.readFileSync(fullPath, 'utf8'); }
      catch (_e) { continue; }

      for (const line of content.split('\n')) {
        if (!line.trim()) continue;
        try { yield JSON.parse(line); }
        catch (_e) { /* skip malformed line */ }
      }
    }
    // Also yield in-flight rows (not yet flushed)
    for (const row of this._writeQueue) yield row;
  }

  // ── Retention ─────────────────────────────────────────

  _pruneOldShards() {
    const cutoff = Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000;
    let files;
    try { files = fs.readdirSync(this._costDir).filter(f => f.endsWith('.jsonl')); }
    catch (_e) { return; }

    let pruned = 0;
    for (const file of files) {
      const m = file.match(/^(\d{4}-\d{2}-\d{2})\.jsonl$/);
      if (!m) continue;
      const fileMs = new Date(m[1] + 'T00:00:00Z').getTime();
      if (fileMs < cutoff) {
        try {
          fs.unlinkSync(path.join(this._costDir, file));
          pruned += 1;
        } catch (_e) { /* swallow */ }
      }
    }

    // Prune in-memory tallies for goals no longer relevant.
    // Heuristic: drop goals not touched in last 24h.
    const tallyCutoff = Date.now() - 24 * 60 * 60 * 1000;
    // We don't track touch-time per goal in the tally; rebuild lazily
    // by clearing if it grows beyond 1000 entries (simple guard).
    if (this._goalTally.size > 1000) {
      this._goalTally.clear();
    }

    if (pruned > 0) _log.info(`[COST] pruned ${pruned} old shard(s)`);
  }

  // ── Stats ──────────────────────────────────────────────

  getStats() {
    return {
      pendingWrites: this._writeQueue.length,
      goalsTracked: this._goalTally.size,
      retentionDays: RETENTION_DAYS,
    };
  }

  stop() {
    if (this._stopped) return;
    this._stopped = true;
    try { if (this._unsubBus) this._unsubBus(); } catch (_e) { /* swallow */ }
    if (this._intervals && this._pruneIntervalId) {
      try { this._intervals.clear(this._pruneIntervalId); } catch (_e) { /* swallow */ }
    }
    this._flush();   // final flush
  }
}

module.exports = { CostStream };
