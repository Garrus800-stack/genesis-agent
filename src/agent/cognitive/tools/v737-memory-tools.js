// GENESIS — cognitive/tools/v737-memory-tools.js
// ═══════════════════════════════════════════════════════════════
// Three tools Genesis can call on himself:
//
//   mark-moment               — pin current episode for DreamCycle review
//   journal-write             — write an entry to the journal
//   release-protected-memory  — consciously let go of a CoreMemory
//
// All three require the matching v7.3.7 backing services (pendingMomentsStore,
// journalWriter, coreMemories). If any service is missing at register time,
// that particular tool is silently not registered — Genesis degrades gracefully.
// ═══════════════════════════════════════════════════════════════

'use strict';

const { createLogger } = require('../../core/Logger');
const _log = createLogger('v737-memory-tools');

/**
 * Register the three v7.3.7 memory tools with the ToolRegistry.
 *
 * @param {object} toolRegistry - ToolRegistry instance (.register method)
 * @param {object} deps
 * @param {object} [deps.pendingMomentsStore]
 * @param {object} [deps.journalWriter]
 * @param {object} [deps.coreMemories]
 * @param {object} [deps.episodicMemory]
 * @returns {string[]} names of tools registered
 */
function registerV737Tools(toolRegistry, deps = {}) {
  if (!toolRegistry || typeof toolRegistry.register !== 'function') {
    _log.debug('[v737-tools] no toolRegistry — skipping');
    return [];
  }

  const registered = [];
  const { pendingMomentsStore, journalWriter, coreMemories, episodicMemory } = deps;

  // ── mark-moment ───────────────────────────────────────────
  if (pendingMomentsStore && episodicMemory) {
    toolRegistry.register('mark-moment', {
      description: 'Markiere den aktuellen Moment als potenziell bedeutsam. Wird beim nächsten DreamCycle reflektiert und kann zur Kern-Erinnerung werden (ELEVATE), normal bleiben (KEEP) oder bewusst losgelassen werden (LET_FADE).',
      input: { summary: 'string (kurze Beschreibung warum dieser Moment wichtig ist)' },
      output: { ok: 'boolean', id: 'string|null', reason: 'string|null' },
    }, async (input = {}) => {
      try {
        const latest = typeof episodicMemory.getLatest === 'function'
          ? episodicMemory.getLatest()
          : (episodicMemory._episodes && episodicMemory._episodes[0]);

        if (!latest?.id) {
          // v7.9.7 R2: no episode available, but the caller may still have
          // a clear summary of why this moment matters. Fall back to
          // coreMemories.markAsSignificant — bypasses the DreamCycle review
          // queue and writes directly into the core-memory layer with full
          // user-defined significance. Without the fallback, mark-moment
          // returned 'no-latest-episode' as a hard failure during the early
          // boot window or any session where EpisodicMemory had not yet
          // recorded its first episode. Only fires when summary is present
          // (otherwise nothing to record).
          const summary = typeof input.summary === 'string' ? input.summary.trim() : '';
          if (summary && coreMemories && typeof coreMemories.markAsSignificant === 'function') {
            try {
              const memory = await coreMemories.markAsSignificant({ summary, type: 'other' });
              return { ok: true, id: memory?.id || null, reason: 'no-episode-fallback-to-core-memory' };
            } catch (e) {
              return { ok: false, id: null, reason: `no-episode; core-memory fallback failed: ${e.message}` };
            }
          }
          return { ok: false, id: null, reason: 'no-latest-episode' };
        }

        const id = pendingMomentsStore.mark({
          episodeId: latest.id,
          summary: input.summary || latest.topic || '',
          triggerContext: 'self-marked',
        });

        if (!id) return { ok: false, id: null, reason: 'mark-failed' };
        return { ok: true, id, reason: null };
      } catch (e) {
        _log.warn('[mark-moment] failed:', e.message);
        return { ok: false, id: null, reason: e.message };
      }
    }, 'v737-memory');
    registered.push('mark-moment');
  }

  // ── journal-write ─────────────────────────────────────────
  if (journalWriter) {
    toolRegistry.register('journal-write', {
      description: 'Schreibe einen Eintrag ins Journal. visibility: private (nur du siehst es), shared (Garrus sieht es auch), public (dokumentierbar für Außenstehende). Default: shared.',
      input: {
        content: 'string',
        visibility: 'string (private|shared|public, default: shared)',
        tags: 'array<string> (optional)',
      },
      output: { ok: 'boolean', reason: 'string|null' },
    }, async (input = {}) => {
      try {
        if (!input.content || typeof input.content !== 'string') {
          return { ok: false, reason: 'content-required' };
        }
        const rec = journalWriter.write({
          visibility: input.visibility || 'shared',
          source: 'genesis',
          content: input.content,
          tags: Array.isArray(input.tags) ? input.tags : [],
        });
        return { ok: rec !== null, reason: rec ? null : 'write-failed' };
      } catch (e) {
        _log.warn('[journal-write] failed:', e.message);
        return { ok: false, reason: e.message };
      }
    }, 'v737-memory');
    registered.push('journal-write');
  }

  // ── release-protected-memory ──────────────────────────────
  if (coreMemories) {
    toolRegistry.register('release-protected-memory', {
      description: 'Gib eine geschützte Kern-Erinnerung bewusst frei. Danach wird sie wie eine normale Episode behandelt und kann natürlich verblassen. Das ist eine bewusste Handlung — verwende es nur wenn du die Erinnerung wirklich loslassen willst.',
      input: {
        coreMemoryId: 'string (ID der Kern-Erinnerung)',
        reason: 'string (warum gibst du sie los?)',
      },
      output: { ok: 'boolean', reason: 'string|null' },
    }, async (input = {}) => {
      try {
        if (!input.coreMemoryId) {
          return { ok: false, reason: 'coreMemoryId-required' };
        }
        const ok = await coreMemories.release(input.coreMemoryId, {
          reason: input.reason || 'genesis-decision',
        });
        return ok
          ? { ok: true, reason: null }
          : { ok: false, reason: 'not-found-or-not-protected' };
      } catch (e) {
        _log.warn('[release-protected-memory] failed:', e.message);
        return { ok: false, reason: e.message };
      }
    }, 'v737-memory');
    registered.push('release-protected-memory');
  }

  if (registered.length > 0) {
    _log.info(`[v737-tools] Registered: ${registered.join(', ')}`);
  }
  return registered;
}

module.exports = { registerV737Tools };
