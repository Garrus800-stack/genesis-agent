// ============================================================
// GENESIS — drag-drop.js
// File drag-and-drop for the chat panel.
// v7.9.44 r12: routes dropped files through the SINGLE shared
// attach path (chat.attachFile) — the same one the ◈ button uses.
// The old agent:import-file path (v7.7.0) is gone; there is now
// exactly ONE way a dropped file is handled, into the Archive.
// ============================================================

const { attachFile } = require('./chat');
const { showToast } = require('./statusbar');
const { t } = require('./i18n');
const { isAgentReady } = require('./agent-state');

const $ = (sel) => document.querySelector(sel);

function setupDragDrop() {
  const chatPanel = $('#chat-panel');
  if (!chatPanel) return;

  chatPanel.addEventListener('dragover', (e) => { e.preventDefault(); document.body.classList.add('drag-over'); });
  chatPanel.addEventListener('dragleave', (e) => { if (e.target === chatPanel) document.body.classList.remove('drag-over'); });
  chatPanel.addEventListener('drop', async (e) => {
    e.preventDefault();
    document.body.classList.remove('drag-over');
    if (!isAgentReady()) { showToast(t('ui.still_starting'), 'warning'); return; }
    const file = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
    if (file) await attachFile(file); // one shared path: ensure Archive → read → remember → chip; copy on send
  });
}

module.exports = {
  setupDragDrop,
};
