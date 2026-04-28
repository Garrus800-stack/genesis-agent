// @ts-checked-v5.8
// ============================================================
// GENESIS — FrontierExtractors.js (v7.1.6 — Persistent Self)
//
// Extractor and merger functions for the three FrontierWriter
// configurations:
//
//   1. UNFINISHED_WORK — captures incomplete goals and work
//      from SessionPersistence at session end.
//
//   2. HIGH_SUSPICION — captures novel/surprising events
//      buffered over the session from SurpriseAccumulator.
//
//   3. LESSON_APPLIED — captures which lessons were recalled
//      during the session from LessonsStore.
//
// Each extractor is a pure function: (context) => props | null.
// No LLM calls, no side effects, fully deterministic.
//
// These are NOT separate modules — they're imported by the
// phase8/phase9 manifest and passed as config to FrontierWriter.
// ============================================================

'use strict';

// ════════════════════════════════════════════════════════════
// 1. UNFINISHED_WORK
// ════════════════════════════════════════════════════════════

/**
 * Extract unfinished work from session context.
 *
 * Sources:
 *   A) SessionPersistence.unfinishedWork — LLM-generated free text
 *   B) GoalStack pending goals — active/paused/blocked
 *
 * Returns null if nothing noteworthy (< 3 messages or no work).
 *
 * @param {object} context
 * @param {object} context.session - Current session data
 * @param {object} [context.goalStack] - GoalStack instance
 * @returns {object|null}
 */
function unfinishedWorkExtractor(context) {
  const { session, goalStack } = context;
  if (!session) return null;

  // Skip trivially short sessions
  if ((session.messageCount || 0) < 3) return null;

  // Source A: LLM-generated unfinished work text
  const unfinishedText = session.unfinishedWork;

  // Source B: Non-completed goals
  const pendingGoals = [];
  if (goalStack && typeof goalStack.getAll === 'function') {
    const all = goalStack.getAll();
    for (const g of all) {
      if (g.status === 'active' || g.status === 'paused' || g.status === 'blocked') {
        const totalSteps = g.totalSteps || g.steps?.length || 1;
        const completedSteps = g.completedSteps || 0;
        pendingGoals.push({
          description: (g.description || '').slice(0, 100),
          status: g.status,
          progress: Math.round((completedSteps / Math.max(totalSteps, 1)) * 100) / 100,
        });
      }
    }
  }

  // Nothing to report?
  if (!unfinishedText && pendingGoals.length === 0) return null;
  // Skip "none" responses from LLM
  if (unfinishedText && /^none\.?$/i.test(unfinishedText.trim()) && pendingGoals.length === 0) return null;

  return {
    description: unfinishedText ? unfinishedText.slice(0, 200) : null,
    pending_goals: pendingGoals.slice(0, 3),
    files_in_progress: (session.codeFilesModified || []).slice(0, 5),
    topics: (session.topicsDiscussed || []).slice(0, 5),
    priority: pendingGoals.some(g => g.progress > 0.5) ? 'high' : 'normal',
  };
}


// ════════════════════════════════════════════════════════════
// 2. HIGH_SUSPICION
// ════════════════════════════════════════════════════════════

/**
 * Extract novel/surprising events from session buffer.
 *
 * Source: SurpriseAccumulator emits 'surprise:novel-event' for
 * events with surprise score >= 1.5. These are buffered over
 * the session and passed here at session:ending.
 *
 * @param {object} context
 * @param {Array} [context.novelEvents] - Buffered novel events
 * @returns {object|null}
 */
function suspicionExtractor(context) {
  const { novelEvents } = context;
  if (!novelEvents || novelEvents.length === 0) return null;

  // Compute dominant category
  const freq = {};
  for (const e of novelEvents) {
    const cat = e.category || 'unknown';
    freq[cat] = (freq[cat] || 0) + 1;
  }
  const entries = Object.entries(freq).sort((a, b) => b[1] - a[1]);
  const dominant = entries[0][0];

  return {
    novel_events: novelEvents.slice(0, 10).map(e => ({
      description: (e.description || '').slice(0, 100),
      surprise_score: e.surprise || 0,
      category: e.category || 'unknown',
    })),
    count: novelEvents.length,
    dominant_category: dominant,
  };
}

/**
 * Merge suspicion nodes when same dominant category.
 * Prevents frontier bloat from repeated surprises in the same area.
 *
 * @param {object} existing - Properties of existing frontier node
 * @param {object} incoming - Properties of new frontier data
 * @returns {object|null} - Merged properties, or null if not mergeable
 */
function suspicionMerger(existing, incoming) {
  if (!existing.dominant_category || !incoming.dominant_category) return null;
  if (existing.dominant_category !== incoming.dominant_category) return null;

  return {
    ...existing,
    count: (existing.count || 0) + (incoming.count || 0),
    novel_events: [
      ...(existing.novel_events || []),
      ...(incoming.novel_events || []),
    ].slice(0, 15),
    last_merged: Date.now(),
  };
}


// ════════════════════════════════════════════════════════════
// 3. LESSON_APPLIED
// ════════════════════════════════════════════════════════════

/**
 * Extract applied lessons from session buffer.
 *
 * Source: LessonsStore.recall() emits 'lesson:applied' for each
 * lesson retrieved. These are buffered over the session and
 * passed here at session:ending.
 *
 * v7.1.7: Now includes confirmed/contradicted counts from
 * lesson:confirmed and lesson:contradicted events (also buffered).
 *
 * @param {object} context
 * @param {Array} [context.appliedLessons] - Buffered applied lessons
 * @param {Array} [context.confirmedLessons] - Buffered confirmed lessons (v7.1.7)
 * @param {Array} [context.contradictedLessons] - Buffered contradicted lessons (v7.1.7)
 * @returns {object|null}
 */
function lessonExtractor(context) {
  const { appliedLessons, confirmedLessons, contradictedLessons } = context;
  if (!appliedLessons || appliedLessons.length === 0) return null;

  // Deduplicate by lesson ID (same lesson may be recalled multiple times)
  const seen = new Set();
  const unique = [];
  for (const l of appliedLessons) {
    if (l.id && !seen.has(l.id)) {
      seen.add(l.id);
      unique.push(l);
    }
  }

  if (unique.length === 0) return null;

  // v7.1.7: Aggregate confirmation data
  const confirmedCount = confirmedLessons?.length || 0;
  const contradictedCount = contradictedLessons?.length || 0;

  return {
    applied: unique.slice(0, 10).map(l => ({
      lessonId: l.id,
      category: l.category || 'unknown',
      insight: (l.insight || '').slice(0, 80),
    })),
    count: unique.length,
    categories: [...new Set(unique.map(l => l.category || 'unknown'))],
    confirmed_count: confirmedCount,
    contradicted_count: contradictedCount,
  };
}


module.exports = {
  unfinishedWorkExtractor,
  suspicionExtractor,
  suspicionMerger,
  lessonExtractor,
};
