// ============================================================
// GENESIS — AgentCoreWire.js (v5.0.0)
//
// Event-wiring + service-start delegate for AgentCore.
//
// Extracts three private methods that had grown to ~250 LOC:
//   _wireEventHandlers()  — EventBus subscriptions for cross-service wiring
//   _wireUIEvents()       — EventBus → Electron window.webContents relay
//   _startServices()      — start() on all autonomous services
//
// Each method is pure side-effects: registers listeners and starts
// timers. No state is held here; all state lives on the services
// themselves, accessed via core.container.
// ============================================================

'use strict';

const { createLogger } = require('./core/Logger');
const _log = createLogger('AgentCoreWire');

class AgentCoreWire {
  /** @param {import('./AgentCore').AgentCore} core */
  constructor(core) {
    this._core = core;
  }

  get _c()   { return this._core.container; }
  get _bus() { return this._core._bus; }

  // ════════════════════════════════════════════════════════
  // EVENT HANDLER WIRING
  // ════════════════════════════════════════════════════════

  _wireEventHandlers() {
    const c   = this._c;
    const bus = this._bus;

    // Homeostasis → pause/resume autonomy
    bus.on('homeostasis:pause-autonomy', () => {
      if (this._core.intervals) this._core.intervals.pause('idlemind-think');
      _log.info('[ORGANISM] Autonomy paused by homeostasis');
    }, { source: 'AgentCore:organism' });

    bus.on('homeostasis:state-change', (data) => {
      if (data.to === 'healthy' && this._core.intervals) {
        this._core.intervals.resume('idlemind-think');
        _log.info('[ORGANISM] Autonomy resumed — organism healthy');
      }
    }, { source: 'AgentCore:organism' });

    // Reasoning solve
    bus.on('reasoning:solve', async (data) => {
      return c.resolve('reasoning').solve(data.task, {
        history:   data.history || [],
        memory:    c.resolve('memory'),
        selfModel: c.resolve('selfModel'),
      });
    }, { source: 'AgentCore' });

    // Web search
    bus.on('web:search', async (data) => {
      const query = data?.query || '';
      if (!query) return null;
      try {
        const web = c.resolve('webFetcher');
        if (/\b(npm|package|module|library|dependency)\b/i.test(query)) {
          return await web.npmSearch(query.replace(/\b(npm|package)\b/gi, '').trim());
        }
        if (/^https?:\/\//.test(query)) return await web.fetchText(query);
        const local = c.resolve('knowledgeGraph').search(query, 5);
        return local.length > 0 ? local : null;
      } catch (err) {
        _log.debug('[WEB:SEARCH] Failed:', err.message);
        return null;
      }
    }, { source: 'AgentCore' });

    // CircuitBreaker → WorldState
    bus.on('circuit:state-change', (data) => {
      if (c.has('worldState')) c.resolve('worldState').updateCircuitState(data.to);
    }, { source: 'AgentCore:wire' });

    // User messages → WorldState topic tracking
    bus.on('user:message', (data) => {
      if (c.has('worldState') && data?.message) {
        c.resolve('worldState').recordUserTopic(data.message.slice(0, 50));
      }
    }, { source: 'AgentCore:wire' });

    // AgentLoop completion → EpisodicMemory
    bus.on('agent-loop:complete', (data) => {
      if (c.has('episodicMemory') && data) {
        try {
          c.resolve('episodicMemory').recordEpisode({
            topic:    data.title || data.summary?.slice(0, 80) || 'Goal execution',
            summary:  data.summary || '',
            outcome:  data.success ? 'success' : 'failed',
            duration: data.duration || 0,
            toolsUsed: data.toolsUsed || [],
            tags:     data.tags || [],
          });
        } catch (err) { _log.debug('Episode recording failed:', err.message); }
      }
    }, { source: 'AgentCore:wire' });

    // chat:error → agent:error relay
    // ErrorAggregator and HotReloader watchdog listen for 'agent:error'.
    // ChatOrchestrator emits 'chat:error' on failures.
    bus.on('chat:error', (data) => {
      bus.fire('agent:error', {
        error:  data?.message || data?.error || 'Unknown error',
        source: 'ChatOrchestrator',
      }, { source: 'AgentCore:relay' });
    }, { source: 'AgentCore:wire', priority: -20 });

    // v7.3.2: CoreMemories subscribes to chat:completed, user:message,
    // hot-reload:success. Late-binding happens at container-wire; here we
    // trigger the subscription wiring (idempotent, safe to call more than once).
    try {
      const coreMemories = this._core?.container?.tryResolve?.('coreMemories');
      if (coreMemories && typeof coreMemories.wireTriggers === 'function') {
        coreMemories.wireTriggers(bus);
      }
    } catch (err) {
      _log.debug('[WIRE] CoreMemories trigger wiring skipped:', err.message);
    }
  }

  // ════════════════════════════════════════════════════════
  // UI EVENT RELAY — EventBus → Electron window
  // ════════════════════════════════════════════════════════

  _wireUIEvents() {
    const bus  = this._bus;
    const core = this._core;

    const push = (channel, data) => {
      if (core.window && !core.window.isDestroyed()) {
        // FIX v6.1.1: Sanitize for IPC structured clone — strip non-serializable values
        try { core.window.webContents.send(channel, JSON.parse(JSON.stringify(data))); }
        catch { /* skip unserializable push */ }
      }
    };

    const status = (data) => push('agent:status-update', data);

    // ══════════════════════════════════════════════════════
    // FIX v5.1.0 (A-4): Declarative event bridge table.
    //
    // Replaces 35 imperative bus.on() calls with a data-driven table.
    // Benefits:
    //   - Domain-grouped: failures in one domain don't cascade
    //   - Key-based dedup (W-1): safe for hot-reload
    //   - Testable: the table is pure data
    //   - Single subscription loop with per-handler try/catch
    // ══════════════════════════════════════════════════════

    // Status mappings: event → { state, detail(data) }
    // Grouped by architectural domain for readability.
    const STATUS_BRIDGE = [
      // ── Core ────────────────────────────────────────
      { event: 'agent:status',              fn: (d) => push('agent:status-update', d) },
      { event: 'idle:thinking',             state: 'thinking', detail: (d) => `${d.activity} (#${d.thought})` },
      { event: 'idle:thought-complete',     state: 'ready' },
      { event: 'idle:proactive-insight',   fn: (d) => { status({ state: 'insight', detail: `💡 ${d.insight}` }); push('agent:proactive-insight', d); } },
      { event: 'reasoning:step',            state: 'thinking', detail: (d) => `${d.step}/${d.total}` },
      { event: 'model:ollama-unavailable',  state: 'warning',  detail: () => 'Ollama not reachable — start with: ollama serve' },
      { event: 'model:no-models',           state: 'warning',  detail: () => 'No models — pull one with: ollama pull <model>' },

      // ── Agency ──────────────────────────────────────
      { event: 'goal:resumed',              state: 'ready',    detail: (d) => `Goal resumed: ${d.description?.slice(0, 50)}` },
      { event: 'failure:classified',        state: 'warning',  detail: (d) => `${d.category}: ${d.strategy}` },
      { event: 'steering:rest-mode',        state: 'resting',  detail: () => 'Low energy — rest mode active' },
      { event: 'steering:model-escalation', state: 'thinking', detail: () => 'High frustration — trying different approach' },
      // v7.5.1 (C-fix): GoalDriver resume-prompt is the only goal:* event with
      // a UI-anchored schema (title, currentStep, totalSteps, lastUpdated).
      // Bridge it as a dedicated push so the renderer can show a prompt.
      // The 4 sibling events (goal:driver-pickup / goal:resumed-auto /
      // goal:discarded / driver:unresponsive) are backend-only telemetry
      // - their preload ALLOWED_RECEIVE entries were removed in the same
      // commit because no UI consumer was ever wired.
      { event: 'ui:resume-prompt',          fn: (d) => push('ui:resume-prompt', d) },

      // ── Trust + Effectors ───────────────────────────
      { event: 'trust:level-changed',       state: 'ready',    detail: (d) => `Trust level: ${d.to}` },
      { event: 'trust:upgrades-available',  state: 'ready',    detail: (d) => `${d.count} trust upgrade(s) available` },
      { event: 'effector:executed',         state: 'ready',    detail: (d) => `Effector: ${d.name}` },
      { event: 'effector:blocked',          state: 'warning',  detail: (d) => `Effector blocked: ${d.name}` },
      { event: 'editor:open',              fn: (d) => push('agent:open-in-editor', d) },

      // ── Health ──────────────────────────────────────
      { event: 'health:degradation',        state: (d) => d.level === 'critical' ? 'error' : 'warning', detail: (d) => `[${d.service}] ${d.reason}` },
      { event: 'health:memory-leak',        state: 'warning',  detail: (d) => `Memory leak suspected: ${d.heapUsedMB}MB, trend: ${d.trend}` },
      { event: 'health:circuit-forced-open',state: 'error',    detail: (d) => `Circuit breaker OPEN: ${d.service} (${d.reason})` },

      // ── Cognitive Health ────────────────────────────
      { event: 'cognitive:service-degraded',  state: 'warning', detail: (d) => `[Cognitive] ${d.service} degraded — backoff ${Math.round(d.backoffMs / 1000)}s` },
      { event: 'cognitive:service-disabled',  state: 'warning', detail: (d) => `[Cognitive] ${d.service} disabled — auto-recover in ${Math.round(d.autoRecoverMs / 60000)}min` },
      { event: 'cognitive:service-recovered', state: 'ready',   detail: (d) => `[Cognitive] ${d.service} recovered` },

      // ── Organism ────────────────────────────────────
      { event: 'homeostasis:correction-applied', state: 'ready',   detail: (d) => `[Homeostasis] Correction: ${d.type}` },
      { event: 'homeostasis:allostasis',         state: 'ready',   detail: (d) => `[Allostasis] ${d.vital} threshold adapted (shift #${d.shifts})` },
      { event: 'immune:intervention',            state: 'warning', detail: (d) => `[Immune] ${d.description}` },
      { event: 'immune:quarantine',              state: 'warning', detail: (d) => `[Immune] Quarantined: ${d.source} (${Math.round(d.durationMs / 1000)}s)` },
      { event: 'metabolism:cost',                guard: (d) => d.cost > 0.08, state: 'warning', detail: (d) => `[Metabolism] High cost: ${d.cost} (${d.tokens}t, ${d.latencyMs}ms)` },

      // ── AgentLoop progress ──────────────────────────
      { event: 'agent-loop:started',         fn: (d) => push('agent:loop-progress',        { phase: 'started', ...d }) },
      { event: 'agent-loop:approval-needed', fn: (d) => push('agent:loop-approval-needed', d) },
      { event: 'agent-loop:needs-input',     fn: (d) => push('agent:loop-approval-needed', { action: 'user-input', ...d }) },
      { event: 'agent-loop:complete',        fn: (d) => push('agent:loop-progress',        { phase: 'complete', ...d }) },

      // v7.4.7: Settings toggle confirmation messages → chat
      { event: 'chat:system-message',        fn: (d) => push('agent:chat-system-message', d) },
    ];

    // Single subscription loop with per-handler isolation
    for (const mapping of STATUS_BRIDGE) {
      const key = `ui:${mapping.event}`; // W-1: key-based dedup
      bus.on(mapping.event, (d) => {
        try {
          // Guard: skip if condition not met (e.g. metabolism cost threshold)
          if (mapping.guard && !mapping.guard(d)) return;

          // Custom function (push to different channel)
          if (mapping.fn) { mapping.fn(d); return; }

          // Standard status update
          const state = typeof mapping.state === 'function' ? mapping.state(d) : mapping.state;
          const detail = mapping.detail ? mapping.detail(d) : undefined;
          status({ state, ...(detail !== undefined ? { detail } : {}) });
        } catch (err) {
          _log.debug(`[UI-BRIDGE] Handler error for "${mapping.event}":`, err.message);
        }
      }, { source: 'AgentCore:ui', key });
    }

    // Expose table for testing
    this._uiBridgeTable = STATUS_BRIDGE;
  }

  // ════════════════════════════════════════════════════════
  // SERVICE START
  // ════════════════════════════════════════════════════════

  _startServices() {
    const c = this._c;
    const settings = c.has('settings') ? c.resolve('settings') : null;
    const bus = c.has('bus') ? c.resolve('bus') : null;
    const start = (name, ...args) => {
      if (c.has(name)) {
        try { c.resolve(name).start(...args); }
        catch (err) { _log.warn(`[GENESIS] ${name}.start() failed:`, err.message); }
      }
    };

    // Phase 5: Core orchestration
    start('learningService');

    // Phase 6: Autonomy — v7.4.7: respect daemon.enabled / idleMind.enabled
    // settings. Service is still resolvable in the container (DaemonController
    // and other services may have it as a dep), only `.start()` is skipped.
    const daemonEnabled = settings?.get?.('daemon.enabled') !== false;
    const idleMindEnabled = settings?.get?.('idleMind.enabled') !== false;
    if (daemonEnabled) {
      start('daemon');
    } else {
      _log.info('[GENESIS] daemon.enabled=false — skipping daemon.start() (service still resolvable)');
    }
    if (idleMindEnabled) {
      start('idleMind');
    } else {
      _log.info('[GENESIS] idleMind.enabled=false — skipping idleMind.start() (service still resolvable)');
    }
    start('healthMonitor', 10000);
    start('cognitiveMonitor');
    start('desktopPerception');

    // Phase 7: Organism
    start('emotionalState');
    start('homeostasis');
    start('needsSystem');
    start('homeostasisEffectors');
    start('metabolism');
    start('immuneSystem');
    start('bodySchema');

    // Phase 9: Cognitive Architecture
    start('surpriseAccumulator');
    start('selfNarrative');

    // Phase 10: Agency
    start('emotionalSteering');
    start('userModel');
    start('fitnessEvaluator');  // v5.0.0: evolution layer

    // Phase 4: Planning
    start('valueStore');

    // Phase 13 → AwarenessPort (no-op by default)
    start('awareness');

    // v7.4.7: Wire Settings → bus, then attach runtime toggle listeners.
    // Without setBus, set() emits nothing and these listeners never fire.
    if (settings && bus && typeof settings.setBus === 'function') {
      settings.setBus(bus);
    }
    this._wireRuntimeToggleListeners(bus, c);
  }

  /**
   * v7.4.7: Listen for setting changes that should take effect at runtime
   * (daemon, idleMind, selfMod, trust). When the user saves Settings, the
   * UI calls Settings.set() which emits these events; the listeners here
   * carry out the side effects (start/stop services, push trust level,
   * etc.) without requiring a restart.
   *
   * @param {*} bus
   * @param {*} c container
   */
  _wireRuntimeToggleListeners(bus, c) {
    if (!bus || typeof bus.on !== 'function') return;

    // v7.4.7: i18n for chat-notify messages. The lang service is in the
    // container since phase 0 (AgentCoreBoot:77 c.registerInstance('lang')).
    // We resolve it here lazily so test harnesses without a lang service
    // still work via the fallback.
    const lang = c.has('lang') ? c.resolve('lang') : null;
    const t = (key, vars) => {
      if (lang && typeof lang.t === 'function') {
        try { return lang.t(key, vars || {}); } catch (_e) { /* fall through */ }
      }
      return key; // last-resort fallback — better than nothing
    };

    const tryStart = (name) => {
      if (!c.has(name)) return;
      try {
        const svc = c.resolve(name);
        if (typeof svc.start === 'function') svc.start();
        _log.info(`[GENESIS] runtime: ${name}.start() (settings toggle)`);
      } catch (err) { _log.warn(`[GENESIS] runtime ${name}.start() failed:`, err.message); }
    };
    const tryStop = (name) => {
      if (!c.has(name)) return;
      try {
        const svc = c.resolve(name);
        if (typeof svc.stop === 'function') svc.stop();
        _log.info(`[GENESIS] runtime: ${name}.stop() (settings toggle)`);
      } catch (err) { _log.warn(`[GENESIS] runtime ${name}.stop() failed:`, err.message); }
    };
    const chatNotify = (msg) => {
      try { bus.emit('chat:system-message', { text: msg }, { source: 'AgentCoreWire' }); }
      catch (_e) { /* never let chat-notify break a runtime toggle */ }
    };

    // Daemon
    bus.on('settings:daemon-toggled', (ev) => {
      if (ev.to === true)  { tryStart('daemon');  chatNotify(t('ui.toggle.daemon_on')); }
      if (ev.to === false) { tryStop('daemon');   chatNotify(t('ui.toggle.daemon_off')); }
    });

    // IdleMind
    bus.on('settings:idlemind-toggled', (ev) => {
      if (ev.to === true)  { tryStart('idleMind'); chatNotify(t('ui.toggle.idlemind_on')); }
      if (ev.to === false) { tryStop('idleMind');  chatNotify(t('ui.toggle.idlemind_off')); }
    });

    // Self-Modification gate — no service to start/stop, just a flag the
    // SelfModificationPipeline checks. We just notify in chat.
    bus.on('settings:selfmod-toggled', (ev) => {
      chatNotify(ev.to ? t('ui.toggle.selfmod_on') : t('ui.toggle.selfmod_off'));
    });

    // Trust level — call setLevel on TrustLevelSystem so its own
    // 'trust:level-changed' event fires for downstream listeners.
    bus.on('settings:trust-level-changed', (ev) => {
      if (typeof ev.to !== 'number') return;
      if (!c.has('trustLevelSystem')) return;
      try {
        c.resolve('trustLevelSystem').setLevel(ev.to);
        // Use the same i18n keys as the dropdown, stripped of parens text
        const trustKeys = ['ui.trust_supervised', 'ui.trust_assisted', 'ui.trust_autonomous', 'ui.trust_full'];
        const fullLabel = t(trustKeys[ev.to] || `level ${ev.to}`);
        // The dropdown text includes a parenthetical hint like "Assisted (ask for risky)" —
        // for the chat notification we want the short name only.
        const short = fullLabel.split('(')[0].trim();
        chatNotify(t('ui.toggle.trust_level', { level: short }));
      } catch (err) { _log.warn('[GENESIS] runtime trustLevel.setLevel failed:', err.message); }
    });

    // v7.4.7: Auto-Resume Mode — GoalDriver reads agency.autoResumeGoals
    // on each scan, so the new value takes effect on the next pickup pass
    // without restart. We just notify here so the user sees the toggle
    // landed and the boot-pickup behavior will use the new value.
    bus.on('settings:auto-resume-changed', (ev) => {
      const modeKeys = { ask: 'ui.auto_resume_ask', always: 'ui.auto_resume_always', never: 'ui.auto_resume_never' };
      const fullLabel = t(modeKeys[ev.to] || ev.to);
      const short = fullLabel.split('(')[0].trim();
      chatNotify(t('ui.toggle.auto_resume', { mode: short }));
    });

    // v7.4.7: MCP serve toggle — start/stop the embedded MCP server so
    // external clients can connect without a Genesis restart. Port
    // changes are not picked up here; that requires a stop+start, which
    // the user can effect by toggling off then on.
    bus.on('settings:mcp-serve-toggled', async (ev) => {
      if (!c.has('mcpClient')) return;
      try {
        const mcp = c.resolve('mcpClient');
        if (ev.to === true) {
          const settings = c.has('settings') ? c.resolve('settings') : null;
          const port = settings?.get?.('mcp.serve.port') || 3580;
          await mcp.startServer(port);
          chatNotify(t('ui.toggle.mcp_started', { port }));
        } else if (ev.to === false) {
          if (mcp._mcpServer && typeof mcp._mcpServer.stop === 'function') {
            await mcp._mcpServer.stop();
          }
          chatNotify(t('ui.toggle.mcp_stopped'));
        }
      } catch (err) {
        _log.warn('[GENESIS] runtime mcp serve toggle failed:', err.message);
        chatNotify(t('ui.toggle.mcp_failed', { error: err.message }));
      }
    });
  }
}

module.exports = { AgentCoreWire };
