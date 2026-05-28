// ============================================================
// GENESIS — src/ui/modules/settings-defaults.js
//
// v7.5.7-fix Phase 3 Etappe 3 — Default + Range registry for UI fields.
//
// Single source of truth for:
//  - default values (mirror of Settings.js)
//  - min/max ranges (input validation + reset bounds)
//  - whether a field is reset-safe (API keys etc. are NOT reset-safe)
//
// Used by:
//  - settings.js: addDefaultHint(), addResetButton(), validateInput()
//
// To keep this in sync with Settings.js: any new entry here MUST have a
// matching default in Settings.js. Tests verify this in v757-fix-phase3-etappe3.
// ============================================================

'use strict';

// Field registry — id → { default, min, max, type, settingsPath, resetSafe }
// type: 'number' | 'bool' | 'string' | 'enum' | 'list' | 'password'
// resetSafe: true if "↺ Default" button should appear (false for API keys etc.)
const FIELD_REGISTRY = {
  // ── Modelle ───────────────────────────────────────────
  'set-anthropic-key':            { type: 'password', settingsPath: 'models.anthropicApiKey',          resetSafe: false, default: '' },
  'set-openai-url':               { type: 'string',   settingsPath: 'models.openaiBaseUrl',            resetSafe: true,  default: '', requiresRestart: true },
  'set-openai-key':               { type: 'password', settingsPath: 'models.openaiApiKey',             resetSafe: false, default: '' },
  'set-openai-models':            { type: 'list',     settingsPath: 'models.openaiModels',             resetSafe: true,  default: [], requiresRestart: true },
  'set-preferred-model':          { type: 'string',   settingsPath: 'models.preferred',                resetSafe: true,  default: null, requiresRestart: true },
  'set-role-chat':                { type: 'string',   settingsPath: 'models.roles.chat',               resetSafe: true,  default: null, requiresRestart: true },
  'set-role-code':                { type: 'string',   settingsPath: 'models.roles.code',               resetSafe: true,  default: null, requiresRestart: true },
  'set-role-analysis':            { type: 'string',   settingsPath: 'models.roles.analysis',           resetSafe: true,  default: null, requiresRestart: true },
  'set-role-creative':            { type: 'string',   settingsPath: 'models.roles.creative',           resetSafe: true,  default: null, requiresRestart: true },

  // ── Verhalten ─────────────────────────────────────────
  'set-daemon':                   { type: 'bool',     settingsPath: 'daemon.enabled',                  resetSafe: true,  default: true },
  'set-idle':                     { type: 'bool',     settingsPath: 'idleMind.enabled',                resetSafe: true,  default: true },
  'set-selfmod':                  { type: 'bool',     settingsPath: 'security.allowSelfModify',        resetSafe: true,  default: true },
  'set-trust-level':              { type: 'enum',     settingsPath: 'trust.level',                     resetSafe: true,  default: 0, options: [0,1,2] },
  'set-auto-resume':              { type: 'enum',     settingsPath: 'agency.autoResumeGoals',          resetSafe: true,  default: 'ask', options: ['ask','always','never'] },
  'set-auto-route':               { type: 'bool',     settingsPath: 'agency.autoRouteByTask',          resetSafe: true,  default: false },
  'set-negotiate':                { type: 'bool',     settingsPath: 'agency.negotiateBeforeAdd',       resetSafe: true,  default: false },
  'set-cognitive-strict':         { type: 'bool',     settingsPath: 'cognitive.strictMode',            resetSafe: true,  default: false },
  // v7.9.0 Phase 2 — Können-Konzept (Skill Crystallization) settings.
  'set-koennen-enabled':                  { type: 'bool',   settingsPath: 'cognitive.koennen.enabled',                                  resetSafe: true, default: true },
  'set-koennen-cryst-enabled':            { type: 'bool',   settingsPath: 'cognitive.koennen.crystallization.enabled',                  resetSafe: true, default: true, requiresRestart: true },
  'set-koennen-cryst-min-candidates':     { type: 'number', settingsPath: 'cognitive.koennen.crystallization.minCandidatesPerPattern',  resetSafe: true, default: 3,        min: 1,    max: 20, requiresRestart: true },
  'set-koennen-cryst-cooldown-ms':        { type: 'number', settingsPath: 'cognitive.koennen.crystallization.cooldownMs',               resetSafe: true, default: 21600000, min: 1000, max: 604800000, requiresRestart: true },
  'set-daemon-auto-repair':       { type: 'bool',     settingsPath: 'daemon.autoRepair',               resetSafe: true,  default: true },
  'set-daemon-auto-optimize':     { type: 'bool',     settingsPath: 'daemon.autoOptimize',             resetSafe: true,  default: false },
  'set-idlemind-max-goals':       { type: 'number',   settingsPath: 'idleMind.maxActiveGoals',         resetSafe: true,  default: 3,    min: 1,    max: 20, requiresRestart: true },
  'set-allow-peers':              { type: 'bool',     settingsPath: 'security.allowNetworkPeers',      resetSafe: true,  default: true },
  'set-allow-file-exec':          { type: 'bool',     settingsPath: 'security.allowFileExecution',     resetSafe: true,  default: true },
  'set-commit-on-shutdown':       { type: 'bool',     settingsPath: 'agency.commitSnapshotOnShutdown', resetSafe: true,  default: false },
  // v7.7.1-hotfix: gate Genesis git-auto-operations behind opt-in.
  'set-git-auto-init':            { type: 'bool',     settingsPath: 'agency.gitAutoInit',               resetSafe: true,  default: false },
  'set-git-auto-commit':          { type: 'bool',     settingsPath: 'agency.gitAutoCommit',             resetSafe: true,  default: false },

  // ── Limits ────────────────────────────────────────────
  'set-max-concurrent':           { type: 'number',   settingsPath: 'models.maxConcurrent',            resetSafe: true,  default: 3,    min: 1,    max: 10, requiresRestart: true },
  'set-max-workers':              { type: 'number',   settingsPath: 'selfSpawner.maxWorkers',          resetSafe: true,  default: 3,    min: 1,    max: 10, requiresRestart: true },
  'set-keep-alive':               { type: 'string',   settingsPath: 'models.ollamaKeepAlive',          resetSafe: true,  default: null, requiresRestart: true },
  // v7.9.12: Ollama HTTP idle-timeouts (seconds in UI, _scaleMs stores ms).
  // local = on-device models; cloud = Ollama-proxied *-cloud models which
  // need a longer ceiling (cold-load + proxy latency). requiresRestart since
  // the value is read once when the backend is constructed at boot.
  'set-local-timeout':            { type: 'number',   settingsPath: 'llm.localTimeoutMs',              resetSafe: true,  default: 180,  min: 30,   max: 900, _scaleMs: true, requiresRestart: true },
  'set-cloud-timeout':            { type: 'number',   settingsPath: 'llm.cloudTimeoutMs',              resetSafe: true,  default: 300,  min: 60,   max: 900, _scaleMs: true, requiresRestart: true },
  'set-kg-max-nodes':             { type: 'number',   settingsPath: 'knowledgeGraph.maxNodes',         resetSafe: true,  default: 5000, min: 0,    max: 100000, requiresRestart: true },
  'set-sslog-max':                { type: 'number',   settingsPath: 'selfStatementLog.maxStatements', resetSafe: true,  default: 5000, min: 0,    max: 100000, requiresRestart: true },
  'set-approval-timeout':         { type: 'number',   settingsPath: 'timeouts.approvalSec',            resetSafe: true,  default: 300,  min: 10,   max: 3600 },
  'set-cost-guard-enabled':       { type: 'bool',     settingsPath: 'llm.costGuard.enabled',           resetSafe: true,  default: true },
  'set-cost-session-limit':       { type: 'number',   settingsPath: 'llm.costGuard.sessionTokenLimit', resetSafe: true,  default: 500000,  min: 1000, max: 10000000 },
  'set-cost-daily-limit':         { type: 'number',   settingsPath: 'llm.costGuard.dailyTokenLimit',   resetSafe: true,  default: 2000000, min: 1000, max: 50000000 },
  'set-cost-warn-threshold':      { type: 'number',   settingsPath: 'llm.costGuard.warnThreshold',     resetSafe: true,  default: 80,   min: 50, max: 99,   _scalePct: true },
  'set-eventstore-size':          { type: 'number',   settingsPath: 'eventStore.maxFileSizeMB',        resetSafe: true,  default: 50,   min: 0,    max: 500, requiresRestart: true },
  'set-eventstore-rotations':     { type: 'number',   settingsPath: 'eventStore.maxRotations',         resetSafe: true,  default: 3,    min: 0,    max: 10, requiresRestart: true },
  'set-spawner-timeout':          { type: 'number',   settingsPath: 'selfSpawner.timeoutMs',           resetSafe: true,  default: 300,  min: 10,   max: 3600, _scaleMs: true, requiresRestart: true },
  'set-spawner-memory':           { type: 'number',   settingsPath: 'selfSpawner.memoryLimitMB',       resetSafe: true,  default: 256,  min: 64,   max: 4096, requiresRestart: true },
  'set-workerpool-max':           { type: 'number',   settingsPath: 'workerPool.maxWorkers',           resetSafe: true,  default: 0,    min: 0,    max: 16, requiresRestart: true },
  'set-episodic-max':             { type: 'number',   settingsPath: 'episodicMemory.maxEpisodes',      resetSafe: true,  default: 500,  min: 0,    max: 50000, requiresRestart: true },
  'set-idlemind-journal-size':    { type: 'number',   settingsPath: 'idleMind.journalMaxFileSizeMB',   resetSafe: true,  default: 10,   min: 1,    max: 500, requiresRestart: true },
  'set-idlemind-journal-rotations': { type: 'number', settingsPath: 'idleMind.journalMaxRotations',    resetSafe: true,  default: 3,    min: 0,    max: 10 },

  // ── MCP ───────────────────────────────────────────────
  'set-mcp-serve':                { type: 'bool',     settingsPath: 'mcp.serve.enabled',               resetSafe: true,  default: false },
  'set-mcp-port':                 { type: 'number',   settingsPath: 'mcp.serve.port',                  resetSafe: true,  default: 3580, min: 1024, max: 65535, requiresRestart: true },

  // ── Install / Auto-Install (Bug P) ─────────────────────
  'set-install-auto':             { type: 'bool',     settingsPath: 'agency.installAuto',              resetSafe: true,  default: false },
  'set-install-full':             { type: 'bool',     settingsPath: 'agency.installFull',              resetSafe: true,  default: false },
  'set-install-scope':            { type: 'enum',     settingsPath: 'agency.installScope',             resetSafe: true,  default: 'project', options: ['project','user','global'] },

  // ── Erweitert ─────────────────────────────────────────
  'set-sim-branches':             { type: 'number',   settingsPath: 'cognitive.simulation.maxBranches', resetSafe: true, default: 3,   min: 1,    max: 20, requiresRestart: true },
  'set-sim-depth':                { type: 'number',   settingsPath: 'cognitive.simulation.maxDepth',    resetSafe: true, default: 15,  min: 1,    max: 100, requiresRestart: true },
  'set-emotion-decay-interval':   { type: 'number',   settingsPath: 'organism.emotions.decayIntervalMs', resetSafe: true, default: 60, min: 5,   max: 3600, _scaleMs: true, requiresRestart: true },
  'set-loneliness-interval':      { type: 'number',   settingsPath: 'organism.emotions.lonelinessIntervalMs', resetSafe: true, default: 300, min: 30, max: 7200, _scaleMs: true, requiresRestart: true },
  'set-idle-minutes':             { type: 'number',   settingsPath: 'idleMind.idleMinutes',            resetSafe: true,  default: 2,    min: 1,    max: 120 },
  'set-think-minutes':            { type: 'number',   settingsPath: 'idleMind.thinkMinutes',           resetSafe: true,  default: 3,    min: 1,    max: 120 },
  'set-daemon-cycle':             { type: 'number',   settingsPath: 'daemon.cycleMinutes',             resetSafe: true,  default: 5,    min: 1,    max: 120, requiresRestart: true },
  'set-health-http':              { type: 'bool',     settingsPath: 'health.httpEnabled',              resetSafe: true,  default: false },
  'set-health-port':              { type: 'number',   settingsPath: 'health.httpPort',                 resetSafe: true,  default: 9090, min: 1024, max: 65535, requiresRestart: true },
  'set-editor-font':              { type: 'number',   settingsPath: 'ui.editorFontSize',               resetSafe: true,  default: 13,   min: 10,   max: 24 },
  'set-chat-font':                { type: 'number',   settingsPath: 'ui.chatFontSize',                 resetSafe: true,  default: 13,   min: 10,   max: 24 },
};

