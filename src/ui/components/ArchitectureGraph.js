// ============================================================
// GENESIS — ArchitectureGraph.js (v5.9.2 — UI Phase 2)
//
// Interactive SVG force-directed architecture graph.
// Renders services as nodes, dependencies/events as edges.
// Color-coded by boot phase. Click to highlight connections.
// Hover for details. Drag to reposition.
//
// Used by Dashboard._renderArchitectureGraph().
// ============================================================

'use strict';

const PHASE_COLORS = [
  '#6366f1', '#8b5cf6', '#a855f7', '#d946ef',
  '#ec4899', '#f43f5e', '#f97316', '#eab308',
  '#84cc16', '#22c55e', '#14b8a6', '#06b6d4', '#3b82f6',
];

const EDGE_COLORS = {
  'depends-on':   'var(--color-text-secondary, #888)',
  'late-binding':  'var(--color-warning, #eab308)',
  'emits':         'var(--color-success, #22c55e)',
  'listens':       'var(--color-info, #06b6d4)',
  'cross-phase':   'var(--color-danger, #f43f5e)',
};

class ArchitectureGraph {
  /**
   * @param {HTMLElement} container
   * @param {{ nodes: Array<*>, edges: Array<*>, layers: Array<*> }} graphData
   */
  constructor(container, graphData) {
    this._container = container;
    this._data = graphData;
    this._svg = null;
    this._tooltip = null;
    this._selected = null;
    this._nodePositions = new Map();
    this._width = 0;
    this._height = 0;
    this._dragging = null;
    this._animFrame = null;

    // v7.9.5: Zoom + pan state. The whole nodes/edges layer lives inside
    // a wrapper <g> with transform `translate(panX,panY) scale(zoom)`.
    // The legend sits OUTSIDE the wrapper so it stays fixed during zoom.
    this._zoom = 1.0;
    this._panX = 0;
    this._panY = 0;
    this._zoomWrap = null;   // SVG <g> element holding the zoomable content
    this._panning = null;    // { startX, startY } while panning the canvas
  }

  // v7.9.5: Zoom bounds. 0.2× is the floor where a 178-service graph
  // still has readable edge bundles; 5× is where individual nodes fill
  // most of the viewport.
  static get ZOOM_MIN() { return 0.2; }
  static get ZOOM_MAX() { return 5.0; }
  static get FIT_MARGIN() { return 40; }  // px of padding around the fit bbox


