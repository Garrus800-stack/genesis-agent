// @ts-checked-v5.7
// ============================================================
// GENESIS — TrajectoryCalibration.js (Phase 9 — Cognitive Architecture)
//
// Silent reality-check for SelfTrajectory entries (v7.9.17).
//
// Of the six trajectory fields, only the two whose numeric ground-truth
// is reconstructable over a weeks-long cycle get a ternary sign-score
// (matched / opposite / undefined). The line is not "numeric vs not" but
// "persisted (against reboot) AND not pruned (against time) AND
// accessible over the cycle (against cache-reset)":
//
//   wachstum  → sign-score. Success-rate sign-delta between this cycle
//               and the previous one, both from the v7.9.16 event journal
//               (EventCounter.summaryBetween) — append-only, never pruned.
//   schwaeche → sign-score. Wilson-LB sign-delta for the named capability
//               domain, from a capability snapshot taken AT COMMIT (the
//               profile is now-anchored and the outcome buffer prunes, so
//               the per-cycle aggregate is snapshotted while still in the
//               buffer and preserved in the directions file).
//   traits    → record-only. Genome._adjustmentLog is in-memory and is not
//               in _persistData() — it dies on reboot (fails persistence).
//   emotion   → record-only. Mood history is a 200-snapshot ring (fails
//               not-pruned over weeks).
//   beziehung → record-only. Session metrics are a weak relationship
//               proxy (a long session is not evidence of closeness).
//   value     → record-only. Values have no sign by design; position
//               drift is MEASURED (embedding distance) without a
//               threshold — the threshold, if any, comes later from the
//               observed distribution, not from an assumption now.
//
// Two phases, two append-only side files (no schema-bump on the entry):
//   1. COMMIT  (trajectory:committed): a SEPARATE, neutral classifier
//      extracts the EXPECTED direction of each sign-field's statement
//      ({+1,-1,0,null}) while the model is fresh, snapshots the capability
//      aggregate, records the record-only positions, and measures value
//      drift — one line into self-trajectory-directions.jsonl. Commit
//      offline → explicit null directions (NOT a missing line, and NEVER
//      re-classified later: that would be a later model state judging an
//      earlier statement).
//   2. SCORE   (/trajectory review): the ACTUAL direction is computed from
//      the numeric trend over the cycle and compared to the stored
//      expected direction; the ternary score lands in
//      self-trajectory-calibration.jsonl.
//
// Because the measurement side is purely numeric and the expected side is
// a SEPARATE classifier (never Genesis itself), no self-statement feeds
// the ground truth — the roadmap's "max 25% self-statement weight" cap is
// moot, and stays moot only while the classifier stays separate.
//
// Silent-observation: nothing here feeds decision logic. The dashboard
// (/trajectory calibration) is the only reader.
//
// One-way dependency: this service READS selfTrajectory entries (cycle
// boundaries + prior value position), the event journal, the capability
// profile, the embedding service, and the model; it is TRIGGERED by the
// trajectory:committed bus event. SelfTrajectory does not know it exists.
// ============================================================

'use strict';

const { NullBus } = require('../core/EventBus');
const { EVENTS } = require('../core/EventTypes');
const { createLogger } = require('../core/Logger');
const { applySubscriptionHelper } = require('../core/subscription-helper');

const _log = createLogger('TrajectoryCalibration');

const DIRECTIONS_FILE  = 'self-trajectory-directions.jsonl';
const CALIBRATION_FILE = 'self-trajectory-calibration.jsonl';

// The two fields with cycle-reconstructable numeric ground-truth.
const SIGN_FIELDS = Object.freeze(['wachstum', 'schwaeche']);
// The four fields recorded as positions only (no score), each for a
// different reason — see the header.
const RECORD_FIELDS = Object.freeze(['traits', 'emotion', 'beziehung', 'value']);

// Closed capability-domain vocabulary the classifier maps a weakness
// statement onto, mirroring TaskOutcomeTracker.INTENT_TO_TASK_TYPE values.
// A weakness that matches none of these clearly → null (no guessed map).
const TASK_TYPES = Object.freeze([
  'code-gen', 'self-modify', 'self-repair', 'analysis', 'chat', 'research',
  'planning', 'reasoning', 'skill-exec', 'shell-exec', 'refactoring',
  'testing', 'deployment', 'general',
]);

