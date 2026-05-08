'use strict';

// ============================================================
// GENESIS — goal-management.js (v7.7.2)
//
// Goal tree + undo UI — extracted from settings.js (was Cluster H,
// lines 950-1010 in the v7.7.1 form). These are NOT part of the
// settings domain — they're triggered by separate UI buttons
// (#btn-goals, #btn-undo) and the Ctrl+Z keyboard shortcut. They
// only lived in settings.js historically; v7.7.2 moves them into
// their own module.
//
// Public surface:
//   - showGoalTree(): fetch goal tree from backend, render as
//     indented HTML in #goal-tree container.
//   - undoLastChange(): trigger the most recent undo via IPC.
//
// Both have not-ready guards (v7.7.0 A2): if the agent is still
// booting, surface a warning toast instead of a confusing IPC
// error. Caller-side: renderer-main.js wires #btn-goals click
// to showGoalTree, #btn-undo + Ctrl+Z to undoLastChange.
// ============================================================

const { t } = require('./i18n');
const { addMessage } = require('./chat');
const { showToast } = require('./statusbar');
const { isAgentReady } = require('./agent-state');

const $ = (sel) => document.querySelector(sel);

async function showGoalTree() {
  // v7.7.0: not-ready guard — agent:get-goal-tree IPC needs backend ready.
  if (!isAgentReady()) {
    showToast(t('ui.still_starting'), 'warning');
    return;
  }
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
  // v7.7.0 (A2): not-ready guard — undo IPC needs backend ready.
  if (!isAgentReady()) {
    showToast(t('ui.still_starting'), 'warning');
    return;
  }
  try {
    const result = await window.genesis.invoke('agent:undo');
    if (result.ok) {
      // v7.7.0 (A3): variable name matches lang-string 'Change reverted: {{detail}}'
      showToast(t('ui.undo_success', { detail: result.reverted }), 'success');
      // v7.7.0 (A3 bonus): inline result.detail directly (matches legacy renderer.js Z.414)
      addMessage('agent', `↩ ${result.detail || ''}`, 'undo');
    } else {
      // v7.7.0 (A4): nothing-to-undo is a benign no-op → warning, not error
      showToast(result.error || t('ui.undo_nothing'), 'warning');
    }
  } catch (err) { showToast(t('ui.undo_failed', { error: err.message }), 'error'); }
}

module.exports = {
  showGoalTree,
  buildGoalNode,
  undoLastChange,
};
