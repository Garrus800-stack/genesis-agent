// ============================================================
// GENESIS test/modules/ui-statusbar-module.test.js (v7.7.0)
//
// Pins v7.7.0 fixes:
//   A5 — showToast stack limit ≤5
//   A6 — warning state surfaces toast
//   A7 — STATE_TO_CSS mapping (legacy parity), insight + resting,
//        unknown state fallback to badge-booting
// ============================================================

'use strict';

const path = require('path');
const assert = require('assert');

const ROOT = path.join(__dirname, '..', '..');
const { createMiniDOM } = require(path.join(ROOT, 'test', 'helpers', 'dom-shim'));

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`    ✅ ${name}`); passed++; }
  catch (e) { console.log(`    ❌ ${name}: ${e.message}`); failed++; }
}

function setup() {
  const dom = createMiniDOM();
  global.document = dom.doc;
  global.window = { genesis: { invoke: () => Promise.resolve({}) } };
  // OS-agnostic cache clear via require.resolve
  delete require.cache[require.resolve(path.join(ROOT, 'src', 'ui', 'modules', 'statusbar'))];
  delete require.cache[require.resolve(path.join(ROOT, 'src', 'ui', 'modules', 'i18n'))];
  delete require.cache[require.resolve(path.join(ROOT, 'src', 'ui', 'modules', 'agent-state'))];
  return { statusbar: require(path.join(ROOT, 'src', 'ui', 'modules', 'statusbar')), dom };
}

// ── showToast ────────────────────────────────────────────────

test('showToast creates toast with correct class', () => {
  const { statusbar, dom } = setup();
  statusbar.showToast('hello', 'info');
  const container = dom.elements['toast-container'];
  assert.strictEqual(container.children.length, 1);
  assert.ok(container.children[0].className.includes('toast-info'));
  assert.strictEqual(container.children[0].textContent, 'hello');
});

test('A5: showToast stack limit ≤5 (memory leak fix)', () => {
  const { statusbar, dom } = setup();
  for (let i = 0; i < 7; i++) statusbar.showToast(`msg-${i}`, 'info');
  const container = dom.elements['toast-container'];
  assert.strictEqual(container.children.length, 5,
    `stack must be capped at 5, got ${container.children.length}`);
});

test('A5: showToast removes oldest when overflowing', () => {
  const { statusbar, dom } = setup();
  for (let i = 0; i < 7; i++) statusbar.showToast(`msg-${i}`, 'info');
  const container = dom.elements['toast-container'];
  // First two should have been removed (msg-0 and msg-1)
  assert.strictEqual(container.children[0].textContent, 'msg-2');
  assert.strictEqual(container.children[4].textContent, 'msg-6');
});

// ── updateStatus — STATE_TO_CSS mapping ──────────────────────

test('A7: ready → badge-ready', () => {
  const { statusbar, dom } = setup();
  statusbar.updateStatus({ state: 'ready' });
  assert.ok(dom.elements['status-badge'].className.includes('badge-ready'),
    `expected badge-ready, got ${dom.elements['status-badge'].className}`);
});

test('A7: thinking → badge-thinking (v7.7.3: dedicated class, was badge-working pre-v7.7.3)', () => {
  const { statusbar, dom } = setup();
  statusbar.updateStatus({ state: 'thinking' });
  assert.ok(dom.elements['status-badge'].className.includes('badge-thinking'),
    `expected badge-thinking, got ${dom.elements['status-badge'].className}`);
});

test('A7: self-modifying → badge-working', () => {
  const { statusbar, dom } = setup();
  statusbar.updateStatus({ state: 'self-modifying' });
  assert.ok(dom.elements['status-badge'].className.includes('badge-working'));
});

test('A7: error → badge-error', () => {
  const { statusbar, dom } = setup();
  statusbar.updateStatus({ state: 'error' });
  assert.ok(dom.elements['status-badge'].className.includes('badge-error'));
});

test('A7: warning → badge-error (legacy parity)', () => {
  const { statusbar, dom } = setup();
  statusbar.updateStatus({ state: 'warning' });
  // Legacy used badge-error class for warnings (renderer.js Z.82)
  assert.ok(dom.elements['status-badge'].className.includes('badge-error'),
    `warning must use error class for legacy parity, got ${dom.elements['status-badge'].className}`);
});

test('A7: unknown state defaults to badge-booting', () => {
  const { statusbar, dom } = setup();
  statusbar.updateStatus({ state: 'frobnicating' });
  assert.ok(dom.elements['status-badge'].className.includes('badge-booting'),
    `unknown state must fall back to booting, got ${dom.elements['status-badge'].className}`);
});

test('A7: insight state has 💡 label (was previously raw state name)', () => {
  const { statusbar, dom } = setup();
  statusbar.updateStatus({ state: 'insight' });
  assert.ok(dom.elements['status-badge'].textContent.includes('💡'),
    `insight needs 💡 icon, got ${dom.elements['status-badge'].textContent}`);
});

test('A7: resting state has 😴 label', () => {
  const { statusbar, dom } = setup();
  statusbar.updateStatus({ state: 'resting' });
  assert.ok(dom.elements['status-badge'].textContent.includes('😴'),
    `resting needs 😴 icon, got ${dom.elements['status-badge'].textContent}`);
});

// ── A6: warning surfaces toast ────────────────────────────────

test('A6: warning state additionally fires showToast', () => {
  const { statusbar, dom } = setup();
  statusbar.updateStatus({ state: 'warning', detail: 'Ollama not reachable' });
  const container = dom.elements['toast-container'];
  assert.strictEqual(container.children.length, 1, 'warning must produce a toast');
  assert.ok(container.children[0].className.includes('toast-warning'),
    `expected toast-warning class`);
  assert.ok(container.children[0].textContent.includes('Ollama not reachable'),
    'toast must contain status.detail');
});

// ── status.detail in tooltip ────────────────────────────────

test('A10: status.detail goes to tooltip (title attr), not badge text', () => {
  const { statusbar, dom } = setup();
  statusbar.updateStatus({ state: 'thinking', detail: 'Loading model llama3:8b' });
  const badge = dom.elements['status-badge'];
  // Source uses `badge.title = status.detail` — direct property
  assert.strictEqual(badge.title, 'Loading model llama3:8b',
    'detail in title property');
  // Badge textContent stays as the static label, NOT the detail text.
  // This was the regression from a v7.7.0 pre-release attempt where
  // the badge showed the model name instead of "Thinking".
  assert.ok(!badge.textContent.includes('llama3:8b'),
    `badge text must not show detail (clutters topbar), got "${badge.textContent}"`);
});

console.log(`\n    ${passed} passed · ${failed} failed · v7.7.0 ui-statusbar-module`);
process.exit(failed > 0 ? 1 : 0);
