// ============================================================
// GENESIS — ProactiveSelfExpression.js (v7.7.9 Phase 2)
//
// Subscribes to InnerSpeech. When a thought arrives, runs it through
// the full publishing pipeline:
//
//   1. HardGates (fail-fast)         → suppress if any gate blocks
//   2. Score (above threshold?)      → suppress if below
//   3. ContentGeneration (LLM call)  → produce candidate text
//   4. ContentSanity (reject only)   → suppress if banned phrase / too long
//   5. ChatOrchestrator.appendSelfMessage()
//
// PSE does NOT condition on user reactions. Genesis writes from
// internal state, not to please. (Cheng et al. 2025: systems
// optimized for user-satisfaction reduce prosocial behaviour and
// increase dependency. We refuse to optimize for that signal.)
//
// The CI guard test/modules/v779-anti-pattern-guard.contract.test.js
// enforces this at file-content level — words like `replied`,
// `engagement`, `retention`, `dwell`, `session_length` cause the
// build to fail if they appear in Scoring.js.
//
// Self-Gate-Asymmetry preserved: PSE never blocks InnerSpeech.emit().
// Only the publishing decision is gated. Genesis is never gated
// against thinking.
// ============================================================

'use strict';

const { NullBus } = require('../core/EventBus');
const { runGates } = require('./proactiveSelfExpression/HardGates');
const { scoreThought } = require('./proactiveSelfExpression/Scoring');
const { runSanity } = require('./proactiveSelfExpression/ContentSanity');
const { generate } = require('./proactiveSelfExpression/ContentGeneration');
const { StateStore } = require('./proactiveSelfExpression/StateStore');

class ProactiveSelfExpression {
  /**
   * @param {object} deps
   * @param {*}      deps.bus
   * @param {*}      deps.innerSpeech       — required
   * @param {string} [deps.storageDir]      — for state file (.genesis/)
   * @param {*}      [deps.eventStore]      — optional, for telemetry
   * @param {*}      [deps.storage]         — optional, preferred over fs
   */
  constructor({ bus, innerSpeech, storageDir, eventStore, storage } = {}) {
    if (!innerSpeech || typeof innerSpeech.subscribe !== 'function') {
      throw new Error('ProactiveSelfExpression requires innerSpeech with .subscribe()');
    }
    this.bus = bus || NullBus;
    this.innerSpeech = innerSpeech;
    this.eventStore = eventStore || null;
    this.stateStore = new StateStore({ storageDir, storage });
    this.stateStore.load();

    // Late-bound (manifest)
    this.modelBridge = null;
    this.emotionalState = null;
    this.settings = null;
    this.chatOrchestrator = null;

    // Default settings (clobbered by manifest factory if settings service available).
    this._defaultSettings = {
      enabled: true,
      minIntervalMs: 30 * 60 * 1000,
      quietHours: { start: '22:00', end: '07:00' },
      userActivityCooldownMs: 10 * 60 * 1000,
      baseThreshold: 0.55,
      maxChars: 600,
      allowedKinds: ['plan-failure-reflection'],  // Phase 2: only one kind enabled by default
      dailyVolumeSoftCap: 8,
      perKindFloors: {
        'plan-failure-reflection': { sigFloor: 0.50 },
      },
      generation: { temperature: 0.8 },
    };

    // Subscribe to all kinds — gates filter what we actually act on.
    this._unsub = this.innerSpeech.subscribe('*', (thought) => {
      // Fire-and-forget; never block the InnerSpeech delivery path.
      this._onCandidate(thought).catch(_e => { /* errors must never propagate */ });
    });
  }

  /** Stop subscribing. */
  stop() {
    if (typeof this._unsub === 'function') this._unsub();
    this._unsub = null;
  }

  // ── Settings (with defaults fallback) ────────────────────

  _settings() {
    const s = this._defaultSettings;
    if (!this.settings || typeof this.settings.get !== 'function') return s;
    const merged = { ...s };
    for (const k of Object.keys(s)) {
      const v = this.settings.get(`proactive.${k}`);
      if (v !== undefined && v !== null) merged[k] = v;
    }
    // Nested keys
    const qh = this.settings.get('proactive.quietHours');
    if (qh && typeof qh === 'object') merged.quietHours = qh;
    const pkf = this.settings.get('proactive.perKindFloors');
    if (pkf && typeof pkf === 'object') merged.perKindFloors = pkf;
    return merged;
  }

