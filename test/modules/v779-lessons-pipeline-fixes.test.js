#!/usr/bin/env node
// v7.7.9 (post-Phase-3c) — Lessons pipeline fixes from burn-in finding.
//
// Phase 3c burn-in revealed LessonsStore = 0/0/0/0 after multiple
// plan failures. The single line `if (lessonsStore.add ...)` in
// AgentLoopPursuitReflection was the keystone:
//
//   X1: add() doesn't exist on LessonsStore — record() does.
//   X2: schema used was wrong (type/trigger/error/ts instead of the
//       canonical category/insight/strategy/evidence/tags/source).
//   X3: obstacle-resolution was a recall-only category — nothing
//       was writing to it. AgentLoopRecovery._recallObstacleLessons
//       was looking up an empty namespace forever.
//   X5: NetworkSentinel called lessonsStore.flush() with optional
//       chaining; flush() didn't exist. Silent shutdown data loss
//       window of up-to-5 lessons (periodic save every 5 creates).
//   X6: classifyFailure regex was too narrow. "Plausibility check
//       failed", "verification failed", "Stopped by user" all fell
//       through to 'unclassified' and were then filtered out by
//       stableClass before reaching the store — even after X1+X2
//       were fixed, ~90% of real burn-in errors wouldn't have made
//       it through.
//
// These fixes close the lessons feedback loop: plan-failure →
// classifyFailure → recordReflection.record(category:'obstacle-
// resolution') → AgentLoopRecovery.recall finds it on the next
// attempt → planner sees the prior lesson.

'use strict';

const { describe, test, assert, run } = require('../harness');
const fs = require('fs');
const path = require('path');
const os = require('os');

const REFLECTION_PATH = path.join(__dirname, '..', '..', 'src/agent/revolution/AgentLoopPursuitReflection.js');
const LESSONS_PATH    = path.join(__dirname, '..', '..', 'src/agent/cognitive/LessonsStore.js');

const { classifyFailure, recordReflection } = require(REFLECTION_PATH);
const { LessonsStore } = require(LESSONS_PATH);

