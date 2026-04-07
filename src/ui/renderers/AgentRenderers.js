// ============================================================
// GENESIS — AgentRenderers.js (v7.0.1 — DashboardRenderers split)
// ============================================================
'use strict';

function apply(Dashboard) {
  const proto = Dashboard.prototype;

  /** Wrap content in a consciousness-row div, with optional inline style. */
  function _cRow(content, style) {
    return '<div class="dash-consciousness-row"' + (style ? ' style="' + style + '"' : '') + '>' + content + '</div>';
  }

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
    if (status.pendingApproval && typeof document !== 'undefined') {
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

  // ── v7.6.0: Awareness Panel (replaces Consciousness) ────

  proto._renderConsciousness = function(data, gateStats) {
    const el = this._el('dash-consciousness-body');
    if (!data && !gateStats) { el.innerHTML = '<span class="dash-muted">Keine Awareness-Daten</span>'; return; }

    const aw = data?.awareness;
    const vals = data?.values;

    let html = '';

    // Self-Modification Gate Stats
    if (gateStats && gateStats.totalAttempts > 0) {
      const blockColor = gateStats.blockRate > 20 ? 'dash-gauge-danger' : 'dash-gauge-awareness';
      html += _cRow(
        '<span class="dash-label" style="font-weight:500">Self-Mod Gates</span>' +
        '<span class="dash-value">' + gateStats.passed + '/' + gateStats.totalAttempts + ' passed</span>' +
        '<span class="dash-label" style="margin-left:8px">Block</span>' +
        '<span class="dash-value">' + gateStats.blockRate + '%</span>',
        'border-bottom:1px solid var(--dash-border);padding-bottom:4px;margin-bottom:4px');
      if (gateStats.consciousnessBlocked > 0) {
        html += _cRow(
          '<span class="dash-label">Awareness blocked</span><span class="dash-value">' + gateStats.consciousnessBlocked + '×</span>' +
          '<span class="dash-label" style="margin-left:8px">Rate</span><span class="dash-value">' + gateStats.consciousnessBlockRate + '%</span>');
      } else if (gateStats.awarenessActive === false) {
        // Gate is wired but NullAwareness is the implementation — counter is
        // always 0 by design, not because nothing was blocked.
        html += _cRow(
          '<span class="dash-label">Awareness gate</span>' +
          '<span class="dash-value dash-muted" style="font-style:italic">inactive (NullAwareness)</span>');
      }
      if (gateStats.energyBlocked > 0) {
        html += _cRow(
          '<span class="dash-label">Energy blocked</span><span class="dash-value">' + gateStats.energyBlocked + '×</span>');
      }
    }

    // Awareness status
    if (aw) {
      const coherence = Math.round((aw.coherence || 0) * 100);
      const mode = aw.mode || 'diffuse';
      html += _cRow(
        '<span class="dash-label">Coherence</span>' +
        '<div class="dash-gauge-track"><div class="dash-gauge-fill dash-gauge-awareness" style="width:' + coherence + '%"></div></div>' +
        '<span class="dash-value">' + coherence + '%</span>') +
        _cRow(
        '<span class="dash-label">Mode</span><span class="dash-value">' + this._esc(mode) + '</span>' +
        (aw.focus ? '<span class="dash-label" style="margin-left:12px">Focus</span><span class="dash-value">' + this._esc(String(aw.focus)) + '</span>' : ''));
    }

    // Values
    if (vals) {
      const alignment = vals.alignmentScore != null ? Math.round(vals.alignmentScore * 100) + '%' : '—';
      const conflicts = vals.conflicts || vals.conflictCount || 0;
      html += _cRow(
        '<span class="dash-label">Value Alignment</span><span class="dash-value">' + alignment + '</span>' +
        '<span class="dash-label" style="margin-left:12px">Conflicts</span><span class="dash-value">' + conflicts + '</span>');
    }

    el.innerHTML = html || '<span class="dash-muted">—</span>';
  };

  // ── v5.8.0: Energy Panel ────────────────────────────────
  // Metabolism energy gauge + cost/regen rates
}

// Browser: register as global so DashboardRenderers barrel can find it without require()
if (typeof window !== 'undefined') window._genesis_AgentRenderers = apply;
if (typeof module !== 'undefined' && module.exports) module.exports = apply;
