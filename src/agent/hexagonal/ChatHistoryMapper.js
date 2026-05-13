// ============================================================
// GENESIS — hexagonal/ChatHistoryMapper.js (v7.7.9 Phase 2)
//
// Pure helper extracted from ChatOrchestrator's persistence path to
// keep the orchestrator under the 700-LOC architectural-fitness ceiling.
//
// Both `_saveHistory` and `_saveHistorySync` map the in-memory history
// array to a serializable shape — same logic, two call sites. The
// mapper supports both legacy entries (just role + content) and the
// v7.7.9 Phase 2 self-message shape (additional initiatedBy, selfMeta,
// timestamp fields).
// ============================================================

'use strict';

/**
 * Map a single in-memory history entry to its on-disk JSON shape.
 *
 * Legacy entries roundtrip cleanly (role + content only). Self-initiated
 * entries get the additional fields persisted. Old entries without
 * those fields stay readable — fields default to undefined and the
 * additive properties just don't appear on disk.
 *
 * @param {object} m — history entry
 * @returns {object}
 */
function mapHistoryEntry(m) {
  const out = {
    role: m.role,
    content: typeof m.content === 'string' ? m.content.slice(0, 2000) : '',
  };
  if (typeof m.timestamp === 'number') out.timestamp = m.timestamp;
  if (m.initiatedBy === 'self') {
    out.initiatedBy = 'self';
    if (m.selfMeta && typeof m.selfMeta === 'object') {
      out.selfMeta = {
        kind: m.selfMeta.kind,
        score: m.selfMeta.score,
        sourceRef: m.selfMeta.sourceRef,
        thoughtId: m.selfMeta.thoughtId,
      };
    }
  }
  return out;
}

/**
 * Map a sliced range of history entries to their on-disk shape.
 *
 * @param {Array<object>} history
 * @param {number} maxPersisted
 * @returns {Array<object>}
 */
function mapHistoryForPersistence(history, maxPersisted) {
  return history.slice(-maxPersisted).map(mapHistoryEntry);
}

/**
 * Construct the in-memory history entry for a self-initiated message
 * from Genesis. Centralized here so ChatOrchestrator's `appendSelfMessage`
 * stays a thin orchestrator method.
 *
 * @param {{ text: string, kind?: string, score?: number,
 *           sourceRef?: object|null, thoughtId?: string|null }} msg
 * @returns {object|null} — null when input is invalid (caller should
 *   no-op silently rather than persist garbage)
 */
function buildSelfMessageEntry(msg) {
  if (!msg || typeof msg.text !== 'string' || msg.text.length === 0) return null;
  return {
    role: 'assistant',
    content: msg.text,
    timestamp: Date.now(),
    initiatedBy: 'self',
    selfMeta: {
      kind: String(msg.kind || 'unknown'),
      score: typeof msg.score === 'number' ? msg.score : null,
      sourceRef: msg.sourceRef || null,
      thoughtId: msg.thoughtId || null,
    },
  };
}

module.exports = {
  mapHistoryEntry,
  mapHistoryForPersistence,
  buildSelfMessageEntry,
};
