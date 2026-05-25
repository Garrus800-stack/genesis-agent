// ============================================================
// GENESIS — v799-colony-threshold.contract.test.js
//
// Pins the v7.9.9 colony-escalation threshold at 15 steps.
// Pre-fix (v7.9.8) the threshold was 8, causing every IdleMind-
// generated goal (typically 10-15 steps) to escalate into
// Colony with 3× LLM calls each, draining the session token
// budget within ~2h45min.
// ============================================================

'use strict';

const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '../..');
const { describe, test, assert, assertEqual, run } = require('../harness');

const PURSUIT_PATH = path.join(ROOT, 'src/agent/revolution/AgentLoopPursuit.js');

describe('v7.9.9 Colony Threshold', () => {

  test('THRESHOLD-01: source constant is 15 (raised from 8)', () => {
    const src = fs.readFileSync(PURSUIT_PATH, 'utf8');
    assert(/_COLONY_STEP_THRESHOLD\s*=\s*15/.test(src),
      'AgentLoopPursuit must use _COLONY_STEP_THRESHOLD = 15 (v7.9.9 raised from 8)');
    assert(!/_COLONY_STEP_THRESHOLD\s*=\s*8\b/.test(src),
      'old threshold 8 must be fully removed');
  });

  test('THRESHOLD-02: v7.9.9 comment present explaining the change', () => {
    const src = fs.readFileSync(PURSUIT_PATH, 'utf8');
    assert(/v7\.9\.9.*[Tt]hreshold\s*(raised\s*)?8\s*[→\->]+\s*15/.test(src) ||
           /v7\.9\.9.*15.*draining|v7\.9\.9 Fix 1.*threshold/.test(src),
      'v7.9.9 marker comment must explain the colony-threshold change');
  });

  test('GATE-01: colony only triggers if steps > threshold', () => {
    const src = fs.readFileSync(PURSUIT_PATH, 'utf8');
    assert(/plan\.steps\.length\s*>\s*_COLONY_STEP_THRESHOLD/.test(src),
      'colony gate must check plan.steps.length > _COLONY_STEP_THRESHOLD');
  });

}); // describe

run().catch(err => { console.error(err); process.exit(1); });
