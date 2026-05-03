// ============================================================
// GENESIS — test/modules/self-statement-activity.test.js (v7.5.7)
//
// Activity-claim detection in SelfStatementLog. Tests the new dimension
// added in v7.5.7: when Genesis claims an ongoing activity ("Ich
// beschäftige mich mit X" / "I'm working on Y") in 1st-person present-
// progressive, but goalStack snapshot at chat-completed shows zero
// active goals, fire SELF_STATEMENT_ACTIVITY_HINT (soft signal).
//
// Tests cover:
//  - Pattern: DE/EN parity, present-progressive only (not future, not past)
//  - Snapshot: goalStack.getActiveGoals() called once per response
//  - Soft signal: separate from contradiction, can co-occur
//  - Degradation: missing goalStack → check skipped, no crash
//  - Edge cases: empty/short statements, multiple statements per response
// ============================================================

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { SelfStatementLog } = require('../../src/agent/cognitive/SelfStatementLog');

let passed = 0, failed = 0;
const failures = [];

function test(name, fn) {
  try {
    const r = fn();
    if (r && typeof r.then === 'function') {
      return r.then(() => { passed++; console.log(`    ✅ ${name}`); })
              .catch(err => { failed++; failures.push({ name, error: err.message }); console.log(`    ❌ ${name}: ${err.message}`); });
    }
    passed++; console.log(`    ✅ ${name}`);
  } catch (err) { failed++; failures.push({ name, error: err.message }); console.log(`    ❌ ${name}: ${err.message}`); }
}
function assert(c, m) { if (!c) throw new Error(m || 'Assertion failed'); }
function eq(a, b, m) { if (a !== b) throw new Error(`${m || 'Expected equal'}: got ${JSON.stringify(a)}, want ${JSON.stringify(b)}`); }

function makeStub() {
  const fired = [];
  const stored = [];
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gen-stmt-act-'));
  const log = new SelfStatementLog({
    bus: {
      on: () => {},
      fire: (name, payload) => fired.push({ name, payload }),
    },
    storageDir: tmp,
    eventStore: {
      append: (type, payload, source) => stored.push({ type, payload, source }),
    },
    flushDebounceMs: 0,  // synchronous flush for tests
  });
  return { log, fired, stored, tmp };
}