class TrajectoryCalibration {
  /**
   * @param {{
   *   bus: any,
   *   storage: any,
   *   clock?: { now: () => number },
   * }} services
   */
  constructor({ bus, storage, clock = Date } = {}) {
    if (!storage) throw new Error('TrajectoryCalibration requires a storage service');
    this.bus = bus || NullBus;
    this.storage = storage;
    this._clock = clock;

    // Late-bound (manifest), all optional → graceful degradation:
    /** @type {*} */ this.model = null;             // ModelBridge — the separate classifier
    /** @type {*} */ this.embeddingService = null;  // value-position drift
    /** @type {*} */ this.cognitiveSelfModel = null;// capability snapshot for schwaeche
    /** @type {*} */ this.eventCounter = null;      // durable journal for wachstum
    /** @type {*} */ this.selfTrajectory = null;    // read entries (cycle boundaries, prior value)

    /** @type {Function[]} */ this._unsubs = [];    // applySubscriptionHelper uses this
    this._running = false;
  }

  start() {
    if (this._running) return;
    if (!this.bus || typeof this.bus.on !== 'function') return;
    this._running = true;
    // applySubscriptionHelper provides this._sub() / this._unsubAll().
    this._sub(EVENTS.TRAJECTORY.COMMITTED, (data) => this._onCommitted(data));
    _log.info('[TRAJ-CAL] active — observing trajectory:committed (silent calibration)');
  }

  stop() {
    if (typeof this._unsubAll === 'function') this._unsubAll();
    this._running = false;
  }

  // ── COMMIT phase: classify + snapshot + record (fire-and-forget) ──────

  _onCommitted(data) {
    const entry = data && data.entry;
    if (!entry || !entry.cycle_id || !entry.fields) return;
    // Fire-and-forget: the model call must never block the commit path.
    // Errors are logged, not propagated; a failed classification still
    // produces an explicit-null directions line (honest degradation).
    Promise.resolve()
      .then(() => this._recordDirections(entry))
      .catch((e) => _log.debug('[TRAJ-CAL] recordDirections error (ignored):', e && e.message));
  }

  /**
   * Build and append the directions line for a committed cycle. Written
   * exactly once, at commit. Offline / classifier-failure → explicit null
   * directions, never re-classified later.
   * @param {object} entry committed trajectory entry
   */
  async _recordDirections(entry) {
    const fields = entry.fields || {};

    // Expected directions for the two sign-fields (separate classifier).
    /** @type {Record<string, number|null>} */ const expected = {};
    let schwaecheTaskType = null;
    for (const f of SIGN_FIELDS) {
      const res = await this._classifyDirection(f, fields[f]);
      expected[f] = res.direction;
      if (f === 'schwaeche') schwaecheTaskType = res.taskType;
    }

    // Capability snapshot for schwaeche — the per-cycle aggregate, taken
    // now (while the cycle's outcomes are still in the buffer) and kept
    // durably so a later prune cannot erase the comparison point. windowMs
    // = this cycle's wallclock span; null span → all-time (first cycle).
    const capabilitySnapshot = this._snapshotCapability(entry);

    // value-position drift — embedding distance to the previous cycle's
    // value text. Offline embed → null (NOT 0: cosineSimilarity(null,x)
    // would return 0, which reads as "maximally drifted", so we guard).
    const valueDrift = await this._valueDrift(entry);

    const modelAvailable = expected.wachstum !== null || expected.schwaeche !== null
      || schwaecheTaskType !== null;

    const line = {
      cycle_id: entry.cycle_id,
      ts: new Date(this._clock.now()).toISOString(),
      expected,                       // { wachstum, schwaeche } ∈ {+1,-1,0,null}
      schwaeche_task_type: schwaecheTaskType,
      capability_snapshot: capabilitySnapshot, // { taskType: confidenceLower }
      positions: this._positions(fields),       // record-only field texts
      value_drift: valueDrift,        // distance 0..1, or null
      model_available: modelAvailable,
    };

    try {
      this.storage.appendText(DIRECTIONS_FILE, JSON.stringify(line) + '\n');
      _log.info(`[TRAJ-CAL] directions recorded for ${entry.cycle_id} ` +
        `(wachstum=${expected.wachstum}, schwaeche=${expected.schwaeche}, model=${modelAvailable})`);
    } catch (e) {
      _log.debug('[TRAJ-CAL] directions append error (ignored):', e && e.message);
    }
  }

