// @ts-checked-v5.7
// ============================================================
// GENESIS — EmbodiedPerception.js (v5.6.0 — SA-P4)
//
// Genesis perceives its own UI as embodied state. Just as
// biological organisms have proprioception (awareness of body
// position), Genesis maintains awareness of its interface:
//
//   - Is the user actively engaged or idle?
//   - Which panel has focus (chat, editor, dashboard)?
//   - Is the window focused or in background?
//   - Is the user typing (composing a message)?
//   - How long has the current session been active?
//
// This feeds into BodySchema as a perception channel, which
// flows into PhenomenalField via valence/arousal modulation:
//   - User engagement → positive valence boost
//   - Long idle → reduced arousal (conserve resources)
//   - Window unfocused → lower priority for proactive actions
//
// Architecture:
//   UI (renderer) → IPC heartbeat → main.js → EventBus
//   → EmbodiedPerception → BodySchema → PhenomenalField
//
// PERFORMANCE: Pure state tracking, no computation. <0.1ms.
// ============================================================

const { NullBus } = require('../core/EventBus');
const { createLogger } = require('../core/Logger');
const _log = createLogger('EmbodiedPerception');

class EmbodiedPerception {
  static containerConfig = {
    name: 'embodiedPerception',
    phase: 7,
    deps: [],
    tags: ['organism', 'embodiment', 'perception', 'sa-p4'],
    lateBindings: [],
  };

  constructor({ bus, config }) {
    this.bus = bus || NullBus;

    const cfg = config || {};

    // ── UI Perception State ─────────────────────────────
    this._uiState = {
      activePanel: 'chat',        // chat | editor | dashboard | settings | unknown
      windowFocused: true,
      userIdleMs: 0,
      isTyping: false,
      chatInputLength: 0,
      lastHeartbeat: 0,
      sessionStartedAt: Date.now(),
    };

    // ── Derived Engagement Metrics ──────────────────────
    this._engagement = {
      level: 'active',            // active | idle | away | background
      interactionRate: 0,         // heartbeats with activity per minute
      sessionDurationMs: 0,
      idleStreak: 0,              // consecutive idle heartbeats
    };

    // ── Configuration ───────────────────────────────────
    this._idleThresholdMs = cfg.idleThresholdMs || 30000;     // 30s → idle
    this._awayThresholdMs = cfg.awayThresholdMs || 300000;    // 5min → away
    this._heartbeatTimeoutMs = cfg.heartbeatTimeoutMs || 15000; // no heartbeat → assume background
    this._recentInteractions = [];  // timestamps of active heartbeats
    this._maxRecentInteractions = 30;

    /** @type {Array<Function>} */
    this._unsubs = [];
    this._wireEvents();
  }

  // ════════════════════════════════════════════════════════
  // LIFECYCLE
  // ════════════════════════════════════════════════════════

  start() {
    _log.info('[EMBODIED] Active — perceiving UI state');
  }

  // FIX v6.0.3 (SA-P4): Cleanup listener on stop — prevents accumulation on hot-reload
  stop() {
    for (const unsub of this._unsubs) unsub();
    this._unsubs = [];
  }
  async asyncLoad() {}

  // ════════════════════════════════════════════════════════
  // HEARTBEAT PROCESSING
  // ════════════════════════════════════════════════════════

  /**
   * Process a UI heartbeat. Called when renderer sends state.
   * @param {{ activePanel?: string, windowFocused?: boolean, userIdleMs?: number, isTyping?: boolean, chatInputLength?: number }} data
   */
  processHeartbeat(data) {
    if (!data || typeof data !== 'object') return;

    const now = Date.now();
    const prev = { ...this._uiState };

    // Update raw state
    if (data.activePanel) this._uiState.activePanel = data.activePanel;
    if (typeof data.windowFocused === 'boolean') this._uiState.windowFocused = data.windowFocused;
    if (typeof data.userIdleMs === 'number') this._uiState.userIdleMs = data.userIdleMs;
    if (typeof data.isTyping === 'boolean') this._uiState.isTyping = data.isTyping;
    if (typeof data.chatInputLength === 'number') this._uiState.chatInputLength = data.chatInputLength;
    this._uiState.lastHeartbeat = now;

    // Track interaction rate
    const isActive = this._uiState.userIdleMs < this._idleThresholdMs && this._uiState.windowFocused;
    if (isActive) {
      this._recentInteractions.push(now);
      if (this._recentInteractions.length > this._maxRecentInteractions) {
        this._recentInteractions.shift();
      }
      this._engagement.idleStreak = 0;
    } else {
      this._engagement.idleStreak++;
    }

    // Compute engagement level
    this._updateEngagement(now);

    // Emit events on significant transitions
    if (prev.activePanel !== this._uiState.activePanel) {
      this.bus.emit('embodied:panel-changed', {
        from: prev.activePanel,
        to: this._uiState.activePanel,
      }, { source: 'EmbodiedPerception' });
    }

    if (prev.windowFocused !== this._uiState.windowFocused) {
      this.bus.emit('embodied:focus-changed', {
        focused: this._uiState.windowFocused,
      }, { source: 'EmbodiedPerception' });
    }

    const prevLevel = this._engagement.level;
    if (prevLevel !== this._engagement.level) {
      this.bus.emit('embodied:engagement-changed', {
        from: prevLevel,
        to: this._engagement.level,
      }, { source: 'EmbodiedPerception' });
    }
  }

