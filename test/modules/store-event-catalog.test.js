// ============================================================
// Regression test: store:SELF_STATEMENT_CONTRADICTION catalog entry
//
// v7.5.6 carry-over (live-found 2026-05-02 Windows DEV-warning):
// SelfStatementLog._fireContradiction calls eventStore.append(
//   'SELF_STATEMENT_CONTRADICTION', ...). EventStore.append then
// emits('store:SELF_STATEMENT_CONTRADICTION'). The catalog entry
// was missing — every contradiction produced a [EVENT:DEV] Unknown
// event warning. Functional behaviour was correct (the contradiction
// reached EventStore), but telemetry was noisy.
//
// This test locks the catalog entry + payload schema in so they
// cannot be removed silently in a future cleanup.
// ============================================================

'use strict';

const path = require('path');
const fs = require('fs');

let passed = 0, failed = 0;
const failures = [];
function test(name, fn) {
  try {
    fn();
    passed++; console.log(`    ✅ ${name}`);
  } catch (err) {
    failed++; failures.push({ name, error: err.message });
    console.log(`    ❌ ${name}: ${err.message}`);
  }
}
function assert(c, m) { if (!c) throw new Error(m || 'Assertion failed'); }

console.log('  store-event-catalog tests:');

test('A1 EventTypes.STORE.SELF_STATEMENT_CONTRADICTION is "store:SELF_STATEMENT_CONTRADICTION"', () => {
  const { EVENTS } = require('../../src/agent/core/EventTypes');
  assert(EVENTS.STORE.SELF_STATEMENT_CONTRADICTION === 'store:SELF_STATEMENT_CONTRADICTION',
    `got "${EVENTS.STORE.SELF_STATEMENT_CONTRADICTION}"`);
});

test('A2 EventPayloadSchemas has store:SELF_STATEMENT_CONTRADICTION', () => {
  const src = fs.readFileSync(
    path.join(__dirname, '../../src/agent/core/EventPayloadSchemas.js'),
    'utf8'
  );
  assert(/'store:SELF_STATEMENT_CONTRADICTION'\s*:/.test(src),
    'schema missing in EventPayloadSchemas.js');
});

test('A3 SelfStatementLog._fireContradiction still references SELF_STATEMENT_CONTRADICTION', () => {
  const src = fs.readFileSync(
    path.join(__dirname, '../../src/agent/cognitive/SelfStatementLog.js'),
    'utf8'
  );
  assert(/eventStore\.append\(\s*['"]SELF_STATEMENT_CONTRADICTION['"]/.test(src),
    'SelfStatementLog must still call eventStore.append("SELF_STATEMENT_CONTRADICTION")');
});

console.log(`\n  store-event-catalog: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.log('\n  Failures:');
  failures.forEach(f => console.log(`    - ${f.name}: ${f.error}`));
  process.exit(1);
}
