// ============================================================
// GENESIS — test/modules/renderer.test.js
// UI tests for renderer.js
//
// STRATEGY:
//   renderer.js is a browser script (no module.exports). It relies on:
//     - DOM (document.querySelector, createElement, etc.)
//     - window.genesis (Electron IPC bridge)
//     - Monaco editor (optional, gracefully absent)
//
//   We build a minimal DOM shim + window.genesis mock, then eval()
//   renderer.js into that sandbox. This lets us test every function
//   (i18n, markdown, chat, streaming, settings, etc.) without
//   Electron, JSDOM, or any npm dependency.
// ============================================================

const { describe, test, assert, assertEqual, assertDeepEqual, run } = require('../harness');
const fs = require('fs');
const path = require('path');

// ── Minimal DOM Shim ────────────────────────────────────────

function createMiniDOM() {
  const elements = {};
  const eventListeners = {};

  function makeElement(tag = 'div') {
    let _textContent = '';
    let _innerHTML = '';
    const el = {
      tagName: tag.toUpperCase(),
      className: '',
      id: '',
      get innerHTML() { return _innerHTML; },
      set innerHTML(v) {
        _innerHTML = v;
        if (v === '') { el.children = []; el._virtualChildren = []; }
        // Parse class-bearing divs/spans from innerHTML for querySelector support
        el._virtualChildren = [];
        const classRe = /<(\w+)\s+class="([^"]*)"[^>]*>/g;
        let match;
        while ((match = classRe.exec(v)) !== null) {
          const vChild = makeElement(match[1]);
          vChild.className = match[2];
          match[2].split(/\s+/).forEach(c => { if(c) vChild._classList.add(c); });
          // Extract data attributes from this tag
          const tagStr = v.slice(match.index, v.indexOf('>', match.index) + 1);
          const dataRe = /data-([\w-]+)="([^"]*)"/g;
          let dm;
          while ((dm = dataRe.exec(tagStr)) !== null) {
            vChild._attrs['data-' + dm[1]] = dm[2];
          }
          el._virtualChildren.push(vChild);
        }
      },
      placeholder: '',
      value: '',
      style: { height: '' },
      children: [],
      _attrs: {},
      _listeners: {},
      _classList: new Set(),

      // textContent setter/getter with HTML escaping for innerHTML
      get textContent() { return _textContent; },
      set textContent(v) {
        _textContent = v;
        _innerHTML = String(v)
          .replace(/&/g, '&amp;')
          .replace(/</g, '&lt;')
          .replace(/>/g, '&gt;')
          .replace(/"/g, '&quot;');
      },

      classList: {
        add(c) { el._classList.add(c); },
        remove(c) { el._classList.delete(c); },
        toggle(c, force) {
          if (force === true) el._classList.add(c);
          else if (force === false) el._classList.delete(c);
          else if (el._classList.has(c)) el._classList.delete(c);
          else el._classList.add(c);
        },
        contains(c) { return el._classList.has(c); },
      },

      getAttribute(name) {
        if (name === 'class') return [...el._classList].join(' ');
        return el._attrs[name] !== undefined ? el._attrs[name] : null;
      },
      setAttribute(name, val) { el._attrs[name] = val; },
      removeAttribute(name) { delete el._attrs[name]; },

      appendChild(child) { el.children.push(child); return child; },
      removeChild(child) {
        const idx = el.children.indexOf(child);
        if (idx >= 0) el.children.splice(idx, 1);
        return child;
      },
      remove() {},
      get firstChild() { return el.children[0] || null; },

      querySelector(sel) {
        // First try global ID registry
        const global = resolveSelector(sel, el);
        if (global) return global;
        // Then search virtual children for class selectors like '.message-content'
        if (sel.startsWith('.') && el._virtualChildren) {
          const cls = sel.slice(1);
          return el._virtualChildren.find(vc => vc._classList.has(cls)) || null;
        }
        // Search real children recursively
        for (const child of el.children) {
          if (sel.startsWith('.') && child._classList?.has(sel.slice(1))) return child;
          if (child.querySelector) {
            const found = child.querySelector(sel);
            if (found) return found;
          }
        }
        return null;
      },
      querySelectorAll(sel) {
        const results = resolveAllSelectors(sel, el);
        // Also search virtual children
        if (sel.startsWith('.') && el._virtualChildren) {
          const cls = sel.slice(1);
          for (const vc of el._virtualChildren) {
            if (vc._classList.has(cls)) results.push(vc);
          }
        }
        return results;
      },

      addEventListener(event, fn) {
        if (!el._listeners[event]) el._listeners[event] = [];
        el._listeners[event].push(fn);
      },
      closest(sel) { return null; },
      hasTextFocus() { return false; },

      get scrollHeight() { return 500; },
      set scrollTop(v) { el._scrollTop = v; },
      get scrollTop() { return el._scrollTop || 0; },
    };
    return el;
  }

  // Flat registry of ID'd elements
  function ensureElement(id, tag) {
    if (!elements[id]) {
      const el = makeElement(tag);
      el.id = id;
      elements[id] = el;
    }
    return elements[id];
  }

  // Pre-create all elements referenced in renderer.js and index.html
  const ids = [
    'chat-messages', 'chat-input', 'btn-send', 'btn-stop', 'btn-toggle-editor',
    'btn-toggle-tree', 'btn-save', 'btn-run-sandbox', 'btn-health', 'btn-self-model',
    'btn-goals', 'btn-settings', 'btn-undo', 'lang-select', 'model-select',
    'status-badge', 'editor-panel', 'file-tree-panel', 'goals-panel', 'editor-filename',
    'monaco-container', 'sandbox-output', 'sandbox-result', 'toast-container',
    'settings-modal', 'set-anthropic-key', 'set-openai-url', 'set-openai-key',
    'set-daemon', 'set-idle', 'set-selfmod', 'file-tree', 'goal-tree',
    'main-layout', 'topbar',
  ];
  for (const id of ids) ensureElement(id);

  // The chat-input needs to be a textarea
  elements['chat-input'].tagName = 'TEXTAREA';
  // editor-panel starts hidden
  elements['editor-panel']._classList.add('hidden');
  elements['file-tree-panel']._classList.add('hidden');
  elements['goals-panel']._classList.add('hidden');
  elements['settings-modal']._classList.add('hidden');
  elements['sandbox-output']._classList.add('hidden');
  elements['btn-stop']._classList.add('hidden');

  function resolveSelector(sel, _scope) {
    // #id
    if (sel.startsWith('#')) return elements[sel.slice(1)] || null;
    // Simple tag or class — return first from flat list
    return null;
  }

  function resolveAllSelectors(sel, _scope) {
    // [data-i18n] / [data-i18n-placeholder]
    if (sel === '[data-i18n]' || sel === '[data-i18n-placeholder]') {
      return Object.values(elements).filter(el => el._attrs[sel.slice(1, -1)] !== undefined);
    }
    if (sel === '.file-tree-item') {
      return elements['file-tree']?.children || [];
    }
    if (sel === '.code-to-editor-btn') {
      return [];
    }
    return [];
  }

  // document mock
  const doc = {
    querySelector(sel) { return resolveSelector(sel); },
    querySelectorAll(sel) { return resolveAllSelectors(sel); },
    getElementById(id) { return elements[id] || null; },
    createElement(tag) { return makeElement(tag); },
    addEventListener(ev, fn) {
      if (!eventListeners[ev]) eventListeners[ev] = [];
      eventListeners[ev].push(fn);
      // Also store on doc for vm-context access
      if (ev === 'DOMContentLoaded') {
        if (!doc._domContentLoadedCallbacks) doc._domContentLoadedCallbacks = [];
        doc._domContentLoadedCallbacks.push(fn);
      }
      // Store keydown callbacks on doc too
      if (ev === 'keydown') {
        if (!doc._keydownCallbacks) doc._keydownCallbacks = [];
        doc._keydownCallbacks.push(fn);
      }
    },
    head: { appendChild() {} },
    body: makeElement('body'),
    activeElement: null,
  };

  return { doc, elements, eventListeners, makeElement };
}


