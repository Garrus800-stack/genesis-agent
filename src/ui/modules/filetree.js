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
      item.textContent = `${file.isDir ? '📁' : '📄'} ${file.path || file.name || file}`;
      item.addEventListener('click', () => {
        const { openFile } = require('./editor');
        if (!file.isDir) openFile(file.path || file.name || file);
      });
      treeEl.appendChild(item);
    }
  } catch (err) { console.warn('[FILETREE] Load failed:', err.message); }
}

module.exports = { loadFileTree };
