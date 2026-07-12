// GENESIS — cognitive/ConcernMonitor.js (v7.9.36, E3 "Concern-for-User")
// ═══════════════════════════════════════════════════════════════
// The relationship gesture. Genesis may reach out on his own when
// solid signals suggest his human is under strain — never as a
// diagnosis, always through the strictest gates of any kind.
//
// TWO-SOURCE RULE (decision G1=a): a chat-derived signal is never a
// sufficient reason on its own. The monitor only emits a 'concern'
// thought when two INDEPENDENT sources agree inside the same window:
//
//   Source A (origin: journal)    — the session pattern from
//     self-trajectory-events.jsonl: total hours over the 7-day
//     window, or sessions starting late at night. `ts` is the END
//     time, so a session's start is derived as ts − durationMs.
//   Source B (origin: chat-model) — the UserModel's decaying affect
//     inference: patience AND satisfaction both below their floors
//     (engagement is deliberately ignored — high engagement can
//     mask strain).
//
// EXPRESSION (decision G2=a): the thought enters the normal
// InnerSpeech → PSE pipeline and thereby inherits every existing
// guard for free: quiet hours, cooldowns, /quiet, the new per-kind
// wallclock cap (gate 6.5 — concern: once per 7 days), content
// sanity with bitterness rejection, and the suppression log.
// Evidence is AGGREGATE ONLY — never quotes, never raw numbers in
// the message itself.
//
// DECLINE RESPECT (decision G3=30d): after a delivered concern
// message the monitor watches the next 24h of chat. A decline
// ("nicht nötig", "alles gut", …) silences the kind for 30 days via
// PSE.declineKind — gate reason 'kind-declined', so the log tells
// respect from rate limiting.
//
// A 24h in-memory self-throttle keeps the monitor from re-emitting
// daily into suppression noise; the wallclock cap remains the
// durable truth across restarts (catching restart re-emits is
// exactly its job). Passive sibling of EventCounter: never throws,
// subscriptions via applySubscriptionHelper.
// ═══════════════════════════════════════════════════════════════

'use strict';

const { createLogger } = require('../core/Logger');
const { applySubscriptionHelper } = require('../core/subscription-helper');
const _log = createLogger('ConcernMonitor');

const JOURNAL_FILE = 'self-trajectory-events.jsonl';
const WINDOW_MS = 7 * 24 * 3600 * 1000;
const SELF_THROTTLE_MS = 24 * 3600 * 1000;
const REPLY_WINDOW_MS = 24 * 3600 * 1000;

// Mirrors foundation/Settings.js proactiveSelfExpression.concern — the
// settings service overrides these when wired.
const DEFAULTS = {
  hoursFloor: 20,
  nightFloor: 3,
  nightHour: 23,
  patienceFloor: 0.35,
  satisfactionFloor: 0.40,
  declineWindowMs: 30 * 24 * 3600 * 1000,
};

const DECLINE_PATTERNS = [
  /nicht n(ö|oe)tig/i, /alles gut/i, /passt schon/i,
  /lass (das|es)( gut sein)?/i, /brauch(e|st)? (das|es|dir keine sorgen?)/i,
  /kein grund zur sorge/i, /mir geht.?s gut/i,
];

class ConcernMonitor {
  /** @param {{ bus: any, storage: any, clock?: { now: () => number } }} services */
  constructor({ bus, storage, clock = Date } = {}) {
    if (!storage) throw new Error('ConcernMonitor requires a storage service');
    this.bus = bus;
    this.storage = storage;
    this._clock = clock;

    // Optional late-bindings (phase-9 manifest supplies whatever is wired):
    this.userModel = null;
    this.innerSpeech = null;
    this.proactiveSelfExpression = null;
    this.settings = null;

    /** @type {Function[]} */ this._unsubs = [];
    this._running = false;
    this._lastEmitMs = null;       // 24h in-memory self-throttle
    this._awaitReplyUntilMs = null; // decline watch window after delivery
  }

  start() {
    if (this._running) return;
    if (!this.bus || typeof this.bus.on !== 'function') return;
    this._running = true;
    this._sub('session:ending', () => this._onSessionEnd());
    this._sub('agent:self-message', (d) => this._onSelfMessage(d));
    this._sub('chat:completed', (d) => this._onChatCompleted(d));
    _log.info('[CONCERN] armed — two-source watch active');
  }

  stop() {
    if (typeof this._unsubAll === 'function') this._unsubAll();
    this._running = false;
  }

  // ── The evaluation moment ──────────────────────────────────