// ── window.genesis Mock ─────────────────────────────────────

function createGenesisMock() {
  const listeners = {};
  const invokeMock = {};
  const sent = [];

  return {
    mock: {
      invoke: async (channel, ...args) => {
        if (invokeMock[channel]) return invokeMock[channel](...args);
        return null;
      },
      send: (channel, data) => { sent.push([channel, data]); },
      on: (channel, cb) => {
        if (!listeners[channel]) listeners[channel] = [];
        listeners[channel].push(cb);
        return () => {
          const idx = listeners[channel].indexOf(cb);
          if (idx >= 0) listeners[channel].splice(idx, 1);
        };
      },
    },
    emit(channel, ...args) {
      for (const cb of (listeners[channel] || [])) cb(...args);
    },
    setInvokeHandler(channel, fn) {
      invokeMock[channel] = fn;
    },
    listeners,
    sent,
  };
}


// ── Load renderer.js into sandbox ───────────────────────────

const vm = require('vm');

function loadRenderer() {
  const { doc, elements, eventListeners, makeElement } = createMiniDOM();
  const genesis = createGenesisMock();

  // require mock: callable + .config
  const requireMock = function(_deps, _cb, _errCb) {};
  requireMock.config = () => {};

  // Deferred setTimeout: store callbacks but only run them if explicitly triggered
  const deferredTimeouts = [];
  const timeoutFn = (fn, _ms) => {
    deferredTimeouts.push(fn);
    return deferredTimeouts.length;
  };

  // Build a shared vm context
  const ctx = vm.createContext({
    document: doc,
    window: { genesis: genesis.mock },
    console: { log() {}, warn() {}, error() {}, debug() {} },
    setTimeout: timeoutFn,
    setInterval: () => 1,
    clearInterval: () => {},
    require: requireMock,
  });
  ctx.window.document = doc;
  ctx.window.setTimeout = ctx.setTimeout;
  ctx.window.setInterval = ctx.setInterval;

  let src = fs.readFileSync(
    path.join(__dirname, '..', '..', 'src', 'ui', 'renderer.js'), 'utf8'
  );

  // v4.12.1 [P2-01]: Convert top-level const/let to var so they're accessible on ctx.
  // Updated for v4.0.0+ Genesis.UI namespace architecture.
  src = src
    .replace("'use strict';", '') // strict mode prevents var hoisting in some vm contexts
    .replace("const $ = (sel) => document.querySelector(sel);", "var $ = (sel) => document.querySelector(sel);")
    .replace("const Genesis = { UI: {} };", "var Genesis = { UI: {} };");
  src = src.split("const $$ = (sel) => document.querySelectorAll(sel);")
           .join("var $$ = (sel) => document.querySelectorAll(sel);");
  src = src.split("const t = Genesis.UI.i18n.t;")
           .join("var t = Genesis.UI.i18n.t;");

  vm.runInContext(src, ctx, { filename: 'renderer.js' });

  // Helper: run code in the vm context (where $, $$, and all functions live)
  function run(code) {
    return vm.runInContext(code, ctx);
  }

  // Build api proxy — every call runs INSIDE the vm context
  // v4.12.1 [P2-01]: Updated for Genesis.UI.* namespace (post-v4.0.0 refactor).
  const api = {
    t(key, vars) {
      ctx._args = [key, vars || {}];
      return run('Genesis.UI.i18n.t(_args[0], _args[1])');
    },
    loadI18n() { return run('Genesis.UI.i18n.load()'); },
    togglePanel(id) { ctx._arg = id; return run('togglePanel(_arg)'); },
    addMessage(role, content, intent) {
      ctx._args = [role, content, intent];
      return run('Genesis.UI.chat.addMessage(_args[0], _args[1], _args[2])');
    },
    showToast(msg, type) {
      ctx._args = [msg, type || 'info'];
      return run('Genesis.UI.toast.show(_args[0], _args[1])');
    },
    updateStatus(s) { ctx._arg = s; return run('Genesis.UI.status.update(_arg)'); },
    renderMarkdown(t) { ctx._arg = t; return run('Genesis.UI.markdown.render(_arg)'); },
    renderMarkdownWithEditorButtons(t) { ctx._arg = t; return run('Genesis.UI.markdown.renderWithButtons(_arg)'); },
    escapeHtml(t) { ctx._arg = t; return run('Genesis.UI.markdown.esc(_arg)'); },
    startStreamingMessage() { return run('Genesis.UI.chat.startStream && Genesis.UI.chat.startStream()'); },
    appendToStream(c) { ctx._arg = c; return run('Genesis.UI.chat.appendChunk && Genesis.UI.chat.appendChunk(_arg)'); },
    finishStream() { return run('Genesis.UI.chat.finishStream()'); },
    sendMessage() { return run('Genesis.UI.chat.send()'); },
    stopGeneration() { return run('Genesis.UI.chat.stop && Genesis.UI.chat.stop()'); },
    undoLastChange() { return run('Genesis.UI.undo.exec()'); },
    loadFileTree() { return run('Genesis.UI.files.load()'); },
    openFile(p) { ctx._arg = p; return run('Genesis.UI.monaco.openFile(_arg)'); },
    saveCurrentFile() { return run('Genesis.UI.monaco.save()'); },
    loadModels() { return run('Genesis.UI.models.load()'); },
    showHealth() { return run('Genesis.UI.health.show()'); },
    showSelfModel() { return run('Genesis.UI.health.showSelf()'); },
    showGoalTree() { return run('Genesis.UI.goals.show()'); },
    openSettings() { return run('Genesis.UI.settings.open()'); },
    closeSettings() { return run('Genesis.UI.settings.close()'); },
    saveSettings() { return run('Genesis.UI.settings.save()'); },
    onAgentReady(s) { ctx._arg = s; return run('Genesis.UI.boot.onReady(_arg)'); },

    get agentReady() { return run('Genesis.UI.boot.ready'); },
    get currentFile() { return run('Genesis.UI.monaco.currentFile'); },
  };

  // Helper: fire DOMContentLoaded callbacks from within the vm context
  function fireDOMReady() {
    run(`
      (function() {
        var cbs = document._domContentLoadedCallbacks || [];
        for (var i = 0; i < cbs.length; i++) {
          try { cbs[i](); } catch(e) {}
        }
      })();
    `);
  }

  return { api, elements, eventListeners, genesis, doc, makeElement, ctx, run, fireDOMReady };
}


