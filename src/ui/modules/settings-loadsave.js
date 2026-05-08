'use strict';

// ============================================================
// GENESIS — settings-loadsave.js (v7.7.2)
//
// Cross-cutting load + save logic for the settings UI. Extracted
// from settings.js (was Clusters C + G, lines 309-505 and
// 733-948 in the v7.7.1 form — combined ~410 LOC, the biggest
// pair in the file).
//
// openSettings(): not-ready guard, wire tabs + JSON editor +
// MCP add-button, decorate all fields with default-hints,
// fetch settings via IPC, populate every UI control with the
// current value. Includes model-list discovery for the
// preferred-model + per-task-role dropdowns and the fallback
// chain renderer.
//
// saveSettings(): validate all fields first (range-check,
// reject if any invalid), then walk the entire UI surface
// collecting [dotPath, value] pairs into a flat sets[] array,
// merge in JSON-editor diff, send as one batch IPC. Falls back
// to per-setting calls if the batch handler is missing.
//
// Dependencies are explicit:
//   - settings-fields:      DOM helpers + decoration + validation
//   - settings-state:       shared fallback/MCP state
//   - settings-fallback-ui: renderFallbackUI (called from
//                           openSettings after model-list fetch)
//   - settings-mcp-ui:      _renderMcpServers + _wireMcpAddButton
//   - settings-json-editor: _wireJsonEditorButtons, _loadJsonEditor,
//                           _collectJsonEditorChanges
// ============================================================

const { t } = require('./i18n');
const { showToast } = require('./statusbar');
const { isAgentReady } = require('./agent-state');
const {
  $,
  _setNum, _setStr, _setBool,
  _decorateAllFields,
  _validateAllFields,
} = require('./settings-fields');
const {
  getFallbackState,
  setFallbackLoaded,
  getMcpServersState,
} = require('./settings-state');
const { renderFallbackUI } = require('./settings-fallback-ui');
const { _renderMcpServers, _wireMcpAddButton } = require('./settings-mcp-ui');
const {
  _wireJsonEditorButtons,
  _loadJsonEditor,
  _collectJsonEditorChanges,
} = require('./settings-json-editor');

// _wireSettingsTabs is internal to the facade (settings.js) so we don't
// import it here — it's wired before openSettings is even called from
// the modal-open click handler in renderer-main.js. To avoid a circular
// import, we re-implement the tabs-wiring locally as it's just DOM setup.
function _wireSettingsTabs() {
  const tabs = document.querySelectorAll('.settings-tab');
  if (!tabs.length || tabs[0]._wired) return;
  for (const tab of tabs) {
    tab._wired = true;
    tab.addEventListener('click', () => {
      const target = tab.getAttribute('data-tab');
      for (const t of document.querySelectorAll('.settings-tab')) t.classList.remove('active');
      tab.classList.add('active');
      for (const p of document.querySelectorAll('.settings-tab-panel')) {
        if (p.getAttribute('data-tab-panel') === target) {
          p.classList.remove('hidden');
        } else {
          p.classList.add('hidden');
        }
      }
    });
  }
}

