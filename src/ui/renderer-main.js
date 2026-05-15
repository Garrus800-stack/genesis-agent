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
const { addMessage, startStreamingMessage, appendToStream, finishStream, sendMessage, stopGeneration, getStreamingState, autoResize } = require('./modules/chat');
const { initMonaco, setCurrentFile } = require('./modules/editor');
const { updateStatus, refreshStatusI18n, showToast, showHealth, showSelfModel } = require('./modules/statusbar');
const { loadFileTree } = require('./modules/filetree');
const { openSettings, closeSettings, saveSettings, refreshSettingsI18n } = require('./modules/settings');
const { showGoalTree, undoLastChange } = require('./modules/goal-management');
const { setupDragDrop } = require('./modules/drag-drop');
const { setAgentReady } = require('./modules/agent-state');

const $ = (sel) => document.querySelector(sel);

let agentReady = false;

// ── Expose globals for onclick handlers in HTML ─────────
window.togglePanel = function(id) {
  const panel = document.getElementById(id);
  if (panel) panel.classList.toggle('hidden');
};
window.closeSettings = closeSettings;

// ── Model Selector ─────────────────────────────────────
// v7.8.5: when ModelBridge has failed over, the dropdown shows the
// model that actually answered — same slot the preferred model
// normally occupies. Switching to another model works as before
// (the `change` listener calls agent:switch-model). Programmatic
// .value assignment here does not fire `change`, so this display
// update never accidentally rewrites the user's preferred setting.
async function refreshEffectiveModelDisplay() {
  const select = document.querySelector('#model-select');
  if (!select) return;
  let health;
  try { health = await window.genesis.invoke('agent:get-health'); }
  catch (_e) { return; }
  const m = health?.model;
  if (!m) return;
  const target = (m.failoverReason && m.effective && m.effective !== m.active)
    ? m.effective
    : m.active;
  if (!target) return;
  // Silent no-op if the target is not among the dropdown options.
  if (!Array.from(select.options).some(o => o.value === target)) return;
  if (select.value !== target) select.value = target;
}

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
  setAgentReady(true);  // v7.7.0: also signal shared module so chat/settings/statusbar guards see ready state
  console.debug('[UI] Genesis ready');
  await loadI18n();
  loadModels();
  // v7.8.5: after loadModels populates the options, sync the display
  // to whatever ModelBridge currently considers effective (in case the
  // user reopened the app while a failover is still active).
  setTimeout(() => refreshEffectiveModelDisplay().catch(() => {}), 500);
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

// ── Bridge Readiness ───────────────────────────────────
// v7.5.3: window.genesis comes from the preload script via contextBridge.
// On Windows with bundled-CJS preload, window.genesis is set synchronously
// before DOMContentLoaded — no wait needed. On Linux with ESM preload (.mjs),
// the preload script loads asynchronously. DOMContentLoaded can fire BEFORE
// the bridge is established, causing `Cannot read properties of undefined
// (reading 'on')` when listeners are wired.
//
// This helper polls for window.genesis every 16ms (one frame at 60fps) for
// up to 5 seconds. In practice the bridge appears within 50–200ms on Linux.
// If it never appears, we surface a real error rather than crashing silently.
function waitForBridge(timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    if (window.genesis && typeof window.genesis.on === 'function') {
      resolve();
      return;
    }
    const start = Date.now();
    const tick = () => {
      if (window.genesis && typeof window.genesis.on === 'function') {
        resolve();
        return;
      }
      if (Date.now() - start > timeoutMs) {
        reject(new Error(
          'Preload bridge did not initialize within ' + timeoutMs + 'ms. ' +
          'window.genesis is undefined. This usually indicates a preload ' +
          'script load failure — check the main process console for errors.'
        ));
        return;
      }
      setTimeout(tick, 16);
    };
    setTimeout(tick, 16);
  });
}

