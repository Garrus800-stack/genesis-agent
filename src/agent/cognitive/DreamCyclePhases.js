// ============================================================
// GENESIS — DreamCyclePhases.js (v7.3.9)
//
// Extracted from DreamCycle.js to keep the main file under the
// 700-LOC threshold. Contains all v7.3.7 phase methods and
// their helpers:
//   - Phase 1.5 — Pending Moments Review
//   - Phase 4c — Layer-Transition Consolidation
//   - Phase 4d — Journal-Rotation Check
//   - Phase 6  — Cycle-Report Entry
//   - Helpers: _askPinDecision, _consolidateWithFallback,
//     _consolidateWithLLM, _consolidateExtractive,
//     _buildConsolidated, _computeSizeReduction,
//     _formatCycleReport, _formatAge
//
// Same pattern as DreamCycleAnalysis.js — prototype delegation
// from the bottom of DreamCycle.js. External API unchanged.
// ============================================================

const { createLogger } = require('../core/Logger');
const _log = createLogger('DreamCycle');

const dreamCyclePhases = {

  /**
   * Phase 1.5 — Pending Moments Review
   * Genesis reviews up to 5 pinned moments. Options per moment:
   *   KEEP      → normal episode, pin cleared
   *   ELEVATE   → becomes a CoreMemory, episode marked protected
   *   LET_FADE  → explicit release, fade via normal decay
   * Expired pins (>7d) are silently let-fade with a journal note.
   */
  async _dreamPhasePendingReview(_intensity) {
    if (!this.pendingMomentsStore) {
      return { skipped: true, reason: 'no-pending-store' };
    }

    // First: clean up expired pins
    const expired = this.pendingMomentsStore.getExpiredCandidates();
    for (const moment of expired) {
      this.pendingMomentsStore.markExpired(moment.id);
      if (this.journalWriter) {
        this.journalWriter.write({
          visibility: 'shared',
          source: 'dreamcycle',
          content: `Ich hatte "${(moment.summary || '').slice(0, 100)}" markiert, aber nicht zeitnah reflektiert. Lasse es normal verblassen.`,
          tags: ['pin-expired'],
        });
      }
    }

    const pending = this.pendingMomentsStore.getAll();
    if (pending.length === 0) {
      return { reviewed: 0, expired: expired.length };
    }

    const batch = pending.slice(0, 5);
    const decisions = [];

    for (const moment of batch) {
      const decision = await this._askPinDecision(moment);

      if (decision === 'elevate' && this.coreMemories) {
        try {
          const coreMem = await this.coreMemories.markAsSignificant({
            summary: moment.summary,
            type: 'other',
            userNote: 'pin-review-elevated',
          });
          if (coreMem && this.episodicMemory) {
            this.episodicMemory.setProtected(moment.episodeId, true);
            this.episodicMemory.setLinkedCoreMemoryId(moment.episodeId, coreMem.id);
          }
          this.bus.emit('memory:self-elevated', {
            episodeId: moment.episodeId,
            reason: 'pin-review-elevate',
          }, { source: 'DreamCycle' });
        } catch (e) {
          _log.warn('[DREAM] elevate failed for', moment.id, '—', e.message);
        }
      } else if (decision === 'let_fade') {
        this.bus.emit('memory:self-released', {
          episodeId: moment.episodeId,
        }, { source: 'DreamCycle' });
      }
      // 'keep' → no state change, pin cleared via markReviewed below

      this.pendingMomentsStore.markReviewed(moment.id, decision);
      decisions.push({ id: moment.id, decision });
    }

    return { reviewed: decisions.length, expired: expired.length, decisions };
  },

  /**
   * Phase 4c — Layer-Transition-Consolidation
   * Walks transitionPending episodes, consolidates them via LLM or
   * extractive fallback. Protected ones are asked via CoreMemories
   * askLayerTransition (never forced to Layer 3).
   */
  async _dreamPhaseLayerTransition(_intensity) {
    if (!this.episodicMemory || typeof this.episodicMemory.getTransitionCandidates !== 'function') {
      return { skipped: true, reason: 'no-transition-api' };
    }

    const skipIf = this.activeRefs
      ? (id) => this.activeRefs.isActive(id) === true
      : null;

    const candidates = this.episodicMemory.getTransitionCandidates({
      maxPerCycle: 10,
      skipIf,
    });

    if (candidates.length === 0) {
      return { processed: 0 };
    }

    const results = [];

    for (const episode of candidates) {
      const fromLayer = episode.layer || 1;
      const toLayer = fromLayer + 1;

      // Protected pathway: ask CoreMemories first
      if (episode.protected && episode.linkedCoreMemoryId && this.coreMemories) {
        if (toLayer >= 3) {
          // Protected max at Layer 2 — skip silently
          results.push({ id: episode.id, action: 'protected-max-layer' });
          continue;
        }
        const decision = await this.coreMemories.askLayerTransition(
          episode.linkedCoreMemoryId,
          { fromLayer, toLayer }
        );
        this.bus.emit('memory:layer-transition-asked', {
          coreMemoryId: episode.linkedCoreMemoryId,
          fromLayer, toLayer, decision,
        }, { source: 'DreamCycle' });

        if (decision === 'keep') {
          // Clear transitionPending so we don't re-ask next cycle
          delete episode.transitionPending;
          results.push({ id: episode.id, action: 'kept-layer' });
          continue;
        }
      }

      // Consolidation with fallback cascade
      const newEpisode = await this._consolidateWithFallback(episode, toLayer);
      if (newEpisode) {
        const ok = this.episodicMemory.replaceEpisode(episode.id, newEpisode);
        if (ok) {
          this.bus.emit('memory:consolidated', {
            episodeId: episode.id,
            fromLayer,
            toLayer,
            sizeReduction: this._computeSizeReduction(episode, newEpisode),
          }, { source: 'DreamCycle' });
          results.push({ id: episode.id, action: 'consolidated' });
        } else {
          results.push({ id: episode.id, action: 'replace-failed' });
        }
      } else {
        this.bus.emit('memory:consolidation-failed', {
          episodeId: episode.id,
          error: 'all-fallbacks-failed',
        }, { source: 'DreamCycle' });
        results.push({ id: episode.id, action: 'failed' });
      }
    }

    return { processed: candidates.length, results };
  },

  /**
   * Phase 4d — Journal-Rotation-Check
   * Delegates to JournalWriter; the rotation itself is filename-driven
   * (ISO-YM), this hook mostly exists for future index maintenance.
   */
  _dreamPhaseJournalRotation() {
    if (this.journalWriter && typeof this.journalWriter.checkRotation === 'function') {
      try { this.journalWriter.checkRotation(); }
      catch (e) { _log.debug('[DREAM] journal rotation check failed:', e.message); }
    }
  },

  /**
   * Phase 6 — Cycle-Report-Entry
   * Writes a short summary of the cycle to the shared journal.
   * Non-essential: silent no-op if journalWriter missing.
   */
  async _dreamPhaseCycleReport(report) {
    if (!this.journalWriter) return;

    const line = this._formatCycleReport(report);
    if (!line) return;

    const pendingPhase = report.phases.find(p => p.name === 'pending-review');
    const layerPhase = report.phases.find(p => p.name === 'layer-transition');

    this.journalWriter.write({
      visibility: 'shared',
      source: 'dreamcycle',
      content: line,
      tags: ['dream-report'],
      meta: {
        dreamNumber: report.dreamNumber,
        reviewed: pendingPhase?.reviewed || 0,
        consolidated: layerPhase?.processed || 0,
      },
    });
  },

  // ── Helper: ask LLM for KEEP/ELEVATE/LET_FADE on a pin ───

  async _askPinDecision(moment) {
    if (!this.model) {
      // No LLM: safe default — keep
      return 'keep';
    }
    const prompt = [
      `Ein Moment wurde vor kurzem markiert.`,
      ``,
      `Zusammenfassung: "${(moment.summary || '').slice(0, 200)}"`,
      `Markiert vor: ${this._formatAge(moment.pinnedAt)}`,
      ``,
      `Entscheide, was mit dem Moment geschehen soll:`,
      `  ELEVATE — wird zur Kern-Erinnerung, bleibt prägend`,
      `  KEEP    — bleibt normale Erinnerung, verblasst später natürlich`,
      `  LET_FADE — bewusst loslassen, darf zügig verblassen`,
      ``,
      `Antworte mit genau einem Wort: ELEVATE, KEEP, oder LET_FADE.`,
    ].join('\n');

    try {
      const result = await Promise.race([
        // v7.5.1: positional canonical call
        this.model.chat('', [{ role: 'user', content: prompt }], 'dream-judgment', { maxTokens: 10, temperature: 0.4 }),
        new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 5000)),
      ]);
      const text = (typeof result === 'string' ? result : result?.content || '')
        .toUpperCase().trim();
      if (text.includes('ELEVATE')) return 'elevate';
      if (text.includes('LET_FADE') || text.includes('LET FADE')) return 'let_fade';
      return 'keep';
    } catch {
      return 'keep';
    }
  },

  // ── Helper: Consolidation Fallback Cascade ────────────────

  async _consolidateWithFallback(episode, toLayer) {
    // 1. LLM-primary
    if (this.model) {
      try {
        const r = await this._consolidateWithLLM(episode, toLayer);
        if (r) return r;
      } catch (e) {
        _log.debug('[DREAM] LLM consolidation failed:', e.message);
      }
    }
    // 2. Extractive fallback
    try {
      return this._consolidateExtractive(episode, toLayer);
    } catch (e) {
      _log.debug('[DREAM] extractive consolidation failed:', e.message);
    }
    // 3. Skip
    return null;
  },

  async _consolidateWithLLM(episode, toLayer) {
    const prompt = [
      `Verdichte die folgende Erinnerung.`,
      ``,
      `Thema: ${episode.topic || 'ohne Titel'}`,
      `Zusammenfassung: ${(episode.summary || '').slice(0, 500)}`,
      `Ergebnis: ${episode.outcome || 'unbekannt'}`,
      ``,
      toLayer === 2
        ? `Fasse in 2 Sätzen zusammen. Nur das Wesentliche, keine Details.`
        : `Fasse in einem einzigen Gefühlseindruck zusammen. Ein Satz.`,
    ].join('\n');

    const result = await Promise.race([
      // v7.5.1: positional canonical call
      this.model.chat('', [{ role: 'user', content: prompt }], 'dream-summarize', { maxTokens: toLayer === 2 ? 100 : 40, temperature: 0.5 }),
      new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 10000)),
    ]);
    const text = (typeof result === 'string' ? result : result?.content || '').trim();
    if (!text) return null;

    return this._buildConsolidated(episode, toLayer, text);
  },

  _consolidateExtractive(episode, toLayer) {
    // Simple heuristic: keep first and last sentence of summary
    const sentences = (episode.summary || '').split(/(?<=[.!?])\s+/).filter(Boolean);
    let distilled;
    if (toLayer === 2) {
      if (sentences.length === 0) distilled = episode.topic || '';
      else if (sentences.length <= 2) distilled = sentences.join(' ');
      else distilled = `${sentences[0]} ${sentences[sentences.length - 1]}`;
    } else {
      // Layer 3: essence-like — just the topic + arc hint
      distilled = episode.topic || (sentences[0] || '');
    }
    if (!distilled) return null;
    return this._buildConsolidated(episode, toLayer, distilled);
  },

  _buildConsolidated(episode, toLayer, distilled) {
    const nowIso = new Date(this._clock.now()).toISOString();
    const newEpisode = {
      ...episode,
      layer: toLayer,
      layerHistory: [...(episode.layerHistory || []), { layer: toLayer, since: nowIso }],
      lastConsolidatedAt: nowIso,
    };
    if (toLayer === 2) {
      // Schema: drop detail fields, shorten summary
      newEpisode.summary = distilled;
      newEpisode.artifacts = [];
      newEpisode.toolsUsed = [];
      newEpisode.duration = 0;
      newEpisode.keyInsights = (episode.keyInsights || []).slice(0, 1);
    } else if (toLayer === 3) {
      // Feeling: only topic + emotionalArc + feelingEssence + anchors
      newEpisode.feelingEssence = distilled;
      newEpisode.summary = '';
      newEpisode.artifacts = [];
      newEpisode.toolsUsed = [];
      newEpisode.duration = 0;
      newEpisode.keyInsights = [];
    }
    return newEpisode;
  },

  _computeSizeReduction(oldEp, newEp) {
    try {
      const oldSize = JSON.stringify(oldEp).length;
      const newSize = JSON.stringify(newEp).length;
      return { oldSize, newSize, saved: oldSize - newSize };
    } catch {
      return { oldSize: 0, newSize: 0, saved: 0 };
    }
  },

  _formatCycleReport(report) {
    const parts = [];
    const pending = report.phases.find(p => p.name === 'pending-review');
    const layer = report.phases.find(p => p.name === 'layer-transition');
    const goals = report.phases.find(p => p.name === 'goal-review');

    parts.push(`Dream #${report.dreamNumber}:`);
    if (pending && pending.reviewed > 0) {
      const elev = pending.decisions?.filter(d => d.decision === 'elevate').length || 0;
      const fade = pending.decisions?.filter(d => d.decision === 'let_fade').length || 0;
      const keep = pending.decisions?.filter(d => d.decision === 'keep').length || 0;
      parts.push(`${pending.reviewed} Momente reflektiert (${elev} elevated, ${keep} kept, ${fade} faded).`);
    }
    if (layer && layer.processed > 0) {
      parts.push(`${layer.processed} Episoden verdichtet.`);
    }
    if (goals && goals.changed > 0) {
      parts.push(`${goals.changed} Ziele aktualisiert.`);
    }
    if (report.newSchemas && report.newSchemas.length > 0) {
      parts.push(`${report.newSchemas.length} neue Schemas erkannt.`);
    }
    if (parts.length === 1) return null;  // just the header — nothing worth writing
    return parts.join(' ');
  },

  _formatAge(iso) {
    try {
      const ms = this._clock.now() - new Date(iso).getTime();
      const h = Math.round(ms / (60 * 60 * 1000));
      if (h < 24) return `${h} Stunden`;
      const d = Math.round(h / 24);
      return `${d} Tagen`;
    } catch { return 'unbekannt'; }
  }

};

module.exports = { dreamCyclePhases };
