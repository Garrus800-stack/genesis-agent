// ============================================================
// GENESIS — src/ui/modules/splitter.js (v7.8.6)
//
// Drag-to-resize splitters between the four main-layout panels.
// Each splitter sits between two named panels in DOM, but its
// visibility logic is smarter than just "both neighbours visible":
// a splitter shows whenever its data-prev panel is visible AND
// any later panel in the row is also visible. Hidden intermediate
// panels are skipped so the splitter visually attaches to whichever
// visible panel actually follows. This way a user can resize
// file-tree even when goals AND editor are toggled off — the
// splitter still appears between file-tree and chat.
//
// Persistence:
//   ui.panelWidths = { file-tree: 220, goals: 280, editor: 600 }
// ============================================================

'use strict';

const PANEL_KEY_TO_ID = {
  'file-tree': 'file-tree-panel',
  'goals':     'goals-panel',
  'editor':    'editor-panel',
};
const ID_TO_PANEL_KEY = Object.fromEntries(
  Object.entries(PANEL_KEY_TO_ID).map(([k, v]) => [v, k])
);

const DEFAULTS = { 'file-tree': 220, 'goals': 280, 'editor': 600 };
const MIN_WIDTHS = { 'file-tree': 180, 'goals': 220, 'editor': 300 };
const KEYBOARD_STEP = 10;
const PERSIST_DEBOUNCE_MS = 200;

let _persistTimer = null;
let _resizeObserver = null;
let _agentReadyRef = () => false;

function _maxWidthForPanel() {
  const layout = document.querySelector('#main-layout');
  if (!layout) return Math.min(window.innerWidth * 0.5, 800);
  return Math.max(200, Math.min(window.innerWidth * 0.5, layout.clientWidth - 400));
}

function _readWidth(panelKey) {
  const css = getComputedStyle(document.documentElement).getPropertyValue(`--panel-width-${panelKey}`).trim();
  if (css && css.endsWith('px')) return parseInt(css, 10);
  return DEFAULTS[panelKey];
}

function _writeWidth(panelKey, px) {
  const clamped = Math.max(MIN_WIDTHS[panelKey], Math.min(px, _maxWidthForPanel()));
  document.documentElement.style.setProperty(`--panel-width-${panelKey}`, `${clamped}px`);
  return clamped;
}

function _firePanelResize(panelKey) {
  const id = PANEL_KEY_TO_ID[panelKey];
  if (!id) return;
  if (typeof window.dispatchEvent !== 'function' || typeof CustomEvent !== 'function') return;
  window.dispatchEvent(new CustomEvent('panel:resize', { detail: { id, width: _readWidth(panelKey) } }));
}

function _persistWidths() {
  if (_persistTimer) clearTimeout(_persistTimer);
  _persistTimer = setTimeout(() => {
    _persistTimer = null;
    if (!_agentReadyRef()) return;
    const widths = {};
    for (const key of Object.keys(DEFAULTS)) widths[key] = _readWidth(key);
    try {
      window.genesis?.invoke?.('agent:set-setting', { key: 'ui.panelWidths', value: widths });
    } catch (_e) { /* best-effort */ }
  }, PERSIST_DEBOUNCE_MS);
}

function _applyStoredWidths(stored) {
  if (!stored || typeof stored !== 'object') return;
  for (const [key, value] of Object.entries(stored)) {
    if (!DEFAULTS[key]) continue;
    const n = parseInt(value, 10);
    if (Number.isFinite(n)) _writeWidth(key, n);
  }
}

function _splitterPanelKey(splitter) {
  const prevId = splitter.getAttribute('data-prev');
  return ID_TO_PANEL_KEY[prevId];
}

/**
 * v7.8.6 visibility rule: splitter shows iff
 *   (a) its data-prev panel exists and is visible
 *   (b) any panel-class sibling further right in the row is also visible
 * Intermediate hidden panels are skipped, so the splitter visually
 * attaches to whichever next-visible panel actually follows.
 *
 * Why: without this, toggling away an intermediate panel (e.g. goals
 * hidden) would orphan splitters between still-visible panels — the
 * user could no longer resize file-tree because both adjacent
 * neighbour splitters were hidden.
 */
