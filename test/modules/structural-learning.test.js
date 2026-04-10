#!/usr/bin/env node
// ============================================================
// TEST — PatternMatcher + StructuralAbstraction (v7.0.9 Phase 3)
//
// Tests structural pattern matching for cross-context lesson
// retrieval and LLM-deferred pattern extraction.
// ============================================================

const { describe, test, assert, assertEqual, run } = require('../harness');

// ════════════════════════════════════════════════════════
// PatternMatcher — Jaccard similarity on structural patterns
// ════════════════════════════════════════════════════════

describe('PatternMatcher — similarity', () => {
  test('identical patterns score 1.0', () => {
    const { PatternMatcher } = require('../../src/agent/cognitive/PatternMatcher');
    const pm = new PatternMatcher();

    const p1 = {
      problemStructure: { category: 'boundary-check', elements: ['conditional', 'modulo'], antiPatterns: ['off-by-one'] },
      solutionStructure: { strategy: 'test-boundaries', steps: ['identify', 'fix'] },
    };
    const score = pm.compare(p1, p1);
    assertEqual(score, 1.0);
  });

  test('similar patterns score high', () => {
    const { PatternMatcher } = require('../../src/agent/cognitive/PatternMatcher');
    const pm = new PatternMatcher();

    const p1 = {
      problemStructure: { category: 'boundary-check', elements: ['conditional', 'modulo', 'loop-counter'], antiPatterns: ['off-by-one'] },
      solutionStructure: { strategy: 'test-boundaries', steps: ['identify', 'fix'] },
    };
    const p2 = {
      problemStructure: { category: 'boundary-check', elements: ['conditional', 'modulo', 'pagination'], antiPatterns: ['off-by-one', 'exclusive-vs-inclusive'] },
      solutionStructure: { strategy: 'test-boundaries', steps: ['identify', 'test', 'fix'] },
    };
    const score = pm.compare(p1, p2);
    assert(score > 0.5, `similar patterns should score >0.5, got ${score}`);
  });

  test('unrelated patterns score low', () => {
    const { PatternMatcher } = require('../../src/agent/cognitive/PatternMatcher');
    const pm = new PatternMatcher();

    const p1 = {
      problemStructure: { category: 'boundary-check', elements: ['conditional', 'modulo'], antiPatterns: ['off-by-one'] },
      solutionStructure: { strategy: 'test-boundaries', steps: ['identify', 'fix'] },
    };
    const p2 = {
      problemStructure: { category: 'string-parsing', elements: ['regex', 'split', 'trim'], antiPatterns: ['null-input'] },
      solutionStructure: { strategy: 'input-validation', steps: ['validate', 'sanitize'] },
    };
    const score = pm.compare(p1, p2);
    assert(score < 0.3, `unrelated patterns should score <0.3, got ${score}`);
  });

  test('handles empty patterns gracefully', () => {
    const { PatternMatcher } = require('../../src/agent/cognitive/PatternMatcher');
    const pm = new PatternMatcher();
    assertEqual(pm.compare({}, {}), 0);
    assertEqual(pm.compare(null, null), 0);
  });

  test('category match boosts score', () => {
    const { PatternMatcher } = require('../../src/agent/cognitive/PatternMatcher');
    const pm = new PatternMatcher();

    const p1 = {
      problemStructure: { category: 'boundary-check', elements: ['x'], antiPatterns: [] },
      solutionStructure: { strategy: 'a', steps: [] },
    };
    const p2Same = {
      problemStructure: { category: 'boundary-check', elements: ['y'], antiPatterns: [] },
      solutionStructure: { strategy: 'b', steps: [] },
    };
    const p2Diff = {
      problemStructure: { category: 'string-parsing', elements: ['y'], antiPatterns: [] },
      solutionStructure: { strategy: 'b', steps: [] },
    };

    const scoreSame = pm.compare(p1, p2Same);
    const scoreDiff = pm.compare(p1, p2Diff);
    assert(scoreSame > scoreDiff, 'same category should score higher');
  });
});

// ════════════════════════════════════════════════════════
// StructuralAbstraction — pattern extraction lifecycle
// ════════════════════════════════════════════════════════