async function openSettings() {
  // v7.7.0: not-ready guard — agent:get-settings IPC would hang or
  // error if backend isn't listening. Same behavior as legacy.
  if (!isAgentReady()) {
    showToast(t('ui.still_starting'), 'warning');
    return;
  }
  // v7.5.7-fix: reset loaded-flag so a failed agent:list-models call
  // doesn't leave _fallbackState in a stale "loaded" state where
  // saveSettings would persist the empty chain.
  setFallbackLoaded(false);
  _wireSettingsTabs();
  _wireMcpAddButton();
  _decorateAllFields();
  _wireJsonEditorButtons();
  _loadJsonEditor();
  try {
    const s = await window.genesis.invoke('agent:get-settings');
    if (s?.daemon?.enabled !== undefined) $('#set-daemon').value = String(s.daemon.enabled);
    if (s?.idleMind?.enabled !== undefined) $('#set-idle').value = String(s.idleMind.enabled);
    if (s?.security?.allowSelfModify !== undefined) $('#set-selfmod').value = String(s.security.allowSelfModify);

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

    _setBool('#set-auto-route', s?.agency?.autoRouteByTask);
    _setBool('#set-negotiate', s?.agency?.negotiateBeforeAdd);
    _setBool('#set-cognitive-strict', s?.cognitive?.strictMode);

    _setNum('#set-max-concurrent', s?.models?.maxConcurrent ?? 3);
    _setNum('#set-max-workers', s?.selfSpawner?.maxWorkers ?? 3);
    _setStr('#set-keep-alive', s?.models?.ollamaKeepAlive ?? '');
    _setNum('#set-kg-max-nodes', s?.knowledgeGraph?.maxNodes ?? 5000);
    _setNum('#set-sslog-max', s?.selfStatementLog?.maxStatements ?? 5000);

    _setNum('#set-sim-branches', s?.cognitive?.simulation?.maxBranches ?? 3);
    _setNum('#set-sim-depth', s?.cognitive?.simulation?.maxDepth ?? 15);
    _setNum('#set-emotion-decay-interval', s?.organism?.emotions?.decayIntervalMs ? Math.round(s.organism.emotions.decayIntervalMs / 1000) : null);
    _setNum('#set-loneliness-interval', s?.organism?.emotions?.lonelinessIntervalMs ? Math.round(s.organism.emotions.lonelinessIntervalMs / 1000) : null);
    _setNum('#set-idle-minutes', s?.idleMind?.idleMinutes ?? 2);
    _setNum('#set-think-minutes', s?.idleMind?.thinkMinutes ?? 3);
    _setNum('#set-daemon-cycle', s?.daemon?.cycleMinutes ?? 5);

    _setBool('#set-cost-guard-enabled', s?.llm?.costGuard?.enabled ?? true);
    _setNum('#set-cost-session-limit', s?.llm?.costGuard?.sessionTokenLimit ?? 500000);
    _setNum('#set-cost-daily-limit', s?.llm?.costGuard?.dailyTokenLimit ?? 2000000);
    _setNum('#set-cost-warn-threshold', s?.llm?.costGuard?.warnThreshold ? Math.round(s.llm.costGuard.warnThreshold * 100) : 80);

    _setNum('#set-eventstore-size', s?.eventStore?.maxFileSizeMB ?? 50);
    _setNum('#set-eventstore-rotations', s?.eventStore?.maxRotations ?? 3);

    _setNum('#set-spawner-timeout', s?.selfSpawner?.timeoutMs ? Math.round(s.selfSpawner.timeoutMs / 1000) : 300);
    _setNum('#set-spawner-memory', s?.selfSpawner?.memoryLimitMB ?? 256);

    _setNum('#set-workerpool-max', s?.workerPool?.maxWorkers ?? 0);

    _setNum('#set-episodic-max', s?.episodicMemory?.maxEpisodes ?? 500);

    _setNum('#set-idlemind-max-goals', s?.idleMind?.maxActiveGoals ?? 3);
    _setNum('#set-idlemind-journal-size', s?.idleMind?.journalMaxFileSizeMB ?? 10);
    _setNum('#set-idlemind-journal-rotations', s?.idleMind?.journalMaxRotations ?? 3);

    _setBool('#set-daemon-auto-repair', s?.daemon?.autoRepair ?? true);
    _setBool('#set-daemon-auto-optimize', s?.daemon?.autoOptimize ?? false);

    _setBool('#set-allow-peers', s?.security?.allowNetworkPeers ?? true);
    _setBool('#set-allow-file-exec', s?.security?.allowFileExecution ?? true);
    _setBool('#set-commit-on-shutdown', s?.agency?.commitSnapshotOnShutdown ?? false);
    _setBool('#set-git-auto-init',       s?.agency?.gitAutoInit ?? false);
    _setBool('#set-git-auto-commit',     s?.agency?.gitAutoCommit ?? false);

    _setBool('#set-install-allow-auto', s?.install?.allowAutoInstall ?? false);
    _setBool('#set-install-full-autonomy', s?.install?.fullAutonomy ?? false);
    const scopeEl = document.querySelector('#set-install-scope');
    if (scopeEl) {
      const scope = s?.install?.scope ?? 'machine';
      scopeEl.value = ['machine', 'user', 'auto'].includes(scope) ? scope : 'machine';
    }

    _setBool('#set-health-http', s?.health?.httpEnabled ?? false);
    _setNum('#set-health-port', s?.health?.httpPort ?? 9090);

    _setNum('#set-editor-font', s?.ui?.editorFontSize ?? 13);
    _setNum('#set-chat-font', s?.ui?.chatFontSize ?? 13);

    if ($('#set-openai-models')) {
      const models = Array.isArray(s?.models?.openaiModels) ? s.models.openaiModels : [];
      $('#set-openai-models').value = models.join(', ');
    }

    _renderMcpServers(Array.isArray(s?.mcp?.servers) ? s.mcp.servers : []);

    try {
      const health = await window.genesis.invoke('agent:get-health');
      const info = $('#settings-model-info');
      if (info && health?.model) {
        info.textContent = `${health.model.active || 'none'} (${health.model.backend || '?'})`;
      }
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
        // v7.5.7-fix: Fallback chain — render as two interactive lists.
        const fbChain = Array.isArray(s?.models?.fallbackChain) ? [...s.models.fallbackChain] : [];
        renderFallbackUI(models, fbChain);
      }
    } catch (_e) { console.debug('[SETTINGS] Fallback model list:', _e.message); }

    // Don't pre-fill API keys — security
    $('#settings-modal').classList.remove('hidden');
  } catch (err) { console.debug('[SETTINGS] Load error:', err.message); }
}

