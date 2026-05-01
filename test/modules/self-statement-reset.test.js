// ============================================================
// Test: SelfStatementLog reset behaviour (v7.5.5)
//
// Honest name: this is a Reset-Test, not a Race-Test. JS is single-
// threaded; reproducing the actual race (parallel handleChat from
// DaemonController) via Microtask-Hijacking is fragile and not done
// here. These tests verify the deterministic reset behaviour — when
// that works, the race-effect is just statistical noise (see Risiko 3
// in v7.5.5 plan, AUDIT-BACKLOG #2).
// ============================================================

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const { describe, test, assertEqual, assert, run } = require('../harness');
const { SelfStatementLog } = require('../../src/agent/cognitive/SelfStatementLog');

function freshDir() {
  const dir = path.join(os.tmpdir(), 'genesis-stmt-reset-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8));
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function mockBus() {
  const events = [];
  return {
    _events: events,
    fire: (event, data, meta) => events.push({ event, data, meta }),
    emit: (event, data, meta) => events.push({ event, data, meta }),
    on: () => () => {},
  };
}

function makeService() {
  return new SelfStatementLog({
    bus: mockBus(),
    storageDir: freshDir(),
    flushDebounceMs: 0,
  });
}

describe('SelfStatementLog: deterministic reset', () => {
  test('flag resets to false after capture', () => {
    const svc = makeService();
    svc.setLastIntrospectionPopulated(true);
    assertEqual(svc._lastIntrospectionPopulated, true);
    svc._captureResponse({
      message: 'x',
      response: 'Mein Modul ist da.',
      intent: 'general',
    });
    assertEqual(svc._lastIntrospectionPopulated, false, 'reset to false after capture');
  });

  test('two consecutive captures see correct flag state', () => {
    const svc = makeService();
    // First turn: populated=true, then capture, reset to false
    svc.setLastIntrospectionPopulated(true);
    svc._captureResponse({
      message: 'turn 1',
      response: 'Mein Modul A ist hier.',
      intent: 'self-inspect',
    });
    // Second turn: NO setLastIntrospectionPopulated call (e.g.
    // _introspectionContext returned empty for this turn)
    svc._captureResponse({
      message: 'turn 2',
      response: 'Mein Modul B existiert.',
      intent: 'general',
    });
    // Verify both turns wrote records — second one must have
    // introspectionPopulated=false thanks to reset.
    const today = new Date().toISOString().slice(0, 10);
    const shard = path.join(svc._dir, today + '.jsonl');
    const lines = fs.readFileSync(shard, 'utf8').trim().split('\n');
    assertEqual(lines.length, 2, 'two records');
    const r0 = JSON.parse(lines[0]);
    const r1 = JSON.parse(lines[1]);
    assertEqual(r0.introspectionPopulated, true,  'turn 1 had data');
    assertEqual(r1.introspectionPopulated, false, 'turn 2 had no data (reset worked)');
  });

  test('reset works even with empty/partial chat:completed payload', () => {
    const svc = makeService();
    svc.setLastIntrospectionPopulated(true);
    // Empty response — captureResponse skips the loop but still resets.
    svc._captureResponse({
      message: 'x',
      response: '',
      intent: 'general',
    });
    // Wait — empty response means _captureResponse does run but
    // statements is empty, so loop doesn't execute. The reset at the
    // end of the function still fires.
    assertEqual(svc._lastIntrospectionPopulated, false, 'reset even on empty response');
  });
});

run();
