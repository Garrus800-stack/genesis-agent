// ============================================================
// GENESIS UI — modules/agent-state.js (v7.7.0)
//
// Shared agent-ready signal between UI modules. Set by renderer-main.js
// when onAgentReady fires; read by any handler that does an IPC call
// the user could trigger before the backend has finished booting
// (sendMessage, openSettings, showHealth, undoLastChange, etc.).
//
// Without this, user actions during the boot window (~1-3 seconds
// between DOMContentLoaded and agent:ready) silently fail or hang
// because the backend isn't listening yet. Legacy renderer.js had the
// same gating via Genesis.UI.boot.ready — the modular path lost it
// during the v7.6.0 split. This module restores feature parity with
// a single source of truth shared across all modules.
// ============================================================

let _ready = false;

function isAgentReady() {
  return _ready;
}

function setAgentReady(value) {
  _ready = !!value;
}

module.exports = { isAgentReady, setAgentReady };