  render() {
    if (!this._data || !this._data.nodes || this._data.nodes.length === 0) {
      this._container.innerHTML = '<span class="dash-muted">Keine Graph-Daten</span>';
      return;
    }

    this._width = this._container.clientWidth || 800;
    this._height = Math.max(400, Math.min(600, this._data.nodes.length * 3));

    // Filter to service nodes only for main graph (events are too noisy)
    const serviceNodes = this._data.nodes.filter(n => n.type === 'service');
    const serviceIds = new Set(serviceNodes.map(n => n.id));
    const edges = this._data.edges.filter(e =>
      serviceIds.has(e.from) && serviceIds.has(e.to) &&
      (e.type === 'depends-on' || e.type === 'late-binding' || e.type === 'cross-phase')
    );

    // Initial layout: group by phase
    this._layoutByPhase(serviceNodes);

    // Build SVG
    this._container.innerHTML = '';
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', `0 0 ${this._width} ${this._height}`);
    svg.setAttribute('width', '100%');
    svg.setAttribute('height', this._height + 'px');
    svg.style.background = 'var(--color-bg-secondary, #1a1a2e)';
    svg.style.borderRadius = '8px';
    svg.style.cursor = 'grab';
    this._svg = svg;

    // Defs for arrow markers
    const defs = document.createElementNS('http://www.w3.org/2000/svg', 'defs');
    defs.innerHTML = `<marker id="arrow" viewBox="0 0 10 6" refX="10" refY="3" markerWidth="6" markerHeight="4" orient="auto-start-reverse"><path d="M 0 0 L 10 3 L 0 6 z" fill="var(--color-text-secondary, #666)" opacity="0.4"/></marker>`;
    svg.appendChild(defs);

    // v7.9.5: Wrapper <g> that carries the zoom/pan transform. Edges + nodes
    // sit inside; the legend stays outside so it doesn't scale with the graph.
    const zoomWrap = document.createElementNS('http://www.w3.org/2000/svg', 'g');
    zoomWrap.setAttribute('class', 'arch-zoom-wrap');
    this._zoomWrap = zoomWrap;

    // Edge group (behind nodes)
    const edgeGroup = document.createElementNS('http://www.w3.org/2000/svg', 'g');
    edgeGroup.setAttribute('class', 'arch-edges');
    for (const edge of edges) {
      const from = this._nodePositions.get(edge.from);
      const to = this._nodePositions.get(edge.to);
      if (!from || !to) continue;

      const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
      line.setAttribute('x1', from.x);
      line.setAttribute('y1', from.y);
      line.setAttribute('x2', to.x);
      line.setAttribute('y2', to.y);
      line.setAttribute('stroke', EDGE_COLORS[edge.type] || '#444');
      line.setAttribute('stroke-width', edge.type === 'cross-phase' ? '1.5' : '0.5');
      line.setAttribute('stroke-opacity', '0.3');
      line.setAttribute('marker-end', 'url(#arrow)');
      line.dataset.from = edge.from;
      line.dataset.to = edge.to;
      line.dataset.type = edge.type;
      edgeGroup.appendChild(line);
    }
    zoomWrap.appendChild(edgeGroup);

    // Node group
    const nodeGroup = document.createElementNS('http://www.w3.org/2000/svg', 'g');
    nodeGroup.setAttribute('class', 'arch-nodes');
    for (const node of serviceNodes) {
      const pos = this._nodePositions.get(node.id);
      if (!pos) continue;

      const g = document.createElementNS('http://www.w3.org/2000/svg', 'g');
      g.setAttribute('transform', `translate(${pos.x}, ${pos.y})`);
      g.style.cursor = 'pointer';
      g.dataset.nodeId = node.id;

      const phase = node.phase >= 0 ? node.phase : 0;
      const color = PHASE_COLORS[phase % PHASE_COLORS.length];

      // Circle
      const circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
      circle.setAttribute('r', '6');
      circle.setAttribute('fill', color);
      circle.setAttribute('stroke', 'var(--color-bg, #111)');
      circle.setAttribute('stroke-width', '1');
      circle.setAttribute('opacity', '0.85');
      g.appendChild(circle);

      // Label (only for larger graphs — skip if too many nodes)
      if (serviceNodes.length < 80) {
        const label = document.createElementNS('http://www.w3.org/2000/svg', 'text');
        label.setAttribute('x', '9');
        label.setAttribute('y', '3');
        label.setAttribute('fill', 'var(--color-text-secondary, #aaa)');
        label.setAttribute('font-size', '8');
        label.setAttribute('font-family', 'var(--font-mono, monospace)');
        label.textContent = node.name.length > 18 ? node.name.slice(0, 16) + '…' : node.name;
        g.appendChild(label);
      }

      // Event handlers
      g.addEventListener('click', () => this._selectNode(node, edges, serviceNodes));
      g.addEventListener('mouseenter', () => this._showTooltip(node, edges));
      g.addEventListener('mouseleave', () => this._hideTooltip());

      // Drag
      g.addEventListener('mousedown', (e) => this._startDrag(e, node));

      nodeGroup.appendChild(g);
    }
    zoomWrap.appendChild(nodeGroup);
    svg.appendChild(zoomWrap);

    // Legend (outside zoomWrap — stays fixed during zoom/pan)
    this._addLegend(svg, this._data.layers || []);

    // Tooltip element
    // v7.9.2: max-width 250→320 for the new connected-to name list; line-height
    // 1.4 for the multi-line content; the pointer-events still :none since we
    // don't need to interact with the tooltip — pinning is state-based.
    const tooltip = document.createElement('div');
    tooltip.className = 'arch-graph-tooltip';
    tooltip.style.cssText = 'display:none;position:absolute;padding:6px 10px;border-radius:6px;font-size:11px;line-height:1.4;pointer-events:none;z-index:100;background:var(--color-bg-tertiary,#222);border:1px solid var(--color-border,#333);color:var(--color-text,#eee);max-width:320px;';
    this._tooltip = tooltip;

    this._container.appendChild(svg);
    this._container.appendChild(tooltip);

    // v7.9.5: zoom/pan toolbar — small absolute-positioned buttons top-right
    // of the graph container. Provides explicit fallback for users who don't
    // discover the wheel/drag gesture, and accessibility for keyboard users.
    this._addZoomToolbar();

    // Global drag handlers — used by both node-drag (existing) and pan (new).
    svg.addEventListener('mousemove', (e) => this._onDrag(e));
    svg.addEventListener('mouseup', () => this._endDrag());
    svg.addEventListener('mouseleave', () => this._endDrag());

    // v7.9.5: Zoom / pan handlers.
    // - Wheel anywhere over the SVG → zoom to cursor.
    // - Mousedown on empty space (not a node) → pan.
    // - Double-click on empty space → reset to fit.
    svg.addEventListener('wheel', (e) => this._onWheel(e), { passive: false });
    svg.addEventListener('mousedown', (e) => this._maybeStartPan(e));
    svg.addEventListener('dblclick', (e) => this._maybeResetFit(e));

    // Compute initial fit so the whole graph is visible without scroll.
    this._resetToFit();
  }