/**
 * Get registry entry for a field id, or null.
 * @param {string} id - HTML id (without leading #)
 */
function getFieldDefault(id) {
  return FIELD_REGISTRY[id] || null;
}

/**
 * Render a default+range hint element appropriate for the field type.
 * Returns an HTMLElement, or null if no hint applicable.
 *
 * @param {string} id            field id
 * @param {Document} doc         document for createElement
 * @param {Function} [translate] optional translate function (key) => string
 *                               If absent, falls back to German strings
 *                               (preserves original behaviour for callers
 *                               that don't pass it).
 */
function buildDefaultHint(id, doc, translate) {
  const meta = FIELD_REGISTRY[id];
  if (!meta) return null;
  const span = doc.createElement('span');
  span.className = 'setting-default-hint';

  // i18n helper — fallback to English originals if translate() not given
  // or if the key isn't in the dictionary (so we never render `{{key}}`).
  // v7.9.10: fallbacks anglicised. Previously they were German ('an',
  // 'aus', 'leer', 'Default') which leaked through in early-boot moments
  // before the i18n dictionary loaded, or in test contexts where no
  // translate function is supplied. With the v7.9.10 full fr+es
  // translation, the fallback path is unreachable for the four supported
  // languages anyway — but the right default when it does trigger is
  // English, not German.
  const t = (key, fallback) => {
    if (typeof translate !== 'function') return fallback;
    const v = translate(key);
    if (!v || v === key) return fallback;
    return v;
  };
  const L_DEFAULT = t('default_hint.label', 'Default');
  const L_MIN = t('default_hint.min', 'Min');
  const L_MAX = t('default_hint.max', 'Max');
  const L_ON = t('default_hint.on', 'on');
  const L_OFF = t('default_hint.off', 'off');
  const L_EMPTY = t('default_hint.empty', 'empty');

  let text = '';
  if (meta.type === 'number' && typeof meta.default === 'number') {
    text = `${L_DEFAULT}: ${meta.default}`;
    if (typeof meta.min === 'number' && typeof meta.max === 'number') {
      text += ` · ${L_MIN}: ${meta.min} · ${L_MAX}: ${meta.max}`;
    }
  } else if (meta.type === 'bool') {
    text = `${L_DEFAULT}: ${meta.default ? L_ON : L_OFF}`;
  } else if (meta.type === 'enum' && meta.default !== null && meta.default !== undefined) {
    // boolean-as-enum (true/false strings) deserves localized labels too
    if (meta.default === 'true' || meta.default === true)  text = `${L_DEFAULT}: ${L_ON}`;
    else if (meta.default === 'false' || meta.default === false) text = `${L_DEFAULT}: ${L_OFF}`;
    else text = `${L_DEFAULT}: ${meta.default}`;
  } else if (meta.type === 'string' && meta.default) {
    text = `${L_DEFAULT}: ${meta.default}`;
  } else if (meta.type === 'string' && (meta.default === null || meta.default === '')) {
    text = `${L_DEFAULT}: ${L_EMPTY}`;
  } else if (meta.type === 'list') {
    text = `${L_DEFAULT}: ${L_EMPTY}`;
  } else {
    return null;
  }
  // v7.9.3: append "(takes effect after restart)" badge for boot-only settings
  if (meta.requiresRestart) {
    const L_RESTART = t('ui.takes_effect_after_restart', '(takes effect after restart)');
    text += ' · ' + L_RESTART;
  }
  span.textContent = text;
  return span;
}

