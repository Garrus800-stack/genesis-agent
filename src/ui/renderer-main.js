// ============================================================
// GENESIS UI — renderer-main.js (v3.8.0 — Modular Entry Point)
//
// Composes the 6 UI modules into a single entry point.
// Built with esbuild → dist/renderer.bundle.js
//
// Modules:
//   i18n.js      — Internationalization
//   chat.js      — Message handling, streaming, markdown
//   editor.js    — Monaco Editor integration
//   statusbar.js — Status badge, toasts, health display
//   filetree.js  — File tree panel
//   settings.js  — Settings modal, drag-drop, goals, undo
// ============================================================

const { t, loadI18n } = require('./modules/i18n');
const { addMessage, startStreamingMessage, appendToStream, finishStream, sendMessage, stopGeneration } = require('./modules/chat');
const { initMonaco, setCurrentFile } = require('./modules/editor');
const { updateStatus, showToast, showHealth, showSelfModel } = require('./modules/statusbar');
const { loadFileTree } = require('./modules/filetree');
const { openSettings, closeSettings, saveSettings, showGoalTree, undoLastChange, setupDragDrop, autoResize } = require('./modules/settings');

const $ = (sel) => document.querySelector(sel);

let agentReady = false;

// ── Expose globals for onclick handlers in HTML ─────────
window.togglePanel = function(id) {
  const panel = document.getElementById(id);
  if (panel) panel.classList.toggle('hidden');
};
window.closeSettings = closeSettings;

// ── Model Selector ─────────────────────────────────────
async function loadModels() {
  const sel = $('#model-select');
  if (!sel) return;
  try {
    const models = await window.genesis.invoke('agent:list-models');
    if (!models || models.length === 0) {
      sel.innerHTML = '<option value="">' + t('ui.no_model') + '</option>';
      return;
    }
    // Get active model to mark it selected
    let active = null;
    try {
      const health = await window.genesis.invoke('agent:get-health');
      active = health?.model?.active;
    } catch (_e) { console.debug('[UI] Health check for active model failed:', _e.message); }

    sel.innerHTML = '';
    for (const m of models) {
      const opt = document.createElement('option');
      opt.value = m.name;
      opt.textContent = `${m.name} (${m.backend})`;
      if (m.name === active) opt.selected = true;
      sel.appendChild(opt);
    }
  } catch (err) {
    sel.innerHTML = '<option value="">⚠ Error</option>';
    console.debug('[UI] Model list:', err.message);
  }
}

// ── Boot Ready ─────────────────────────────────────────
async function onAgentReady(status) {
  agentReady = true;
  console.debug('[UI] Genesis ready');
  await loadI18n();
  loadModels();
  try {
    // v7.2.4: Use filesystem check for first-boot detection.
    // Health data was unreliable due to IPC timing — facts/episodes/KG could
    // all be 0 even after boot completed. The filesystem check reads .genesis/
    // directly and doesn't depend on any service being loaded.
    const bootCheck = await window.genesis.invoke('agent:is-first-boot');
    const isFirstBoot = bootCheck?.firstBoot !== false;
    console.debug('[UI] First boot check:', JSON.stringify(bootCheck));

    if (isFirstBoot) {
      // First boot: onboarding template as system message.
      addMessage('system', t('welcome.first'));
    }
    // Returning boot: empty. Genesis speaks when spoken to.
  } catch (err) {
    console.error('[UI] onAgentReady error:', err);
  }
}

