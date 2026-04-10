// @ts-check
// ============================================================
// GENESIS — StructuralAbstraction.js (v7.0.9 — Phase 3)
//
// Manages the lifecycle of structural pattern extraction for
// Lessons. Patterns are extracted via LLM call in DreamCycle
// (never in the hot path). Retry queue with typed failures.
//
// Lifecycle: pending → extracted | failed:{reason} | obsolete | contradiction
//
// Failure types:
//   llm-timeout:          Normal retry, exponential backoff (max 3)
//   parse-error:          Retry with simplified prompt (max 3)
//   low-confidence:       Retry with extended context (max 2)
//   contradicts-existing: No retry — signal for knowledge collision
//
// Integration:
//   DreamCycle Phase 5 → StructuralAbstraction.getPendingExtractions()
//                       → LLM call → markExtracted() or markFailed()
//   LessonsStore → stores structuralPattern + patternStatus
//   PatternMatcher → compares patterns for similar_to edges
// ============================================================

'use strict';

const { NullBus } = require('../core/EventBus');
const { createLogger } = require('../core/Logger');
const _log = createLogger('StructuralAbstraction');

const MAX_RETRIES = 3;
const MAX_RETRIES_LOW_CONF = 2;

/** @typedef {'pending'|'extracted'|'failed'|'obsolete'|'contradiction'|'stale'} PatternStatus */
/** @typedef {'llm-timeout'|'parse-error'|'low-confidence'|'contradicts-existing'} FailureReason */

class StructuralAbstraction {
  static containerConfig = {
    name: 'structuralAbstraction',
    phase: 9,
    deps: [],
    tags: ['cognitive', 'learning', 'abstraction'],
    lateBindings: [
      { prop: 'lessonsStore', service: 'lessonsStore', optional: true },
    ],
  };

  /**
   * @param {{ bus?: object, config?: object }} opts
   */
  constructor({ bus, config } = {}) {
    this.bus = bus || NullBus;
    this.lessonsStore = null;

    // ── Extraction queue ────────────────────────────────
    /** @type {Map<string, { lessonId: string, text: string, category: string, status: PatternStatus, retries: number, lastFailure: FailureReason | null, pattern: object | null, queuedAt: number }>} */
    this._queue = new Map();
  }

  // ════════════════════════════════════════════════════════
  // QUEUE MANAGEMENT
  // ════════════════════════════════════════════════════════

  /**
   * Queue a lesson for pattern extraction.
   * Called when a new lesson is created — extraction happens in DreamCycle.
   * @param {{ lessonId: string, text: string, category: string }} item
   */
  queueExtraction(item) {
    if (this._queue.has(item.lessonId)) return; // Already queued
    this._queue.set(item.lessonId, {
      lessonId: item.lessonId,
      text: item.text,
      category: item.category,
      status: 'pending',
      retries: 0,
      lastFailure: null,
      pattern: null,
      queuedAt: Date.now(),
    });
    _log.debug(`[ABSTRACTION] Queued extraction for ${item.lessonId}`);
  }

  /**
   * Get all pending extractions for DreamCycle processing.
   * @returns {Array<{ lessonId: string, text: string, category: string, retries: number, lastFailure: string | null }>}
   */
  getPendingExtractions() {
    const pending = [];
    for (const [, entry] of this._queue) {
      if (entry.status === 'pending' || entry.status === 'stale') {
        pending.push({
          lessonId: entry.lessonId,
          text: entry.text,
          category: entry.category,
          retries: entry.retries,
          lastFailure: entry.lastFailure,
        });
      }
    }
    return pending;
  }

  /**
   * Mark a lesson's pattern as successfully extracted.
   * @param {string} lessonId
   * @param {object} pattern - The extracted structuralPattern
   */
  markExtracted(lessonId, pattern) {
    const entry = this._queue.get(lessonId);
    if (!entry) return;
    entry.status = 'extracted';
    entry.pattern = pattern;
    _log.info(`[ABSTRACTION] Extracted pattern for ${lessonId}`);
    this.bus.emit('abstraction:extracted', { lessonId, category: entry.category }, { source: 'StructuralAbstraction' });
  }

  /**
   * Mark a lesson's extraction as failed with typed reason.
   * @param {string} lessonId
   * @param {FailureReason} reason
   */
  markFailed(lessonId, reason) {
    const entry = this._queue.get(lessonId);
    if (!entry) return;

    entry.retries++;
    entry.lastFailure = reason;

    // contradicts-existing: no retry, mark as contradiction
    if (reason === 'contradicts-existing') {
      entry.status = 'contradiction';
      _log.warn(`[ABSTRACTION] Contradiction for ${lessonId} — no retry`);
      this.bus.emit('abstraction:contradiction', { lessonId, category: entry.category }, { source: 'StructuralAbstraction' });
      return;
    }

    // Check retry limits
    const maxRetries = reason === 'low-confidence' ? MAX_RETRIES_LOW_CONF : MAX_RETRIES;
    if (entry.retries >= maxRetries) {
      entry.status = 'obsolete';
      _log.warn(`[ABSTRACTION] ${lessonId} marked obsolete after ${entry.retries} failures (last: ${reason})`);
      this.bus.emit('abstraction:obsolete', { lessonId, retries: entry.retries, lastReason: reason }, { source: 'StructuralAbstraction' });
    } else {
      entry.status = 'pending'; // Re-queue for retry
      _log.info(`[ABSTRACTION] ${lessonId} failed (${reason}), retry ${entry.retries}/${maxRetries}`);
    }
  }

  /**
   * Mark a lesson's pattern as stale (needs re-extraction).
   * Called by GoalSynthesizer when lesson exists but doesn't help.
   * @param {string} lessonId
   */
  markStale(lessonId) {
    const entry = this._queue.get(lessonId);
    if (entry) {
      entry.status = 'stale';
      entry.retries = 0; // Reset retries for re-extraction
      _log.info(`[ABSTRACTION] ${lessonId} marked stale — will re-extract`);
    }
  }

  /**
   * Get the extraction status for a specific lesson.
   * @param {string} lessonId
   * @returns {{ status: string, retries: number, lastFailure: string | null, pattern: object | null } | null}
   */
  getExtractionStatus(lessonId) {
    const entry = this._queue.get(lessonId);
    if (!entry) return null;
    return {
      status: entry.status,
      retries: entry.retries,
      lastFailure: entry.lastFailure,
      pattern: entry.pattern,
    };
  }

  /** Get overall statistics */
  getStats() {
    let pending = 0, extracted = 0, failed = 0, obsolete = 0, stale = 0, contradiction = 0;
    for (const [, entry] of this._queue) {
      switch (entry.status) {
        case 'pending': pending++; break;
        case 'extracted': extracted++; break;
        case 'failed': failed++; break;
        case 'obsolete': obsolete++; break;
        case 'stale': stale++; break;
        case 'contradiction': contradiction++; break;
      }
    }
    return { pending, extracted, failed, obsolete, stale, contradiction, total: this._queue.size };
  }
}

module.exports = { StructuralAbstraction };
