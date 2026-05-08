'use strict';

// ============================================================
// GENESIS — settings-state.js (v7.7.2)
//
// Shared module-level state for the settings UI. Replaces the
// implicit `let _fallbackState` and `let _mcpServersState` that
// lived as module-scope variables in the old monolithic
// settings.js. Explicit getter/setter API makes state-mutation
// flow visible across module boundaries (load/save, fallback-ui,
// mcp-ui all read/write the same state).
//
// Pattern: module-singleton state, persisted only via require()
// cache. Callers must use the exported API — never direct mutation
// of the underlying objects (which are returned by reference for
// read efficiency, but should be treated as opaque).
// ============================================================

let _fallbackState = { available: [], chain: [], loaded: false };
let _mcpServersState = { servers: [] };

// ── Fallback chain state ─────────────────────────────────────

function getFallbackState() {
  return _fallbackState;
}

function setFallbackChain(chain) {
  _fallbackState.chain = Array.isArray(chain) ? [...chain] : [];
}

function setFallbackAvailable(models) {
  _fallbackState.available = Array.isArray(models) ? models : [];
}

function setFallbackLoaded(v) {
  _fallbackState.loaded = !!v;
}

function resetFallbackState() {
  _fallbackState = { available: [], chain: [], loaded: false };
}

// ── MCP servers state ────────────────────────────────────────

function getMcpServersState() {
  return _mcpServersState;
}

function setMcpServers(servers) {
  _mcpServersState.servers = Array.isArray(servers) ? servers.map(s => ({ ...s })) : [];
}

function addMcpServer(server) {
  _mcpServersState.servers.push(server);
}

function removeMcpServer(idx) {
  if (idx >= 0 && idx < _mcpServersState.servers.length) {
    _mcpServersState.servers.splice(idx, 1);
  }
}

module.exports = {
  // Fallback state
  getFallbackState,
  setFallbackChain,
  setFallbackAvailable,
  setFallbackLoaded,
  resetFallbackState,
  // MCP state
  getMcpServersState,
  setMcpServers,
  addMcpServer,
  removeMcpServer,
};
