// @ts-checked-v5.8
// ============================================================
// GENESIS — Settings.js (v2 — with API key encryption)
// Persistent configuration. API keys are encrypted at rest
// using AES-256-GCM with a machine-derived key.
// Stored in .genesis/settings.json.
// ============================================================

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');
const { createLogger } = require('../core/Logger');
const { TIMEOUTS } = require('../core/Constants');
const _log = createLogger('Settings');

// v7.6.7 Track A: Encryption-at-rest concern extracted to SettingsEncryption.js
// (Mixin pattern, analog ModelBridgeFailover.js). Module-level helpers are
// invoked directly via `enc.encryptValue(...)` etc.; instance methods are
// mounted onto Settings.prototype at the bottom of this file.
const enc = require('./SettingsEncryption');
const persistence = require('./SettingsPersistence'); // v7.9.29 (hygiene)
const { defaultSettings } = require('./SettingsDefaults'); // v7.9.47 (hygiene)
const {
  SENSITIVE_KEYS,
  ENC_PREFIX,
  ENC_PREFIX_V2,
  ENC_PREFIX_V3,
  encryptValue,
  decryptValue,
} = enc;

// v7.4.7: Settings whose changes need runtime side-effects (start/stop
// services, gate runtime behavior). Mapped to bus events that
// AgentCoreWire listens for. Settings whose change requires a restart
// to take effect (e.g. timeouts.approvalSec injected into agentLoop)
// are NOT in this map — they're advisory-only via the UI hint.
const TOGGLE_EVENT_KEYS = {
  'daemon.enabled':            'settings:daemon-toggled',
  'idleMind.enabled':          'settings:idlemind-toggled',
  'security.allowSelfModify':  'settings:selfmod-toggled',
  'trust.level':               'settings:trust-level-changed',
  'agency.autoResumeGoals':    'settings:auto-resume-changed',
  'agency.autoRouteByTask':    'settings:auto-route-toggled',  // v7.5.2
  'mcp.serve.enabled':         'settings:mcp-serve-toggled',
  // v7.9.0 Phase 2: Können-Pipeline toggles.
  'cognitive.koennen.enabled':                 'settings:koennen-toggled',
  'cognitive.koennen.crystallization.enabled': 'settings:koennen-crystallization-toggled',
  // v7.9.4: Können Phase 3 toggles.
  'cognitive.koennen.promotion.enabled':                          'settings:koennen-promotion-toggled',
  'cognitive.koennen.rehearsal.enabled':                          'settings:koennen-rehearsal-toggled',
  'cognitive.koennen.crystallization.acquisitionContext.enabled': 'settings:koennen-context-toggled',
};

class Settings {
  constructor(storageDir, storage) {
    this.storage = storage || null;
    this._storageDir = storageDir;
    this.filePath = path.join(storageDir, 'settings.json');
    // v7.4.7: Optional bus for emitting setting-change events.
    // Set later via setBus(). Used so that Daemon/IdleMind/SelfMod
    // toggles take effect at runtime, not just at next boot.
    this._bus = null;
    // v7.6.6 Track A: installation-anchored encryption.
    // Lazy-loaded on first crypto operation via _getInstallId().
    // Sentinel '' = "tried, failed, fall back to legacy hostname-key".
    this._installId = null;
    // v7.6.6 Track A.4: SENSITIVE_KEYS that could not be decrypted during
    // load/migration. Fired as settings:keys-unreadable from setBus()
    // once the bus is available, then cleared.
    this._unreadableKeys = [];
    // FIX v4.10.0 (M-4): Use a randomly generated salt persisted to disk.
    // Previously, salt was deterministic from storageDir path — an attacker
    // with local access could reconstruct the key without brute force.
    // Random salt is generated on first run and stored in .genesis/enc-salt.
    this._encSalt = this._loadOrCreateSalt(storageDir);
    this.data = defaultSettings();
    // FIX v7.0.8: Moved _load() back into constructor (was asyncLoad since v3.8.0).
    // _load() is synchronous (readJSON is sync). Having it in asyncLoad() caused a
    // race condition: ModelBridge.asyncLoad() runs concurrently in the same boot level
    // and reads models.preferred BEFORE Settings._load() applies env overrides.
    // Result: GENESIS_MODEL env var was ignored, auto-select picked wrong model.
    this._load();
    // v7.5.7-fix Phase 3 Etappe 3: Sanity-clamp known numeric fields after load.
    // Without this, a malformed settings.json (manual edit, copied from older
    // version) could make Genesis crash because e.g. maxConcurrent=-1 or
    // sessionTokenLimit=NaN gets passed to schedulers/budgets.
    this._sanityClampOnLoad();
  }

