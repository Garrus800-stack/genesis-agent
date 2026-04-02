// @ts-checked-v5.7
// ============================================================
// GENESIS — PeerConsensus.js (v4.12.8)
//
// State synchronization for multi-instance Genesis deployments.
// Solves the problem: when Genesis clones itself or runs multiple
// instances, Settings and KnowledgeGraph diverge with no merge.
//
// Strategy: Last-Writer-Wins (LWW) with Vector Clocks.
// - Each instance tracks a logical clock per peer
// - Every state mutation increments the local clock
// - On sync, vector clocks are compared:
//   - If remote dominates local → accept remote
//   - If local dominates remote → keep local (push to remote)
//   - If concurrent → LWW by wall-clock timestamp
//
// This is NOT full Raft/Paxos. Genesis instances are cooperative,
// not Byzantine. LWW is the right trade-off for:
// - Settings (last user change wins)
// - KG facts (last learned fact wins)
// - Schemas (merge by union + confidence max)
//
// Integration:
//   PeerNetwork registers /sync/pull and /sync/push endpoints.
//   PeerConsensus runs periodic sync via gossip interval.
// ============================================================

const { createLogger } = require('../core/Logger');
const { NullBus } = require('../core/EventBus');
const _log = createLogger('PeerConsensus');

// ═══════════════════════════════════════════════════════════
// VECTOR CLOCK
// ═══════════════════════════════════════════════════════════

class VectorClock {
  /**
   * @param {string} selfId - This instance's unique ID
   * @param {Object<string,number>} initial - Initial clock values
   */
  constructor(selfId, initial = {}) {
    this.selfId = selfId;
    this.clock = { ...initial };
    if (!(selfId in this.clock)) this.clock[selfId] = 0;
  }

  /** Increment own clock (call on every local mutation). */
  tick() {
    this.clock[this.selfId] = (this.clock[this.selfId] || 0) + 1;
    return this.clock[this.selfId];
  }

  /** Merge with a remote clock (take max of each component). */
  merge(remoteClock) {
    for (const [id, value] of Object.entries(remoteClock)) {
      this.clock[id] = Math.max(this.clock[id] || 0, value);
    }
    // Ensure own clock is at least as high as merged
    this.tick();
  }

  /**
   * Compare two vector clocks.
   * @param {Object<string,number>} a
   * @param {Object<string,number>} b
   * @returns {'before'|'after'|'concurrent'|'equal'}
   *   'before'  = a happened-before b (a < b)
   *   'after'   = a happened-after b (a > b)
   *   'concurrent' = neither dominates
   *   'equal'   = identical
   */
  static compare(a, b) {
    const allKeys = new Set([...Object.keys(a), ...Object.keys(b)]);
    let aLess = false, bLess = false;
    for (const key of allKeys) {
      const va = a[key] || 0;
      const vb = b[key] || 0;
      if (va < vb) aLess = true;
      if (va > vb) bLess = true;
    }
    if (aLess && bLess) return 'concurrent';
    if (aLess) return 'before';
    if (bLess) return 'after';
    return 'equal';
  }

  /** Serialize for network transmission. */
  toJSON() { return { ...this.clock }; }

  /** Get current value. */
  get value() { return this.clock[this.selfId] || 0; }
}


// ═══════════════════════════════════════════════════════════
// PEER CONSENSUS
// ═══════════════════════════════════════════════════════════

class PeerConsensus {
  static containerConfig = {
    name: 'peerConsensus',
    phase: 5,
    deps: ['storage', 'eventStore'],
    tags: ['hexagonal', 'consensus', 'sync'],
    lateBindings: [
      { prop: 'network', service: 'network', optional: true },
      { prop: 'settings', service: 'settings', optional: true },
      { prop: 'knowledgeGraph', service: 'knowledgeGraph', optional: true },
      { prop: 'schemaStore', service: 'schemaStore', optional: true },
    ],
  };

