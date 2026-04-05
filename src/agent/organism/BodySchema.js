// ============================================================
// GENESIS — BodySchema.js (Phase 7 — Organism Layer)
//
// The agent's body map. Biological organisms maintain a
// proprioceptive model — they know what limbs they have,
// which ones work, and what they can currently do.
//
// Genesis needs the same thing. Without BodySchema, the agent
// plans actions it can't execute (calling a tool that's offline,
// using a model that's unavailable, writing to a disk that's
// full). With it, the agent knows its own capabilities IN
// REAL TIME and can plan accordingly.
//
// BodySchema tracks:
//
//   Effectors (what can I DO?):
//     - Available tools (from ToolRegistry/EffectorRegistry)
//     - Available models (from ModelBridge)
//     - Available MCP servers (from McpClient)
//     - File system access (writable dirs, disk space)
//     - Network access (online/offline)
//
//   Constraints (what limits me RIGHT NOW?):
//     - Active circuit breakers (which services are down)
//     - Homeostasis state (throttled? recovery mode?)
//     - Token budget remaining
//     - Trust level restrictions
//
//   Capability Summary:
//     - canExecuteCode: bool
//     - canAccessWeb: bool
//     - canModifySelf: bool
//     - canSpawnWorkers: bool
//     - activeModel: string
//     - trustLevel: number
//
// Architecture:
//   ToolRegistry       → BodySchema (effector inventory)
//   CircuitBreaker     → BodySchema (constraint updates)
//   Homeostasis        → BodySchema (throttle state)
//   TrustLevelSystem   → BodySchema (permission level)
//   BodySchema         → PromptBuilder (capability context)
//
// PERFORMANCE: Pure state lookup, no computation. ~0.1ms.
// ============================================================

const { NullBus } = require('../core/EventBus');
const { createLogger } = require('../core/Logger');
const _log = createLogger('BodySchema');

// ── Subsystem Sampling Table ─────────────────────────────
// Each entry describes how to sample a late-bound subsystem.
// Used by _update() to avoid a long if-chain (CC reduction).
const SUBSYSTEM_SAMPLERS = [
  {
    prop: 'model',
    sample: (src, caps) => { caps.activeModel = src.activeModel || 'unknown'; },
  },
  {
    prop: 'tools',
    sample: (src, caps, self) => {
      const toolNames = src.list?.() || src.listTools?.() || [];
      self._toolList = Array.isArray(toolNames) ? toolNames.map(t => t.name || t) : [];
      caps.canExecuteCode = self._toolList.some(t =>
        /shell|sandbox|code|exec/i.test(typeof t === 'string' ? t : t.name || '')
      );
    },
  },
  {
    prop: 'effectorRegistry',
    sample: (src, caps, self) => {
      self._effectorList = src.list?.() || [];
      caps.canAccessWeb = self._effectorList.some(e =>
        /web|browser|fetch|http/i.test(typeof e === 'string' ? e : e.name || '')
      );
    },
  },
  {
    prop: 'mcpClient',
    sample: (src, _caps, self) => {
      const status = src.getStatus?.() || {};
      self._mcpServers = status.connectedCount || 0;
    },
  },
  {
    prop: 'circuitBreaker',
    sample: (src, caps, _self, constraints) => {
      const state = src.getState?.() || 'closed';
      caps.circuitOpen = (state === 'open');
      if (state === 'open') constraints.push('LLM circuit breaker OPEN — model calls may fail');
    },
  },
  {
    prop: 'homeostasis',
    sample: (src, caps, _self, constraints) => {
      const report = src.getReport?.() || {};
      caps.isThrottled = report.state === 'warning' || report.state === 'critical';
      caps.isRecovery = report.state === 'recovering' || report.state === 'critical';
      if (report.state === 'critical') constraints.push('RECOVERY MODE — autonomy paused, only user-initiated actions');
      else if (report.state === 'warning') constraints.push('System under stress — prefer lightweight operations');
    },
  },
  {
    prop: 'trustLevelSystem',
    sample: (src, caps, _self, constraints) => {
      const status = src.getStatus?.() || {};
      const level = status.level ?? 0;
      caps.trustLevel = level;
      caps.canModifySelf = level >= 2;
      caps.canSpawnWorkers = level >= 1;
      if (level < 1) constraints.push('Trust Level 0 — supervised mode, all actions need approval');
    },
  },
  // v6.0.5 (V6-10): NetworkSentinel — real connectivity status
  {
    prop: 'networkSentinel',
    sample: (src, caps, _self, constraints) => {
      const status = src.getStatus?.() || {};
      caps.networkOnline = status.online !== false;
      if (!caps.networkOnline) {
        caps.canAccessWeb = false;
        constraints.push(status.failoverActive
          ? 'OFFLINE — running on local Ollama (auto-failover active)'
          : 'OFFLINE — network unavailable, cloud backends unreachable');
      }
    },
  },
];