  /** Internal: write value at dot-path without touching events or _save. */
  _setRaw(dotPath, value) {
    const parts = dotPath.split('.');
    let obj = this.data;
    for (let i = 0; i < parts.length - 1; i++) {
      if (!obj[parts[i]] || typeof obj[parts[i]] !== 'object') return;
      obj = obj[parts[i]];
    }
    obj[parts[parts.length - 1]] = value;
  }

  /**
   * v7.6.6 Track A: Lazy-load the installation UUID from `.install-id`.
   * Cached in this._installId. Sentinel '' on failure (fall back to
   * legacy hostname-derived key for encrypt/decrypt). Returns null when
   * the cached sentinel is empty so callers see a clean tri-state:
   * UUID-string | null.
   */
  _getInstallId() {
    if (this._installId !== null) {
      return this._installId || null;
    }
    try {
      const { getOrCreate } = require('./InstallId.js');
      this._installId = getOrCreate(this._storageDir);
    } catch (err) {
      _log.warn(`[SETTINGS] InstallId unavailable, falling back to legacy machine-id: ${err.message}`);
      this._installId = ''; // sentinel: tried, failed
    }
    return this._installId || null;
  }

  /**
   * v7.4.7: Late-bind a bus so set() can emit toggle events for
   * Daemon/IdleMind/SelfMod runtime toggles. Called from AgentCoreWire
   * after Settings is resolved (Settings is in phase 0, bus also).
   *
   * v7.6.6 Track A.4: Also fires settings:keys-unreadable for any
   * SENSITIVE_KEYS that failed to decrypt during load (e.g. after
   * `.install-id` rotation). Buffer is cleared after fire so subsequent
   * setBus() calls do not refire the same event.
   * @param {*} bus
   */
  setBus(bus) {
    this._bus = bus || null;
    if (this._bus && this._unreadableKeys.length > 0) {
      try {
        this._bus.fire('settings:keys-unreadable', { keys: this._unreadableKeys.slice() }, { source: 'Settings' });
      } catch (_e) { /* never let event-fire break setBus */ }
      this._unreadableKeys = [];
    }
  }

  set(dotPath, value) {
    const parts = dotPath.split('.');
    let obj = this.data;
    for (let i = 0; i < parts.length - 1; i++) {
      if (!obj[parts[i]] || typeof obj[parts[i]] !== 'object') obj[parts[i]] = {};
      obj = obj[parts[i]];
    }
    // v7.4.7: capture old value BEFORE write so toggle events can be
    // emitted with from/to. Used for runtime daemon/idleMind/selfMod
    // toggles — without this, AgentCoreWire's listener can't tell if
    // the value actually changed.
    const oldValue = obj[parts[parts.length - 1]];
    if (SENSITIVE_KEYS.has(dotPath) && value && typeof value === 'string'
        && !value.startsWith(ENC_PREFIX)
        && !value.startsWith(ENC_PREFIX_V2)
        && !value.startsWith(ENC_PREFIX_V3)) {
      obj[parts[parts.length - 1]] = encryptValue(value, this._encSalt, this._getInstallId());
    } else {
      obj[parts[parts.length - 1]] = value;
    }
    this._save();
    // v7.4.7: Emit toggle events for runtime-relevant settings.
    // Listened to in AgentCoreWire to start/stop services live.
    if (this._bus && oldValue !== value) {
      const eventKey = TOGGLE_EVENT_KEYS[dotPath];
      if (eventKey) {
        try {
          this._bus.fire(eventKey, { from: oldValue, to: value, key: dotPath }, { source: 'Settings' });
        } catch (_e) { /* never let event-emit break a save */ }
      }
    }
  }