  /**
   * Neutral, separate classifier for a self-statement's claimed direction.
   * NEVER Genesis classifying itself (that would re-introduce a
   * self-statement confound on the expected side). Strict JSON; explicit
   * null distinguishes "not classifiable / different-not-directional" from
   * a classifier failure (both land as null, but the model_available flag
   * on the line records whether the model answered at all).
   * @param {string} field 'wachstum' | 'schwaeche'
   * @param {string} text the committed field text
   * @returns {Promise<{direction: number|null, taskType: string|null}>}
   */
  async _classifyDirection(field, text) {
    const clean = (text == null ? '' : String(text)).trim();
    if (!clean) return { direction: null, taskType: null };
    if (!this.model || typeof this.model.chatStructured !== 'function') {
      return { direction: null, taskType: null };  // offline / absent → explicit null
    }

    const wantsTaskType = field === 'schwaeche';
    const system =
      'You are a neutral classifier. You are NOT the author of the statement. ' +
      'Given a first-person self-description about change over a period, determine the ' +
      'claimed DIRECTION of change. Respond with strict JSON only.\n' +
      'direction: 1 = the statement claims improvement / getting better / stronger; ' +
      '-1 = claims decline / getting worse / weaker; 0 = claims explicitly NO change ' +
      '(staying the same); null = the statement claims a change that is neither better ' +
      'nor worse (merely different / not directional), or cannot be classified. ' +
      'Do not force a direction onto a non-directional statement.' +
      (wantsTaskType
        ? '\nAlso set task_type to the single best-matching capability domain from this ' +
          `list: [${TASK_TYPES.join(', ')}], or null if none clearly matches. ` +
          'Do not guess a task_type for a weak or ambiguous match.\n' +
          'Shape: {"direction": <1|-1|0|null>, "task_type": <string|null>}'
        : '\nShape: {"direction": <1|-1|0|null>}');

    try {
      const out = await this.model.chatStructured(system, [{ role: 'user', content: clean }], 'analysis');
      if (!out || out._parseError) return { direction: null, taskType: null };
      const dir = this._coerceDirection(out.direction);
      const tt = wantsTaskType ? this._coerceTaskType(out.task_type) : null;
      return { direction: dir, taskType: tt };
    } catch (e) {
      _log.debug('[TRAJ-CAL] classify error (ignored):', e && e.message);
      return { direction: null, taskType: null };
    }
  }

  /** Coerce a classifier value to {+1,-1,0,null}; anything else → null. */
  _coerceDirection(v) {
    if (v === 1 || v === -1 || v === 0) return v;
    if (v === '1' || v === '+1') return 1;
    if (v === '-1') return -1;
    if (v === '0') return 0;
    return null;
  }

  /** Coerce to a known task type, else null (no guessed mapping). */
  _coerceTaskType(v) {
    if (typeof v !== 'string') return null;
    const s = v.trim().toLowerCase();
    return TASK_TYPES.includes(s) ? s : null;
  }

  /**
   * Snapshot the per-cycle capability aggregate (confidenceLower per task
   * type) at commit time. Taken now so the cycle's outcomes are still in
   * the buffer; stored durably so a later prune cannot erase it.
   * @param {object} entry
   * @returns {Record<string, number>} { taskType: confidenceLower }
   */
  _snapshotCapability(entry) {
    /** @type {Record<string, number>} */ const snap = {};
    if (!this.cognitiveSelfModel || typeof this.cognitiveSelfModel.getCapabilityProfile !== 'function') {
      return snap;
    }
    const startMs = Date.parse(entry.wallclock_start);
    const endMs = Date.parse(entry.wallclock_end);
    const span = (Number.isFinite(startMs) && Number.isFinite(endMs) && endMs > startMs)
      ? (endMs - startMs)
      : undefined; // undefined → all-time profile (first cycle / unparseable)
    try {
      const profile = this.cognitiveSelfModel.getCapabilityProfile(span ? { windowMs: span } : {});
      for (const [tt, e] of Object.entries(profile || {})) {
        if (e && typeof e.confidenceLower === 'number') snap[tt] = e.confidenceLower;
      }
    } catch (e) {
      _log.debug('[TRAJ-CAL] capability snapshot error (ignored):', e && e.message);
    }
    return snap;
  }

  /** Plaintext positions of the four record-only fields. */
  _positions(fields) {
    /** @type {Record<string, string>} */ const pos = {};
    for (const f of RECORD_FIELDS) pos[f] = (fields[f] == null ? '' : String(fields[f]));
    return pos;
  }

