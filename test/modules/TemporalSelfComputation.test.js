const { describe, test, assert, assertEqual, run } = require('../harness');
const { TemporalSelf } = require('../../src/agent/consciousness/TemporalSelf');

function makeTS() {
  return new TemporalSelf({
    bus: { emit(){}, fire(){}, on(){} },
    storage: null, eventStore: null, config: {},
  });
}
function makeFrame(v, a, c, q) {
  return { valence: v, arousal: a, coherence: c, dominantQualia: q || 'contentment', phi: 0.5, surprise: { recentLevel: 0.3 }, epoch: Date.now(), timestamp: Date.now() };
}

describe('TemporalSelfComputation — _detectPattern', () => {
  test('returns plateau for stable frames', () => {
    const ts = makeTS();
    const frames = Array(10).fill(null).map(() => makeFrame(0.3, 0.4, 0.6));
    assertEqual(ts._detectPattern(frames), 'plateau');
  });
  test('detects rupture on large valence jump', () => {
    const ts = makeTS();
    const frames = [makeFrame(0.2, 0.3, 0.6), makeFrame(0.2, 0.3, 0.6), makeFrame(0.8, 0.3, 0.6), makeFrame(0.2, 0.3, 0.6), makeFrame(0.2, 0.3, 0.6)];
    assertEqual(ts._detectPattern(frames), 'rupture');
  });
  test('returns plateau for too few frames', () => {
    const ts = makeTS();
    assertEqual(ts._detectPattern([makeFrame(0, 0, 0)]), 'plateau');
  });
});

describe('TemporalSelfComputation — _computeRetention', () => {
  test('computes momentum from frame sequence', () => {
    const ts = makeTS();
    const frames = [];
    for (let i = 0; i < 15; i++) frames.push(makeFrame(i * 0.05, 0.5, 0.6));
    ts._computeRetention(frames);
    const ret = ts.getRetention();
    assert(ret.valenceMomentum > 0, 'rising valence should give positive momentum');
  });
  test('skips for <2 frames', () => {
    const ts = makeTS();
    ts._computeRetention([makeFrame(0, 0, 0)]);
    // should not crash
    assert(true);
  });
});

describe('TemporalSelfComputation — _computeProtention', () => {
  test('projects future valence', () => {
    const ts = makeTS();
    const frames = [];
    for (let i = 0; i < 10; i++) frames.push(makeFrame(i * 0.08, 0.5, 0.6));
    ts._computeRetention(frames);
    ts._computeProtention(frames);
    const prot = ts.getProtention();
    assert(prot.projectedValence !== undefined);
  });
});

describe('TemporalSelfComputation — _createChapter', () => {
  test('creates chapter with correct structure', () => {
    const ts = makeTS();
    const ch = ts._createChapter('flow', makeFrame(0.5, 0.6, 0.8, 'flow'));
    assertEqual(ch.dominantQualia, 'flow');
    assertEqual(ch.title, 'The Flow');
    assertEqual(ch.frameCount, 1);
    assert(!ch.closed);
  });
});

describe('TemporalSelfComputation — _updateIdentity', () => {
  test('increments totalExperienceFrames', () => {
    const ts = makeTS();
    const before = ts.getIdentity().totalExperienceFrames;
    ts._updateIdentity([makeFrame(0.3, 0.4, 0.6)]);
    assertEqual(ts.getIdentity().totalExperienceFrames, before + 1);
  });
});

run();
