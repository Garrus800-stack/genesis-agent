'use strict';

// ============================================================
// GENESIS UI — modules/settings.js (v7.7.2)
//
// Settings module facade. Aggregates the cross-module pieces of
// the settings UI into a single import surface for callers.
//
// History: this file was a 1073-LOC monolith through v7.7.1. The
// v7.7.2 split extracted six concern-specific sub-modules:
//
//   settings-state.js        — Shared state (fallback, MCP)
//   settings-fields.js       — Generic field helpers
//   settings-loadsave.js     — openSettings + saveSettings
//   settings-json-editor.js  — JSON power-mode editor
//   settings-fallback-ui.js  — Fallback chain UI
//   settings-mcp-ui.js       — MCP servers UI
//
// Plus two non-settings concerns extracted to their own modules
// (they only lived here historically):
//
//   goal-management.js       — showGoalTree + undoLastChange
//   drag-drop.js             — setupDragDrop
//   chat.js (extended)       — autoResize moved to chat-input domain
//
// The single external caller (renderer-main.js) now imports each
// module directly. This facade keeps closeSettings + i18n refresh
// in one place — they're the only things genuinely "settings-only"
// that don't belong in a sub-module.
// ============================================================

const { t } = require('./i18n');
const { openSettings, saveSettings } = require('./settings-loadsave');
const { _refreshResetTitles } = require('./settings-fields');

const $ = (sel) => document.querySelector(sel);

function closeSettings() {
  $('#settings-modal').classList.add('hidden');
}

/**
 * v7.5.7-fix Phase 3 Etappe 6: refresh i18n strings inside the settings
 * modal after a language change. Re-decorates fields (default-hints,
 * reset button titles), re-translates dynamic button labels.
 *
 * Called by the language-change handler in renderer-main.js. The modal
 * may or may not be open; we touch only what's already in the DOM.
 */
function refreshSettingsI18n() {
  // 1. Reset button titles (already-decorated fields)
  _refreshResetTitles();
  // 2. MCP "Add" button label (re-translated on next openSettings,
  //    but if the modal is open right now, we'd want it updated).
  const mcpAdd = $('#btn-mcp-server-add');
  if (mcpAdd) mcpAdd.textContent = t('ui.add');
}

module.exports = {
  openSettings,
  closeSettings,
  saveSettings,
  refreshSettingsI18n,
};
