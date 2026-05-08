// ============================================================
// GENESIS UI — modules/settings.js
// Settings modal, drag-and-drop file import, goals panel, undo.
// ============================================================

const { t } = require('./i18n');
const { addMessage } = require('./chat');
const { showToast } = require('./statusbar');
const { isAgentReady } = require('./agent-state');
// v7.5.7-fix Phase 3 Etappe 3: central registry for defaults + ranges
const { FIELD_REGISTRY, getFieldDefault, buildDefaultHint, validateField } = require('./settings-defaults');

const $ = (sel) => document.querySelector(sel);

// v7.5.7-fix Phase 2: helper for safe number-input value assignment
function _setNum(selector, value) {
  const el = $(selector);
  if (el && value !== undefined && value !== null) el.value = String(value);
}
function _setStr(selector, value) {
  const el = $(selector);
  if (el && value !== undefined && value !== null) el.value = String(value);
}
function _setBool(selector, value) {
  const el = $(selector);
  if (el && value !== undefined) el.value = String(!!value);
}

// ── v7.5.7-fix Phase 3 Etappe 3: per-field Default-Hint + Reset + Validation ──

/**
 * Decorate a field with: default-hint, reset-button, range-validation.
 * Idempotent — but the default-hint *is* re-rendered each call so that
 * language changes (Etappe 6 i18n) refresh the visible text.
 *
 * Wraps the input in a .setting-input-row div (input + reset button),
 * appends a .setting-default-hint span, and wires input-event validation.
 */
function _decorateField(id) {
  const el = document.getElementById(id);
  if (!el) return;
  const meta = getFieldDefault(id);
  if (!meta) return; // unknown field — skip silently

  const parent = el.parentNode;
  if (!parent) return;

  // Re-rendering the default-hint must always happen (language may have
  // changed). The structural decoration (row + reset button) only once.
  // Remove any existing default-hint so we can rebuild it.
  const existingHints = parent.parentNode
    ? parent.parentNode.querySelectorAll('.setting-default-hint')
    : null;
  if (existingHints) existingHints.forEach(n => n.remove());
  const ownHint = parent.querySelector('.setting-default-hint');
  if (ownHint) ownHint.remove();

  if (!el._decorated) {
    el._decorated = true;

    // 1. Wrap input in row + add reset button (one-time structural change)
    if (meta.resetSafe) {
      const row = document.createElement('div');
      row.className = 'setting-input-row';
      parent.insertBefore(row, el);
      row.appendChild(el);
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'setting-reset-btn';
      // i18n: title attr — re-applied on re-decoration via _refreshResetTitles below
      btn.title = t('ui.reset_to_default');
      btn.textContent = '↺';
      btn.addEventListener('click', () => _resetFieldToDefault(id));
      row.appendChild(btn);
    }

    // 3. Range validation on input (one-time listener)
    if (meta.type === 'number') {
      el.addEventListener('input', () => _validateAndMark(id));
      el.addEventListener('change', () => _validateAndMark(id));
    }
  }

  // 2. Default hint — ALWAYS re-render so language changes pick up
  const hint = buildDefaultHint(id, document, t);
  if (hint) {
    // Insert before existing .setting-hint if any, else append
    const existingHint = parent.querySelector('.setting-hint');
    if (existingHint) parent.insertBefore(hint, existingHint);
    else parent.appendChild(hint);
  }
}

/**
 * Refresh translatable attributes on previously-decorated elements
 * (reset button title, etc.) — called on language switch.
 */
function _refreshResetTitles() {
  document.querySelectorAll('.setting-reset-btn').forEach(btn => {
    btn.title = t('ui.reset_to_default');
  });
}

function _validateAndMark(id) {
  const el = document.getElementById(id);
  if (!el) return true;
  const meta = getFieldDefault(id);
  if (!meta || meta.type !== 'number') return true;

  const result = validateField(id, el.value, t);
  // Remove old error if any
  const parent = el.parentNode?.parentNode || el.parentNode;
  const oldErr = parent?.querySelector(`.setting-error[data-for="${id}"]`);
  if (oldErr) oldErr.remove();
  if (result.ok) {
    el.classList.remove('invalid');
    return true;
  }
  el.classList.add('invalid');
  const errEl = document.createElement('span');
  errEl.className = 'setting-error';
  errEl.dataset.for = id;
  // i18n: try translation first, fall back to original German
  const tpl = t('settings.validation.out_of_range_with_reason');
  errEl.textContent = (tpl && tpl !== 'settings.validation.out_of_range_with_reason')
    ? tpl.replace('{{reason}}', result.reason)
    : `Wert außerhalb gültigem Bereich (${result.reason}). Speichern blockiert.`;
  if (parent) parent.appendChild(errEl);
  return false;
}