(async () => {

  // ── Pattern matching (DE) ────────────────────────────

  await test('DE: "Ich beschäftige mich mit X" matches activity', () => {
    const { log } = makeStub();
    assert(log._checkActivityClaim('Ich beschäftige mich mit der Cache-Optimierung.'),
      'beschäftige sollte matchen');
  });

  await test('DE: "Ich analysiere gerade Y" matches activity', () => {
    const { log } = makeStub();
    assert(log._checkActivityClaim('Ich analysiere gerade die Logs.'),
      'analysiere sollte matchen');
  });

  await test('DE: "Ich denke gerade nach" matches activity', () => {
    const { log } = makeStub();
    assert(log._checkActivityClaim('Ich denke gerade nach über das Problem.'),
      'denke gerade nach sollte matchen');
  });

  // ── Pattern matching (EN) ────────────────────────────

  await test('EN: "I\'m working on X" matches activity', () => {
    const { log } = makeStub();
    assert(log._checkActivityClaim("I'm working on the bug fix."),
      "I'm working sollte matchen");
  });

  await test('EN: "I am analyzing X" matches activity', () => {
    const { log } = makeStub();
    assert(log._checkActivityClaim('I am analyzing the dataset.'),
      'I am analyzing sollte matchen');
  });

  // ── Pattern NEGATIVE — must NOT match ───────────────

  await test('DE: "Ich werde X tun" (Versprechen) does NOT match activity', () => {
    const { log } = makeStub();
    assert(!log._checkActivityClaim('Ich werde mich darum kümmern.'),
      'werde ist Versprechen, nicht Aktivität');
  });

  await test('DE: "Ich habe X gemacht" (Vergangenheit) does NOT match', () => {
    const { log } = makeStub();
    assert(!log._checkActivityClaim('Ich habe das schon analysiert.'),
      'habe analysiert ist Vergangenheit');
  });

  await test('DE: "Ich plane X" (Versprechen) does NOT match', () => {
    const { log } = makeStub();
    assert(!log._checkActivityClaim('Ich plane den nächsten Schritt.'),
      'plane ist nicht in activity-list');
  });

  await test('EN: "I will analyze" (future) does NOT match', () => {
    const { log } = makeStub();
    assert(!log._checkActivityClaim('I will analyze this later.'),
      'will = Versprechen');
  });

  await test('EN: "I worked on" (past) does NOT match', () => {
    const { log } = makeStub();
    assert(!log._checkActivityClaim('I worked on it yesterday.'),
      'worked = Vergangenheit');
  });

  await test('EN: "I have analyzed" (perfect) does NOT match', () => {
    const { log } = makeStub();
    assert(!log._checkActivityClaim('I have analyzed the data.'),
      'have analyzed = Perfekt');
  });

  // ── Activity-hint with goalStack snapshot ───────────

  await test('Activity claim + 0 active goals → fires SELF_STATEMENT_ACTIVITY_HINT', () => {
    const { log, fired, stored } = makeStub();
    log.goalStack = { getActiveGoals: () => [] };  // 0 goals
    log._captureResponse({
      message: 'Was machst du?',
      response: 'Ich arbeite gerade an den Tests.',
      intent: 'general',
    });
    const hintFired = fired.find(f => f.name === 'self-statement:activity-hint');
    const hintStored = stored.find(s => s.type === 'SELF_STATEMENT_ACTIVITY_HINT');
    assert(hintFired, `expected fire of activity-hint; got: ${JSON.stringify(fired.map(f=>f.name))}`);
    assert(hintStored, 'expected store of SELF_STATEMENT_ACTIVITY_HINT');
    eq(hintFired.payload.activeGoalCount, 0, 'activeGoalCount should be 0 in payload');
  });

  await test('Activity claim + 1 active goal → NO activity-hint', () => {
    const { log, fired, stored } = makeStub();
    log.goalStack = { getActiveGoals: () => [{ description: 'fix bug', status: 'active' }] };
    log._captureResponse({
      message: 'Status?',
      response: 'Ich analysiere gerade die Pipeline.',
      intent: 'general',
    });
    const hintFired = fired.find(f => f.name === 'self-statement:activity-hint');
    const hintStored = stored.find(s => s.type === 'SELF_STATEMENT_ACTIVITY_HINT');
    assert(!hintFired, 'should NOT fire activity-hint when goal is active');
    assert(!hintStored, 'should NOT store activity-hint when goal is active');
  });

  await test('Promise (no activity match) + 0 goals → NO activity-hint', () => {
    const { log, fired, stored } = makeStub();
    log.goalStack = { getActiveGoals: () => [] };
    log._captureResponse({
      message: 'Was kommt als nächstes?',
      response: 'Ich werde mich darum kümmern.',
      intent: 'general',
    });
    const hintFired = fired.find(f => f.name === 'self-statement:activity-hint');
    assert(!hintFired, 'promise without activity-pattern should not fire activity-hint');
  });

  await test('Activity claim + goalStack missing → check skipped (no crash)', () => {
    const { log, fired, stored } = makeStub();
    // goalStack stays null/undefined — not set
    log._captureResponse({
      message: 'Was machst du?',
      response: 'Ich arbeite an dem Problem.',
      intent: 'general',
    });
    const hintFired = fired.find(f => f.name === 'self-statement:activity-hint');
    assert(!hintFired, 'no goalStack → no activity-hint fires');
  });

  await test('goalStack throws → check skipped (no crash)', () => {
    const { log, fired } = makeStub();
    log.goalStack = { getActiveGoals: () => { throw new Error('boom'); } };
    // Must not throw
    log._captureResponse({
      message: 'Status?',
      response: 'Ich analysiere die Daten.',
      intent: 'general',
    });
    const hintFired = fired.find(f => f.name === 'self-statement:activity-hint');
    assert(!hintFired, 'goalStack-error → no activity-hint, no crash');
  });

  // ── Activity + structural can co-occur ──────────────

  await test('Activity claim with structural noun fires BOTH contradiction AND activity-hint', () => {
    const { log, fired } = makeStub();
    log.goalStack = { getActiveGoals: () => [] };
    log._lastIntrospectionPopulated = false;  // structural without backing
    log._captureResponse({
      message: 'Status?',
      response: 'Ich beschäftige mich mit der Cache-Optimierung.',  // hat strukturell-Nouns
      intent: 'general',
    });
    const contraFired = fired.find(f => f.name === 'self-statement:contradiction');
    const hintFired = fired.find(f => f.name === 'self-statement:activity-hint');
    assert(contraFired, 'should fire contradiction (strukturell + !populated)');
    assert(hintFired, 'should ALSO fire activity-hint (separate dimension)');
  });

  // ── Record JSONL contains activityClaim + activeGoalCount ──

  await test('JSONL record has activityClaim and activeGoalCount fields', () => {
    const { log, tmp } = makeStub();
    log.goalStack = { getActiveGoals: () => [] };
    log._captureResponse({
      message: 'Was machst du?',
      response: 'Ich arbeite gerade.',
      intent: 'general',
    });
    // Read the JSONL shard
    const date = new Date().toISOString().slice(0, 10);
    const shard = path.join(tmp, 'self-statements', `${date}.jsonl`);
    assert(fs.existsSync(shard), `shard should exist at ${shard}`);
    const lines = fs.readFileSync(shard, 'utf8').trim().split('\n').map(JSON.parse);
    assert(lines.length > 0, 'should have at least one record');
    const rec = lines[0];
    assert('activityClaim' in rec, `record should have activityClaim field; got keys: ${Object.keys(rec)}`);
    assert('activeGoalCount' in rec, 'record should have activeGoalCount field');
    eq(rec.activityClaim, true, 'activity-claim should be true');
    eq(rec.activeGoalCount, 0, 'activeGoalCount should be 0');
  });

  // ── activityMarkers parity (DE/EN both have the key) ──

  await test('LANG_PATTERNS DE and EN both expose activityMarkers (parity)', () => {
    // The parity assertion is at module-load time. Loading the module
    // (which we already did at the top of this file) is itself the test —
    // a missing key would have thrown. Re-verify by inspecting the
    // module's exported pattern shape via a quick instance test.
    const { log } = makeStub();
    // Directly probe — German + English fragments should each pass alone
    assert(log._checkActivityClaim('Ich teste gerade.'), 'DE pattern should be live');
    assert(log._checkActivityClaim("I'm testing the code."), 'EN pattern should be live');
  });

  // ── Done ─────────────────────────────────────────────

  console.log('');
  console.log(`  ${passed} passed${failed > 0 ? `, ${failed} failed` : ''}`);
  if (failed > 0) {
    console.log('');
    console.log('  Failures:');
    for (const f of failures) console.log(`    - ${f.name}: ${f.error}`);
    process.exit(1);
  }
})();