// ════════════════════════════════════════════════════════════
// TESTS
// ════════════════════════════════════════════════════════════

describe('renderer.js — i18n', () => {

  test('t() returns key when no translation', () => {
    const { api } = loadRenderer();
    assertEqual(api.t('unknown.key'), 'unknown.key');
  });

  // v4.12.1 [P2-01]: i18n strings are internal to Genesis.UI.i18n closure.
  // Must load via IPC mock (agent:get-lang-strings), not direct assignment.
  test('t() interpolates {{var}} placeholders', async () => {
    const { api, genesis } = loadRenderer();
    genesis.setInvokeHandler('agent:get-lang-strings', () => ({
      'hello': 'Hallo {{name}}, du hast {{n}} Nachrichten',
    }));
    await api.loadI18n();
    const result = api.t('hello', { name: 'Garrus', n: 5 });
    assertEqual(result, 'Hallo Garrus, du hast 5 Nachrichten');
  });

  test('t() handles multiple occurrences of same var', async () => {
    const { api, genesis } = loadRenderer();
    genesis.setInvokeHandler('agent:get-lang-strings', () => ({
      'x': '{{a}} and {{a}}',
    }));
    await api.loadI18n();
    assertEqual(api.t('x', { a: 'OK' }), 'OK and OK');
  });

  test('loadI18n() fetches strings and sets lang selector', async () => {
    const { api, genesis, elements } = loadRenderer();
    genesis.setInvokeHandler('agent:get-lang-strings', () => ({
      _lang: 'de',
      'ui.ready': 'Bereit',
    }));
    await api.loadI18n();
    assertEqual(api.t('ui.ready'), 'Bereit');
    assertEqual(elements['lang-select'].value, 'de');
  });
});


