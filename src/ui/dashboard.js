// ============================================================
// GENESIS - dashboard.js (v5.8.0 - UI Overhaul Phase 1)
//
// Live visualization of Genesis's internal state.
// Injected into the existing renderer as a toggleable panel.
//
// v5.4.0: Extracted rendering + styles to delegates.
// v5.8.0: Added Consciousness, Energy, Architecture,
//         Project Intelligence, Tool Synthesis panels.
//
// Sections:
//   1. Organism - Mood ring + emotion bars + sparkline + needs radar
//   2. Consciousness - PhenomenalField awareness, attention, temporal self, values
//   3. Energy - Metabolism gauge + LLM cost tracking
//   4. Agent Loop - Current goal, step progress, approval queue
//   5. Vitals - Homeostasis vital signs with status indicators
//   6. Cognitive - VerificationEngine, WorldState, MetaLearning
//   7. Reasoning - Causal decision traces (v5.5.0)
//   8. Architecture - Service graph, phases, couplings (v5.8.0)
//   9. Project - Tech stack, conventions, quality (v5.8.0)
//  10. Tool Synthesis - Generated/active/failed tools (v5.8.0)
//  11. Memory - Vector memory stats, session history
//  12. Event Flow - Recent event chains, listener hotspots
//  13. System - Services, intervals, circuit breaker, uptime
//
// Updates every 2s via polling 8 IPC channels.
// Uses CSS custom properties from the existing theme.
// ============================================================

class Dashboard {
  constructor() {
    this._interval = null;
    this._visible = false;
    this._lastHealth = null;
    this._loopUnsub = null;
    this._approvalUnsub = null;
    this._moodHistory = [];
    this._moodHistoryMax = 30;
  }

  // FIX v4.12.4 (K-01): HTML-escape dynamic strings before innerHTML injection.
  _esc(text) {
    if (text == null) return '';
    const d = document.createElement('div');
    d.textContent = String(text);
    return d.innerHTML;
  }

  inject() {
    const panel = document.createElement('aside');
    panel.id = 'dashboard-panel';
    panel.className = 'panel hidden';
    panel.innerHTML = this._buildHTML();
    document.getElementById('main-layout').prepend(panel);

    // FIX v4.10.0: Bind close button via addEventListener (CSP blocks inline onclick)
    document.getElementById('btn-close-dashboard')?.addEventListener('click', () => this.toggle());

    const btn = document.createElement('button');
    btn.id = 'btn-dashboard';
    btn.className = 'topbar-btn';
    btn.title = 'Dashboard';
    btn.innerHTML = '\u25C8 <span data-i18n="ui.dashboard">Dashboard</span>';
    btn.addEventListener('click', () => this.toggle());
    document.querySelector('.topbar-center')?.prepend(btn);

    const style = document.createElement('style');
    style.textContent = this._buildCSS();
    document.head.appendChild(style);

    this._approvalUnsub = window.genesis?.on('agent:loop-approval-needed', () => {
      this._showApproval();
    });

    this._loopUnsub = window.genesis?.on('agent:loop-progress', () => {
      this._updateLoopProgress();
    });
  }

  toggle() {
    const panel = document.getElementById('dashboard-panel');
    if (!panel) return;

    this._visible = !this._visible;
    panel.classList.toggle('hidden', !this._visible);
    document.getElementById('btn-dashboard')?.classList.toggle('active', this._visible);

    if (this._visible) {
      this.refresh();
      this._interval = setInterval(() => this.refresh(), 2000);
    } else {
      clearInterval(this._interval);
      this._interval = null;
    }
  }

  async refresh() {
    if (!this._visible || !window.genesis) return;
    try {
      const [health, loopStatus, session, eventDebug, reasoningTraces, archSnapshot, projectProfile, toolSynthesis, taskOutcomes, selfModelReport] = await Promise.all([
        window.genesis.invoke('agent:get-health').catch(err => { console.debug('[DASH] Health:', err.message); return null; }),
        window.genesis.invoke('agent:loop-status').catch(err => { console.debug('[DASH] Loop status:', err.message); return null; }),
        window.genesis.invoke('agent:get-session').catch(err => { console.debug('[DASH] Session:', err.message); return null; }),
        window.genesis.invoke('agent:get-event-debug').catch(err => { console.debug('[DASH] Events:', err.message); return null; }),
        window.genesis.invoke('agent:get-reasoning-traces').catch(err => { console.debug('[DASH] Reasoning:', err.message); return null; }),
        window.genesis.invoke('agent:get-architecture').catch(err => { console.debug('[DASH] Architecture:', err.message); return null; }),
        window.genesis.invoke('agent:get-project-intel').catch(err => { console.debug('[DASH] Project:', err.message); return null; }),
        window.genesis.invoke('agent:get-tool-synthesis').catch(err => { console.debug('[DASH] ToolSynth:', err.message); return null; }),
        window.genesis.invoke('agent:get-task-outcomes').catch(err => { console.debug('[DASH] TaskOutcomes:', err.message); return null; }),
        window.genesis.invoke('agent:get-selfmodel-report').catch(err => { console.debug('[DASH] SelfModel:', err.message); return null; }),
      ]);
      if (!health) {
        this._renderOfflineState();
        return;
      }
      this._lastHealth = health;
      this._renderOrganism(health?.organism);
      this._renderVitals(health);
      this._renderAgentLoop(loopStatus);
      this._renderCognitive(health?.cognitive, health?.cognitiveMonitor);
      this._renderConsciousness(health?.consciousness);
      this._renderEnergy(health?.organism?.metabolism);
      this._renderReasoning(reasoningTraces);
      this._renderInsightsTimeline(health?.idleMind);
      this._renderMemory(health, session);
      this._renderArchitecture(archSnapshot);
      this._renderArchitectureGraph();
      this._renderHotspotHeatmap();
      this._renderProjectIntel(projectProfile);
      this._renderToolSynthesis(toolSynthesis);
      this._renderTaskOutcomes(taskOutcomes);
      this._renderSelfModel(selfModelReport);
      this._renderEventFlow(eventDebug);
      this._renderSystem(health);
    } catch (err) {
      console.debug('[DASH] Refresh failed:', err.message);
    }
  }

