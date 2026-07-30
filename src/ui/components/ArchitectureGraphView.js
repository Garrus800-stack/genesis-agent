// ============================================================
// GENESIS — ui/components/ArchitectureGraphView.js (v7.9.50)
//
// The viewport half of the architecture graph: transform, wheel zoom, pan,
// fit-to-view and the zoom toolbar. Split out because the file stood at
// exactly 700 lines with the size guard allowing 700 and failing above it —
// the same wall IntentPatterns hit before v7.9.47, where the next entry could
// not be added at all.
//
// Mixed onto ArchitectureGraph.prototype. `this` is the graph throughout.
// The block was checked for free identifiers before it was cut: it needs
// nothing from the module head.
//
// Loaded as a <script> tag like every other UI file, so it publishes a global
// rather than a module export — require() does not exist in the renderer.
// index.html loads it BEFORE ArchitectureGraph.js, which mixes it in.
// ============================================================

'use strict';

// The three static getters the viewport methods read. They live on the class,
// which is a global in the renderer and a require in Node — so the block asks
// `this.constructor` instead, which is the graph either way. Found by
// audit-free-identifiers before it could fail anywhere.
var architectureGraphView = {
  _applyTransform() {
    if (!this._zoomWrap) return;
    this._zoomWrap.setAttribute(
      'transform',
      `translate(${this._panX}, ${this._panY}) scale(${this._zoom})`
    );
  },

  /**
   * Wheel handler — zoom toward the cursor. preventDefault keeps the
   * outer dashboard from scrolling AND blocks the Electron window-level
   * Ctrl+wheel zoom that would otherwise interfere with pinch gestures.
   */
  _onWheel(e) {
    e.preventDefault();
    const svgRect = this._svg.getBoundingClientRect();
    // Cursor coords in SVG-viewBox space (the coordinate space the wrap
    // transform operates in). The viewBox is `0 0 width height`, mapped
    // to svgRect.width × svgRect.height, so scale factor matches.
    const mx = ((e.clientX - svgRect.left) / svgRect.width)  * this._width;
    const my = ((e.clientY - svgRect.top)  / svgRect.height) * this._height;

    // Smooth zoom factor; deltaY > 0 means scroll-down → zoom out.
    // 0.001 is a comfortable per-tick step on standard mouse wheels and
    // touchpad pinch deltas.
    const factor = Math.exp(-e.deltaY * 0.001);
    const newZoom = Math.max(
      this.constructor.ZOOM_MIN,
      Math.min(this.constructor.ZOOM_MAX, this._zoom * factor)
    );
    if (newZoom === this._zoom) return;

    // Zoom-to-cursor: keep the point currently under the mouse fixed
    // in screen space. The transform is `translate(pan) scale(zoom)`,
    // so a point P_screen relates to P_data as
    //   P_screen = P_data * zoom + pan.
    // Holding (mx, my) fixed across the zoom change yields:
    //   newPan = (mx, my) - ((mx, my) - oldPan) * (newZoom / oldZoom)
    const ratio = newZoom / this._zoom;
    this._panX = mx - (mx - this._panX) * ratio;
    this._panY = my - (my - this._panY) * ratio;
    this._zoom = newZoom;
    this._applyTransform();
  },

  /**
   * Mousedown on empty space (not a node) starts a pan. Mousedowns on
   * nodes are absorbed by their own listeners (stopPropagation isn't
   * needed because we discriminate via event.target.closest).
   */
  _maybeStartPan(e) {
    if (e.button !== 0) return;           // left button only
    // Target inside a node-<g>? Let node-drag handle it.
    const targetEl = /** @type {Element} */ (e.target);
    if (targetEl && typeof targetEl.closest === 'function') {
      if (targetEl.closest('g.arch-nodes g[data-node-id]')) return;
    }
    e.preventDefault();
    this._panning = { startX: e.clientX, startY: e.clientY, origPanX: this._panX, origPanY: this._panY };
    if (this._svg) this._svg.style.cursor = 'grabbing';
  },

  /**
   * Double-click on empty space → reset to fit. On a node, leave the
   * existing single-click select-handler in charge (dblclick on a node
   * is rare; not a click-conflict in practice).
   */
  _maybeResetFit(e) {
    const targetEl = /** @type {Element} */ (e.target);
    if (targetEl && typeof targetEl.closest === 'function') {
      if (targetEl.closest('g.arch-nodes g[data-node-id]')) return;
    }
    this._resetToFit();
  },

  /**
   * Compute zoom+pan such that the bounding box of all node positions
   * fits inside the viewport with FIT_MARGIN padding. Called once after
   * initial render and from the reset toolbar button / double-click.
   */
  _resetToFit() {
    if (!this._zoomWrap || this._nodePositions.size === 0) return;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const pos of this._nodePositions.values()) {
      if (pos.x < minX) minX = pos.x;
      if (pos.y < minY) minY = pos.y;
      if (pos.x > maxX) maxX = pos.x;
      if (pos.y > maxY) maxY = pos.y;
    }
    if (!isFinite(minX)) {
      // Degenerate — no positions yet. Reset to identity.
      this._zoom = 1.0; this._panX = 0; this._panY = 0;
      this._applyTransform();
      return;
    }
    const m = this.constructor.FIT_MARGIN;
    const bboxW = Math.max(1, maxX - minX);
    const bboxH = Math.max(1, maxY - minY);
    const availW = Math.max(1, this._width  - 2 * m);
    const availH = Math.max(1, this._height - 2 * m);
    const fitZoom = Math.min(availW / bboxW, availH / bboxH, this.constructor.ZOOM_MAX);
    const clampedZoom = Math.max(this.constructor.ZOOM_MIN, fitZoom);
    // Center the bbox in the viewport.
    const cx = (minX + maxX) / 2;
    const cy = (minY + maxY) / 2;
    this._zoom = clampedZoom;
    this._panX = this._width  / 2 - cx * clampedZoom;
    this._panY = this._height / 2 - cy * clampedZoom;
    this._applyTransform();
  },

  /**
   * Zoom in/out by a fixed step. Used by the toolbar buttons. Zooms
   * around the viewport center, since there's no cursor reference.
   */
  _zoomStep(factor) {
    const newZoom = Math.max(
      this.constructor.ZOOM_MIN,
      Math.min(this.constructor.ZOOM_MAX, this._zoom * factor)
    );
    if (newZoom === this._zoom) return;
    const cx = this._width / 2;
    const cy = this._height / 2;
    const ratio = newZoom / this._zoom;
    this._panX = cx - (cx - this._panX) * ratio;
    this._panY = cy - (cy - this._panY) * ratio;
    this._zoom = newZoom;
    this._applyTransform();
  },

  /**
   * Inject a small absolute-positioned toolbar with + / − / ⊙ buttons.
   * The container is set to position:relative in the dashboard CSS so
   * this stays anchored to the graph card.
   */
  _addZoomToolbar() {
    if (!this._container) return;
    // Defensive: don't double-inject on re-render.
    let bar = this._container.querySelector('.arch-zoom-toolbar');
    if (bar) bar.remove();
    bar = document.createElement('div');
    bar.setAttribute('class', 'arch-zoom-toolbar');
    bar.style.cssText = [
      'position:absolute',
      'top:8px',
      'right:8px',
      'display:flex',
      'gap:4px',
      'background:rgba(0,0,0,0.35)',
      'border:1px solid var(--color-border,#333)',
      'border-radius:6px',
      'padding:2px',
      'z-index:50',
    ].join(';');

    const mkBtn = (label, title, onClick) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = label;
      b.title = title;
      b.style.cssText = [
        'width:24px', 'height:24px', 'border:none', 'border-radius:4px',
        'background:transparent', 'color:var(--color-text,#eee)', 'cursor:pointer',
        'font-size:14px', 'line-height:1', 'padding:0',
      ].join(';');
      b.addEventListener('mouseenter', () => { b.style.background = 'rgba(255,255,255,0.08)'; });
      b.addEventListener('mouseleave', () => { b.style.background = 'transparent'; });
      b.addEventListener('click', (e) => { e.stopPropagation(); onClick(); });
      return b;
    };

    bar.appendChild(mkBtn('+', 'Zoom in',    () => this._zoomStep(1.2)));
    bar.appendChild(mkBtn('−', 'Zoom out',   () => this._zoomStep(1 / 1.2)));
    bar.appendChild(mkBtn('⊙', 'Fit to view', () => this._resetToFit()));

    this._container.appendChild(bar);
  }

  // ── Utils ─────────────────────────────────────────────────
};

if (typeof module !== 'undefined' && module.exports) module.exports = { architectureGraphView };