  constructor({ bus, storage, eventStore, selfId, config }) {
    this.bus = bus || NullBus;
    this.storage = storage;
    this.eventStore = eventStore || null;
    this.selfId = selfId || `genesis-${Date.now().toString(36)}`;

    // Late-bound
    this.network = null;
    this.settings = null;
    this.knowledgeGraph = null;
    this.schemaStore = null;

    const cfg = config || {};
    this._syncIntervalMs = cfg.syncIntervalMs || 120000; // 2 min
    this._syncEnabled = cfg.enabled !== false;

    // Vector clocks per sync domain
    this._clocks = {
      settings: new VectorClock(this.selfId),
      knowledge: new VectorClock(this.selfId),
      schemas: new VectorClock(this.selfId),
    };

    // LWW register: key → { value, timestamp, clock }
    this._lwwRegister = new Map();

    // Stats
    this._stats = {
      syncAttempts: 0,
      syncSuccesses: 0,
      conflictsResolved: 0,
      itemsSent: 0,
      itemsReceived: 0,
    };

    this._load();
  }

  // ═══════════════════════════════════════════════════════
  // PUBLIC API
  // ═══════════════════════════════════════════════════════

  /**
   * Record a local mutation. Call this when settings change,
   * facts are learned, or schemas are stored.
   * @param {'settings'|'knowledge'|'schemas'} domain
   * @param {string} key
   * @param {*} value
   */
  recordMutation(domain, key, value) {
    if (!this._clocks[domain]) return;
    const version = this._clocks[domain].tick();
    this._lwwRegister.set(`${domain}:${key}`, {
      value,
      timestamp: Date.now(),
      clock: { ...this._clocks[domain].toJSON() },
      version,
    });
  }

  /**
   * Build a sync payload for sending to a peer.
   * Includes vector clocks and all mutations since the peer's
   * last known clock values.
   *
   * @param {Object} peerClocks - Peer's vector clocks per domain
   * @returns {{ selfId: string, clocks: object, mutations: Array }}
   */
  buildSyncPayload(peerClocks = {}) {
    const mutations = [];

    for (const [fullKey, entry] of this._lwwRegister) {
      const [domain] = fullKey.split(':', 1);
      const peerClock = peerClocks[domain] || {};
      const relation = VectorClock.compare(peerClock, entry.clock);

      // Send if peer hasn't seen this version
      if (relation === 'before' || relation === 'concurrent') {
        mutations.push({
          key: fullKey,
          value: entry.value,
          timestamp: entry.timestamp,
          clock: entry.clock,
        });
      }
    }

    return {
      selfId: this.selfId,
      clocks: {
        settings: this._clocks.settings.toJSON(),
        knowledge: this._clocks.knowledge.toJSON(),
        schemas: this._clocks.schemas.toJSON(),
      },
      mutations,
    };
  }

  /**
   * Apply a sync payload received from a peer.
   * Uses LWW: if concurrent, wall-clock timestamp wins.
   *
   * @param {{ selfId, clocks, mutations }} payload
   * @returns {{ accepted: number, rejected: number, conflicts: number }}
   */
  applySyncPayload(payload) {
    if (!payload?.mutations) return { accepted: 0, rejected: 0, conflicts: 0 };

    let accepted = 0, rejected = 0, conflicts = 0;

    for (const mutation of payload.mutations) {
      const existing = this._lwwRegister.get(mutation.key);

      if (!existing) {
        // New key — accept unconditionally
        this._lwwRegister.set(mutation.key, {
          value: mutation.value,
          timestamp: mutation.timestamp,
          clock: mutation.clock,
        });
        this._applyToService(mutation.key, mutation.value);
        accepted++;
        continue;
      }

      const relation = VectorClock.compare(existing.clock, mutation.clock);

      if (relation === 'before') {
        // Remote is strictly newer — accept
        this._lwwRegister.set(mutation.key, {
          value: mutation.value,
          timestamp: mutation.timestamp,
          clock: mutation.clock,
        });
        this._applyToService(mutation.key, mutation.value);
        accepted++;
      } else if (relation === 'concurrent') {
        // Concurrent — LWW by wall-clock timestamp
        conflicts++;
        if (mutation.timestamp > existing.timestamp) {
          this._lwwRegister.set(mutation.key, {
            value: mutation.value,
            timestamp: mutation.timestamp,
            clock: mutation.clock,
          });
          this._applyToService(mutation.key, mutation.value);
          accepted++;
        } else {
          rejected++;
        }
      } else {
        // Local is newer or equal — reject
        rejected++;
      }
    }

    // Merge clocks
    if (payload.clocks) {
      for (const domain of ['settings', 'knowledge', 'schemas']) {
        if (payload.clocks[domain]) {
          this._clocks[domain].merge(payload.clocks[domain]);
        }
      }
    }

    this._stats.syncSuccesses++;
    this._stats.conflictsResolved += conflicts;
    this._stats.itemsReceived += accepted;

    if (accepted > 0) {
      this.bus.emit('peer:sync-applied', {
        from: payload.selfId,
        accepted, rejected, conflicts,
      }, { source: 'PeerConsensus' });
      _log.info(`[SYNC] Applied ${accepted} mutations from ${payload.selfId} (${conflicts} conflicts resolved by LWW)`);
    }

    this._save();
    return { accepted, rejected, conflicts };
  }

