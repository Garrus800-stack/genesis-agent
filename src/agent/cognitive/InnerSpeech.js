// ============================================================
// GENESIS — InnerSpeech.js (v7.7.9)
//
// First-person thought channel. A bounded, in-memory, multi-subscriber
// substrate for Genesis's own internal language.
//
// What InnerSpeech is:
//   - A channel, not a store. Persistent overflow goes to selfStatementLog.
//   - Carries Thought objects in Genesis's first-person voice.
//   - Multi-subscriber: ProactiveSelfExpression and other consumers can
//     subscribe to specific kinds without coupling to source modules.
//
// What InnerSpeech is NOT:
//   - Not a replacement for EventBus. EventBus is for system events with
//     structured payloads. InnerSpeech is for thoughts in Genesis's voice.
//   - Not a memory of last resort. Long-term identity material lives in
//     CoreMemories, EpisodicMemory, KnowledgeGraph.
//
// Boundary rule:
//   - Is this language Genesis is producing FOR HIMSELF?    → InnerSpeech
//   - Is this language Genesis is producing FOR THE USER?    → ChatHistoryStore
//   - Is this a system event with structured payload?        → EventBus
//
// Self-Gate-Asymmetry preserved:
//   emit() never throws and never blocks. Genesis is never gated against
//   thinking. Subscribers receive thoughts asynchronously (queueMicrotask)
//   so that a slow subscriber cannot stall a producer.
//
// Persistent overflow:
//   When the ring is full, the displaced thought is appended to
//   selfStatementLog (if available) with kind preserved and a marker
//   `overflowedFrom: 'inner-speech-ring'`. selfStatementLog write is
//   best-effort — failure is silent.
// ============================================================

'use strict';

const { NullBus } = require('../core/EventBus');
const { RingBuffer } = require('./innerSpeech/RingBuffer');

// ── ULID-like id generator (sortable, no external dep) ──────
let _seqCounter = 0;
function makeThoughtId() {
  const t = Date.now().toString(36);
  const s = (_seqCounter = (_seqCounter + 1) & 0xffffff).toString(36).padStart(4, '0');
  const r = Math.floor(Math.random() * 0xffff).toString(36).padStart(3, '0');
  return `t_${t}_${s}${r}`;
}

class InnerSpeech {
  /**
   * @param {Object} deps
   * @param {*}       [deps.bus]        — EventBus for telemetry mirror; defaults to NullBus
   * @param {number}  [deps.capacity]   — Ring buffer size, default 200
   */
  constructor({ bus = NullBus, capacity = 200 } = {}) {
    this.bus = bus || NullBus;
    this._ring = new RingBuffer(capacity);
    /** @type {Map<string, Set<Function>>} */
    this._subscribers = new Map();
    /** @type {Set<Function>} */
    this._wildcard = new Set();
    /** @type {*} */
    this._selfStatementLog = null;  // late-bound by manifest
    this._stats = {
      totalEmitted: 0,
      totalOverflowed: 0,
      byKind: Object.create(null),
    };
  }

