// ============================================================
// GENESIS — src/agent/foundation/SettingsPersistence.js
//
// v7.9.29 (hygiene): load/save/merge/env-override + on-load numeric
// clamping, extracted from Settings to keep it under the 700-LOC guard.
// The defaults tree stays in Settings (heavily source-asserted). Methods
// mounted onto Settings.prototype via the mixin, mirroring the existing
// SettingsEncryption extraction. this.* only; no behaviour change.
// ============================================================

const path = require('path');
const { createLogger } = require('../core/Logger');
const _log = createLogger('Settings');

class _SettingsPersistenceHost {

  /**
   * v7.5.7-fix Phase 3 Etappe 3: Clamp known numeric settings to valid ranges.
   * Logs a warning when clamping; does not throw. Mirror of the UI's
   * settings-defaults.js registry.
   */
  _sanityClampOnLoad() {
    const log = (msg) => { try { require('../core/Logger').createLogger('Settings').warn(`[SANITY] ${msg}`); } catch (_e) { /* logger optional */ } };
    const clamp = (path, min, max) => {
      const v = this.get(path);
      if (typeof v !== 'number' || Number.isNaN(v)) return;
      if (v < min) { this._setRaw(path, min); log(`${path}=${v} clamped to ${min} (min)`); }
      else if (v > max) { this._setRaw(path, max); log(`${path}=${v} clamped to ${max} (max)`); }
    };
    clamp('models.maxConcurrent',                 1, 50);
    clamp('selfSpawner.maxWorkers',               1, 50);
    clamp('selfSpawner.timeoutMs',                10000, 3600000);
    clamp('selfSpawner.memoryLimitMB',            64, 8192);
    clamp('workerPool.maxWorkers',                0, 64);
    clamp('eventStore.maxFileSizeMB',             0, 5000);
    clamp('eventStore.maxRotations',              0, 100);
    clamp('knowledgeGraph.maxNodes',              0, 1000000);
    clamp('selfStatementLog.maxStatements',       0, 1000000);
    clamp('episodicMemory.maxEpisodes',           0, 1000000);
    // v7.7.9: InnerSpeech capacity bounded so badly-edited settings don't
    // allocate enormous arrays. 1..10000 covers reasonable use cases.
    clamp('innerSpeech.capacity',                 1, 10000);
    // v7.7.9 Phase 2: PSE numeric clamps. Bounded so badly-edited settings
    // can't disable the boundary altogether. minIntervalMs ≥ 30s prevents
    // accidental flooding; baseThreshold ∈ [0,1] is a score; maxChars
    // bounded so PSE can't push novella-length messages.
    clamp('proactive.minIntervalMs',              30 * 1000, 24 * 60 * 60 * 1000);
    clamp('proactive.userActivityCooldownMs',     0,         24 * 60 * 60 * 1000);
    clamp('proactive.baseThreshold',              0,         1);
    clamp('proactive.maxChars',                   50,        4000);
    clamp('proactive.dailyVolumeSoftCap',         0,         100);
    // v7.7.9 Phase 3: StalledGoalWatchdog timeouts. timeoutMs ≥ 60s
    // prevents accidental over-aggressive stall-flagging. tickMs ≥ 5s
    // prevents busy-loop scans, ≤ 10 min prevents drift on long-running
    // sessions.
    clamp('goals.stalledTimeoutMs',               60 * 1000, 24 * 60 * 60 * 1000);
    clamp('goals.stalledWatchdogTickMs',          5 * 1000,  10 * 60 * 1000);
    clamp('llm.costGuard.sessionTokenLimit',      1000, 100000000);
    clamp('llm.costGuard.dailyTokenLimit',        1000, 1000000000);
    clamp('llm.costGuard.warnThreshold',          0.5, 0.99);
    clamp('idleMind.idleMinutes',                 1, 1440);
    clamp('idleMind.thinkMinutes',                1, 1440);
    clamp('idleMind.maxActiveGoals',              1, 100);
    clamp('idleMind.journalMaxFileSizeMB',        1, 5000);
    clamp('idleMind.journalMaxRotations',         0, 100);
    // v7.9.4: goal-activity balance. 0 = legacy always-goal-step,
    // 1-50 = break every N steps. Above 50 effectively disables it.
    clamp('idleMind.goalStepsPerActivityPick',    0, 50);
    clamp('daemon.cycleMinutes',                  1, 1440);
    clamp('mcp.serve.port',                       1024, 65535);
    // v7.9.46: knock budget for the vestibule responder. Floor keeps a typo
    // from making every knock absent; ceiling keeps a visitor from hanging.
    clamp('mcp.serve.knockTimeoutMs',             5000, 300000);
    clamp('health.httpPort',                      1024, 65535);
    clamp('timeouts.approvalSec',                  0, 86400);
    // v7.9.5 live-fix: shutdown summary protection
    clamp('shutdown.sessionSummaryMinMs',         0, 86400000);
    clamp('shutdown.sessionSummaryTimeoutMs',     500, 120000);
    // v7.9.5 live-fix: continuation-loop attempt cap
    clamp('llm.continuation.maxAttempts',         1, 20);
    // v7.9.13: stream-timeout bounds (ms). JSON-only expert settings, so
    // clamp() is the only guard — there is no FIELD_REGISTRY min/max for
    // these. Floors keep a misconfiguration from aborting mid-token;
    // ceilings keep a typo from disabling the runaway-generation
    // protection entirely.
    clamp('llm.streamTimeouts.firstChunk',        10000,  600000);
    clamp('llm.numCtxCap',                        4096,   262144); // v7.9.37 pass 4
    clamp('llm.maxTokensDefault',                 0,      32768);
    clamp('llm.streamTimeouts.chunk',             5000,   120000);
    clamp('llm.streamTimeouts.total',             60000,  1800000);
    clamp('llm.streamTimeouts.continuationTotal', 120000, 3600000);
    // v7.9.14: local/cloud response-timeout bounds (ms). These ARE
    // FIELD_REGISTRY-surfaced (set-local-timeout / set-cloud-timeout in
    // Limits-tab, seconds with _scaleMs), but the registry's min/max
    // only fires in the UI write path — a direct edit to settings.json
    // would bypass it. clamp() at load is the second gate so the
    // values are guaranteed in-range however they got there.
    // Ranges match FIELD_REGISTRY exactly (30s-15min, 60s-15min);
    // anti-drift guard test asserts the equality, so this comment
    // and the registry cannot silently diverge.
    clamp('llm.localTimeoutMs',                   30000,  900000);  // 30s-15min, registry: 30-900
    clamp('llm.cloudTimeoutMs',                   60000,  900000);  // 60s-15min, registry: 60-900
    // v7.9.5 live-fix: ArchReflect rebuild staleness — 1 min floor (don't
    // rebuild constantly), 1 day ceiling (don't go forever between rebuilds).
    clamp('cognitive.architectureReflection.staleThresholdMs', 60000, 86400000);
    clamp('cognitive.simulation.maxBranches',     1, 100);
    clamp('cognitive.simulation.maxDepth',        1, 1000);
    clamp('organism.emotions.decayIntervalMs',    1000, 3600000);
    clamp('organism.emotions.lonelinessIntervalMs', 1000, 86400000);
    // v7.9.5: Inhabit cooldown — 1 minute floor (don't allow per-cycle spam),
    // 1440 ceiling (once-a-day is the slowest reasonable cadence).
    clamp('organism.inhabit.cooldownMinutes',     1, 1440);
    clamp('ui.editorFontSize',                    8, 48);
    clamp('ui.chatFontSize',                      8, 48);
    // v7.9.8: trust.level clamp removed. Validation lives in
    // TrustLevelSystem._migrateLevel — the domain owner — so old stored
    // values from the 4-level system (0..3) reach the migration intact.
    // Clamping here to 0..2 first would collapse old level 3 (FULL) to
    // level 2 before the migration could see it as old-FULL.
  }
  _save() {
    try {
      // v3.7.1: Non-blocking via debounced async write.
      // Settings changes are user-triggered and infrequent — debounce is ideal.
      if (this.storage) this.storage.writeJSONDebounced('settings.json', this.data, 500);
    } catch (err) { _log.warn('[SETTINGS] Save failed:', err.message); }
  }