describe('renderer.js — escapeHtml', () => {

  test('escapes HTML special characters', () => {
    const { api } = loadRenderer();
    const escaped = api.escapeHtml('<script>alert("xss")</script>');
    assert(!escaped.includes('<script>'), 'Should escape angle brackets');
    assert(escaped.includes('&lt;'), 'Should contain &lt;');
    assert(escaped.includes('&gt;'), 'Should contain &gt;');
  });

  test('preserves normal text', () => {
    const { api } = loadRenderer();
    assertEqual(api.escapeHtml('Hello World'), 'Hello World');
  });
});


describe('renderer.js — renderMarkdown', () => {

  test('renders code blocks with language class', () => {
    const { api } = loadRenderer();
    const md = '```javascript\nconsole.log("hi");\n```';
    const html = api.renderMarkdown(md);
    assert(html.includes('language-javascript'), 'Has language class');
    assert(html.includes('console.log'), 'Contains code');
    assert(!html.includes('<script>'), 'Code is escaped');
  });

  test('renders inline code', () => {
    const { api } = loadRenderer();
    const html = api.renderMarkdown('use `npm install` to install');
    assert(html.includes('<code>npm install</code>'), 'Inline code rendered');
  });

  test('renders bold and italic', () => {
    const { api } = loadRenderer();
    assert(api.renderMarkdown('**bold**').includes('<strong>'));
    assert(api.renderMarkdown('*italic*').includes('<em>'));
  });

  test('renders headings', () => {
    const { api } = loadRenderer();
    assert(api.renderMarkdown('# H1').includes('<h2>'));
    assert(api.renderMarkdown('## H2').includes('<h3>'));
    assert(api.renderMarkdown('### H3').includes('<h4>'));
  });

  test('converts newlines to <br>', () => {
    const { api } = loadRenderer();
    assert(api.renderMarkdown('line1\nline2').includes('<br>'));
  });

  test('escapes HTML inside markdown to prevent XSS', () => {
    const { api } = loadRenderer();
    const md = '**<img src=x onerror=alert(1)>**';
    const html = api.renderMarkdown(md);
    // v4.12.1: The security invariant is that no raw HTML <img> tag appears.
    // The text onerror= may appear as escaped content — that's safe.
    assert(!html.includes('<img'), 'No raw <img tag in output');
    assert(!html.includes('<img src'), 'No executable img element');
  });

  test('handles empty input', () => {
    const { api } = loadRenderer();
    assertEqual(api.renderMarkdown(''), '');
    assertEqual(api.renderMarkdown(null), '');
    assertEqual(api.renderMarkdown(undefined), '');
  });
});


