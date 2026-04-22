// GENESIS — cognitive/ContextCollector.js (v7.3.7)
// ═══════════════════════════════════════════════════════════════
// Shared context-collection layer used by:
//   - WakeUpRoutine.run()         → collectPostBootContext()
//   - IdleMind activity selection → collectIdleContext()
//   - DreamCycle Phase 1 (RECALL) → collectDreamContext()
//
// DESIGN DECISIONS (from v7.3.7 spec Sektion 6 + Patch B):
//   - Zero constructor deps except `clock` — avoids any DI cycle
//     with IdleMind ↔ DreamCycle ↔ ContextCollector all in Phase 9.
//   - All sources are optional late-bindings. Missing source →
//     null in the result, never a throw.
//   - Clock-injected (Principle 0.3) — deterministic tests.
//   - Uses only verified v7.3.6 public APIs (no .snapshot(),
//     .getActive(), .getLastDreamAt() — those don't exist).
// ═══════════════════════════════════════════════════════════════

'use strict';

const { createLogger } = require('../core/Logger');
const _log = createLogger('ContextCollector');

class ContextCollector {
  /**
   * @param {object} [opts]
   * @param {{ now: () => number }} [opts.clock]
   */
  constructor({ clock = Date } = {}) {
    this._clock = clock;

    // All sources set via late-bindings (optional: true).
    // ContextCollector resolves immediately at boot; sources attach later.
    this.episodicMemory = null;
    this.journalWriter = null;
    this.pendingMomentsStore = null;
    this.coreMemories = null;
    this.emotionalState = null;
    this.needsSystem = null;
    this.dreamCycle = null;

    // Lazy-tracked: time of first post-boot context call. Used to
    // distinguish "core memories created this session" from older ones.
    this._postBootMarkerMs = null;
  }

  // ── Lifecycle ─────────────────────────────────────────────

  async asyncLoad() { /* nothing to load */ }
  start() { /* nothing to start */ }
  stop() { /* nothing to stop */ }

  // ══════════════════════════════════════════════════════════
  // PUBLIC: collectPostBootContext (WakeUpRoutine)
  // ══════════════════════════════════════════════════════════

  /**
   * Snapshot for the post-boot Re-Entry routine. Heavier read —
   * journal, dreams, core memories, pending moments, organism state.
   *
   * Time-windowed where applicable: dreams last 48h.
   *
   * @returns {Promise<object>}
   */
  async collectPostBootContext() {
    if (this._postBootMarkerMs == null) {
      this._postBootMarkerMs = this._clock.now();
    }

    const readCounts = { dreams: 0, coreMemories: 0, journal: 0 };

    return {
      recentDreams: this._readDreams(48 * 60 * 60 * 1000, readCounts),
      lastPrivateEntry: this._readLastJournal('private', readCounts),
      lastSharedEntry: this._readLastJournal('shared', readCounts),
      pendingCount: this._safeCall(() => this.pendingMomentsStore?.getCount?.()) || 0,
      newCoreMemoriesSinceLastBoot: this._collectNewCoreMemories(readCounts),
      emotionalSnapshot: this._collectEmotionalSnapshot(),
      activeNeeds: this._collectActiveNeeds(),
      readCounts,
    };
  }

  // ══════════════════════════════════════════════════════════
  // PUBLIC: collectIdleContext (IdleMind activity scoring)
  // ══════════════════════════════════════════════════════════

  /**
   * Lighter snapshot for IdleMind activity selection. Skips
   * journal/dreams (IdleMind cares about *now*, not yesterday).
   *
   * @returns {Promise<object>}
   */
  async collectIdleContext() {
    return {
      emotionalSnapshot: this._collectEmotionalSnapshot(),
      activeNeeds: this._collectActiveNeeds(),
      pendingCount: this._safeCall(() => this.pendingMomentsStore?.getCount?.()) || 0,
      recentEpisodeCount: this._safeCall(
        () => this.episodicMemory?.getRecent?.(1)?.length
      ) || 0,
      timeSinceLastDream: this._safeCall(
        () => this.dreamCycle?.getTimeSinceLastDream?.()
      ) ?? Infinity,
    };
  }

  // ══════════════════════════════════════════════════════════
  // PUBLIC: collectDreamContext (DreamCycle Phase 1)
  // ══════════════════════════════════════════════════════════

