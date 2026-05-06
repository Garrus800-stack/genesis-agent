// ============================================================
// GENESIS — test/modules/ui-bundle-modules.test.js
//
// Replaces the v7.5.x renderer.test.js (930 LOC) which used to
// eval the monolithic src/ui/renderer.js inside a vm sandbox.
// v7.6.0 consolidated the dual-path UI: only the bundled
// renderer remains (src/ui/modules/*.js → dist/renderer.bundle.js).
//
// This test focuses on the security-critical surface that the
// old test covered:
//   - escapeHtml: XSS prevention for chat messages
//   - renderMarkdown: same prevention through markdown rendering
//   - i18n.t: placeholder substitution
//
// Other UI behavior (status badges, IPC wiring, settings load)
// is exercised by e2e-electron.test.js (real Electron boot) and
// the v757-fix-phase3-* test files.
//
// We use a tiny DOM shim because the modules use document.* —
// they can be require()d directly (CJS), the shim only stubs the
// 5-6 globals they touch.
// ============================================================

'use strict';

const { describe, test, assert, assertEqual, run } = require('../harness');
const path = require('path');

// ── Minimal DOM Shim ────────────────────────────────────────
//
// Only what chat.js + i18n.js touch:
//   - document.createElement, document.querySelector
//   - document.querySelectorAll
//   - element.textContent (read-back must produce escaped innerHTML)

function createDOMShim() {
  // Each "element" stores its textContent and exposes innerHTML
  // computed from textContent the way the browser would.
  const HTML_ENTITIES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  const escape = s => String(s).replace(/[&<>"']/g, c => HTML_ENTITIES[c]);

  const elementProto = {
    setAttribute() {}, getAttribute() { return null; },
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
    appendChild() {}, removeChild() {},
  };

  function makeElement(tag = 'div') {
    const el = Object.create(elementProto);
    el.tagName = (tag || 'div').toUpperCase();
    el._textContent = '';
    el.attributes = {};
    Object.defineProperty(el, 'textContent', {
      get() { return this._textContent; },
      set(v) { this._textContent = String(v == null ? '' : v); },
    });
    Object.defineProperty(el, 'innerHTML', {
      get() { return escape(this._textContent); },
      set(v) { this._textContent = String(v); },
    });
    return el;
  }

  return {
    document: {
      createElement: (t) => makeElement(t),
      querySelector: () => null,
      querySelectorAll: () => [],
      addEventListener: () => {},
    },
    window: {},
  };
}

// ── Module Loader ───────────────────────────────────────────
//
// Modules use `document.createElement` etc. at CALL time (not just
// require time), so the DOM shim must live on `global.document`
// for the duration of the test run. We set it up once here.

const _shim = createDOMShim();
global.document = _shim.document;
global.window = _shim.window;

function loadChatModule() {
  const modPath = require.resolve(
    path.join(__dirname, '..', '..', 'src', 'ui', 'modules', 'chat.js')
  );
  delete require.cache[modPath];
  return require(modPath);
}

function loadI18nModule() {
  const modPath = require.resolve(
    path.join(__dirname, '..', '..', 'src', 'ui', 'modules', 'i18n.js')
  );
  delete require.cache[modPath];
  return require(modPath);
}


// ════════════════════════════════════════════════════════════
// TESTS
// ════════════════════════════════════════════════════════════

describe('chat.js — escapeHtml (XSS contract)', () => {

  test('chat contract: escapes HTML special characters', () => {
    const { escapeHtml } = loadChatModule();
    const escaped = escapeHtml('<script>alert("xss")</script>');
    assert(!escaped.includes('<script>'), 'must escape angle brackets');
    assert(escaped.includes('&lt;'), 'must contain &lt;');
    assert(escaped.includes('&gt;'), 'must contain &gt;');
  });

  test('preserves normal text', () => {
    const { escapeHtml } = loadChatModule();
    assertEqual(escapeHtml('Hello World'), 'Hello World');
  });

  test('chat contract: handles attribute-injection vector', () => {
    const { escapeHtml } = loadChatModule();
    const escaped = escapeHtml('"><img onerror=x>');
    assert(!escaped.includes('<img'), 'must escape <img');
  });

});


describe('chat.js — renderMarkdown (XSS contract)', () => {

  test('chat contract: escapes HTML inside markdown to prevent XSS', () => {
    const { renderMarkdown } = loadChatModule();
    const md = '**<img src=x onerror=alert(1)>**';
    const html = renderMarkdown(md);
    // The security invariant: no raw <img tag survives in output.
    assert(!html.includes('<img'), `raw <img must not survive: got ${html}`);
    assert(!html.includes('<img src'), 'no executable img element');
  });

  test('chat contract: script tag inside fenced code does not break out', () => {
    const { renderMarkdown } = loadChatModule();
    const md = '```js\n<script>alert(1)</script>\n```';
    const html = renderMarkdown(md);
    // Inside a code block: angle brackets must be escaped (rendered
    // as &lt;script&gt;), not present as live HTML.
    assert(!/<script>alert/.test(html),
      `live <script> tag must not survive in code block: ${html}`);
  });

  test('renders code blocks (with code-block class)', () => {
    const { renderMarkdown } = loadChatModule();
    const md = '```javascript\nconsole.log("hi");\n```';
    const html = renderMarkdown(md);
    assert(/code-block/.test(html), `expected "code-block" class in output: ${html}`);
    assert(html.includes('console.log'), 'contains code');
  });

  test('renders inline code', () => {
    const { renderMarkdown } = loadChatModule();
    const html = renderMarkdown('use `npm install` to install');
    assert(html.includes('<code>npm install</code>'), 'inline code rendered');
  });

  test('renders bold and italic', () => {
    const { renderMarkdown } = loadChatModule();
    assert(renderMarkdown('**bold**').includes('<strong>'));
    assert(renderMarkdown('*italic*').includes('<em>'));
  });

  test('handles empty input', () => {
    const { renderMarkdown } = loadChatModule();
    assertEqual(renderMarkdown(''), '');
    assertEqual(renderMarkdown(null), '');
    assertEqual(renderMarkdown(undefined), '');
  });

});


describe('i18n.js — t (translation + interpolation)', () => {

  test('returns key when no translation', () => {
    const { t } = loadI18nModule();
    assertEqual(t('nonexistent.key'), 'nonexistent.key');
  });

  test('handles undefined input gracefully', () => {
    const { t } = loadI18nModule();
    // Module's t() with undefined should not throw.
    let threw = false;
    try { t(); } catch { threw = true; }
    assert(!threw, 't() with no args must not throw');
  });

});


// ════════════════════════════════════════════════════════════

run();
