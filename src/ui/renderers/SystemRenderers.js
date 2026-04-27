// ============================================================
// GENESIS — SystemRenderers.js (v7.0.1 — DashboardRenderers split)
// ============================================================
'use strict';

function apply(Dashboard) {
  const proto = Dashboard.prototype;

  proto._renderVitals = function(health) {
    if (!health?.organism?.homeostasis) {
      this._el('dash-vitals-body').innerHTML = '<span class="dash-muted">Not available</span>';
      return;
    }

    var h = health.organism.homeostasis;
    var vitals = h.vitals || {};
    var state = h.state || 'healthy';
    var stateColors = { healthy: '#639922', stressed: '#ef9f27', recovering: '#d4537e', critical: '#e24b4a' };

    var self = this;
    var vitalRows = Object.entries(vitals).map(function(entry) {
      var name = entry[0], v = entry[1];
      var statusDot = v.status === 'healthy' ? '\uD83D\uDFE2' : v.status === 'warning' ? '\uD83D\uDFE1' : '\uD83D\uDD34';
      var displayVal = typeof v.value === 'number' ? v.value.toFixed(2) : v.value;
      return '<div class="dash-vital-row">' +
        '<span>' + statusDot + '</span>' +
        '<span class="dash-vital-name">' + self._esc(name) + '</span>' +
        '<span class="dash-vital-val">' + self._esc(displayVal) + (v.unit !== 'state' ? self._esc(v.unit) : '') + '</span>' +
      '</div>';
    }).join('');

    var errRate = h.errorRate !== undefined
      ? '<div class="dash-stat"><span>Error rate</span><span>' + (h.errorRate * 100).toFixed(1) + '%</span></div>'
      : '';

    this._el('dash-vitals-body').innerHTML =
      '<div class="dash-state-badge" style="background:' + (stateColors[state] || '#888') + '">' + this._esc(state.toUpperCase()) + '</div>' +
      vitalRows + errRate +
      (!h.autonomyAllowed ? '<div class="dash-warn">\u26A0 Autonomy paused</div>' : '');
  };

  // == Agent Loop Section ==================================


  proto._renderMemory = function(health, session) {
    var parts = [];

    if (health?.memory) {
      var m = health.memory;
      parts.push('<div class="dash-stat"><span>Facts</span><span>' + (m.facts || 0) + '</span></div>');
      parts.push('<div class="dash-stat"><span>Episodes</span><span>' + (m.episodes || 0) + '</span></div>');
    }
    if (health?.knowledgeGraph) {
      parts.push('<div class="dash-stat"><span>KG nodes</span><span>' + (health.knowledgeGraph.nodes || 0) + '</span></div>');
    }
    if (health?.unifiedMemory) {
      parts.push('<div class="dash-stat"><span>Unified queries</span><span>' + (health.unifiedMemory.searchCount || 0) + '</span></div>');
    }
    if (health?.embeddings?.available) {
      parts.push('<div class="dash-stat"><span>Embeddings</span><span>' + this._esc(health.embeddings.model || '?') + ' (' + (health.embeddings.dimensions || '?') + 'd)</span></div>');
    }
    if (session?.sessionHistory !== undefined) {
      parts.push('<div class="dash-stat"><span>Past sessions</span><span>' + session.sessionHistory + '</span></div>');
    }
    if (session?.currentSession) {
      parts.push('<div class="dash-stat"><span>This session</span><span>' + (session.currentSession.messageCount || 0) + ' msgs / ' + (session.currentSession.duration || '0m') + '</span></div>');
    }
    if (session?.userProfile?.name) {
      parts.push('<div class="dash-stat"><span>User</span><span>' + this._esc(session.userProfile.name) + '</span></div>');
    }

    this._el('dash-memory-body').innerHTML = parts.length > 0
      ? '<div class="dash-stats">' + parts.join('') + '</div>'
      : '<span class="dash-muted">No data</span>';
  };

  // == Self-Modifications Section (v7.4.9) =================
  // Surfaces the EventStore.getProjection('modifications') data:
  // last 5 self-modifications with file, time, source, success state.

  proto._renderModifications = function(modifications) {
    var el = this._el('dash-modifications-body');
    if (!el) return;
    if (!modifications || !Array.isArray(modifications.history) || modifications.history.length === 0) {
      el.innerHTML = '<span class="dash-muted">No modifications yet</span>';
      return;
    }
    var total = modifications.totalModifications || modifications.history.length;
    // Defensive copy — projection state must not be mutated by renderer.
    var recent = modifications.history.slice(-5).reverse();
    var self = this;
    var rows = recent.map(function(m) {
      var icon = m.success === false ? '\u274C' : '\u2705';
      var file = (m.file || '?');
      // Trim long paths: keep last 2 segments
      var parts = file.split(/[\\/]/);
      var shortFile = parts.length > 2 ? '\u2026/' + parts.slice(-2).join('/') : file;
      var time = '';
      if (m.timestamp) {
        try { time = new Date(m.timestamp).toLocaleTimeString(); }
        catch (_e) { time = ''; }
      }
      var source = m.source ? self._esc(String(m.source).slice(0, 24)) : '';
      return '<div class="dash-mod-row">' +
        '<span class="dash-mod-icon">' + icon + '</span>' +
        '<span class="dash-mod-file" title="' + self._esc(file) + '">' + self._esc(shortFile) + '</span>' +
        '<span class="dash-mod-meta">' + (time ? self._esc(time) : '') + (source ? ' \u00B7 ' + source : '') + '</span>' +
      '</div>';
    }).join('');
    el.innerHTML =
      '<div class="dash-stat"><span>Total</span><span>' + total + '</span></div>' +
      '<div class="dash-mod-list">' + rows + '</div>';
  };

  // == Event Flow Section ==================================


  proto._renderEventFlow = function(eventDebug) {
    var el = this._el('dash-events-body');
    if (!eventDebug) {
      el.innerHTML = '<span class="dash-muted">Not available</span>';
      return;
    }

    var history = eventDebug.history || [];
    var listenerReport = eventDebug.listenerReport || {};

    // Group recent events into chains by timestamp proximity (50ms window)
    var chains = [];
    var currentChain = [];
    var lastTs = 0;

    for (var i = 0; i < history.length; i++) {
      var evt = history[i];
      if (evt.timestamp - lastTs > 50 && currentChain.length > 0) {
        chains.push(currentChain);
        currentChain = [];
      }
      currentChain.push(evt);
      lastTs = evt.timestamp;
    }
    if (currentChain.length > 0) chains.push(currentChain);

    // Show last 8 chains
    var recentChains = chains.slice(-8);

    // Color map for event namespaces
    var nsColors = {
      'agent': '#6c8cff', 'chat': '#4ade80', 'user': '#fbbf24',
      'llm': '#f87171', 'idle': '#5dcaa5', 'emotion': '#d4537e',
      'goal': '#ef9f27', 'circuit': '#888780', 'health': '#639922',
      'code': '#e24b4a', 'cognitive': '#c084fc', 'module': '#378add',
      'intent': '#1d9e75', 'reasoning': '#fbbf24', 'agent-loop': '#6c8cff',
      'expectation': '#c084fc', 'dream': '#d4537e', 'surprise': '#ef9f27',
      'container': '#888780', 'peer': '#378add', 'verification': '#4ade80',
      'homeostasis': '#639922', 'editor': '#5dcaa5', 'store': '#888780',
    };

    function getColor(event) {
      var ns = event.split(':')[0];
      return nsColors[ns] || 'rgba(255,255,255,0.5)';
    }

    function shortEvent(event) {
      return event
        .replace('agent-loop:', 'loop:')
        .replace('agent:', 'agt:')
        .replace(':completed', ':done')
        .replace(':started', ':start')
        .replace('cognitive:', 'cog:')
        .replace('homeostasis:', 'hom:')
        .replace('expectation:', 'exp:')
        .replace('verification:', 'ver:');
    }

    var chainHTML = '';
    for (var c = 0; c < recentChains.length; c++) {
      var chain = recentChains[c];
      var elapsed = chain.length > 1 ? (chain[chain.length - 1].timestamp - chain[0].timestamp) + 'ms' : '';
      var self = this;
      var nodes = chain.map(function(evt) {
        var color = getColor(evt.event);
        var short = shortEvent(evt.event);
        return '<span class="dash-evt-node" style="border-color:' + color + ';color:' + color + '" title="' +
          self._esc(evt.event) + ' \u2190 ' + self._esc(evt.source || '?') + '">' + self._esc(short) + '</span>';
      });

      chainHTML += '<div class="dash-evt-chain">' +
        nodes.join('<span class="dash-evt-arrow">\u2192</span>') +
        (elapsed ? '<span class="dash-evt-elapsed">' + elapsed + '</span>' : '') +
        '</div>';
    }

    // Listener health: flag hotspots
    var suspects = (listenerReport.suspects || []).slice(0, 3);
    var hotHTML = '';
    if (suspects.length > 0) {
      hotHTML = '<div class="dash-section-sub">Listener Hotspots</div>';
      for (var s = 0; s < suspects.length; s++) {
        var sus = suspects[s];
        hotHTML += '<div class="dash-evt-hot"><span class="dash-evt-hot-name">' +
          this._esc(shortEvent(sus.event)) + '</span><span class="dash-evt-hot-count">' +
          sus.count + ' listeners</span></div>';
      }
    }

    var statsHTML = '<div class="dash-stats">' +
      '<div class="dash-stat"><span>Events registered</span><span>' + (eventDebug.registeredEvents || 0) + '</span></div>' +
      '<div class="dash-stat"><span>Total listeners</span><span>' + (listenerReport.total || 0) + '</span></div>' +
      '</div>';

    el.innerHTML = statsHTML +
      '<div class="dash-section-sub">Recent Chains</div>' +
      (chainHTML || '<span class="dash-muted">No events yet</span>') +
      hotHTML;
  };

  // == System Section ======================================


  proto._renderSystem = function(health) {
    if (!health) {
      this._el('dash-system-body').innerHTML = '<span class="dash-muted">No data</span>';
      return;
    }

    var uptime = health.uptime ? this._formatUptime(health.uptime) : '?';
    var circuit = health.circuit?.state || '?';
    var circuitColor = circuit === 'CLOSED' ? '#639922' : circuit === 'HALF_OPEN' ? '#ef9f27' : '#e24b4a';

    var self = this;
    var intervals = Array.isArray(health.intervals)
      ? health.intervals.map(function(i) {
          return '<span class="dash-interval ' + (i.paused ? 'dash-paused' : '') + '">' + self._esc(i.name) + '</span>';
        }).join(' ')
      : '';

    var storageInfo = health.storage
      ? '<div class="dash-stat"><span>Storage writes</span><span>' + (health.storage.writes || 0) + '</span></div>'
      : '';

    var mcpInfo = health.mcp
      ? '<div class="dash-stat"><span>MCP</span><span>' + (health.mcp.connectedCount || 0) + '/' + (health.mcp.serverCount || 0) + ' servers</span></div>'
      : '';

    // v5.9.0: MCP Server status + toggle
    var mcpServing = health.mcp?.serving;
    var mcpServerInfo = mcpServing
      ? '<div class="dash-stat"><span>MCP Server</span><span class="dash-ok">:' + mcpServing + '</span></div>'
      : '<div class="dash-stat"><span>MCP Server</span><span class="dash-muted">off</span></div>';
    var mcpToggle = '<div class="dash-mcp-toggle">' +
      '<button class="dash-btn ' + (mcpServing ? 'dash-btn-reject' : 'dash-btn-approve') + '" id="btn-mcp-toggle">' +
      (mcpServing ? 'Stop Server' : 'Start Server') + '</button></div>';

    this._el('dash-system-body').innerHTML =
      '<div class="dash-stats">' +
        '<div class="dash-stat"><span>Uptime</span><span>' + uptime + '</span></div>' +
        '<div class="dash-stat"><span>Services</span><span>' + (health.services || '?') + '</span></div>' +
        '<div class="dash-stat"><span>Tools</span><span>' + (health.tools || '?') + '</span></div>' +
        '<div class="dash-stat"><span>Model</span><span>' + this._esc(health.model?.active || 'none') + '</span></div>' +
        '<div class="dash-stat"><span>Circuit</span><span style="color:' + circuitColor + '">' + this._esc(circuit) + '</span></div>' +
        '<div class="dash-stat"><span>IdleMind</span><span>' + (health.idleMind?.thoughtCount || 0) + ' thoughts</span></div>' +
        '<div class="dash-stat"><span>Goals</span><span>' + (health.goals?.active || 0) + '/' + (health.goals?.total || 0) + '</span></div>' +
        '<div class="dash-stat"><span>Shell cmds</span><span>' + (health.shell?.totalCommands || 0) + '</span></div>' +
        storageInfo + mcpInfo + mcpServerInfo +
      '</div>' +
      mcpToggle +
      (intervals ? '<div class="dash-section-sub">Intervals</div><div class="dash-intervals">' + intervals + '</div>' : '');

    // Wire toggle button
    var toggleBtn = (typeof document !== 'undefined') ? document.getElementById('btn-mcp-toggle') : null;
    if (toggleBtn && window.genesis) {
      toggleBtn.addEventListener('click', function() {
        if (mcpServing) {
          window.genesis.invoke('agent:mcp-stop-server').catch(function(err) { console.debug('[DASH] MCP stop:', err.message); });
        } else {
          window.genesis.invoke('agent:mcp-start-server').catch(function(err) { console.debug('[DASH] MCP start:', err.message); });
        }
      });
    }
  };


  proto._formatUptime = function(seconds) {
    if (seconds < 60) return Math.round(seconds) + 's';
    if (seconds < 3600) return Math.round(seconds / 60) + 'm';
    return Math.floor(seconds / 3600) + 'h ' + Math.round((seconds % 3600) / 60) + 'm';
  };

  // ── v5.5.0: Reasoning Trace Panel ──────────────────────
}

// Browser: register as global so DashboardRenderers barrel can find it without require()
if (typeof window !== 'undefined') window._genesis_SystemRenderers = apply;
if (typeof module !== 'undefined' && module.exports) module.exports = apply;