  // ── Layout ────────────────────────────────────────────────

  _layoutByPhase(nodes) {
    // Group nodes by phase
    const phaseGroups = new Map();
    for (const n of nodes) {
      const p = n.phase >= 0 ? n.phase : 99;
      if (!phaseGroups.has(p)) phaseGroups.set(p, []);
      phaseGroups.get(p).push(n);
    }

    const phases = [...phaseGroups.keys()].sort((a, b) => a - b);
    const colWidth = this._width / (phases.length + 1);
    const padding = 30;

    for (let col = 0; col < phases.length; col++) {
      const group = phaseGroups.get(phases[col]);
      const rowHeight = (this._height - 2 * padding) / (group.length + 1);

      for (let row = 0; row < group.length; row++) {
        const x = padding + colWidth * (col + 0.5) + (Math.random() - 0.5) * 20;
        const y = padding + rowHeight * (row + 0.5) + (Math.random() - 0.5) * 10;
        this._nodePositions.set(group[row].id, { x, y });
      }
    }
  }

  // ── Interaction ───────────────────────────────────────────

  _selectNode(node, edges, allNodes) {
    // v7.9.2: toggle pin & highlights via simple "same-node-clicked-twice"
    // detection. Reads _selected BEFORE mutating, fixing the v7.x.x toggle
    // bug where every third+ click on the same node would re-trigger
    // deselection. Now: first click pins & highlights, second click on
    // same node unpins & resets, click on different node switches pin.
    const wasSelected = this._selected === node.id;

    if (wasSelected) {
      // Unpin & reset
      this._tooltipPinned = null;
      this._selected = null;
      this._resetHighlights();
      this._hideTooltip();
      return;
    }

    // Highlight connected nodes and edges
    const connected = new Set([node.id]);
    for (const e of edges) {
      if (e.from === node.id) connected.add(e.to);
      if (e.to === node.id) connected.add(e.from);
    }

    // Dim non-connected
    const nodeEls = this._svg.querySelectorAll('.arch-nodes g');
    for (const el of nodeEls) {
      const id = el.dataset.nodeId;
      const isConn = connected.has(id);
      el.querySelector('circle').setAttribute('opacity', isConn ? '1' : '0.15');
      const txt = el.querySelector('text');
      if (txt) txt.setAttribute('opacity', isConn ? '1' : '0.2');
    }

    const edgeEls = this._svg.querySelectorAll('.arch-edges line');
    for (const el of edgeEls) {
      const isConn = (el.dataset.from === node.id || el.dataset.to === node.id);
      el.setAttribute('stroke-opacity', isConn ? '0.8' : '0.05');
      el.setAttribute('stroke-width', isConn ? '2' : '0.5');
    }

    this._selected = node.id;
    // v7.9.2: pin the tooltip so it stays visible until the user clicks
    // elsewhere — and re-show with the pin badge.
    this._tooltipPinned = node.id;
    this._showTooltip(node, edges);
  }