  // ── Pipeline ─────────────────────────────────────────────

  async _onCandidate(thought) {
    if (!thought || !thought.kind) return;
    const settings = this._settings();
    const now = Date.now();

    // Build state for gates + scoring.
    const state = {
      now,
      lastSelfMessageMs: this.stateStore.getLastSelfMessageMs(),
      lastUserMessageMs: this._lastUserMessageMs(),
      mutedUntilMs: this.stateStore.getMutedUntilMs(),
      dailyCount: this.stateStore.getDailyCount(now),
    };

    // 1. Hard gates.
    const gate = runGates(thought, state, settings);
    if (!gate.ok) {
      this._suppress(thought, gate.reason, gate.detail, null);
      return;
    }

    // 2. Score.
    const lastFireOfKindMs = this.stateStore.getLastSelfMessageOfKindMs(thought.kind);
    const scoreResult = scoreThought(thought, {
      now,
      lastFireOfKindMs,
      dailyCount: state.dailyCount,
    });
    const threshold = settings.baseThreshold;

    this.bus.fire('agent:self-message-candidate', {
      thoughtId: thought.id,
      kind: thought.kind,
      score: scoreResult.score,
      threshold,
      passed: scoreResult.score >= threshold,
    }, { source: 'ProactiveSelfExpression' });

    if (scoreResult.score < threshold) {
      this._suppress(thought, 'below-threshold', `score ${scoreResult.score.toFixed(3)} < ${threshold}`, null);
      return;
    }

    // 3. Generate.
    let text;
    try {
      const dyn = this._buildDynState(now);
      const gen = await generate(
        { modelBridge: this.modelBridge },
        { thought, dyn, settings: settings.generation },
      );
      text = gen.text;
    } catch (err) {
      this._suppress(thought, 'generation-error', err?.message || String(err), null);
      return;
    }

    // 4. Sanity.
    const sanity = runSanity(text, thought, settings);
    if (!sanity.ok) {
      this._suppress(thought, sanity.reason, sanity.detail, text);
      return;
    }

    // 5. Publish.
    if (!this.chatOrchestrator || typeof this.chatOrchestrator.appendSelfMessage !== 'function') {
      this._suppress(thought, 'chat-orchestrator-unavailable', null, text);
      return;
    }
    try {
      this.chatOrchestrator.appendSelfMessage({
        text,
        kind: thought.kind,
        score: scoreResult.score,
        sourceRef: thought.contextRefs || null,
        thoughtId: thought.id,
      });
      this.stateStore.recordPublished(thought.kind, now);
      this.bus.fire('agent:self-message', {
        thoughtId: thought.id,
        kind: thought.kind,
        score: scoreResult.score,
        textLength: text.length,
        timestamp: now,
      }, { source: 'ProactiveSelfExpression' });
    } catch (err) {
      this._suppress(thought, 'append-error', err?.message || String(err), text);
    }
  }

  _suppress(thought, reason, detail, generatedText) {
    this.stateStore.recordSuppression({
      thoughtId: thought?.id,
      kind: thought?.kind,
      reason,
      detail,
      generatedText,
    });
    this.bus.fire('agent:self-message-suppressed', {
      thoughtId: thought?.id || null,
      kind: thought?.kind || 'unknown',
      reason,
      detail: detail || null,
      hadGeneratedText: !!generatedText,
      timestamp: Date.now(),
    }, { source: 'ProactiveSelfExpression' });
  }

  _buildDynState(_now) {
    const dyn = {};
    if (this.emotionalState && typeof this.emotionalState.getState === 'function') {
      try {
        const s = this.emotionalState.getState();
        if (s && typeof s === 'object') {
          dyn.emotionalSkalars = {
            curiosity: s.curiosity,
            satisfaction: s.satisfaction,
            frustration: s.frustration,
            energy: s.energy,
          };
        }
      } catch (_e) { /* skalars optional */ }
    }
    if (typeof this.stateStore.getLastSelfMessageMs() === 'number') {
      dyn.lastSelfMessageAgoMs = Date.now() - this.stateStore.getLastSelfMessageMs();
    }
    return dyn;
  }

