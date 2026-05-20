'use strict';

// ============================================================
// GENESIS — settings-fields.js (v7.7.2)
//
// Generic DOM helpers for the settings UI. Extracted from
// settings.js (was Cluster A, lines 16-167 in the v7.7.1 form).
//
// Three categories:
//   1. Value setters (_setNum, _setStr, _setBool) — safe DOM
//      assignment with null-guards.
//   2. Field decoration (_decorateField, _decorateAllFields,
//      _refreshResetTitles) — wraps inputs with reset button +
//      default-hint span, wires range-validation listeners.
//   3. Validation + reset (_validateAndMark, _validateAllFields,
//      _resetFieldToDefault) — per-field validation + restore
//      to FIELD_REGISTRY default.
//
// Used by: settings-loadsave.js (open + save call all three),
// and via re-export from settings.js for any external caller.
// ============================================================

const { t } = require('./i18n');
const { FIELD_REGISTRY, getFieldDefault, buildDefaultHint, validateField } = require('./settings-defaults');

const $ = (sel) => document.querySelector(sel);

// ── Safe value setters ───────────────────────────────────────

function _setNum(selector, value) {
  const el = $(selector);
  if (el && value !== undefined && value !== null) el.value = String(value);
}

function _setStr(selector, value) {
  const el = $(selector);
  if (el && value !== undefined && value !== null) el.value = String(value);
}

function _setBool(selector, value) {
  const el = $(selector);
  if (el && value !== undefined) el.value = String(!!value);
}

// ── Per-field Default-Hint + Reset + Validation ──────────────

/**
 * Decorate a field with: default-hint, reset-button, range-validation.
 * Idempotent — but the default-hint *is* re-rendered each call so that
 * language changes refresh the visible text.
 */
function _decorateField(id) {
  const el = document.getElementById(id);
  if (!el) return;
  const meta = getFieldDefault(id);
  if (!meta) return;

  const parent = el.parentNode;
  if (!parent) return;

  // Re-rendering the default-hint must always happen (language may have
  // changed). The structural decoration (row + reset button) only once.
  // Remove any existing OWN default-hint so we can rebuild it. The previous
  // code queried parent.parentNode (= the whole tab panel) and wiped every
  // hint in the tab, so only the last decorated field ever kept its hint.
  const ownHint = parent.querySelector('.setting-default-hint');
  if (ownHint) ownHint.remove();

  if (!el._decorated) {
    el._decorated = true;

    if (meta.resetSafe) {
      const row = document.createElement('div');
      row.className = 'setting-input-row';
      parent.insertBefore(row, el);
      row.appendChild(el);
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'setting-reset-btn';
      btn.title = t('ui.reset_to_default');
      btn.textContent = '↺';
      btn.addEventListener('click', () => _resetFieldToDefault(id));
      row.appendChild(btn);
    }

    if (meta.type === 'number') {
      el.addEventListener('input', () => _validateAndMark(id));
      el.addEventListener('change', () => _validateAndMark(id));
    }
  }

  const hint = buildDefaultHint(id, document, t);
  if (hint) {
    const existingHint = parent.querySelector('.setting-hint');
    if (existingHint) parent.insertBefore(hint, existingHint);
    else parent.appendChild(hint);
  }
}

/**
 * Refresh translatable attributes on previously-decorated elements
 * (reset button title, etc.) — called on language switch.
 */
function _refreshResetTitles() {
  document.querySelectorAll('.setting-reset-btn').forEach(btn => {
    btn.title = t('ui.reset_to_default');
  });
}

function _validateAndMark(id) {
  const el = document.getElementById(id);
  if (!el) return true;
  const meta = getFieldDefault(id);
  if (!meta || meta.type !== 'number') return true;

  const result = validateField(id, el.value, t);
  const parent = el.parentNode?.parentNode || el.parentNode;
  const oldErr = parent?.querySelector(`.setting-error[data-for="${id}"]`);
  if (oldErr) oldErr.remove();
  if (result.ok) {
    el.classList.remove('invalid');
    return true;
  }
  el.classList.add('invalid');
  const errEl = document.createElement('span');
  errEl.className = 'setting-error';
  errEl.dataset.for = id;
  const tpl = t('settings.validation.out_of_range_with_reason');
  errEl.textContent = (tpl && tpl !== 'settings.validation.out_of_range_with_reason')
    ? tpl.replace('{{reason}}', result.reason)
    : `Wert außerhalb gültigem Bereich (${result.reason}). Speichern blockiert.`;
  if (parent) parent.appendChild(errEl);
  return false;
}

function _resetFieldToDefault(id) {
  const el = document.getElementById(id);
  const meta = getFieldDefault(id);
  if (!el || !meta) return;
  if (meta.type === 'number') {
    let v = meta.default;
    el.value = v == null ? '' : String(v);
  } else if (meta.type === 'bool') {
    el.value = String(!!meta.default);
  } else if (meta.type === 'enum' || meta.type === 'string') {
    el.value = meta.default == null ? '' : String(meta.default);
  } else if (meta.type === 'list') {
    el.value = '';
  }
  el.classList.remove('invalid');
  const parent = el.parentNode?.parentNode || el.parentNode;
  const oldErr = parent?.querySelector(`.setting-error[data-for="${id}"]`);
  if (oldErr) oldErr.remove();
}

/** Decorate every registered field after the modal is opened. */
function _decorateAllFields() {
  for (const id of Object.keys(FIELD_REGISTRY)) _decorateField(id);
}

/** Validate ALL fields. Returns true if save can proceed. */
function _validateAllFields() {
  let allOk = true;
  for (const id of Object.keys(FIELD_REGISTRY)) {
    if (!_validateAndMark(id)) allOk = false;
  }
  return allOk;
}

module.exports = {
  $,
  _setNum, _setStr, _setBool,
  _decorateField, _decorateAllFields, _refreshResetTitles,
  _validateAndMark, _validateAllFields, _resetFieldToDefault,
};
