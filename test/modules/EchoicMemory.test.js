#!/usr/bin/env node
// Test: EchoicMemory.js — Sliding-window perception smoother
const { describe, test, assert, assertEqual, run } = require('../harness');
const EchoicMemory = require('../../src/agent/consciousness/EchoicMemory');

describe('EchoicMemory — Adaptive Alpha', () => {
  test('base alpha with zero surprise', () => {
    const em = new EchoicMemory({ baseAlpha: 0.4 });
    const a = em.computeAdaptiveAlpha(0);
    assertEqual(a, 0.4);
  });

  test('high surprise increases alpha toward max', () => {
    const em = new EchoicMemory({ baseAlpha: 0.4, maxAlpha: 0.8, reactivityGain: 1.5 });
    const a = em.computeAdaptiveAlpha(2.0);
    assert(a > 0.4, 'alpha should increase with surprise');
    assert(a <= 0.8, 'alpha should not exceed max');
  });

  test('alpha never drops below min', () => {
    const em = new EchoicMemory({ baseAlpha: 0.01, minAlpha: 0.05, reactivityGain: 0 });
    const a = em.computeAdaptiveAlpha(0);
    assert(a >= 0.05, 'alpha should not drop below min');
  });

  test('alpha override takes precedence', () => {
    const em = new EchoicMemory();
    em._alphaOverride = 0.99;
    assertEqual(em.computeAdaptiveAlpha(0), 0.99);
  });
});

describe('EchoicMemory — Blending', () => {
  test('first frame initializes gestalt directly', () => {
    const em = new EchoicMemory();
    const frame = { channels: { a: 1.0, b: 0.5 }, timestamp: Date.now() };
    const result = em.blend(frame, 0.5);
    assert(result, 'should return gestalt');
    assert(result.channels, 'gestalt should have channels');
    assertEqual(result.channels.a, 1.0);
  });

  test('second frame blends with gestalt', () => {
    const em = new EchoicMemory();
    em.blend({ channels: { x: 0.0 }, timestamp: 1000 }, 1.0);
    const result = em.blend({ channels: { x: 1.0 }, timestamp: 2000 }, 0.5);
    // lerp: 0.0 + 0.5*(1.0 - 0.0) = 0.5
    assert(Math.abs(result.channels.x - 0.5) < 0.01, 'should be lerped to ~0.5');
  });

  test('high alpha tracks input closely', () => {
    const em = new EchoicMemory();
    em.blend({ channels: { x: 0 }, timestamp: 1 }, 1.0);
    const result = em.blend({ channels: { x: 1.0 }, timestamp: 2 }, 0.99);
    assert(result.channels.x > 0.9, 'high alpha should track input closely');
  });

  test('low alpha resists change', () => {
    const em = new EchoicMemory();
    em.blend({ channels: { x: 0 }, timestamp: 1 }, 1.0);
    const result = em.blend({ channels: { x: 1.0 }, timestamp: 2 }, 0.01);
    assert(result.channels.x < 0.05, 'low alpha should resist change');
  });

  test('frame count increments', () => {
    const em = new EchoicMemory();
    assertEqual(em._frameCount, 0);
    em.blend({ channels: { a: 1 }, timestamp: 1 }, 0.5);
    assertEqual(em._frameCount, 1);
    em.blend({ channels: { a: 1 }, timestamp: 2 }, 0.5);
    assertEqual(em._frameCount, 2);
  });
});

run();
