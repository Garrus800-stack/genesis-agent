'use strict';

// ============================================================
// GENESIS — settings-fallback-ui.js (v7.7.2)
//
// Fallback chain UI for the settings modal. Extracted from
// settings.js (was Clusters D + F, lines 505-731 in the v7.7.1
// form).
//
// Two layers:
//   1. Pure logic helpers (fbAdd, fbRemove, fbMove, fbIsCloud) —
//      no DOM, no module state, just immutable chain operations.
//      Exposed for unit-testing via direct require (replaces the
//      hacky regex-source-parsing pattern from v7.5.7).
//   2. DOM rendering layer (renderFallbackUI, _renderAvailable,
//      _renderChain, _addToChain, _removeFromChain, _moveInChain) —
//      reads/writes shared state via settings-state.js.
//
// State sharing: _fallbackState used to be a module-level `let` in
// settings.js; now lives in settings-state.js with explicit getter/
// setter API. This module reads via getFallbackState() and mutates
// via setFallbackChain() / setFallbackAvailable().
// ============================================================

const {
  getFallbackState,
  setFallbackChain,
  setFallbackAvailable,
} = require('./settings-state');

const $ = (sel) => document.querySelector(sel);

// ── Pure logic helpers ───────────────────────────────────────
// (No DOM, no state — directly testable.)

function fbAdd(chain, modelName) {
  if (!modelName || typeof modelName !== 'string') return chain.slice();
  if (chain.includes(modelName)) return chain.slice();
  return [...chain, modelName];
}

function fbRemove(chain, idx) {
  if (!Array.isArray(chain)) return [];
  if (!Number.isInteger(idx) || idx < 0 || idx >= chain.length) return chain.slice();
  const next = chain.slice();
  next.splice(idx, 1);
  return next;
}

function fbMove(chain, from, to) {
  if (!Array.isArray(chain)) return [];
  if (!Number.isInteger(from) || from < 0 || from >= chain.length) return chain.slice();
  if (!Number.isInteger(to) || to < 0 || to >= chain.length) return chain.slice();
  if (from === to) return chain.slice();
  const next = chain.slice();
  const [item] = next.splice(from, 1);
  next.splice(to, 0, item);
  return next;
}

function fbIsCloud(modelName) {
  // Match `:cloud` (qwen3-coder-next:cloud, kimi-k2.5:cloud) and the
  // `-cloud` variant some Ollama models use (qwen3-vl:235b-cloud).
  return typeof modelName === 'string' && /[:-]cloud(\b|$)/i.test(modelName);
}

function isCloudModel(m) {
  return fbIsCloud(m?.name);
}

// ── DOM rendering layer ──────────────────────────────────────

function renderFallbackUI(allModels, chain) {
  setFallbackAvailable(allModels || []);
  setFallbackChain(chain || []);
  _renderAvailable();
  _renderChain();
}

function _renderAvailable() {
  const root = $('#fallback-available');
  if (!root) return;
  const state = getFallbackState();
  root.innerHTML = '';
  for (const m of state.available) {
    const li = document.createElement('li');
    li.className = 'fallback-item';
    const name = document.createElement('span');
    name.className = 'fallback-item-name';
    name.textContent = m.name;
    name.title = m.name;
    li.appendChild(name);
    if (isCloudModel(m)) {
      const cloud = document.createElement('span');
      cloud.className = 'fallback-item-cloud';
      cloud.textContent = '☁';
      cloud.title = 'Cloud model — may need Ollama Pro subscription';
      li.appendChild(cloud);
    }
    const backend = document.createElement('span');
    backend.className = 'fallback-item-backend';
    backend.textContent = m.backend || '?';
    li.appendChild(backend);
    const btn = document.createElement('button');
    btn.className = 'fallback-btn fallback-btn-add';
    btn.type = 'button';
    btn.textContent = '+ Add';
    btn.title = 'Add to fallback chain';
    const inChain = state.chain.includes(m.name);
    btn.disabled = inChain;
    if (inChain) btn.title = 'Already in chain';
    btn.addEventListener('click', () => _addToChain(m.name));
    li.appendChild(btn);
    root.appendChild(li);
  }
}

function _renderChain() {
  const root = $('#fallback-chain');
  const empty = $('#fallback-chain-empty');
  if (!root) return;
  const state = getFallbackState();
  root.innerHTML = '';
  if (state.chain.length === 0) {
    if (empty) empty.classList.remove('hidden');
    return;
  }
  if (empty) empty.classList.add('hidden');
  state.chain.forEach((modelName, idx) => {
    const meta = state.available.find(m => m.name === modelName);
    const li = document.createElement('li');
    li.className = 'fallback-item';
    const pos = document.createElement('span');
    pos.className = 'fallback-item-pos';
    pos.textContent = String(idx + 1);
    li.appendChild(pos);
    const name = document.createElement('span');
    name.className = 'fallback-item-name';
    name.textContent = modelName;
    name.title = modelName;
    li.appendChild(name);
    if (meta && isCloudModel(meta)) {
      const cloud = document.createElement('span');
      cloud.className = 'fallback-item-cloud';
      cloud.textContent = '☁';
      cloud.title = 'Cloud model';
      li.appendChild(cloud);
    }
    const up = document.createElement('button');
    up.className = 'fallback-btn'; up.type = 'button'; up.textContent = '↑';
    up.title = 'Move up'; up.disabled = (idx === 0);
    up.addEventListener('click', () => _moveInChain(idx, idx - 1));
    li.appendChild(up);
    const down = document.createElement('button');
    down.className = 'fallback-btn'; down.type = 'button'; down.textContent = '↓';
    down.title = 'Move down'; down.disabled = (idx === state.chain.length - 1);
    down.addEventListener('click', () => _moveInChain(idx, idx + 1));
    li.appendChild(down);
    const rm = document.createElement('button');
    rm.className = 'fallback-btn fallback-btn-remove'; rm.type = 'button';
    rm.textContent = '×'; rm.title = 'Remove from chain';
    rm.addEventListener('click', () => _removeFromChain(idx));
    li.appendChild(rm);
    root.appendChild(li);
  });
}

function _addToChain(modelName) {
  const state = getFallbackState();
  const next = fbAdd(state.chain, modelName);
  if (next === state.chain) return;
  setFallbackChain(next);
  _renderAvailable();
  _renderChain();
}

function _removeFromChain(idx) {
  const state = getFallbackState();
  setFallbackChain(fbRemove(state.chain, idx));
  _renderAvailable();
  _renderChain();
}

function _moveInChain(from, to) {
  const state = getFallbackState();
  setFallbackChain(fbMove(state.chain, from, to));
  _renderChain();
}

module.exports = {
  // Pure logic helpers
  fbAdd, fbRemove, fbMove, fbIsCloud, isCloudModel,
  // DOM rendering layer
  renderFallbackUI,
  _renderAvailable, _renderChain,
  _addToChain, _removeFromChain, _moveInChain,
};