function _updateSplitterVisibility() {
  document.querySelectorAll('.splitter').forEach(sp => {
    const prev = document.getElementById(sp.getAttribute('data-prev'));
    if (!prev || prev.classList.contains('hidden')) {
      sp.classList.add('hidden');
      return;
    }
    let nextEl = sp.nextElementSibling;
    let hasNextVisiblePanel = false;
    while (nextEl) {
      if (nextEl.classList.contains('panel') && !nextEl.classList.contains('hidden')) {
        hasNextVisiblePanel = true;
        break;
      }
      nextEl = nextEl.nextElementSibling;
    }
    sp.classList.toggle('hidden', !hasNextVisiblePanel);
  });
}

function _attachDragHandlers(splitter) {
  const panelKey = _splitterPanelKey(splitter);
  if (!panelKey) return;
  let startX = 0;
  let startWidth = 0;

  const onMove = (clientX) => {
    const delta = clientX - startX;
    _writeWidth(panelKey, startWidth + delta);
    _firePanelResize(panelKey);
  };

  const onMouseMove = (e) => onMove(e.clientX);
  const onTouchMove = (e) => { if (e.touches[0]) onMove(e.touches[0].clientX); };

  const onEnd = () => {
    splitter.classList.remove('dragging');
    window.removeEventListener('mousemove', onMouseMove);
    window.removeEventListener('mouseup', onEnd);
    window.removeEventListener('touchmove', onTouchMove);
    window.removeEventListener('touchend', onEnd);
    document.body.style.cursor = '';
    _persistWidths();
  };

  splitter.addEventListener('mousedown', (e) => {
    startX = e.clientX;
    startWidth = _readWidth(panelKey);
    splitter.classList.add('dragging');
    document.body.style.cursor = 'col-resize';
    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onEnd);
    e.preventDefault();
  });

  splitter.addEventListener('touchstart', (e) => {
    if (!e.touches[0]) return;
    startX = e.touches[0].clientX;
    startWidth = _readWidth(panelKey);
    splitter.classList.add('dragging');
    window.addEventListener('touchmove', onTouchMove);
    window.addEventListener('touchend', onEnd);
    e.preventDefault();
  }, { passive: false });

  splitter.addEventListener('dblclick', () => {
    _writeWidth(panelKey, DEFAULTS[panelKey]);
    _firePanelResize(panelKey);
    _persistWidths();
  });

  splitter.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowLeft') {
      _writeWidth(panelKey, _readWidth(panelKey) - KEYBOARD_STEP);
      _firePanelResize(panelKey);
      _persistWidths();
      e.preventDefault();
    } else if (e.key === 'ArrowRight') {
      _writeWidth(panelKey, _readWidth(panelKey) + KEYBOARD_STEP);
      _firePanelResize(panelKey);
      _persistWidths();
      e.preventDefault();
    }
  });
}

function _setupResizeObserver() {
  const layout = document.querySelector('#main-layout');
  if (!layout || typeof ResizeObserver === 'undefined') return;
  _resizeObserver = new ResizeObserver(() => {
    for (const key of Object.keys(DEFAULTS)) {
      const current = _readWidth(key);
      _writeWidth(key, current);
    }
  });
  _resizeObserver.observe(layout);
}

async function initSplitters(agentReadyFn) {
  if (typeof agentReadyFn === 'function') _agentReadyRef = agentReadyFn;

  if (window.genesis?.invoke && _agentReadyRef()) {
    try {
      const settings = await window.genesis.invoke('agent:get-settings');
      _applyStoredWidths(settings?.ui?.panelWidths);
    } catch (_e) { /* fallback to defaults */ }
  }

  document.querySelectorAll('.splitter').forEach(_attachDragHandlers);
  _updateSplitterVisibility();
  window.addEventListener('panel:visibility-changed', _updateSplitterVisibility);
  _setupResizeObserver();
}

function resetAllPanelWidths() {
  for (const key of Object.keys(DEFAULTS)) {
    _writeWidth(key, DEFAULTS[key]);
    _firePanelResize(key);
  }
  _persistWidths();
}

module.exports = {
  initSplitters,
  resetAllPanelWidths,
  _readWidth,
  _writeWidth,
  _updateSplitterVisibility,
  _applyStoredWidths,
  DEFAULTS,
  MIN_WIDTHS,
};
