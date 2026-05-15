// ============================================================
// GENESIS — test/modules/v785-effective-model-ui.test.js (v7.8.5)
//
// effective-model-ui contract: on failover, the model dropdown
// shows the model that actually answered — same slot the
// preferred model normally occupies. No separate badge, no
// flashing, no tooltip. Just the model name. Switching to a
// different model via the dropdown still works as before
// because programmatic .value assignment does not fire `change`.
// ============================================================

'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

let passed = 0, failed = 0;
const failures = [];

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`    ✅ ${name}`);
  } catch (err) {
    failed++;
    failures.push({ name, error: err.message });
    console.log(`    ❌ ${name}: ${err.message}`);
  }
}

const ROOT = path.join(__dirname, '..', '..');
const HTML = fs.readFileSync(path.join(ROOT, 'src/ui/index.html'), 'utf-8');
const CSS  = fs.readFileSync(path.join(ROOT, 'src/ui/styles.css'), 'utf-8');
const JS   = fs.readFileSync(path.join(ROOT, 'src/ui/renderer-main.js'), 'utf-8');

test('effective-model-ui contract: no separate badge element in markup', () => {
  // The badge approach was the wrong design — refusing to regress to it.
  assert.ok(!HTML.includes('model-effective-indicator'),
    'index.html must NOT contain a separate effective-model badge element');
  assert.ok(!CSS.includes('.topbar-effective'),
    'styles.css must NOT contain a separate badge CSS rule');
});

test('effective-model-ui contract: refresh function exists and operates on the dropdown', () => {
  assert.match(JS, /async function refreshEffectiveModelDisplay\s*\(/,
    'refreshEffectiveModelDisplay must be defined');
  const fn = JS.match(/async function refreshEffectiveModelDisplay[\s\S]+?\n\}/);
  assert.ok(fn, 'function body must be present');
  assert.match(fn[0], /#model-select/,
    'refresh must operate on the #model-select dropdown directly');
});

test('effective-model-ui contract: render uses failoverReason as primary gate', () => {
  const fn = JS.match(/async function refreshEffectiveModelDisplay[\s\S]+?\n\}/)[0];
  assert.match(fn, /m\.failoverReason/,
    'render must check failoverReason — auto-routing must not trigger display change');
  assert.match(fn, /m\.effective\s*!==\s*m\.active/,
    'render must also confirm effective !== active');
});

test('effective-model-ui contract: render sets select.value, not innerHTML', () => {
  // Setting .value is essential: it leaves the option list intact AND
  // does not fire the `change` event (only user input does).
  const fn = JS.match(/async function refreshEffectiveModelDisplay[\s\S]+?\n\}/)[0];
  assert.match(fn, /select\.value\s*=\s*target/,
    'must assign select.value to the target model name');
  assert.ok(!/innerHTML/.test(fn),
    'must NOT manipulate innerHTML (would destroy option list)');
});

test('effective-model-ui contract: render only acts if target exists among options', () => {
  // Guard against setting .value to a name that is not in the option
  // list — that would be a silent visual no-op and produce confusion.
  const fn = JS.match(/async function refreshEffectiveModelDisplay[\s\S]+?\n\}/)[0];
  assert.match(fn, /Array\.from\(select\.options\)\.some\(o\s*=>\s*o\.value\s*===\s*target\)/,
    'must verify target is among select.options before assigning');
});

test('effective-model-ui contract: stream-done refreshes the display', () => {
  const block = JS.match(/window\.genesis\.on\('agent:stream-done'[\s\S]+?\}\);/);
  assert.ok(block, 'agent:stream-done handler must exist');
  assert.match(block[0], /refreshEffectiveModelDisplay/,
    'stream-done must call refreshEffectiveModelDisplay');
});

test('effective-model-ui contract: boot also refreshes once', () => {
  const bootRegion = JS.match(/loadModels\(\);[\s\S]{0,400}/);
  assert.ok(bootRegion, 'loadModels() boot call must exist');
  assert.match(bootRegion[0], /refreshEffectiveModelDisplay/,
    'boot must also refresh the display');
});

test('effective-model-ui contract: user dropdown change handler untouched', () => {
  // Verify the change listener is still wired the same way — this is the
  // path that legitimately writes to settings. Programmatic .value
  // assignment does not fire `change`, so this path is safe.
  assert.match(JS, /#model-select.*addEventListener\(\s*['"]change['"]/s,
    'change listener on #model-select must still exist');
  assert.match(JS, /agent:switch-model/,
    'change listener must still invoke agent:switch-model');
});

if (failed > 0) {
  console.log(`\n  ${failed} failure(s):`);
  for (const f of failures) console.log(`    - ${f.name}: ${f.error}`);
  process.exit(1);
}
console.log(`    ${passed} passed`);
