// ============================================================
// GENESIS UI — modules/settings.js
// Settings modal, drag-and-drop file import, goals panel, undo.
// ============================================================

const { t } = require('./i18n');
const { addMessage } = require('./chat');
const { showToast } = require('./statusbar');

const $ = (sel) => document.querySelector(sel);

async function openSettings() {
  try {
    const s = await window.genesis.invoke('agent:get-settings');
    // v5.1.0: Settings come as nested object { daemon: { enabled: true }, ... }
    if (s?.daemon?.enabled !== undefined) $('#set-daemon').value = String(s.daemon.enabled);
    if (s?.idleMind?.enabled !== undefined) $('#set-idle').value = String(s.idleMind.enabled);
    if (s?.security?.allowSelfModify !== undefined) $('#set-selfmod').value = String(s.security.allowSelfModify);

    // v7.4.7: New settings — Trust, Auto-Resume, MCP-Serve, Approval-Timeout
    if (s?.trust?.level !== undefined && $('#set-trust-level')) {
      $('#set-trust-level').value = String(s.trust.level);
    }
    if (s?.agency?.autoResumeGoals && $('#set-auto-resume')) {
      $('#set-auto-resume').value = s.agency.autoResumeGoals;
    }
    if (s?.mcp?.serve?.enabled !== undefined && $('#set-mcp-serve')) {
      $('#set-mcp-serve').value = String(s.mcp.serve.enabled);
    }
    if (s?.mcp?.serve?.port !== undefined && $('#set-mcp-port')) {
      $('#set-mcp-port').value = String(s.mcp.serve.port);
    }
    if (s?.timeouts?.approvalSec !== undefined && $('#set-approval-timeout')) {
      $('#set-approval-timeout').value = String(s.timeouts.approvalSec);
    }

    // v5.1.0: Show current model/backend info and populate preferred model selector
    try {
      const health = await window.genesis.invoke('agent:get-health');
      const info = $('#settings-model-info');
      if (info && health?.model) {
        info.textContent = `${health.model.active || 'none'} (${health.model.backend || '?'})`;
      }
      // Populate preferred model + role dropdowns
      const models = await window.genesis.invoke('agent:list-models');
      const roles = s?.models?.roles || {};
      const dropdowns = [
        { id: '#set-preferred-model', current: s?.models?.preferred, defaultLabel: 'Auto-detect' },
        { id: '#set-role-chat',      current: roles.chat,     defaultLabel: 'Default' },
        { id: '#set-role-code',      current: roles.code,     defaultLabel: 'Default' },
        { id: '#set-role-analysis',  current: roles.analysis, defaultLabel: 'Default' },
        { id: '#set-role-creative',  current: roles.creative, defaultLabel: 'Default' },
      ];
      if (models && models.length > 0) {
        for (const dd of dropdowns) {
          const sel = $(dd.id);
          if (!sel) continue;
          sel.innerHTML = `<option value="">${dd.defaultLabel}</option>`;
          for (const m of models) {
            const opt = document.createElement('option');
            opt.value = m.name;
            opt.textContent = `${m.name} (${m.backend})`;
            if (m.name === dd.current) opt.selected = true;
            sel.appendChild(opt);
          }
        }
        // Populate fallback chain multi-select
        const fbSel = $('#set-fallback-chain');
        const fbChain = s?.models?.fallbackChain || [];
        if (fbSel) {
          fbSel.innerHTML = '';
          for (const m of models) {
            const opt = document.createElement('option');
            opt.value = m.name;
            opt.textContent = `${m.name} (${m.backend})`;
            if (fbChain.includes(m.name)) opt.selected = true;
            fbSel.appendChild(opt);
          }
        }
      }
    } catch (_e) { console.debug('[SETTINGS] Fallback model list:', _e.message); }

    // Don't pre-fill API keys — security
    $('#settings-modal').classList.remove('hidden');
  } catch (err) { console.debug('[SETTINGS] Load error:', err.message); }
}

function closeSettings() { $('#settings-modal').classList.add('hidden'); }

