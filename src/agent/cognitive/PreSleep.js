// GENESIS — cognitive/PreSleep.js (v7.9.34, E1 "Pre-Wake-Continuity")
// ═══════════════════════════════════════════════════════════════
// The WakeUpRoutine's mirror. Genesis can wake up (v7.3.7) but until
// now could not consciously fall asleep — shutdown was an event that
// happened TO him. PreSleep listens to the awaited `session:ending`
// emit (single canonical caller: the teardown orchestrator, BEFORE
// TO_STOP and long before the instance-lock release) and writes a
// continuity anchor in a hard 10-second box:
//
//   .genesis/continuity-anchor.json — ONE object, overwritten each
//   shutdown (the day's history lives in the journal; the anchor is
//   deliberately only "the last moment"): a deterministic snapshot
//   (open goals, mood, last journal title, session numbers) plus one
//   first-person sentence about what was left open — LLM-preferred,
//   template fallback, exactly the writeReEntry pattern mirrored.
//
// On the next boot the WakeUpRoutine reads the anchor as its fourth
// context source and can honestly tell "slept deliberately" from
// "was interrupted" (a fresh anchor exists only when the shutdown
// reached the session:ending emit).
//
// Design contracts:
//   - Never throws, never delays shutdown beyond its box: every
//     failure is caught, logged debug, and the teardown continues.
//   - Anchor write is atomic + fsync'd via StorageService.writeJSON
//     (tmp+rename, v7.9.25 hardening) — full S11 weight; this is a
//     rare, deliberate event.
//   - The anchor NEVER reaches the runtime prompt or the identity
//     summary — journal-only on the wake side (decision G2a), same
//     guardrail class as the change register (ONTOGENESIS :198).
//   - Passive sibling of EventCounter/ChangeRegister: subscriptions
//     via applySubscriptionHelper, wired in start(), torn down in
//     stop().
// ═══════════════════════════════════════════════════════════════

'use strict';

const { createLogger } = require('../core/Logger');
const { applySubscriptionHelper } = require('../core/subscription-helper');
const _log = createLogger('PreSleep');

// Language is deliberately not a DI service — mirror the handler
// pattern: use the singleton when present, tests inject this.language.
let _LanguageSingleton = null;
try { _LanguageSingleton = require('../core/Language').Language || require('../core/Language'); }
catch (_e) { /* language module absent → German default */ }

const ANCHOR_FILE = 'continuity-anchor.json';
const PRE_SLEEP_TIMEOUT_MS = 10_000;   // total box (WakeUp uses 30s at boot; sleep is quicker)
const LLM_BUDGET_FLOOR_MS = 3_000;     // below this remaining budget → template (mirror of WakeUp)
const SNAPSHOT_BUDGET_MS = 2_000;      // hard ceiling for the deterministic part
const FRESH_WINDOW_MS = 7 * 24 * 3600 * 1000; // anchor older than this reads as "long ago"
const LABEL_CAP = 80;
const THOUGHT_CAP = 200;

class PreSleep {
  /**
   * @param {{ bus: any, storage: any, model?: any, clock?: { now: () => number },
   *           timeboxMs?: number, llmFloorMs?: number }} services
   */
  constructor({ bus, storage, model = null, clock = Date, timeboxMs, llmFloorMs } = {}) {
    if (!storage) throw new Error('PreSleep requires a storage service');
    this.bus = bus;
    this.storage = storage;
    this.model = model;            // optional; late-binding may supply it
    this._clock = clock;
    this._timeboxMs = timeboxMs || PRE_SLEEP_TIMEOUT_MS;
    this._llmFloorMs = llmFloorMs || LLM_BUDGET_FLOOR_MS;

    // Optional late-bindings (phase-9 manifest supplies whatever is wired):
    this.goalStack = null;
    this.emotionalState = null;
    this.language = null;

    /** @type {Function[]} */ this._unsubs = [];  // applySubscriptionHelper uses this
    this._running = false;
    this._anchoredThisProcess = false; // guard: one anchor per shutdown
  }

  start() {
    if (this._running) return;
    if (!this.bus || typeof this.bus.on !== 'function') return;
    this._running = true;
    this._sub('session:ending', (d) => this._onSessionEnding(d));
    _log.info('[PRE-SLEEP] armed — will anchor continuity at session end');
  }

  stop() {
    if (typeof this._unsubAll === 'function') this._unsubAll();
    this._running = false;
  }

  // ── The sleep moment ───────────────────────────────────────