function _resetFieldToDefault(id) {
  const el = document.getElementById(id);
  const meta = getFieldDefault(id);
  if (!el || !meta) return;
  if (meta.type === 'number') {
    let v = meta.default;
    // Inverse-scale for fields shown in seconds but stored in ms (or %→0..1)
    el.value = v == null ? '' : String(v);
  } else if (meta.type === 'bool') {
    el.value = String(!!meta.default);
  } else if (meta.type === 'enum' || meta.type === 'string') {
    el.value = meta.default == null ? '' : String(meta.default);
  } else if (meta.type === 'list') {
    el.value = '';
  }
  // Clear any prior validation error
  el.classList.remove('invalid');
  const parent = el.parentNode?.parentNode || el.parentNode;
  const oldErr = parent?.querySelector(`.setting-error[data-for="${id}"]`);
  if (oldErr) oldErr.remove();
}

/** Decorate every registered field after the modal is opened. */
function _decorateAllFields() {
  for (const id of Object.keys(FIELD_REGISTRY)) _decorateField(id);
}

/** Validate ALL fields. Returns true if save can proceed. */
function _validateAllFields() {
  let allOk = true;
  for (const id of Object.keys(FIELD_REGISTRY)) {
    if (!_validateAndMark(id)) allOk = false;
  }
  return allOk;
}

// ── v7.5.7-fix Phase 3 Etappe 4: JSON-Editor (power mode) ───────

const SENSITIVE_PATHS = new Set([
  'models.anthropicApiKey',
  'models.openaiApiKey',
  'peer.discoveryToken',
]);

function _maskSensitiveInJson(obj) {
  // Deep clone, then walk and mask. Returns a new object — original untouched.
  const cloned = JSON.parse(JSON.stringify(obj));
  for (const dotPath of SENSITIVE_PATHS) {
    const parts = dotPath.split('.');
    let cur = cloned;
    for (let i = 0; i < parts.length - 1; i++) {
      if (!cur || typeof cur !== 'object') return cloned;
      cur = cur[parts[i]];
    }
    if (cur && typeof cur === 'object' && parts[parts.length - 1] in cur) {
      const val = cur[parts[parts.length - 1]];
      if (typeof val === 'string' && val.length > 0) {
        cur[parts[parts.length - 1]] = '***MASKED*** (set via Modelle-Tab)';
      }
    }
  }
  return cloned;
}

async function _loadJsonEditor() {
  const ta = $('#json-editor-textarea');
  const status = $('#json-editor-status');
  if (!ta) return;
  try {
    const settings = await window.genesis.invoke('agent:get-settings');
    const masked = _maskSensitiveInJson(settings);
    ta.value = JSON.stringify(masked, null, 2);
    ta.classList.remove('invalid');
    if (status) {
      status.textContent = t('settings.json.status_loaded');
      status.className = 'json-editor-status valid';
    }
  } catch (err) {
    if (status) {
      status.textContent = t('settings.json.status_load_error') + ': ' + err.message;
      status.className = 'json-editor-status invalid';
    }
  }
}

function _validateJsonEditor() {
  const ta = $('#json-editor-textarea');
  const status = $('#json-editor-status');
  if (!ta || !status) return null;
  try {
    const parsed = JSON.parse(ta.value);
    ta.classList.remove('invalid');
    status.textContent = t('settings.json.status_valid');
    status.className = 'json-editor-status valid';
    return parsed;
  } catch (err) {
    ta.classList.add('invalid');
    status.textContent = t('settings.json.status_invalid') + ': ' + err.message;
    status.className = 'json-editor-status invalid';
    return null;
  }
}

function _wireJsonEditorButtons() {
  const validateBtn = $('#btn-json-validate');
  if (validateBtn && !validateBtn._wired) {
    validateBtn._wired = true;
    validateBtn.addEventListener('click', () => _validateJsonEditor());
  }
  const reloadBtn = $('#btn-json-reload');
  if (reloadBtn && !reloadBtn._wired) {
    reloadBtn._wired = true;
    reloadBtn.addEventListener('click', () => _loadJsonEditor());
  }
  // Live-validate on input
  const ta = $('#json-editor-textarea');
  if (ta && !ta._wired) {
    ta._wired = true;
    let timer = null;
    ta.addEventListener('input', () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => _validateJsonEditor(), 400);
    });
  }
}

/**
 * Build a flat "diff" of dot-path entries between user-edited JSON and
 * current settings. Used by saveSettings to apply only what the user
 * actually changed via the JSON-Editor (without overwriting masked
 * sensitive fields).
 *
 * Returns array of [dotPath, value] pairs to send via setBatch.
 */