  /**
   * Get sync status for diagnostics.
   */
  getStatus() {
    return {
      selfId: this.selfId,
      enabled: this._syncEnabled,
      clocks: {
        settings: this._clocks.settings.value,
        knowledge: this._clocks.knowledge.value,
        schemas: this._clocks.schemas.value,
      },
      registerSize: this._lwwRegister.size,
      stats: { ...this._stats },
    };
  }

  // ═══════════════════════════════════════════════════════
  // INTERNAL — Apply to services
  // ═══════════════════════════════════════════════════════

  /**
   * Apply a synced value to the appropriate service.
   * @param {string} fullKey - "domain:key"
   * @param {*} value
   */
  _applyToService(fullKey, value) {
    const colonIdx = fullKey.indexOf(':');
    if (colonIdx < 0) return;
    const domain = fullKey.slice(0, colonIdx);
    const key = fullKey.slice(colonIdx + 1);

    try {
      switch (domain) {
        case 'settings':
          if (this.settings?.set) {
            this.settings.set(key, value);
          }
          break;
        case 'knowledge':
          if (this.knowledgeGraph?.connect) {
            // value is { subject, relation, object }
            if (value?.subject && value?.relation && value?.object) {
              this.knowledgeGraph.connect(value.subject, value.relation, value.object);
            }
          }
          break;
        case 'schemas':
          if (this.schemaStore?.store) {
            this.schemaStore.store(value);
          }
          break;
      }
    } catch (err) {
      _log.debug(`[SYNC] Failed to apply ${fullKey}:`, err.message);
    }
  }

  // ═══════════════════════════════════════════════════════
  // PERSISTENCE
  // ═══════════════════════════════════════════════════════

  _save() {
    if (!this.storage) return;
    try {
      const data = {
        selfId: this.selfId,
        clocks: {
          settings: this._clocks.settings.toJSON(),
          knowledge: this._clocks.knowledge.toJSON(),
          schemas: this._clocks.schemas.toJSON(),
        },
        // Only persist recent LWW entries (last 500)
        register: [...this._lwwRegister.entries()]
          .sort((a, b) => b[1].timestamp - a[1].timestamp)
          .slice(0, 500)
          .map(([k, v]) => [k, v]),
      };
      this.storage.writeJSONDebounced('peer-consensus.json', data, 5000);
    } catch (err) {
      _log.debug('[SYNC] Save failed:', err.message);
    }
  }

  _load() {
    if (!this.storage) return;
    try {
      const data = this.storage.readJSON('peer-consensus.json', null);
      if (!data) return;
      if (data.selfId) this.selfId = data.selfId;
      if (data.clocks) {
        for (const domain of ['settings', 'knowledge', 'schemas']) {
          if (data.clocks[domain]) {
            this._clocks[domain] = new VectorClock(this.selfId, data.clocks[domain]);
          }
        }
      }
      if (data.register) {
        for (const [key, value] of data.register) {
          this._lwwRegister.set(key, value);
        }
      }
    } catch (err) {
      _log.debug('[SYNC] Load failed:', err.message);
    }
  }
}

module.exports = { PeerConsensus, VectorClock };