// ── DOMContentLoaded ───────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  // v4.0.0: Global Error Boundary — catches unhandled errors and
  // promise rejections, displays user-facing toast instead of silent failure.
  // Also logs to console for debugging.
  const _errorBoundary = {
    _errorCount: 0,
    _maxToasts: 5,  // Don't flood the user with error toasts
    _suppressedSince: null,

    handle(error, context = 'unknown') {
      this._errorCount++;
      const msg = error?.message || String(error);
      console.error(`[ERROR-BOUNDARY] ${context}:`, error);

      if (this._errorCount <= this._maxToasts) {
        try { showToast(`Error: ${msg.slice(0, 120)}`, 'error'); } catch { /* toast itself broken */ }
      } else if (!this._suppressedSince) {
        this._suppressedSince = Date.now();
        try { showToast('Multiple errors detected — check console (F12)', 'error'); } catch { /* ok */ }
      }
    },

    getStats() {
      return { totalErrors: this._errorCount, suppressedSince: this._suppressedSince };
    },
  };

  window.addEventListener('error', (event) => {
    _errorBoundary.handle(event.error || event.message, 'window.onerror');
  });

  window.addEventListener('unhandledrejection', (event) => {
    _errorBoundary.handle(event.reason, 'unhandledrejection');
    event.preventDefault(); // Prevent default console error
  });

  // Expose for debugging
  window.__errorBoundary = _errorBoundary;

  initMonaco();
  setupDragDrop();

  const chatInput = $('#chat-input');
  chatInput.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); } });
  chatInput.addEventListener('input', () => autoResize(chatInput));

  $('#btn-send').addEventListener('click', sendMessage);
  $('#btn-stop').addEventListener('click', stopGeneration);
  $('#btn-toggle-editor').addEventListener('click', () => window.togglePanel('editor-panel'));
  $('#btn-toggle-tree').addEventListener('click', () => { window.togglePanel('file-tree-panel'); loadFileTree(); });
  $('#btn-save').addEventListener('click', () => { const { saveCurrentFile } = require('./modules/editor'); saveCurrentFile(); });
  $('#btn-run-sandbox').addEventListener('click', () => { const { runInSandbox } = require('./modules/editor'); runInSandbox(); });
  $('#btn-health').addEventListener('click', showHealth);
  $('#btn-self-model').addEventListener('click', showSelfModel);
  $('#btn-goals').addEventListener('click', () => { window.togglePanel('goals-panel'); showGoalTree(); });
  $('#btn-settings').addEventListener('click', openSettings);
  $('#btn-undo').addEventListener('click', undoLastChange);

  // v4.0.0: Migrated from inline onclick to addEventListener (CSP compliance).
  // Panel close buttons
  $('#btn-close-filetree').addEventListener('click', () => window.togglePanel('file-tree-panel'));
  $('#btn-close-goals').addEventListener('click', () => window.togglePanel('goals-panel'));
  $('#btn-close-editor').addEventListener('click', () => window.togglePanel('editor-panel'));
  $('#btn-close-sandbox-output').addEventListener('click', () => $('#sandbox-output').classList.add('hidden'));
  // Settings modal
  $('#settings-backdrop').addEventListener('click', closeSettings);
  $('#btn-close-settings').addEventListener('click', closeSettings);
  $('#btn-settings-cancel').addEventListener('click', closeSettings);
  $('#btn-settings-save').addEventListener('click', saveSettings);

  // Language selector
  $('#lang-select').addEventListener('change', async function() {
    if (!agentReady) return;
    try {
      await window.genesis.invoke('agent:set-lang', this.value);
      await loadI18n();
      showToast('Language: ' + this.value.toUpperCase(), 'success');
    } catch (err) { console.debug('[UI] Lang switch error:', err.message); }
  });

  // Model selector
  $('#model-select').addEventListener('change', async function () {
    if (!agentReady || !this.value) return;
    try {
      await window.genesis.invoke('agent:switch-model', this.value);
      showToast(t('ui.model_switched', { model: this.value }), 'success');
      updateStatus({ state: 'ready', model: this.value });
    } catch (err) { showToast(t('ui.switch_failed'), 'error'); }
  });

  // Global undo
  document.addEventListener('keydown', (e) => {
    const { getEditor } = require('./modules/editor');
    if (e.ctrlKey && e.key === 'z' && !e.shiftKey && document.activeElement?.id !== 'chat-input' && !getEditor()?.hasTextFocus()) {
      e.preventDefault(); undoLastChange();
    }
  });

  // IPC event listeners
  window.genesis.on('agent:stream-chunk', appendToStream);
  window.genesis.on('agent:stream-done', finishStream);

  window.genesis.on('agent:open-in-editor', (data) => {
    if (!data || !data.content) return;
    const editorPanel = $('#editor-panel');
    if (editorPanel.classList.contains('hidden')) window.togglePanel('editor-panel');
    const { getEditor } = require('./modules/editor');
    const editor = getEditor();
    if (editor && typeof monaco !== 'undefined') {
      editor.setModel(monaco.editor.createModel(data.content, data.language || 'plaintext'));
    }
    setCurrentFile(data.filename || 'genesis_output.txt');
    $('#editor-filename').textContent = data.filename || 'genesis_output.txt';
    showToast(t('ui.code_in_editor', { file: data.filename || 'output' }), 'success');
  });

  window.genesis.on('agent:status-update', (status) => {
    updateStatus(status);
    if (status.state === 'ready' && !agentReady) onAgentReady(status);
  });

  // Proactive readiness check
  window.genesis.invoke('agent:get-health').then((health) => {
    if (health && !agentReady) {
      onAgentReady({ state: 'ready', model: health.model?.active || null });
    }
  }).catch(e => console.warn('[UI] Health check failed:', e.message));

  // v7.1.1: Aggressive retries — 1s, 2s, 3s, 5s, 10s
  // The ready status IPC can arrive before the renderer has registered its listener.
  // Also accept health response even without model (agent is ready, model may still be loading).
  for (const d of [1000, 2000, 3000, 5000, 10000]) {
    setTimeout(async () => {
      if (agentReady) return;
      try {
        const h = await window.genesis.invoke('agent:get-health');
        if (h) onAgentReady({ state: 'ready', model: h.model?.active || null });
      } catch (_e) { console.debug('[UI] boot retry failed:', _e.message); }
    }, d);
  }

  // v5.1.0: Reload models when settings are saved (API keys may unlock new backends)
  window.addEventListener('genesis:reload-models', () => loadModels().catch(e => console.warn('[UI] Model reload failed:', e.message)));

  // v5.1.0: Second retry — models might not be detected until Ollama responds
  setTimeout(() => {
    const sel = $('#model-select');
    if (sel && (sel.options.length <= 1 || sel.options[0]?.value === '')) {
      console.debug('[UI] Model retry...');
      loadModels().catch(e => console.warn('[UI] Model load failed:', e.message));
    }
  }, 10000);
});