async function _collectJsonEditorChanges() {
  const ta = $('#json-editor-textarea');
  if (!ta || !ta.value.trim()) return [];
  let parsed;
  try { parsed = JSON.parse(ta.value); } catch (_e) { return null; /* invalid */ }
  let current;
  try { current = await window.genesis.invoke('agent:get-settings'); } catch (_e) { return []; }

  const changes = [];
  function walk(obj, prefix) {
    if (obj == null || typeof obj !== 'object') return;
    for (const key of Object.keys(obj)) {
      const dotPath = prefix ? `${prefix}.${key}` : key;
      const val = obj[key];
      // Skip masked sensitive fields — never write the literal "***MASKED***" string back
      if (SENSITIVE_PATHS.has(dotPath) && typeof val === 'string' && val.startsWith('***MASKED***')) continue;
      // Recurse into plain objects (not arrays)
      if (val !== null && typeof val === 'object' && !Array.isArray(val)) {
        walk(val, dotPath);
        continue;
      }
      // Compare to current value via dot-path
      const cur = _getDotPath(current, dotPath);
      if (JSON.stringify(cur) !== JSON.stringify(val)) {
        changes.push([dotPath, val]);
      }
    }
  }
  walk(parsed, '');
  return changes;
}

function _getDotPath(obj, dotPath) {
  const parts = dotPath.split('.');
  let cur = obj;
  for (const p of parts) {
    if (cur == null) return undefined;
    cur = cur[p];
  }
  return cur;
}

