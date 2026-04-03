// ============================================================
// GENESIS - DashboardRenderers.js (v5.4.0 - God-Class Extraction)
//
// Extracted rendering methods from Dashboard.js to resolve the
// God-Class finding (32 methods -> ~12 in Dashboard.js).
//
// Pattern: Delegate extraction (same as McpCodeExec, WorldStateQueries)
// Dashboard.js retains: constructor, inject, toggle, refresh, _esc, _el, _buildHTML
// This file: all _render*, _build* (data visualization), _moodEmoji
// DashboardStyles.js: _buildCSS
// ============================================================

'use strict';

/**
 * Apply rendering methods to Dashboard.prototype.
 * @param {Function} Dashboard - The Dashboard class
 */
function applyRenderers(Dashboard) {
  const proto = Dashboard.prototype;

  // == Organism Section ====================================

  proto._renderOrganism = function(organism) {
    if (!organism) {
      this._el('dash-organism-body').innerHTML = '<span class="dash-muted">Not available</span>';
      return;
    }

    const emo = organism.emotions;
    if (!emo) return;

    const state = emo.state || {};
    this._moodHistory.push({ ts: Date.now(), ...state });
    if (this._moodHistory.length > this._moodHistoryMax) this._moodHistory.shift();

    const mood = emo.mood || 'calm';
    const moodColors = {
      frustrated: '#e24b4a', exhausted: '#888780', lonely: '#d4537e',
      curious: '#1d9e75', content: '#639922', focused: '#378add',
      tense: '#ef9f27', tired: '#b4b2a9', calm: '#5dcaa5',
    };
    const color = moodColors[mood] || '#5dcaa5';
    const trend = emo.trend === 'rising' ? '\u2197' : emo.trend === 'falling' ? '\u2198' : '\u2192';

    const dimColors = {
      curiosity: '#1d9e75', satisfaction: '#639922',
      frustration: '#e24b4a', energy: '#378add', loneliness: '#d4537e',
    };
    const bars = ['curiosity', 'satisfaction', 'frustration', 'energy', 'loneliness']
      .map(dim => {
        const val = state[dim] || 0;
        const pct = Math.round(val * 100);
        return '<div class="dash-bar-row">' +
          '<span class="dash-bar-label">' + dim.slice(0, 3) + '</span>' +
          '<div class="dash-bar-track"><div class="dash-bar-fill" style="width:' + pct + '%;background:' + (dimColors[dim] || '#6c8cff') + '"></div></div>' +
          '<span class="dash-bar-val">' + pct + '</span>' +
          '</div>';
      }).join('');

    const sparklineHTML = this._buildSparkline();

    const needs = organism.needs;
    const needsRadar = needs ? this._buildNeedsRadar(needs.needs || {}) : '';

    const recs = (needs?.recommendations || []);
    const recsHTML = recs.length > 0
      ? '<div class="dash-recs">' + recs.map(r => '<span class="dash-rec-tag">' + this._esc(r.activity || r) + '</span>').join('') + '</div>'
      : '';

    const driveInfo = needs?.totalDrive !== undefined ? 'Drive: ' + Math.round(needs.totalDrive * 100) + '%' : '';

    this._el('dash-organism-body').innerHTML =
      '<div class="dash-mood">' +
        '<div class="dash-mood-ring" style="border-color:' + color + ';box-shadow:0 0 12px ' + color + '44">' +
          '<span class="dash-mood-emoji">' + this._moodEmoji(mood) + '</span>' +
        '</div>' +
        '<div class="dash-mood-text">' +
          '<span class="dash-mood-label">' + this._esc(mood) + ' ' + trend + '</span>' +
          '<span class="dash-muted">' + (emo.dominant ? 'Dominant: ' + this._esc(emo.dominant.emotion || emo.dominant.name || String(emo.dominant)) + (emo.dominant.intensity != null ? ' (' + Math.round(emo.dominant.intensity * 100) + '%)' : '') : '') + '</span>' +
          '<span class="dash-muted">' + driveInfo + '</span>' +
        '</div>' +
      '</div>' +
      sparklineHTML +
      '<div class="dash-section-sub">Emotions</div>' +
      bars +
      (needsRadar ? '<div class="dash-section-sub">Needs</div>' + needsRadar : '') +
      (recsHTML ? '<div class="dash-section-sub">Recommended</div>' + recsHTML : '');
  };

  proto._moodEmoji = function(mood) {
    var map = {
      frustrated: '\uD83D\uDE24', exhausted: '\uD83D\uDE34', lonely: '\uD83E\uDEE5',
      curious: '\uD83E\uDDD0', content: '\uD83D\uDE0C', focused: '\uD83C\uDFAF',
      tense: '\uD83D\uDE2C', tired: '\uD83D\uDCA4', calm: '\uD83C\uDF3F',
    };
    return map[mood] || '\uD83C\uDF3F';
  };

  proto._buildSparkline = function() {
    if (this._moodHistory.length < 3) return '';

    var w = 240, h = 32, pad = 2;
    var points = this._moodHistory.map(function(m) { return m.energy || 0.5; });
    var maxPts = points.length;
    var dx = (w - 2 * pad) / (maxPts - 1);

    var pathData = points.map(function(v, i) {
      var x = pad + i * dx;
      var y = h - pad - v * (h - 2 * pad);
      return (i === 0 ? 'M' : 'L') + x.toFixed(1) + ' ' + y.toFixed(1);
    }).join(' ');

    return '<div class="dash-sparkline-wrap">' +
      '<svg width="' + w + '" height="' + h + '" viewBox="0 0 ' + w + ' ' + h + '">' +
        '<path d="' + pathData + '" fill="none" stroke="#5dcaa5" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>' +
      '</svg>' +
      '<span class="dash-muted" style="font-size:9px">energy (last ' + maxPts + ' ticks)</span>' +
    '</div>';
  };

  proto._buildNeedsRadar = function(needs) {
    var entries = Object.entries(needs);
    if (entries.length === 0) return '';

    var size = 130, cx = size / 2, cy = size / 2, r = size / 2 - 20;
    var n = entries.length;

    var rings = '';
    [r * 0.33, r * 0.66, r].forEach(function(ringR) {
      var ringPts = [];
      for (var i = 0; i < n; i++) {
        var angle = (Math.PI * 2 * i) / n - Math.PI / 2;
        ringPts.push((cx + Math.cos(angle) * ringR).toFixed(1) + ',' + (cy + Math.sin(angle) * ringR).toFixed(1));
      }
      rings += '<polygon points="' + ringPts.join(' ') + '" fill="none" stroke="rgba(255,255,255,0.08)" stroke-width="0.5"/>';
    });

    var axes = '', labels = '';
    entries.forEach(function(entry, i) {
      var name = entry[0];
      var angle = (Math.PI * 2 * i) / n - Math.PI / 2;
      var ax = cx + Math.cos(angle) * r;
      var ay = cy + Math.sin(angle) * r;
      var lx = cx + Math.cos(angle) * (r + 13);
      var ly = cy + Math.sin(angle) * (r + 13);
      axes += '<line x1="' + cx + '" y1="' + cy + '" x2="' + ax.toFixed(1) + '" y2="' + ay.toFixed(1) + '" stroke="rgba(255,255,255,0.06)" stroke-width="0.5"/>';
      labels += '<text x="' + lx.toFixed(1) + '" y="' + ly.toFixed(1) + '" text-anchor="middle" dominant-baseline="central" fill="rgba(255,255,255,0.45)" font-size="9" font-family="inherit">' + name.slice(0, 5) + '</text>';
    });

    var dataPts = entries.map(function(entry, i) {
      var val = entry[1];
      var v = typeof val === 'number' ? val : (val?.value || 0);
      var angle = (Math.PI * 2 * i) / n - Math.PI / 2;
      return (cx + Math.cos(angle) * r * v).toFixed(1) + ',' + (cy + Math.sin(angle) * r * v).toFixed(1);
    });

    return '<div class="dash-radar-wrap">' +
      '<svg width="' + size + '" height="' + size + '" viewBox="0 0 ' + size + ' ' + size + '">' +
        rings + axes +
        '<polygon points="' + dataPts.join(' ') + '" fill="rgba(239,159,39,0.2)" stroke="#ef9f27" stroke-width="1.5" stroke-linejoin="round"/>' +
        labels +
      '</svg>' +
    '</div>';
  };

  // == Vitals Section ======================================

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

  proto._renderAgentLoop = function(status) {
    var el = this._el('dash-loop-body');
    if (!status || !status.running) {
      el.innerHTML = '<span class="dash-muted">Idle \u2014 no active goal</span>';
      return;
    }

    var pct = status.stepCount > 0 ? Math.round((status.stepCount / (status.stepCount + 3)) * 100) : 0;
    var esc = this._esc.bind(this);
    var logHTML = (status.recentLog || []).map(function(l) {
      return '<div class="dash-log-entry ' + (l.error ? 'dash-log-err' : '') + '">' +
        '<span class="dash-log-step">#' + l.step + '</span>' +
        '<span class="dash-log-type">' + esc(l.type || '?') + '</span>' +
        '<span class="dash-log-desc">' + esc((l.description || '').slice(0, 60)) + '</span>' +
      '</div>';
    }).join('');

    el.innerHTML =
      '<div class="dash-loop-progress">' +
        '<div class="dash-progress-track"><div class="dash-progress-fill" style="width:' + pct + '%"></div></div>' +
        '<span class="dash-muted">Step ' + status.stepCount + ' \u00B7 ' + status.consecutiveErrors + ' errors</span>' +
      '</div>' +
      (status.pendingApproval ?
        '<div class="dash-approval">' +
          '<div class="dash-approval-text">' + esc(status.pendingApproval.description) + '</div>' +
          '<div class="dash-approval-btns">' +
            '<button id="dash-btn-approve" class="dash-btn dash-btn-approve">\u2713 Approve</button>' +
            '<button id="dash-btn-reject" class="dash-btn dash-btn-reject">\u2715 Reject</button>' +
          '</div>' +
        '</div>'
      : '') +
      '<div class="dash-log">' + logHTML + '</div>';

    // FIX v4.10.0: Bind approve/reject via addEventListener (CSP blocks inline onclick)
    if (status.pendingApproval) {
      document.getElementById('dash-btn-approve')?.addEventListener('click', () => { if (window._dashApprove) window._dashApprove(); });
      document.getElementById('dash-btn-reject')?.addEventListener('click', () => { if (window._dashReject) window._dashReject(); });
    }
  };

  proto._showApproval = function() {
    if (!this._visible) this.toggle();
    this.refresh();
  };

  proto._updateLoopProgress = function() {
    if (this._visible) this.refresh();
  };

  // == Cognitive Section ===================================

  proto._renderCognitive = function(cognitive, monitor) {
    var el = this._el('dash-cognitive-body');
    if (!cognitive && !monitor) {
      el.innerHTML = '<span class="dash-muted">Not available</span>';
      return;
    }

    var parts = [];

    if (cognitive?.verifier) {
      var v = cognitive.verifier;
      var total = (v.pass || 0) + (v.fail || 0) + (v.ambiguous || 0);
      if (total > 0) {
        var passRate = ((v.pass || 0) / total * 100).toFixed(0);
        parts.push('<div class="dash-stat"><span>Verifications</span><span>' + total + ' (' + passRate + '% pass)</span></div>');
      }
    }

    if (cognitive?.worldState) {
      var ws = cognitive.worldState;
      var ollamaClass = ws.ollamaStatus === 'running' ? 'dash-ok' : 'dash-err';
      parts.push('<div class="dash-stat"><span>Ollama</span><span class="' + ollamaClass + '">' + this._esc(ws.ollamaStatus || '?') + '</span></div>');
      if (ws.recentFiles !== undefined) {
        parts.push('<div class="dash-stat"><span>Modified files</span><span>' + ws.recentFiles + '</span></div>');
      }
    }

    if (cognitive?.metaLearning && cognitive.metaLearning.recordings !== undefined) {
      var ml = cognitive.metaLearning;
      parts.push('<div class="dash-stat"><span>ML recordings</span><span>' + (ml.recordings || 0) + '</span></div>');
      if (ml.strategies !== undefined) {
        parts.push('<div class="dash-stat"><span>Strategies</span><span>' + ml.strategies + '</span></div>');
      }
    }

    if (cognitive?.episodicMemory && cognitive.episodicMemory.episodes !== undefined) {
      parts.push('<div class="dash-stat"><span>Episodes</span><span>' + cognitive.episodicMemory.episodes + '</span></div>');
    }

    if (monitor) {
      if (monitor.anomalies !== undefined) {
        parts.push('<div class="dash-stat"><span>Anomalies</span><span>' + monitor.anomalies + '</span></div>');
      }
      if (monitor.confidenceAvg !== undefined) {
        parts.push('<div class="dash-stat"><span>Avg confidence</span><span>' + (monitor.confidenceAvg * 100).toFixed(0) + '%</span></div>');
      }
    }

    el.innerHTML = parts.length > 0
      ? '<div class="dash-stats">' + parts.join('') + '</div>'
      : '<span class="dash-muted">No cognitive data yet</span>';
  };

  // == Memory Section ======================================

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
    var toggleBtn = document.getElementById('btn-mcp-toggle');
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
  proto._renderReasoning = function(data) {
    const el = this._el('dash-reasoning-body');
    if (!data || !data.traces || data.traces.length === 0) {
      el.innerHTML = '<span class="dash-muted">No reasoning traces yet — decisions appear here as they happen.</span>';
      return;
    }

    const stats = data.stats || {};
    const header = '<div class="dash-reasoning-stats">' +
      '<span class="dash-muted">' + (stats.total || 0) + ' total traces</span>' +
      '</div>';

    // Group traces by correlationId into decision chains
    const groups = new Map(); // correlationId → trace[]
    const ungrouped = [];
    for (const t of data.traces) {
      if (t.correlationId) {
        if (!groups.has(t.correlationId)) groups.set(t.correlationId, []);
        groups.get(t.correlationId).push(t);
      } else {
        ungrouped.push(t);
      }
    }

    let html = header;

    // Render grouped decision chains
    if (groups.size > 0) {
      html += '<div class="dash-trace-groups">';
      for (const [corrId, traces] of groups) {
        const first = traces[0];
        const chainLabel = first.label || first.type || 'Decision';
        html += '<details class="dash-trace-chain">' +
          '<summary class="dash-trace-chain-head">' +
          '<span class="dash-trace-label">' + this._esc(chainLabel) + '</span>' +
          '<span class="dash-trace-chain-count">' + traces.length + ' steps</span>' +
          '<span class="dash-trace-age">' + (first.age || '') + '</span>' +
          '</summary>';
        for (let i = 0; i < traces.length; i++) {
          const t = traces[i];
          const indent = i > 0 ? ' dash-trace-child' : '';
          const connector = i > 0 ? '├─ ' : '';
          html += '<div class="dash-trace-row' + indent + '">' +
            '<span class="dash-trace-connector">' + connector + '</span>' +
            '<span class="dash-trace-label">' + (t.label || t.type) + '</span>' +
            '<span class="dash-trace-summary">' + (t.summary || '') + '</span>' +
            '</div>';
        }
        html += '</details>';
      }
      html += '</div>';
    }

    // Render ungrouped traces (no correlationId)
    if (ungrouped.length > 0) {
      const rows = ungrouped.map(function(t) {
        return '<div class="dash-trace-row">' +
          '<span class="dash-trace-label">' + (t.label || t.type) + '</span>' +
          '<span class="dash-trace-summary">' + (t.summary || '') + '</span>' +
          '<span class="dash-trace-age">' + (t.age || '') + '</span>' +
          '</div>';
      }).join('');
      html += '<div class="dash-trace-list">' + rows + '</div>';
    }

    el.innerHTML = html;
  };

  // ── v5.8.0: Consciousness Panel ─────────────────────────
  // PhenomenalField awareness, Attention gate, TemporalSelf, Values
  proto._renderConsciousness = function(data) {
    const el = this._el('dash-consciousness-body');
    if (!data) { el.innerHTML = '<span class="dash-muted">Keine Consciousness-Daten</span>'; return; }

    const pf = data.phenomenalField;
    const att = data.attention;
    const ts = data.temporalSelf;
    const vals = data.values;

    let html = '';

    // Phenomenal Field — awareness meter
    if (pf) {
      const awareness = Math.round((pf.awareness || pf.globalAwareness || 0) * 100);
      const valence = pf.valence != null ? (pf.valence > 0 ? '+' : '') + pf.valence.toFixed(2) : '—';
      const arousal = pf.arousal != null ? pf.arousal.toFixed(2) : '—';
      html += '<div class="dash-consciousness-row">' +
        '<span class="dash-label">Awareness</span>' +
        '<div class="dash-gauge-track"><div class="dash-gauge-fill dash-gauge-awareness" style="width:' + awareness + '%"></div></div>' +
        '<span class="dash-value">' + awareness + '%</span>' +
        '</div>' +
        '<div class="dash-consciousness-row">' +
        '<span class="dash-label">Valence</span><span class="dash-value">' + this._esc(valence) + '</span>' +
        '<span class="dash-label" style="margin-left:12px">Arousal</span><span class="dash-value">' + this._esc(arousal) + '</span>' +
        '</div>';
    }

    // Attention Gate
    if (att) {
      const focus = att.currentFocus || att.focus || '—';
      const filtered = att.filteredCount != null ? att.filteredCount : '—';
      html += '<div class="dash-consciousness-row">' +
        '<span class="dash-label">Focus</span><span class="dash-value">' + this._esc(String(focus)) + '</span>' +
        '<span class="dash-label" style="margin-left:12px">Filtered</span><span class="dash-value">' + filtered + '</span>' +
        '</div>';
    }

    // Temporal Self — narrative chapter
    if (ts) {
      const chapterRaw = ts.currentChapter || ts.chapter || ts.phase || '—';
      const chapter = typeof chapterRaw === 'object' ? (chapterRaw.title || chapterRaw.name || '—') : chapterRaw;
      const continuity = ts.continuityScore != null ? Math.round(ts.continuityScore * 100) + '%' : '—';
      html += '<div class="dash-consciousness-row">' +
        '<span class="dash-label">Chapter</span><span class="dash-value">' + this._esc(String(chapter)) + '</span>' +
        '<span class="dash-label" style="margin-left:12px">Continuity</span><span class="dash-value">' + continuity + '</span>' +
        '</div>';
    }

    // Values
    if (vals) {
      const alignment = vals.alignmentScore != null ? Math.round(vals.alignmentScore * 100) + '%' : '—';
      const conflicts = vals.conflicts || vals.conflictCount || 0;
      html += '<div class="dash-consciousness-row">' +
        '<span class="dash-label">Value Alignment</span><span class="dash-value">' + alignment + '</span>' +
        '<span class="dash-label" style="margin-left:12px">Conflicts</span><span class="dash-value">' + conflicts + '</span>' +
        '</div>';
    }

    el.innerHTML = html || '<span class="dash-muted">—</span>';
  };

  // ── v5.8.0: Energy Panel ────────────────────────────────
  // Metabolism energy gauge + cost/regen rates
  proto._renderEnergy = function(metabolism) {
    const el = this._el('dash-energy-body');
    if (!metabolism) { el.innerHTML = '<span class="dash-muted">Keine Metabolism-Daten</span>'; return; }

    const energy = metabolism.energy || {};
    const percent = energy.percent != null ? energy.percent : 0;
    const level = energy.level || 'unknown';
    const current = energy.current != null ? Math.round(energy.current) : '—';
    const max = energy.max != null ? energy.max : '—';
    const totalCost = metabolism.totalCost != null ? metabolism.totalCost.toFixed(1) : '—';
    const calls = metabolism.llmCalls || 0;

    const gaugeClass = level === 'depleted' ? 'dash-gauge-danger' :
                       level === 'low' ? 'dash-gauge-warn' : 'dash-gauge-ok';

    let html = '<div class="dash-energy-gauge">' +
      '<div class="dash-gauge-track"><div class="dash-gauge-fill ' + gaugeClass + '" style="width:' + percent + '%"></div></div>' +
      '<span class="dash-value">' + current + ' / ' + max + ' (' + percent + '%)</span>' +
      '<span class="dash-badge dash-badge-' + level + '">' + this._esc(level) + '</span>' +
      '</div>' +
      '<div class="dash-energy-stats">' +
      '<span class="dash-label">LLM Calls</span><span class="dash-value">' + calls + '</span>' +
      '<span class="dash-label" style="margin-left:12px">Total Cost</span><span class="dash-value">' + totalCost + '</span>' +
      '</div>';

    el.innerHTML = html;
  };

  // ── v5.8.0: Architecture Panel ──────────────────────────
  // Service count, events, layers, couplings from ArchitectureReflection
  proto._renderArchitecture = function(snapshot) {
    const el = this._el('dash-architecture-body');
    if (!snapshot) { el.innerHTML = '<span class="dash-muted">Keine Architecture-Daten</span>'; return; }

    const services = snapshot.services || 0;
    const events = snapshot.events || 0;
    const layers = snapshot.layers || 0;
    const couplings = snapshot.crossPhaseCouplings || snapshot.couplings || 0;
    const phases = snapshot.phases || {};

    let html = '<div class="dash-arch-summary">' +
      '<span class="dash-stat"><span class="dash-stat-num">' + services + '</span> Services</span>' +
      '<span class="dash-stat"><span class="dash-stat-num">' + events + '</span> Events</span>' +
      '<span class="dash-stat"><span class="dash-stat-num">' + layers + '</span> Layers</span>' +
      '<span class="dash-stat"><span class="dash-stat-num">' + couplings + '</span> Couplings</span>' +
      '</div>';

    // Phase map compact
    const phaseEntries = Object.entries(phases);
    if (phaseEntries.length > 0) {
      html += '<div class="dash-arch-phases">';
      for (const [phase, svcs] of phaseEntries) {
        const count = Array.isArray(svcs) ? svcs.length : 0;
        html += '<span class="dash-phase-pill" title="Phase ' + this._esc(phase) + ': ' + count + ' services">P' + this._esc(phase) + '<small>' + count + '</small></span>';
      }
      html += '</div>';
    }

    el.innerHTML = html;
  };

  // ── v5.8.0: Project Intelligence Panel ──────────────────
  // Stack, conventions, quality from ProjectIntelligence
  proto._renderProjectIntel = function(profile) {
    const el = this._el('dash-project-body');
    if (!profile) { el.innerHTML = '<span class="dash-muted">Keine Project-Daten</span>'; return; }

    const lang = profile.language || '—';
    const framework = profile.framework || '—';
    const testFw = profile.testFramework || '—';
    const pkg = profile.packageManager || '—';
    const files = profile.files || profile.fileCount || '—';
    const ts = profile.typescript ? 'Yes' : 'No';

    let html = '<div class="dash-project-grid">' +
      '<span class="dash-label">Language</span><span class="dash-value">' + this._esc(lang) + '</span>' +
      '<span class="dash-label">Framework</span><span class="dash-value">' + this._esc(framework) + '</span>' +
      '<span class="dash-label">Tests</span><span class="dash-value">' + this._esc(testFw) + '</span>' +
      '<span class="dash-label">Package Mgr</span><span class="dash-value">' + this._esc(pkg) + '</span>' +
      '<span class="dash-label">Files</span><span class="dash-value">' + files + '</span>' +
      '<span class="dash-label">TypeScript</span><span class="dash-value">' + ts + '</span>' +
      '</div>';

    // Conventions
    const conv = profile.conventions;
    if (conv) {
      html += '<div class="dash-project-conv">' +
        '<span class="dash-muted">' +
        [conv.moduleSystem, conv.indentation, conv.naming].filter(Boolean).join(' · ') +
        '</span></div>';
    }

    el.innerHTML = html;
  };

  // ── v5.8.0: Tool Synthesis Panel ────────────────────────
  // DynamicToolSynthesis stats
  proto._renderToolSynthesis = function(stats) {
    const el = this._el('dash-toolsynth-body');
    if (!stats) { el.innerHTML = '<span class="dash-muted">Keine Tool-Synthesis-Daten</span>'; return; }

    const generated = stats.generated || stats.totalGenerated || 0;
    const active = stats.active || stats.activeTools || 0;
    const failed = stats.failed || stats.totalFailed || 0;
    const evicted = stats.evicted || 0;

    let html = '<div class="dash-toolsynth-stats">' +
      '<span class="dash-stat"><span class="dash-stat-num">' + generated + '</span> Generated</span>' +
      '<span class="dash-stat"><span class="dash-stat-num">' + active + '</span> Active</span>' +
      '<span class="dash-stat"><span class="dash-stat-num">' + failed + '</span> Failed</span>' +
      '<span class="dash-stat"><span class="dash-stat-num">' + evicted + '</span> Evicted</span>' +
      '</div>';

    // Tool list
    const tools = stats.tools || stats.activeToolNames || [];
    if (tools.length > 0) {
      html += '<div class="dash-toolsynth-list">';
      for (const t of tools) {
        const name = typeof t === 'string' ? t : (t.name || '?');
        html += '<span class="dash-tool-pill">' + this._esc(name) + '</span>';
      }
      html += '</div>';
    }

    el.innerHTML = html;
  };

  // ── v5.9.2: Interactive Architecture Graph ──────────────

  // ── v5.9.2: Proactive Insights Timeline ─────────────────
  // Shows recent IdleMind activities and proactive insights chronologically.

  proto._renderInsightsTimeline = function(idleMindData) {
    const el = this._el('dash-insights-body');
    if (!idleMindData) {
      el.innerHTML = '<span class="dash-muted">Keine Insight-Daten</span>';
      return;
    }

    const activities = idleMindData.recentActivities || [];
    const thoughtCount = idleMindData.thoughtCount || 0;
    const isIdle = idleMindData.isIdle;
    const idleSince = idleMindData.idleSince || 0;

    let html = '<div class="dash-insights-header">' +
      '<span class="dash-stat"><span class="dash-stat-num">' + thoughtCount + '</span> thoughts</span>' +
      '<span class="dash-stat">' + (isIdle ? '💤 idle ' + this._formatDuration(idleSince) : '🟢 active') + '</span>' +
      '</div>';

    if (activities.length === 0) {
      html += '<span class="dash-muted">Noch keine Aktivitäten — IdleMind denkt nach wenn du idle bist.</span>';
    } else {
      html += '<div class="dash-insights-timeline">';
      for (const act of activities) {
        const activity = typeof act === 'string' ? act : (act.activity || act.type || '?');
        const result = typeof act === 'object' ? (act.result || act.insight || '') : '';
        const time = act.ts ? this._formatTime(act.ts) : '';
        const icon = this._insightIcon(activity);

        html += '<div class="dash-insight-entry">' +
          '<span class="dash-insight-icon">' + icon + '</span>' +
          '<div class="dash-insight-content">' +
          '<span class="dash-insight-activity">' + this._esc(activity) + '</span>';
        if (result) {
          html += '<span class="dash-insight-result">' + this._esc(String(result).slice(0, 120)) + '</span>';
        }
        html += '</div>';
        if (time) html += '<span class="dash-insight-time">' + time + '</span>';
        html += '</div>';
      }
      html += '</div>';
    }

    el.innerHTML = html;
  };

  proto._insightIcon = function(activity) {
    const icons = {
      'reflect': '🔍', 'review': '🔍', 'code-review': '🔍',
      'dream': '💭', 'consolidate': '💭',
      'explore': '🧭', 'mcp-explore': '🧭',
      'plan': '📋', 'goal': '📋',
      'learn': '📚', 'study': '📚',
      'optimize': '⚡', 'refactor': '⚡',
      'test': '🧪', 'verify': '🧪',
    };
    for (const [key, icon] of Object.entries(icons)) {
      if (activity.toLowerCase().includes(key)) return icon;
    }
    return '💡';
  };

  proto._formatDuration = function(ms) {
    if (ms < 60000) return Math.round(ms / 1000) + 's';
    if (ms < 3600000) return Math.round(ms / 60000) + 'min';
    return Math.round(ms / 3600000) + 'h';
  };

  proto._formatTime = function(ts) {
    try {
      const d = new Date(ts);
      return d.getHours().toString().padStart(2, '0') + ':' + d.getMinutes().toString().padStart(2, '0');
    } catch (_e) { return ''; }
  };

  // ── v5.9.2: Coupling Hotspot Heatmap ────────────────────
  // Shows which services have the most dependencies — lazy-loaded on toggle.

  proto._hotspotVisible = false;
  proto._hotspotToggleBound = false;

  proto._renderHotspotHeatmap = function() {
    if (!this._hotspotToggleBound) {
      const toggle = document.getElementById('dash-hotspot-toggle');
      if (toggle) {
        toggle.addEventListener('click', () => {
          this._hotspotVisible = !this._hotspotVisible;
          const body = document.getElementById('dash-hotspot-body');
          if (body) body.style.display = this._hotspotVisible ? 'block' : 'none';
          toggle.textContent = 'Coupling Hotspots ' + (this._hotspotVisible ? '▾' : '▸');
          if (this._hotspotVisible) this._loadHotspotData();
        });
        this._hotspotToggleBound = true;
      }
    }
  };

  proto._loadHotspotData = async function() {
    const container = document.getElementById('dash-hotspot-body');
    if (!container || !window.genesis) return;

    container.innerHTML = '<span class="dash-muted">Hotspots werden berechnet…</span>';
    try {
      const data = await window.genesis.invoke('agent:get-architecture-graph');
      if (!data || !data.nodes || !data.edges) {
        container.innerHTML = '<span class="dash-muted">Keine Graph-Daten</span>';
        return;
      }

      // Count connections per service node
      const connCount = new Map(); // nodeId → { in: n, out: n, name, layer, phase }
      for (const node of data.nodes) {
        if (node.type === 'service') {
          connCount.set(node.id, { in: 0, out: 0, name: node.name, layer: node.layer || '?', phase: node.phase });
        }
      }
      for (const edge of data.edges) {
        if (connCount.has(edge.from)) connCount.get(edge.from).out++;
        if (connCount.has(edge.to)) connCount.get(edge.to).in++;
      }

      // Sort by total connections descending
      const sorted = [...connCount.values()]
        .map(c => ({ ...c, total: c.in + c.out }))
        .sort((a, b) => b.total - a.total)
        .slice(0, 20);

      if (sorted.length === 0) {
        container.innerHTML = '<span class="dash-muted">Keine Hotspots</span>';
        return;
      }

      const maxTotal = sorted[0].total || 1;

      let html = '<div class="dash-hotspot-list">';
      for (const s of sorted) {
        const pct = Math.round((s.total / maxTotal) * 100);
        const heat = pct > 70 ? 'hot' : pct > 40 ? 'warm' : 'cool';
        html += '<div class="dash-hotspot-row">' +
          '<span class="dash-hotspot-name" title="' + this._esc(s.layer) + ' (Phase ' + s.phase + ')">' + this._esc(s.name) + '</span>' +
          '<div class="dash-hotspot-bar-track"><div class="dash-hotspot-bar dash-hotspot-' + heat + '" style="width:' + pct + '%"></div></div>' +
          '<span class="dash-hotspot-count">↗' + s.out + ' ↙' + s.in + '</span>' +
          '</div>';
      }
      html += '</div>';

      container.innerHTML = html;
    } catch (err) {
      container.innerHTML = '<span class="dash-muted">Hotspot-Fehler: ' + (err.message || '') + '</span>';
    }
  };
  // Lazy-loaded on toggle click. Uses ArchitectureGraph component.

  proto._archGraphInstance = null;
  proto._archGraphVisible = false;
  proto._archGraphToggleBound = false;

  proto._renderArchitectureGraph = function() {
    // Bind toggle once
    if (!this._archGraphToggleBound) {
      const toggle = document.getElementById('dash-archgraph-toggle');
      if (toggle) {
        toggle.addEventListener('click', () => {
          this._archGraphVisible = !this._archGraphVisible;
          const body = document.getElementById('dash-archgraph-body');
          if (body) body.style.display = this._archGraphVisible ? 'block' : 'none';
          toggle.textContent = 'Architecture Graph ' + (this._archGraphVisible ? '▾' : '▸');
          if (this._archGraphVisible && !this._archGraphInstance) {
            this._loadArchGraph();
          }
        });
        this._archGraphToggleBound = true;
      }
    }
  };

  proto._loadArchGraph = async function() {
    const container = document.getElementById('dash-archgraph-body');
    if (!container || !window.genesis) return;

    container.innerHTML = '<span class="dash-muted">Graph wird geladen…</span>';
    try {
      const data = await window.genesis.invoke('agent:get-architecture-graph');
      if (!data || !data.nodes) {
        container.innerHTML = '<span class="dash-muted">Keine Graph-Daten</span>';
        return;
      }
      if (this._archGraphInstance) this._archGraphInstance.destroy();
      /* global ArchitectureGraph */
      if (typeof window.ArchitectureGraph === 'function') {
        this._archGraphInstance = new window.ArchitectureGraph(container, data);
        this._archGraphInstance.render();
      } else {
        container.innerHTML = '<span class="dash-muted">ArchitectureGraph component not loaded</span>';
      }
    } catch (err) {
      container.innerHTML = '<span class="dash-muted">Graph-Fehler: ' + (err.message || 'unbekannt') + '</span>';
    }
  };

  // v5.9.7 (V6-11): Task Performance panel — empirical success rates
  proto._renderTaskOutcomes = function(stats) {
    var el = document.getElementById('dash-taskperf-body');
    if (!el) return;
    if (!stats || stats.total === 0) {
      el.innerHTML = '<span class="dash-muted">Noch keine Daten — TaskOutcomeTracker sammelt…</span>';
      return;
    }

    var html = '<div class="dash-taskperf-total">Gesamt: <strong>' + stats.total + '</strong> Aufgaben</div>';

    // Per-task-type bars
    var entries = Object.entries(stats.byTaskType)
      .sort(function(a, b) { return b[1].count - a[1].count; })
      .slice(0, 8);

    if (entries.length > 0) {
      html += '<div class="dash-section-sub">Nach Tasktyp</div>';
      html += '<div class="dash-taskperf-list">';
      for (var i = 0; i < entries.length; i++) {
        var type = entries[i][0];
        var s = entries[i][1];
        var pct = Math.round(s.successRate * 100);
        var heat = pct >= 80 ? 'good' : pct >= 60 ? 'warn' : 'bad';
        var costLabel = s.avgTokenCost > 999
          ? (s.avgTokenCost / 1000).toFixed(1) + 'k'
          : s.avgTokenCost;
        html += '<div class="dash-taskperf-row">' +
          '<span class="dash-taskperf-name">' + this._esc(type) + '</span>' +
          '<div class="dash-taskperf-bar-track">' +
            '<div class="dash-taskperf-bar dash-taskperf-' + heat + '" style="width:' + pct + '%"></div>' +
          '</div>' +
          '<span class="dash-taskperf-pct">' + pct + '%</span>' +
          '<span class="dash-taskperf-meta">n=' + s.count + ', ~' + costLabel + ' tok</span>' +
        '</div>';
      }
      html += '</div>';
    }

    // Per-backend comparison
    var backends = Object.entries(stats.byBackend)
      .filter(function(e) { return e[1].count >= 2; })
      .sort(function(a, b) { return b[1].count - a[1].count; });

    if (backends.length > 0) {
      html += '<div class="dash-section-sub">Nach Backend</div>';
      html += '<div class="dash-taskperf-backends">';
      for (var j = 0; j < backends.length; j++) {
        var name = backends[j][0];
        var bs = backends[j][1];
        var bpct = Math.round(bs.successRate * 100);
        var bheat = bpct >= 80 ? 'good' : bpct >= 60 ? 'warn' : 'bad';
        html += '<span class="dash-taskperf-backend dash-taskperf-' + bheat + '">' +
          this._esc(name) + ': ' + bpct + '% (n=' + bs.count + ')' +
        '</span>';
      }
      html += '</div>';
    }

    el.innerHTML = html;
  };

  // ── v5.9.8 (V6-11): Cognitive Self-Model Panel ──────────────
  proto._renderSelfModel = function(report) {
    var el = document.getElementById('dash-selfmodel-body');
    if (!el) return;
    if (!report || !report.profile || Object.keys(report.profile).length === 0) {
      el.innerHTML = '<span class="dash-muted">Noch keine Daten — CognitiveSelfModel sammelt…</span>';
      return;
    }

    var html = '';

    // ── Capability Radar (horizontal bars with Wilson floor) ──
    var entries = Object.entries(report.profile)
      .sort(function(a, b) { return b[1].sampleSize - a[1].sampleSize; })
      .slice(0, 8);

    if (entries.length > 0) {
      html += '<div class="dash-section-sub">Capability Profile (Wilson 90%)</div>';
      html += '<div class="dash-sm-radar">';
      for (var i = 0; i < entries.length; i++) {
        var type = entries[i][0];
        var e = entries[i][1];
        var floor = Math.round(e.confidenceLower * 100);
        var raw = Math.round(e.successRate * 100);
        var cls = e.isStrong ? 'strong' : e.isWeak ? 'weak' : 'mid';
        var badge = e.isStrong ? ' ★' : e.isWeak ? ' ⚠' : '';
        html += '<div class="dash-sm-row">' +
          '<span class="dash-sm-label">' + this._esc(type) + badge + '</span>' +
          '<div class="dash-sm-track">' +
            '<div class="dash-sm-bar-raw" style="width:' + raw + '%"></div>' +
            '<div class="dash-sm-bar dash-sm-' + cls + '" style="width:' + floor + '%"></div>' +
          '</div>' +
          '<span class="dash-sm-val">' + floor + '%</span>' +
          '<span class="dash-sm-n">n=' + e.sampleSize + '</span>' +
        '</div>';
      }
      html += '</div>';
    }

    // ── Backend Strength Map ──
    var bm = report.backendMap || {};
    var bmKeys = Object.keys(bm);
    if (bmKeys.length > 0) {
      html += '<div class="dash-section-sub">Backend Recommendations</div>';
      html += '<div class="dash-sm-backends">';
      for (var j = 0; j < Math.min(bmKeys.length, 6); j++) {
        var task = bmKeys[j];
        var rec = bm[task];
        html += '<span class="dash-sm-rec">' +
          '<strong>' + this._esc(task) + '</strong> → ' + this._esc(rec.recommended) +
        '</span>';
      }
      html += '</div>';
    }

    // ── Bias Alerts ──
    var biases = report.biases || [];
    if (biases.length > 0) {
      html += '<div class="dash-section-sub">Active Biases</div>';
      html += '<div class="dash-sm-biases">';
      for (var k = 0; k < biases.length; k++) {
        var b = biases[k];
        var sevCls = b.severity === 'high' ? 'bad' : b.severity === 'medium' ? 'warn' : 'info';
        html += '<div class="dash-sm-bias dash-sm-bias-' + sevCls + '">' +
          '<strong>' + this._esc(b.name) + '</strong> ' +
          '<span class="dash-sm-bias-ev">' + this._esc(b.evidence) + '</span>' +
        '</div>';
      }
      html += '</div>';
    }

    el.innerHTML = html;
  };
}

// UI scripts don't use CommonJS in browser, but we export for testability
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { applyRenderers };
}
