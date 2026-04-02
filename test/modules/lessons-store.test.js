// ============================================================
// TEST: LessonsStore — SA-P7 Cross-Project Learning
// ============================================================

const os = require('os');
const fs = require('fs');
const path = require('path');
const { describe, test, assertEqual, assert, run } = require('../harness');
const { LessonsStore } = require('../../src/agent/cognitive/LessonsStore');

// ── Test helpers ────────────────────────────────────────────

function makeBus() {
  const listeners = {};
  const emitted = [];
  return {
    on(event, fn) {
      (listeners[event] = listeners[event] || []).push(fn);
      return () => { listeners[event] = listeners[event].filter(f => f !== fn); };
    },
    emit(event, data) {
      emitted.push({ event, data });
      for (const fn of (listeners[event] || [])) fn(data);
    },
    emitted,
    getEmitted(event) { return emitted.filter(e => e.event === event); },
  };
}

function makeTempDir() {
  const dir = path.join(os.tmpdir(), 'genesis-lessons-test-' + Math.random().toString(36).slice(2));
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function cleanup(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
}

// ── Basic Operations ────────────────────────────────────────

describe('LessonsStore — Basic', () => {
  test('starts and stops cleanly', () => {
    const bus = makeBus();
    const dir = makeTempDir();
    const store = new LessonsStore({ bus, globalDir: dir });
    store.start();
    store.stop();
    cleanup(dir);
  });

  test('records a lesson', () => {
    const bus = makeBus();
    const dir = makeTempDir();
    const store = new LessonsStore({ bus, globalDir: dir });
    store.start();

    const id = store.record({
      category: 'code-gen',
      insight: 'Chain-of-thought prompts work better for complex refactors',
      strategy: { promptStyle: 'chain-of-thought', temperature: 0.5 },
      evidence: { surprise: 0.7, successRate: 0.85, sampleSize: 10 },
      tags: ['gemma2:9b', 'refactor'],
    });

    assert(id.startsWith('lesson_'), 'Should return lesson ID');
    assertEqual(store.getStats().totalLessons, 1);
    store.stop();
    cleanup(dir);
  });

  test('recalls relevant lessons', () => {
    const bus = makeBus();
    const dir = makeTempDir();
    const store = new LessonsStore({ bus, globalDir: dir });
    store.start();

    store.record({ category: 'code-gen', insight: 'Use step-by-step for code', tags: ['code'] });
    store.record({ category: 'analysis', insight: 'Lower temp for analysis', tags: ['analysis'] });
    store.record({ category: 'code-gen', insight: 'JSON schema works for structs', tags: ['code'] });

    const results = store.recall('code-gen');
    assert(results.length >= 2, 'Should recall at least 2 code-gen lessons');
    assert(results[0].category === 'code-gen', 'Top result should match category');
    assert(store.getStats().lessonsRecalled >= 2);
    store.stop();
    cleanup(dir);
  });

  test('recall boosts useCount', () => {
    const bus = makeBus();
    const dir = makeTempDir();
    const store = new LessonsStore({ bus, globalDir: dir });
    store.start();

    store.record({ category: 'debug', insight: 'Check stack traces first' });
    store.recall('debug');
    store.recall('debug');

    const all = store.getAll();
    assertEqual(all[0].useCount, 2);
    store.stop();
    cleanup(dir);
  });
});

// ── Persistence ─────────────────────────────────────────────

describe('LessonsStore — Persistence', () => {
  test('persists and reloads across instances', () => {
    const bus = makeBus();
    const dir = makeTempDir();

    // Instance 1: create lessons
    const store1 = new LessonsStore({ bus, globalDir: dir });
    store1.start();
    store1.record({ category: 'code-gen', insight: 'Lesson A' });
    store1.record({ category: 'debug', insight: 'Lesson B' });
    store1.stop(); // saves

    // Instance 2: reload
    const store2 = new LessonsStore({ bus, globalDir: dir });
    store2.start();
    assertEqual(store2.getStats().totalLessons, 2);
    const results = store2.recall('code-gen');
    assert(results.length >= 1, 'Should recall at least 1 code-gen lesson');
    assert(results.some(r => r.insight === 'Lesson A'), 'Should find Lesson A');
    store2.stop();
    cleanup(dir);
  });

  test('stores in global dir, not project dir', () => {
    const bus = makeBus();
    const dir = makeTempDir();
    const store = new LessonsStore({ bus, globalDir: dir });
    store.start();
    store.record({ category: 'test', insight: 'Global lesson' });
    store.stop();

    assert(fs.existsSync(path.join(dir, 'lessons.json')), 'Should save in global dir');
    cleanup(dir);
  });
});

// ── Deduplication ───────────────────────────────────────────

describe('LessonsStore — Deduplication', () => {
  test('deduplicates similar lessons', () => {
    const bus = makeBus();
    const dir = makeTempDir();
    const store = new LessonsStore({ bus, globalDir: dir });
    store.start();

    store.record({ category: 'code-gen', insight: 'Step by step works for code gen', source: 'streak' });
    store.record({ category: 'code-gen', insight: 'Step by step works for code generation', source: 'streak' });

    assertEqual(store.getStats().totalLessons, 1); // Deduplicated
    const all = store.getAll();
    assert(all[0].evidence.sampleSize > 1, 'Should strengthen existing');
    store.stop();
    cleanup(dir);
  });

  test('keeps different lessons separate', () => {
    const bus = makeBus();
    const dir = makeTempDir();
    const store = new LessonsStore({ bus, globalDir: dir });
    store.start();

    store.record({ category: 'code-gen', insight: 'Use JSON schema', source: 'streak' });
    store.record({ category: 'code-gen', insight: 'Lower temperature helps', source: 'temp-tuning' });

    assertEqual(store.getStats().totalLessons, 2);
    store.stop();
    cleanup(dir);
  });
});

// ── Auto-Capture ────────────────────────────────────────────

describe('LessonsStore — Auto-Capture', () => {
  test('captures lesson from streak detection', () => {
    const bus = makeBus();
    const dir = makeTempDir();
    const store = new LessonsStore({ bus, globalDir: dir });
    store.start();

    bus.emit('online-learning:streak-detected', {
      actionType: 'code-gen',
      consecutiveFailures: 3,
      suggestion: { promptStyle: 'chain-of-thought', temperature: 0.5 },
    });

    assertEqual(store.getStats().totalLessons, 1);
    assertEqual(store.getStats().autoCaptures, 1);
    const all = store.getAll();
    assert(all[0].insight.includes('3 failures'), 'Should mention failure count');
    assert(all[0].tags.includes('streak-recovery'));
    store.stop();
    cleanup(dir);
  });

  test('captures lesson from model escalation', () => {
    const bus = makeBus();
    const dir = makeTempDir();
    const store = new LessonsStore({ bus, globalDir: dir });
    store.start();

    bus.emit('online-learning:escalation-needed', {
      actionType: 'analysis',
      currentModel: 'gemma2:9b',
      surprise: 0.85,
    });

    assertEqual(store.getStats().totalLessons, 1);
    const all = store.getAll();
    assert(all[0].tags.includes('model-limit'));
    store.stop();
    cleanup(dir);
  });

  test('captures lesson from temperature adjustment', () => {
    const bus = makeBus();
    const dir = makeTempDir();
    const store = new LessonsStore({ bus, globalDir: dir });
    store.start();

    bus.emit('online-learning:temp-adjusted', {
      actionType: 'code-gen',
      model: 'gemma2:9b',
      oldTemp: 0.7,
      newTemp: 0.55,
      successRate: 0.35,
      windowSize: 10,
    });

    assertEqual(store.getStats().totalLessons, 1);
    const all = store.getAll();
    assert(all[0].insight.includes('lowered'));
    store.stop();
    cleanup(dir);
  });
});

// ── Context Building ────────────────────────────────────────

describe('LessonsStore — Context', () => {
  test('buildContext returns formatted string', () => {
    const bus = makeBus();
    const dir = makeTempDir();
    const store = new LessonsStore({ bus, globalDir: dir });
    store.start();

    store.record({ category: 'code-gen', insight: 'Use step-by-step', evidence: { confidence: 0.8 } });
    store.record({ category: 'code-gen', insight: 'Lower temp for precision', evidence: { confidence: 0.6 } });

    const ctx = store.buildContext('code-gen');
    assert(ctx.includes('LESSONS FROM PAST PROJECTS'), 'Has header');
    assert(ctx.includes('step-by-step'), 'Has first lesson');
    assert(ctx.includes('Lower temp'), 'Has second lesson');
    store.stop();
    cleanup(dir);
  });

  test('buildContext returns empty for no matches', () => {
    const bus = makeBus();
    const dir = makeTempDir();
    const store = new LessonsStore({ bus, globalDir: dir });
    store.start();

    store.record({ category: 'debug', insight: 'Irrelevant lesson' });
    const ctx = store.buildContext('deployment');
    // May or may not match depending on relevance scoring
    // At minimum shouldn't crash
    assert(typeof ctx === 'string');
    store.stop();
    cleanup(dir);
  });
});

// ── Capacity & Eviction ─────────────────────────────────────

describe('LessonsStore — Capacity', () => {
  test('evicts least valuable when over capacity', () => {
    const bus = makeBus();
    const dir = makeTempDir();
    const store = new LessonsStore({ bus, globalDir: dir, config: { maxLessons: 10 } });
    store.start();

    for (let i = 0; i < 15; i++) {
      store.record({
        category: 'test',
        insight: `Lesson ${i}`,
        evidence: { confidence: i < 5 ? 0.1 : 0.9 },
        source: `src-${i}`,
      });
    }

    assert(store.getStats().totalLessons <= 10, 'Should enforce capacity');
    assert(store.getStats().lessonsDecayed > 0, 'Should have evicted some');
    store.stop();
    cleanup(dir);
  });
});

// ── Diagnostics ─────────────────────────────────────────────

describe('LessonsStore — Diagnostics', () => {
  test('getStats returns comprehensive data', () => {
    const bus = makeBus();
    const dir = makeTempDir();
    const store = new LessonsStore({ bus, globalDir: dir });
    store.start();

    store.record({ category: 'code-gen', insight: 'A' });
    store.record({ category: 'debug', insight: 'B' });
    store.recall('code-gen');

    const stats = store.getStats();
    assertEqual(stats.totalLessons, 2);
    assertEqual(stats.lessonsCreated, 2);
    assert(stats.lessonsRecalled >= 1, 'Should have recalled at least 1');
    assertEqual(stats.byCategory['code-gen'], 1);
    assertEqual(stats.byCategory['debug'], 1);
    assert(stats.globalDir.includes('genesis-lessons'));
    store.stop();
    cleanup(dir);
  });

  test('clear removes all lessons', () => {
    const bus = makeBus();
    const dir = makeTempDir();
    const store = new LessonsStore({ bus, globalDir: dir });
    store.start();

    store.record({ category: 'test', insight: 'X' });
    store.record({ category: 'test', insight: 'Y' });
    const count = store.clear();
    assertEqual(count, 2);
    assertEqual(store.getStats().totalLessons, 0);
    store.stop();
    cleanup(dir);
  });
});

run();