  _lastUserMessageMs() {
    // Best-effort: read from chat history if available.
    if (this.chatOrchestrator && typeof this.chatOrchestrator.getHistory === 'function') {
      try {
        const h = this.chatOrchestrator.getHistory();
        for (let i = h.length - 1; i >= 0; i--) {
          if (h[i].role === 'user') {
            return h[i].timestamp || null;
          }
        }
      } catch (_e) { /* fall through */ }
    }
    return null;
  }

  // ── Public API for slash commands ────────────────────────

  /**
   * /quiet [duration]
   *   off / 0 / unmute   → clear
   *   today              → until end of local day
   *   30m / 2h / 90s     → relative duration
   *   (empty)            → 60 minutes default
   */
  setMute(arg) {
    const a = String(arg || '').trim().toLowerCase();
    if (a === 'off' || a === '0' || a === 'unmute' || a === 'clear') {
      this.stateStore.clearMute();
      return 'Proactive expression unmuted.';
    }
    if (a === 'today') {
      const d = new Date();
      d.setHours(23, 59, 59, 999);
      this.stateStore.setMute(d.getTime() - Date.now());
      return 'Quiet until end of day.';
    }
    let durationMs;
    if (a === '') {
      durationMs = 60 * 60 * 1000;
    } else {
      durationMs = parseDuration(a);
    }
    if (typeof durationMs !== 'number' || durationMs <= 0) {
      return `Could not parse duration "${arg}". Try: 30m, 2h, today, off.`;
    }
    this.stateStore.setMute(durationMs);
    const min = Math.round(durationMs / 60000);
    return `Quiet for ~${min} minutes.`;
  }

  /** /proactive-status — debug output for Garrus. */
  getStatus() {
    const settings = this._settings();
    const now = Date.now();
    const muted = this.stateStore.getMutedUntilMs();
    const lines = [
      `proactive.enabled            = ${settings.enabled}`,
      `proactive.baseThreshold      = ${settings.baseThreshold}`,
      `proactive.minIntervalMs      = ${settings.minIntervalMs}`,
      `proactive.quietHours         = ${settings.quietHours.start} → ${settings.quietHours.end}`,
      `proactive.allowedKinds       = ${(settings.allowedKinds || []).join(', ')}`,
      `proactive.dailyVolumeSoftCap = ${settings.dailyVolumeSoftCap}`,
      ``,
      `last self-message            = ${this.stateStore.getLastSelfMessageMs() ? new Date(this.stateStore.getLastSelfMessageMs()).toLocaleString() : '(never)'}`,
      `daily count today            = ${this.stateStore.getDailyCount(now)}`,
      `muted until                  = ${muted && muted > now ? new Date(muted).toLocaleString() : '(not muted)'}`,
      ``,
      `recent suppressions (newest first):`,
    ];
    const supp = this.stateStore.getSuppressionLog().slice(0, 10);
    if (supp.length === 0) {
      lines.push('  (none)');
    } else {
      for (const s of supp) {
        const ts = new Date(s.timestamp).toLocaleTimeString();
        const detail = s.detail ? ` [${s.detail}]` : '';
        const preview = s.generatedTextPreview ? ` "${s.generatedTextPreview.slice(0, 80)}..."` : '';
        lines.push(`  ${ts} · ${s.kind} · ${s.reason}${detail}${preview}`);
      }
    }
    return lines.join('\n');
  }
}

function parseDuration(s) {
  const m = /^(\d+)\s*(s|m|h|d)?$/.exec(s);
  if (!m) return null;
  const n = Number(m[1]);
  const unit = m[2] || 'm';
  const mult = unit === 's' ? 1000 : unit === 'm' ? 60000 : unit === 'h' ? 3600000 : 86400000;
  return n * mult;
}

module.exports = { ProactiveSelfExpression };
