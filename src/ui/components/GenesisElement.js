// ============================================================
// GENESIS UI — components/GenesisElement.js (v4.10.0)
//
// Base class for all Genesis UI components. A lightweight
// reactive component system inspired by Lit, built specifically
// for Genesis's constraints:
//
//   - ZERO external dependencies (no lit, no preact, no bundler)
//   - CSP-compatible (no eval, no unsafe-inline for scripts)
//   - Works with Electron's contextIsolation + sandbox:true
//   - Shadow DOM for style encapsulation
//   - Reactive properties with automatic re-rendering
//   - Template literal HTML (tagged template for XSS safety)
//   - Event delegation
//   - i18n integration via Genesis.UI.i18n.t()
//
// ARCHITECTURE:
//   GenesisElement extends HTMLElement (Web Component standard).
//   Each component declares reactive properties via static `properties`.
//   When a property changes, render() is called (batched via microtask).
//   Templates use tagged template literals for safe HTML construction.
//
// Usage:
//   class MyComponent extends GenesisElement {
//     static properties = { count: { type: Number, default: 0 } };
//     render() {
//       return html`<button @click=${() => this.count++}>
//         Clicked ${this.count} times
//       </button>`;
//     }
//   }
//   customElements.define('my-component', MyComponent);
//
// NOTE: This is NOT Lit. It's a purpose-built ~200 LOC reactive
// base that covers Genesis's needs without external dependencies.
// ============================================================

'use strict';

// ── Safe HTML Tagged Template ────────────────────────────────
// Escapes interpolated values to prevent XSS. Raw HTML can be
// injected via unsafeHTML() for trusted content only.

const _ESCAPE_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

function _escapeHtml(str) {
  if (str === null || str === undefined) return '';
  if (typeof str !== 'string') return String(str);
  return str.replace(/[&<>"']/g, c => _ESCAPE_MAP[c]);
}

class _UnsafeHTML {
  constructor(value) { this.value = value; }
  toString() { return this.value; }
}

/** Mark a string as trusted HTML (no escaping). Use sparingly. */
function unsafeHTML(value) {
  return new _UnsafeHTML(value);
}

/**
 * Tagged template for safe HTML construction.
 * All interpolated values are escaped unless wrapped in unsafeHTML().
 * Event handlers (@click, @input, etc.) are collected for delegation.
 */
function html(strings, ...values) {
  const handlers = [];
  let result = '';

  for (let i = 0; i < strings.length; i++) {
    result += strings[i];
    if (i < values.length) {
      const val = values[i];
      if (typeof val === 'function') {
        // Event handler — generate a unique marker
        const id = `__ge_${handlers.length}`;
        handlers.push({ id, fn: val });
        result += id;
      } else if (val instanceof _UnsafeHTML) {
        result += val.value;
      } else if (Array.isArray(val)) {
        // Array of template results — join without escaping
        result += val.map(v => v instanceof _UnsafeHTML ? v.value : _escapeHtml(v)).join('');
      } else {
        result += _escapeHtml(val);
      }
    }
  }

  return { __html: result, __handlers: handlers };
}

// ── Base Element ─────────────────────────────────────────────

class GenesisElement extends HTMLElement {
  /**
   * Declare reactive properties. Override in subclass:
   *   static properties = { name: { type: String, default: '' } };
   */
  static properties = {};

  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
    this._renderPending = false;
    this._mounted = false;
    this._eventCleanup = [];

    // Initialize reactive properties
    this._initProperties();
  }

  _initProperties() {
    const props = this.constructor.properties;
    for (const [name, config] of Object.entries(props)) {
      const privateName = `_prop_${name}`;
      this[privateName] = config.default !== undefined ? config.default : null;

      Object.defineProperty(this, name, {
        get: () => this[privateName],
        set: (val) => {
          const old = this[privateName];
          if (old === val) return;
          this[privateName] = val;
          this.requestRender();
        },
        configurable: true,
      });
    }
  }

  connectedCallback() {
    this._mounted = true;
    this._performRender();
    this.onMount();
  }

  disconnectedCallback() {
    this._mounted = false;
    this._cleanupEvents();
    this.onUnmount();
  }

  /** Override for mount lifecycle */
  onMount() {}

  /** Override for unmount lifecycle */
  onUnmount() {}

  /** Override to return html`...` template */
  render() {
    return html`<slot></slot>`;
  }

  /** Override to return CSS string */
  styles() {
    return '';
  }

  /** Schedule a render on the next microtask */
  requestRender() {
    if (this._renderPending) return;
    this._renderPending = true;
    queueMicrotask(() => {
      this._renderPending = false;
      if (this._mounted) this._performRender();
    });
  }

  _performRender() {
    this._cleanupEvents();

    const template = this.render();
    const css = this.styles();

    let htmlStr = '';
    let handlers = [];

    if (template && template.__html) {
      htmlStr = template.__html;
      handlers = template.__handlers || [];
    } else if (typeof template === 'string') {
      htmlStr = template;
    }

    // Build shadow DOM content
    this.shadowRoot.innerHTML = (css ? `<style>${css}</style>` : '') + htmlStr;

    // Wire event handlers via delegation
    for (const { id, fn } of handlers) {
      // Find elements containing the handler marker
      const walker = document.createTreeWalker(
        this.shadowRoot,
        NodeFilter.SHOW_ELEMENT,
        null,
      );

      let node;
      while ((node = walker.nextNode())) {
        for (const attr of [...node.attributes]) {
          if (attr.value === id) {
            // Extract event name from attribute (e.g. @click → click)
            const eventName = attr.name.replace(/^@/, '');
            node.removeAttribute(attr.name);
            node.addEventListener(eventName, fn);
            this._eventCleanup.push(() => node.removeEventListener(eventName, fn));
          }
        }
      }
    }
  }

  _cleanupEvents() {
    for (const cleanup of this._eventCleanup) cleanup();
    this._eventCleanup = [];
  }

  /** Helper: Access i18n translation */
  t(key, vars) {
    try { return window.Genesis?.UI?.i18n?.t(key, vars) || key; }
    catch { return key; }
  }

  /** Helper: Emit a custom event */
  emit(name, detail = {}) {
    this.dispatchEvent(new CustomEvent(name, { detail, bubbles: true, composed: true }));
  }

  /** Helper: Query inside shadow DOM */
  $(sel) { return this.shadowRoot.querySelector(sel); }
  $$(sel) { return this.shadowRoot.querySelectorAll(sel); }
}

// ── Exports ─────────────────────────────────────────────────
// These are attached to window for use in non-module scripts
// (Electron renderer without bundler).

window.GenesisElement = GenesisElement;
window.html = html;
window.unsafeHTML = unsafeHTML;
