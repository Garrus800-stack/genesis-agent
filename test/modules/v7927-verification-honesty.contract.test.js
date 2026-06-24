// ============================================================
// GENESIS — test/modules/v7927-verification-honesty.contract.test.js
// v7.9.27: successRate is (steps - errors)/steps — a NO-ERROR rate, not a
// verification rate. The summary printed it as "Success rate: 100%" even
// when only 1 of 8 steps was verified. Reporting honesty only, NO behaviour
// change: an ambiguous step is not a failure and the thresholds are untouched;
// the summary now leads with verification coverage and names the unverified
// steps instead of folding them into a success figure.
// ============================================================

'use strict';

const { describe, test, assert, run } = require('../harness');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const { AgentLoopRecoveryDelegate } = require(path.join(ROOT, 'src/agent/revolution/AgentLoopRecovery'));

const verify = (plan, results) => AgentLoopRecoveryDelegate.prototype.verifyGoal.call({}, plan, results);

describe('v7.9.27 — goal summary reports verification honestly, no behaviour change', () => {

  test('programmatic path: 1 verified / 7 unverified is NOT reported as 100% success', async () => {
    const results = [
      { verification: { status: 'pass' }, output: 'counted 42 files' },
      ...Array.from({ length: 7 }, () => ({ verification: { status: 'ambiguous' }, output: '' })),
    ];
    const { success, summary } = await verify({ title: 'T', steps: [] }, results);
    assert(success === true, 'goal still completes (ambiguous is not failure)');
    assert(summary.includes('1 verified'), 'reports the verified count');
    assert(summary.includes('unverified'), 'names the unverified steps explicitly');
    assert(summary.includes('Verification: 1/8'), 'leads with verification coverage');
    assert(!/Success rate/i.test(summary), 'the misleading "Success rate" label is gone');
    assert(!/\b100\s*%/.test(summary), 'does not claim 100% over a 1/8-verified goal');
  });

  test('heuristic path: 0 verified is reported as "none programmatically verified"', async () => {
    const results = Array.from({ length: 8 }, () => ({ output: 'ran' }));
    const { success, summary } = await verify({ title: 'T', steps: [] }, results);
    assert(success === true, 'goal still completes via the heuristic path');
    assert(summary.includes('none programmatically verified'), 'states the lack of verification plainly');
    assert(!/Success rate/i.test(summary), 'no misleading "Success rate" label');
  });

});

run();
