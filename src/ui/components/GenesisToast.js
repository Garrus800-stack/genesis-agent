// ============================================================
// GENESIS UI — components/GenesisToast.js (v4.10.0)
//
// Toast notification Web Component. Auto-dismiss, stacking,
// max 5 visible, smooth animations.
//
// USAGE:
//   <genesis-toast></genesis-toast>
//   document.querySelector('genesis-toast').show('Saved!', 'success');
// ============================================================

'use strict';

class GenesisToast extends GenesisElement {
  constructor() {
    super();
    this._toasts = []; // { id, message, type, exiting }
    this._nextId = 0;
  }

  styles() {
    return `
      :host {
        position: fixed; bottom: 80px; right: 20px; z-index: 9999;
        display: flex; flex-direction: column-reverse; gap: 8px;
        pointer-events: none;
      }

      .toast {
        padding: 8px 16px; border-radius: 8px; font-size: 12px;
        pointer-events: auto; animation: slideIn 0.25s ease;
        max-width: 320px; word-wrap: break-word;
        font-family: var(--font-sans, sans-serif);
        transition: opacity 0.2s, transform 0.2s;
      }
      .toast.exiting { opacity: 0; transform: translateX(30px); }
      .toast-info { background: var(--bg-elevated, #161822); color: var(--text-primary, #e0e0e8); border: 1px solid var(--border, #252839); }
      .toast-error { background: var(--error, #f87171); color: #fff; }
      .toast-success { background: var(--success, #4ade80); color: #000; }
      .toast-warning { background: var(--warning, #fbbf24); color: #000; }

      @keyframes slideIn { from { opacity: 0; transform: translateX(30px); } to { opacity: 1; transform: translateX(0); } }
    `;
  }

  render() {
    const toastHtml = this._toasts.map(t =>
      `<div class="toast toast-${t.type}${t.exiting ? ' exiting' : ''}" data-id="${t.id}">${this._esc(t.message)}</div>`
    ).join('');

    return { __html: toastHtml, __handlers: [] };
  }

  _esc(text) {
    const d = document.createElement('div');
    d.textContent = text;
    return d.innerHTML;
  }

  show(message, type = 'info') {
    const id = this._nextId++;
    this._toasts.push({ id, message, type, exiting: false });

    // Cap at 5 visible
    while (this._toasts.length > 5) this._toasts.shift();

    this.requestRender();

    // Auto-dismiss after 3s
    setTimeout(() => this._dismiss(id), 3000);
  }

  _dismiss(id) {
    const toast = this._toasts.find(t => t.id === id);
    if (!toast) return;
    toast.exiting = true;
    this.requestRender();

    // Remove after exit animation
    setTimeout(() => {
      this._toasts = this._toasts.filter(t => t.id !== id);
      this.requestRender();
    }, 200);
  }
}

customElements.define('genesis-toast', GenesisToast);