  /**
   * v7.5.7-fix Phase 3: batch-set multiple settings in a single call.
   * UI was previously sending one IPC per setting (4-8 per Save click),
   * each triggering listeners (e.g. ModelBridge.setRoles → log spam).
   * This call writes everything, then emits toggle events once at the end.
   *
   * Returns array of changes for caller (e.g. for change-log display).
   *
   * @param {Array<[string, *]>} entries - [dotPath, value] pairs
   * @returns {Array<{ key: string, from: *, to: * }>} changes that occurred
   */
  setBatch(entries) {
    if (!Array.isArray(entries) || entries.length === 0) return [];
    const changes = [];
    const eventQueue = [];

    for (const [dotPath, value] of entries) {
      if (typeof dotPath !== 'string') continue;
      const parts = dotPath.split('.');
      let obj = this.data;
      for (let i = 0; i < parts.length - 1; i++) {
        if (!obj[parts[i]] || typeof obj[parts[i]] !== 'object') obj[parts[i]] = {};
        obj = obj[parts[i]];
      }
      const oldValue = obj[parts[parts.length - 1]];
      if (SENSITIVE_KEYS.has(dotPath) && value && typeof value === 'string'
          && !value.startsWith(ENC_PREFIX)
          && !value.startsWith(ENC_PREFIX_V2)
          && !value.startsWith(ENC_PREFIX_V3)) {
        obj[parts[parts.length - 1]] = encryptValue(value, this._encSalt, this._getInstallId());
      } else {
        obj[parts[parts.length - 1]] = value;
      }
      // v7.5.7-fix Phase 3 followup: deep-equality for arrays/objects so
      // that "no actual change" doesn't trigger spurious change-log entries
      // (was visible in user logs as `mcp.servers: [0 items] → [0 items]`).
      // Reference-inequality alone fires even when contents are identical.
      const isChanged = (() => {
        if (oldValue === value) return false;
        if (typeof oldValue !== typeof value) return true;
        if (oldValue === null || value === null) return oldValue !== value;
        if (typeof oldValue === 'object') {
          try { return JSON.stringify(oldValue) !== JSON.stringify(value); }
          catch (_e) { return true; }
        }
        return oldValue !== value;
      })();
      if (isChanged) {
        changes.push({ key: dotPath, from: oldValue, to: value });
        const eventKey = TOGGLE_EVENT_KEYS[dotPath];
        if (eventKey) eventQueue.push({ eventKey, payload: { from: oldValue, to: value, key: dotPath } });
      }
    }

    // Single save for entire batch (debounced anyway, but call once cleanly)
    this._save();

    // Emit toggle events after all writes are done
    if (this._bus) {
      for (const ev of eventQueue) {
        try { this._bus.fire(ev.eventKey, ev.payload, { source: 'Settings' }); }
        catch (_e) { /* never let event-emit break the batch */ }
      }
    }

    return changes;
  }

  get(dotPath) {
    const parts = dotPath.split('.');
    /** @type {*} */ let val = this.data;
    for (const p of parts) { if (val == null) return undefined; val = val[p]; }
    if (SENSITIVE_KEYS.has(dotPath) && typeof val === 'string'
        && (val.startsWith(ENC_PREFIX) || val.startsWith(ENC_PREFIX_V2) || val.startsWith(ENC_PREFIX_V3))) {
      return decryptValue(val, this._encSalt, this._getInstallId());
    }
    return val;
  }

  getAll() {
    const copy = JSON.parse(JSON.stringify(this.data));
    const antKey = this.get('models.anthropicApiKey');
    copy.models.anthropicApiKey = antKey ? antKey.slice(0, 8) + '...' : '';
    const oaiKey = this.get('models.openaiApiKey');
    copy.models.openaiApiKey = oaiKey ? oaiKey.slice(0, 8) + '...' : '';
    if (copy.mcp && copy.mcp.serve) copy.mcp.serve.apiKey = this.get('mcp.serve.apiKey') ? '(set)' : ''; // v7.9.46: state, never the value
    return copy;
  }

  getRaw() { return this.data; }

  /**
   * v7.4.0: Runtime snapshot for RuntimeStatePort.
   * I/O-free, in-memory only. Uses getAll() (NOT getRaw())
   * so API keys are already masked by the time they leave
   * this method. Whitelist: backend, model, trustLevel,
   * language. Everything else stays internal.
   *
   * CRITICAL: NEVER call getRaw() here. That would bypass
   * the masking and leak real API keys into the prompt.
   */
  getRuntimeSnapshot() {
    const all = this.getAll();  // already masked
    return {
      backend: all?.models?.defaultBackend || null,
      model: all?.models?.defaultModel || null,
      trustLevel: all?.trust?.level || null,
      language: all?.ui?.language || null,
    };
  }
  hasAnthropic() { const k = this.get('models.anthropicApiKey'); return !!(k && k.length > 10); }
  hasOpenAI() { return !!(this.get('models.openaiBaseUrl') && this.get('models.openaiApiKey')); }

}

// v7.6.7 Track A: Mount the encryption mixin onto Settings.prototype.
// Pure structural extraction — runtime semantics unchanged. See
// SettingsEncryption.js for the extracted methods and rationale.
Object.assign(Settings.prototype, enc.settingsEncryptionMixin);
Object.assign(Settings.prototype, persistence.settingsPersistenceMixin); // v7.9.29 (hygiene)

module.exports = { Settings };