// v7.5.7-fix Phase 2: Tab switching for the redesigned settings modal.
function _wireSettingsTabs() {
  const tabs = document.querySelectorAll('.settings-tab');
  if (!tabs.length || tabs[0]._wired) return;
  for (const tab of tabs) {
    tab._wired = true;
    tab.addEventListener('click', () => {
      const target = tab.getAttribute('data-tab');
      // Toggle tab buttons
      for (const t of document.querySelectorAll('.settings-tab')) t.classList.remove('active');
      tab.classList.add('active');
      // Toggle panels
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
  // (e.g. ollama unreachable) doesn't leave _fallbackState in a stale
  // "loaded" state where saveSettings would persist the empty chain.
  if (typeof _fallbackState !== 'undefined') _fallbackState.loaded = false;
  _wireSettingsTabs();
  _wireMcpAddButton();
  // v7.5.7-fix Phase 3 Etappe 3: add default-hints + reset buttons + validation
  _decorateAllFields();
  // v7.5.7-fix Phase 3 Etappe 4: JSON-Editor wiring + initial load
  _wireJsonEditorButtons();
  _loadJsonEditor();
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

    // v7.5.7-fix Phase 2: Auto-Routing toggle (default false now)
    _setBool('#set-auto-route', s?.agency?.autoRouteByTask);
    // Goal-Negotiation toggle
    _setBool('#set-negotiate', s?.agency?.negotiateBeforeAdd);
    // Cognitive strict mode
    _setBool('#set-cognitive-strict', s?.cognitive?.strictMode);

    // v7.5.7-fix Phase 2: Limits tab
    _setNum('#set-max-concurrent', s?.models?.maxConcurrent ?? 3);
    _setNum('#set-max-workers', s?.selfSpawner?.maxWorkers ?? 3);
    _setStr('#set-keep-alive', s?.models?.ollamaKeepAlive ?? '');
    _setNum('#set-kg-max-nodes', s?.knowledgeGraph?.maxNodes ?? 5000);
    _setNum('#set-sslog-max', s?.selfStatementLog?.maxStatements ?? 5000);

    // v7.5.7-fix Phase 3 Etappe 2: MCP servers now rendered editable below

    // v7.5.7-fix Phase 2: Erweitert tab
    _setNum('#set-sim-branches', s?.cognitive?.simulation?.maxBranches ?? 3);
    _setNum('#set-sim-depth', s?.cognitive?.simulation?.maxDepth ?? 15);
    _setNum('#set-emotion-decay-interval', s?.organism?.emotions?.decayIntervalMs ? Math.round(s.organism.emotions.decayIntervalMs / 1000) : null);
    _setNum('#set-loneliness-interval', s?.organism?.emotions?.lonelinessIntervalMs ? Math.round(s.organism.emotions.lonelinessIntervalMs / 1000) : null);
    _setNum('#set-idle-minutes', s?.idleMind?.idleMinutes ?? 2);
    _setNum('#set-think-minutes', s?.idleMind?.thinkMinutes ?? 3);
    _setNum('#set-daemon-cycle', s?.daemon?.cycleMinutes ?? 5);

    // v7.5.7-fix Phase 3 Etappe 2: Cost-Guard
    _setBool('#set-cost-guard-enabled', s?.llm?.costGuard?.enabled ?? true);
    _setNum('#set-cost-session-limit', s?.llm?.costGuard?.sessionTokenLimit ?? 500000);
    _setNum('#set-cost-daily-limit', s?.llm?.costGuard?.dailyTokenLimit ?? 2000000);
    _setNum('#set-cost-warn-threshold', s?.llm?.costGuard?.warnThreshold ? Math.round(s.llm.costGuard.warnThreshold * 100) : 80);

    // EventStore rotation
    _setNum('#set-eventstore-size', s?.eventStore?.maxFileSizeMB ?? 50);
    _setNum('#set-eventstore-rotations', s?.eventStore?.maxRotations ?? 3);

    // SelfSpawner timeout/memory
    _setNum('#set-spawner-timeout', s?.selfSpawner?.timeoutMs ? Math.round(s.selfSpawner.timeoutMs / 1000) : 300);
    _setNum('#set-spawner-memory', s?.selfSpawner?.memoryLimitMB ?? 256);

    // WorkerPool
    _setNum('#set-workerpool-max', s?.workerPool?.maxWorkers ?? 0);

    // EpisodicMemory
    _setNum('#set-episodic-max', s?.episodicMemory?.maxEpisodes ?? 500);

    // IdleMind extras
    _setNum('#set-idlemind-max-goals', s?.idleMind?.maxActiveGoals ?? 3);
    _setNum('#set-idlemind-journal-size', s?.idleMind?.journalMaxFileSizeMB ?? 10);
    _setNum('#set-idlemind-journal-rotations', s?.idleMind?.journalMaxRotations ?? 3);

    // Daemon sub-toggles
    _setBool('#set-daemon-auto-repair', s?.daemon?.autoRepair ?? true);
    _setBool('#set-daemon-auto-optimize', s?.daemon?.autoOptimize ?? false);

    // Security toggles
    _setBool('#set-allow-peers', s?.security?.allowNetworkPeers ?? true);
    _setBool('#set-allow-file-exec', s?.security?.allowFileExecution ?? true);
    _setBool('#set-commit-on-shutdown', s?.agency?.commitSnapshotOnShutdown ?? false);
    _setBool('#set-git-auto-init',       s?.agency?.gitAutoInit ?? false);
    _setBool('#set-git-auto-commit',     s?.agency?.gitAutoCommit ?? false);
    // v7.5.9 ZIP6 — Install-pipeline toggles.
    _setBool('#set-install-allow-auto', s?.install?.allowAutoInstall ?? false);
    _setBool('#set-install-full-autonomy', s?.install?.fullAutonomy ?? false);
    const scopeEl = document.querySelector('#set-install-scope');
    if (scopeEl) {
      const scope = s?.install?.scope ?? 'machine';
      scopeEl.value = ['machine', 'user', 'auto'].includes(scope) ? scope : 'machine';
    }

    // Health-Server
    _setBool('#set-health-http', s?.health?.httpEnabled ?? false);
    _setNum('#set-health-port', s?.health?.httpPort ?? 9090);

    // UI font sizes
    _setNum('#set-editor-font', s?.ui?.editorFontSize ?? 13);
    _setNum('#set-chat-font', s?.ui?.chatFontSize ?? 13);

    // OpenAI models list
    if ($('#set-openai-models')) {
      const models = Array.isArray(s?.models?.openaiModels) ? s.models.openaiModels : [];
      $('#set-openai-models').value = models.join(', ');
    }

    // MCP server list (editable)
    _renderMcpServers(Array.isArray(s?.mcp?.servers) ? s.mcp.servers : []);

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
        // v7.5.7-fix: Fallback chain — render as two interactive lists.
        // Replaces the v5.1.0 <select multiple size="3"> Ctrl+Click UI which
        // was unintuitive and frequently misread (markiert ≠ ausgewählt).
        const fbChain = Array.isArray(s?.models?.fallbackChain) ? [...s.models.fallbackChain] : [];
        renderFallbackUI(models, fbChain);
      }
    } catch (_e) { console.debug('[SETTINGS] Fallback model list:', _e.message); }

    // Don't pre-fill API keys — security
    $('#settings-modal').classList.remove('hidden');
  } catch (err) { console.debug('[SETTINGS] Load error:', err.message); }
}

// ── v7.5.7-fix: Pure logic helpers (testable without DOM) ────────────
// These functions encapsulate the mutation-rules of the fallback chain.
// They are pure (input → output), so they can be unit-tested directly.
// The DOM-rendering layer (_renderAvailable / _renderChain) calls these.

function fbAdd(chain, modelName) {
  if (!modelName || typeof modelName !== 'string') return chain.slice();
  if (chain.includes(modelName)) return chain.slice();
  return [...chain, modelName];
}