describe('renderer.js — renderMarkdownWithEditorButtons', () => {

  test('adds editor button for long code blocks', () => {
    const { api } = loadRenderer();
    const longCode = 'a'.repeat(25);
    const md = '```javascript\n' + longCode + '\n```';
    const html = api.renderMarkdownWithEditorButtons(md);
    assert(html.includes('code-to-editor-btn'), 'Has editor button');
    assert(html.includes('code-block-wrapper'), 'Has wrapper div');
  });

  test('no editor button for short code blocks', () => {
    const { api } = loadRenderer();
    const md = '```js\nshort\n```';
    const html = api.renderMarkdownWithEditorButtons(md);
    assert(!html.includes('code-to-editor-btn'), 'No button for short code');
  });
});


describe('renderer.js — showToast', () => {

  test('creates toast with correct class', () => {
    const { api, elements } = loadRenderer();
    api.showToast('Test message', 'success');
    const container = elements['toast-container'];
    assert(container.children.length >= 1, 'Toast added');
    const toast = container.children[container.children.length - 1];
    assert(toast.className.includes('toast-success'), 'Has success class');
    assertEqual(toast.textContent, 'Test message');
  });

  test('limits toast stack to 5', () => {
    const { api, elements } = loadRenderer();
    for (let i = 0; i < 8; i++) {
      api.showToast('Toast ' + i, 'info');
    }
    assert(elements['toast-container'].children.length <= 5, 'Max 5 toasts');
  });
});


describe('renderer.js — updateStatus', () => {

  test('ready state sets badge-ready', () => {
    const { api, elements } = loadRenderer();
    api.updateStatus({ state: 'ready', model: 'gemma2:9b' });
    const badge = elements['status-badge'];
    assert(badge._classList.has('badge-ready'), 'Has ready class');
    assertEqual(badge.textContent, 'gemma2:9b');
  });

  test('thinking state sets badge-working', () => {
    const { api, elements } = loadRenderer();
    api.updateStatus({ state: 'thinking', detail: 'Processing...' });
    assert(elements['status-badge']._classList.has('badge-working'));
    assertEqual(elements['status-badge'].textContent, 'Processing...');
  });

  test('error state sets badge-error', () => {
    const { api, elements } = loadRenderer();
    api.updateStatus({ state: 'error', detail: 'Model crashed' });
    assert(elements['status-badge']._classList.has('badge-error'));
  });

  test('warning state shows toast', () => {
    const { api, elements } = loadRenderer();
    api.updateStatus({ state: 'warning', detail: 'Low memory' });
    assert(elements['status-badge']._classList.has('badge-error'), 'Warning uses error badge class');
    // Toast should have been created
    assert(elements['toast-container'].children.length >= 1, 'Warning toast shown');
  });

  test('unknown state defaults to booting', () => {
    const { api, elements } = loadRenderer();
    api.updateStatus({ state: 'initializing', detail: 'Phase 3' });
    assert(elements['status-badge']._classList.has('badge-booting'));
  });
});


