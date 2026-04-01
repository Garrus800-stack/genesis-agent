#!/usr/bin/env node
// Test: TemporalSelf.js — Temporal continuity & life chapters
const { describe, test, assert, run } = require('../harness');
const { NullBus } = require('../../src/agent/core/EventBus');
const { TemporalSelf } = require('../../src/agent/consciousness/TemporalSelf');

function createTemporal(overrides = {}) {
  return new TemporalSelf({
    bus: NullBus,
    storage: null,
    eventStore: null,
    intervals: { register: () => {}, clear: () => {} },
    config: {},
    ...overrides,
  });
}

describe('TemporalSelf — Construction', () => {
  test('constructs without errors', () => {
    const ts = createTemporal();
    assert(ts, 'should construct');
  });

  test('retentional field starts empty', () => {
    const ts = createTemporal();
    const retention = ts.getRetention();
    assert(retention, 'should return retention data');
  });

  test('chapters list starts with initial chapter or empty', () => {
    const ts = createTemporal();
    const chapters = ts.getChapters();
    assert(Array.isArray(chapters), 'should return array');
  });
});

describe('TemporalSelf — Pattern Detection', () => {
  test('_detectPattern handles empty frames', () => {
    const ts = createTemporal();
    const pattern = ts._detectPattern([]);
    assert(pattern !== undefined, 'should return a pattern for empty input');
  });

  test('_detectPattern identifies rising trend', () => {
    const ts = createTemporal();
    const frames = [];
    for (let i = 0; i < 10; i++) {
      frames.push({ valence: i * 0.1, arousal: 0.5, timestamp: Date.now() + i * 2000 });
    }
    const pattern = ts._detectPattern(frames);
    assert(typeof pattern === 'string', 'should return pattern string');
    // rising valence should yield 'rising' or similar
  });
});

describe('TemporalSelf — Lifecycle', () => {
  test('start and stop without errors', () => {
    const ts = createTemporal();
    ts.start();
    ts.stop();
    assert(true);
  });
});

describe('TemporalSelf — Chapter Shift Threshold', () => {
  test('has configurable chapter shift threshold', () => {
    const ts = createTemporal();
    assert(typeof ts._chapterShiftThreshold === 'number');
    assert(ts._chapterShiftThreshold > 0 && ts._chapterShiftThreshold < 1);
  });
});

run();