describe('StructuralAbstraction — lifecycle', () => {
  test('creates with pending status', () => {
    const { StructuralAbstraction } = require('../../src/agent/cognitive/StructuralAbstraction');
    const sa = new StructuralAbstraction({ bus: { emit() {}, on() { return () => {}; } } });
    const stats = sa.getStats();
    assertEqual(stats.pending, 0);
    assertEqual(stats.extracted, 0);
    assertEqual(stats.failed, 0);
  });

  test('queueExtraction adds to pending', () => {
    const { StructuralAbstraction } = require('../../src/agent/cognitive/StructuralAbstraction');
    const sa = new StructuralAbstraction({ bus: { emit() {}, on() { return () => {}; } } });

    sa.queueExtraction({
      lessonId: 'lesson-1',
      text: 'FizzBuzz had off-by-one in modulo check',
      category: 'boundary-check',
    });

    assertEqual(sa.getStats().pending, 1);
  });

  test('getPendingExtractions returns queued items', () => {
    const { StructuralAbstraction } = require('../../src/agent/cognitive/StructuralAbstraction');
    const sa = new StructuralAbstraction({ bus: { emit() {}, on() { return () => {}; } } });

    sa.queueExtraction({ lessonId: 'lesson-1', text: 'test', category: 'test' });
    sa.queueExtraction({ lessonId: 'lesson-2', text: 'test2', category: 'test' });

    const pending = sa.getPendingExtractions();
    assertEqual(pending.length, 2);
  });

  test('markExtracted removes from pending', () => {
    const { StructuralAbstraction } = require('../../src/agent/cognitive/StructuralAbstraction');
    const sa = new StructuralAbstraction({ bus: { emit() {}, on() { return () => {}; } } });

    sa.queueExtraction({ lessonId: 'lesson-1', text: 'test', category: 'test' });
    sa.markExtracted('lesson-1', { category: 'test', elements: ['x'] });

    assertEqual(sa.getStats().pending, 0);
    assertEqual(sa.getStats().extracted, 1);
  });

  test('markFailed tracks failure reason', () => {
    const { StructuralAbstraction } = require('../../src/agent/cognitive/StructuralAbstraction');
    const sa = new StructuralAbstraction({ bus: { emit() {}, on() { return () => {}; } } });

    sa.queueExtraction({ lessonId: 'lesson-1', text: 'test', category: 'test' });
    sa.markFailed('lesson-1', 'llm-timeout');

    // After 1 failure: goes back to pending for retry, not "failed"
    const status = sa.getExtractionStatus('lesson-1');
    assertEqual(status.retries, 1);
    assertEqual(status.lastFailure, 'llm-timeout');
    assertEqual(status.status, 'pending'); // queued for retry
  });

  test('markFailed increments retry count', () => {
    const { StructuralAbstraction } = require('../../src/agent/cognitive/StructuralAbstraction');
    const sa = new StructuralAbstraction({ bus: { emit() {}, on() { return () => {}; } } });

    sa.queueExtraction({ lessonId: 'lesson-1', text: 'test', category: 'test' });
    sa.markFailed('lesson-1', 'llm-timeout');
    sa.markFailed('lesson-1', 'parse-error');
    sa.markFailed('lesson-1', 'llm-timeout');

    // After 3 failures: should be marked obsolete
    const status = sa.getExtractionStatus('lesson-1');
    assertEqual(status.retries, 3);
    assertEqual(status.status, 'obsolete');
  });

  test('contradicts-existing does not retry', () => {
    const { StructuralAbstraction } = require('../../src/agent/cognitive/StructuralAbstraction');
    const sa = new StructuralAbstraction({ bus: { emit() {}, on() { return () => {}; } } });

    sa.queueExtraction({ lessonId: 'lesson-1', text: 'test', category: 'test' });
    sa.markFailed('lesson-1', 'contradicts-existing');

    const status = sa.getExtractionStatus('lesson-1');
    assertEqual(status.status, 'contradiction');
    // Should NOT be in pending anymore
    assertEqual(sa.getPendingExtractions().length, 0);
  });
});

run();