function fbRemove(chain, idx) {
  if (!Array.isArray(chain)) return [];
  if (!Number.isInteger(idx) || idx < 0 || idx >= chain.length) return chain.slice();
  const next = chain.slice();
  next.splice(idx, 1);
  return next;
}

function fbMove(chain, from, to) {
  if (!Array.isArray(chain)) return [];
  if (!Number.isInteger(from) || from < 0 || from >= chain.length) return chain.slice();
  if (!Number.isInteger(to) || to < 0 || to >= chain.length) return chain.slice();
  if (from === to) return chain.slice();
  const next = chain.slice();
  const [item] = next.splice(from, 1);
  next.splice(to, 0, item);
  return next;
}

function fbIsCloud(modelName) {
  // Match `:cloud` (qwen3-coder-next:cloud, kimi-k2.5:cloud) and the
  // `-cloud` variant some Ollama models use (qwen3-vl:235b-cloud).
  // The latter form is `<size>-cloud` not `:cloud`, so we accept either
  // a colon or hyphen as the separator.
  return typeof modelName === 'string' && /[:-]cloud(\b|$)/i.test(modelName);
}


// _fallbackState lives on the module scope so the click handlers (add,
// remove, move-up, move-down) can mutate it and re-render. We rebuild
// the DOM each time rather than incremental-updating because the lists
// are small (~24 entries) and the logic stays simple.
let _fallbackState = { available: [], chain: [] };

// v7.5.7-fix Phase 3 Etappe 2: MCP server list state.
// Each entry: { name: string, url: string }. URL can be HTTPS or stdio://.
let _mcpServersState = { servers: [] };

function _renderMcpServers(servers) {
  _mcpServersState.servers = Array.isArray(servers) ? servers.map(s => ({ ...s })) : [];
  const root = $('#mcp-servers-list');
  if (!root) return;
  root.innerHTML = '';
  if (_mcpServersState.servers.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'mcp-server-list-empty';
    empty.textContent = t('settings.mcp.empty');
    root.appendChild(empty);
    return;
  }
  _mcpServersState.servers.forEach((srv, idx) => {
    const row = document.createElement('div');
    row.className = 'mcp-server-row';
    const nameEl = document.createElement('span');
    nameEl.className = 'mcp-server-name';
    nameEl.textContent = srv.name || '(unnamed)';
    const urlEl = document.createElement('span');
    urlEl.className = 'mcp-server-url';
    urlEl.textContent = srv.url || '';
    urlEl.title = srv.url || '';
    const removeBtn = document.createElement('button');
    removeBtn.className = 'mcp-server-remove';
    removeBtn.type = 'button';
    removeBtn.textContent = t('ui.remove');
    removeBtn.addEventListener('click', () => {
      _mcpServersState.servers.splice(idx, 1);
      _renderMcpServers(_mcpServersState.servers);
    });
    row.appendChild(nameEl);
    row.appendChild(urlEl);
    row.appendChild(removeBtn);
    root.appendChild(row);
  });
}

// Wired in _wireSettingsTabs() via openSettings — bound once per modal open.
function _wireMcpAddButton() {
  const btn = $('#btn-mcp-server-add');
  if (!btn) return;
  // Always re-translate the button label so language switch picks up
  btn.textContent = t('ui.add');
  if (btn._wired) return;
  btn._wired = true;
  btn.addEventListener('click', () => {
    const nameEl = $('#mcp-server-new-name');
    const urlEl = $('#mcp-server-new-url');
    const name = (nameEl?.value || '').trim();
    const url = (urlEl?.value || '').trim();
    if (!name) { showToast(t('settings.mcp.error_name_missing'), 'error'); return; }
    if (!url) { showToast(t('settings.mcp.error_url_missing'), 'error'); return; }
    if (_mcpServersState.servers.some(s => s.name === name)) {
      const tpl = t('settings.mcp.error_exists');
      showToast(tpl.replace('{name}', name), 'error');
      return;
    }
    _mcpServersState.servers.push({ name, url });
    _renderMcpServers(_mcpServersState.servers);
    if (nameEl) nameEl.value = '';
    if (urlEl) urlEl.value = '';
  });
}


function isCloudModel(m) {
  return fbIsCloud(m?.name);
}

function renderFallbackUI(allModels, chain) {
  _fallbackState.available = allModels || [];
  _fallbackState.chain = chain || [];
  _renderAvailable();
  _renderChain();
}