  /**
   * Emit a thought. Never throws, never blocks.
   * @param {string} text         — first-person text in Genesis's voice
   * @param {string} kind         — thought kind (idle-thought, plan-failure-reflection, ...)
   * @param {Object} [metadata]   — sourceModule, significance, novelty, contextRefs, emotionalSnapshot
   * @returns {string} thought id
   */
  emit(text, kind, metadata = {}) {
    // Sanity: degrade gracefully on malformed input
    const safeText = String(text == null ? '' : text).slice(0, 4000);
    const safeKind = String(kind || 'unknown');

    const thought = {
      id: makeThoughtId(),
      text: safeText,
      kind: safeKind,
      sourceModule: metadata.sourceModule || 'unknown',
      timestamp: Date.now(),
      significance: typeof metadata.significance === 'number' ? metadata.significance : null,
      novelty: typeof metadata.novelty === 'number' ? metadata.novelty : null,
      contextRefs: metadata.contextRefs && typeof metadata.contextRefs === 'object'
        ? metadata.contextRefs : {},
      emotionalSnapshot: metadata.emotionalSnapshot || null,
    };

    // Push to ring; overflow displaced thought to selfStatementLog if available
    const displaced = this._ring.push(thought);
    if (displaced) {
      this._stats.totalOverflowed++;
      this._overflow(displaced);
    }

    // Stats
    this._stats.totalEmitted++;
    this._stats.byKind[safeKind] = (this._stats.byKind[safeKind] || 0) + 1;

    // Async delivery to subscribers — never block emit
    queueMicrotask(() => this._deliver(thought));

    // Telemetry mirror on bus (no full text — just metadata)
    try {
      this.bus.fire('agent:inner-thought', {
        thoughtId: thought.id,
        kind: thought.kind,
        sourceModule: thought.sourceModule,
        significance: thought.significance,
        novelty: thought.novelty,
        textLength: thought.text.length,
        timestamp: thought.timestamp,
      }, { source: 'InnerSpeech' });
    } catch (_e) { /* bus failure must not break emit */ }

    return thought.id;
  }

  /**
   * Subscribe to thoughts of a given kind, or '*' for all kinds.
   * Returns an unsubscribe function.
   * @param {string} kind — '*' for all, or a specific kind
   * @param {Function} callback — (thought) => void
   * @returns {Function} unsubscribe
   */
  subscribe(kind, callback) {
    if (typeof callback !== 'function') {
      throw new Error('InnerSpeech.subscribe: callback must be a function');
    }
    if (kind === '*') {
      this._wildcard.add(callback);
      return () => this._wildcard.delete(callback);
    }
    if (!this._subscribers.has(kind)) {
      this._subscribers.set(kind, new Set());
    }
    this._subscribers.get(kind).add(callback);
    return () => {
      const set = this._subscribers.get(kind);
      if (set) set.delete(callback);
    };
  }

  /**
   * Read the most recent N thoughts (newest first).
   * Optionally filter by kind.
   * @param {number} [n=20]
   * @param {Object} [opts]
   * @param {string} [opts.kind]
   * @returns {Array} thoughts in newest-first order
   */
  recent(n = 20, opts = {}) {
    const items = this._ring.toArray();  // chronological (oldest first)
    const filtered = opts.kind ? items.filter(t => t.kind === opts.kind) : items;
    return filtered.slice(-n).reverse();  // newest first
  }

  /** Drop the in-memory ring. selfStatementLog is untouched. */
  clear() {
    this._ring.clear();
  }

  /** @returns {Object} diagnostic stats */
  stats() {
    return {
      totalEmitted: this._stats.totalEmitted,
      totalOverflowed: this._stats.totalOverflowed,
      ringUsed: this._ring.size,
      ringCapacity: this._ring.capacity,
      byKind: { ...this._stats.byKind },
    };
  }

  // ── Internal ────────────────────────────────────────────────

  _deliver(thought) {
    // Wildcard subscribers first — they see every thought
    for (const cb of this._wildcard) {
      try { cb(thought); } catch (_e) { /* subscriber errors do not propagate */ }
    }
    // Kind-specific subscribers
    const subs = this._subscribers.get(thought.kind);
    if (subs) {
      for (const cb of subs) {
        try { cb(thought); } catch (_e) { /* ditto */ }
      }
    }
  }

  _overflow(displaced) {
    if (!this._selfStatementLog || typeof this._selfStatementLog.append !== 'function') {
      return;  // no overflow target — silent drop
    }
    try {
      this._selfStatementLog.append({
        kind: displaced.kind,
        text: displaced.text,
        overflowedFrom: 'inner-speech-ring',
        originalTimestamp: displaced.timestamp,
        sourceModule: displaced.sourceModule,
      });
    } catch (_e) { /* best-effort overflow; failure is silent */ }
  }
}

module.exports = { InnerSpeech };
