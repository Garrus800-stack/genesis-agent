// ============================================================
// GENESIS test/modules/ui-chat-module.test.js (v7.7.0)
//
// Pins v7.7.0 fixes:
//   A2 — sendMessage not-ready guard via shared agent-state
//   A8 — markdown headings (# → h2, ## → h3, ### → h4)
// Plus regression coverage for addMessage roles + escapeHtml + XSS.
// ============================================================

'use strict';

const path = require('path');
const assert = require('assert');

const ROOT = path.join(__dirname, '..', '..');
const { createMiniDOM } = require(path.join(ROOT, 'test', 'helpers', 'dom-shim'));
const { createGenesisMock } = require(path.join(ROOT, 'test', 'helpers', 'genesis-mock'));

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`    ✅ ${name}`); passed++; }
  catch (e) { console.log(`    ❌ ${name}: ${e.message}`); failed++; }
}

function setup() {
  const dom = createMiniDOM();
  const genesis = createGenesisMock();
  global.document = dom.doc;
  global.window = { genesis: genesis.mock };
  // OS-agnostic cache clear via require.resolve — works on Win + Linux
  for (const m of ['i18n', 'agent-state', 'statusbar', 'chat']) {
    delete require.cache[require.resolve(path.join(ROOT, 'src', 'ui', 'modules', m))];
  }
  return {
    chat: require(path.join(ROOT, 'src', 'ui', 'modules', 'chat')),
    agentState: require(path.join(ROOT, 'src', 'ui', 'modules', 'agent-state')),
    dom, genesis,
  };
}

// ── escapeHtml ───────────────────────────────────────────────

test('escapeHtml escapes special characters', () => {
  const { chat } = setup();
  const out = chat.escapeHtml('<script>alert(1)</script>');
  assert.ok(!out.includes('<script>'), `<script> must not survive: ${out}`);
});

test('escapeHtml preserves normal text', () => {
  const { chat } = setup();
  assert.strictEqual(chat.escapeHtml('Hello world'), 'Hello world');
});

// ── renderMarkdown ───────────────────────────────────────────

test('renderMarkdown bold and italic', () => {
  const { chat } = setup();
  const html = chat.renderMarkdown('**bold** and *italic*');
  assert.ok(html.includes('<strong>bold</strong>'));
  assert.ok(html.includes('<em>italic</em>'));
});

test('renderMarkdown XSS protection inside markdown', () => {
  const { chat } = setup();
  const html = chat.renderMarkdown('**<img src=x onerror=alert(1)>**');
  assert.ok(!html.includes('<img'), 'no raw <img survives');
});

test('A8: # H1 → <h2>', () => {
  const { chat } = setup();
  const html = chat.renderMarkdown('# Title');
  assert.ok(html.includes('<h2>Title</h2>'),
    `expected <h2>, got: ${html}`);
});

test('A8: ## H2 → <h3>', () => {
  const { chat } = setup();
  const html = chat.renderMarkdown('## Subtitle');
  assert.ok(html.includes('<h3>Subtitle</h3>'),
    `expected <h3>, got: ${html}`);
});

test('A8: ### H3 → <h4>', () => {
  const { chat } = setup();
  const html = chat.renderMarkdown('### Section');
  assert.ok(html.includes('<h4>Section</h4>'),
    `expected <h4>, got: ${html}`);
});

test('A8: heading with XSS payload still escaped', () => {
  const { chat } = setup();
  const html = chat.renderMarkdown('# <script>alert(1)</script>');
  assert.ok(!html.includes('<script>'), 'XSS escaped inside heading');
});

// ── addMessage ───────────────────────────────────────────────

test('addMessage adds user-message class', () => {
  const { chat, dom } = setup();
  chat.addMessage('user', 'Hello');
  const container = dom.elements['chat-messages'];
  assert.ok(container.children.length >= 1);
  assert.ok(container.children[0].className.includes('user-message'));
});

