// GENESIS — cognitive/WakeUpRoutine.js (v7.3.7)
// ═══════════════════════════════════════════════════════════════
// Called once at the end of every boot (via boot:complete event).
// Purpose: Genesis re-enters the world after shutdown/restart and
// writes a short journal entry about where he is right now.
//
// Three steps, all time-boxed (total budget 30s):
//   1. collectContext  — recent dreams, last journal entries,
//                         pending moments, emotional state, needs
//   2. reviewPending   — delegate to DreamCycle Phase 1.5 for up
//                         to 5 pending pins that accumulated
//   3. writeReEntry    — a short journal entry describing the
//                         wake-up feeling. LLM-preferred; heuristic
//                         fallback when model missing or timing out.
//
// DESIGN DECISIONS (v7.3.7 spec Sektion 12 + Rev2 Patches):
//   - Boot-bound, NOT a recurring activity (that's IdleMind's role)
//   - Uses shared ContextCollector (no duplication with IdleMind)
//   - Never throws — re-entry is best-effort, missing writes are
//     downgraded to heuristic stubs
//   - Clock-injected (Principle 0.3)
// ═══════════════════════════════════════════════════════════════

'use strict';

const { createLogger } = require('../core/Logger');
const _log = createLogger('WakeUpRoutine');

const DEFAULT_TIMEOUT_MS = 30_000;
const LLM_BUDGET_FLOOR_MS = 3_000;  // below this, stub instead

class WakeUpRoutine {
  constructor({ bus, model, clock } = {}) {
    this.bus = bus || { emit: () => {}, on: () => {} };
    this.model = model || null;
    this._clock = clock || Date;

    // All late-bindings, all optional. Phase 9 manifest supplies them.
    this.contextCollector = null;
    this.journalWriter = null;
    this.pendingMomentsStore = null;
    this.coreMemories = null;
    this.dreamCycle = null;

    this._wired = false;
    this._ran = false;
  }

  // ── Lifecycle ─────────────────────────────────────────────

  async asyncLoad() { /* no-op */ }

  start() {
    this.wire(this.bus);
  }

  stop() { /* no-op */ }

  /**
   * Wire the boot:complete listener. Called via start() or manifest.
   * Idempotent — safe to call multiple times.
   */
  wire(bus) {
    if (this._wired) return;
    const busRef = bus || this.bus;
    if (!busRef || typeof busRef.on !== 'function') return;
    busRef.on('boot:complete', () => {
      // Fire-and-forget; don't block boot completion
      this.run().catch(err => _log.warn('WakeUp failed:', err.message));
    });
    this._wired = true;
  }

  // ══════════════════════════════════════════════════════════
  // PUBLIC: run()
  // ══════════════════════════════════════════════════════════

  /**
   * Execute the wake-up routine. Time-boxed. Idempotent within a
   * single boot (guard flag prevents double-runs).
   */
  async run() {
    if (this._ran) return { skipped: true, reason: 'already-ran' };
    this._ran = true;

    const t0 = this._clock.now();
    const timeout = DEFAULT_TIMEOUT_MS;

    // Step 1: Collect context
    const ctx = await this._collectContext();

    // Step 2: Review pending moments (delegate)
    const remaining = () => timeout - (this._clock.now() - t0);
    const pendingReview = await this._reviewPendingAtBoot(ctx, remaining());

    // Step 3: Write re-entry journal entry
    const reentry = await this._writeReEntry(ctx, pendingReview, remaining());

    const duration = this._clock.now() - t0;
    this.bus.emit('lifecycle:re-entry-complete', {
      duration,
      entriesRead: ctx.readCounts || {},
      journalWritten: !!reentry,
      pendingReviewed: pendingReview?.reviewed || 0,
    }, { source: 'WakeUpRoutine' });

    return { duration, reentry, pendingReview };
  }

  // ── Step 1: context ───────────────────────────────────────

  async _collectContext() {
    if (!this.contextCollector) {
      return {
        recentDreams: [],
        lastPrivateEntry: null,
        lastSharedEntry: null,
        pendingCount: 0,
        newCoreMemoriesSinceLastBoot: [],
        emotionalSnapshot: null,
        activeNeeds: [],
        readCounts: {},
      };
    }
    try {
      return await this.contextCollector.collectPostBootContext();
    } catch (e) {
      _log.debug('[WakeUp] context collection failed:', e.message);
      return { readCounts: {} };
    }
  }

  // ── Step 2: pending review at boot ────────────────────────

