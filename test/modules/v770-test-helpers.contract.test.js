// ============================================================
// GENESIS test/modules/v770-test-helpers.contract.test.js (v7.7.0)
//
// Pin the helper export shape so per-module UI tests break loud
// if helpers regress. Without this, a silent change to dom-shim
// or genesis-mock would propagate as confusing failures across
// 6 ui-*-module test files.
// ============================================================

'use strict';

const path = require('path');
const assert = require('assert');

const { createMiniDOM } = require(path.join(__dirname, '..', 'helpers', 'dom-shim'));
const { createGenesisMock } = require(path.join(__dirname, '..', 'helpers', 'genesis-mock'));

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`    ✅ ${name}`); passed++; }
  catch (e) { console.log(`    ❌ ${name}: ${e.message}`); failed++; }
}

// ── dom-shim contract ────────────────────────────────────────

test('createMiniDOM returns {doc, elements, eventListeners}', () => {
  const dom = createMiniDOM();
  assert.ok(dom.doc, 'doc present');
  assert.ok(dom.elements, 'elements present');
  assert.ok(dom.eventListeners, 'eventListeners present');
});

test('document.createElement returns element with classList + className sync', () => {
  const dom = createMiniDOM();
  const el = dom.doc.createElement('div');
  el.className = 'foo bar';
  assert.ok(el.classList.contains('foo'), 'classList sees foo');
  assert.ok(el.classList.contains('bar'), 'classList sees bar');
  assert.strictEqual(el.className, 'foo bar', 'className readback');
});

test('classList.add updates className', () => {
  const dom = createMiniDOM();
  const el = dom.doc.createElement('div');
  el.classList.add('a');
  el.classList.add('b');
  assert.ok(el.className.includes('a') && el.className.includes('b'));
});

test('classList.remove updates className', () => {
  const dom = createMiniDOM();
  const el = dom.doc.createElement('div');
  el.className = 'a b c';
  el.classList.remove('b');
  assert.ok(!el.classList.contains('b'));
});

test('classList.toggle without force flips', () => {
  const dom = createMiniDOM();
  const el = dom.doc.createElement('div');
  el.classList.toggle('x');
  assert.ok(el.classList.contains('x'));
  el.classList.toggle('x');
  assert.ok(!el.classList.contains('x'));
});

test('document.getElementById lazy-creates on miss', () => {
  const dom = createMiniDOM();
  const el = dom.doc.getElementById('does-not-exist');
  assert.ok(el, 'lazy-created element returned');
  // Same id returns same instance
  assert.strictEqual(dom.doc.getElementById('does-not-exist'), el);
});

test('document.querySelector("#id") works', () => {
  const dom = createMiniDOM();
  const el = dom.doc.querySelector('#status-badge');
  assert.ok(el, '#id resolves');
});

test('appendChild + children + removeChild', () => {
  const dom = createMiniDOM();
  const parent = dom.doc.createElement('div');
  const child = dom.doc.createElement('span');
  parent.appendChild(child);
  assert.strictEqual(parent.children.length, 1);
  parent.removeChild(child);
  assert.strictEqual(parent.children.length, 0);
});

test('addEventListener + dispatchEvent invokes listener', () => {
  const dom = createMiniDOM();
  const el = dom.doc.createElement('button');
  let called = 0;
  el.addEventListener('click', () => { called++; });
  el.dispatchEvent('click');
  assert.strictEqual(called, 1);
});

test('document-level addEventListener (DOMContentLoaded)', () => {
  const dom = createMiniDOM();
  let called = 0;
  dom.doc.addEventListener('DOMContentLoaded', () => { called++; });
  dom.doc.dispatchEvent('DOMContentLoaded');
  assert.strictEqual(called, 1);
});

test('setAttribute/hasAttribute/removeAttribute roundtrip', () => {
  const dom = createMiniDOM();
  const el = dom.doc.createElement('div');
  el.setAttribute('data-foo', 'bar');
  assert.ok(el.hasAttribute('data-foo'));
  assert.strictEqual(el.getAttribute('data-foo'), 'bar');
  el.removeAttribute('data-foo');
  assert.ok(!el.hasAttribute('data-foo'));
});

// ── genesis-mock contract ────────────────────────────────────

test('createGenesisMock returns {mock, calls, listeners, setHandler, trigger, reset}', () => {
  const g = createGenesisMock();
  assert.ok(g.mock);
  assert.ok(g.calls);
  assert.ok(g.listeners);
  assert.strictEqual(typeof g.setHandler, 'function');
  assert.strictEqual(typeof g.trigger, 'function');
  assert.strictEqual(typeof g.reset, 'function');
});

test('genesis.invoke records calls and resolves handler result', async () => {
  const g = createGenesisMock();
  g.setHandler('test:channel', (a, b) => a + b);
  const r = await g.mock.invoke('test:channel', 2, 3);
  assert.strictEqual(r, 5);
  assert.strictEqual(g.calls.invoke.length, 1);
  assert.strictEqual(g.calls.invoke[0].channel, 'test:channel');
});

test('genesis.send records fire-and-forget', () => {
  const g = createGenesisMock();
  g.mock.send('agent:request-stream', 'hello');
  assert.strictEqual(g.calls.send.length, 1);
  assert.deepStrictEqual(g.calls.send[0], { channel: 'agent:request-stream', args: ['hello'] });
});

test('genesis.on + trigger invokes listener', () => {
  const g = createGenesisMock();
  let payload = null;
  g.mock.on('agent:status-update', (p) => { payload = p; });
  g.trigger('agent:status-update', { state: 'ready' });
  assert.deepStrictEqual(payload, { state: 'ready' });
});

test('reset() clears calls/listeners/handlers', () => {
  const g = createGenesisMock();
  g.setHandler('ch', () => 1);
  g.mock.send('s', 'x');
  g.mock.on('ev', () => {});
  g.reset();
  assert.strictEqual(g.calls.send.length, 0);
  assert.strictEqual(Object.keys(g.listeners).length, 0);
});

console.log(`\n    ${passed} passed · ${failed} failed · v7.7.0 test helpers contract`);
process.exit(failed > 0 ? 1 : 0);
