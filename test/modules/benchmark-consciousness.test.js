#!/usr/bin/env node
// Test: benchmark-consciousness.js — Scoring function validation
const { describe, test, assert, run } = require('../harness');
const { TASKS } = require('../../scripts/benchmark-consciousness');

describe('Consciousness Benchmark — Scoring Functions', () => {
  test('all tasks have required fields', () => {
    for (const task of TASKS) {
      assert(task.id, `task should have id`);
      assert(task.category, `${task.id} should have category`);
      assert(task.prompt, `${task.id} should have prompt`);
      assert(typeof task.score === 'function', `${task.id} should have score function`);
    }
  });

  test('scoring functions return numbers in [0, 100]', () => {
    for (const task of TASKS) {
      const s1 = task.score('');
      const s2 = task.score('A comprehensive detailed answer covering all relevant aspects with code examples and thorough analysis.');
      assert(typeof s1 === 'number', `${task.id} empty should return number`);
      assert(typeof s2 === 'number', `${task.id} full should return number`);
      assert(s1 >= 0 && s1 <= 100, `${task.id} empty score ${s1} should be in [0, 100]`);
      assert(s2 >= 0 && s2 <= 100, `${task.id} full score ${s2} should be in [0, 100]`);
    }
  });

  test('good responses score higher than bad responses', () => {
    for (const task of TASKS) {
      const bad = task.score('ok');
      const good = task.score(task.prompt + ' Here is a thorough answer. ' +
        'function factorial(n) { if (n <= 1) return 1; return n * factorial(n-1); } ' +
        'The utilitarian perspective argues for maximizing welfare. Deontological ethics focuses on duties. ' +
        'However, on the other hand, there are strong arguments because the conclusion therefore ' +
        'depends on risk estimation phase milestone challenge. ' +
        'She felt a wonder she had never experienced before, like a dream unfolding. ' +
        'The off-by-one error causes undefined to be added, resulting in NaN. Fix: use < instead of <=');
      assert(good > bad, `${task.id}: good (${good}) should beat bad (${bad})`);
    }
  });

  test('empty string scores low', () => {
    for (const task of TASKS) {
      const score = task.score('');
      assert(score <= 20, `${task.id}: empty should score ≤20, got ${score}`);
    }
  });

  test('code-factorial rewards edge cases and JSDoc', () => {
    const task = TASKS.find(t => t.id === 'code-factorial');
    const withEdge = task.score('function factorial(n) { if (n <= 0) return 1; throw new Error("invalid"); /** @param {number} n @returns {number} */ }');
    const without = task.score('function f() { return 1; }');
    assert(withEdge > without, 'edge cases + JSDoc should score higher');
  });

  test('analysis-debug rewards bug identification', () => {
    const task = TASKS.find(t => t.id === 'analysis-debug');
    const good = task.score('The bug is an off-by-one error: i <= arr.length reads undefined. Fix: use i < arr.length ```js fixed```');
    const bad = task.score('The code looks fine to me.');
    assert(good > bad, 'correct analysis should score much higher');
  });
});

run();
