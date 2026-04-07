// ============================================================
// GENESIS — IntelRenderers.js (v7.0.1 — DashboardRenderers split)
// ============================================================
'use strict';

function apply(Dashboard) {
  const proto = Dashboard.prototype;

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

// Browser: register as global so DashboardRenderers barrel can find it without require()
if (typeof window !== 'undefined') window._genesis_IntelRenderers = apply;
if (typeof module !== 'undefined' && module.exports) module.exports = apply;