class BodySchema {
  static containerConfig = {
    name: 'bodySchema',
    phase: 7,
    deps: ['storage'],
    tags: ['organism', 'embodiment', 'capabilities'],
    lateBindings: [
      { prop: 'tools', service: 'tools', optional: true },
      { prop: 'circuitBreaker', service: 'circuitBreaker', optional: true },
      { prop: 'homeostasis', service: 'homeostasis', optional: true },
      { prop: 'trustLevelSystem', service: 'trustLevelSystem', optional: true },
      { prop: 'mcpClient', service: 'mcpClient', optional: true },
      { prop: 'model', service: 'llm', optional: true },
      { prop: 'effectorRegistry', service: 'effectorRegistry', optional: true },
      { prop: 'embodiedPerception', service: 'embodiedPerception', optional: true },
    ],
  };

  constructor({ bus, storage, config }) {
    this.bus = bus || NullBus;
    /** @type {Function[]} */ this._unsubs = [];
    this.storage = storage || null;

    // Late-bound
    this.tools = null;
    this.circuitBreaker = null;
    this.homeostasis = null;
    this.trustLevelSystem = null;
    this.mcpClient = null;
    this.model = null;
    this.effectorRegistry = null;
    this.embodiedPerception = null;  // v5.6.0 SA-P4

    // ── Cached capability state ──────────────────────────
    this._capabilities = {
      canExecuteCode: true,
      canAccessWeb: false,
      canModifySelf: true,
      canSpawnWorkers: true,
      activeModel: 'unknown',
      trustLevel: 0,
      isThrottled: false,
      isRecovery: false,
      circuitOpen: false,
      // v5.6.0 SA-P4: UI embodiment
      userEngagement: 'unknown',   // active | idle | away | background | unknown
      activePanel: 'unknown',
      windowFocused: true,
      userTyping: false,
    };

    this._effectorList = [];     // Available effector names
    this._toolList = [];         // Available tool names
    this._mcpServers = 0;        // Connected MCP server count
    this._constraints = [];      // Active constraint descriptions
    this._lastUpdate = 0;
    this._updateIntervalMs = (config?.updateIntervalMs) || 5000;

    this._wireEvents();
  }

  // ════════════════════════════════════════════════════════════
  // LIFECYCLE
  // ════════════════════════════════════════════════════════════

  start() {
    this._update();
    _log.info('[BODY-SCHEMA] Active — tracking capabilities');
  }


  /** @private Subscribe to bus event with auto-cleanup in stop() */
  _sub(event, handler, opts) {
    const unsub = this.bus.on(event, handler, opts);
    this._unsubs.push(typeof unsub === 'function' ? unsub : () => {});
    return unsub;
  }

  stop() {
    for (const unsub of this._unsubs) { try { unsub(); } catch (_) { /* best effort */ } }
    this._unsubs = [];}

  async asyncLoad() {}

  // ════════════════════════════════════════════════════════════
  // CORE: CAPABILITY SAMPLING
  // ════════════════════════════════════════════════════════════

  /**
   * Sample all connected subsystems and update the capability map.
   * Called periodically and on relevant events.
   */
  _update() {
    const now = Date.now();
    if (now - this._lastUpdate < this._updateIntervalMs) return;
    this._lastUpdate = now;

    const constraints = [];

    for (const sampler of SUBSYSTEM_SAMPLERS) {
      const source = this[sampler.prop];
      if (!source) continue;
      try {
        sampler.sample(source, this._capabilities, this, constraints);
      } catch (err) { _log.debug(`[BODY] ${sampler.prop} sampling failed:`, err.message); }
    }

    this._constraints = constraints;

    // v5.6.0 SA-P4: Sample UI embodiment state
    this._sampleUIState();
  }

