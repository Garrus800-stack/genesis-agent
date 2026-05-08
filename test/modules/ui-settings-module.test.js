// ============================================================
// GENESIS test/modules/ui-settings-module.test.js (v7.7.0)
//
// Pins v7.7.0 fixes:
//   A2 — undoLastChange not-ready guard
//   A3 — undo placeholder fix ({commit} → {detail}) + inline result.detail
//   A4 — undo nothing-to-undo uses warning toast (not error)
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

function setup(undoResponse) {
  const dom = createMiniDOM();
  const genesis = createGenesisMock();
  // Stub agent:get-lang-strings for i18n bootstrap
  genesis.setHandler('agent:get-lang-strings', () => ({
    'ui.undo_success': 'Change reverted: {{detail}}',
    'ui.undo_failed': 'Undo failed: {{error}}',
    'ui.undo_nothing': 'Nothing to undo',
    'ui.still_starting': 'Still starting…',
  }));
  genesis.setHandler('agent:undo', () => undoResponse);
  global.document = dom.doc;
  global.window = { genesis: genesis.mock };
  // OS-agnostic cache clear via require.resolve
  for (const m of ['i18n', 'agent-state', 'statusbar', 'chat', 'settings', 'settings-defaults']) {
    try { delete require.cache[require.resolve(path.join(ROOT, 'src', 'ui', 'modules', m))]; } catch {}
  }
  return {
    settings: require(path.join(ROOT, 'src', 'ui', 'modules', 'settings')),
    agentState: require(path.join(ROOT, 'src', 'ui', 'modules', 'agent-state')),
    i18n: require(path.join(ROOT, 'src', 'ui', 'modules', 'i18n')),
    dom, genesis,
  };
}

(async () => {

await test('A2: undoLastChange shows toast when agent not ready', async () => {
  const { settings, agentState, dom, genesis } = setup({ ok: true, reverted: 'main.js' });
  agentState.setAgentReady(false);
  await settings.undoLastChange();
  // No IPC fired — guarded
  const undoCalls = genesis.calls.invoke.filter(c => c.channel === 'agent:undo');
  assert.strictEqual(undoCalls.length, 0, 'undo IPC must not fire when not ready');
  // Warning toast shown
  const container = dom.elements['toast-container'];
  assert.ok(container.children.length >= 1, 'warning toast must be shown');
});

await test('A3: undoLastChange success — toast uses {{detail}} not literal placeholder', async () => {
  const { settings, agentState, dom, i18n } = setup({ ok: true, reverted: 'main.js change' });
  await i18n.loadI18n();
  agentState.setAgentReady(true);
  await settings.undoLastChange();
  const container = dom.elements['toast-container'];
  // Find the success toast (skip any warning toasts)
  const successToast = Array.from(container.children).find(c => c.className.includes('toast-success'));
  assert.ok(successToast, 'success toast present');
  // After A3 fix: text is "Change reverted: main.js change"
  // (NOT "Change reverted: {{detail}}" literal — that was the bug)
  assert.ok(successToast.textContent.includes('main.js change'),
    `placeholder must be substituted: ${successToast.textContent}`);
  assert.ok(!successToast.textContent.includes('{{detail}}'),
    `literal {{detail}} must NOT appear: ${successToast.textContent}`);
});

await test('A3 bonus: chat message inlines result.detail (no ui.undo_detail key call)', async () => {
  const { settings, agentState, dom, i18n } = setup({
    ok: true, reverted: 'main.js', detail: 'Replaced foo() with bar()',
  });
  await i18n.loadI18n();
  agentState.setAgentReady(true);
  await settings.undoLastChange();
  const chatContainer = dom.elements['chat-messages'];
  assert.ok(chatContainer.children.length >= 1, 'chat message added');
  const msg = chatContainer.children[chatContainer.children.length - 1];
  // After A3 bonus: chat shows "↩ Replaced foo() with bar()"
  // NOT the literal "↩ ui.undo_detail" (which was the previous bug
  // because ui.undo_detail key doesn't exist in Language.js)
  assert.ok(msg.innerHTML.includes('Replaced foo'),
    `chat msg must contain detail text: ${msg.innerHTML}`);
  assert.ok(!msg.innerHTML.includes('ui.undo_detail'),
    `literal lang-key must NOT appear: ${msg.innerHTML}`);
});

await test('A4: undoLastChange nothing-to-undo uses warning toast', async () => {
  const { settings, agentState, dom, i18n } = setup({ ok: false });
  await i18n.loadI18n();
  agentState.setAgentReady(true);
  await settings.undoLastChange();
  const container = dom.elements['toast-container'];
  const warningToast = Array.from(container.children).find(c => c.className.includes('toast-warning'));
  assert.ok(warningToast, 'warning toast for nothing-to-undo');
  // Should NOT be 'toast-error' — that's the regression A4 fixes.
  const errorToast = Array.from(container.children).find(c => c.className.includes('toast-error'));
  assert.ok(!errorToast, 'must NOT be error toast');
});

await test('A4: undo with explicit error from backend → warning (not error)', async () => {
  const { settings, agentState, dom, i18n } = setup({ ok: false, error: 'No commits to undo' });
  await i18n.loadI18n();
  agentState.setAgentReady(true);
  await settings.undoLastChange();
  const container = dom.elements['toast-container'];
  const warningToast = Array.from(container.children).find(c => c.className.includes('toast-warning'));
  assert.ok(warningToast, 'backend error message → warning toast');
  assert.ok(warningToast.textContent.includes('No commits to undo'));
});

await test('undo IPC throw → error toast (catch path stays error)', async () => {
  const dom = createMiniDOM();
  const genesis = createGenesisMock();
  genesis.setHandler('agent:get-lang-strings', () => ({
    'ui.undo_failed': 'Undo failed: {{error}}', 'ui.still_starting': 'Still starting…',
  }));
  genesis.setHandler('agent:undo', () => { throw new Error('IPC dead'); });
  global.document = dom.doc;
  global.window = { genesis: genesis.mock };
  for (const m of ['i18n', 'agent-state', 'statusbar', 'chat', 'settings', 'settings-defaults']) {
    try { delete require.cache[require.resolve(path.join(ROOT, 'src', 'ui', 'modules', m))]; } catch {}
  }
  const { undoLastChange } = require(path.join(ROOT, 'src', 'ui', 'modules', 'settings'));
  const { setAgentReady } = require(path.join(ROOT, 'src', 'ui', 'modules', 'agent-state'));
  const { loadI18n } = require(path.join(ROOT, 'src', 'ui', 'modules', 'i18n'));
  await loadI18n();
  setAgentReady(true);
  await undoLastChange();
  const container = dom.elements['toast-container'];
  const errorToast = Array.from(container.children).find(c => c.className.includes('toast-error'));
  assert.ok(errorToast, 'thrown exception → error toast');
});

await test('A2: openSettings shows toast when agent not ready', async () => {
  const { settings, agentState, dom, genesis } = setup({});
  agentState.setAgentReady(false);
  await settings.openSettings();
  const settingsCalls = genesis.calls.invoke.filter(c => c.channel === 'agent:get-settings');
  assert.strictEqual(settingsCalls.length, 0, 'openSettings IPC must not fire when not ready');
  const container = dom.elements['toast-container'];
  assert.ok(container.children.length >= 1, 'warning toast shown');
});

await new Promise(r => setTimeout(r, 10));
console.log(`\n    ${passed} passed · ${failed} failed · v7.7.0 ui-settings-module`);
process.exit(failed > 0 ? 1 : 0);
})();