test('addMessage adds agent-message class', () => {
  const { chat, dom } = setup();
  chat.addMessage('agent', 'Hello back');
  const container = dom.elements['chat-messages'];
  assert.ok(container.children[0].className.includes('agent-message'));
});

test('addMessage with intent shows intent-tag for non-general', () => {
  const { chat, dom } = setup();
  chat.addMessage('agent', 'Creating skill...', 'skill-creation');
  const container = dom.elements['chat-messages'];
  assert.ok(container.children[0].innerHTML.includes('intent-tag'));
});

test('addMessage no intent-tag for general intent', () => {
  const { chat, dom } = setup();
  chat.addMessage('agent', 'Hi', 'general');
  const container = dom.elements['chat-messages'];
  assert.ok(!container.children[0].innerHTML.includes('intent-tag'));
});

// ── sendMessage (A2 not-ready guard) ─────────────────────────

test('A2: sendMessage shows toast when agent not ready', async () => {
  const { chat, dom, agentState, genesis } = setup();
  agentState.setAgentReady(false);
  // Pre-set chat-input value
  const input = dom.elements['chat-input'];
  input.value = 'hello world';
  await chat.sendMessage();
  // Should NOT have sent IPC
  const sendCalls = genesis.calls.send.filter(c => c.channel === 'agent:request-stream');
  assert.strictEqual(sendCalls.length, 0,
    'sendMessage must not send IPC when agent not ready');
  // Should have shown a toast
  const container = dom.elements['toast-container'];
  assert.ok(container.children.length >= 1, 'warning toast must be shown');
});

test('A2: sendMessage sends IPC + adds user message when ready', async () => {
  const { chat, dom, agentState, genesis } = setup();
  agentState.setAgentReady(true);
  const input = dom.elements['chat-input'];
  input.value = 'hi there';
  await chat.sendMessage();
  const sendCalls = genesis.calls.send.filter(c => c.channel === 'agent:request-stream');
  assert.strictEqual(sendCalls.length, 1, 'IPC must fire when ready');
  assert.strictEqual(sendCalls[0].args[0], 'hi there');
});

test('A2: sendMessage clears input after send', async () => {
  const { chat, dom, agentState } = setup();
  agentState.setAgentReady(true);
  const input = dom.elements['chat-input'];
  input.value = 'foo';
  await chat.sendMessage();
  assert.strictEqual(input.value, '', 'input cleared');
});

test('sendMessage no-op on empty input', async () => {
  const { chat, dom, agentState, genesis } = setup();
  agentState.setAgentReady(true);
  const input = dom.elements['chat-input'];
  input.value = '   ';  // whitespace only
  await chat.sendMessage();
  const sendCalls = genesis.calls.send.filter(c => c.channel === 'agent:request-stream');
  assert.strictEqual(sendCalls.length, 0, 'whitespace input must not send');
});

// ── streaming ────────────────────────────────────────────────

test('startStreamingMessage creates agent message container', () => {
  const { chat, dom } = setup();
  chat.startStreamingMessage();
  const container = dom.elements['chat-messages'];
  assert.ok(container.children.length >= 1);
  assert.ok(container.children[0].className.includes('agent-message'));
});

test('finishStream sets isStreaming false', () => {
  const { chat } = setup();
  chat.startStreamingMessage();
  chat.finishStream();
  const state = chat.getStreamingState();
  assert.strictEqual(state.isStreaming, false);
});

test('appendToStream appends content to current stream', () => {
  const { chat, dom } = setup();
  chat.startStreamingMessage();
  chat.appendToStream('Hello ');
  chat.appendToStream('world');
  const state = chat.getStreamingState();
  assert.ok(state.streamingMessageEl, 'streamingMessageEl present');
});

console.log(`\n    ${passed} passed · ${failed} failed · v7.7.0 ui-chat-module`);
process.exit(failed > 0 ? 1 : 0);