  // ════════════════════════════════════════════════════════
  // ENGAGEMENT COMPUTATION
  // ════════════════════════════════════════════════════════

  /** @private */
  _updateEngagement(now) {
    this._engagement.sessionDurationMs = now - this._uiState.sessionStartedAt;

    // Interaction rate: active heartbeats in last 60s
    const oneMinAgo = now - 60000;
    this._recentInteractions = this._recentInteractions.filter(t => t > oneMinAgo);
    this._engagement.interactionRate = this._recentInteractions.length;

    // Engagement level
    if (!this._uiState.windowFocused) {
      this._engagement.level = 'background';
    } else if (this._uiState.userIdleMs > this._awayThresholdMs) {
      this._engagement.level = 'away';
    } else if (this._uiState.userIdleMs > this._idleThresholdMs) {
      this._engagement.level = 'idle';
    } else {
      this._engagement.level = 'active';
    }
  }

  // ════════════════════════════════════════════════════════
  // PUBLIC API (for BodySchema + PromptBuilder)
  // ════════════════════════════════════════════════════════

  /** Get current UI perception state */
  getUIState() {
    return { ...this._uiState };
  }

  /** Get derived engagement metrics */
  getEngagement() {
    // Check for stale heartbeat
    const now = Date.now();
    if (this._uiState.lastHeartbeat > 0 &&
        now - this._uiState.lastHeartbeat > this._heartbeatTimeoutMs) {
      this._engagement.level = 'background';
    }
    return { ...this._engagement };
  }

  /** Is the user actively engaged? */
  isUserActive() {
    return this._engagement.level === 'active';
  }

  /** Is the user typing in the chat input? */
  isUserTyping() {
    return this._uiState.isTyping && this._uiState.chatInputLength > 0;
  }

  /**
   * Build prompt context — only when engagement state is notable.
   * Avoids noise: returns empty string when user is active and focused.
   */
  buildPromptContext() {
    const eng = this.getEngagement();
    const ui = this._uiState;
    const parts = [];

    if (eng.level === 'away') {
      parts.push('USER STATE: Away (idle >5min). Autonomous actions appropriate.');
    } else if (eng.level === 'idle') {
      parts.push('USER STATE: Idle. User may be reading or thinking.');
    } else if (eng.level === 'background') {
      parts.push('USER STATE: Window not focused. Defer non-critical notifications.');
    }

    if (ui.isTyping && ui.chatInputLength > 0) {
      parts.push('User is currently composing a message.');
    }

    if (ui.activePanel === 'editor') {
      parts.push('User is in the code editor — technical context likely.');
    } else if (ui.activePanel === 'dashboard') {
      parts.push('User is viewing the dashboard — system health context.');
    }

    return parts.length > 0 ? parts.join('\n') : '';
  }

  /** Full diagnostic */
  getReport() {
    return {
      uiState: this.getUIState(),
      engagement: this.getEngagement(),
    };
  }

  // ════════════════════════════════════════════════════════
  // EVENT WIRING
  // ════════════════════════════════════════════════════════

  /** @private */
  _wireEvents() {
    // Listen for UI heartbeats forwarded from main.js IPC bridge
    // FIX v6.0.3 (SA-P4): Track subscription for cleanup in stop()
    this._unsubs.push(
      this.bus.on('ui:heartbeat', (data) => {
        this.processHeartbeat(data);
      }, { source: 'EmbodiedPerception', priority: -10 })
    );
  }
}

module.exports = { EmbodiedPerception };
