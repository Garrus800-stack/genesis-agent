'use strict';

// ============================================================
// GENESIS — test/helpers/settings-source.js (v7.7.2)
//
// Helper for legacy text-grep tests that were written against the
// monolithic settings.js (1073 LOC) before the v7.7.2 split. The
// split moved most of the logic into 6 sub-modules + 2 separate
// modules (goal-management, drag-drop) — but the tests' text-grep
// approach is still valid as a "ratchet" pattern, just against
// the union of files instead of one.
//
// Returns a single concatenated string of all settings-related
// module sources. Future structural changes that keep the patterns
// somewhere in the family will keep these tests green; only
// removing a feature (e.g. dropping JSON-editor support) breaks
// them, which is the intended ratchet behaviour.
// ============================================================

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');

// All files that combined make up the "settings" surface area as
// of v7.7.2. Order is stable to make debug dumps reproducible.
const FAMILY = [
  'src/ui/modules/settings.js',                // facade
  'src/ui/modules/settings-state.js',          // shared state
  'src/ui/modules/settings-fields.js',         // generic field helpers
  'src/ui/modules/settings-loadsave.js',       // openSettings + saveSettings
  'src/ui/modules/settings-json-editor.js',    // JSON editor
  'src/ui/modules/settings-fallback-ui.js',    // fallback chain UI
  'src/ui/modules/settings-mcp-ui.js',         // MCP servers UI
  'src/ui/modules/goal-management.js',         // showGoalTree + undoLastChange (extracted)
  'src/ui/modules/drag-drop.js',               // setupDragDrop (extracted)
];

function readSettingsFamily() {
  return FAMILY
    .map(rel => {
      const abs = path.join(ROOT, rel);
      return fs.existsSync(abs) ? fs.readFileSync(abs, 'utf8') : '';
    })
    .join('\n// ── boundary ──\n');
}

module.exports = {
  readSettingsFamily,
  FAMILY,
};
