// ============================================================
// TEST — LessonsStore Deep Logic (v7.0.5)
// Covers: _similarity, _findDuplicate, _evictLeastValuable,
//         _scoreRelevance, updateLessonOutcome, _save/_load roundtrip
// ============================================================

const { describe, test, assert, assertEqual, run } = require('../harness');
const { LessonsStore } = require('../../src/agent/cognitive/LessonsStore');
const path = require('path');
const os = require('os');
const fs = require('fs');

function mockBus() {
  return { on: () => () => {}, emit() {}, fire() {} };
}

function tmpDir() {
  const dir = path.join(os.tmpdir(), `genesis-lessons-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function createStore(overrides = {}) {
  const dir = overrides.dataDir || tmpDir();
  return new LessonsStore({
    bus: mockBus(),
    dataDir: dir,
    config: { maxLessons: overrides.maxLessons || 50, decayDays: overrides.decayDays || 90 },
    ...overrides,
  });
}

function makeLesson(overrides = {}) {
  return {
    category: 'code-gen',
    insight: 'Breaking tasks into sub-steps improves success rate',
    strategy: 'step-by-step decomposition',
    evidence: { surpriseScore: 0.8, successRate: 0.7, sampleSize: 10, confidence: 0.6 },
    tags: ['code', 'kimi-k2.5'],
    ...overrides,
  };
}

// ════════════════════════════════════════════════════════════
// _similarity — Jaccard-like word overlap scoring
// ════════════════════════════════════════════════════════════

describe('LessonsStore — _similarity', () => {
  test('identical strings return 1.0', () => {
    const store = createStore();
    assertEqual(store._similarity('hello world', 'hello world'), 1);
  });

  test('completely different strings return 0', () => {
    const store = createStore();
    const score = store._similarity('alpha beta gamma', 'delta epsilon zeta');
    assertEqual(score, 0);
  });

  test('partial overlap returns fraction', () => {
    const store = createStore();
    const score = store._similarity('hello world foo', 'hello world bar');
    // overlap: hello, world (2) / max(3, 3) = 0.666...
    assert(score > 0.5 && score < 0.8, `Expected ~0.67, got ${score}`);
  });

  test('null inputs return 0', () => {
    const store = createStore();
    assertEqual(store._similarity(null, 'hello'), 0);
    assertEqual(store._similarity('hello', null), 0);
    assertEqual(store._similarity(null, null), 0);
  });

  test('case insensitive', () => {
    const store = createStore();
    assertEqual(store._similarity('Hello World', 'hello world'), 1);
  });
});

// ════════════════════════════════════════════════════════════
// _findDuplicate — Deduplication by category + insight similarity
// ════════════════════════════════════════════════════════════

describe('LessonsStore — _findDuplicate', () => {
  test('finds duplicate with same category and similar insight', () => {
    const store = createStore();
    const existing = makeLesson({ insight: 'Breaking tasks into steps improves quality' });
    existing.id = 'existing-1';
    store._lessons = [existing];

    const newLesson = makeLesson({ insight: 'Breaking tasks into steps improves success rate' });
    const dup = store._findDuplicate(newLesson);
    assert(dup !== undefined, 'Should find duplicate');
    assertEqual(dup.id, 'existing-1');
  });

  test('no duplicate for different category', () => {
    const store = createStore();
    store._lessons = [makeLesson({ category: 'debug', insight: 'same insight here' })];
    const dup = store._findDuplicate(makeLesson({ category: 'code-gen', insight: 'same insight here' }));
    assert(dup === undefined, 'Different category should not match');
  });

  test('no duplicate for low similarity', () => {
    const store = createStore();
    store._lessons = [makeLesson({ insight: 'Use async patterns for IO operations' })];
    const dup = store._findDuplicate(makeLesson({ insight: 'Refactor database schema for performance' }));
    assert(dup === undefined, 'Low similarity should not match');
  });
});

// ════════════════════════════════════════════════════════════
// _evictLeastValuable — Bottom 10% removal by value score
// ════════════════════════════════════════════════════════════

describe('LessonsStore — _evictLeastValuable', () => {
  test('removes bottom 10% of lessons', () => {
    const store = createStore();
    // Create 20 lessons with varying quality
    store._lessons = [];
    for (let i = 0; i < 20; i++) {
      store._lessons.push({
        id: `lesson-${i}`,
        category: 'code-gen',
        insight: `Lesson ${i}`,
        evidence: { confidence: i < 5 ? 0.1 : 0.9, sampleSize: 10 },
        useCount: i < 5 ? 0 : 5,
        lastUsed: i < 5 ? Date.now() - 200 * 86400000 : Date.now(), // old vs recent
        tags: [],
      });
    }
    store._stats = { lessonsDecayed: 0 };
    store._evictLeastValuable();
    // Should remove ceil(20 * 0.1) = 2 lessons
    assertEqual(store._lessons.length, 18);
    assertEqual(store._stats.lessonsDecayed, 2);
  });

  test('evicts low-confidence old lessons first', () => {
    const store = createStore();
    store._lessons = [
      { id: 'bad', evidence: { confidence: 0.1 }, useCount: 0, lastUsed: Date.now() - 365 * 86400000, tags: [] },
      { id: 'good', evidence: { confidence: 0.9 }, useCount: 10, lastUsed: Date.now(), tags: [] },
    ];
    store._stats = { lessonsDecayed: 0 };
    store._evictLeastValuable();
    // ceil(2 * 0.1) = 1 removed — should be the bad one
    assertEqual(store._lessons.length, 1);
    assertEqual(store._lessons[0].id, 'good');
  });
});

// ════════════════════════════════════════════════════════════
// _scoreRelevance — Multi-signal relevance scoring
// ════════════════════════════════════════════════════════════

describe('LessonsStore — _scoreRelevance', () => {
  test('category match boosts score', () => {
    const store = createStore();
    const lesson = { category: 'code-gen', tags: [], evidence: { confidence: 0.5 }, lastUsed: Date.now() };
    const score = store._scoreRelevance(lesson, 'code-gen', {});
    assert(score >= 0.4, `Category match should give ≥0.4, got ${score}`);
  });

  test('general category gives small boost', () => {
    const store = createStore();
    const lesson = { category: 'general', tags: [], evidence: { confidence: 0.5 }, lastUsed: Date.now() };
    const score = store._scoreRelevance(lesson, 'code-gen', {});
    assert(score > 0 && score < 0.4, `General should give small boost, got ${score}`);
  });

  test('tag overlap increases score', () => {
    const store = createStore();
    const lesson = { category: 'code-gen', tags: ['javascript', 'refactor'], evidence: { confidence: 0.5 }, lastUsed: Date.now() };
    const withTags = store._scoreRelevance(lesson, 'code-gen', { tags: ['javascript', 'refactor'] });
    const noTags = store._scoreRelevance(lesson, 'code-gen', {});
    assert(withTags > noTags, `Tag overlap should increase score: ${withTags} vs ${noTags}`);
  });

  test('model match increases score', () => {
    const store = createStore();
    const lesson = { category: 'code-gen', tags: ['kimi-k2.5'], evidence: { confidence: 0.5 }, lastUsed: Date.now() };
    const withModel = store._scoreRelevance(lesson, 'code-gen', { model: 'kimi-k2.5' });
    const noModel = store._scoreRelevance(lesson, 'code-gen', {});
    assert(withModel > noModel, `Model match should boost: ${withModel} vs ${noModel}`);
  });

  test('old lessons decay', () => {
    const store = createStore({ decayDays: 90 });
    const recentLesson = { category: 'code-gen', tags: [], evidence: { confidence: 0.5 }, lastUsed: Date.now() };
    const oldLesson = { category: 'code-gen', tags: [], evidence: { confidence: 0.5 }, lastUsed: Date.now() - 120 * 86400000 };
    const recent = store._scoreRelevance(recentLesson, 'code-gen', {});
    const old = store._scoreRelevance(oldLesson, 'code-gen', {});
    assert(recent > old, `Recent should score higher: ${recent} vs ${old}`);
  });
});

// ════════════════════════════════════════════════════════════
// updateLessonOutcome — Feedback loop for lesson quality
// ════════════════════════════════════════════════════════════

describe('LessonsStore — updateLessonOutcome', () => {
  test('success increases confidence', () => {
    const store = createStore();
    const lesson = makeLesson();
    lesson.id = 'test-1';
    lesson.evidence.confidence = 0.5;
    lesson.evidence.sampleSize = 5;
    lesson.useCount = 1;
    lesson.lastUsed = Date.now() - 86400000;
    store._lessons = [lesson];

    store.updateLessonOutcome('test-1', true);
    assert(lesson.evidence.confidence > 0.5, `Confidence should increase, got ${lesson.evidence.confidence}`);
    assert(lesson.useCount > 1, 'Use count should increase');
  });

  test('failure decreases confidence', () => {
    const store = createStore();
    const lesson = makeLesson();
    lesson.id = 'test-2';
    lesson.evidence.confidence = 0.8;
    lesson.evidence.sampleSize = 10;
    lesson.useCount = 3;
    lesson.lastUsed = Date.now();
    store._lessons = [lesson];

    store.updateLessonOutcome('test-2', false);
    assert(lesson.evidence.confidence < 0.8, `Confidence should decrease, got ${lesson.evidence.confidence}`);
  });

  test('unknown lessonId is safe', () => {
    const store = createStore();
    store._lessons = [];
    // Should not throw
    store.updateLessonOutcome('nonexistent', true);
  });
});

// ════════════════════════════════════════════════════════════
// record + recall roundtrip
// ════════════════════════════════════════════════════════════

describe('LessonsStore — record/recall roundtrip', () => {
  test('recorded lesson is recallable', () => {
    const store = createStore();
    store._lessons = [];
    store._stats = { lessonsCreated: 0, lessonsRecalled: 0, lessonsDecayed: 0, duplicatesMerged: 0 };

    store.record(makeLesson({ category: 'debug', insight: 'Use bisect to find regressions' }));
    const results = store.recall('debug', {}, 5);
    assert(results.length === 1, `Expected 1 result, got ${results.length}`);
    assert(results[0].insight.includes('bisect'), 'Should recall the recorded lesson');
  });

  test('duplicate strengthens existing instead of adding', () => {
    const store = createStore();
    store._lessons = [];
    store._stats = { lessonsCreated: 0, lessonsRecalled: 0, lessonsDecayed: 0, duplicatesMerged: 0 };

    const lesson = makeLesson({ insight: 'step by step decomposition works best' });
    store.record(lesson);
    const initialConf = store._lessons[0].evidence.confidence;

    // Record near-duplicate
    store.record(makeLesson({ insight: 'step by step decomposition works well' }));
    assertEqual(store._lessons.length, 1, 'Should merge, not add');
    assert(store._lessons[0].evidence.confidence > initialConf, 'Confidence should increase on merge');
  });
});

if (require.main === module) run();
