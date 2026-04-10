// @ts-check
// ============================================================
// GENESIS — PatternMatcher.js (v7.0.9 — Phase 3)
//
// Compares structural patterns from LessonsStore for cross-context
// lesson retrieval. Uses weighted Jaccard similarity on elements,
// anti-patterns, and category matching.
//
// No LLM calls — pure set operations.
//
// Integration:
//   LessonsStore.findByStructure() → PatternMatcher.compare()
//   DreamCycle Phase 5 → generates similar_to edges in KG
//   SymbolicResolver → uses structural matches for GUIDED
// ============================================================

'use strict';

class PatternMatcher {
  /**
   * Compare two structural patterns.
   * @param {object|null} a - Pattern A
   * @param {object|null} b - Pattern B
   * @returns {number} Similarity score 0.0 - 1.0
   */
  compare(a, b) {
    if (!a || !b) return 0;

    const pa = a.problemStructure || {};
    const pb = b.problemStructure || {};
    const sa = a.solutionStructure || {};
    const sb = b.solutionStructure || {};

    // Category match: 0 or 1 (strong signal)
    const categoryMatch = (pa.category && pb.category && pa.category === pb.category) ? 1.0 : 0.0;

    // Element overlap (Jaccard)
    const elemScore = this._jaccard(pa.elements || [], pb.elements || []);

    // Anti-pattern overlap (Jaccard)
    const antiScore = this._jaccard(pa.antiPatterns || [], pb.antiPatterns || []);

    // Solution strategy match
    const stratMatch = (sa.strategy && sb.strategy && sa.strategy === sb.strategy) ? 1.0 : 0.0;

    // Solution steps overlap
    const stepsScore = this._jaccard(sa.steps || [], sb.steps || []);

    // Weighted combination
    // Category is the strongest signal (40%), elements (25%), anti-patterns (15%), strategy (10%), steps (10%)
    const score = (categoryMatch * 0.40) +
                  (elemScore * 0.25) +
                  (antiScore * 0.15) +
                  (stratMatch * 0.10) +
                  (stepsScore * 0.10);

    return Math.round(score * 100) / 100;
  }

  /**
   * Jaccard similarity between two string arrays.
   * |intersection| / |union|
   * @param {string[]} a
   * @param {string[]} b
   * @returns {number} 0.0 - 1.0
   */
  _jaccard(a, b) {
    if (a.length === 0 && b.length === 0) return 0;
    const setA = new Set(a.map(s => s.toLowerCase()));
    const setB = new Set(b.map(s => s.toLowerCase()));
    let intersection = 0;
    for (const item of setA) {
      if (setB.has(item)) intersection++;
    }
    const union = setA.size + setB.size - intersection;
    return union === 0 ? 0 : intersection / union;
  }
}

module.exports = { PatternMatcher };