// ── helpers ─────────────────────────────────────────────────
function makeStubBus() {
  return { on: () => () => {}, fire: () => {}, _container: null };
}
function makeLessonsStore() {
  const tmpDir = path.join(os.tmpdir(),
    'genesis-test-lessons-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6));
  fs.mkdirSync(tmpDir, { recursive: true });
  const store = new LessonsStore({ bus: makeStubBus(), globalDir: tmpDir });
  store.start();
  return { store, tmpDir, cleanup: () => fs.rmSync(tmpDir, { recursive: true, force: true }) };
}

// ════════════════════════════════════════════════════════════
// X1 + X2 — recordReflection uses record() with correct schema
// ════════════════════════════════════════════════════════════
describe('X1+X2 — recordReflection writes via record() with correct schema', () => {
  test('source no longer calls lessonsStore.add()', () => {
    const src = fs.readFileSync(REFLECTION_PATH, 'utf-8');
    // Strip comments (`//` lines and `/* … */` blocks) before checking —
    // the rationale comment block in the source explains the bug fix
    // and *does* contain the string "lessonsStore.add()" in prose. The
    // contract is: no actual CODE may call .add().
    const stripped = src
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n')
      .filter(line => !line.trim().startsWith('//'))
      .join('\n');
    assert(!/lessonsStore\.add\s*\(/.test(stripped),
      'source code (non-comment) must not contain lessonsStore.add() — that method does not exist on LessonsStore');
  });

  test('source calls lessonsStore.record() instead', () => {
    const src = fs.readFileSync(REFLECTION_PATH, 'utf-8');
    assert(/lessonsStore\.record\s*\(/.test(src),
      'source must call lessonsStore.record() (the actual API)');
    assert(/typeof\s+lessonsStore\.record\s*===\s*['"]function['"]/.test(src),
      'guard must check record (the real API), not add');
  });

  test('lesson record uses LessonsStore.record() canonical fields', () => {
    const { store, cleanup } = makeLessonsStore();
    try {
      recordReflection(
        { lessonsStore: store, selfStatementLog: null },
        {
          goalId: 'g-x2',
          goalDescription: 'Test goal X2',
          errorMessage: 'Unknown step type: undefined',
          classification: 'structural',
          stepsExecuted: 4,
          innerSpeech: null,
        }
      );
      const all = store.getAll();
      assert(all.length === 1, `expected 1 lesson recorded, got ${all.length}`);
      const lesson = all[0];
      // Canonical schema: category / insight / strategy / evidence / tags / source
      assert(typeof lesson.category === 'string', 'lesson.category must be a string');
      assert(typeof lesson.insight === 'string' && lesson.insight.length > 0,
        'lesson.insight must be a non-empty string');
      assert(lesson.strategy && typeof lesson.strategy === 'object',
        'lesson.strategy must be an object');
      assert(lesson.evidence && typeof lesson.evidence === 'object',
        'lesson.evidence must be an object');
      assert(Array.isArray(lesson.tags), 'lesson.tags must be an array');
      assert(typeof lesson.source === 'string', 'lesson.source must be a string');
    } finally { cleanup(); }
  });

  test('source field identifies the producer as plan-failure-reflection', () => {
    const { store, cleanup } = makeLessonsStore();
    try {
      recordReflection(
        { lessonsStore: store, selfStatementLog: null },
        { goalId: 'g', goalDescription: 'd', errorMessage: 'Unknown step type: undefined',
          classification: 'structural', stepsExecuted: 0, innerSpeech: null }
      );
      const lesson = store.getAll()[0];
      assert(lesson.source === 'plan-failure-reflection',
        `source should be 'plan-failure-reflection', got '${lesson.source}'`);
    } finally { cleanup(); }
  });

  test('evidence.successRate is 0 (this is a failure, not a success)', () => {
    const { store, cleanup } = makeLessonsStore();
    try {
      recordReflection(
        { lessonsStore: store, selfStatementLog: null },
        { goalId: 'g', goalDescription: 'd', errorMessage: 'Unknown step type: undefined',
          classification: 'structural', stepsExecuted: 0, innerSpeech: null }
      );
      const lesson = store.getAll()[0];
      assert(lesson.evidence.successRate === 0,
        `evidence.successRate should be 0 for a failure, got ${lesson.evidence.successRate}`);
    } finally { cleanup(); }
  });
});

// ════════════════════════════════════════════════════════════
// X3 — obstacle-resolution category closes the recall loop
// ════════════════════════════════════════════════════════════
describe('X3 — obstacle-resolution category closes the read/write loop', () => {
  test('plan-failure-reflection records into obstacle-resolution category', () => {
    const { store, cleanup } = makeLessonsStore();
    try {
      recordReflection(
        { lessonsStore: store, selfStatementLog: null },
        { goalId: 'g-x3', goalDescription: 'd', errorMessage: 'Plausibility check failed',
          classification: 'structural', stepsExecuted: 2, innerSpeech: null }
      );
      const lesson = store.getAll()[0];
      assert(lesson.category === 'obstacle-resolution',
        `category should be 'obstacle-resolution' (the category AgentLoopRecovery recalls), got '${lesson.category}'`);
    } finally { cleanup(); }
  });

  test('AgentLoopRecovery.recall("obstacle-resolution") finds the recorded lesson', () => {
    const { store, cleanup } = makeLessonsStore();
    try {
      // Record three plan-failures across categories
      recordReflection(
        { lessonsStore: store, selfStatementLog: null },
        { goalId: 'g1', goalDescription: 'first', errorMessage: 'Unknown step type: undefined',
          classification: 'structural', stepsExecuted: 1, innerSpeech: null }
      );
      recordReflection(
        { lessonsStore: store, selfStatementLog: null },
        { goalId: 'g2', goalDescription: 'second', errorMessage: 'TIMEOUT POST http://x',
          classification: 'execution', stepsExecuted: 2, innerSpeech: null }
      );
      recordReflection(
        { lessonsStore: store, selfStatementLog: null },
        { goalId: 'g3', goalDescription: 'third', errorMessage: 'Plausibility check failed',
          classification: 'structural', stepsExecuted: 3, innerSpeech: null }
      );

      // Simulate AgentLoopRecovery._recallObstacleLessons
      const recalled = store.recall('obstacle-resolution', { tags: ['structural'] }, 5);
      assert(Array.isArray(recalled), 'recall must return an array');
      assert(recalled.length > 0,
        'recall("obstacle-resolution") must return the recorded plan-failure lessons — pre-fix this returned []');
    } finally { cleanup(); }
  });
});

// ════════════════════════════════════════════════════════════
// X5 — LessonsStore.flush() exists and saves
// ════════════════════════════════════════════════════════════
describe('X5 — LessonsStore.flush() exists and persists', () => {
  test('LessonsStore.flush is a function', () => {
    const { store, cleanup } = makeLessonsStore();
    try {
      assert(typeof store.flush === 'function',
        'LessonsStore must expose a public flush() method — NetworkSentinel calls it on shutdown');
    } finally { cleanup(); }
  });

  test('flush returns a promise that resolves true', async () => {
    const { store, cleanup } = makeLessonsStore();
    try {
      const result = await store.flush();
      assert(result === true, 'flush() should resolve to true on success');
    } finally { cleanup(); }
  });

  test('flush writes lessons file to disk', async () => {
    const { store, tmpDir, cleanup } = makeLessonsStore();
    try {
      // Record one lesson — periodic save fires every 5 creates so without
      // flush a single lesson would NOT be on disk.
      recordReflection(
        { lessonsStore: store, selfStatementLog: null },
        { goalId: 'g', goalDescription: 'flushtest', errorMessage: 'Unknown step type: undefined',
          classification: 'structural', stepsExecuted: 1, innerSpeech: null }
      );

      const filePath = path.join(tmpDir, 'lessons.json');
      const beforeFlush = fs.existsSync(filePath);
      await store.flush();
      const afterFlush = fs.existsSync(filePath);

      assert(afterFlush, 'lessons.json must exist on disk after flush()');
      // Don't assert beforeFlush=false: periodic save may have fired on create.
      // The point is afterFlush=true is guaranteed.
      const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      assert(Array.isArray(data.lessons), 'persisted file must contain lessons array');
      assert(data.lessons.length === 1, `expected 1 lesson persisted, got ${data.lessons.length}`);
    } finally { cleanup(); }
  });

  test('flush is idempotent (safe to call when not dirty)', async () => {
    const { store, cleanup } = makeLessonsStore();
    try {
      const a = await store.flush();
      const b = await store.flush();
      const c = await store.flush();
      assert(a === true && b === true && c === true,
        'flush() must be safe to call repeatedly');
    } finally { cleanup(); }
  });
});

// ════════════════════════════════════════════════════════════
// X6 — classifyFailure covers live-typical error patterns
// ════════════════════════════════════════════════════════════
describe('X6 — classifyFailure covers patterns from real burn-ins', () => {
  // Each row: [error message, expected classification]
  const cases = [
    // Structural — planning/schema/path issues
    ['Unknown step type: undefined', 'structural'],
    ['Plausibility check failed for: file:src/x/y.js (path does not exist)', 'structural'],
    ['implausible paths: file:foo/bar.js', 'structural'],
    ['Missing required field goalId', 'structural'],

    // Execution — LLM / verification / repair / timeout
    ['TIMEOUT POST http://127.0.0.1:11434/api/chat (180s)', 'execution'],
    ['Goal verification failed after 9 steps with 2 step error(s)', 'execution'],
    ['Verification engine returned: NO — strategy exhausted', 'execution'],

    // External — network and connectivity
    ['Network connection refused', 'external'],
    ['fetch failed: ECONNREFUSED 127.0.0.1', 'external'],

    // User-action — explicit user stop
    ['Stopped by user', 'user-action'],
    ['Goal aborted', 'user-action'],

    // Unclassified — falls through (correct behaviour for unknown shapes)
    ['', 'unclassified'],
    ['something completely unrecognised', 'unclassified'],
  ];

  for (const [errMsg, expected] of cases) {
    test(`"${errMsg.slice(0, 50)}..." → ${expected}`, () => {
      const got = classifyFailure(errMsg);
      assert(got === expected,
        `classifyFailure(${JSON.stringify(errMsg.slice(0, 40))}) expected '${expected}', got '${got}'`);
    });
  }
});

// ════════════════════════════════════════════════════════════
// stableClass filter — make sure live errors flow through
// ════════════════════════════════════════════════════════════
describe('stableClass filter — live errors now pass through to the store', () => {
  test('"Plausibility check failed" (was unclassified → filtered) now records', () => {
    const { store, cleanup } = makeLessonsStore();
    try {
      const classification = classifyFailure('Plausibility check failed for: file:x');
      assert(classification === 'structural',
        `pre-fix this was 'unclassified', got '${classification}'`);

      recordReflection(
        { lessonsStore: store, selfStatementLog: null },
        { goalId: 'g', goalDescription: 'd',
          errorMessage: 'Plausibility check failed for: file:x',
          classification, stepsExecuted: 1, innerSpeech: null }
      );
      assert(store.getAll().length === 1,
        'Plausibility check failed must produce a recorded lesson');
    } finally { cleanup(); }
  });

  test('"Goal verification failed" (was unclassified → filtered) now records', () => {
    const { store, cleanup } = makeLessonsStore();
    try {
      const classification = classifyFailure('Goal verification failed after 9 steps');
      assert(classification === 'execution',
        `pre-fix this was 'unclassified', got '${classification}'`);

      recordReflection(
        { lessonsStore: store, selfStatementLog: null },
        { goalId: 'g', goalDescription: 'd',
          errorMessage: 'Goal verification failed after 9 steps',
          classification, stepsExecuted: 9, innerSpeech: null }
      );
      assert(store.getAll().length === 1,
        'Goal verification failed must produce a recorded lesson');
    } finally { cleanup(); }
  });

  test('user-action still filtered (no lesson for explicit user stops)', () => {
    const { store, cleanup } = makeLessonsStore();
    try {
      recordReflection(
        { lessonsStore: store, selfStatementLog: null },
        { goalId: 'g', goalDescription: 'd',
          errorMessage: 'Stopped by user',
          classification: 'user-action', stepsExecuted: 0, innerSpeech: null }
      );
      assert(store.getAll().length === 0,
        'user-action must remain filtered — no lesson for user-initiated stops');
    } finally { cleanup(); }
  });
});

// ════════════════════════════════════════════════════════════
// End-to-end loop: write → recall → would-be-used in planning
// ════════════════════════════════════════════════════════════
describe('End-to-end: write side and read side use the same category', () => {
  test('same category is written by recordReflection AND recalled by AgentLoopRecovery', () => {
    // The crucial invariant: AgentLoopRecovery._recallObstacleLessons
    // calls recall('obstacle-resolution', ...). The fix in
    // recordReflection writes into the same category. This test
    // verifies the contract by inspecting source.
    const reflectionSrc = fs.readFileSync(REFLECTION_PATH, 'utf-8');
    const recoveryPath = path.join(__dirname, '..', '..', 'src/agent/revolution/AgentLoopRecovery.js');
    const recoverySrc = fs.readFileSync(recoveryPath, 'utf-8');

    const writeMatch = /category:\s*['"]obstacle-resolution['"]/.test(reflectionSrc);
    const readMatch = /recall\(\s*['"]obstacle-resolution['"]/.test(recoverySrc);

    assert(writeMatch,
      'AgentLoopPursuitReflection must write into obstacle-resolution category');
    assert(readMatch,
      'AgentLoopRecovery must recall from obstacle-resolution category');
    assert(writeMatch && readMatch,
      'BOTH sides must use the same category — this is the lessons feedback loop invariant');
  });
});

// ════════════════════════════════════════════════════════════
// v7.9.10 — gate widened: unclassified-with-content records
// ════════════════════════════════════════════════════════════
describe('v7.9.10 — LLM-verdict messages record despite unclassified bucket', () => {
  test('PARTIAL verdict message with content records a lesson', () => {
    const { store, cleanup } = makeLessonsStore();
    try {
      recordReflection(
        { lessonsStore: store, selfStatementLog: null },
        {
          goalId: 'g-verdict-1',
          goalDescription: 'Inspect AgentCore.js',
          errorMessage: 'PARTIAL, because although 2 steps were completed, the critical step failed (command on AgentCore.js) and the verification was ambiguous',
          classification: 'unclassified',
          stepsExecuted: 2,
          innerSpeech: null,
        }
      );
      const lessons = store.getAll();
      assert(lessons.length === 1, `expected 1 lesson, got ${lessons.length}`);
      assert(lessons[0].insight.includes('PARTIAL'),
        'lesson insight must include the LLM verdict text');
    } finally { cleanup(); }
  });

  test('FAILED verdict message with content records a lesson', () => {
    const { store, cleanup } = makeLessonsStore();
    try {
      recordReflection(
        { lessonsStore: store, selfStatementLog: null },
        {
          goalId: 'g-verdict-2',
          goalDescription: 'Inspect Cognitive Monitor Analysis Output',
          errorMessage: 'FAILED. The goal "Inspect Cognitive Monitor Analysis Output" was not achieved. Despite completing 22 steps, there were 6 errors',
          classification: 'unclassified',
          stepsExecuted: 22,
          innerSpeech: null,
        }
      );
      assert(store.getAll().length === 1,
        'FAILED verdict must record despite unclassified bucket');
    } finally { cleanup(); }
  });

  test('unclassified WITHOUT message content is still dropped (no signal)', () => {
    const { store, cleanup } = makeLessonsStore();
    try {
      recordReflection(
        { lessonsStore: store, selfStatementLog: null },
        {
          goalId: 'g-empty',
          goalDescription: 'd',
          errorMessage: '',
          classification: 'unclassified',
          stepsExecuted: 0,
          innerSpeech: null,
        }
      );
      assert(store.getAll().length === 0,
        'unclassified + empty message must NOT record (no signal worth keeping)');
    } finally { cleanup(); }
  });

  test('user-action is still dropped (not a Genesis failure)', () => {
    const { store, cleanup } = makeLessonsStore();
    try {
      recordReflection(
        { lessonsStore: store, selfStatementLog: null },
        {
          goalId: 'g-user',
          goalDescription: 'd',
          errorMessage: 'User rejected the goal',
          classification: 'user-action',
          stepsExecuted: 0,
          innerSpeech: null,
        }
      );
      assert(store.getAll().length === 0,
        'user-action must NOT record — it is not Genesis failing');
    } finally { cleanup(); }
  });
});

run();
