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
const _log = createLogger('Settings');

// ── Encryption helpers (machine-bound AES-256-GCM) ─────────
const SENSITIVE_KEYS = new Set(['models.anthropicApiKey', 'models.openaiApiKey']);

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
  'mcp.serve.enabled':         'settings:mcp-serve-toggled',
};
const ENC_PREFIX = 'enc:';
// FIX v4.10.0 (S-4): v2 prefix for 600k-iteration keys.
// Old 'enc:' prefix = 10,000 iterations (read-compatible, auto-upgraded on next write).
// New 'enc2:' prefix = 600,000 iterations (OWASP 2023 minimum for SHA-256).
const ENC_PREFIX_V2 = 'enc2:';
const PBKDF2_ITERATIONS_V1 = 10000;
const PBKDF2_ITERATIONS_V2 = 600000;

function deriveKey(salt, iterations = PBKDF2_ITERATIONS_V2) {
  const machineId = `${os.hostname()}:${os.userInfo().username}:genesis-v2`;
  return crypto.pbkdf2Sync(machineId, salt, iterations, 32, 'sha256');
}

function encryptValue(plaintext, salt) {
  if (!plaintext || plaintext.startsWith(ENC_PREFIX_V2) || plaintext.startsWith(ENC_PREFIX)) return plaintext;
  // FIX v4.10.0: Always encrypt with v2 (600k iterations)
  const key = deriveKey(salt, PBKDF2_ITERATIONS_V2);
  const iv = crypto.randomBytes(12);
  const cipher = /** @type {*} */ (crypto.createCipheriv('aes-256-gcm', key, iv));
  let encrypted = cipher.update(plaintext, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  const tag = cipher.getAuthTag().toString('hex');
  return `${ENC_PREFIX_V2}${iv.toString('hex')}:${tag}:${encrypted}`;
}

function decryptValue(ciphertext, salt) {
  if (!ciphertext) return ciphertext;
  // FIX v4.10.0: Support both v1 (10k) and v2 (600k) prefixes for backward compat
  let prefix, iterations;
  if (ciphertext.startsWith(ENC_PREFIX_V2)) {
    prefix = ENC_PREFIX_V2;
    iterations = PBKDF2_ITERATIONS_V2;
  } else if (ciphertext.startsWith(ENC_PREFIX)) {
    prefix = ENC_PREFIX;
    iterations = PBKDF2_ITERATIONS_V1;
  } else {
    return ciphertext; // Not encrypted
  }
  try {
    const parts = ciphertext.slice(prefix.length).split(':');
    if (parts.length !== 3) return ciphertext;
    const [ivHex, tagHex, encHex] = parts;
    const key = deriveKey(salt, iterations);
    const decipher = /** @type {*} */ (crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(ivHex, 'hex')));
    decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
    let decrypted = decipher.update(encHex, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    return decrypted;
  } catch (err) {
    _log.warn('[SETTINGS] API key decryption failed — key may need re-entry');
    return '';
  }
}

class Settings {
  constructor(storageDir, storage) {
    this.storage = storage || null;
    this.filePath = path.join(storageDir, 'settings.json');
    // v7.4.7: Optional bus for emitting setting-change events.
    // Set later via setBus(). Used so that Daemon/IdleMind/SelfMod
    // toggles take effect at runtime, not just at next boot.
    this._bus = null;
    // FIX v4.10.0 (M-4): Use a randomly generated salt persisted to disk.
    // Previously, salt was deterministic from storageDir path — an attacker
    // with local access could reconstruct the key without brute force.
    // Random salt is generated on first run and stored in .genesis/enc-salt.
    this._encSalt = this._loadOrCreateSalt(storageDir);
    this.data = {
      models: {
        preferred: null, fallbackChain: [], anthropicApiKey: '', openaiBaseUrl: '', openaiApiKey: '', openaiModels: [],
        // v5.1.0: Per-task model assignment — null = use preferred/auto
        roles: { chat: null, code: null, analysis: null, creative: null },
      },
      daemon: { enabled: true, cycleMinutes: 5, autoRepair: true, autoOptimize: false },
      idleMind: { enabled: true, idleMinutes: 2, thinkMinutes: 3, maxActiveGoals: 3 },
      ui: { language: 'de', editorFontSize: 13, chatFontSize: 13 },
      security: { allowSelfModify: true, allowNetworkPeers: true, allowFileExecution: true },
      // v7.4.7: Trust level (0..3 = SUPERVISED..FULL_AUTONOMY).
      // Read by TrustLevelSystem.asyncLoad — overrides the persisted
      // trust-level.json default. UI dropdown writes here.
      trust: { level: 1 },
      // v7.4.7: Agency runtime preferences. autoResumeGoals selects
      // GoalDriver boot-pickup behavior (already wired in GoalDriver:562).
      // Values: 'ask' | 'always' | 'never'.
      // v7.5.0: negotiateBeforeAdd — when true, /goal add proposes
      // the goal as pending; Genesis then clarifies before it's
      // committed to the active stack. Default false for backwards
      // compatibility (existing users keep direct-add behaviour).
      agency: { autoResumeGoals: 'ask', negotiateBeforeAdd: false },
      mcp: { enabled: true, servers: [], serve: { enabled: false, port: 3580 } },
      // v3.5.0: Configurable timeouts (were hardcoded across modules)
      timeouts: { approvalSec: 60, shellMs: 15000, httpMs: 60000, gitMs: 5000 },
      // v3.7.0: Cognitive strictMode — when true, AgentLoop refuses to run
      // unless core cognitive services (verifier, formalPlanner, worldState) are bound.
      // Default false for backwards compatibility.
      cognitive: {
        strictMode: false,
        // v4.0: Phase 9 — Cognitive Architecture feature flags
        // All features default to true. Set to false to disable individually.
        phase9Enabled: true,
        expectations: {
          enabled: true,
          minSamples: 10,           // Min MetaLearning samples for statistical prediction
          confidenceCap: 0.95,
        },
        simulation: {
          enabled: true,
          maxBranches: 3,
          maxDepth: 15,
          pruneThreshold: 0.05,
          timeBudgetMs: 5000,
        },
        surprise: {
          enabled: true,
          noveltyThreshold: 1.5,
          significantThreshold: 0.8,
          amplifiedLearning: true,  // Feed surprise weights into MetaLearning
        },
        dreams: {
          enabled: true,
          useLLM: true,             // false = heuristic-only (no LLM cost)
          minEpisodes: 10,
          maxDurationMs: 120000,
          consolidationIntervalMs: 30 * 60 * 1000,
        },
        selfNarrative: {
          enabled: true,
          injectInPrompts: true,    // false = narrative exists but isn't injected
          updateThreshold: 20,      // Accumulated change points before update
        },
        schemas: {
          maxSchemas: 200,
          relevanceThreshold: 0.3,
          confidenceDecayRate: 0.005,
        },
      },
      // v3.5.0: Organism tuning — previously hardcoded in EmotionalState/Homeostasis/NeedsSystem
      organism: {
        emotions: {
          decayIntervalMs: 60000,        // How often emotions drift toward baseline
          lonelinessIntervalMs: 300000,   // How often loneliness grows passively
          lonelinessGrowth: 0.008,        // Loneliness increment per tick
          significantShift: 0.05,         // Min change to emit emotion:shift event
          baselines: { curiosity: 0.6, satisfaction: 0.5, frustration: 0.1, energy: 0.7, loneliness: 0.3 },
          decayRates: { curiosity: 0.02, satisfaction: 0.03, frustration: 0.04, energy: 0.01, loneliness: 0.005 },
        },
        homeostasis: {
          tickIntervalMs: 30000,          // How often vitals are checked
          recoveryDurationMs: 300000,     // How long recovery mode lasts
          criticalThreshold: 2,           // N vitals in warning → enter recovery
          maxErrorWindowMs: 60000,        // Error rate window
          thresholds: {
            errorRate: { healthy: 0.5, warning: 2.0 },
            memoryPressure: { healthy: 75, warning: 90 },
            kgNodeCount: { healthy: 3000, warning: 5000 },
            responseLatency: { healthy: 5000, warning: 15000 },
          },
        },
        needs: {
          growthIntervalMs: 120000,       // How often needs grow
          growthRates: { knowledge: 0.008, social: 0.005, maintenance: 0.003, rest: 0.002 },
          weights: { knowledge: 1.2, social: 0.8, maintenance: 1.0, rest: 0.6 },
          satisfyAmounts: { knowledge: 0.15, social: 0.25, maintenance: 0.20, rest: 0.12 },
        },
      },
    };
    // FIX v7.0.8: Moved _load() back into constructor (was asyncLoad since v3.8.0).
    // _load() is synchronous (readJSON is sync). Having it in asyncLoad() caused a
    // race condition: ModelBridge.asyncLoad() runs concurrently in the same boot level
    // and reads models.preferred BEFORE Settings._load() applies env overrides.
    // Result: GENESIS_MODEL env var was ignored, auto-select picked wrong model.
    this._load();
  }

  /** @param {string} dotPath @param {*} value */
  /**
   * v7.4.7: Late-bind a bus so set() can emit toggle events for
   * Daemon/IdleMind/SelfMod runtime toggles. Called from AgentCoreWire
   * after Settings is resolved (Settings is in phase 0, bus also).
   * @param {*} bus
   */
  setBus(bus) {
    this._bus = bus || null;
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
    if (SENSITIVE_KEYS.has(dotPath) && value && typeof value === 'string' && !value.startsWith(ENC_PREFIX) && !value.startsWith(ENC_PREFIX_V2)) {
      obj[parts[parts.length - 1]] = encryptValue(value, this._encSalt);
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
          this._bus.emit(eventKey, { from: oldValue, to: value, key: dotPath }, { source: 'Settings' });
        } catch (_e) { /* never let event-emit break a save */ }
      }
    }
  }

  get(dotPath) {
    const parts = dotPath.split('.');
    /** @type {*} */ let val = this.data;
    for (const p of parts) { if (val == null) return undefined; val = val[p]; }
    if (SENSITIVE_KEYS.has(dotPath) && typeof val === 'string' && (val.startsWith(ENC_PREFIX) || val.startsWith(ENC_PREFIX_V2))) {
      return decryptValue(val, this._encSalt);
    }
    return val;
  }

  getAll() {
    const copy = JSON.parse(JSON.stringify(this.data));
    const antKey = this.get('models.anthropicApiKey');
    copy.models.anthropicApiKey = antKey ? antKey.slice(0, 8) + '...' : '';
    const oaiKey = this.get('models.openaiApiKey');
    copy.models.openaiApiKey = oaiKey ? oaiKey.slice(0, 8) + '...' : '';
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
      }
    } catch (err) { _log.warn('[SETTINGS] Load failed, using defaults:', err.message); }

    // v5.9.0: Environment variable overrides (for headless/CI mode)
    this._applyEnvOverrides();
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

  _migratePlaintextKeys() {
    let migrated = false;
    for (const dotPath of SENSITIVE_KEYS) {
      const parts = dotPath.split('.');
      /** @type {*} */ let val = this.data;
      for (const p of parts) { if (val) val = val[p]; }
      if (val && typeof val === 'string' && val.length > 10) {
        if (!val.startsWith(ENC_PREFIX) && !val.startsWith(ENC_PREFIX_V2)) {
          // Plaintext → encrypt with v2
          this.set(dotPath, val);
          migrated = true;
        } else if (val.startsWith(ENC_PREFIX) && !val.startsWith(ENC_PREFIX_V2)) {
          // FIX v4.10.0 (S-4): Auto-upgrade v1 (10k iterations) → v2 (600k iterations).
          // Decrypt with old iterations, re-encrypt with new.
          const plaintext = decryptValue(val, this._encSalt);
          if (plaintext && plaintext.length > 0) {
            this.set(dotPath, plaintext); // set() will encrypt with v2
            migrated = true;
          }
        }
      }
    }
    if (migrated) _log.info('[SETTINGS] Migrated API keys to PBKDF2 v2 (600k iterations)');
  }

  _deepMerge(target, source) {
    const result = { ...target };
    for (const key of Object.keys(source)) {
      if (source[key] && typeof source[key] === 'object' && !Array.isArray(source[key])) {
        result[key] = this._deepMerge(target[key] || {}, source[key]);
      } else { result[key] = source[key]; }
    }
    return result;
  }

  /**
   * FIX v4.10.0 (M-4): Load or create a random encryption salt.
   * Stored in .genesis/enc-salt (plain hex string, not sensitive itself —
   * security depends on the machine-derived key material in deriveKey()).
   * Falls back to deterministic salt for backward compatibility if the
   * salt file cannot be written.
   */
  _loadOrCreateSalt(storageDir) {
    const saltPath = path.join(storageDir, 'enc-salt');
    try {
      if (fs.existsSync(saltPath)) {
        return fs.readFileSync(saltPath, 'utf-8').trim();
      }
      const salt = crypto.randomBytes(32).toString('hex');
      if (!fs.existsSync(storageDir)) fs.mkdirSync(storageDir, { recursive: true });
      fs.writeFileSync(saltPath, salt, 'utf-8');
      return salt;
    } catch (err) {
      _log.warn('[SETTINGS] Random salt creation failed, using deterministic fallback:', err.message);
      return 'genesis-' + storageDir.replace(/[^a-zA-Z0-9]/g, '').slice(-16);
    }
  }
}

module.exports = { Settings };