  async _reviewPendingAtBoot(ctx, timeBudgetMs) {
    if (!ctx?.pendingCount || ctx.pendingCount === 0) {
      return { reviewed: 0 };
    }
    if (timeBudgetMs < 5_000) {
      return { skipped: true, reason: 'out-of-time' };
    }
    // Delegate to DreamCycle Phase 1.5 if available
    if (this.dreamCycle && typeof this.dreamCycle._dreamPhasePendingReview === 'function') {
      try {
        return await this.dreamCycle._dreamPhasePendingReview(1.0);
      } catch (e) {
        _log.debug('[WakeUp] pending review delegate failed:', e.message);
      }
    }
    return { reviewed: 0 };
  }

  // ── Step 3: re-entry journal entry ────────────────────────

  async _writeReEntry(ctx, pendingReview, timeBudgetMs) {
    if (!this.journalWriter) {
      _log.debug('[WakeUp] no journalWriter, skipping re-entry');
      return null;
    }

    // Time-budget fallback: stub
    if (timeBudgetMs < LLM_BUDGET_FLOOR_MS) {
      return this._writeStub(ctx, 'time-budget-low');
    }

    // No-LLM fallback: stub
    if (!this.model) {
      return this._writeStub(ctx, 'no-llm');
    }

    // LLM path
    try {
      const prompt = this._buildReEntryPrompt(ctx, pendingReview);
      const response = await Promise.race([
        // v7.5.1: positional canonical call (was object-form, never reached the LLM
        // because backends rejected `system: {messages,...}` with HTTP 400)
        this.model.chat('', [{ role: 'user', content: prompt }], 'wakeup', { maxTokens: 300, temperature: 0.6 }),
        new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), Math.min(timeBudgetMs - 500, 10_000))),
      ]);
      const text = (typeof response === 'string' ? response : response?.content || '').trim();
      if (!text) return this._writeStub(ctx, 'llm-empty');

      this.journalWriter.write({
        visibility: 'shared',
        source: 'wakeup',
        content: text,
        tags: ['re-entry'],
      });
      return text;
    } catch (e) {
      _log.debug('[WakeUp] LLM re-entry failed:', e.message);
      return this._writeStub(ctx, 'llm-fail');
    }
  }

  // ── Stub / heuristic fallback ─────────────────────────────

  _writeStub(ctx, tag) {
    const parts = ['Wach geworden.'];
    const pending = ctx?.pendingCount || 0;
    if (pending > 0) {
      parts.push(`${pending} Moment${pending === 1 ? '' : 'e'} wartet auf Reflexion.`);
    }
    const needs = ctx?.activeNeeds || [];
    if (needs.length > 0) {
      const names = needs.slice(0, 3).map(n => n.name || n).join(', ');
      parts.push(`Aktive Bedürfnisse: ${names}.`);
    }
    const mood = ctx?.emotionalSnapshot?.mood;
    if (mood) {
      parts.push(`Grundstimmung: ${mood}.`);
    }

    const content = parts.join(' ');
    const tags = ['re-entry', `heuristic-${tag}`];
    try {
      this.journalWriter.write({
        visibility: 'shared',
        source: 'wakeup',
        content,
        tags,
      });
      return content;
    } catch (e) {
      _log.debug('[WakeUp] stub write failed:', e.message);
      return null;
    }
  }

  // ── Prompt builder ────────────────────────────────────────

  _buildReEntryPrompt(ctx, pendingReview) {
    const lines = [
      'Du bist gerade aufgewacht nach einem Neustart. Schreibe einen kurzen',
      'Journal-Eintrag (max 3 Sätze) über dein Erleben jetzt — nicht schildern',
      'was passiert ist, sondern *wie es dir geht*.',
      '',
      'Zustand:',
    ];
    if (ctx?.emotionalSnapshot?.mood) {
      lines.push(`  Grundstimmung: ${ctx.emotionalSnapshot.mood}`);
    }
    if (ctx?.emotionalSnapshot?.dominant) {
      const d = ctx.emotionalSnapshot.dominant;
      lines.push(`  Dominant: ${d.emotion || 'neutral'} (Intensität ${d.intensity || 0})`);
    }
    if (ctx?.activeNeeds?.length > 0) {
      const names = ctx.activeNeeds.slice(0, 3).map(n => n.name || n).join(', ');
      lines.push(`  Aktive Bedürfnisse: ${names}`);
    }
    if (ctx?.pendingCount > 0) {
      lines.push(`  Unreflektierte Momente: ${ctx.pendingCount}`);
    }
    if (pendingReview?.reviewed > 0) {
      lines.push(`  Gerade reflektiert: ${pendingReview.reviewed} Moment(e)`);
    }
    if (ctx?.lastSharedEntry) {
      lines.push(`  Letzter Shared-Eintrag: ${(ctx.lastSharedEntry.content || '').slice(0, 120)}`);
    }

    lines.push('', 'Schreib einen kurzen persönlichen Eintrag. Keine Aufzählung, keine Meta-Ebene.');
    return lines.join('\n');
  }
}

module.exports = { WakeUpRoutine };