// ── DOMContentLoaded ───────────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {
  // v7.5.3: Wait for preload bridge before any window.genesis.* call.
  // Without this, Linux ESM-preload race produces "Cannot read properties
  // of undefined (reading 'on')" toast and a stuck BOOTING state.
  try {
    await waitForBridge(5000);
  } catch (err) {
    document.body.innerHTML =
      '<div style="color:#ff6b6b;padding:2em;font-family:monospace;line-height:1.5;">' +
      '<h2>⚠ Preload bridge failed to initialize</h2>' +
      '<p>' + (err.message || String(err)) + '</p>' +
      '<p>The preload script did not establish window.genesis within the ' +
      'timeout window. Check the terminal output of <code>npm start</code> ' +
      'for preload errors.</p>' +
      '</div>';
    return;
  }

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
      // v7.5.7-fix Phase 3 Etappe 7: re-render JS-generated UI text
      // (default-hints, MCP add-button, list empty-state) so the
      // language change shows up in already-decorated elements.
      try { refreshSettingsI18n(); }
      catch (e) { console.warn('[UI] refreshSettingsI18n failed:', e.message); }
      // v7.5.7-fix Phase 3 Etappe 8: re-render the live status-badge
      // label with the new language (without it the badge snaps back
      // to whatever data-i18n="ui.booting" resolves to).
      try { refreshStatusI18n(); }
      catch (e) { console.warn('[UI] refreshStatusI18n failed:', e.message); }
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
  // v7.8.5: after every stream, refresh the model dropdown display so
  // the user sees the model that actually answered. Programmatic
  // .value assignment does NOT fire `change`, so the user's preferred
  // setting is not touched.
  window.genesis.on('agent:stream-done', () => {
    finishStream();
    refreshEffectiveModelDisplay().catch(() => { /* best-effort */ });
  });

  // v7.4.5.fix #23: Goal results in chat. When a goal completes via
  // GoalDriver auto-pickup (boot-pickup, periodic scan) — NOT via the
  // chat-triggered ChatOrchestrator → AgentLoop path which streams
  // its own response — the result was being silently dropped. AgentLoop
  // emits 'agent-loop:complete' with the verification summary; AgentCoreWire
  // bridges it to 'agent:loop-progress' {phase, success, summary, title}.
  // We listen here and append the result as an assistant message,
  // BUT only when no stream is currently active (otherwise the
  // chat-trigger path would double-render).
  let _lastShownGoalAt = 0;
  window.genesis.on('agent:loop-progress', (data) => {
    if (!data || data.phase !== 'complete') return;
    const { isStreaming } = getStreamingState();
    if (isStreaming) return; // chat-trigger path handles its own render
    // Dedupe: a single goal completion can fire the bridge twice if
    // both the stack-completion and the verifier-summary fire close
    // together. Suppress duplicates within 500ms.
    const now = Date.now();
    if (now - _lastShownGoalAt < 500) return;
    _lastShownGoalAt = now;

    const title = data.title || 'Goal';
    const summary = (data.summary || '').trim();
    const success = data.success !== false;
    const intent = success ? 'goal-complete' : 'goal-failed';
    const icon = success ? '✅' : '❌';
    const body = summary
      ? `${icon} **${title}**\n\n${summary}`
      : `${icon} **${title}** ${success ? 'abgeschlossen' : 'fehlgeschlagen'}`;
    try {
      addMessage('agent', body, intent);
    } catch (err) {
      console.warn('[UI] Failed to render goal result:', err.message);
    }
  });

  // v7.4.7: System messages from runtime toggles (Daemon/IdleMind/SelfMod
  // changed in Settings). AgentCoreWire emits 'chat:system-message' on the
  // bus which is bridged to this IPC channel. Rendered as an inline-system
  // message so the user gets immediate feedback that the toggle worked.
  window.genesis.on('agent:chat-system-message', (data) => {
    if (!data || !data.text) return;
    try {
      addMessage('agent', data.text, 'system');
    } catch (err) {
      console.warn('[UI] Failed to render system message:', err.message);
    }
  });

  // v7.7.9 Phase 2: ProactiveSelfExpression appended a self-initiated
  // message to chat history. Render with self-initiated styling (small
  // dot before the timestamp + tooltip naming the kind/score/sourceRef).
  // No notification, no popup — Genesis's own messages enter the chat
  // alongside everything else, just visually marked so the user can
  // tell a self-initiated message from a reply at a glance.
  window.genesis.on('genesis:self-message', (msg) => {
    if (!msg || typeof msg.content !== 'string' || msg.content.length === 0) return;
    try {
      addMessage('agent', msg.content, undefined, {
        initiatedBy: 'self',
        selfMeta: msg.selfMeta || null,
        timestamp: msg.timestamp || Date.now(),
      });
    } catch (err) {
      console.warn('[UI] Failed to render self-message:', err.message);
    }
  });

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

  // v7.5.1 (C-fix): GoalDriver fires 'ui:resume-prompt' via the bus, AgentCoreWire
  // bridges it to this IPC channel. Render as an inline system message so the
  // user sees that a paused goal needs a decision (resume / discard).
  // Schema: { goalId, title?, currentStep?, totalSteps?, lastUpdated?, reason? }
  window.genesis.on('ui:resume-prompt', (data) => {
    if (!data || !data.goalId) return;
    try {
      const title = data.title || data.goalId;
      const progress = (data.currentStep != null && data.totalSteps != null)
        ? ` (Step ${data.currentStep}/${data.totalSteps})`
        : '';
      const reason = data.reason ? ` — ${data.reason}` : '';
      addMessage('agent', `🟡 Goal "${title}"${progress} is paused and awaiting decision${reason}. Use /goal resume ${data.goalId} or /goal discard ${data.goalId}.`, 'system');
    } catch (err) {
      console.warn('[UI] Failed to render resume-prompt:', err.message);
    }
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
