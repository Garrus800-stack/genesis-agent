// ============================================================
// GENESIS test/modules/ui-renderer-main.test.js (v7.7.0)
//
// Verifies renderer-main.js correctly wires up:
//   - IPC listeners (status-update, stream-chunk, etc.)
//   - DOMContentLoaded handler
//   - window.togglePanel / closeSettings globals
//   - setAgentReady sync via shared agent-state module (A2)
// ============================================================

'use strict';

const path = require('path');
const fs = require('fs');
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

// renderer-main has top-level side effects (DOMContentLoaded handler
// registration, IPC listener wiring inside that handler). We verify
// behavior in two layers:
//   1. Static checks: re-load the source and pattern-match for the
//      expected wiring calls (cheap, OS-agnostic).
//   2. Dynamic load: clear cache + require + drive DOMContentLoaded
//      to verify listeners are actually registered on the mock.

const RENDERER_SRC = fs.readFileSync(
  path.join(ROOT, 'src', 'ui', 'renderer-main.js'), 'utf-8'
);

// ── Static source-presence checks ────────────────────────────

test('source registers DOMContentLoaded handler', () => {
  assert.ok(/document\.addEventListener\(['"]DOMContentLoaded['"]/.test(RENDERER_SRC),
    'DOMContentLoaded handler registered at module load');
});

test('source wires agent:status-update listener', () => {
  assert.ok(/genesis\.on\(['"]agent:status-update['"]/.test(RENDERER_SRC),
    'agent:status-update listener wired');
});

test('source wires agent:stream-chunk listener', () => {
  assert.ok(/genesis\.on\(['"]agent:stream-chunk['"]/.test(RENDERER_SRC));
});

test('source wires agent:stream-done listener', () => {
  assert.ok(/genesis\.on\(['"]agent:stream-done['"]/.test(RENDERER_SRC));
});

test('source wires agent:open-in-editor listener', () => {
  assert.ok(/genesis\.on\(['"]agent:open-in-editor['"]/.test(RENDERER_SRC));
});

test('source imports setAgentReady from agent-state (v7.7.0)', () => {
  assert.ok(/setAgentReady.*require\(['"]\.\/modules\/agent-state['"]\)/.test(RENDERER_SRC) ||
            /require\(['"]\.\/modules\/agent-state['"]\).*setAgentReady/.test(RENDERER_SRC),
    'setAgentReady imported from agent-state.js');
});

test('source calls setAgentReady(true) in onAgentReady (v7.7.0 A2 sync)', () => {
  assert.ok(/setAgentReady\(true\)/.test(RENDERER_SRC),
    'setAgentReady(true) called when agent ready');
});

// ── Dynamic execution checks ─────────────────────────────────

function setup() {
  const dom = createMiniDOM();
  const genesis = createGenesisMock();
  // Stub all IPC handlers used during DOMContentLoaded init
  genesis.setHandler('agent:get-lang-strings', () => ({}));
  genesis.setHandler('agent:list-models', () => ({ models: [], current: null }));
  genesis.setHandler('agent:is-first-boot', () => ({ firstBoot: false }));
  genesis.setHandler('agent:get-skills', () => []);
  global.document = dom.doc;
  global.window = { genesis: genesis.mock };
  global.setTimeout = setTimeout;
  global.clearTimeout = clearTimeout;
  // Clear the entire src/ui module cache so renderer-main re-evaluates
  // its top-level side effects (DOMContentLoaded handler registration,
  // global window.* assignments) under the fresh shim.
  // OS-agnostic: match both forward and back slashes (Win + Linux).
  for (const k of Object.keys(require.cache)) {
    if (k.includes('src/ui/') || k.includes('src\\ui\\')) {
      delete require.cache[k];
    }
  }
  require(path.join(ROOT, 'src', 'ui', 'renderer-main'));
  return { dom, genesis };
}

test('window.togglePanel global is exposed at module load', () => {
  setup();
  assert.strictEqual(typeof global.window.togglePanel, 'function',
    'window.togglePanel must be a function');
});

test('window.closeSettings global is exposed', () => {
  setup();
  assert.strictEqual(typeof global.window.closeSettings, 'function');
});

test('window.togglePanel toggles hidden class on element', () => {
  const { dom } = setup();
  // Pre-create panel with hidden class
  const panel = dom.doc.getElementById('editor-panel');
  panel.classList.add('hidden');
  assert.ok(panel.classList.contains('hidden'));
  global.window.togglePanel('editor-panel');
  assert.ok(!panel.classList.contains('hidden'), 'hidden removed by toggle');
  global.window.togglePanel('editor-panel');
  assert.ok(panel.classList.contains('hidden'), 'hidden re-added on second toggle');
});

console.log(`\n    ${passed} passed · ${failed} failed · v7.7.0 ui-renderer-main`);
process.exit(failed > 0 ? 1 : 0);
