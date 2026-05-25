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

  // v7.9.10: use closest('.setting-group') as the stable anchor for both
  // cleanup and insertion. The pre-fix code used el.parentNode which is
  // unstable: the first call sees .setting-group (no row yet), then this
  // function moves el INTO a freshly-created .setting-input-row, so every
  // subsequent call (e.g. on language switch) sees .setting-input-row as
  // parent. Cleanup via querySelector on input-row found nothing, the
  // original hint stayed in setting-group in its original language, and
  // a new hint was appended to input-row — duplicates appeared, the old
  // one never refreshed. setting-group is structurally stable; closest()
  // returns it regardless of how many times decoration has run.
  const settingGroup = el.closest('.setting-group');
  if (!settingGroup) return;

  // Re-rendering the default-hint must always happen (language may have
  // changed). The structural decoration (row + reset button) only once.
  // Remove ALL stale default-hints anywhere under this setting-group via
  // querySelectorAll, not just the first — a missed cleanup from a prior
  // language switch could otherwise leave residuals behind.
  const ownHints = settingGroup.querySelectorAll('.setting-default-hint');
  ownHints.forEach(h => h.remove());

  if (!el._decorated) {
    el._decorated = true;

    if (meta.resetSafe) {
      const row = document.createElement('div');
      row.className = 'setting-input-row';
      // Use el's CURRENT parent for row insertion — at first-decoration
      // time this is still settingGroup (el hasn't moved yet).
      const insertParent = el.parentNode;
      insertParent.insertBefore(row, el);
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
    // Insert the hint into the stable settingGroup anchor, before any
    // descriptive .setting-hint (the long help text) if present.
    const existingHint = settingGroup.querySelector('.setting-hint');
    if (existingHint) settingGroup.insertBefore(hint, existingHint);
    else settingGroup.appendChild(hint);
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