  // v4.0.0: Show meaningful state when agent health is unavailable
  _renderOfflineState() {
    const msg = '<span class="dash-muted">Agent nicht erreichbar - Ollama l\u00E4uft?</span>';
    for (const id of ['dash-organism-body', 'dash-consciousness-body', 'dash-energy-body',
                       'dash-vitals-body', 'dash-loop-body',
                       'dash-cognitive-body', 'dash-reasoning-body',
                       'dash-architecture-body', 'dash-project-body', 'dash-toolsynth-body',
                       'dash-memory-body', 'dash-events-body', 'dash-system-body']) {
      this._el(id).innerHTML = msg;
    }
  }

  // == Helpers =============================================

  _el(id) { return document.getElementById(id) || document.createElement('div'); }

  _buildHTML() {
    return '<div class="panel-header">' +
        '<span>\u25C8 Dashboard</span>' +
        '<button id="btn-close-dashboard" class="btn-icon">\u2715</button>' +
      '</div>' +
      '<div class="dash-scroll">' +
        '<div class="dash-section"><div class="dash-section-head">Organism</div><div id="dash-organism-body" class="dash-section-body"></div></div>' +
        '<div class="dash-section"><div class="dash-section-head">Consciousness</div><div id="dash-consciousness-body" class="dash-section-body"></div></div>' +
        '<div class="dash-section"><div class="dash-section-head">Energy</div><div id="dash-energy-body" class="dash-section-body"></div></div>' +
        '<div class="dash-section"><div class="dash-section-head">Agent Loop</div><div id="dash-loop-body" class="dash-section-body"></div></div>' +
        '<div class="dash-section"><div class="dash-section-head">Vitals</div><div id="dash-vitals-body" class="dash-section-body"></div></div>' +
        '<div class="dash-section"><div class="dash-section-head">Cognitive</div><div id="dash-cognitive-body" class="dash-section-body"></div></div>' +
        '<div class="dash-section"><div class="dash-section-head">Reasoning</div><div id="dash-reasoning-body" class="dash-section-body"></div></div>' +
        '<div class="dash-section"><div class="dash-section-head">Insights Timeline</div><div id="dash-insights-body" class="dash-section-body"></div></div>' +
        '<div class="dash-section"><div class="dash-section-head">Architecture</div><div id="dash-architecture-body" class="dash-section-body"></div></div>' +
        '<div class="dash-section"><div class="dash-section-head" id="dash-archgraph-toggle" style="cursor:pointer">Architecture Graph ▸</div><div id="dash-archgraph-body" class="dash-section-body" style="display:none;position:relative;"></div></div>' +
        '<div class="dash-section"><div class="dash-section-head" id="dash-hotspot-toggle" style="cursor:pointer">Coupling Hotspots ▸</div><div id="dash-hotspot-body" class="dash-section-body" style="display:none"></div></div>' +
        '<div class="dash-section"><div class="dash-section-head">Project</div><div id="dash-project-body" class="dash-section-body"></div></div>' +
        '<div class="dash-section"><div class="dash-section-head">Tool Synthesis</div><div id="dash-toolsynth-body" class="dash-section-body"></div></div>' +
        '<div class="dash-section"><div class="dash-section-head">Task Performance</div><div id="dash-taskperf-body" class="dash-section-body"></div></div>' +
        '<div class="dash-section"><div class="dash-section-head">Cognitive Self-Model</div><div id="dash-selfmodel-body" class="dash-section-body"></div></div>' +
        '<div class="dash-section"><div class="dash-section-head">Memory</div><div id="dash-memory-body" class="dash-section-body"></div></div>' +
        '<div class="dash-section"><div class="dash-section-head">Event Flow</div><div id="dash-events-body" class="dash-section-body"></div></div>' +
        '<div class="dash-section"><div class="dash-section-head">System</div><div id="dash-system-body" class="dash-section-body"></div></div>' +
      '</div>';
  }
}

// -- Apply delegate methods ----------------------------------
// In browser: loaded via <script> tags before this file.
// In test (Node): loaded via require().
if (typeof applyRenderers === 'function') {
  applyRenderers(Dashboard);
} else if (typeof require !== 'undefined') {
  try {
    const { applyRenderers: ar } = require('./DashboardRenderers');
    ar(Dashboard);
  } catch (_e) { /* browser without modules */ }
}

if (typeof applyStyles === 'function') {
  applyStyles(Dashboard);
} else if (typeof require !== 'undefined') {
  try {
    const { applyStyles: as } = require('./DashboardStyles');
    as(Dashboard);
  } catch (_e) { /* browser without modules */ }
}

// Global hooks for approval buttons
window._dashApprove = function() { window.genesis?.invoke('agent:loop-approve').catch(function(err) { console.debug('[DASH] Approve failed:', err.message); }); };
window._dashReject = function() { window.genesis?.invoke('agent:loop-reject').catch(function(err) { console.debug('[DASH] Reject failed:', err.message); }); };

// Auto-init
window._genesis_dashboard = new Dashboard();
document.addEventListener('DOMContentLoaded', function() {
  window._genesis_dashboard.inject();
});