async function saveSettings() {
  // v7.5.7-fix Phase 3 Etappe 3: validate all fields before any IPC.
  if (!_validateAllFields()) {
    showToast('Einige Werte sind außerhalb gültigem Bereich. Bitte korrigieren.', 'error');
    return;
  }
  const sets = [];
  const anthKey = $('#set-anthropic-key').value;
  if (anthKey) sets.push(['models.anthropicApiKey', anthKey]);
  const oaiUrl = $('#set-openai-url').value;
  if (oaiUrl) sets.push(['models.openaiBaseUrl', oaiUrl]);
  const oaiKey = $('#set-openai-key').value;
  if (oaiKey) sets.push(['models.openaiApiKey', oaiKey]);
  const prefModel = $('#set-preferred-model')?.value;
  if (prefModel !== undefined) sets.push(['models.preferred', prefModel || null]);
  for (const role of ['chat', 'code', 'analysis', 'creative']) {
    const val = $(`#set-role-${role}`)?.value || null;
    sets.push([`models.roles.${role}`, val]);
  }
  // v7.5.7-fix: Fallback chain — read from shared state.
  const fallbackState = getFallbackState();
  sets.push(['models.fallbackChain', Array.isArray(fallbackState.chain) ? [...fallbackState.chain] : []]);
  sets.push(['daemon.enabled', $('#set-daemon').value === 'true']);
  sets.push(['idleMind.enabled', $('#set-idle').value === 'true']);
  sets.push(['security.allowSelfModify', $('#set-selfmod').value === 'true']);

  // v7.4.7: Trust, Auto-Resume, MCP-Serve, Approval-Timeout
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
    if (!Number.isNaN(t) && t >= 10 && t <= 3600) sets.push(['timeouts.approvalSec', t]);
  }

  const autoRouteEl = $('#set-auto-route');
  if (autoRouteEl) sets.push(['agency.autoRouteByTask', autoRouteEl.value === 'true']);
  const negotiateEl = $('#set-negotiate');
  if (negotiateEl) sets.push(['agency.negotiateBeforeAdd', negotiateEl.value === 'true']);
  const cogStrictEl = $('#set-cognitive-strict');
  if (cogStrictEl) sets.push(['cognitive.strictMode', cogStrictEl.value === 'true']);

  const _intIfValid = (selector, key, min, max) => {
    const el = $(selector);
    if (!el || el.value === '') return;
    const n = parseInt(el.value, 10);
    if (!Number.isNaN(n) && n >= min && n <= max) sets.push([key, n]);
  };
  _intIfValid('#set-max-concurrent',  'models.maxConcurrent',           1, 10);
  _intIfValid('#set-max-workers',     'selfSpawner.maxWorkers',         1, 10);
  _intIfValid('#set-kg-max-nodes',    'knowledgeGraph.maxNodes',        0, 100000);
  _intIfValid('#set-sslog-max',       'selfStatementLog.maxStatements', 0, 100000);

  const keepAliveEl = $('#set-keep-alive');
  if (keepAliveEl) {
    const v = keepAliveEl.value.trim();
    sets.push(['models.ollamaKeepAlive', v === '' ? null : v]);
  }

  _intIfValid('#set-sim-branches', 'cognitive.simulation.maxBranches', 1, 20);
  _intIfValid('#set-sim-depth',    'cognitive.simulation.maxDepth',    1, 100);
  _intIfValid('#set-idle-minutes', 'idleMind.idleMinutes',             1, 120);
  _intIfValid('#set-think-minutes', 'idleMind.thinkMinutes',           1, 120);
  _intIfValid('#set-daemon-cycle', 'daemon.cycleMinutes',              1, 120);
  const decayEl = $('#set-emotion-decay-interval');
  if (decayEl?.value) {
    const sec = parseInt(decayEl.value, 10);
    if (!Number.isNaN(sec) && sec >= 5 && sec <= 3600) sets.push(['organism.emotions.decayIntervalMs', sec * 1000]);
  }
  const lonelyEl = $('#set-loneliness-interval');
  if (lonelyEl?.value) {
    const sec = parseInt(lonelyEl.value, 10);
    if (!Number.isNaN(sec) && sec >= 30 && sec <= 7200) sets.push(['organism.emotions.lonelinessIntervalMs', sec * 1000]);
  }

  const cgEnEl = $('#set-cost-guard-enabled');
  if (cgEnEl) sets.push(['llm.costGuard.enabled', cgEnEl.value === 'true']);
  _intIfValid('#set-cost-session-limit', 'llm.costGuard.sessionTokenLimit', 1000, 10000000);
  _intIfValid('#set-cost-daily-limit',   'llm.costGuard.dailyTokenLimit',   1000, 50000000);
  const warnEl = $('#set-cost-warn-threshold');
  if (warnEl?.value) {
    const pct = parseInt(warnEl.value, 10);
    if (!Number.isNaN(pct) && pct >= 50 && pct <= 99) sets.push(['llm.costGuard.warnThreshold', pct / 100]);
  }

  _intIfValid('#set-eventstore-size',      'eventStore.maxFileSizeMB', 0, 500);
  _intIfValid('#set-eventstore-rotations', 'eventStore.maxRotations',  0, 10);

  const spawnTimeoutEl = $('#set-spawner-timeout');
  if (spawnTimeoutEl?.value) {
    const sec = parseInt(spawnTimeoutEl.value, 10);
    if (!Number.isNaN(sec) && sec >= 10 && sec <= 3600) sets.push(['selfSpawner.timeoutMs', sec * 1000]);
  }
  _intIfValid('#set-spawner-memory', 'selfSpawner.memoryLimitMB', 64, 4096);

  _intIfValid('#set-workerpool-max', 'workerPool.maxWorkers', 0, 16);

  _intIfValid('#set-episodic-max', 'episodicMemory.maxEpisodes', 0, 50000);

  _intIfValid('#set-idlemind-max-goals',         'idleMind.maxActiveGoals',       1, 20);
  _intIfValid('#set-idlemind-journal-size',      'idleMind.journalMaxFileSizeMB', 1, 500);
  _intIfValid('#set-idlemind-journal-rotations', 'idleMind.journalMaxRotations',  0, 10);

  const daemonRepairEl = $('#set-daemon-auto-repair');
  if (daemonRepairEl) sets.push(['daemon.autoRepair', daemonRepairEl.value === 'true']);
  const daemonOptEl = $('#set-daemon-auto-optimize');
  if (daemonOptEl) sets.push(['daemon.autoOptimize', daemonOptEl.value === 'true']);

  const peersEl = $('#set-allow-peers');
  if (peersEl) sets.push(['security.allowNetworkPeers', peersEl.value === 'true']);
  const fileExecEl = $('#set-allow-file-exec');
  if (fileExecEl) sets.push(['security.allowFileExecution', fileExecEl.value === 'true']);
  const commitEl = $('#set-commit-on-shutdown');
  if (commitEl) sets.push(['agency.commitSnapshotOnShutdown', commitEl.value === 'true']);
  const gitInitEl = $('#set-git-auto-init');
  if (gitInitEl) sets.push(['agency.gitAutoInit', gitInitEl.value === 'true']);
  const gitCommitEl = $('#set-git-auto-commit');
  if (gitCommitEl) sets.push(['agency.gitAutoCommit', gitCommitEl.value === 'true']);

  const installAutoEl = $('#set-install-allow-auto');
  if (installAutoEl) sets.push(['install.allowAutoInstall', installAutoEl.value === 'true']);
  const installFullEl = $('#set-install-full-autonomy');
  if (installFullEl) sets.push(['install.fullAutonomy', installFullEl.value === 'true']);
  const installScopeEl = $('#set-install-scope');
  if (installScopeEl && ['machine', 'user', 'auto'].includes(installScopeEl.value)) {
    sets.push(['install.scope', installScopeEl.value]);
  }

  const healthEl = $('#set-health-http');
  if (healthEl) sets.push(['health.httpEnabled', healthEl.value === 'true']);
  _intIfValid('#set-health-port', 'health.httpPort', 1024, 65535);

  _intIfValid('#set-editor-font', 'ui.editorFontSize', 10, 24);
  _intIfValid('#set-chat-font',   'ui.chatFontSize',   10, 24);

  const oaiModelsEl = $('#set-openai-models');
  if (oaiModelsEl) {
    const list = oaiModelsEl.value.split(',').map(s => s.trim()).filter(s => s.length > 0);
    sets.push(['models.openaiModels', list]);
  }

  // MCP servers list (full replace from state)
  const mcpState = getMcpServersState();
  sets.push(['mcp.servers', mcpState.servers.map(s => ({ name: s.name, url: s.url }))]);

  // v7.5.7-fix Phase 3 Etappe 4: merge JSON-Editor changes into the batch.
  const jsonChanges = await _collectJsonEditorChanges();
  if (jsonChanges === null) {
    showToast('JSON-Editor: ungültiges JSON. Speichern abgebrochen.', 'error');
    return;
  }
  if (jsonChanges.length > 0) {
    const existingKeys = new Set(sets.map(([k]) => k));
    for (const [k, v] of jsonChanges) {
      if (!existingKeys.has(k)) sets.push([k, v]);
    }
  }

  // v7.5.7-fix Phase 3: single batch call instead of N individual IPCs.
  try {
    const result = await window.genesis.invoke('agent:set-settings-batch', { entries: sets });
    if (result && result.error) throw new Error(result.error);
  } catch (err) {
    console.warn('[SETTINGS] Batch save failed, falling back to per-setting:', err.message);
    for (const [key, value] of sets) {
      try { await window.genesis.invoke('agent:set-setting', { key, value }); }
      catch (e) { console.warn(`[SETTINGS] Failed to set ${key}:`, e.message); }
    }
  }
  // Hide modal (replaces closeSettings call to avoid circular import with facade)
  $('#settings-modal').classList.add('hidden');
  showToast(t('ui.settings_saved'), 'success');

  window.dispatchEvent(new Event('genesis:reload-models'));
}

module.exports = {
  openSettings,
  saveSettings,
};
