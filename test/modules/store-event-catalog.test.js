// ============================================================
// Regression test: EventStore.append() ↔ EventTypes.STORE catalog
//
// Original v7.5.6 carry-over (live-found 2026-05-02 Windows DEV-warning):
// SelfStatementLog._fireContradiction calls eventStore.append(
//   'SELF_STATEMENT_CONTRADICTION', ...). EventStore.append then
// emits('store:SELF_STATEMENT_CONTRADICTION'). The catalog entry
// was missing — every contradiction produced a [EVENT:DEV] Unknown
// event warning. Functional behaviour was correct, telemetry noisy.
//
// v7.6.3 extension: B1+B2 generalize the check. Every static
// eventStore.append('TYPE', ...) call site in src/agent/ MUST have
// a matching EVENTS.STORE.TYPE entry AND a payload schema for
// 'store:TYPE'. The dynamic emit `bus.fire(\`store:\${type}\`, ...)`
// in EventStore.append is invisible to grep-based audits, so this
// test is the only thing that catches catalog drift on the
// store:* namespace.
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

// Walk src/agent/ collecting every `eventStore.append('TYPE'` and
// `this.es.append('TYPE'` call site. Optional-chaining is supported
// since several modules use `eventStore?.append('TYPE'`.
function collectAppendCallsites() {
  const ROOT = path.join(__dirname, '../../src/agent');
  const types = new Map(); // TYPE → [{file, line}]

  function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
        walk(full);
      } else if (entry.isFile() && entry.name.endsWith('.js')) {
        const content = fs.readFileSync(full, 'utf8');
        const lines = content.split('\n');
        // Skip EventStore.js itself — it is the dispatcher, not a caller
        if (full.endsWith(path.join('foundation', 'EventStore.js'))) continue;
        for (let i = 0; i < lines.length; i++) {
          // Match (this.eventStore | this.es | eventStore | es)(?.)?.append('TYPE'
          const matches = lines[i].matchAll(
            /\b(?:this\.)?(?:eventStore|es)\??\.append\(\s*['"]([A-Z_][A-Z0-9_]*)['"]/g
          );
          for (const m of matches) {
            const type = m[1];
            if (!types.has(type)) types.set(type, []);
            types.get(type).push({ file: path.relative(ROOT, full), line: i + 1 });
          }
        }
      }
    }
  }

  walk(ROOT);
  return types;
}

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

test('A3 SelfStatementClassifier._fireContradiction still references SELF_STATEMENT_CONTRADICTION', () => {
  // v7.6.1: _fireContradiction was extracted from SelfStatementLog into a
  // classifier mixin. The eventStore.append call now lives in the new file.
  const src = fs.readFileSync(
    path.join(__dirname, '../../src/agent/cognitive/SelfStatementClassifier.js'),
    'utf8'
  );
  assert(/eventStore\.append\(\s*['"]SELF_STATEMENT_CONTRADICTION['"]/.test(src),
    'SelfStatementClassifier must still call eventStore.append("SELF_STATEMENT_CONTRADICTION")');
});

// ── B1+B2: General-purpose drift guard for the entire store:* namespace ──

test('B1 every eventStore.append("TYPE") call has a matching EVENTS.STORE.TYPE entry', () => {
  const { EVENTS } = require('../../src/agent/core/EventTypes');
  const callsites = collectAppendCallsites();
  const missing = [];
  for (const [type, locs] of callsites) {
    const aliasName = `store:${type}`;
    // EVENTS.STORE values match against full prefix-form
    const present = Object.values(EVENTS.STORE).includes(aliasName);
    if (!present) {
      missing.push({ type, aliasName, sample: locs[0] });
    }
  }
  if (missing.length > 0) {
    const detail = missing.map(m =>
      `  ${m.aliasName} (${m.sample.file}:${m.sample.line})`
    ).join('\n');
    throw new Error(
      `${missing.length} append() call site(s) without EVENTS.STORE catalog entry:\n${detail}`
    );
  }
});

test('B2 every eventStore.append("TYPE") call has a payload schema for "store:TYPE"', () => {
  const { SCHEMAS } = require('../../src/agent/core/EventPayloadSchemas');
  const callsites = collectAppendCallsites();
  const missing = [];
  for (const [type, locs] of callsites) {
    const aliasName = `store:${type}`;
    if (!SCHEMAS[aliasName]) {
      missing.push({ aliasName, sample: locs[0] });
    }
  }
  if (missing.length > 0) {
    const detail = missing.map(m =>
      `  ${m.aliasName} (${m.sample.file}:${m.sample.line})`
    ).join('\n');
    throw new Error(
      `${missing.length} append() call site(s) without payload schema:\n${detail}`
    );
  }
});

console.log(`\n  store-event-catalog: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.log('\n  Failures:');
  failures.forEach(f => console.log(`    - ${f.name}: ${f.error}`));
  process.exit(1);
}
