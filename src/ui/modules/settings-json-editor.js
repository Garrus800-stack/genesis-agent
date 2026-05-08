'use strict';

// ============================================================
// GENESIS — settings-json-editor.js (v7.7.2)
//
// JSON power-mode editor for the settings modal. Extracted from
// settings.js (was Cluster B, lines 170-306 in the v7.7.1 form).
//
// Three responsibilities:
//   1. Load/display: _loadJsonEditor reads current settings via
//      IPC, masks SENSITIVE_PATHS (API keys, discovery tokens),
//      pretty-prints them into the textarea.
//   2. Validation: _validateJsonEditor parses the textarea on
//      input (debounced) and surfaces JSON syntax errors visibly.
//   3. Diff collection: _collectJsonEditorChanges parses the
//      textarea, compares dot-paths against current settings,
//      returns only the changed entries (skipping masked
//      sensitive fields so the literal "***MASKED***" string
//      never gets written back).
//
// SENSITIVE_PATHS is the canonical list of dot-paths whose values
// must never appear in the editor — they're set via the dedicated
// Modelle-Tab inputs only.
// ============================================================

const { t } = require('./i18n');

const $ = (sel) => document.querySelector(sel);

const SENSITIVE_PATHS = new Set([
  'models.anthropicApiKey',
  'models.openaiApiKey',
  'peer.discoveryToken',
]);

function _maskSensitiveInJson(obj) {
  // Deep clone, then walk and mask. Returns a new object — original untouched.
  const cloned = JSON.parse(JSON.stringify(obj));
  for (const dotPath of SENSITIVE_PATHS) {
    const parts = dotPath.split('.');
    let cur = cloned;
    for (let i = 0; i < parts.length - 1; i++) {
      if (!cur || typeof cur !== 'object') return cloned;
      cur = cur[parts[i]];
    }
    if (cur && typeof cur === 'object' && parts[parts.length - 1] in cur) {
      const val = cur[parts[parts.length - 1]];
      if (typeof val === 'string' && val.length > 0) {
        cur[parts[parts.length - 1]] = '***MASKED*** (set via Modelle-Tab)';
      }
    }
  }
  return cloned;
}

async function _loadJsonEditor() {
  const ta = $('#json-editor-textarea');
  const status = $('#json-editor-status');
  if (!ta) return;
  try {
    const settings = await window.genesis.invoke('agent:get-settings');
    const masked = _maskSensitiveInJson(settings);
    ta.value = JSON.stringify(masked, null, 2);
    ta.classList.remove('invalid');
    if (status) {
      status.textContent = t('settings.json.status_loaded');
      status.className = 'json-editor-status valid';
    }
  } catch (err) {
    if (status) {
      status.textContent = t('settings.json.status_load_error') + ': ' + err.message;
      status.className = 'json-editor-status invalid';
    }
  }
}

function _validateJsonEditor() {
  const ta = $('#json-editor-textarea');
  const status = $('#json-editor-status');
  if (!ta || !status) return null;
  try {
    const parsed = JSON.parse(ta.value);
    ta.classList.remove('invalid');
    status.textContent = t('settings.json.status_valid');
    status.className = 'json-editor-status valid';
    return parsed;
  } catch (err) {
    ta.classList.add('invalid');
    status.textContent = t('settings.json.status_invalid') + ': ' + err.message;
    status.className = 'json-editor-status invalid';
    return null;
  }
}

function _wireJsonEditorButtons() {
  const validateBtn = $('#btn-json-validate');
  if (validateBtn && !validateBtn._wired) {
    validateBtn._wired = true;
    validateBtn.addEventListener('click', () => _validateJsonEditor());
  }
  const reloadBtn = $('#btn-json-reload');
  if (reloadBtn && !reloadBtn._wired) {
    reloadBtn._wired = true;
    reloadBtn.addEventListener('click', () => _loadJsonEditor());
  }
  // Live-validate on input
  const ta = $('#json-editor-textarea');
  if (ta && !ta._wired) {
    ta._wired = true;
    let timer = null;
    ta.addEventListener('input', () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => _validateJsonEditor(), 400);
    });
  }
}

/**
 * Build a flat "diff" of dot-path entries between user-edited JSON and
 * current settings. Used by saveSettings to apply only what the user
 * actually changed via the JSON-Editor (without overwriting masked
 * sensitive fields).
 *
 * Returns array of [dotPath, value] pairs to send via setBatch.
 */
async function _collectJsonEditorChanges() {
  const ta = $('#json-editor-textarea');
  if (!ta || !ta.value.trim()) return [];
  let parsed;
  try { parsed = JSON.parse(ta.value); } catch (_e) { return null; /* invalid */ }
  let current;
  try { current = await window.genesis.invoke('agent:get-settings'); } catch (_e) { return []; }

  const changes = [];
  function walk(obj, prefix) {
    if (obj == null || typeof obj !== 'object') return;
    for (const key of Object.keys(obj)) {
      const dotPath = prefix ? `${prefix}.${key}` : key;
      const val = obj[key];
      // Skip masked sensitive fields — never write the literal "***MASKED***" string back
      if (SENSITIVE_PATHS.has(dotPath) && typeof val === 'string' && val.startsWith('***MASKED***')) continue;
      // Recurse into plain objects (not arrays)
      if (val !== null && typeof val === 'object' && !Array.isArray(val)) {
        walk(val, dotPath);
        continue;
      }
      // Compare to current value via dot-path
      const cur = _getDotPath(current, dotPath);
      if (JSON.stringify(cur) !== JSON.stringify(val)) {
        changes.push([dotPath, val]);
      }
    }
  }
  walk(parsed, '');
  return changes;
}

function _getDotPath(obj, dotPath) {
  const parts = dotPath.split('.');
  let cur = obj;
  for (const p of parts) {
    if (cur == null) return undefined;
    cur = cur[p];
  }
  return cur;
}

module.exports = {
  SENSITIVE_PATHS,
  _maskSensitiveInJson,
  _loadJsonEditor,
  _validateJsonEditor,
  _wireJsonEditorButtons,
  _collectJsonEditorChanges,
  _getDotPath,
};