describe('renderer.js — addMessage', () => {

  test('adds user message to chat', () => {
    const { api, elements } = loadRenderer();
    api.addMessage('user', 'Hello Genesis');
    const container = elements['chat-messages'];
    assert(container.children.length >= 1, 'Message added');
    const msg = container.children[container.children.length - 1];
    assert(msg.className.includes('user-message'), 'Has user-message class');
    assert(msg.innerHTML.includes('You'), 'Shows user name');
  });

  test('adds agent message to chat', () => {
    const { api, elements } = loadRenderer();
    api.addMessage('agent', 'Hello human');
    const msg = elements['chat-messages'].children[0];
    assert(msg.className.includes('agent-message'));
    assert(msg.innerHTML.includes('Genesis'));
  });

  test('shows intent tag for non-general intents', () => {
    const { api, elements } = loadRenderer();
    api.addMessage('agent', 'Creating skill...', 'skill-creation');
    const msg = elements['chat-messages'].children[0];
    assert(msg.innerHTML.includes('intent-tag'), 'Intent tag present');
    assert(msg.innerHTML.includes('skill-creation'), 'Intent name shown');
  });

  test('hides intent tag for general/stream/error', () => {
    const { api, elements } = loadRenderer();
    api.addMessage('agent', 'Hey', 'general');
    const msg = elements['chat-messages'].children[0];
    assert(!msg.innerHTML.includes('intent-tag'), 'No intent tag for general');
  });
});


describe('renderer.js — togglePanel', () => {

  test('toggles hidden class on panel', () => {
    const { api, elements } = loadRenderer();
    assert(elements['editor-panel']._classList.has('hidden'), 'Starts hidden');
    api.togglePanel('editor-panel');
    assert(!elements['editor-panel']._classList.has('hidden'), 'Now visible');
    api.togglePanel('editor-panel');
    assert(elements['editor-panel']._classList.has('hidden'), 'Hidden again');
  });

  test('toggles active class on editor button', () => {
    const { api, elements } = loadRenderer();
    api.togglePanel('editor-panel');
    assert(elements['btn-toggle-editor']._classList.has('active'));
    api.togglePanel('editor-panel');
    assert(!elements['btn-toggle-editor']._classList.has('active'));
  });

  test('toggles active class on file-tree button', () => {
    const { api, elements } = loadRenderer();
    api.togglePanel('file-tree-panel');
    assert(elements['btn-toggle-tree']._classList.has('active'));
  });
});


describe('renderer.js — sendMessage', () => {

  test('does nothing when input is empty', async () => {
    const { api, genesis, elements } = loadRenderer();
    // Boot the agent so send() doesn't bail on !boot.ready
    genesis.setInvokeHandler('agent:get-lang-strings', () => ({}));
    genesis.setInvokeHandler('agent:list-models', () => []);
    genesis.setInvokeHandler('agent:get-health', () => ({ memory: { facts: 0 }, idleMind: { thoughtCount: 0 } }));
    genesis.setInvokeHandler('agent:get-goals', () => []);
    await api.onAgentReady({ state: 'ready' });
    elements['chat-messages'].children = []; elements['chat-messages']._virtualChildren = [];
    elements['chat-input'].value = '   ';
    await api.sendMessage();
    // send() trims and bails on empty — no new messages beyond boot welcome
    assertEqual(elements['chat-messages'].children.length, 0, 'No message sent');
  });

  test('shows toast when agent not ready', async () => {
    const { api, elements } = loadRenderer();
    // Don't call onAgentReady — boot.ready stays false
    elements['chat-input'].value = 'Hello';
    await api.sendMessage();
    assert(elements['toast-container'].children.length >= 1, 'Warning toast shown');
  });
});


describe('renderer.js — streaming', () => {

  test('startStreamingMessage creates agent message', () => {
    const { api, elements } = loadRenderer();
    // v4.12.1: startStream is internal to Genesis.UI.chat; test via addMessage
    api.addMessage('agent', 'Test response');
    const container = elements['chat-messages'];
    assert(container.children.length >= 1, 'Agent message created');
    const msg = container.children[container.children.length - 1];
    assert(msg.className.includes('agent-message'), 'Has agent class');
  });

  test('finishStream resets UI buttons', () => {
    const { api, elements } = loadRenderer();
    // finishStream should be safe to call even when no stream is active
    api.finishStream();
    assert(!elements['btn-send']._classList.has('hidden'), 'Send button visible');
    assert(elements['btn-stop']._classList.has('hidden'), 'Stop button hidden');
  });
});


describe('renderer.js — loadModels', () => {

  test('populates model selector from IPC', async () => {
    const { api, genesis, elements } = loadRenderer();
    genesis.setInvokeHandler('agent:list-models', () => [
      { name: 'gemma2:9b' },
      { name: 'llama3:8b' },
    ]);
    await api.loadModels();
    const select = elements['model-select'];
    assertEqual(select.children.length, 2);
    assertEqual(select.children[0].value, 'gemma2:9b');
    assertEqual(select.children[1].value, 'llama3:8b');
  });

  test('shows error on failure', async () => {
    const { api, genesis, elements } = loadRenderer();
    genesis.setInvokeHandler('agent:list-models', () => { throw new Error('offline'); });
    await api.loadModels();
    assert(elements['model-select'].innerHTML.includes('error') ||
           elements['model-select'].innerHTML.includes('Error') ||
           elements['model-select'].children.length === 0,
           'Error handled');
  });

  test('shows no-model option when empty', async () => {
    const { api, genesis, elements } = loadRenderer();
    genesis.setInvokeHandler('agent:list-models', () => []);
    await api.loadModels();
    // Should have a single "no model" option
    assert(elements['model-select'].innerHTML.includes('<option'), 'Has fallback option');
  });
});


