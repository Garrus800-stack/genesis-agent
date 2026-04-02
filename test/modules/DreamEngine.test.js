#!/usr/bin/env node
// Test: DreamEngine.js — Offline consolidation
const { describe, test, assert, assertEqual, run } = require('../harness');
const DreamEngine = require('../../src/agent/consciousness/DreamEngine');

describe('DreamEngine — Construction', () => {
  test('constructs with defaults', () => {
    const de = new DreamEngine();
    assert(de.config.maxPrototypes > 0);
    assert(de.config.clusterIterations > 0);
    assertEqual(de._lastDream, null);
  });

  test('accepts custom config', () => {
    const de = new DreamEngine({ maxPrototypes: 5, clusterIterations: 20 });
    assertEqual(de.config.maxPrototypes, 5);
    assertEqual(de.config.clusterIterations, 20);
  });

  test('accepts dependencies', () => {
    const llm = async () => 'dream narrative';
    const de = new DreamEngine({}, { llmCall: llm });
    assertEqual(de.deps.llmCall, llm);
  });
});

describe('DreamEngine — Consolidation API', () => {
  test('consolidate method exists', () => {
    const de = new DreamEngine();
    assert(typeof de.consolidate === 'function', 'should have consolidate method');
  });

  test('_clusterFrames handles empty array', () => {
    const de = new DreamEngine();
    const result = de._clusterFrames([]);
    assert(Array.isArray(result), 'should return array for empty input');
  });
});

describe('DreamEngine — Config Validation', () => {
  test('weights sum to approximately 1.0', () => {
    const de = new DreamEngine();
    const sum = de.config.emotionWeight + de.config.temporalWeight + de.config.contentWeight;
    assert(Math.abs(sum - 1.0) < 0.01, `weights should sum to 1.0, got ${sum}`);
  });

  test('minFramesPerCluster is reasonable', () => {
    const de = new DreamEngine();
    assert(de.config.minFramesPerCluster >= 1);
    assert(de.config.minFramesPerCluster <= 50);
  });
});

run();
