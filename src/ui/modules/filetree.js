// ============================================================
// GENESIS UI — modules/filetree.js
// File tree panel: load, render, click-to-open.
// ============================================================

const $ = (sel) => document.querySelector(sel);

async function loadFileTree() {
  try {
    const files = await window.genesis.invoke('agent:get-file-tree');
    const treeEl = $('#file-tree');
    if (!treeEl) return;
    treeEl.innerHTML = '';
    for (const file of files) {
      const item = document.createElement('div');
      item.className = 'file-tree-item' + (file.protected ? ' protected' : '');
      // v7.7.0 (A9): icon hierarchy — protected wins over module wins
      // over plain file. SelfModel.getFileTree() returns {path, lines,
      // protected, isModule} — there is no isDir field, so the previous
      // `file.isDir ? '📁' : '📄'` always rendered '📄' (dead branch).
      // Now: 🔒 protected files (hash-locked core), ◈ Genesis-internal
      // modules, 📄 everything else. Same icon hierarchy as legacy
      // renderer.js used (renderer.test.js Z.749-750 pinned this).
      let icon;
      if (file.protected) icon = '🔒';
      else if (file.isModule) icon = '◈';
      else icon = '📄';
      item.textContent = `${icon} ${file.path || file.name || file}`;
      item.addEventListener('click', () => {
        const { openFile } = require('./editor');
        openFile(file.path || file.name || file);
      });
      treeEl.appendChild(item);
    }
  } catch (err) { console.warn('[FILETREE] Load failed:', err.message); }
}

module.exports = { loadFileTree };
