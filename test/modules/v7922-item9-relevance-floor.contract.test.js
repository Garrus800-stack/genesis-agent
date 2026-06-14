'use strict';
// v7.9.22 Item 9 — a breadth-scaled relevance floor blocks an over-general (bare-string-
// strategy) lesson on steps it scores low for, while leaving specific lessons untouched and
// never hard-killing a saturated lesson on a step it fits.
const { describe, test, assert, run } = require('../harness');
const { SymbolicResolver, LEVEL } = require('../../src/agent/intelligence/SymbolicResolver');

const makeResolver = (lesson) => new SymbolicResolver({
  lessonsStore: { recall: () => (lesson ? [lesson] : []) },
  schemaStore: null,
});
const lesson = (o) => ({
  id: 'L1', insight: 'step by step decomposition works best',
  strategy: o.strategy, confidence: o.confidence ?? 0.8, relevance: o.relevance,
  category: o.category ?? 'general', source: 'manual', useCount: o.useCount ?? 0, lastUsed: Date.now(),
});

describe('v7.9.22 Item 9 — breadth-scaled relevance floor on GUIDED', () => {
  test('an over-general lesson (broad reach, generic) with low relevance does NOT fire', () => {
    const r = makeResolver(lesson({ strategy: 'step-by-step', useCount: 300, relevance: 0.3 }));
    const res = r.resolve('GENERIC', 'do the thing', 'x', {});
    assert(res.level === LEVEL.PASS, `expected PASS (gated), got ${res.level}`);
  });

  test('the same broad lesson still guides a step it scores HIGH relevance for', () => {
    const r = makeResolver(lesson({ strategy: 'step-by-step', useCount: 300, relevance: 0.8 }));
    const res = r.resolve('GENERIC', 'do the thing', 'x', {});
    assert(res.level !== LEVEL.PASS, `expected guidance at high relevance, got ${res.level}`);
  });

  test('a specific (object-strategy) lesson is never gated, even at low relevance', () => {
    const r = makeResolver(lesson({ strategy: { goalDescription: 'a specific goal', action: 'do' }, useCount: 300, relevance: 0.3 }));
    const res = r.resolve('GENERIC', 'do the thing', 'x', {});
    assert(res.level !== LEVEL.PASS, `object-strategy lesson should guide, got ${res.level}`);
  });

  test('a saturated-confidence broad lesson is not hard-killed — guides a relevant step', () => {
    const r = makeResolver(lesson({ strategy: 'step-by-step', confidence: 1.0, useCount: 300, relevance: 0.9 }));
    const res = r.resolve('GENERIC', 'do the thing', 'x', {});
    assert(res.level !== LEVEL.PASS, `saturated lesson should still guide at high relevance, got ${res.level}`);
  });
});

run();