async function saveSettings() {
  const sets = [];
  const anthKey = $('#set-anthropic-key').value;
  if (anthKey) sets.push(['models.anthropicApiKey', anthKey]);
  const oaiUrl = $('#set-openai-url').value;
  if (oaiUrl) sets.push(['models.openaiBaseUrl', oaiUrl]);
  const oaiKey = $('#set-openai-key').value;
  if (oaiKey) sets.push(['models.openaiApiKey', oaiKey]);
  // v5.1.0: Preferred model selection
  const prefModel = $('#set-preferred-model')?.value;
  if (prefModel !== undefined) sets.push(['models.preferred', prefModel || null]);
  // v5.1.0: Per-task model roles
  for (const role of ['chat', 'code', 'analysis', 'creative']) {
    const val = $(`#set-role-${role}`)?.value || null;
    sets.push([`models.roles.${role}`, val]);
  }
  // v5.1.0: Fallback chain (multi-select)
  const fbSel = $('#set-fallback-chain');
  if (fbSel) {
    const chain = [...fbSel.selectedOptions].map(o => o.value).filter(Boolean);
    sets.push(['models.fallbackChain', chain]);
  }
  sets.push(['daemon.enabled', $('#set-daemon').value === 'true']);
  sets.push(['idleMind.enabled', $('#set-idle').value === 'true']);
  sets.push(['security.allowSelfModify', $('#set-selfmod').value === 'true']);

  // v7.4.7: New settings
  const trustLevelEl = $('#set-trust-level');
  if (trustLevelEl) {
    const trustVal = parseInt(trustLevelEl.value, 10);
    if (!Number.isNaN(trustVal)) sets.push(['trust.level', trustVal]);
  }
  const autoResumeEl = $('#set-auto-resume');
  if (autoResumeEl?.value) sets.push(['agency.autoResumeGoals', autoResumeEl.value]);
  const mcpServeEl = $('#set-mcp-serve');
  if (mcpServeEl) sets.push(['mcp.serve.enabled', mcpServeEl.value === 'true']);
  const mcpPortEl = $('#set-mcp-port');
  if (mcpPortEl?.value) {
    const port = parseInt(mcpPortEl.value, 10);
    if (!Number.isNaN(port) && port >= 1024 && port <= 65535) sets.push(['mcp.serve.port', port]);
  }
  const approvalTimeoutEl = $('#set-approval-timeout');
  if (approvalTimeoutEl?.value) {
    const t = parseInt(approvalTimeoutEl.value, 10);
    if (!Number.isNaN(t) && t >= 10 && t <= 300) sets.push(['timeouts.approvalSec', t]);
  }

  for (const [key, value] of sets) {
    try { await window.genesis.invoke('agent:set-setting', { key, value }); }
    catch (err) { console.warn(`[SETTINGS] Failed to set ${key}:`, err.message); }
  }
  closeSettings();
  showToast(t('ui.settings_saved'), 'success');

  // v5.1.0: Refresh model dropdown after save (API keys or preferred model may have changed)
  window.dispatchEvent(new Event('genesis:reload-models'));
}

async function showGoalTree() {
  try {
    const goals = await window.genesis.invoke('agent:get-goal-tree');
    const container = $('#goal-tree');
    if (!container) return;
    container.innerHTML = '';
    if (!goals || goals.length === 0) {
      container.innerHTML = '<div class="empty-state">' + t('ui.no_goals') + '</div>';
      return;
    }
    for (const goal of goals) {
      container.innerHTML += buildGoalNode(goal, 0);
    }
  } catch (err) { console.debug('[GOALS] Load error:', err.message); }
}

function buildGoalNode(goal, depth) {
  const indent = depth * 16;
  const statusIcon = { active: '🔵', completed: '✅', failed: '❌', paused: '⏸' }[goal.status] || '⚪';
  let html = `<div class="goal-node" style="padding-left:${indent}px">
    <span class="goal-status">${statusIcon}</span>
    <span class="goal-desc">${goal.description || goal.goal || 'Unnamed goal'}</span>
  </div>`;
  if (goal.children) {
    for (const child of goal.children) html += buildGoalNode(child, depth + 1);
  }
  return html;
}

async function undoLastChange() {
  try {
    const result = await window.genesis.invoke('agent:undo');
    if (result.ok) {
      showToast(t('ui.undo_success', { commit: result.reverted }), 'success');
      addMessage('agent', `↩ ${t('ui.undo_detail', { detail: result.detail })}`, 'undo');
    } else {
      showToast(result.error || t('ui.undo_failed'), 'error');
    }
  } catch (err) { showToast(t('ui.undo_failed'), 'error'); }
}

function setupDragDrop() {
  const chatPanel = $('#chat-panel');
  if (!chatPanel) return;

  chatPanel.addEventListener('dragover', (e) => { e.preventDefault(); chatPanel.classList.add('drag-over'); });
  chatPanel.addEventListener('dragleave', () => { chatPanel.classList.remove('drag-over'); });
  chatPanel.addEventListener('drop', async (e) => {
    e.preventDefault();
    chatPanel.classList.remove('drag-over');
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

function autoResize(ta) { ta.style.height = 'auto'; ta.style.height = Math.min(ta.scrollHeight, 150) + 'px'; }

module.exports = { openSettings, closeSettings, saveSettings, showGoalTree, undoLastChange, setupDragDrop, autoResize };
