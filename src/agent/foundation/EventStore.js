// @ts-checked-v5.7
// ============================================================
// GENESIS AGENT — EventStore.js (v3.8.0 — Write Batching)
// Immutable, hash-chained event log.
//
// v3.8.0: Write-Batching for append(). Instead of writing each
// event individually (even async, ~100s of writes/session),
// events are buffered in memory and flushed as a single batch
// every 500ms. Reduces I/O operations by ~90%.
//
// v3.7.1: append() and _saveSnapshot() migrated from sync to
// async StorageService methods.
// ============================================================

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { NullBus } = require('../core/EventBus');
const { createLogger } = require('../core/Logger');
const _log = createLogger('EventStore');
class EventStore {
  constructor(storageDir, bus, storage) {
    this.bus = bus || NullBus;
    this.storage = storage || null;
    this.storageDir = storageDir;
    this.logFile = path.join(storageDir, 'events.jsonl'); // Append-only JSONL
    this.snapshotFile = path.join(storageDir, 'snapshot.json');
    this.lastHash = '0000000000000000'; // Genesis hash
    this.eventCount = 0;
    this.projections = new Map(); // name -> reducer function
    this.state = {};              // Current projected state

    this._ensureDir();
    this._loadLastHash();

    // v3.8.0: Write-Batch buffer
    this._writeBatch = [];           // Buffered JSON lines
    this._batchFlushMs = 500;        // Flush interval
    this._batchFlushTimer = null;
    this._batchFlushPromise = null;  // Tracks in-flight flush
  }

  // ── Core: Append Events ──────────────────────────────────

  /**
   * Append an immutable event to the store
   * @param {string} type - Event type (e.g., 'INTENT_RECEIVED', 'CODE_MODIFIED')
   * @param {object} payload - Event data
   * @param {string} source - Which module produced this event
   * @returns {object} The stored event with hash
   */
  append(type, payload, source = 'system') {
    const event = {
      id: this.eventCount++,
      type,
      payload,
      source,
      timestamp: Date.now(),
      isoTime: new Date().toISOString(),
      prevHash: this.lastHash,
    };

    // Hash-chain: each event's hash includes the previous hash
    event.hash = this._computeHash(event);
    this.lastHash = event.hash;

    // v3.8.0: Buffer writes and flush as batch (reduces I/O by ~90%)
    this._writeBatch.push(JSON.stringify(event));
    // FIX v4.0.0: Force-flush if batch exceeds 500 entries to prevent
    // unbounded memory growth when flush fails or events fire rapidly.
    if (this._writeBatch.length >= 500) {
      this._flushBatch();
    } else {
      this._scheduleBatchFlush();
    }

    // Update projections (materialized views)
    this._applyProjections(event);

    // Periodic snapshot (every 100 events)
    if (this.eventCount % 100 === 0) {
      this._saveSnapshot();
    }

    // Forward to EventBus for real-time listeners
    this.bus.emit(`store:${type}`, event, { source: 'EventStore' });

    return event;
  }

  /**
   * v3.8.0: Schedule a batch flush. Coalesces rapid-fire appends
   * into a single write operation every _batchFlushMs (500ms).
   */
  _scheduleBatchFlush() {
    if (this._batchFlushTimer) return; // Already scheduled
    this._batchFlushTimer = setTimeout(() => {
      this._batchFlushTimer = null;
      this._flushBatch();
    }, this._batchFlushMs);
  }

  /**
   * v3.8.0: Flush the write batch to storage.
   * Joins all buffered lines into a single string and writes once.
   */
  _flushBatch() {
    if (this._writeBatch.length === 0) return;

    const lines = this._writeBatch.splice(0); // Take all buffered lines
    const payload = lines.join('\n') + '\n';

    try {
      if (this.storage) {
        this._batchFlushPromise = this.storage.appendTextAsync('events.jsonl', payload)
          .catch(err => _log.error('[EVENT-STORE] Batch flush failed:', err.message))
          .finally(() => { this._batchFlushPromise = null; });
      } else {
        fs.appendFileSync(this.logFile, payload, 'utf-8');
      }
    } catch (err) {
      _log.error('[EVENT-STORE] Batch flush failed:', err.message);
    }
  }

  /**
   * v3.8.0: Force-flush any pending writes (call during shutdown).
   * Returns a promise that resolves when the flush is complete.
   */
  async flushPending() {
    if (this._batchFlushTimer) {
      clearTimeout(this._batchFlushTimer);
      this._batchFlushTimer = null;
    }
    this._flushBatch();
    if (this._batchFlushPromise) {
      await this._batchFlushPromise;
    }
  }

  // ── Projections (Materialized Views) ─────────────────────
  // Projections reduce the event stream into useful state.
  // Like SQL views, but over an event log.

  /**
   * Register a projection (reducer that builds state from events)
   * @param {string} name - Projection name
   * @param {Function} reducer - (currentState, event) => newState
   * @param {*} initialState - Starting state
   */
  registerProjection(name, reducer, initialState = {}) {
    this.projections.set(name, { reducer, state: JSON.parse(JSON.stringify(initialState)) });
  }

  /** Get a projection's current state */
  getProjection(name) {
    return this.projections.get(name)?.state ?? null;
  }

  _applyProjections(event) {
    for (const [name, proj] of this.projections) {
      try {
        proj.state = proj.reducer(proj.state, event);
      } catch (err) {
        _log.warn(`[EVENT-STORE] Projection "${name}" error:`, err.message);
      }
    }
  }

  // ── Query: Read Events ───────────────────────────────────