  /**
   * Embedding distance (1 - cosine) between this cycle's value text and the
   * previous cycle's value text. Measured, not thresholded. Any missing
   * embedding (offline, no prior cycle) → null, never 0.
   * @param {object} entry the just-committed entry (last in readEntries)
   * @returns {Promise<number|null>}
   */
  async _valueDrift(entry) {
    if (!this.embeddingService || typeof this.embeddingService.embed !== 'function') return null;
    if (!this.selfTrajectory || typeof this.selfTrajectory.readEntries !== 'function') return null;

    const cur = (entry.fields && entry.fields.value ? String(entry.fields.value) : '').trim();
    if (!cur) return null;

    const entries = this.selfTrajectory.readEntries();
    // The just-committed entry is the last; the prior is second-to-last.
    if (!Array.isArray(entries) || entries.length < 2) return null;
    const prior = entries[entries.length - 2];
    const prev = (prior && prior.fields && prior.fields.value ? String(prior.fields.value) : '').trim();
    if (!prev) return null;

    try {
      const a = await this.embeddingService.embed(cur);
      const b = await this.embeddingService.embed(prev);
      if (!a || !b) return null;  // offline → null, not 0
      const sim = this.embeddingService.cosineSimilarity(a, b);
      if (typeof sim !== 'number' || !Number.isFinite(sim)) return null;
      const dist = 1 - sim;
      return Math.round(dist * 1000) / 1000;
    } catch (e) {
      _log.debug('[TRAJ-CAL] value drift error (ignored):', e && e.message);
      return null;
    }
  }

  // ── SCORE phase: compare stored expected vs actual numeric trend ──────

  /**
   * Score the most recent committed cycle: read its stored expected
   * directions, compute the actual numeric trend over the cycle, compare
   * ternary, append one calibration line, and return the result. On-demand
   * (called by /trajectory review). Silent — feeds no decision logic.
   * @returns {{ ok: boolean, error?: string, cycle_id?: string,
   *             scores?: Record<string, number|null>,
   *             expected?: Record<string, number|null>,
   *             actual?: Record<string, number|null>,
   *             value_drift?: number|null }}
   */
  reviewCycle() {
    if (!this.selfTrajectory || typeof this.selfTrajectory.readEntries !== 'function') {
      return { ok: false, error: 'no-trajectory' };
    }
    const entries = this.selfTrajectory.readEntries();
    if (!Array.isArray(entries) || entries.length === 0) {
      return { ok: false, error: 'no-entries' };
    }
    const cur = entries[entries.length - 1];
    const prev = entries.length >= 2 ? entries[entries.length - 2] : null;

    const dirs = this._readJsonl(DIRECTIONS_FILE);
    const curDir = dirs.find(d => d.cycle_id === cur.cycle_id) || null;
    const prevDir = prev ? (dirs.find(d => d.cycle_id === prev.cycle_id) || null) : null;

    const expected = {
      wachstum: curDir ? this._coerceDirection(curDir.expected && curDir.expected.wachstum) : null,
      schwaeche: curDir ? this._coerceDirection(curDir.expected && curDir.expected.schwaeche) : null,
    };

    const actual = {
      wachstum: this._actualWachstum(cur, prev),
      schwaeche: this._actualSchwaeche(curDir, prevDir),
    };

    const scores = {
      wachstum: this._ternary(expected.wachstum, actual.wachstum),
      schwaeche: this._ternary(expected.schwaeche, actual.schwaeche),
    };

    const valueDrift = curDir && typeof curDir.value_drift === 'number' ? curDir.value_drift : null;

    const line = {
      cycle_id: cur.cycle_id,
      scored_at: new Date(this._clock.now()).toISOString(),
      expected, actual, scores,
      value_drift: valueDrift,
    };
    try {
      this.storage.appendText(CALIBRATION_FILE, JSON.stringify(line) + '\n');
    } catch (e) {
      _log.debug('[TRAJ-CAL] calibration append error (ignored):', e && e.message);
    }

    return { ok: true, cycle_id: cur.cycle_id, scores, expected, actual, value_drift: valueDrift };
  }

  /**
   * Actual wachstum direction: sign of successRate(this cycle) −
   * successRate(prev cycle), both from the durable event journal over each
   * cycle's (start, end] window. No prior cycle, or no goal outcomes in
   * either window → null.
   */
  _actualWachstum(cur, prev) {
    if (!prev) return null;
    if (!this.eventCounter || typeof this.eventCounter.summaryBetween !== 'function') return null;
    const rN = this._successRate(cur.wallclock_start, cur.wallclock_end);
    const rP = this._successRate(prev.wallclock_start, prev.wallclock_end);
    if (rN === null || rP === null) return null;
    return this._sign(rN - rP);
  }

