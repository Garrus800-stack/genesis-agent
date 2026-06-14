#!/usr/bin/env node
// ============================================================
// GENESIS — test/modules/v7914-causal-suspicion-chain.contract.test.js
//
// v7.9.14 (1c): integration test that guards the multi-module
// behaviour chain established in v7.9.7 P7:
//
//   CausalAnnotation._checkPromotions()
//     → fires bus event 'causal:promoted' (telemetry)
//     → SYNCHRONOUSLY writes a lesson with
//          source:                   'plan-failure-reflection'
//          strategy.classification:  'causal-suspicion'
//   SymbolicResolver._checkDirect()
//     → filters lessons with that source/classification out of
//       DIRECT recalls (returns null)
//   IdleMind (started)
//     → listens on bus.on('agent:self-message', ...) with
//       kind === 'plan-failure-reflection' and fills
//       _recentlyFailedGoalTokens with a 1h cooldown entry
//
// The whole loop hinges on two string literals appearing identically
// in three modules. A refactor like "rename to planFailureReflection
// for JS-naming-consistency" would silently break the loop without
// any single-module unit test noticing. THIS test is the guard.
//
// Assertions use assert.strictEqual on the string values, NOT
// includes/startsWith — the exact strings ARE the contract.
//
// Setup note: IdleMind.start() MUST be called so the listener
// registration actually runs. Without start() the test would pass
// vacuously because the cooldown map would never fill.
// ============================================================

'use strict';

const { describe, test, assert, assertEqual, run } = require('../harness');
const { createTestRoot } = require('../harness');
const path = require('path');
const ROOT = path.resolve(__dirname, '..', '..');

const { CausalAnnotation } = require(path.join(ROOT, 'src/agent/cognitive/CausalAnnotation'));
const { SymbolicResolver } = require(path.join(ROOT, 'src/agent/intelligence/SymbolicResolver'));
const { IdleMind } = require(path.join(ROOT, 'src/agent/autonomy/IdleMind'));
const { createBus } = require(path.join(ROOT, 'src/agent/core/EventBus'));

// String constants that the contract guards. Hard-coded here on purpose
// so that a refactor in source must also touch this file.
const SOURCE_MARKER = 'plan-failure-reflection';
const CLASSIFICATION = 'causal-suspicion';

// Capture-mock for LessonsStore — records every .record() call so the
// test can inspect what was written.
function makeCaptureLessonsStore() {
  const calls = [];
  return {
    calls,
    record(lesson) {
      calls.push(lesson);
      return `mock_lesson_${calls.length}`;
    },
  };
}