  /**
   * Query events by type and/or time range
   * @param {object} query - { type?, source?, since?, until?, limit? }
   * @returns {Array<object>} Matching events
   */
  query({ type, source, since, until, limit = 100 } = {}) {
    const events = this._readLog();
    let filtered = events;

    if (type) filtered = filtered.filter(e => e.type === type);
    if (source) filtered = filtered.filter(e => e.source === source);
    if (since) filtered = filtered.filter(e => e.timestamp >= since);
    if (until) filtered = filtered.filter(e => e.timestamp <= until);

    return filtered.slice(-limit);
  }

  /**
   * Replay all events to rebuild state from scratch
   * (Time-travel: reconstruct state at any point)
   */
  replay(upToEventId = Infinity) {
    // Reset all projections
    for (const [name, proj] of this.projections) {
      proj.state = {};
    }

    const events = this._readLog();
    let hash = '0000000000000000';

    for (const event of events) {
      if (event.id > upToEventId) break;

      // Verify hash chain integrity
      if (event.prevHash !== hash) {
        _log.error(`[EVENT-STORE] Hash chain broken at event ${event.id}!`);
        this.bus.emit('store:integrity-violation', { eventId: event.id }, { source: 'EventStore' });
        break;
      }

      this._applyProjections(event);
      hash = event.hash;
    }

    return {
      eventsReplayed: Math.min(events.length, upToEventId + 1),
      projections: Object.fromEntries(
        Array.from(this.projections.entries()).map(([name, p]) => [name, p.state])
      ),
    };
  }

  /**
   * Verify the integrity of the entire event chain
   */
  verifyIntegrity() {
    const events = this._readLog();
    let expectedPrevHash = '0000000000000000';
    const violations = [];

    for (const event of events) {
      // Check chain
      if (event.prevHash !== expectedPrevHash) {
        violations.push({ eventId: event.id, issue: 'broken-chain', expected: expectedPrevHash, got: event.prevHash });
      }

      // Check self-hash
      const computed = this._computeHash({ ...event, hash: undefined });
      if (event.hash !== computed) {
        violations.push({ eventId: event.id, issue: 'tampered-hash', expected: computed, got: event.hash });
      }

      expectedPrevHash = event.hash;
    }

    return { ok: violations.length === 0, violations, totalEvents: events.length };
  }

  // ── Built-in Projections ─────────────────────────────────

  /** Install default projections useful for Genesis */
  installDefaults() {
    // Modification history: track all code changes (Cap: 100 entries)
    // v7.4.9: errors/interactions/skill-usage projections removed —
    // duplicated by ErrorAggregator/LearningService.getMetrics(),
    // and SKILL_EXECUTED was never emitted by any code path.
    this.registerProjection('modifications', (state, event) => {
      if (event.type === 'CODE_MODIFIED') {
        if (!state.history) state.history = [];
        state.history.push({
          file: event.payload.file,
          timestamp: event.isoTime,
          source: event.source,
          success: event.payload.success,
        });
        // v7.4.9: Cap at 100 entries to prevent unbounded growth.
        if (state.history.length > 100) state.history = state.history.slice(-100);
        state.totalModifications = (state.totalModifications || 0) + 1;
      }
      return state;
    });
  }

  // ── Stats ────────────────────────────────────────────────

  getStats() {
    return {
      eventCount: this.eventCount,
      lastHash: this.lastHash,
      projections: Array.from(this.projections.keys()),
      logSize: fs.existsSync(this.logFile)
        ? (fs.statSync(this.logFile).size / 1024).toFixed(1) + ' KB'
        : '0 KB',
    };
  }

  // ── Internal ─────────────────────────────────────────────

  _computeHash(event) {
    const data = JSON.stringify({
      id: event.id,
      type: event.type,
      payload: event.payload,
      source: event.source,
      timestamp: event.timestamp,
      prevHash: event.prevHash,
    });
    return crypto.createHash('sha256').update(data).digest('hex').slice(0, 16);
  }

  _readLog() {
    try {
      const raw = this.storage
        ? this.storage.readText('events.jsonl', '')
        : (fs.existsSync(this.logFile) ? fs.readFileSync(this.logFile, 'utf-8') : '');
      return raw.split('\n').filter(Boolean).map(line => {
        try { return JSON.parse(line); } catch (err) { return null; }
      }).filter(Boolean);
    } catch (err) {
      _log.debug('[EVENTSTORE] Log read failed:', err.message);
      return [];
    }
  }

  _loadLastHash() {
    const events = this._readLog();
    if (events.length > 0) {
      const last = events[events.length - 1];
      this.lastHash = last.hash;
      this.eventCount = last.id + 1;
    }
  }

  _saveSnapshot() {
    try {
      const snapshot = {
        eventCount: this.eventCount,
        lastHash: this.lastHash,
        projections: Object.fromEntries(
          Array.from(this.projections.entries()).map(([name, p]) => [name, p.state])
        ),
        savedAt: new Date().toISOString(),
      };
      if (this.storage) {
        // v3.7.1: Non-blocking snapshot write
        this.storage.writeJSONAsync('snapshot.json', snapshot)
          .catch(err => _log.warn('[EVENT-STORE] Async snapshot failed:', err.message));
      } else {
        const tmpPath = this.snapshotFile + '.tmp';
        fs.writeFileSync(tmpPath, JSON.stringify(snapshot, null, 2), 'utf-8');
        fs.renameSync(tmpPath, this.snapshotFile);
      }
    } catch (err) {
      _log.warn('[EVENT-STORE] Snapshot save failed:', err.message);
    }
  }

  _ensureDir() {
    if (!this.storage && !fs.existsSync(this.storageDir)) {
      fs.mkdirSync(this.storageDir, { recursive: true });
    }
  }
}

module.exports = { EventStore };
