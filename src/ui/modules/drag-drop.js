'use strict';

// ============================================================
// GENESIS — drag-drop.js (v7.7.2)
//
// File drag-and-drop import for the chat panel — extracted from
// settings.js (was Cluster I subset, lines 1012-1039 in v7.7.1).
// Not part of the settings domain, only lived there historically.
//
// Wires #chat-panel to accept dropped files and route them through
// the agent:import-file IPC. Includes the v7.7.0 not-ready guard:
// drops during boot show a warning toast instead of failing
// silently or emitting confusing IPC errors.
// ============================================================

const { t } = require('./i18n');
const { addMessage } = require('./chat');
const { showToast } = require('./statusbar');
const { isAgentReady } = require('./agent-state');

const $ = (sel) => document.querySelector(sel);

function setupDragDrop() {
  const chatPanel = $('#chat-panel');
  if (!chatPanel) return;

  chatPanel.addEventListener('dragover', (e) => { e.preventDefault(); chatPanel.classList.add('drag-over'); });
  chatPanel.addEventListener('dragleave', () => { chatPanel.classList.remove('drag-over'); });
  chatPanel.addEventListener('drop', async (e) => {
    e.preventDefault();
    chatPanel.classList.remove('drag-over');
    // v7.7.0: not-ready guard — agent:import-file IPC needs backend ready.
    if (!isAgentReady()) {
      showToast(t('ui.still_starting'), 'warning');
      return;
    }
    const files = e.dataTransfer?.files;
    if (!files || files.length === 0) return;
    for (const file of files) {
      try {
        const result = await window.genesis.invoke('agent:import-file', file.path);
        if (result?.ok !== false) {
          showToast(t('ui.file_imported', { file: file.name }), 'success');
          addMessage('agent', `📎 ${t('ui.imported')}: **${file.name}**`, 'file');
        }
      } catch (err) { showToast(`Import error: ${err.message}`, 'error'); }
    }
  });
}

module.exports = {
  setupDragDrop,
};
