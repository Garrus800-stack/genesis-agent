'use strict';

// ============================================================
// GENESIS — activities/plan-review-feedback.js (v7.9.20, L1)
//
// Feedback-loop helper for the idle planner. Before proposing the next
// activity, the planner must know which source files it has ALREADY covered,
// so it stops re-proposing the same inspection — the field showed the goal
// "Inspect …/Reflect.js" picked 4× because nothing remembered it was done.
//
// CRITICAL (verified against the runtime dump): the file-reading activities
// store their coverage INCONSISTENTLY in the knowledge graph —
//   • Explore.js     → addNode('insight', …, { file:   <path>, type:'code-review' })
//   • ReadSource.js  → addNode('insight', …, { module: <path>, type:'self-read'   })
//   • F2 (AgentLoop) → addNode('insight', …, { module: <path>, type:'agent-loop-analysis' })
// A narrow filter on one type or one property key misses the others. The dump
// had 5 Explore nodes (file:) and 0 ReadSource nodes, so reading only
// `agent-loop-analysis`/`module` would have seen NOTHING already-covered and
// the loop would only half-close. Therefore: read ALL 'insight' nodes and take
// `properties.module || properties.file`, independent of the `type` value.
//
// Defensive: a KG without getNodesByType degrades to the original ordering.
// Lives in its own module to keep Plan.js under the LOC guideline.
// ============================================================

/**
 * @param {Array<{file:string}>} modules - module summaries (POSIX paths via F1)
 * @param {*} kg - knowledge graph (may lack getNodesByType)
 * @returns {{ realPaths: string, alreadyReviewed: string }}
 */
function orderByReviewState(modules, kg) {
  const covered = new Set();
  if (kg && typeof kg.getNodesByType === 'function') {
    try {
      for (const n of (kg.getNodesByType('insight') || [])) {
        const p = (n && n.properties) || {};
        const file = p.module || p.file;   // type-independent: catches Explore, ReadSource, F2
        if (file) covered.add(file);
      }
    } catch (_e) { /* best-effort: fall back to plain ordering */ }
  }
  // Stable sort: not-yet-covered files first, original order preserved within groups.
  const ordered = (modules || []).slice().sort((a, b) =>
    (covered.has(a.file) ? 1 : 0) - (covered.has(b.file) ? 1 : 0));
  return {
    realPaths: ordered.slice(0, 30).map(m => m.file).join('\n'),
    alreadyReviewed: [...covered].slice(0, 12).join('\n'),
  };
}

module.exports = { orderByReviewState };