function _renderAvailable() {
  const root = $('#fallback-available');
  if (!root) return;
  root.innerHTML = '';
  for (const m of _fallbackState.available) {
    const li = document.createElement('li');
    li.className = 'fallback-item';
    const name = document.createElement('span');
    name.className = 'fallback-item-name';
    name.textContent = m.name;
    name.title = m.name;
    li.appendChild(name);
    if (isCloudModel(m)) {
      const cloud = document.createElement('span');
      cloud.className = 'fallback-item-cloud';
      cloud.textContent = '☁';
      cloud.title = 'Cloud model — may need Ollama Pro subscription';
      li.appendChild(cloud);
    }
    const backend = document.createElement('span');
    backend.className = 'fallback-item-backend';
    backend.textContent = m.backend || '?';
    li.appendChild(backend);
    const btn = document.createElement('button');
    btn.className = 'fallback-btn fallback-btn-add';
    btn.type = 'button';
    btn.textContent = '+ Add';
    btn.title = 'Add to fallback chain';
    const inChain = _fallbackState.chain.includes(m.name);
    btn.disabled = inChain;
    if (inChain) btn.title = 'Already in chain';
    btn.addEventListener('click', () => _addToChain(m.name));
    li.appendChild(btn);
    root.appendChild(li);
  }
}

function _renderChain() {
  const root = $('#fallback-chain');
  const empty = $('#fallback-chain-empty');
  if (!root) return;
  root.innerHTML = '';
  if (_fallbackState.chain.length === 0) {
    if (empty) empty.classList.remove('hidden');
    return;
  }
  if (empty) empty.classList.add('hidden');
  _fallbackState.chain.forEach((modelName, idx) => {
    const meta = _fallbackState.available.find(m => m.name === modelName);
    const li = document.createElement('li');
    li.className = 'fallback-item';
    const pos = document.createElement('span');
    pos.className = 'fallback-item-pos';
    pos.textContent = String(idx + 1);
    li.appendChild(pos);
    const name = document.createElement('span');
    name.className = 'fallback-item-name';
    name.textContent = modelName;
    name.title = modelName;
    li.appendChild(name);
    if (meta && isCloudModel(meta)) {
      const cloud = document.createElement('span');
      cloud.className = 'fallback-item-cloud';
      cloud.textContent = '☁';
      cloud.title = 'Cloud model';
      li.appendChild(cloud);
    }
    const up = document.createElement('button');
    up.className = 'fallback-btn'; up.type = 'button'; up.textContent = '↑';
    up.title = 'Move up'; up.disabled = (idx === 0);
    up.addEventListener('click', () => _moveInChain(idx, idx - 1));
    li.appendChild(up);
    const down = document.createElement('button');
    down.className = 'fallback-btn'; down.type = 'button'; down.textContent = '↓';
    down.title = 'Move down'; down.disabled = (idx === _fallbackState.chain.length - 1);
    down.addEventListener('click', () => _moveInChain(idx, idx + 1));
    li.appendChild(down);
    const rm = document.createElement('button');
    rm.className = 'fallback-btn fallback-btn-remove'; rm.type = 'button';
    rm.textContent = '×'; rm.title = 'Remove from chain';
    rm.addEventListener('click', () => _removeFromChain(idx));
    li.appendChild(rm);
    root.appendChild(li);
  });
}

function _addToChain(modelName) {
  const next = fbAdd(_fallbackState.chain, modelName);
  if (next === _fallbackState.chain) return;
  _fallbackState.chain = next;
  _renderAvailable();
  _renderChain();
}

function _removeFromChain(idx) {
  _fallbackState.chain = fbRemove(_fallbackState.chain, idx);
  _renderAvailable();
  _renderChain();
}

function _moveInChain(from, to) {
  _fallbackState.chain = fbMove(_fallbackState.chain, from, to);
  _renderChain();
}

function closeSettings() { $('#settings-modal').classList.add('hidden'); }

