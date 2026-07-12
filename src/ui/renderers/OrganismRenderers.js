// ============================================================
// GENESIS — OrganismRenderers.js (v7.0.1 — DashboardRenderers split)
// ============================================================
'use strict';

function apply(Dashboard) {
  const proto = Dashboard.prototype;

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
      frustrated: '#e35b5b', exhausted: '#8a8578', lonely: '#8f7fd4',
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
          '<span class="dash-muted">' + (organism.emotionalFrontier?.dashboardLine ? '\u2764 ' + this._esc(organism.emotionalFrontier.dashboardLine) : '') + '</span>' +
          '<span class="dash-muted">' + (organism.unfinishedWorkFrontier?.dashboardLine ? '\u23f3 ' + this._esc(organism.unfinishedWorkFrontier.dashboardLine) : '') + '</span>' +
          '<span class="dash-muted">' + (organism.suspicionFrontier?.dashboardLine ? '\u26a0 ' + this._esc(organism.suspicionFrontier.dashboardLine) : '') + '</span>' +
          '<span class="dash-muted">' + (organism.lessonFrontier?.dashboardLine ? '\u2713 ' + this._esc(organism.lessonFrontier.dashboardLine) : '') + '</span>' +
          '<span class="dash-muted">' + (organism.causalSuspicion?.dashboardLine ? '\uD83C\uDFAF Causal: ' + this._esc(organism.causalSuspicion.dashboardLine) : '') + '</span>' +
          '<span class="dash-muted">' + driveInfo + '</span>' +
        '</div>' +
      '</div>' +
      sparklineHTML +
      '<div class="dash-section-sub">Emotions</div>' +
      bars +
      (needsRadar ? '<div class="dash-section-sub">Needs</div>' + needsRadar : '') +
      (recsHTML ? '<div class="dash-section-sub">Recommended</div>' + recsHTML : '');
  };


  // v7.9.37: Genesis' own state marks, chosen by Genesis itself — "nicht ganz
  // Organismus, nicht ganz Maschine": a translucent boundary layer whose contour
  // stretches, tightens or shrinks with the state, and one eye that stays awake.
  // Inline SVG at 1em scales cleanly on every machine and resolution.
  proto._moodEmoji = function(mood) {
    var O = '<svg width="1em" height="1em" viewBox="-16 -16 32 32" style="display:block" aria-hidden="true">';
    var B = ' fill="#6c8cff" fill-opacity="0.3" stroke="#6c8cff" stroke-width="2.2"';
    var map = {
      curious: O + '<path d="M0 -12c12 0 15 6 15 9 4 0 9-3 12-7 0 7-5 11-10 12-2 8-9 12-17 12-10 0-15-7-15-13s5-13 15-13z"' + B + '/><circle cx="5" cy="-1" r="6.3" fill="#fff"/><circle cx="7" cy="-1" r="3.1" fill="#26314f"/><circle cx="8" cy="-2.2" r="1.1" fill="#fff"/></svg>',
      content: O + '<circle cy="1" r="12.5"' + B + '/><circle cy="0" r="5.8" fill="#fff"/><circle cy="-1" r="2.7" fill="#26314f"/><circle cx="1" cy="-2" r="0.9" fill="#fff"/><path d="M-5.8 0a5.8 5.8 0 0 0 11.6 0l0 3.1l-11.6 0z" fill="#6c8cff"/></svg>',
      calm: O + '<circle cy="1" r="12"' + B + '/><circle cy="1" r="16" fill="none" stroke="#6c8cff" stroke-width="1" opacity="0.35"/><circle cy="0.5" r="5.8" fill="#fff"/><path d="M-5.8 0.5a5.8 5.8 0 0 1 11.6 0z" fill="#6c8cff"/><circle cy="2.2" r="2.3" fill="#26314f"/></svg>',
      focused: O + '<circle cy="1" r="10.5" fill="#6c8cff" fill-opacity="0.32" stroke="#6c8cff" stroke-width="2.4"/><circle cy="1" r="13.8" fill="none" stroke="#6c8cff" stroke-width="1.4"/><circle cy="0.5" r="5.4" fill="#fff"/><circle cy="0.5" r="3.2" fill="#26314f"/><circle cy="0.5" r="4.5" fill="none" stroke="#ffb638" stroke-width="1.1"/></svg>',
      tense: O + '<circle cy="1" r="11.5" fill="#6c8cff" fill-opacity="0.3" stroke="#6c8cff" stroke-width="2" stroke-dasharray="2.6 2"/><circle cy="0.8" r="6" fill="#fff"/><circle cy="1.1" r="1.8" fill="#26314f"/><path d="M11.5 -6q2 3 0 5.5q-2-2.7 0-5.5" fill="#ffb638"/></svg>',
      tired: O + '<ellipse cy="4" rx="14.5" ry="9"' + B + '/><circle cy="3" r="5.3" fill="#fff"/><path d="M-5.3 3a5.3 5.3 0 0 1 10.6 0l0 1.4l-10.6 0z" fill="#6c8cff"/><circle cy="5.1" r="1.7" fill="#26314f"/><path d="M12 -7l4 0l-4 4l4 0" stroke="#ffb638" stroke-width="2.1" fill="none"/></svg>',
      exhausted: O + '<g opacity="0.92"><ellipse cy="5" rx="15" ry="7.8" fill="#6c8cff" fill-opacity="0.26" stroke="#6c8cff" stroke-width="2"/><circle cy="4" r="4.8" fill="#fff"/><path d="M-4.8 4a4.8 4.8 0 0 1 9.6 0l0 1.9l-9.6 0z" fill="#6c8cff"/><line x1="-2.1" y1="5.2" x2="2.1" y2="5.2" stroke="#26314f" stroke-width="1.5"/><path d="M12 -5l4 0l-4 4l4 0" stroke="#ffb638" stroke-width="2" fill="none"/><path d="M17 -11l3 0l-3 3l3 0" stroke="#ffb638" stroke-width="1.6" fill="none"/></g></svg>',
      frustrated: O + '<path d="M0 -13l3.5 5 6.5-2-2 6.5 5.5 3.5-5.5 3.5 2 6.5-6.5-2-3.5 5-3.5-5-6.5 2 2-6.5-5.5-3.5 5.5-3.5-2-6.5 6.5 2z" fill="#6c8cff" fill-opacity="0.3" stroke="#6c8cff" stroke-width="2" stroke-linejoin="round"/><circle cy="1" r="5.3" fill="#fff"/><path d="M-5.3 1a5.3 5.3 0 0 1 10.6 0z" fill="#6c8cff" transform="rotate(-16)"/><circle cx="0.5" cy="2.3" r="1.9" fill="#26314f"/></svg>',
      lonely: O + '<circle cy="1" r="17" fill="none" stroke="#6c8cff" stroke-width="1" stroke-dasharray="2.5 4" opacity="0.5"/><g opacity="0.85"><circle cy="1.5" r="7.5" fill="#6c8cff" fill-opacity="0.3" stroke="#6c8cff" stroke-width="1.9"/><circle cy="1" r="3.4" fill="#fff"/><circle cy="2.1" r="1.3" fill="#26314f"/></g></svg>',
    };
    return map[mood] || map.calm;
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


  proto._renderEnergy = function(metabolism) {
    const el = this._el('dash-energy-body');
    if (!metabolism) { el.innerHTML = '<span class="dash-muted">Keine Metabolism-Daten</span>'; return; }

    const energy = metabolism.energy || {};
    const percent = energy.percent != null ? energy.percent : 0;
    const state = energy.state || 'unknown';
    const current = energy.current != null ? Math.round(energy.current) : '—';
    const max = energy.max != null ? energy.max : '—';
    const totalCost = metabolism.totalEnergySpent != null ? metabolism.totalEnergySpent.toFixed(1) : '—';
    const calls = metabolism.callCount || 0;

    const gaugeClass = state === 'depleted' ? 'dash-gauge-danger' :
                       state === 'low' ? 'dash-gauge-warn' : 'dash-gauge-ok';

    let html = '<div class="dash-energy-gauge">' +
      '<div class="dash-gauge-track"><div class="dash-gauge-fill ' + gaugeClass + '" style="width:' + percent + '%"></div></div>' +
      '<span class="dash-value">' + current + ' / ' + max + ' (' + percent + '%)</span>' +
      '<span class="dash-badge dash-badge-' + state + '">' + this._esc(state) + '</span>' +
      '</div>' +
      '<div class="dash-energy-stats">' +
      '<span class="dash-label">LLM Calls</span><span class="dash-value">' + calls + '</span>' +
      '<span class="dash-label" style="margin-left:12px">Energy Spent</span><span class="dash-value">' + totalCost + '</span>' +
      '</div>';

    el.innerHTML = html;
  };

  // ── v5.8.0: Architecture Panel ──────────────────────────
  // Service count, events, layers, couplings from ArchitectureReflection
}

// Browser: register as global so DashboardRenderers barrel can find it without require()
if (typeof window !== 'undefined') window._genesis_OrganismRenderers = apply;
if (typeof module !== 'undefined' && module.exports) module.exports = apply;
