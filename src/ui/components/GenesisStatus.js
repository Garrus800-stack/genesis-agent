// ============================================================
// GENESIS UI — components/GenesisStatus.js (v4.10.0)
//
// Reactive status badge. Reflects agent state: booting, ready,
// working, error. Pulses when active.
//
// USAGE:
//   <genesis-status></genesis-status>
//   document.querySelector('genesis-status').state = 'ready';
// ============================================================

'use strict';

class GenesisStatus extends GenesisElement {
  static properties = {
    state: { type: String, default: 'booting' },
    detail: { type: String, default: '' },
    model: { type: String, default: '' },
  };

  styles() {
    return `
      :host { display: inline-block; }

      .badge {
        font-size: 10px; padding: 2px 8px; border-radius: 10px;
        font-weight: 600; text-transform: uppercase; letter-spacing: 0.5px;
        font-family: var(--font-sans, sans-serif);
        transition: all 0.3s ease;
      }
      .badge-booting { background: var(--warning, #fbbf24); color: #000; }
      .badge-ready { background: var(--success, #4ade80); color: #000; }
      .badge-working { background: var(--accent, #6c8cff); color: #fff; animation: pulse 1.5s infinite; }
      .badge-error { background: var(--error, #f87171); color: #fff; }
      .badge-warning { background: var(--warning, #fbbf24); color: #000; }

      @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.6; } }
    `;
  }

  render() {
    const cls = this._getBadgeClass();
    const text = this._getDisplayText();
    return html`<span class="badge ${cls}">${text}</span>`;
  }

  _getBadgeClass() {
    const s = this.state;
    if (s === 'ready') return 'badge-ready';
    if (['thinking', 'self-modifying', 'self-repairing', 'creating-skill', 'cloning'].includes(s)) return 'badge-working';
    if (s === 'error') return 'badge-error';
    if (s === 'warning') return 'badge-warning';
    return 'badge-booting';
  }

  _getDisplayText() {
    if (this.state === 'ready') return this.model || this.t('ui.ready');
    if (this.state === 'error' || this.state === 'warning') return this.detail || this.state;
    if (this.detail) return this.detail;
    return this.t('ui.starting');
  }

  /** Convenience: update from a status event object */
  update(status) {
    if (status.state) this.state = status.state;
    if (status.detail !== undefined) this.detail = status.detail || '';
    if (status.model !== undefined) this.model = status.model || '';
  }
}

customElements.define('genesis-status', GenesisStatus);
