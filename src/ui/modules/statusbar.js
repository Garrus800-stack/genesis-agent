// ============================================================
// GENESIS UI — modules/statusbar.js
// Status badge updates, toast notifications, health/self-model display.
// ============================================================

const { t } = require('./i18n');

const $ = (sel) => document.querySelector(sel);

// v7.5.7-fix Phase 3 Etappe 8: remember the last applied status so we
// can re-render its label when the language changes. Without this, the
// status-badge shows whatever the static `data-i18n="ui.booting"` text
// resolves to right after `applyI18n()` runs — i.e. it snaps back to
// "Booting..." even if the live state is "ready" or "idle".
let _lastStatus = null;

function updateStatus(status) {
  const badge = $('#status-badge');
  if (!badge || !status) return;
  // Once we have a real (non-initial) status update, the static i18n
  // attribute on the element becomes a liability — applyI18n() would
  // overwrite our live textContent on every language switch. Drop it
  // after the first real update; we manage the text ourselves.
  if (status.state && status.state !== 'booting' && badge.hasAttribute('data-i18n')) {
    badge.removeAttribute('data-i18n');
  }
  _lastStatus = status;
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

/**
 * Re-render the status-badge label using the most recent status payload.
 * Called from the language-change handler after applyI18n(), so the live
 * status (e.g. "Ready" / "Bereit") follows the language switch.
 *
 * If we've never seen a real status update yet (renderer registered its
 * listener after the agent fired the initial `ready` event), fall back
 * to refreshing whatever the badge currently says by mapping its known
 * CSS class back to a state. Without this, language switches could leave
 * a stale label in place (the symptom: badge stays "Bereit" even after
 * switching to EN).
 */
function refreshStatusI18n() {
  if (_lastStatus) {
    updateStatus(_lastStatus);
    return;
  }
  // Fallback: derive state from the badge's CSS class. This handles the
  // case where the agent's initial status:'ready' fired before we
  // registered our IPC listener — _lastStatus is still null but the
  // badge already shows something.
  if (typeof document === 'undefined') return; // safe in non-browser test env
  const badge = $('#status-badge');
  if (!badge) return;
  const m = (badge.className || '').match(/badge-(\w+)/);
  if (m && m[1] && m[1] !== 'booting') {
    updateStatus({ state: m[1] });
  }
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

module.exports = { updateStatus, refreshStatusI18n, showToast, showHealth, showSelfModel };