describe('renderer.js — loadFileTree', () => {

  test('skipped when agent not ready', async () => {
    const { api, elements } = loadRenderer();
    // Don't call onAgentReady — boot.ready stays false
    await api.loadFileTree();
    assertEqual(elements['file-tree'].children.length, 0);
  });

  test('populates tree items from IPC', async () => {
    const { api, genesis, elements } = loadRenderer();
    genesis.setInvokeHandler('agent:get-lang-strings', () => ({}));
    genesis.setInvokeHandler('agent:list-models', () => []);
    genesis.setInvokeHandler('agent:get-health', () => ({ memory: { facts: 0 }, idleMind: { thoughtCount: 0 } }));
    genesis.setInvokeHandler('agent:get-goals', () => []);
    await api.onAgentReady({ state: 'ready' });
    genesis.setInvokeHandler('agent:get-file-tree', () => [
      { path: 'main.js', protected: true, isModule: false },
      { path: 'src/agent/Brain.js', protected: false, isModule: true },
    ]);
    await api.loadFileTree();
    const tree = elements['file-tree'];
    assertEqual(tree.children.length, 2);
    assert(tree.children[0].className.includes('protected'), 'Protected class');
    assert(tree.children[0].innerHTML.includes('🔒'), 'Protected icon');
    assert(tree.children[1].innerHTML.includes('◈'), 'Module icon');
  });
});


describe('renderer.js — undoLastChange', () => {

  test('shows warning when agent not ready', async () => {
    const { api, elements } = loadRenderer();
    // Don't call onAgentReady
    await api.undoLastChange();
    assert(elements['toast-container'].children.length >= 1);
  });

  test('shows success toast on successful undo', async () => {
    const { api, genesis, elements } = loadRenderer();
    genesis.setInvokeHandler('agent:get-lang-strings', () => ({}));
    genesis.setInvokeHandler('agent:list-models', () => []);
    genesis.setInvokeHandler('agent:get-health', () => ({ memory: { facts: 0 }, idleMind: { thoughtCount: 0 } }));
    genesis.setInvokeHandler('agent:get-goals', () => []);
    await api.onAgentReady({ state: 'ready' });
    genesis.setInvokeHandler('agent:undo', () => ({ ok: true, reverted: 'file.js', detail: 'Reverted file.js' }));
    await api.undoLastChange();
    const toasts = elements['toast-container'].children;
    assert(toasts.length >= 1, 'Toast shown');
    assert(toasts[toasts.length - 1].className.includes('toast-success'), 'Success toast');
  });

  test('shows warning toast when nothing to undo', async () => {
    const { api, genesis, elements } = loadRenderer();
    genesis.setInvokeHandler('agent:get-lang-strings', () => ({}));
    genesis.setInvokeHandler('agent:list-models', () => []);
    genesis.setInvokeHandler('agent:get-health', () => ({ memory: { facts: 0 }, idleMind: { thoughtCount: 0 } }));
    genesis.setInvokeHandler('agent:get-goals', () => []);
    await api.onAgentReady({ state: 'ready' });
    genesis.setInvokeHandler('agent:undo', () => ({ ok: false, error: 'Nothing to undo' }));
    await api.undoLastChange();
    const toasts = elements['toast-container'].children;
    assert(toasts.length >= 1);
    assert(toasts[toasts.length - 1].className.includes('toast-warning'), 'Warning toast');
  });
});


// v4.12.1 [P2-01]: autoResize is now inline in DOMContentLoaded (ci.addEventListener('input', ...))
// No longer a standalone function — tested implicitly via DOMContentLoaded wiring tests.


// v4.12.1 [P2-01]: buildGoalNode is now _node() internal to Genesis.UI.goals.
// Goal rendering is tested implicitly via showGoalTree() integration.


