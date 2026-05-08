// ============================================================
// GENESIS test/helpers/dom-shim.js (v7.7.0)
//
// Minimal browser DOM shim for testing UI modules under Node.
// Replaces the inline 250-LOC shim that lived inside
// renderer.test.js (deleted in v7.7.0).
//
// What modules need (from src/ui/modules/*):
//   - document.createElement(tag)
//   - document.querySelector('#id') / .querySelectorAll(sel)
//   - document.getElementById(id)
//   - element.textContent / .innerHTML / .className
//   - element.classList (add/remove/contains/toggle)
//   - element.addEventListener / dispatchEvent
//   - element.appendChild / .removeChild / .firstChild / .children
//   - element.setAttribute / .removeAttribute / .hasAttribute
//   - select.options (array)
//
// The shim is intentionally minimal — just enough for the modules
// to exercise their behavior.
// ============================================================

'use strict';

function _makeClassList(initial) {
  const set = new Set((initial || '').split(/\s+/).filter(Boolean));
  return {
    _set: set,
    add(...names) { for (const n of names) set.add(n); },
    remove(...names) { for (const n of names) set.delete(n); },
    contains(name) { return set.has(name); },
    toggle(name, force) {
      if (force === true) { set.add(name); return true; }
      if (force === false) { set.delete(name); return false; }
      if (set.has(name)) { set.delete(name); return false; }
      set.add(name); return true;
    },
    toString() { return Array.from(set).join(' '); },
  };
}

function _makeElement(tag, doc) {
  const children = [];
  const listeners = {};
  const attrs = {};
  let _classList = _makeClassList('');
  let _innerHTML = '';
  let _textContent = '';
  // Browser-parity HTML entity escape for textContent → innerHTML.
  // Real DOM: setting textContent='<' produces innerHTML='&lt;'.
  // Modules like chat.escapeHtml() rely on this to sanitize input.
  const HTML_ENTITIES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  const _escapeForInner = s => String(s).replace(/[&<>"']/g, c => HTML_ENTITIES[c]);
  const el = {
    tagName: String(tag).toUpperCase(),
    nodeType: 1,
    children,
    _attrs: attrs,
    _listeners: listeners,
    _doc: doc,
    get classList() { return _classList; },
    get className() { return _classList.toString(); },
    set className(v) {
      // Important: keep classList in sync with className assignment.
      // Real DOM does this automatically; the shim must mirror it,
      // otherwise `el.className = 'badge badge-ready'` would leave
      // `el.classList.contains('badge-ready')` returning false.
      _classList = _makeClassList(v || '');
    },
    get textContent() { return _textContent; },
    set textContent(v) {
      _textContent = String(v == null ? '' : v);
      // textContent assignment also derives innerHTML (escaped) — this
      // is browser-parity behavior that escapeHtml() in chat.js relies on:
      //   const d = doc.createElement('div'); d.textContent = '<'; return d.innerHTML;
      // → must produce '&lt;'.
      _innerHTML = _escapeForInner(_textContent);
      children.length = 0;
    },
    get innerHTML() { return _innerHTML; },
    set innerHTML(v) {
      _innerHTML = String(v == null ? '' : v);
      // Direct innerHTML set doesn't update textContent (real DOM would
      // parse and recompute, but tests usually only check the raw HTML).
      if (v === '') { children.length = 0; _textContent = ''; }
    },
    appendChild(child) {
      children.push(child);
      child._parent = el;
      return child;
    },
    removeChild(child) {
      const i = children.indexOf(child);
      if (i !== -1) { children.splice(i, 1); child._parent = null; }
      return child;
    },
    get firstChild() { return children[0] || null; },
    get lastChild() { return children[children.length - 1] || null; },
    addEventListener(ev, fn) {
      (listeners[ev] = listeners[ev] || []).push(fn);
    },
    removeEventListener(ev, fn) {
      const arr = listeners[ev];
      if (!arr) return;
      const i = arr.indexOf(fn);
      if (i !== -1) arr.splice(i, 1);
    },
    dispatchEvent(eventOrName) {
      const name = typeof eventOrName === 'string' ? eventOrName : eventOrName.type;
      const arr = listeners[name] || [];
      for (const fn of arr) fn(typeof eventOrName === 'string' ? { type: name } : eventOrName);
    },
    setAttribute(k, v) { attrs[k] = String(v); },
    removeAttribute(k) { delete attrs[k]; },
    hasAttribute(k) { return Object.prototype.hasOwnProperty.call(attrs, k); },
    getAttribute(k) { return attrs[k] != null ? attrs[k] : null; },
    // <select>.options[] behavior
    options: [],
    // .style is touched by some modules — give it an empty stand-in
    style: {},
    // .focus()/.blur() no-ops
    focus() {}, blur() {},
    // .closest() — minimal: walks _parent
    closest(sel) {
      let cur = el;
      while (cur) {
        if (cur._matchesSelector && cur._matchesSelector(sel)) return cur;
        cur = cur._parent;
      }
      return null;
    },
    // .querySelector / .querySelectorAll inside element — defer to doc-level
    querySelector(sel) { return doc ? doc.querySelector(sel, el) : null; },
    querySelectorAll(sel) { return doc ? doc.querySelectorAll(sel, el) : []; },
    // .remove() removes self from parent
    remove() {
      if (el._parent) el._parent.removeChild(el);
    },
  };
  // Set the initial classList getter to track className-set consistency
  el._classList = _classList;
  return el;
}

function createMiniDOM() {
  const elements = {};   // id → element (for #id queries)
  const eventListeners = {};
  const doc = {
    elements,
    eventListeners,
    createElement(tag) {
      return _makeElement(tag, doc);
    },
    getElementById(id) {
      // Lazy create on first access — many UI modules query an id
      // that may not have been pre-registered. Real DOM returns null
      // on miss, but for shim convenience we lazy-create. Tests can
      // pre-populate `dom.elements[id]` if they need a specific shape.
      if (!elements[id]) {
        elements[id] = _makeElement('div', doc);
        elements[id].id = id;
      }
      return elements[id];
    },
    querySelector(sel /*, root */) {
      if (typeof sel === 'string' && sel.startsWith('#')) {
        return doc.getElementById(sel.slice(1));
      }
      // for class/tag selectors, return null (tests can stub if needed)
      return null;
    },
    querySelectorAll() { return []; },
    addEventListener(ev, fn) {
      (eventListeners[ev] = eventListeners[ev] || []).push(fn);
    },
    removeEventListener(ev, fn) {
      const arr = eventListeners[ev];
      if (!arr) return;
      const i = arr.indexOf(fn);
      if (i !== -1) arr.splice(i, 1);
    },
    dispatchEvent(eventOrName) {
      const name = typeof eventOrName === 'string' ? eventOrName : eventOrName.type;
      const arr = eventListeners[name] || [];
      for (const fn of arr) fn(typeof eventOrName === 'string' ? { type: name } : eventOrName);
    },
    body: null,
    head: null,
    documentElement: null,
  };
  // Pre-create body + documentElement so modules referencing them don't crash
  doc.body = _makeElement('body', doc);
  doc.documentElement = _makeElement('html', doc);
  return { doc, elements, eventListeners };
}

module.exports = { createMiniDOM };
