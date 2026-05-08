'use strict';

// ============================================================
// GENESIS — settings-mcp-ui.js (v7.7.2)
//
// MCP servers UI for the settings modal. Extracted from
// settings.js (was Cluster E, lines 549-613 in the v7.7.1 form).
//
// Responsibilities:
//   - _renderMcpServers(servers): rebuild the visible list of
//     configured MCP servers (with remove buttons).
//   - _wireMcpAddButton(): one-time wiring of the "Add" button
//     that appends a new server (name+url) to the state.
//
// State sharing: _mcpServersState used to be a module-level `let`
// in settings.js; now lives in settings-state.js with explicit
// API. This module reads via getMcpServersState() and mutates via
// setMcpServers() / addMcpServer() / removeMcpServer().
// ============================================================

const { t } = require('./i18n');
const { showToast } = require('./statusbar');
const {
  getMcpServersState,
  setMcpServers,
  addMcpServer,
  removeMcpServer,
} = require('./settings-state');

const $ = (sel) => document.querySelector(sel);

function _renderMcpServers(servers) {
  setMcpServers(servers);
  const root = $('#mcp-servers-list');
  if (!root) return;
  const state = getMcpServersState();
  root.innerHTML = '';
  if (state.servers.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'mcp-server-list-empty';
    empty.textContent = t('settings.mcp.empty');
    root.appendChild(empty);
    return;
  }
  state.servers.forEach((srv, idx) => {
    const row = document.createElement('div');
    row.className = 'mcp-server-row';
    const nameEl = document.createElement('span');
    nameEl.className = 'mcp-server-name';
    nameEl.textContent = srv.name || '(unnamed)';
    const urlEl = document.createElement('span');
    urlEl.className = 'mcp-server-url';
    urlEl.textContent = srv.url || '';
    urlEl.title = srv.url || '';
    const removeBtn = document.createElement('button');
    removeBtn.className = 'mcp-server-remove';
    removeBtn.type = 'button';
    removeBtn.textContent = t('ui.remove');
    removeBtn.addEventListener('click', () => {
      removeMcpServer(idx);
      _renderMcpServers(getMcpServersState().servers);
    });
    row.appendChild(nameEl);
    row.appendChild(urlEl);
    row.appendChild(removeBtn);
    root.appendChild(row);
  });
}

// Wired in _wireSettingsTabs() via openSettings — bound once per modal open.
function _wireMcpAddButton() {
  const btn = $('#btn-mcp-server-add');
  if (!btn) return;
  // Always re-translate the button label so language switch picks up
  btn.textContent = t('ui.add');
  if (btn._wired) return;
  btn._wired = true;
  btn.addEventListener('click', () => {
    const nameEl = $('#mcp-server-new-name');
    const urlEl = $('#mcp-server-new-url');
    const name = (nameEl?.value || '').trim();
    const url = (urlEl?.value || '').trim();
    if (!name) { showToast(t('settings.mcp.error_name_missing'), 'error'); return; }
    if (!url) { showToast(t('settings.mcp.error_url_missing'), 'error'); return; }
    const state = getMcpServersState();
    if (state.servers.some(s => s.name === name)) {
      const tpl = t('settings.mcp.error_exists');
      showToast(tpl.replace('{name}', name), 'error');
      return;
    }
    addMcpServer({ name, url });
    _renderMcpServers(getMcpServersState().servers);
    if (nameEl) nameEl.value = '';
    if (urlEl) urlEl.value = '';
  });
}

module.exports = {
  _renderMcpServers,
  _wireMcpAddButton,
};