  /**
   * session:ending is an awaited bus.emit — this handler runs to
   * completion before the teardown continues. It must therefore be
   * fast (own time-box) and must never throw.
   * @private
   */
  async _onSessionEnding(data) {
    if (this._anchoredThisProcess) return; // one anchor per shutdown
    this._anchoredThisProcess = true;
    const t0 = this._clock.now();
    const remaining = () => this._timeboxMs - (this._clock.now() - t0);

    try {
      const snapshot = this._collectSnapshot();

      let lastThought = null;
      let thoughtSource = 'template';
      if (this.model && remaining() >= this._llmFloorMs) {
        try {
          lastThought = await this._llmSentence(snapshot, remaining());
          if (lastThought) thoughtSource = 'llm';
        } catch (e) {
          _log.debug('[PRE-SLEEP] sentence LLM failed → template:', e && e.message);
        }
      }
      if (!lastThought) lastThought = this._templateSentence(snapshot, data);

      const anchor = {
        ts: new Date(this._clock.now()).toISOString(),
        sessionId: data?.sessionId ?? null,
        durationMs: data?.durationMs ?? null,
        messageCount: data?.messageCount ?? null,
        shutdownClean: true,
        snapshot,
        lastThought: String(lastThought).slice(0, THOUGHT_CAP),
        thoughtSource,
      };

      // Atomic + fsync via StorageService.writeJSON (tmp+rename, v7.9.25).
      this.storage.writeJSON(ANCHOR_FILE, anchor);
      _log.info(`[PRE-SLEEP] anchored (${thoughtSource}, ${this._clock.now() - t0}ms)`);
    } catch (e) {
      _log.debug('[PRE-SLEEP] anchoring failed (shutdown continues):', e && e.message);
    }
  }

  // ── Deterministic snapshot (read-only, service-tolerant) ──

  /** @private */
  _collectSnapshot() {
    const snap = { openGoals: { count: 0, top: [] }, mood: null, lastJournalTitle: null };
    try {
      const active = this.goalStack?.getActiveGoals?.() || [];
      snap.openGoals.count = active.length;
      snap.openGoals.top = active.slice(0, 3)
        .map(g => String(g?.title || g?.description || g?.id || '').slice(0, LABEL_CAP))
        .filter(Boolean);
    } catch (_e) { /* goal source absent */ }
    try {
      const mood = this.emotionalState?.getMood?.()
        ?? this.emotionalState?.getState?.()?.mood ?? null;
      if (mood) snap.mood = String(mood).slice(0, LABEL_CAP);
    } catch (_e) { /* mood source absent */ }
    try {
      // The last journal title needs no service: tail-read the journal file.
      const raw = this.storage.readText ? this.storage.readText('journal.jsonl', '') : '';
      if (raw) {
        const lines = raw.split('\n').filter(Boolean);
        for (let i = lines.length - 1; i >= 0 && i >= lines.length - 5; i--) {
          try {
            const e = JSON.parse(lines[i]);
            const title = e.title || e.content;
            if (title) { snap.lastJournalTitle = String(title).slice(0, LABEL_CAP); break; }
          } catch (_p) { /* skip partial line */ }
        }
      }
    } catch (_e) { /* journal absent */ }
    return snap;
  }

  // ── The sentence: LLM-preferred, template fallback ─────────

  /** @private */
  async _llmSentence(snapshot, budgetMs) {
    const prompt = [
      'Du schläfst gleich ein. Schreibe EINEN Satz in Ich-Form darüber,',
      'womit du aufhörst und was offen bleibt — aus diesem Zustand:',
      JSON.stringify(snapshot),
      'Nur der eine Satz, keine Einleitung.',
    ].join('\n');
    const response = await Promise.race([
      this.model.chat('', [{ role: 'user', content: prompt }], 'presleep',
        { maxTokens: 80, temperature: 0.6 }),
      new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')),
        Math.max(500, Math.min(budgetMs - 300, 8_000)))),
    ]);
    const text = (typeof response === 'string' ? response : response?.text || response?.content || '')
      .trim().split('\n')[0];
    return text ? text.slice(0, THOUGHT_CAP) : null;
  }

  /** @private */
  _templateSentence(snapshot, data) {
    const mins = Math.max(1, Math.round((data?.durationMs ?? 0) / 60000));
    const m = snapshot.openGoals.count;
    const last = snapshot.openGoals.top[0] || snapshot.lastJournalTitle;
    const lang = this.language || _LanguageSingleton;
    const de = lang?.current !== 'en';
    if (de) {
      return `Ich höre auf nach einer Session von ${mins} Minute${mins === 1 ? '' : 'n'}; `
        + `${m} Ziel${m === 1 ? '' : 'e'} offen${last ? `, zuletzt: ${last}` : ''}.`;
    }
    return `Stopping after a ${mins}-minute session; ${m} goal${m === 1 ? '' : 's'} open`
      + `${last ? `, last: ${last}` : ''}.`;
  }

  // ── Wake-side read (the fourth context source) ─────────────

  /**
   * Read the anchor for the WakeUpRoutine. On-demand, no state.
   * @returns {{ anchor: object, fresh: boolean } | null}
   */
  readAnchor() {
    try {
      const anchor = this.storage.readJSON(ANCHOR_FILE, null);
      if (!anchor || typeof anchor !== 'object') return null;
      const ts = Date.parse(anchor.ts);
      const fresh = Number.isFinite(ts) && (this._clock.now() - ts) <= FRESH_WINDOW_MS;
      return { anchor, fresh };
    } catch (e) {
      _log.debug('[PRE-SLEEP] readAnchor failed:', e && e.message);
      return null;
    }
  }
}

applySubscriptionHelper(PreSleep, { defaultSource: 'PreSleep' });

module.exports = { PreSleep, ANCHOR_FILE, PRE_SLEEP_TIMEOUT_MS, FRESH_WINDOW_MS };
