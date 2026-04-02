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
const { addMessage, appendToStream, finishStream, sendMessage, stopGeneration } = require('./modules/chat');
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
    const health = await window.genesis.invoke('agent:get-health');
    const goals = await window.genesis.invoke('agent:get-goals');
    const activeGoals = (goals || []).filter(g => g.status === 'active');
    const memFacts = health.memory?.facts || 0;
    const thoughts = health.idleMind?.thoughtCount || 0;
    const lines = [];
    if (memFacts === 0 && thoughts === 0) {
      lines.push(t('welcome.first'));
    } else {
      const userName = health.userName;
      lines.push(userName ? t('welcome.returning', { name: userName }) : t('welcome.returning_anon'));
      if (activeGoals.length > 0) {
        lines.push(''); lines.push('**' + t('welcome.working_on') + '**');
        for (const g of activeGoals.slice(0, 3)) {
          const progress = g.steps?.length > 0 ? ` (${g.currentStep || 0}/${g.steps.length})` : '';
          lines.push(`- ${g.description}${progress}`);
        }
      }
      if (thoughts > 0) {
        lines.push(''); lines.push(t('welcome.thoughts', { thoughts, facts: memFacts }));
      }
    }
    addMessage('agent', lines.join('\n'));
  } catch (err) { addMessage('agent', "I'm Genesis. Ask me anything."); }
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
    if (health && health.model && !agentReady) {
      onAgentReady({ state: 'ready', model: health.model.active });
    }
  }).catch(e => console.warn('[UI] Health check failed:', e.message));

  setTimeout(() => {
    if (!agentReady) {
      console.debug('[UI] Fallback connection...');
      loadModels().then(() => { agentReady = true; }).catch(err => console.debug('[UI] Fallback load failed:', err.message));
    }
  }, 5000);

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
