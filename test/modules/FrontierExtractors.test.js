// ============================================================
// Test: FrontierExtractors.js — v7.1.6 Persistent Self
//
// Tests the three extractor/merger functions and their
// integration with FrontierWriter configurations.
//
// Groups:
//   A. unfinishedWorkExtractor  (5 tests)
//   B. suspicionExtractor       (3 tests)
//   C. suspicionMerger           (2 tests)
//   D. lessonExtractor           (3 tests)
//   E. LessonsStore.recall() event emission (2 tests)
// ============================================================

const { describe, test, assert, assertEqual, run } = require('../harness');
const {
  unfinishedWorkExtractor,
  suspicionExtractor,
  suspicionMerger,
  lessonExtractor,
} = require('../../src/agent/organism/FrontierExtractors');

// ── A. unfinishedWorkExtractor ──────────────────────────────

describe('unfinishedWorkExtractor', () => {

  test('extracts unfinished text and pending goals', () => {
    const result = unfinishedWorkExtractor({
      session: {
        messageCount: 15,
        unfinishedWork: 'Multi-file refactor still in progress',
        codeFilesModified: ['src/agent/core/EventBus.js', 'src/agent/core/Container.js'],
        topicsDiscussed: ['refactoring', 'testing'],
      },
      goalStack: {
        getAll: () => [
          { description: 'Refactor EventBus listeners', status: 'active', completedSteps: 3, totalSteps: 5 },
          { description: 'Add tests', status: 'completed', completedSteps: 2, totalSteps: 2 },
        ],
      },
    });

    assert(result !== null, 'should return props');
    assertEqual(result.description, 'Multi-file refactor still in progress');
    assertEqual(result.pending_goals.length, 1); // only active, not completed
    assertEqual(result.pending_goals[0].status, 'active');
    assertEqual(result.pending_goals[0].progress, 0.6); // 3/5
    assertEqual(result.priority, 'high'); // progress > 0.5
    assertEqual(result.files_in_progress.length, 2);
  });

  test('returns null for short sessions (< 3 messages)', () => {
    const result = unfinishedWorkExtractor({
      session: { messageCount: 2, unfinishedWork: 'something' },
    });
    assertEqual(result, null);
  });

  test('returns null when no unfinished work and no pending goals', () => {
    const result = unfinishedWorkExtractor({
      session: { messageCount: 10, unfinishedWork: null, codeFilesModified: [] },
      goalStack: { getAll: () => [{ status: 'completed' }] },
    });
    assertEqual(result, null);
  });

  test('returns null when unfinished text is "none"', () => {
    const result = unfinishedWorkExtractor({
      session: { messageCount: 10, unfinishedWork: 'none.' },
      goalStack: { getAll: () => [] },
    });
    assertEqual(result, null);
  });

  test('works without goalStack', () => {
    const result = unfinishedWorkExtractor({
      session: {
        messageCount: 5,
        unfinishedWork: 'Need to finish testing',
        codeFilesModified: [],
        topicsDiscussed: [],
      },
    });
    assert(result !== null, 'should return props');
    assertEqual(result.pending_goals.length, 0);
    assertEqual(result.priority, 'normal');
  });
});

// ── B. suspicionExtractor ───────────────────────────────────

describe('suspicionExtractor', () => {

  test('extracts novel events with dominant category', () => {
    const result = suspicionExtractor({
      novelEvents: [
        { description: 'Unexpected failure', surprise: 1.8, category: 'code-gen' },
        { description: 'Model timeout', surprise: 1.6, category: 'code-gen' },
        { description: 'Strange output', surprise: 2.0, category: 'analysis' },
      ],
    });

    assert(result !== null, 'should return props');
    assertEqual(result.count, 3);
    assertEqual(result.dominant_category, 'code-gen'); // 2 vs 1
    assertEqual(result.novel_events.length, 3);
  });

  test('returns null for empty events', () => {
    assertEqual(suspicionExtractor({ novelEvents: [] }), null);
    assertEqual(suspicionExtractor({}), null);
  });

  test('caps novel_events at 10', () => {
    const events = Array.from({ length: 15 }, (_, i) => ({
      description: `event-${i}`, surprise: 1.5, category: 'test',
    }));
    const result = suspicionExtractor({ novelEvents: events });
    assertEqual(result.novel_events.length, 10);
    assertEqual(result.count, 15); // total count preserved
  });
});

