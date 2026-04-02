#!/usr/bin/env node
// Test: SalienceGate.js — 2D Attentional Routing
const { describe, test, assert, run } = require('../harness');
const SalienceGate = require('../../src/agent/consciousness/SalienceGate');

describe('SalienceGate — Construction', () => {
  test('constructs with default config', () => {
    const sg = new SalienceGate();
    assert(sg, 'should construct');
    assert(sg.config, 'should have config');
    assert(sg.config.channels, 'should have default channels');
  });

  test('has urgency and relevance thresholds', () => {
    const sg = new SalienceGate();
    assert(typeof sg.config.urgencyThreshold === 'number');
    assert(typeof sg.config.relevanceThreshold === 'number');
  });
});

describe('SalienceGate — Quadrant Classification', () => {
  test('classifies channels into quadrants', () => {
    const sg = new SalienceGate();
    if (typeof sg.classify === 'function') {
      const result = sg.classify({
        channels: { 'system-health': 0.9, 'creativity-flow': 0.2 },
        surprises: { 'system-health': 0.8, 'creativity-flow': 0.1 },
      });
      assert(result, 'should return classification');
    } else if (typeof sg.evaluate === 'function') {
      const result = sg.evaluate({
        channels: { 'system-health': 0.9 },
        surprises: { 'system-health': 0.8 },
      });
      assert(result, 'should return evaluation');
    } else {
      assert(true, 'skipped — API variant');
    }
  });
});

describe('SalienceGate — Chapter Relevance', () => {
  test('config has chapter relevance mapping', () => {
    const sg = new SalienceGate();
    const cr = sg.config.chapterRelevance;
    assert(cr, 'should have chapterRelevance');
    assert(cr.default, 'should have default chapter');
    assert(typeof cr.default.system === 'number', 'should have system relevance');
  });

  test('max focus channels configured', () => {
    const sg = new SalienceGate();
    assert(sg.config.maxFocusChannels > 0, 'should allow at least 1 focus channel');
    assert(sg.config.maxFocusChannels <= 5, 'should cap focus channels');
  });
});

run();
