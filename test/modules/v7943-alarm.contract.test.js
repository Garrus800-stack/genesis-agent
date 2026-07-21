#!/usr/bin/env node
// GENESIS — v7.9.43 W2 (B4): four checks, ONE gentle line, else byte silence.
'use strict';
const { describe, test, assert, assertEqual, run } = require('../harness');
const path = require('path');
const { checkSelfConsistency } = require(path.resolve(__dirname,'..','..','src/agent/intelligence/SelfConsistencyAlarm.js'));
const fs = require('fs');
describe('v7943 W2 — the four checks', () => {
  test('goals unreadable → line names Ziele', () => {
    const l = checkSelfConsistency({ goalStack: { getOpenGoals: () => { throw new Error('x'); } }, upMs: 1 });
    assert(l && l.includes('Ziele') && l.includes('nachfragen lohnt'), 'gentle line');
  });
  test('idle status unreadable → Idle-Status', () => {
    assert(checkSelfConsistency({ idleMind: {}, upMs: 1 }).includes('Idle-Status'), 'named');
  });
  test('dream time in the future → Traumzeit; small positive is fine', () => {
    assert(checkSelfConsistency({ dreamMs: -999999, upMs: 1 }).includes('Traumzeit'), 'future flagged');
    assertEqual(checkSelfConsistency({ dreamMs: 5000, upMs: 1 }), null, 'plausible stays silent');
  });
  test('waking clock jumps back → Wachzeit; first build skips', () => {
    assert(checkSelfConsistency({ upMs: 1000, lastUpMs: 99999 }).includes('Wachzeit'), 'monotonic');
    assertEqual(checkSelfConsistency({ upMs: 1000 }), null, 'no prior value, no alarm');
  });
  test('all healthy → null (byte-identical silence upstream)', () => {
    assertEqual(checkSelfConsistency({ goalStack: { getOpenGoals: () => [] }, idleMind: { thoughtCount: 2 }, dreamMs: 100, upMs: 5000, lastUpMs: 1000 }), null, 'silence');
  });
  test('fixed order: first discrepancy wins, exactly one line', () => {
    const l = checkSelfConsistency({ goalStack: { getOpenGoals: () => null }, idleMind: {}, dreamMs: -999999, upMs: 1, lastUpMs: 9999999 });
    assert(l.includes('Ziele') && !l.includes('Idle') && (l.match(/\u26a0/g) || []).length === 1, 'one line, first source');
  });
  test('wiring pin: sits right after the self clock, never touches the register', () => {
    const t = fs.readFileSync(path.resolve(__dirname,'..','..','src/agent/intelligence/PromptBuilderSectionsExtra.js'),'utf8');
    assert(t.indexOf('_selfConsistencyLine') > -1 && t.indexOf('v7.9.43 W2+W3') > t.indexOf('_selfClockLine();'), 'anchored at the clock');
    const a = fs.readFileSync(path.resolve(__dirname,'..','..','src/agent/intelligence/SelfConsistencyAlarm.js'),'utf8');
    assert(!/ChangeRegister|change-register/.test(a), 'register untouched (reading kept open by plan)');
  });
});
run();