// ── C. suspicionMerger ──────────────────────────────────────

describe('suspicionMerger', () => {

  test('merges when same dominant_category', () => {
    const existing = { dominant_category: 'code-gen', count: 3, novel_events: [{ d: 'a' }, { d: 'b' }] };
    const incoming = { dominant_category: 'code-gen', count: 2, novel_events: [{ d: 'c' }] };

    const result = suspicionMerger(existing, incoming);
    assert(result !== null, 'should merge');
    assertEqual(result.count, 5); // 3 + 2
    assertEqual(result.novel_events.length, 3); // a, b, c
  });

  test('returns null for different categories', () => {
    const existing = { dominant_category: 'code-gen', count: 3 };
    const incoming = { dominant_category: 'analysis', count: 2 };

    assertEqual(suspicionMerger(existing, incoming), null);
  });
});

// ── D. lessonExtractor ──────────────────────────────────────

describe('lessonExtractor', () => {

  test('extracts applied lessons with deduplication', () => {
    const result = lessonExtractor({
      appliedLessons: [
        { id: 'L1', category: 'code-gen', insight: 'Step-by-step works better' },
        { id: 'L2', category: 'debug', insight: 'Check logs first' },
        { id: 'L1', category: 'code-gen', insight: 'Step-by-step works better' }, // duplicate
      ],
    });

    assert(result !== null, 'should return props');
    assertEqual(result.count, 2); // deduplicated
    assertEqual(result.applied.length, 2);
    assertEqual(result.categories.length, 2); // code-gen, debug
  });

  test('returns null for empty lessons', () => {
    assertEqual(lessonExtractor({ appliedLessons: [] }), null);
    assertEqual(lessonExtractor({}), null);
  });

  test('caps applied at 10', () => {
    const lessons = Array.from({ length: 15 }, (_, i) => ({
      id: `L${i}`, category: 'test', insight: `lesson ${i}`,
    }));
    const result = lessonExtractor({ appliedLessons: lessons });
    assertEqual(result.applied.length, 10);
    assertEqual(result.count, 15); // total unique count
  });
});

// ── E. LessonsStore.recall() event emission ─────────────────

describe('LessonsStore lesson:applied emission', () => {

  test('recall() emits lesson:applied for each result', () => {
    // Minimal LessonsStore mock to test the event emission
    const { LessonsStore } = require('../../src/agent/cognitive/LessonsStore');
    const events = [];
    const bus = {
      emit(event, data, opts) { events.push({ event, data, opts }); },
      on() { return () => {}; },
    };
    const store = new LessonsStore({ bus, storage: null });

    // Manually add test lessons
    store._lessons = [
      {
        id: 'test-1', category: 'code-gen', insight: 'Use step-by-step',
        strategy: 'decompose', evidence: { confidence: 0.8, surpriseScore: 0.5, sampleSize: 10 },
        tags: ['test'], useCount: 0, lastUsed: 0, created: Date.now(),
        source: 'manual',
      },
      {
        id: 'test-2', category: 'debug', insight: 'Check logs first',
        strategy: 'log-check', evidence: { confidence: 0.9, surpriseScore: 0.3, sampleSize: 20 },
        tags: ['test'], useCount: 0, lastUsed: 0, created: Date.now(),
        source: 'manual',
      },
    ];

    const results = store.recall('code-gen', {}, 5);
    assert(results.length >= 1, 'should recall at least 1 lesson');

    const appliedEvents = events.filter(e => e.event === 'lesson:applied');
    assertEqual(appliedEvents.length, results.length);
    assert(appliedEvents[0].data.id !== undefined, 'event should have lesson id');
    assert(appliedEvents[0].data.category !== undefined, 'event should have category');
  });

  test('recall() emits nothing when no lessons match', () => {
    const { LessonsStore } = require('../../src/agent/cognitive/LessonsStore');
    const events = [];
    const bus = {
      emit(event, data, opts) { events.push({ event, data, opts }); },
      on() { return () => {}; },
    };
    const store = new LessonsStore({ bus, storage: null });
    store._lessons = []; // empty

    const results = store.recall('code-gen');
    assertEqual(results.length, 0);

    const appliedEvents = events.filter(e => e.event === 'lesson:applied');
    assertEqual(appliedEvents.length, 0);
  });
});

run();
