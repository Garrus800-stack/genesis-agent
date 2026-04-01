// ============================================================
// GENESIS UI — modules/statusbar.js
// Status badge updates, toast notifications, health/self-model display.
// ============================================================

const { t } = require('./i18n');

const $ = (sel) => document.querySelector(sel);

function updateStatus(status) {
  const badge = $('#status-badge');
  if (!badge || !status) return;
  badge.className = 'badge badge-' + (status.state || 'ready');
  const labels = {
    ready: t('ui.ready'), thinking: t('ui.thinking'),
    error: t('ui.error'), warning: t('ui.warning'),
    booting: t('ui.booting'), 'self-modifying': t('ui.self_modifying'),
    'self-repairing': '🔧 Repairing', 'creating-skill': '🛠 Creating Skill',
    cloning: '🧬 Cloning', 'health-tick': null,
  };
  const label = labels[status.state];
  if (label) badge.textContent = label;
  if (status.detail) badge.title = status.detail;
}

function showToast(message, type = 'info') {
  const container = $('#toast-container');
  if (!container) return;
  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;
  toast.textContent = message;
  container.appendChild(toast);
  setTimeout(() => { toast.classList.add('fade-out'); setTimeout(() => toast.remove(), 300); }, 3000);
}

async function showHealth() {
  const { addMessage } = require('./chat');
  try {
    const h = await window.genesis.invoke('agent:get-health');
    const lines = [
      `**${t('health.status')}**`, '',
      `**${t('health.model')}:** ${h.model?.active || t('health.none')}`,
      `**${t('health.modules')}:** ${h.modules}`,
      `**${t('health.memory')}:** ${h.memory?.episodes || 0} ${t('health.episodes')}, ${h.memory?.facts || 0} ${t('health.facts')}`,
      `**${t('health.tools')}:** ${h.tools}`,
      `**${t('health.kernel')}:** ${h.kernel?.ok ? '✅' : '⚠️'}`,
      `**${t('health.daemon')}:** ${h.daemon?.running ? t('health.active') : t('health.inactive')}`,
      `**${t('health.idle')}:** ${h.idleMind?.thoughtCount || 0} ${t('health.thoughts')}`,
      `**${t('health.goals')}:** ${h.goals?.active || 0} ${t('health.active_goals')}`,
      `**${t('health.uptime')}:** ${Math.round(h.uptime / 60)} min`,
    ];
    addMessage('agent', lines.join('\n'), 'health');
  } catch (err) { addMessage('agent', `Health error: ${err.message}`, 'error'); }
}

async function showSelfModel() {
  const { addMessage } = require('./chat');
  try {
    const sm = await window.genesis.invoke('agent:get-self-model');
    const lines = [
      `**Self-Model**`, '',
      `**Identity:** ${sm.identity} v${sm.version}`,
      `**Modules:** ${Object.keys(sm.modules || {}).length}`,
      `**Files:** ${Object.keys(sm.files || {}).length}`,
      `**Capabilities:** ${(sm.capabilities || []).join(', ')}`,
    ];
    addMessage('agent', lines.join('\n'), 'self-model');
  } catch (err) { addMessage('agent', `Self-model error: ${err.message}`, 'error'); }
}

module.exports = { updateStatus, showToast, showHealth, showSelfModel };