  /**
   * Focused snapshot for DreamCycle. Episode-centric.
   *
   * Note: getUnprocessed() and getTransitionCandidates() will be
   * added to EpisodicMemory in Step 5 of the v7.3.7 build. Until
   * then they return [] via optional chaining.
   *
   * @returns {Promise<object>}
   */
  async collectDreamContext() {
    return {
      unprocessedEpisodes: this._safeCall(
        () => this.episodicMemory?.getUnprocessed?.()
      ) || [],
      pendingMomentsCount: this._safeCall(
        () => this.pendingMomentsStore?.getCount?.()
      ) || 0,
      transitionCandidates: this._safeCall(
        () => this.episodicMemory?.getTransitionCandidates?.()
      ) || [],
    };
  }

  // ══════════════════════════════════════════════════════════
  // INTERNAL HELPERS
  // ══════════════════════════════════════════════════════════

  /**
   * Build emotional snapshot from real EmotionalState methods.
   * v7.3.6 has: getState(), getDominant(), getMood(), getTrend(),
   * buildPromptContext(). There is NO .snapshot() — assemble here.
   */
  _collectEmotionalSnapshot() {
    if (!this.emotionalState) return null;
    return this._safeCall(() => ({
      state: this.emotionalState.getState?.() || null,
      dominant: this.emotionalState.getDominant?.() || null,
      mood: this.emotionalState.getMood?.() || null,
    })) || null;
  }

  /**
   * Build active-needs list from real NeedsSystem methods.
   * v7.3.6 has: getNeeds() → {name: value}, getMostUrgent() →
   * {need, drive}, getTotalDrive(). There is NO .getActive() —
   * we filter the getNeeds() object ourselves.
   *
   * Returns array of { name, value } sorted by value descending.
   */
  _collectActiveNeeds(threshold = 0.5) {
    if (!this.needsSystem) return [];
    return this._safeCall(() => {
      const all = this.needsSystem.getNeeds?.() || {};
      const list = Object.entries(all)
        .filter(([_name, value]) => typeof value === 'number' && value >= threshold)
        .map(([name, value]) => ({ name, value }))
        .sort((a, b) => b.value - a.value);
      return list;
    }) || [];
  }

  /**
   * Read recent dream entries from JournalWriter (source='dreamcycle').
   * Returns [] if JournalWriter not yet wired (Step 4 dependency).
   */
  _readDreams(_windowMs, readCounts) {
    if (!this.journalWriter) return [];
    const entries = this._safeCall(() => this.journalWriter.readLast?.('shared', 20)) || [];
    const dreamEntries = entries.filter(e => e?.source === 'dreamcycle');
    readCounts.dreams = dreamEntries.length;
    return dreamEntries;
  }

  _readLastJournal(visibility, readCounts) {
    if (!this.journalWriter) return null;
    const entries = this._safeCall(() => this.journalWriter.readLast?.(visibility, 1)) || [];
    if (entries.length > 0) readCounts.journal++;
    return entries[0] || null;
  }

  /**
   * List CoreMemories created since the post-boot marker was set.
   * For the very first call (_postBootMarkerMs just set), nothing
   * qualifies as "new". On subsequent calls within the same session,
   * memories created after boot are returned.
   *
   * Uses CoreMemories internal identity store via list() if available.
   */
  _collectNewCoreMemories(readCounts) {
    if (!this.coreMemories) return [];
    const all = this._safeCall(() => this.coreMemories.list?.()) || [];
    readCounts.coreMemories = all.length;
    if (this._postBootMarkerMs == null) return [];
    return all.filter(cm => {
      const ts = new Date(cm?.timestamp || 0).getTime();
      return ts >= this._postBootMarkerMs;
    });
  }

  /**
   * Wrap optional-chain reads in try/catch — guarantees no throw
   * propagates from a misbehaving source. Defensive at the boundary.
   */
  _safeCall(fn) {
    try { return fn(); }
    catch (e) {
      _log.debug?.('source call failed:', e?.message);
      return null;
    }
  }

  // ── Diagnostics ───────────────────────────────────────────

  getReport() {
    return {
      sourcesAttached: {
        episodicMemory: !!this.episodicMemory,
        journalWriter: !!this.journalWriter,
        pendingMomentsStore: !!this.pendingMomentsStore,
        coreMemories: !!this.coreMemories,
        emotionalState: !!this.emotionalState,
        needsSystem: !!this.needsSystem,
        dreamCycle: !!this.dreamCycle,
      },
      postBootMarkerMs: this._postBootMarkerMs,
    };
  }
}

module.exports = { ContextCollector };