describe('v7.9.14 (1c) — causal-suspicion chain contract', () => {

  test('CausalAnnotation writes a lesson with the exact source+classification on promotion', () => {
    const bus = createBus();
    const lessonsStore = makeCaptureLessonsStore();
    let promotedEventFired = false;
    let promotedPayload = null;
    bus.on('causal:promoted', (data) => {
      promotedEventFired = true;
      promotedPayload = data;
    });

    // Use a low threshold config so we trigger promotion quickly
    const ca = new CausalAnnotation({
      bus,
      lessonsStore,
      config: {},  // defaults are fine — CONF.SUSPICION_EARLY_PROMO with MIN_OBS_EARLY=2
    });

    // Drive enough failures on one key to cross the early-promotion threshold
    // (perfect failure correlation with 2+ observations).
    const key = 'fs.unlink:risky-arg';
    for (let i = 0; i < 5; i++) {
      // simulate a failure observation
      const entry = ca._suspicion.get(key) || { failCount: 0, successCount: 0, observations: 0, lastSeen: Date.now() };
      entry.failCount++;
      entry.observations++;
      entry.lastSeen = Date.now();
      ca._suspicion.set(key, entry);
    }
    ca._checkPromotions();

    // The bus event must have fired (telemetry path)
    assert(promotedEventFired, 'causal:promoted must fire on threshold crossing');
    assertEqual(promotedPayload.action, key, 'bus event payload action must match the key');

    // The lesson must have been written (behavioural path) — same call
    assertEqual(lessonsStore.calls.length, 1, 'exactly one lesson must have been recorded');
    const written = lessonsStore.calls[0];

    // STRICT equality on the contract strings — this is the test
    assertEqual(written.source, SOURCE_MARKER,
      `lesson.source must be exactly '${SOURCE_MARKER}' (the string contract with IdleMind/PSE)`);
    assertEqual(written.strategy.classification, CLASSIFICATION,
      `lesson.strategy.classification must be exactly '${CLASSIFICATION}' (the string contract with SymbolicResolver)`);
  });

  test('SymbolicResolver filters lessons with the exact source out of DIRECT', () => {
    const bus = createBus();
    const sr = new SymbolicResolver({ bus });

    // Build a lesson that satisfies every OTHER _checkDirect precondition
    // so the only reason to return null is the causal-suspicion filter.
    const lessonWithCausalSource = {
      id: 'L1',
      source: SOURCE_MARKER,
      strategy: { classification: 'something-else' },  // test source filter in isolation
      useCount: 10,
      lastUsed: Date.now(),
      confidence: 0.9,
      insight: 'test',
    };

    const result = sr._checkDirect('ANALYZE', lessonWithCausalSource);
    assertEqual(result, null,
      `_checkDirect must return null for lessons with source === '${SOURCE_MARKER}'`);
  });

  test('SymbolicResolver filters lessons with the exact classification out of DIRECT', () => {
    const bus = createBus();
    const sr = new SymbolicResolver({ bus });

    // This time: source is benign, but classification triggers the filter
    const lessonWithCausalClass = {
      id: 'L2',
      source: 'manual',
      strategy: { classification: CLASSIFICATION },
      useCount: 10,
      lastUsed: Date.now(),
      confidence: 0.9,
      insight: 'test',
    };

    const result = sr._checkDirect('ANALYZE', lessonWithCausalClass);
    assertEqual(result, null,
      `_checkDirect must return null for lessons with strategy.classification === '${CLASSIFICATION}'`);
  });

  test('SymbolicResolver still allows DIRECT for a clean lesson (sanity)', () => {
    // Without this control test, the previous two could trivially pass
    // because _checkDirect returns null for any lesson with a non-test
    // step type. Confirm: a clean lesson on an eligible step type works.
    const bus = createBus();
    const sr = new SymbolicResolver({ bus });
    const cleanLesson = {
      id: 'L3',
      source: 'manual',
      strategy: { classification: 'proven-solution', steps: ['step1'] },
      useCount: 10,
      lastUsed: Date.now(),
      confidence: 0.9,
      insight: 'clean lesson that should be eligible',
    };
    const result = sr._checkDirect('ANALYZE', cleanLesson);
    assert(result !== null, 'a clean lesson on an eligible step type must NOT be filtered (control)');
    assertEqual(result.level, 'direct', 'clean lesson must resolve to DIRECT (LEVEL constant is lowercased)');
  });

  test('IdleMind fills _recentlyFailedGoalTokens on agent:self-message with the exact kind', () => {
    const bus = createBus();
    // IdleMind needs a bunch of dependencies. We give the minimum surface
    // that won't make .start() crash. The internals we don't test will
    // sit idle.
    const idle = new IdleMind({
      bus,
      model: null,
      prompts: null,
      selfModel: null,
      memory: null,
      knowledgeGraph: null,
      eventStore: null,
      storageDir: createTestRoot('v7914-idle'),
      goalStack: null,
      intervals: null,
      storage: null,
    });

    // CRITICAL: without start(), the agent:self-message listener is NOT
    // registered and the test would pass vacuously. start() is where
    // the bus.on('agent:self-message', ...) call lives (IdleMind.js Z198).
    idle.start();

    // Fire a self-message with the contracted kind
    bus.fire('agent:self-message', {
      kind: SOURCE_MARKER,  // <-- the exact string contract
      sourceRef: { goalDescription: 'refactor the recovery handler module' },
    }, { source: 'test' });

    // The cooldown map must now have one entry
    assert(Array.isArray(idle._recentlyFailedGoalTokens),
      '_recentlyFailedGoalTokens must exist as an array');
    assertEqual(idle._recentlyFailedGoalTokens.length, 1,
      `IdleMind must have added one cooldown entry on kind '${SOURCE_MARKER}'`);

    const entry = idle._recentlyFailedGoalTokens[0];
    assert(entry.tokens instanceof Set, 'cooldown entry must carry a token Set');
    assert(entry.tokens.has('refactor'),
      'cooldown entry must contain tokens from the goal description');
    assert(entry.expiresAt > Date.now(),
      'cooldown entry must have a future expiry (1h from now)');

    // Clean up: stop the interval so this test does not leak timers
    idle.stop();
  });

  test('IdleMind ignores agent:self-message with a different kind', () => {
    // Control: prove the kind check matters. A self-message with the
    // wrong kind must NOT fill the cooldown.
    const bus = createBus();
    const idle = new IdleMind({
      bus,
      storageDir: createTestRoot('v7914-idle-control'),
      model: null, prompts: null, selfModel: null, memory: null,
      knowledgeGraph: null, eventStore: null, goalStack: null,
      intervals: null, storage: null,
    });
    idle.start();

    bus.fire('agent:self-message', {
      kind: 'some-other-kind',
      sourceRef: { goalDescription: 'should be ignored' },
    }, { source: 'test' });

    assertEqual(idle._recentlyFailedGoalTokens.length, 0,
      'IdleMind must ignore kinds other than plan-failure-reflection (control)');

    idle.stop();
  });

});

if (require.main === module) run();