  _resetHighlights() {
    const nodeEls = this._svg.querySelectorAll('.arch-nodes g');
    for (const el of nodeEls) {
      el.querySelector('circle').setAttribute('opacity', '0.85');
      const txt = el.querySelector('text');
      if (txt) txt.setAttribute('opacity', '1');
    }
    const edgeEls = this._svg.querySelectorAll('.arch-edges line');
    for (const el of edgeEls) {
      el.setAttribute('stroke-opacity', '0.3');
      el.setAttribute('stroke-width', el.dataset.type === 'cross-phase' ? '1.5' : '0.5');
    }
  }

  _showTooltip(node, edges) {
    // v7.9.2: respect pin — don't overwrite a pinned tooltip on hover
    if (this._tooltipPinned && this._tooltipPinned !== node.id) return;

    // Build a cached node-id → name lookup. Built lazily because nodes
    // can be filtered to services in render(); rebuilding per-call is
    // cheap but caching is cheaper and the data doesn't change.
    if (!this._nameById) {
      this._nameById = new Map(this._data.nodes.map(n => [n.id, n.name]));
    }
    const nameById = this._nameById;

    // Collect connected names — bounded to 8 with "+N more" overflow.
    const outboundNames = edges.filter(e => e.from === node.id)
      .map(e => nameById.get(e.to))
      .filter(Boolean);
    const inboundNames = edges.filter(e => e.to === node.id)
      .map(e => nameById.get(e.from))
      .filter(Boolean);

    const fmtList = (arr) => {
      if (arr.length === 0) return '<em>none</em>';
      if (arr.length <= 8) return arr.map(n => this._esc(n)).join(', ');
      return arr.slice(0, 8).map(n => this._esc(n)).join(', ') + ` <em>+${arr.length - 8} more</em>`;
    };

    const layer = node.layer || 'unknown';
    let html =
      `<strong>${this._esc(node.name)}</strong><br>` +
      `Layer: ${this._esc(layer)} · Phase ${node.phase}<br>` +
      `↗ ${outboundNames.length} deps out · ↙ ${inboundNames.length} deps in` +
      (node.tags?.length ? `<br>Tags: ${node.tags.join(', ')}` : '');

    if (outboundNames.length > 0) {
      html += `<br><br><strong>↗ Out:</strong> ${fmtList(outboundNames)}`;
    }
    if (inboundNames.length > 0) {
      html += `<br><strong>↙ In:</strong> ${fmtList(inboundNames)}`;
    }

    if (this._tooltipPinned === node.id) {
      html += `<br><br><em style="opacity:0.6">Click again to unpin</em>`;
    }

    this._tooltip.innerHTML = html;
    this._tooltip.style.display = 'block';

    // v7.9.2: Smart positioning — measure tooltip after display, flip if
    // it would overflow the container bounds. Container is position:relative.
    const pos = this._nodePositions.get(node.id);
    if (!pos) return;
    const rect = this._container.getBoundingClientRect();
    const svgRect = this._svg.getBoundingClientRect();
    const scaleX = svgRect.width / this._width;
    const scaleY = svgRect.height / this._height;
    const nodeLeft = pos.x * scaleX + svgRect.left - rect.left;
    const nodeTop = pos.y * scaleY + svgRect.top - rect.top;

    // Reset to measurable position first
    this._tooltip.style.left = '0px';
    this._tooltip.style.top = '0px';
    const tw = this._tooltip.offsetWidth;
    const th = this._tooltip.offsetHeight;
    const cw = this._container.clientWidth;
    const ch = this._container.clientHeight;

    // Prefer right-of-node, flip to left if no room
    let left = nodeLeft + 12;
    if (left + tw > cw - 4) left = nodeLeft - tw - 12;
    if (left < 4) left = 4; // last-resort clamp to container left edge

    // Prefer above-node, flip below if no room above
    let top = nodeTop - th - 10;
    if (top < 4) top = nodeTop + 14;
    if (top + th > ch - 4) top = Math.max(4, ch - th - 4);

    this._tooltip.style.left = `${left}px`;
    this._tooltip.style.top = `${top}px`;
  }

