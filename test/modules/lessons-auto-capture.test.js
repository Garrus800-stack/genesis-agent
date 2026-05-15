// ============================================================
// GENESIS — test/modules/lessons-auto-capture.test.js
// Contract test for LessonsAutoCapture (v7.8.8 extraction from LessonsStore).
// Verifies all 7 event-to-lesson translations and lifecycle.
// ============================================================

'use strict';

const { describe, test, assert, assertEqual, run } = require('../harness');
const path = require('path');
const fs = require('fs');
const os = require('os');

const ROOT = path.resolve(__dirname, '..', '..');
const { LessonsStore } = require(path.join(ROOT, 'src/agent/cognitive/LessonsStore'));
const { LessonsAutoCapture } = require(path.join(ROOT, 'src/agent/cognitive/LessonsAutoCapture'));

function makeBus() {
  const subs = new Map();
  return {
    on: (event, fn) => {
      if (!subs.has(event)) subs.set(event, new Set());
      subs.get(event).add(fn);
      return () => subs.get(event).delete(fn);
    },
    fire: (event, data) => {
      const set = subs.get(event);
      if (set) for (const fn of set) try { fn(data); } catch (_e) {}
    },
    emit: function () { return this.fire.apply(this, arguments); },
  };
}

function tmpDir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'genesis-lac-')); }

function setup() {
  const bus = makeBus();
  const store = new LessonsStore({ bus, globalDir: tmpDir() });
  const cap = new LessonsAutoCapture({ bus, store });
  cap.start();
  return { bus, store, cap };
}

describe('LessonsAutoCapture: lifecycle', () => {

  test('start subscribes; stop unsubscribes cleanly', () => {
    const { bus, store, cap } = setup();
    bus.fire('shell:outcome', { command: 'ls', success: true, platform: 'linux' });
    assertEqual(store._lessons.length, 1, 'first record stored');
    cap.stop();
    bus.fire('shell:outcome', { command: 'pwd', success: true, platform: 'linux' });
    assertEqual(store._lessons.length, 1, 'after stop, new events do not record');
  });

  test('constructor throws when bus or store missing', () => {
    let threw = 0;
    try { new LessonsAutoCapture({ bus: null, store: {} }); } catch (_e) { threw++; }
    try { new LessonsAutoCapture({ bus: {}, store: null }); } catch (_e) { threw++; }
    assertEqual(threw, 2);
  });

});

describe('LessonsAutoCapture: 7 event-to-lesson translations', () => {

  test('shell:outcome (success) → shell-success lesson', () => {
    const { bus, store } = setup();
    bus.fire('shell:outcome', { command: 'npm test', success: true, platform: 'win' });
    const l = store._lessons[0];
    assertEqual(l.category, 'shell-success');
    assert(l.insight.includes('npm test') && l.insight.includes('win'));
  });

  test('shell:outcome (failure) → shell-failure lesson with error', () => {
    const { bus, store } = setup();
    bus.fire('shell:outcome', { command: 'rm -rf /', success: false, platform: 'win', error: 'permission denied' });
    const l = store._lessons[0];
    assertEqual(l.category, 'shell-failure');
    assert(l.insight.includes('permission denied'));
  });

  test('dream:complete with insights > 0 → dream-insight lesson', () => {
    const { bus, store } = setup();
    bus.fire('dream:complete', { dreamNumber: 42, insights: 3, newSchemas: 1, strengthened: 5 });
    const l = store._lessons[0];
    assertEqual(l.category, 'dream-insight');
    assert(l.insight.includes('Dream #42'));
  });

  test('dream:complete with zero insights and zero schemas → no lesson', () => {
    const { bus, store } = setup();
    bus.fire('dream:complete', { dreamNumber: 1, insights: 0, newSchemas: 0, strengthened: 0 });
    assertEqual(store._lessons.length, 0);
  });

  test('online-learning:streak-detected → streak-recovery lesson', () => {
    const { bus, store } = setup();
    bus.fire('online-learning:streak-detected', {
      actionType: 'codegen',
      consecutiveFailures: 5,
      suggestion: { promptStyle: 'examples-first', temperature: 0.3 },
    });
    const l = store._lessons[0];
    assertEqual(l.category, 'codegen');
    assert(l.tags.includes('streak-recovery'));
  });

  test('online-learning:escalation-needed → model-limit lesson', () => {
    const { bus, store } = setup();
    bus.fire('online-learning:escalation-needed', {
      actionType: 'debug', currentModel: 'qwen:0.5b', surprise: 0.85,
    });
    const l = store._lessons[0];
    assertEqual(l.category, 'debug');
    assert(l.tags.includes('model-limit'));
  });

  test('online-learning:temp-adjusted → temperature lesson', () => {
    const { bus, store } = setup();
    bus.fire('online-learning:temp-adjusted', {
      actionType: 'codegen', oldTemp: 0.7, newTemp: 0.3, model: 'qwen:1b', successRate: 0.4, windowSize: 10,
    });
    const l = store._lessons[0];
    assertEqual(l.category, 'codegen');
    assert(l.insight.includes('lowered'));
    assert(l.tags.includes('temperature'));
  });

  test('workspace:consolidate (high salience) → goal-execution lesson', () => {
    const { bus, store } = setup();
    bus.fire('workspace:consolidate', {
      goalId: 'goal-42',
      items: [{ key: 'discovery', value: 'binary search index in btree', salience: 0.8 }],
    });
    const l = store._lessons[0];
    assertEqual(l.category, 'goal-execution');
    assert(l.tags.includes('discovery'));
  });

  test('workspace:consolidate (low salience < 0.6) → no lesson', () => {
    const { bus, store } = setup();
    bus.fire('workspace:consolidate', {
      goalId: 'goal-x',
      items: [{ key: 'noise', value: 'whatever', salience: 0.4 }],
    });
    assertEqual(store._lessons.length, 0);
  });

  test('prompt-evolution:promoted → prompt-optimization lesson', () => {
    const { bus, store } = setup();
    bus.fire('prompt-evolution:promoted', {
      section: 'reasoning', variant: 'chain-of-thought', improvement: 0.18, trials: 30,
    });
    const l = store._lessons[0];
    assertEqual(l.category, 'prompt-optimization');
    assert(l.tags.includes('reasoning'));
  });

});

describe('LessonsAutoCapture: autoCaptures counter', () => {

  test('store._stats.autoCaptures increments for tracked hooks', () => {
    const { bus, store } = setup();
    bus.fire('online-learning:streak-detected', {
      actionType: 'a', consecutiveFailures: 1, suggestion: { promptStyle: 's', temperature: 0.1 },
    });
    bus.fire('online-learning:escalation-needed', { actionType: 'b', currentModel: 'x', surprise: 0.5 });
    bus.fire('online-learning:temp-adjusted', {
      actionType: 'c', oldTemp: 0.5, newTemp: 0.3, model: 'y', successRate: 0.5, windowSize: 5,
    });
    bus.fire('workspace:consolidate', { goalId: 'g', items: [{ key: 'k', value: 'v', salience: 0.7 }] });
    bus.fire('prompt-evolution:promoted', { section: 's', variant: 'v', improvement: 0.1, trials: 10 });
    assertEqual(store._stats.autoCaptures, 5);
  });

});

if (require.main === module) run();
