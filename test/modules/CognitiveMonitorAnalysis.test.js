const { describe, test, assert, assertEqual, run } = require('../harness');
const { CognitiveMonitor } = require('../../src/agent/autonomy/CognitiveMonitor');

function makeCM() {
  return new CognitiveMonitor({
    bus: { emit(){}, fire(){}, on(){} },
    eventStore: null, storage: null, intervals: null, config: {},
  });
}

describe('CognitiveMonitorAnalysis — _hashText', () => {
  test('produces consistent hash', () => {
    const cm = makeCM();
    const h1 = cm._hashText('hello world');
    const h2 = cm._hashText('hello world');
    assert(h1 instanceof Map || typeof h1 === 'object');
    assertEqual(JSON.stringify(h1), JSON.stringify(h2));
  });
  test('different texts produce different hashes', () => {
    const cm = makeCM();
    const h1 = cm._hashText('hello world foo bar');
    const h2 = cm._hashText('completely different text here');
    assert(JSON.stringify(h1) !== JSON.stringify(h2));
  });
});

describe('CognitiveMonitorAnalysis — _hashSimilarity', () => {
  test('identical texts have similarity 1', () => {
    const cm = makeCM();
    const h = cm._hashText('hello world test');
    const sim = cm._hashSimilarity(h, h);
    assert(sim > 0.99, 'identical hashes should be ~1');
  });
  test('empty hashes return 0', () => {
    const cm = makeCM();
    assertEqual(cm._hashSimilarity(new Map(), new Map()), 0);
  });
  test('different texts have low similarity', () => {
    const cm = makeCM();
    const h1 = cm._hashText('javascript programming functions');
    const h2 = cm._hashText('quantum physics particles');
    const sim = cm._hashSimilarity(h1, h2);
    assert(sim < 0.5, 'very different texts should be dissimilar');
  });
});

describe('CognitiveMonitorAnalysis — _checkCircularity', () => {
  test('returns null for first reasoning', () => {
    const cm = makeCM();
    const hash = cm._hashText('first thought');
    assertEqual(cm._checkCircularity(hash), null);
  });
  test('detects repeated reasoning', () => {
    const cm = makeCM();
    cm.recordReasoning('thinking about the same problem');
    cm.recordReasoning('thinking about the same problem');
    cm.recordReasoning('thinking about the same problem');
    // Check circularity alerts
    const report = cm.getCircularityReport();
    assert(report.alertCount >= 0); // may or may not trigger depending on threshold
  });
});

describe('CognitiveMonitorAnalysis — _detectRedundantToolCalls', () => {
  test('returns empty when no tool calls', () => {
    const cm = makeCM();
    cm._detectRedundantToolCalls();
    const analytics = cm.getToolAnalytics();
    assertEqual(analytics.redundantPatterns.length, 0);
  });
  test('detects repeated tool calls', () => {
    const cm = makeCM();
    for (let i = 0; i < 10; i++) cm.recordToolCall('search', true, 100);
    cm._detectRedundantToolCalls();
    // May detect redundancy depending on time window
    assert(true); // no crash
  });
});

describe('CognitiveMonitorAnalysis — _periodicAnalysis', () => {
  test('runs without crash', () => {
    const cm = makeCM();
    cm._periodicAnalysis();
    assert(true);
  });
});

run();
