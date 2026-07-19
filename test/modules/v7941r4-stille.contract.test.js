// ============================================================
// TEST — v7.9.41 r4: the silence belongs to the user.
//   node test/modules/v7941r4-stille.contract.test.js
// Field 19.07. (Garrus): "15 minutes will never be reached — he keeps doing
// something in the conversation." Proven right: agent:status (Genesis'
// own loops) and store:CHAT_MESSAGE (Genesis' own replies) reset the idle
// clock. Now only user:message does — and the think tick checks every 60s,
// so: last user message + 5min threshold + <=60s => first thought ~min 6.
// ============================================================
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { describe, test, run } = require('../harness');
const ROOT = path.join(__dirname, '..', '..');
function src(rel) { return fs.readFileSync(path.join(ROOT, rel), 'utf-8'); }
const { INTERVALS } = require('../../src/agent/core/Constants.js');

describe('v7.9.41 r4 — the silence belongs to the user', () => {
  test('only user:message resets the idle clock (source pins)', () => {
    const t = src('src/agent/autonomy/IdleMind.js');
    const resets = (t.match(/this\.lastUserActivity = Date\.now\(\)/g) || []).length;
    assert.ok(t.includes("this._sub('user:message', () => { this.lastUserActivity"), 'user:message subscription');
    assert.ok(!/_sub\('agent:status',[^)]*lastUserActivity/.test(t), 'agent:status must NOT reset');
    assert.ok(!/_sub\('store:CHAT_MESSAGE',[^)]*lastUserActivity/.test(t), 'own replies must NOT reset');
    assert.ok(resets <= 4, 'no hidden extra reset subscriptions: ' + resets);
  });
  test('think tick is 60s, threshold 5min — first thought by ~minute 6 (functional)', () => {
    assert.strictEqual(INTERVALS.IDLE_THINK_CYCLE, 60 * 1000);
    assert.strictEqual(INTERVALS.IDLE_THRESHOLD, 5 * 60 * 1000);
    assert.ok(INTERVALS.IDLE_THRESHOLD + INTERVALS.IDLE_THINK_CYCLE <= 6 * 60 * 1000, 'the promise: <= 6 minutes');
  });
  test('user:message fires on both orchestrator paths (source pin)', () => {
    const t = src('src/agent/hexagonal/ChatOrchestrator.js');
    assert.ok((t.match(/fire\('user:message'/g) || []).length >= 2);
  });
  test('the self-cadence reset after a thought stays (userActive API untouched)', () => {
    const t = src('src/agent/autonomy/IdleMind.js');
    assert.ok(t.includes('userActive()'), 'API exists');
  });
});
if (require.main === module) run();