async function saveSettings() {
  // v7.5.7-fix Phase 3 Etappe 3: validate all fields before any IPC.
  // If anything is out-of-range, abort and surface the error visually.
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
  // v5.1.0: Preferred model selection
  const prefModel = $('#set-preferred-model')?.value;
  if (prefModel !== undefined) sets.push(['models.preferred', prefModel || null]);
  // v5.1.0: Per-task model roles
  for (const role of ['chat', 'code', 'analysis', 'creative']) {
    const val = $(`#set-role-${role}`)?.value || null;
    sets.push([`models.roles.${role}`, val]);
  }
  // v7.5.7-fix: Fallback chain — read from _fallbackState (populated by
  // openSettings → renderFallbackUI). The state is the source of truth;
  // the DOM is just its current rendering. We always persist, even if
  // empty, because clearing the chain is a valid user action.
  sets.push(['models.fallbackChain', Array.isArray(_fallbackState.chain) ? [..._fallbackState.chain] : []]);
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
    if (!Number.isNaN(t) && t >= 10 && t <= 3600) sets.push(['timeouts.approvalSec', t]);
  }

  // v7.5.7-fix Phase 2: Behavior tab — new toggles
  const autoRouteEl = $('#set-auto-route');
  if (autoRouteEl) sets.push(['agency.autoRouteByTask', autoRouteEl.value === 'true']);
  const negotiateEl = $('#set-negotiate');
  if (negotiateEl) sets.push(['agency.negotiateBeforeAdd', negotiateEl.value === 'true']);
  const cogStrictEl = $('#set-cognitive-strict');
  if (cogStrictEl) sets.push(['cognitive.strictMode', cogStrictEl.value === 'true']);

  // v7.5.7-fix Phase 2: Limits tab
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

  // Keep-alive: empty string = null = use Ollama default
  const keepAliveEl = $('#set-keep-alive');
  if (keepAliveEl) {
    const v = keepAliveEl.value.trim();
    sets.push(['models.ollamaKeepAlive', v === '' ? null : v]);
  }

  // v7.5.7-fix Phase 2: Erweitert tab
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

  // v7.5.7-fix Phase 3 Etappe 2: Cost-Guard
  const cgEnEl = $('#set-cost-guard-enabled');
  if (cgEnEl) sets.push(['llm.costGuard.enabled', cgEnEl.value === 'true']);
  _intIfValid('#set-cost-session-limit', 'llm.costGuard.sessionTokenLimit', 1000, 10000000);
  _intIfValid('#set-cost-daily-limit',   'llm.costGuard.dailyTokenLimit',   1000, 50000000);
  const warnEl = $('#set-cost-warn-threshold');
  if (warnEl?.value) {
    const pct = parseInt(warnEl.value, 10);
    if (!Number.isNaN(pct) && pct >= 50 && pct <= 99) sets.push(['llm.costGuard.warnThreshold', pct / 100]);
  }

  // EventStore rotation
  _intIfValid('#set-eventstore-size',      'eventStore.maxFileSizeMB', 0, 500);
  _intIfValid('#set-eventstore-rotations', 'eventStore.maxRotations',  0, 10);

  // SelfSpawner timeout/memory
  const spawnTimeoutEl = $('#set-spawner-timeout');
  if (spawnTimeoutEl?.value) {
    const sec = parseInt(spawnTimeoutEl.value, 10);
    if (!Number.isNaN(sec) && sec >= 10 && sec <= 3600) sets.push(['selfSpawner.timeoutMs', sec * 1000]);
  }
  _intIfValid('#set-spawner-memory', 'selfSpawner.memoryLimitMB', 64, 4096);

  // WorkerPool
  _intIfValid('#set-workerpool-max', 'workerPool.maxWorkers', 0, 16);

  // EpisodicMemory
  _intIfValid('#set-episodic-max', 'episodicMemory.maxEpisodes', 0, 50000);

  // IdleMind extras
  _intIfValid('#set-idlemind-max-goals',         'idleMind.maxActiveGoals',       1, 20);
  _intIfValid('#set-idlemind-journal-size',      'idleMind.journalMaxFileSizeMB', 1, 500);
  _intIfValid('#set-idlemind-journal-rotations', 'idleMind.journalMaxRotations',  0, 10);

  // Daemon sub-toggles
  const daemonRepairEl = $('#set-daemon-auto-repair');
  if (daemonRepairEl) sets.push(['daemon.autoRepair', daemonRepairEl.value === 'true']);
  const daemonOptEl = $('#set-daemon-auto-optimize');
  if (daemonOptEl) sets.push(['daemon.autoOptimize', daemonOptEl.value === 'true']);

  // Security toggles
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
  // v7.5.9 ZIP6 — Install-pipeline toggles.
  const installAutoEl = $('#set-install-allow-auto');
  if (installAutoEl) sets.push(['install.allowAutoInstall', installAutoEl.value === 'true']);
  const installFullEl = $('#set-install-full-autonomy');
  if (installFullEl) sets.push(['install.fullAutonomy', installFullEl.value === 'true']);
  const installScopeEl = $('#set-install-scope');
  if (installScopeEl && ['machine', 'user', 'auto'].includes(installScopeEl.value)) {
    sets.push(['install.scope', installScopeEl.value]);
  }

  // Health-Server
  const healthEl = $('#set-health-http');
  if (healthEl) sets.push(['health.httpEnabled', healthEl.value === 'true']);
  _intIfValid('#set-health-port', 'health.httpPort', 1024, 65535);

  // UI font sizes
  _intIfValid('#set-editor-font', 'ui.editorFontSize', 10, 24);
  _intIfValid('#set-chat-font',   'ui.chatFontSize',   10, 24);

  // OpenAI models list (comma-separated → array, drop empties)
  const oaiModelsEl = $('#set-openai-models');
  if (oaiModelsEl) {
    const list = oaiModelsEl.value.split(',').map(s => s.trim()).filter(s => s.length > 0);
    sets.push(['models.openaiModels', list]);
  }

  // MCP servers list (full replace from state)
  sets.push(['mcp.servers', _mcpServersState.servers.map(s => ({ name: s.name, url: s.url }))]);

  // v7.5.7-fix Phase 3 Etappe 4: merge JSON-Editor changes into the batch.
  // The JSON-Editor lets users edit the ~50 settings not exposed as
  // dedicated UI fields. We diff against current settings and append only
  // actual changes. If the JSON is invalid, we abort with a toast — same
  // policy as range-validation: don't half-save.
  const jsonChanges = await _collectJsonEditorChanges();
  if (jsonChanges === null) {
    showToast('JSON-Editor: ungültiges JSON. Speichern abgebrochen.', 'error');
    return;
  }
  if (jsonChanges.length > 0) {
    // Append, but don't overwrite if a same-path entry came from a regular UI field.
    // Form-field saves take precedence — they have explicit min/max validation.
    const existingKeys = new Set(sets.map(([k]) => k));
    for (const [k, v] of jsonChanges) {
      if (!existingKeys.has(k)) sets.push([k, v]);
    }
  }

  // v7.5.7-fix Phase 3: single batch call instead of N individual IPCs.
  // Reduces log spam (e.g. "Roles updated" 4x became 1x), improves
  // perceived save latency, and ensures atomic application of all values.
  // Falls back to individual sets if batch handler is missing (older main.js).
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
  closeSettings();
  showToast(t('ui.settings_saved'), 'success');

  // v5.1.0: Refresh model dropdown after save (API keys or preferred model may have changed)
  window.dispatchEvent(new Event('genesis:reload-models'));
}

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
      // v7.7.0 (A3): variable name now matches the lang-string
      // 'Change reverted: {{detail}}' — was {commit:...} which mismatched
      // and (after the i18n {{var}} regex fix) would have left the
      // placeholder literal in the toast.
      showToast(t('ui.undo_success', { detail: result.reverted }), 'success');
      // v7.7.0 (A3 bonus): the lang-key 'ui.undo_detail' does not exist
      // in Language.js — the t() call returned the key itself, leaving
      // chat with the literal text "↩ ui.undo_detail" after every undo.
      // Inline result.detail directly (matches legacy renderer.js Z.414).
      addMessage('agent', `↩ ${result.detail || ''}`, 'undo');
    } else {
      // v7.7.0 (A4): nothing-to-undo is a benign no-op, not a failure —
      // surface as warning, not error. Real exceptions still go through
      // the catch below as 'error'.
      showToast(result.error || t('ui.undo_nothing'), 'warning');
    }
  } catch (err) { showToast(t('ui.undo_failed', { error: err.message }), 'error'); }
}

