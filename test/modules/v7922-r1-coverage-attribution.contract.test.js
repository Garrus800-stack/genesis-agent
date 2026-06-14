'use strict';
// v7.9.22 R1 — every stored analysis is attributed to a real module (membership guard in
// _stepAnalyze), and orderByReviewState offers the planner only uncovered files when enough
// exist to fill the list (structural constraint), falling back so the loop never starves.
const { describe, test, assert, run } = require('../harness');
const { AgentLoopStepsDelegate } = require('../../src/agent/revolution/AgentLoopSteps');
const { orderByReviewState } = require('../../src/agent/autonomy/activities/plan-review-feedback');

function loopStub(modules) {
  const calls = [];
  const loop = {
    model: { chat: async () => 'Analysis: the module looks structurally fine with no obvious issues.' },
    selfModel: { readModule: () => '// code', getFullModel: () => ({ modules }) },
    kg: { getNodesByType: () => [], addNode: (type, label, props) => { calls.push({ type, label, props }); return 'id'; } },
    verifier: null,
    rootDir: '/tmp',
  };
  return { loop, calls };
}

describe('v7.9.22 R1 — store guard: attribute coverage only to real modules', () => {
  test('a targetless analyze step stores no insight node', async () => {
    const { loop, calls } = loopStub({ 'src/agent/x.js': {} });
    const d = new AgentLoopStepsDelegate(loop);
    await d._stepAnalyze({ type: 'ANALYZE', description: 'Analyze', target: '' }, '');
    assert(calls.length === 0, `empty target should store nothing, stored ${calls.length}`);
  });

  test('an off-list (snapshot-copy) path stores no insight node', async () => {
    const { loop, calls } = loopStub({ 'src/agent/x.js': {} });
    const d = new AgentLoopStepsDelegate(loop);
    await d._stepAnalyze({ type: 'ANALYZE', description: 'Analyze', target: 'snapshots/_auto_before_restore_1/src/agent/ports/DaemonControlPort.js' }, '');
    assert(calls.length === 0, `off-list path should store nothing, stored ${calls.length}`);
  });

  test('an in-set target stores exactly one node carrying that module', async () => {
    const { loop, calls } = loopStub({ 'src/agent/x.js': {} });
    const d = new AgentLoopStepsDelegate(loop);
    await d._stepAnalyze({ type: 'ANALYZE', description: 'Analyze', target: 'src/agent/x.js' }, '');
    assert(calls.length === 1, `in-set target should store one node, stored ${calls.length}`);
    assert(calls[0].props.module === 'src/agent/x.js', `node should carry the module, got ${calls[0].props.module}`);
    assert(calls[0].props.module !== null, 'module must not be null');
  });
});

describe('v7.9.22 R1 — orderByReviewState offers only uncovered when enough exist', () => {
  const insightKg = (coveredFiles) => ({
    getNodesByType: (t) => (t === 'insight' ? coveredFiles.map(f => ({ properties: { module: f } })) : []),
  });

  test('with enough uncovered files, realPaths contains no already-covered module', () => {
    const mods = Array.from({ length: 35 }, (_, i) => ({ file: `src/m${i}.js` }));
    const coveredFiles = ['src/m0.js', 'src/m1.js', 'src/m2.js', 'src/m3.js', 'src/m4.js'];
    const { realPaths } = orderByReviewState(mods, insightKg(coveredFiles));
    const offered = realPaths.split('\n');
    for (const c of coveredFiles) {
      assert(!offered.includes(c), `covered module ${c} must not be offered, but realPaths included it`);
    }
    assert(offered.length === 30, `should offer the cap of 30 uncovered, got ${offered.length}`);
  });

  test('a fully-covered set still returns a non-empty list (no starvation)', () => {
    const mods = Array.from({ length: 35 }, (_, i) => ({ file: `src/m${i}.js` }));
    const coveredFiles = mods.map(m => m.file);
    const { realPaths } = orderByReviewState(mods, insightKg(coveredFiles));
    assert(realPaths.trim().length > 0, 'fully-covered set must still offer files as fallback');
  });
});

run();
