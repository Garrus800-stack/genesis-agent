// ============================================================
// GENESIS — v795-architecture-graph-zoom.contract.test.js
//
// Smoke tests for v7.9.5 ArchitectureGraph zoom/pan. Heavy DOM
// interaction (wheel events, mouse drag, hit-testing) is out of
// scope for headless JS — those stay in the manual UX checklist.
// Here we verify the structural contract: state fields exist,
// zoom math is mathematically correct, the wrapper-G is created,
// the toolbar is created, fit logic clamps correctly.
// ============================================================

'use strict';

const path = require('path');
const ROOT = path.resolve(__dirname, '../..');
const { describe, test, assert, assertEqual, run } = require('../harness');

describe('v7.9.5 Architecture Graph Zoom/Pan', () => {

// Minimal SVG/DOM shim so the ArchitectureGraph module loads in node.
// We only need the structural calls — not real rendering.
function shimDom() {
  if (typeof global.document !== 'undefined') return;
  const _nodes = [];
  const mkEl = (tag) => {
    const el = {
      tag,
      attrs: {},
      style: { cssText: '' },
      children: [],
      listeners: {},
      dataset: {},
      textContent: '',
      setAttribute(k, v) { this.attrs[k] = String(v); },
      getAttribute(k) { return this.attrs[k]; },
      appendChild(c) { this.children.push(c); c.parent = this; return c; },
      removeChild(c) { this.children = this.children.filter(x => x !== c); },
      remove() { if (this.parent) this.parent.removeChild(this); },
      addEventListener(ev, fn) {
        (this.listeners[ev] || (this.listeners[ev] = [])).push(fn);
      },
      querySelector() { return null; },
      querySelectorAll() { return []; },
      getBoundingClientRect() { return { left: 0, top: 0, width: 800, height: 600 }; },
      get clientWidth() { return 800; },
    };
    _nodes.push(el);
    return el;
  };
  global.document = {
    createElementNS: (_ns, tag) => mkEl(tag),
    createElement: (tag) => mkEl(tag),
  };
  // Provide cancelAnimationFrame for destroy()
  if (typeof global.cancelAnimationFrame === 'undefined') {
    global.cancelAnimationFrame = () => {};
  }
}

function makeGraphData(nodeCount) {
  const nodes = [];
  for (let i = 0; i < nodeCount; i++) {
    nodes.push({ id: `svc${i}`, name: `Service${i}`, type: 'service', phase: i % 13 });
  }
  return {
    nodes,
    edges: [],
    layers: Array.from({ length: 13 }, (_, i) => ({ name: `P${i + 1}` })),
  };
}

// ── Constructor + static bounds ────────────────────────────

test('B1: zoom/pan state fields exist on a fresh instance', () => {
  shimDom();
  const { ArchitectureGraph } = require(path.join(ROOT, 'src/ui/components/ArchitectureGraph'));
  const container = document.createElement('div');
  const ag = new ArchitectureGraph(container, makeGraphData(0));
  assertEqual(ag._zoom, 1.0);
  assertEqual(ag._panX, 0);
  assertEqual(ag._panY, 0);
  assertEqual(ag._zoomWrap, null);   // not rendered yet
  assertEqual(ag._panning, null);
});

test('B1: static ZOOM_MIN / ZOOM_MAX / FIT_MARGIN are sensible', () => {
  const { ArchitectureGraph } = require(path.join(ROOT, 'src/ui/components/ArchitectureGraph'));
  assert(ArchitectureGraph.ZOOM_MIN > 0,           'min zoom must be positive');
  assert(ArchitectureGraph.ZOOM_MIN < 1,           'min zoom should allow zooming out');
  assert(ArchitectureGraph.ZOOM_MAX > 1,           'max zoom should allow zooming in');
  assert(ArchitectureGraph.ZOOM_MAX <= 10,         'max zoom should not be absurd');
  assert(ArchitectureGraph.FIT_MARGIN >= 0,        'fit margin non-negative');
});

// ── Methods exist ───────────────────────────────────────────

test('B2: zoom/pan/fit methods exist on the prototype', () => {
  const { ArchitectureGraph } = require(path.join(ROOT, 'src/ui/components/ArchitectureGraph'));
  const proto = ArchitectureGraph.prototype;
  for (const name of [
    '_applyTransform', '_onWheel', '_maybeStartPan', '_maybeResetFit',
    '_resetToFit', '_zoomStep', '_addZoomToolbar',
  ]) {
    assertEqual(typeof proto[name], 'function', `${name} must be defined`);
  }
});

// ── Reset-to-fit math ───────────────────────────────────────

test('B3: _resetToFit clamps to ZOOM_MAX when bbox is tiny', () => {
  shimDom();
  const { ArchitectureGraph } = require(path.join(ROOT, 'src/ui/components/ArchitectureGraph'));
  const container = document.createElement('div');
  const ag = new ArchitectureGraph(container, makeGraphData(0));
  // Set up minimal state for _resetToFit
  ag._zoomWrap = document.createElementNS('svg', 'g');
  ag._width = 800;
  ag._height = 600;
  ag._nodePositions.set('a', { x: 400, y: 300 });
  ag._nodePositions.set('b', { x: 401, y: 301 });
  ag._resetToFit();
  // 1px bbox with 800×600 viewport would require ~720× zoom — must clamp.
  assertEqual(ag._zoom, ArchitectureGraph.ZOOM_MAX);
});

test('B3: _resetToFit clamps to ZOOM_MIN when bbox is huge', () => {
  shimDom();
  const { ArchitectureGraph } = require(path.join(ROOT, 'src/ui/components/ArchitectureGraph'));
  const container = document.createElement('div');
  const ag = new ArchitectureGraph(container, makeGraphData(0));
  ag._zoomWrap = document.createElementNS('svg', 'g');
  ag._width = 800;
  ag._height = 600;
  ag._nodePositions.set('a', { x: 0, y: 0 });
  ag._nodePositions.set('b', { x: 100000, y: 100000 });
  ag._resetToFit();
  // 100k bbox with 800×600 viewport would need ~0.006× zoom — must clamp up.
  assertEqual(ag._zoom, ArchitectureGraph.ZOOM_MIN);
});

test('B3: _resetToFit centers the bbox in the viewport', () => {
  shimDom();
  const { ArchitectureGraph } = require(path.join(ROOT, 'src/ui/components/ArchitectureGraph'));
  const container = document.createElement('div');
  const ag = new ArchitectureGraph(container, makeGraphData(0));
  ag._zoomWrap = document.createElementNS('svg', 'g');
  ag._width = 800;
  ag._height = 600;
  // A 400×300 bbox centered around the SVG origin (0,0) — after fit,
  // the bbox center should map to the viewport center.
  ag._nodePositions.set('a', { x: -200, y: -150 });
  ag._nodePositions.set('b', { x:  200, y:  150 });
  ag._resetToFit();
  // bbox center (0,0) → viewport center (400, 300)
  // pan = vpCenter - bboxCenter * zoom = (400, 300) - (0, 0) * zoom = (400, 300)
  assertEqual(ag._panX, 400);
  assertEqual(ag._panY, 300);
});

// ── Transform output ────────────────────────────────────────

test('B4: _applyTransform writes the correct transform attribute', () => {
  shimDom();
  const { ArchitectureGraph } = require(path.join(ROOT, 'src/ui/components/ArchitectureGraph'));
  const container = document.createElement('div');
  const ag = new ArchitectureGraph(container, makeGraphData(0));
  ag._zoomWrap = document.createElementNS('svg', 'g');
  ag._zoom = 2.5;
  ag._panX = 100;
  ag._panY = 50;
  ag._applyTransform();
  assertEqual(ag._zoomWrap.attrs.transform, 'translate(100, 50) scale(2.5)');
});

test('B4: _applyTransform no-op when zoomWrap not yet created', () => {
  shimDom();
  const { ArchitectureGraph } = require(path.join(ROOT, 'src/ui/components/ArchitectureGraph'));
  const container = document.createElement('div');
  const ag = new ArchitectureGraph(container, makeGraphData(0));
  // Should not throw
  ag._applyTransform();
});

// ── _zoomStep math ──────────────────────────────────────────

test('B5: _zoomStep zooms around viewport center', () => {
  shimDom();
  const { ArchitectureGraph } = require(path.join(ROOT, 'src/ui/components/ArchitectureGraph'));
  const container = document.createElement('div');
  const ag = new ArchitectureGraph(container, makeGraphData(0));
  ag._zoomWrap = document.createElementNS('svg', 'g');
  ag._width = 800;
  ag._height = 600;
  ag._zoom = 1.0;
  ag._panX = 0;
  ag._panY = 0;
  // Initial transform: identity. Viewport-center point (400, 300) in
  // screen space corresponds to (400, 300) in data space.
  ag._zoomStep(2.0);
  assertEqual(ag._zoom, 2.0);
  // After 2× zoom around (400, 300), data-point (400, 300) must still
  // sit at screen-point (400, 300):
  //   screen = data * zoom + pan
  //   400 = 400 * 2.0 + panX → panX = -400
  assertEqual(ag._panX, -400);
  assertEqual(ag._panY, -300);
});

test('B5: _zoomStep clamps at ZOOM_MAX', () => {
  shimDom();
  const { ArchitectureGraph } = require(path.join(ROOT, 'src/ui/components/ArchitectureGraph'));
  const container = document.createElement('div');
  const ag = new ArchitectureGraph(container, makeGraphData(0));
  ag._zoomWrap = document.createElementNS('svg', 'g');
  ag._width = 800; ag._height = 600;
  ag._zoom = ArchitectureGraph.ZOOM_MAX;
  ag._panX = 0; ag._panY = 0;
  ag._zoomStep(2.0);  // would push above max — no-op
  assertEqual(ag._zoom, ArchitectureGraph.ZOOM_MAX);
});

test('B5: _zoomStep clamps at ZOOM_MIN', () => {
  shimDom();
  const { ArchitectureGraph } = require(path.join(ROOT, 'src/ui/components/ArchitectureGraph'));
  const container = document.createElement('div');
  const ag = new ArchitectureGraph(container, makeGraphData(0));
  ag._zoomWrap = document.createElementNS('svg', 'g');
  ag._width = 800; ag._height = 600;
  ag._zoom = ArchitectureGraph.ZOOM_MIN;
  ag._zoomStep(0.1);   // would push below min — no-op
  assertEqual(ag._zoom, ArchitectureGraph.ZOOM_MIN);
});

// ── Toolbar injection ───────────────────────────────────────

test('B6: _addZoomToolbar injects a toolbar element into the container', () => {
  shimDom();
  const { ArchitectureGraph } = require(path.join(ROOT, 'src/ui/components/ArchitectureGraph'));
  const container = document.createElement('div');
  // Patch querySelector for this test so the de-dup check works.
  container.querySelector = () => null;
  const ag = new ArchitectureGraph(container, makeGraphData(0));
  ag._addZoomToolbar();
  const toolbar = container.children.find(c => c.attrs && c.attrs.class === 'arch-zoom-toolbar');
  assert(toolbar, 'toolbar must be appended to container');
  assertEqual(toolbar.children.length, 3, 'must have +, −, ⊙ buttons');
});

test('B6: _addZoomToolbar is idempotent — does not double-inject on re-call', () => {
  shimDom();
  const { ArchitectureGraph } = require(path.join(ROOT, 'src/ui/components/ArchitectureGraph'));
  const container = document.createElement('div');
  // Patch querySelector to find the existing toolbar.
  let existing = null;
  container.querySelector = (sel) => sel === '.arch-zoom-toolbar' ? existing : null;
  const ag = new ArchitectureGraph(container, makeGraphData(0));
  ag._addZoomToolbar();
  existing = container.children.find(c => c.attrs && c.attrs.class === 'arch-zoom-toolbar') || null;
  const beforeCount = container.children.length;
  ag._addZoomToolbar();   // would .remove() the existing one before re-adding
  // We expect exactly one toolbar still — count by class attribute.
  const toolbars = container.children.filter(c => c.attrs && c.attrs.class === 'arch-zoom-toolbar');
  assertEqual(toolbars.length, 1, `expected 1 toolbar, found ${toolbars.length}`);
});

});

run();