  _hideTooltip() {
    // v7.9.2: pinned tooltips stay visible until explicitly unpinned via click
    if (this._tooltipPinned) return;
    if (this._tooltip) this._tooltip.style.display = 'none';
  }

  // ── Drag ──────────────────────────────────────────────────

  _startDrag(e, node) {
    e.preventDefault();
    this._dragging = { nodeId: node.id, startX: e.clientX, startY: e.clientY };
    this._svg.style.cursor = 'grabbing';
  }

  _onDrag(e) {
    // v7.9.5: Pan path — mousedown landed on empty space.
    if (this._panning) {
      const dx = e.clientX - this._panning.startX;
      const dy = e.clientY - this._panning.startY;
      // Convert client-px deltas to viewBox units. viewBox is 0..width × 0..height
      // mapped to svgRect.width × svgRect.height, so we scale by the same ratio.
      const svgRect = this._svg.getBoundingClientRect();
      const scaleX = this._width  / svgRect.width;
      const scaleY = this._height / svgRect.height;
      this._panX = this._panning.origPanX + dx * scaleX;
      this._panY = this._panning.origPanY + dy * scaleY;
      this._applyTransform();
      return;
    }

    if (!this._dragging) return;
    const pos = this._nodePositions.get(this._dragging.nodeId);
    if (!pos) return;

    const svgRect = this._svg.getBoundingClientRect();
    const scaleX = this._width / svgRect.width;
    const scaleY = this._height / svgRect.height;

    // v7.9.5: divide by zoom so a 1px mouse move yields a 1px on-screen
    // node move regardless of zoom level. Without this, dragging at 5×
    // zoom would feel 5× slower than at 1×.
    const dx = (e.clientX - this._dragging.startX) * scaleX / this._zoom;
    const dy = (e.clientY - this._dragging.startY) * scaleY / this._zoom;

    pos.x += dx;
    pos.y += dy;
    this._dragging.startX = e.clientX;
    this._dragging.startY = e.clientY;

    // Update node position
    const nodeEl = this._svg.querySelector(`g[data-node-id="${this._dragging.nodeId}"]`);
    if (nodeEl) nodeEl.setAttribute('transform', `translate(${pos.x}, ${pos.y})`);

    // Update connected edges
    const edgeEls = this._svg.querySelectorAll('.arch-edges line');
    for (const el of edgeEls) {
      if (el.dataset.from === this._dragging.nodeId) {
        el.setAttribute('x1', pos.x);
        el.setAttribute('y1', pos.y);
      }
      if (el.dataset.to === this._dragging.nodeId) {
        el.setAttribute('x2', pos.x);
        el.setAttribute('y2', pos.y);
      }
    }
  }

  _endDrag() {
    this._dragging = null;
    this._panning = null;  // v7.9.5
    if (this._svg) this._svg.style.cursor = 'grab';
  }