function setupDragDrop() {
  const chatPanel = $('#chat-panel');
  if (!chatPanel) return;

  chatPanel.addEventListener('dragover', (e) => { e.preventDefault(); chatPanel.classList.add('drag-over'); });
  chatPanel.addEventListener('dragleave', () => { chatPanel.classList.remove('drag-over'); });
  chatPanel.addEventListener('drop', async (e) => {
    e.preventDefault();
    chatPanel.classList.remove('drag-over');
    // v7.7.0: not-ready guard — agent:import-file IPC needs backend ready.
    if (!isAgentReady()) {
      showToast(t('ui.still_starting'), 'warning');
      return;
    }
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

/**
 * Re-render everything in the settings modal that depends on the
 * current language but isn't a static [data-i18n] element. Called
 * from the language-switch handler in renderer.js after applyI18n().
 *
 * Idempotent and cheap if the modal isn't open / fields aren't yet
 * decorated.
 */
function refreshSettingsI18n() {
  // Re-render default-hints for all decorated fields
  for (const id of Object.keys(FIELD_REGISTRY)) {
    const el = document.getElementById(id);
    if (el && el._decorated) _decorateField(id);
  }
  // Update reset-button titles
  _refreshResetTitles();
  // Re-render MCP server list (empty-state + Remove button labels)
  if (Array.isArray(_mcpServersState.servers)) {
    _renderMcpServers(_mcpServersState.servers);
  }
  // Update MCP add-button label
  const addBtn = document.querySelector('#btn-mcp-server-add');
  if (addBtn) addBtn.textContent = t('ui.add');
}

module.exports = {
  openSettings, closeSettings, saveSettings,
  showGoalTree, undoLastChange, setupDragDrop, autoResize,
  refreshSettingsI18n,
  // v7.5.7-fix: pure helpers exported for unit-testing
  _fbHelpers: { fbAdd, fbRemove, fbMove, fbIsCloud },
};