  // ════════════════════════════════════════════════════════════
  // v5.6.0 SA-P4: UI EMBODIMENT SAMPLING
  // ════════════════════════════════════════════════════════════

  /** @private Sample EmbodiedPerception for UI state */
  _sampleUIState() {
    if (!this.embodiedPerception) return;
    try {
      const eng = this.embodiedPerception.getEngagement();
      const ui = this.embodiedPerception.getUIState();
      this._capabilities.userEngagement = eng.level || 'unknown';
      this._capabilities.activePanel = ui.activePanel || 'unknown';
      this._capabilities.windowFocused = ui.windowFocused !== false;
      this._capabilities.userTyping = !!ui.isTyping;

      // Add constraints based on UI state
      if (eng.level === 'background') {
        this._constraints.push('Window not focused — defer UI-heavy operations');
      }
      if (eng.level === 'away') {
        this._constraints.push('User away — autonomous background tasks appropriate');
      }
    } catch (err) { _log.debug('[BODY] embodiedPerception sampling failed:', err.message); }
  }

  // ════════════════════════════════════════════════════════════
  // PUBLIC API
  // ════════════════════════════════════════════════════════════

  /** Get the full capability map */
  getCapabilities() {
    this._update();
    return { ...this._capabilities };
  }

  /** Check if a specific capability is available */
  can(capability) {
    this._update();
    return !!this._capabilities[capability];
  }

  /** Get current constraints */
  getConstraints() {
    this._update();
    return [...this._constraints];
  }

  /**
   * Build prompt context for PromptBuilder.
   * Only injects when there are active constraints or notable
   * capability changes — avoids noise in normal operation.
   */
  buildPromptContext() {
    this._update();

    const parts = [];

    // Always mention active constraints
    if (this._constraints.length > 0) {
      parts.push('CONSTRAINTS:');
      for (const c of this._constraints) {
        parts.push(`  ⚠ ${c}`);
      }
    }

    // Mention circuit breaker state
    if (this._capabilities.circuitOpen) {
      parts.push('LLM backend is unstable — prefer cached results and simple operations.');
    }

    // Only inject capability summary when something is restricted
    if (!this._capabilities.canExecuteCode) {
      parts.push('Code execution is currently unavailable.');
    }
    if (!this._capabilities.canModifySelf) {
      parts.push('Self-modification is restricted at current trust level.');
    }

    return parts.length > 0 ? parts.join('\n') : '';
  }

  /** Full diagnostic */
  getReport() {
    this._update();
    return {
      capabilities: { ...this._capabilities },
      tools: this._toolList.length,
      effectors: this._effectorList.length,
      mcpServers: this._mcpServers,
      constraints: [...this._constraints],
    };
  }

  // ════════════════════════════════════════════════════════════
  // EVENT WIRING
  // ════════════════════════════════════════════════════════════

  _wireEvents() {
    // Force re-sample on relevant state changes
    this._sub('health:degradation', () => this._invalidate(), { source: 'BodySchema', priority: -10 });
    // v4.12.5-fix: Was 'health:recovery' (never emitted). Homeostasis emits state-change on recovery.
    this._sub('homeostasis:state-change', () => this._invalidate(), { source: 'BodySchema', priority: -10 });
    // v4.12.5-fix: Was 'circuit:open'/'circuit:close' (never emitted).
    // CircuitBreaker emits 'circuit:state-change' with { from, to }.
    this._sub('circuit:state-change', () => this._invalidate(), { source: 'BodySchema', priority: -10 });
    this._sub('mcp:connected', () => this._invalidate(), { source: 'BodySchema', priority: -10 });
    this._sub('mcp:disconnected', () => this._invalidate(), { source: 'BodySchema', priority: -10 });
    // v5.6.0 SA-P4: UI state changes trigger re-sample
    this._sub('embodied:engagement-changed', () => this._invalidate(), { source: 'BodySchema', priority: -10 });
    this._sub('embodied:focus-changed', () => this._invalidate(), { source: 'BodySchema', priority: -10 });
  }

  _invalidate() {
    this._lastUpdate = 0; // Force next _update() to re-sample
  }
}

module.exports = { BodySchema };