  // ── Legend ─────────────────────────────────────────────────

  _addLegend(svg, layers) {
    const g = document.createElementNS('http://www.w3.org/2000/svg', 'g');
    g.setAttribute('transform', `translate(8, ${this._height - 18})`);

    let x = 0;
    for (let i = 0; i < Math.min(layers.length, 13); i++) {
      const color = PHASE_COLORS[i % PHASE_COLORS.length];
      const name = layers[i]?.name || `P${i + 1}`;

      const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
      rect.setAttribute('x', x);
      rect.setAttribute('y', '0');
      rect.setAttribute('width', '8');
      rect.setAttribute('height', '8');
      rect.setAttribute('rx', '2');
      rect.setAttribute('fill', color);
      g.appendChild(rect);

      const txt = document.createElementNS('http://www.w3.org/2000/svg', 'text');
      txt.setAttribute('x', x + 11);
      txt.setAttribute('y', '7');
      txt.setAttribute('fill', 'var(--color-text-secondary, #888)');
      txt.setAttribute('font-size', '7');
      const short = name.length > 6 ? name.slice(0, 5) : name;
      txt.textContent = short;
      g.appendChild(txt);

      x += 11 + short.length * 4.5 + 6;
    }

    svg.appendChild(g);
  }

  // ── v7.9.5: Zoom + Pan ───────────────────────────────────

  _applyTransform() {
    if (!this._zoomWrap) return;
    this._zoomWrap.setAttribute(
      'transform',
      `translate(${this._panX}, ${this._panY}) scale(${this._zoom})`
    );
  }

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
      ArchitectureGraph.ZOOM_MIN,
      Math.min(ArchitectureGraph.ZOOM_MAX, this._zoom * factor)
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
  }

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
  }

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
  }

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
    const m = ArchitectureGraph.FIT_MARGIN;
    const bboxW = Math.max(1, maxX - minX);
    const bboxH = Math.max(1, maxY - minY);
    const availW = Math.max(1, this._width  - 2 * m);
    const availH = Math.max(1, this._height - 2 * m);
    const fitZoom = Math.min(availW / bboxW, availH / bboxH, ArchitectureGraph.ZOOM_MAX);
    const clampedZoom = Math.max(ArchitectureGraph.ZOOM_MIN, fitZoom);
    // Center the bbox in the viewport.
    const cx = (minX + maxX) / 2;
    const cy = (minY + maxY) / 2;
    this._zoom = clampedZoom;
    this._panX = this._width  / 2 - cx * clampedZoom;
    this._panY = this._height / 2 - cy * clampedZoom;
    this._applyTransform();
  }

  /**
   * Zoom in/out by a fixed step. Used by the toolbar buttons. Zooms
   * around the viewport center, since there's no cursor reference.
   */
  _zoomStep(factor) {
    const newZoom = Math.max(
      ArchitectureGraph.ZOOM_MIN,
      Math.min(ArchitectureGraph.ZOOM_MAX, this._zoom * factor)
    );
    if (newZoom === this._zoom) return;
    const cx = this._width / 2;
    const cy = this._height / 2;
    const ratio = newZoom / this._zoom;
    this._panX = cx - (cx - this._panX) * ratio;
    this._panY = cy - (cy - this._panY) * ratio;
    this._zoom = newZoom;
    this._applyTransform();
  }

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

  _esc(s) {
    if (typeof s !== 'string') return '';
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  destroy() {
    if (this._animFrame) cancelAnimationFrame(this._animFrame);
    this._container.innerHTML = '';
    this._svg = null;
    this._tooltip = null;
  }
}

// Export for Dashboard use
if (typeof window !== 'undefined') {
  window.ArchitectureGraph = ArchitectureGraph;
}
if (typeof module !== 'undefined') {
  module.exports = { ArchitectureGraph };
}