  /**
   * v3.8.0: Was async boot-time loading. Since v7.0.8, _load() runs in
   * constructor (sync) to avoid race conditions with ModelBridge.
   * asyncLoad() kept as no-op for Container.bootAll() compatibility.
   */
  async asyncLoad() {
    // _load() already called in constructor — nothing to do.
  }


  _load() {
    try {
      let loaded = null;
      if (this.storage) {
        loaded = this.storage.readJSON('settings.json', null);
      }
      if (loaded) {
        this.data = this._deepMerge(this.data, loaded);
        this._migratePlaintextKeys();
        // v7.6.6 Track A.3: Re-key legacy enc:/enc2: ciphertexts to enc3:
        // (installation-anchored). Atomic, idempotent, partial-success-safe.
        this._migrateLegacyEncryption();
        // v7.6.6 Track A.4: Detect enc3: values that fail to decrypt
        // (typically after .install-id rotation). Buffered for setBus()
        // to fire as settings:keys-unreadable.
        this._checkUnreadableV3Keys();
      }
    } catch (err) { _log.warn('[SETTINGS] Load failed, using defaults:', err.message); }

    // v5.9.0: Environment variable overrides (for headless/CI mode)
    this._applyEnvOverrides();
  }

  /**
   * v7.6.6 Track A.3: Re-key any legacy `enc:`/`enc2:` ciphertext to
   * `enc3:` using the installation-anchored key. Runs once on first
   * v7.6.6 boot of an existing install; idempotent on subsequent boots.
   *
   * Properties:
   *   - Pre-migration backup created before any rewrite
   *     (`settings.json.pre-v3-migration`, only if not already present)
   *   - Partial success accepted: keys whose legacy decrypt fails are
   *     left as-is and tracked in `_unreadableKeys` for the boot-time
   *     warning event
   *   - No-op when no install-id is available (cannot create v3 ciphertexts)
   *   - No-op when no legacy-prefix values are present
   *   - Single _save() at end so failure mid-loop does not leave a
   *     partially-written file (the in-memory state is the only thing
   *     mutated until save)
   */
  _deepMerge(target, source) {
    const result = { ...target };
    for (const key of Object.keys(source)) {
      if (source[key] && typeof source[key] === 'object' && !Array.isArray(source[key])) {
        result[key] = this._deepMerge(target[key] || {}, source[key]);
      } else { result[key] = source[key]; }
    }
    return result;
  }

  /** @private */
  _applyEnvOverrides() {
    const ENV_MAP = {
      'GENESIS_API_KEY':    'models.anthropicApiKey',
      'ANTHROPIC_API_KEY':  'models.anthropicApiKey',
      'GENESIS_OPENAI_KEY': 'models.openaiApiKey',
      'OPENAI_API_KEY':     'models.openaiApiKey',
      'GENESIS_MODEL':      'models.preferred',
    };
    for (const [env, dotPath] of Object.entries(ENV_MAP)) {
      const val = process.env[env]?.trim();
      if (val && val.length > 0) {
        this.set(dotPath, val);
        _log.info(`[SETTINGS] Applied env override: ${env} → ${dotPath}`);
      }
    }
  }
}

const settingsPersistenceMixin = {};
for (const name of Object.getOwnPropertyNames(_SettingsPersistenceHost.prototype)) {
  if (name !== 'constructor') settingsPersistenceMixin[name] = _SettingsPersistenceHost.prototype[name];
}

module.exports = { settingsPersistenceMixin };
