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
  }

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
    svg.appendChild(edgeGroup);

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
    svg.appendChild(nodeGroup);

    // Legend
    this._addLegend(svg, this._data.layers || []);

    // Tooltip element
    const tooltip = document.createElement('div');
    tooltip.className = 'arch-graph-tooltip';
    tooltip.style.cssText = 'display:none;position:absolute;padding:6px 10px;border-radius:6px;font-size:11px;pointer-events:none;z-index:100;background:var(--color-bg-tertiary,#222);border:1px solid var(--color-border,#333);color:var(--color-text,#eee);max-width:250px;';
    this._tooltip = tooltip;

    this._container.appendChild(svg);
    this._container.appendChild(tooltip);

    // Global drag handlers
    svg.addEventListener('mousemove', (e) => this._onDrag(e));
    svg.addEventListener('mouseup', () => this._endDrag());
    svg.addEventListener('mouseleave', () => this._endDrag());
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

    // Click again to deselect
    if (this._selected === node.id && this._svg._prevSelected === node.id) {
      this._resetHighlights();
      this._selected = null;
    }
    this._svg._prevSelected = node.id;
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
    const inbound = edges.filter(e => e.to === node.id).length;
    const outbound = edges.filter(e => e.from === node.id).length;
    const layer = node.layer || 'unknown';

    this._tooltip.innerHTML =
      `<strong>${this._esc(node.name)}</strong><br>` +
      `Layer: ${this._esc(layer)} · Phase ${node.phase}<br>` +
      `↗ ${outbound} deps out · ↙ ${inbound} deps in` +
      (node.tags?.length ? `<br>Tags: ${node.tags.join(', ')}` : '');
    this._tooltip.style.display = 'block';

    const pos = this._nodePositions.get(node.id);
    if (pos) {
      const rect = this._container.getBoundingClientRect();
      const svgRect = this._svg.getBoundingClientRect();
      const scaleX = svgRect.width / this._width;
      const scaleY = svgRect.height / this._height;
      this._tooltip.style.left = (pos.x * scaleX + svgRect.left - rect.left + 12) + 'px';
      this._tooltip.style.top = (pos.y * scaleY + svgRect.top - rect.top - 10) + 'px';
    }
  }

  _hideTooltip() {
    if (this._tooltip) this._tooltip.style.display = 'none';
  }

  // ── Drag ──────────────────────────────────────────────────

  _startDrag(e, node) {
    e.preventDefault();
    this._dragging = { nodeId: node.id, startX: e.clientX, startY: e.clientY };
    this._svg.style.cursor = 'grabbing';
  }

  _onDrag(e) {
    if (!this._dragging) return;
    const pos = this._nodePositions.get(this._dragging.nodeId);
    if (!pos) return;

    const svgRect = this._svg.getBoundingClientRect();
    const scaleX = this._width / svgRect.width;
    const scaleY = this._height / svgRect.height;

    const dx = (e.clientX - this._dragging.startX) * scaleX;
    const dy = (e.clientY - this._dragging.startY) * scaleY;

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
