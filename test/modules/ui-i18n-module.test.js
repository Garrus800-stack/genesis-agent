// ============================================================
// GENESIS test/modules/ui-i18n-module.test.js (v7.7.0)
//
// Tests for src/ui/modules/i18n.js — pinning the v7.7.0 (A1)
// {{var}} interpolation fix + multiple-occurrence semantics that
// match production Language.js strings.
// ============================================================

'use strict';

const path = require('path');
const assert = require('assert');

const ROOT = path.join(__dirname, '..', '..');
const { createMiniDOM } = require(path.join(ROOT, 'test', 'helpers', 'dom-shim'));
const { createGenesisMock } = require(path.join(ROOT, 'test', 'helpers', 'genesis-mock'));

let passed = 0, failed = 0;
function test(name, fn) {
  try {
    const r = fn();
    if (r && typeof r.then === 'function') {
      return r.then(
        () => { console.log(`    ✅ ${name}`); passed++; },
        (e) => { console.log(`    ❌ ${name}: ${e.message}`); failed++; }
      );
    }
    console.log(`    ✅ ${name}`); passed++;
  } catch (e) { console.log(`    ❌ ${name}: ${e.message}`); failed++; }
}

function loadFresh() {
  // require.resolve gives OS-native path (correct separators on Win + Linux)
  delete require.cache[require.resolve(path.join(ROOT, 'src', 'ui', 'modules', 'i18n'))];
  return require(path.join(ROOT, 'src', 'ui', 'modules', 'i18n'));
}

(async () => {

test('t() returns key when no translation', () => {
  const { t } = loadFresh();
  assert.strictEqual(t('does.not.exist'), 'does.not.exist');
});

test('t() handles undefined safely', () => {
  const { t } = loadFresh();
  let threw = false;
  try { t(); } catch { threw = true; }
  assert.ok(!threw, 't() with no args must not throw');
});

test('t() with vars but no translation returns key (no substitution)', () => {
  const { t } = loadFresh();
  assert.strictEqual(t('does.not.exist', { foo: 'bar' }), 'does.not.exist');
});

test('A1: t() interpolates {{var}} placeholders (v7.7.0 fix)', async () => {
  const { t, loadI18n } = loadFresh();
  global.window = {
    genesis: {
      invoke: () => Promise.resolve({ 'ui.test': 'Hello {{name}}!' }),
    },
  };
  global.document = createMiniDOM().doc;
  await loadI18n();
  assert.strictEqual(t('ui.test', { name: 'Garrus' }), 'Hello Garrus!',
    '{{var}} must substitute');
});

test('A1: t() handles multiple occurrences of same {{var}}', async () => {
  const { t, loadI18n } = loadFresh();
  global.window = {
    genesis: {
      invoke: () => Promise.resolve({ 'ui.echo': '{{x}} and {{x}} again' }),
    },
  };
  global.document = createMiniDOM().doc;
  await loadI18n();
  assert.strictEqual(t('ui.echo', { x: 'hi' }), 'hi and hi again',
    'multiple {{var}} all substituted');
});

test('A1: t() leaves unresolved {{vars}} alone if not in vars dict', async () => {
  const { t, loadI18n } = loadFresh();
  global.window = {
    genesis: {
      invoke: () => Promise.resolve({ 'ui.partial': 'a {{x}} b {{y}} c' }),
    },
  };
  global.document = createMiniDOM().doc;
  await loadI18n();
  assert.strictEqual(t('ui.partial', { x: 'X' }), 'a X b {{y}} c',
    'unresolved placeholder kept literal');
});

test('A1: t() coerces non-string values via String()', async () => {
  const { t, loadI18n } = loadFresh();
  global.window = {
    genesis: {
      invoke: () => Promise.resolve({ 'ui.count': '{{n}} items' }),
    },
  };
  global.document = createMiniDOM().doc;
  await loadI18n();
  assert.strictEqual(t('ui.count', { n: 42 }), '42 items', 'number coerced');
});

test('loadI18n fetches from agent:get-lang-strings', async () => {
  const { loadI18n, t } = loadFresh();
  let invoked = null;
  global.window = {
    genesis: {
      invoke: (channel) => {
        invoked = channel;
        return Promise.resolve({ 'k': 'v' });
      },
    },
  };
  global.document = createMiniDOM().doc;
  await loadI18n();
  assert.strictEqual(invoked, 'agent:get-lang-strings');
  assert.strictEqual(t('k'), 'v');
});

await new Promise(r => setTimeout(r, 10));
console.log(`\n    ${passed} passed · ${failed} failed · v7.7.0 ui-i18n-module`);
process.exit(failed > 0 ? 1 : 0);
})();