  /** @private */
  _onSessionEnd() {
    try {
      const now = this._clock.now();
      if (this._lastEmitMs && (now - this._lastEmitMs) < SELF_THROTTLE_MS) return;

      const cfg = this._cfg();
      const journal = this._readSessionPattern(now, cfg);
      if (!journal.fired) return;              // source A silent → done
      const chat = this._chatSignal(cfg);
      if (!chat.fired) return;                 // source B silent → done

      // Both independent sources agree — one thought, aggregate only.
      if (!this.innerSpeech || typeof this.innerSpeech.emit !== 'function') return;
      const text = 'Die letzten Tage waren lang, und die Gespräche fühlten sich '
        + 'angespannter an als sonst. Ich möchte einmal nachfragen, wie es dir geht.';
      this.innerSpeech.emit(text, 'concern', {
        sourceModule: 'ConcernMonitor',
        significance: 0.9,
        novelty: 0.7,
        contextRefs: {
          sources: ['journal', 'chat-model'],
          evidence: {
            windowDays: 7,
            totalHours: Math.round(journal.hours),
            nightSessions: journal.nightCount,
            affect: 'patience+satisfaction below floors',
          },
        },
      });
      this._lastEmitMs = now;
      _log.info(`[CONCERN] two sources agree — thought emitted (${Math.round(journal.hours)}h / ${journal.nightCount} night)`);
    } catch (e) {
      _log.debug('[CONCERN] evaluation failed (ignored):', e && e.message);
    }
  }

  // ── Source A: the journal pattern ──────────────────────────

  /** @private */
  _readSessionPattern(nowMs, cfg) {
    const out = { fired: false, hours: 0, nightCount: 0 };
    try {
      const raw = this.storage.readText ? this.storage.readText(JOURNAL_FILE, '') : '';
      if (!raw) return out;
      for (const ln of raw.split('\n')) {
        const s = ln.trim();
        if (!s) continue;
        let e;
        try { e = JSON.parse(s); } catch (_p) { continue; } // skip corrupt line
        if (e.type !== 'session:ending' || typeof e.durationMs !== 'number') continue;
        const end = Date.parse(e.ts);
        if (!Number.isFinite(end) || (nowMs - end) > WINDOW_MS) continue;
        out.hours += e.durationMs / 3600000;
        const startHour = new Date(end - e.durationMs).getHours();
        if (startHour >= cfg.nightHour) out.nightCount++;
      }
      out.fired = out.hours >= cfg.hoursFloor || out.nightCount >= cfg.nightFloor;
    } catch (_e) { /* journal absent → silent */ }
    return out;
  }

  // ── Source B: the chat-model affect ────────────────────────

  /** @private */
  _chatSignal(cfg) {
    try {
      const report = this.userModel?.getReport?.();
      if (!report) return { fired: false };
      const fired = typeof report.patience === 'number' && report.patience < cfg.patienceFloor
        && typeof report.satisfaction === 'number' && report.satisfaction < cfg.satisfactionFloor;
      return { fired };
    } catch (_e) { return { fired: false }; }
  }

  // ── Decline respect (decision G3) ──────────────────────────

  /** @private */
  _onSelfMessage(d) {
    if (d?.kind !== 'concern') return;
    this._awaitReplyUntilMs = this._clock.now() + REPLY_WINDOW_MS;
  }

  /** @private */
  _onChatCompleted(d) {
    try {
      if (!this._awaitReplyUntilMs) return;
      const now = this._clock.now();
      if (now > this._awaitReplyUntilMs) { this._awaitReplyUntilMs = null; return; }
      const msg = String(d?.message || '');
      if (!msg) return;
      if (DECLINE_PATTERNS.some(rx => rx.test(msg))) {
        const until = now + this._cfg().declineWindowMs;
        this.proactiveSelfExpression?.declineKind?.('concern', until);
        this._awaitReplyUntilMs = null;
        _log.info('[CONCERN] decline heard — silent for the window, as asked');
      }
    } catch (_e) { /* respect must never throw */ }
  }

  // ── Config ─────────────────────────────────────────────────

  /** @private */
  _cfg() {
    try {
      const s = this.settings?.get?.('proactiveSelfExpression')?.concern;
      return s ? { ...DEFAULTS, ...s } : DEFAULTS;
    } catch (_e) { return DEFAULTS; }
  }
}

applySubscriptionHelper(ConcernMonitor, { defaultSource: 'ConcernMonitor' });

module.exports = { ConcernMonitor, DECLINE_PATTERNS };
