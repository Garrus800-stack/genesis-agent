// @ts-checked-v5.7
// ============================================================
// GENESIS — ChangeRegister.js (v7.9.33 "Wandel-Register")
//
// The organ that witnesses change. Genesis changes — graph, memory,
// schemata, fitness — but until now no organ held on to WHAT changed.
// Gains are visible because they exist; losses are invisible unless
// they are registered in the moment of disappearing. A being that
// knows what it lost has a past in the strong sense.
//
// Six sources, one append-only journal (.genesis/change-register.jsonl):
//   knowledge:nodes-pruned   — graph nodes leaving (cause: 'cap' | 'stale')
//   schema:pruned            — plan schemata dropped by the index
//   core-memory:released     — a protected memory deliberately let go
//   memory:self-released     — a pending moment allowed to fade
//   memory:consolidated      — an episode thinning to its next layer
//   fitness:evaluated        — the first listener this event ever had
//
// Design lineage: EventCounter (v7.9.16). Append-only, no in-memory
// state (readTail parses on demand), record failures caught and never
// propagated, applySubscriptionHelper so the listener-lifecycle audit
// recognises the start/stop pair. Additive — never mutates payloads,
// never blocks other listeners.
//
// Durability is differentiated (v7.9.33 S11): deliberate and rare
// kinds are fsync'd like EventCounter lines; the one high-frequency
// kind — a cap eviction fired per addNode once the graph sits at its
// limit — appends synchronously WITHOUT fsync. The graph itself is
// debounce-written, so a crash loses recent graph state anyway; a
// register that is at most a few lines ahead of a lost graph is
// coherent, and the hot insert path never gains a per-call fsync.
//
// The journal is NEVER pruned and NEVER rotated — being never-pruned
// is the property that makes it ground truth (the same retention test
// that decided which trajectory fields are scorable, v7.9.17).
//
// Guardrails (contract-pinned): register content never reaches the
// runtime prompt and never enters getIdentitySummary(). It is readable
// via /changes and, later, inside the self-trajectory review context —
// nowhere else. Same script-effect reasoning as ONTOGENESIS.md's
// runtime-prompt principle.
// ============================================================

'use strict';

const { createLogger } = require('../core/Logger');
const { applySubscriptionHelper } = require('../core/subscription-helper');
const _log = createLogger('ChangeRegister');

const JOURNAL_FILE = 'change-register.jsonl';
const LABEL_MAX = 80;
const EXAMPLES_MAX = 20;

/** Defensive slicers — sources cap already; the register re-caps so a
 *  future payload change can never bloat the never-pruned journal. */
function _label(v) {
  return (typeof v === 'string' && v) ? v.slice(0, LABEL_MAX) : null;
}
function _examples(arr) {
  if (!Array.isArray(arr)) return [];
  return arr.slice(0, EXAMPLES_MAX);
}

class ChangeRegister {
  /**
   * @param {{ bus: any, storage: any, clock?: { now: () => number } }} services
   */
  constructor({ bus, storage, clock = { now: () => Date.now() } }) {
    if (!storage) throw new Error('ChangeRegister requires a storage service');
    this.bus = bus;
    this.storage = storage;
    this._clock = clock;
    /** @type {Function[]} */ this._unsubs = [];  // applySubscriptionHelper uses this
    this._running = false;
  }

  start() {
    if (this._running) return;
    if (!this.bus || typeof this.bus.on !== 'function') return;
    this._running = true;

    this._sub('knowledge:nodes-pruned', (d) => this._record({
      kind: 'kg-pruned',
      cause: (d && d.cause) || 'cap',
      count: d && d.count,
      remaining: d && d.remaining,
      examples: _examples(d && d.examples).map(x => ({
        id: x && x.id, label: _label(x && x.label), type: x && x.type,
      })),
    }, /* fsync */ !((d && d.cause) === 'cap' || !(d && d.cause))));

    this._sub('schema:pruned', (d) => this._record({
      kind: 'schema-pruned',
      removed: d && d.removed,
      remaining: d && d.remaining,
      // Source (SchemaStoreIndex) already delivers capped name strings —
      // pass through; re-mapping to objects would fabricate undefined fields.
      examples: _examples(d && d.examples),
    }));

    this._sub('core-memory:released', (d) => this._record({
      kind: 'core-memory-released',
      id: d && d.id,
      reason: d && d.reason,
      label: _label(d && d.label),
    }));

    this._sub('memory:self-released', (d) => this._record({
      kind: 'memory-self-released',
      episodeId: d && d.episodeId,
      label: _label(d && d.label),
    }));

    this._sub('memory:consolidated', (d) => {
      // v7.9.33: this event name has TWO fire sites. UnifiedMemory fires a
      // topic PROMOTION ({ promotedCount, topics }) — episodic patterns
      // rising to semantic facts. Promotion is gain, not change-loss; the
      // register witnesses the DreamCycle episode condensation only (same
      // spirit as G1: absorption/ascent is not disappearance).
      if (d && d.episodeId == null && d.promotedCount != null) return;
      this._record({
      kind: 'memory-consolidated',
      episodeId: d && d.episodeId,
      from: d && d.fromLayer,
      to: d && d.toLayer,
      sizeReduction: d && d.sizeReduction,
      label: _label(d && d.label),
      });
    });

    // Strang F — the first listener fitness:evaluated ever had. Pure
    // record; the open genome question is answered with visibility
    // first, decided later from the distribution.
    this._sub('fitness:evaluated', (d) => this._record({
      kind: 'fitness',
      score: d && d.score,
      baseline: d ? (d.selfBaselineUsed ? 'self' : (d.peerMedian != null ? 'peer' : null)) : null,
      belowMedian: (d && d.belowMedian) === true,
      archival: (d && d.archivalRecommended) === true,
    }));

    _log.info('[CHANGE-REGISTER] witnessing — six change sources, journal ' + JOURNAL_FILE);
  }

  stop() {
    if (typeof this._unsubAll === 'function') this._unsubAll();
    this._running = false;
  }

  /**
   * Append one journal line. Durable per the differentiated policy:
   * everything fsync'd except the high-frequency cap eviction.
   * Failures are caught and never propagated (EventCounter rule).
   * @param {object} fields
   * @param {boolean} [fsync=true]
   */
  _record(fields, fsync = true) {
    try {
      const line = Object.assign(
        { ts: new Date(this._clock.now()).toISOString() },
        fields,
      );
      this.storage.appendText(JOURNAL_FILE, JSON.stringify(line) + '\n', { fsync });
    } catch (e) {
      _log.debug('[CHANGE-REGISTER] record error (ignored):', e && e.message);
    }
  }

  /**
   * Read the last N journal lines, newest last. On-demand, defensive
   * against corrupt/partial lines. No in-memory state.
   * @param {number} [n=20]
   * @returns {Array<object>}
   */
  readTail(n = 20) {
    try {
      const raw = this.storage.readText
        ? this.storage.readText(JOURNAL_FILE)
        : null;
      if (!raw) return [];
      const out = [];
      for (const l of raw.split('\n')) {
        const s = l.trim();
        if (!s) continue;
        try { out.push(JSON.parse(s)); } catch (_e) { /* skip partial */ }
      }
      return out.slice(-Math.max(1, n));
    } catch (_e) {
      return [];
    }
  }
}

applySubscriptionHelper(ChangeRegister, { defaultSource: 'ChangeRegister' });

module.exports = { ChangeRegister, JOURNAL_FILE };