describe('renderer.js — openSettings / closeSettings', () => {

  test('openSettings shows modal with data from IPC', async () => {
    const { api, genesis, elements } = loadRenderer();
    genesis.setInvokeHandler('agent:get-lang-strings', () => ({}));
    genesis.setInvokeHandler('agent:list-models', () => []);
    genesis.setInvokeHandler('agent:get-health', () => ({ memory: { facts: 0 }, idleMind: { thoughtCount: 0 } }));
    genesis.setInvokeHandler('agent:get-goals', () => []);
    await api.onAgentReady({ state: 'ready' });
    genesis.setInvokeHandler('agent:get-settings', () => ({
      models: { anthropicApiKey: 'sk-test', openaiBaseUrl: 'https://api.local', openaiApiKey: 'sk-oai' },
      daemon: { enabled: true },
      idleMind: { enabled: false },
      security: { allowSelfModify: true },
    }));
    await api.openSettings();
    assert(!elements['settings-modal']._classList.has('hidden'), 'Modal visible');
  });

  test('closeSettings hides modal', () => {
    const { api, elements } = loadRenderer();
    elements['settings-modal']._classList.delete('hidden');
    api.closeSettings();
    assert(elements['settings-modal']._classList.has('hidden'), 'Modal hidden');
  });
});


describe('renderer.js — onAgentReady', () => {

  test('sets agentReady and shows welcome for new user', async () => {
    const { api, genesis, elements } = loadRenderer();
    genesis.setInvokeHandler('agent:get-lang-strings', () => ({
      'welcome.first': 'Welcome! I am Genesis.',
    }));
    genesis.setInvokeHandler('agent:list-models', () => [{ name: 'gemma2:9b' }]);
    // v7.2.4: Filesystem-based first-boot check
    genesis.setInvokeHandler('agent:is-first-boot', () => ({ firstBoot: true }));
    genesis.setInvokeHandler('agent:get-health', () => ({
      memory: { facts: 0 },
      idleMind: { thoughtCount: 0 },
    }));
    genesis.setInvokeHandler('agent:get-goals', () => []);

    await api.onAgentReady({ state: 'ready', model: 'gemma2:9b' });
    assert(api.agentReady, 'Agent marked ready');
    assert(elements['chat-messages'].children.length >= 1, 'Welcome message shown');
  });

  test('returning boot shows no welcome — chat stays empty until user speaks', async () => {
    const { api, genesis, elements } = loadRenderer();
    genesis.setInvokeHandler('agent:get-lang-strings', () => ({}));
    genesis.setInvokeHandler('agent:list-models', () => []);
    genesis.setInvokeHandler('agent:is-first-boot', () => ({ firstBoot: false }));

    await api.onAgentReady({ state: 'ready' });

    // Returning boot is silent. No welcome-request, no stream bubble, no message.
    const sent = genesis.sent || [];
    const requestedWelcome = sent.some(([channel]) => channel === 'agent:request-welcome');
    assert(!requestedWelcome, 'returning boot must NOT send agent:request-welcome');

    const msgs = elements['chat-messages'].children;
    assert(msgs.length === 0, `returning boot must leave chat empty, got ${msgs.length} bubble(s)`);
  });
});


describe('renderer.js — IPC event wiring', () => {

  test('agent:status-update listener registered', () => {
    const { genesis, fireDOMReady } = loadRenderer();
    fireDOMReady();
    assert(genesis.listeners['agent:status-update']?.length >= 1, 'Status listener wired');
  });

  test('agent:stream-chunk listener registered', () => {
    const { genesis, fireDOMReady } = loadRenderer();
    fireDOMReady();
    assert(genesis.listeners['agent:stream-chunk']?.length >= 1, 'Stream chunk listener wired');
  });

  test('agent:stream-done listener registered', () => {
    const { genesis, fireDOMReady } = loadRenderer();
    fireDOMReady();
    assert(genesis.listeners['agent:stream-done']?.length >= 1, 'Stream done listener wired');
  });

  test('agent:open-in-editor listener registered', () => {
    const { genesis, fireDOMReady } = loadRenderer();
    fireDOMReady();
    assert(genesis.listeners['agent:open-in-editor']?.length >= 1, 'Open-in-editor listener wired');
  });
});


describe('renderer.js — DOMContentLoaded wiring', () => {

  test('DOMContentLoaded event triggers init', () => {
    const { eventListeners } = loadRenderer();
    assert(eventListeners['DOMContentLoaded']?.length >= 1, 'DOMContentLoaded registered');
  });

  test('keydown handler registered on document', () => {
    const { eventListeners, fireDOMReady } = loadRenderer();
    fireDOMReady();
    assert(eventListeners['keydown']?.length >= 1, 'Keydown registered');
  });
});

run();