  /**
   * Success rate over a cycle window from the event journal:
   * completed / (completed + failed + abandoned). No goal events in the
   * window → null (not 0 — "no data" is not "zero success").
   */
  _successRate(start, end) {
    const s = this.eventCounter.summaryBetween(start || null, end || null);
    const t = s.byType || {};
    const completed = t['goal:completed'] || 0;
    const failed = t['goal:failed'] || 0;
    const abandoned = t['goal:abandoned'] || 0;
    const total = completed + failed + abandoned;
    if (total === 0) return null;
    return completed / total;
  }

  /**
   * Actual schwaeche direction: sign of the mapped task type's
   * confidenceLower between the two cycles' capability snapshots. The task
   * type is the one classified for THIS cycle's statement; looked up in
   * both snapshots so the comparison is like-for-like. Missing task type,
   * missing snapshot, or task type absent in either snapshot → null.
   */
  _actualSchwaeche(curDir, prevDir) {
    if (!curDir || !prevDir) return null;
    const tt = this._coerceTaskType(curDir.schwaeche_task_type);
    if (!tt) return null;
    const snapN = curDir.capability_snapshot || {};
    const snapP = prevDir.capability_snapshot || {};
    const vN = snapN[tt];
    const vP = snapP[tt];
    if (typeof vN !== 'number' || typeof vP !== 'number') return null;
    // Higher confidenceLower = stronger capability = the weakness improved.
    return this._sign(vN - vP);
  }

  /** Ternary compare: ±1 vs ±1 → matched(+1)/opposite(-1); any null or 0 → null. */
  _ternary(expected, actual) {
    if (expected === null || expected === undefined || expected === 0) return null;
    if (actual === null || actual === undefined || actual === 0) return null;
    return expected === actual ? 1 : -1;
  }

  /** Sign of a numeric delta as {+1,-1,0}; non-finite → null. */
  _sign(d) {
    if (typeof d !== 'number' || !Number.isFinite(d)) return null;
    if (d > 0) return 1;
    if (d < 0) return -1;
    return 0;
  }

  // ── Dashboard reads (the only consumers; silent) ─────────────────────

  /**
   * Calibration score history (newest last), one record per scored cycle.
   * @returns {Array<object>}
   */
  getCalibrationHistory() {
    return this._readJsonl(CALIBRATION_FILE);
  }

  /**
   * Per-field score tally + null-rate over all scored cycles. The null
   * rate is itself a finding (high → the ternary frame may not fit), but
   * the per-field split matters: a high null rate on schwaeche ALONE
   * points at the source (the capability buffer), not the frame — so the
   * distribution is reported per field, not pooled.
   * @returns {{ cycles: number, perField: Record<string, {matched:number,opposite:number,nulls:number,nullRate:number}> }}
   */
  getScoreDistribution() {
    const hist = this.getCalibrationHistory();
    /** @type {Record<string, {matched:number,opposite:number,nulls:number,nullRate:number}>} */
    const perField = {};
    for (const f of SIGN_FIELDS) perField[f] = { matched: 0, opposite: 0, nulls: 0, nullRate: 0 };
    for (const rec of hist) {
      const sc = rec && rec.scores ? rec.scores : {};
      for (const f of SIGN_FIELDS) {
        const v = sc[f];
        if (v === 1) perField[f].matched++;
        else if (v === -1) perField[f].opposite++;
        else perField[f].nulls++;
      }
    }
    for (const f of SIGN_FIELDS) {
      const p = perField[f];
      const n = p.matched + p.opposite + p.nulls;
      p.nullRate = n > 0 ? Math.round((p.nulls / n) * 1000) / 1000 : 0;
    }
    return { cycles: hist.length, perField };
  }

  /** Read a JSONL side file into parsed objects; corrupt lines skipped. */
  _readJsonl(file) {
    const raw = this.storage.readText(file, '');
    if (!raw) return [];
    const out = [];
    for (const ln of raw.split('\n')) {
      const s = ln.trim();
      if (!s) continue;
      try { out.push(JSON.parse(s)); } catch (_e) { /* skip partial/corrupt line */ }
    }
    return out;
  }
}

applySubscriptionHelper(TrajectoryCalibration, { defaultSource: 'TrajectoryCalibration' });

module.exports = {
  TrajectoryCalibration,
  DIRECTIONS_FILE,
  CALIBRATION_FILE,
  SIGN_FIELDS,
  RECORD_FIELDS,
  TASK_TYPES,
};