/**
 * Validate a field's current input value against its registered range.
 * Returns { ok: boolean, reason?: string }.
 *
 * @param {string} id           field id
 * @param {*} currentValue      raw input value
 * @param {Function} [translate] optional translate fn for reason strings
 */
function validateField(id, currentValue, translate) {
  const meta = FIELD_REGISTRY[id];
  if (!meta) return { ok: true };
  const t = (key, fallback) => {
    if (typeof translate !== 'function') return fallback;
    const v = translate(key);
    return (!v || v === key) ? fallback : v;
  };
  if (meta.type === 'number') {
    if (currentValue === '' || currentValue == null) return { ok: true }; // empty = use default
    const n = Number(currentValue);
    if (Number.isNaN(n)) return { ok: false, reason: t('default_hint.not_a_number', 'not a number') };
    if (typeof meta.min === 'number' && n < meta.min) return { ok: false, reason: `< ${t('default_hint.min','Min')} ${meta.min}` };
    if (typeof meta.max === 'number' && n > meta.max) return { ok: false, reason: `> ${t('default_hint.max','Max')} ${meta.max}` };
  }
  return { ok: true };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { FIELD_REGISTRY, getFieldDefault, buildDefaultHint, validateField };
}
if (typeof window !== 'undefined') {
  window.GenesisFieldRegistry = { FIELD_REGISTRY, getFieldDefault, buildDefaultHint, validateField };
}
