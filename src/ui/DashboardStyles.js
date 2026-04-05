// ============================================================
// GENESIS - DashboardStyles.js (v5.4.0 - God-Class Extraction)
//
// Extracted _buildCSS from Dashboard.js.
// ============================================================

'use strict';

/**
 * Apply style methods to Dashboard.prototype.
 * @param {Function} Dashboard - The Dashboard class
 */
function applyStyles(Dashboard) {
  Dashboard.prototype._buildCSS = function() {
    return '#dashboard-panel{width:280px;min-width:240px;max-width:340px;display:flex;flex-direction:column;border-right:1px solid rgba(255,255,255,0.06);overflow:hidden}' +
    '.dash-scroll{flex:1;overflow-y:auto;padding:8px;scrollbar-width:thin;scrollbar-color:rgba(255,255,255,0.1) transparent}' +
    '.dash-section{margin-bottom:12px}' +
    '.dash-section-head{font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:0.05em;color:rgba(255,255,255,0.4);padding:4px 0;border-bottom:1px solid rgba(255,255,255,0.06);margin-bottom:6px}' +
    '.dash-section-sub{font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:0.04em;color:rgba(255,255,255,0.3);margin:8px 0 4px}' +
    '.dash-section-body{font-size:12px}' +
    '.dash-muted{color:rgba(255,255,255,0.3);font-style:italic}' +
    '.dash-ok{color:#639922}.dash-err{color:#e24b4a}' +
    '.dash-mood{display:flex;align-items:center;gap:10px;margin-bottom:8px}' +
    '.dash-mood-ring{width:42px;height:42px;border-radius:50%;border:3px solid;display:flex;align-items:center;justify-content:center;font-size:20px;transition:border-color 0.5s,box-shadow 0.5s}' +
    '.dash-mood-text{display:flex;flex-direction:column;gap:1px}' +
    '.dash-mood-label{font-weight:600;font-size:13px;text-transform:capitalize}' +
    '.dash-sparkline-wrap{margin:4px 0 8px;display:flex;flex-direction:column;align-items:flex-start;gap:1px}' +
    '.dash-sparkline-wrap svg{display:block}' +
    '.dash-bar-row{display:flex;align-items:center;gap:4px;height:18px}' +
    '.dash-bar-label{width:28px;font-size:10px;text-transform:uppercase;color:rgba(255,255,255,0.5);text-align:right}' +
    '.dash-bar-track{flex:1;height:6px;background:rgba(255,255,255,0.06);border-radius:3px;overflow:hidden}' +
    '.dash-bar-fill{height:100%;border-radius:3px;transition:width 0.5s ease}' +
    '.dash-bar-val{width:22px;font-size:10px;text-align:right;color:rgba(255,255,255,0.4)}' +
    '.dash-radar-wrap{display:flex;justify-content:center;margin:4px 0}' +
    '.dash-recs{display:flex;flex-wrap:wrap;gap:3px;margin-top:2px}' +
    '.dash-rec-tag{font-size:9px;padding:2px 6px;border-radius:3px;background:rgba(29,158,117,0.15);color:rgba(29,158,117,0.85);text-transform:capitalize}' +
    '.dash-stats{display:flex;flex-direction:column;gap:2px}' +
    '.dash-stat{display:flex;justify-content:space-between;padding:2px 0;font-size:12px}' +
    '.dash-stat span:first-child{color:rgba(255,255,255,0.5)}' +
    '.dash-stat span:last-child{font-weight:500}' +
    '.dash-vital-row{display:flex;align-items:center;gap:6px;padding:2px 0;font-size:12px}' +
    '.dash-vital-name{flex:1;color:rgba(255,255,255,0.6)}' +
    '.dash-vital-val{font-family:monospace;font-size:11px}' +
    '.dash-state-badge{display:inline-block;padding:2px 8px;border-radius:4px;font-size:10px;font-weight:700;color:#fff;margin-bottom:6px}' +
    '.dash-warn{color:#ef9f27;font-size:11px;margin-top:4px}' +
    '.dash-loop-progress{margin-bottom:8px}' +
    '.dash-progress-track{height:6px;background:rgba(255,255,255,0.06);border-radius:3px;overflow:hidden}' +
    '.dash-progress-fill{height:100%;background:#6c8cff;border-radius:3px;transition:width 0.3s}' +
    '.dash-approval{background:rgba(239,159,39,0.12);border:1px solid rgba(239,159,39,0.3);border-radius:6px;padding:8px;margin:6px 0}' +
    '.dash-approval-text{font-size:12px;margin-bottom:6px}' +
    '.dash-approval-btns{display:flex;gap:6px}' +
    '.dash-btn{padding:4px 10px;border:none;border-radius:4px;font-size:11px;font-weight:600;cursor:pointer}' +
    '.dash-btn-approve{background:#1d9e75;color:#fff}' +
    '.dash-btn-reject{background:rgba(255,255,255,0.1);color:rgba(255,255,255,0.7)}' +
    '.dash-log{max-height:120px;overflow-y:auto}' +
    '.dash-log-entry{display:flex;gap:4px;font-size:11px;padding:2px 0;border-bottom:1px solid rgba(255,255,255,0.03)}' +
    '.dash-log-err{color:#e24b4a}' +
    '.dash-log-step{color:rgba(255,255,255,0.3);width:22px}' +
    '.dash-log-type{color:#6c8cff;width:50px;font-family:monospace;font-size:10px}' +
    '.dash-log-desc{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}' +
    '.dash-intervals{display:flex;flex-wrap:wrap;gap:3px}' +
    '.dash-interval{font-size:9px;padding:1px 5px;border-radius:3px;background:rgba(108,140,255,0.12);color:rgba(108,140,255,0.7)}' +
    '.dash-paused{background:rgba(239,159,39,0.12);color:rgba(239,159,39,0.7)}' +
    '.dash-evt-chain{display:flex;flex-wrap:wrap;align-items:center;gap:2px;padding:3px 0;border-bottom:1px solid rgba(255,255,255,0.03)}' +
    '.dash-evt-node{font-size:9px;padding:1px 4px;border-radius:3px;border:1px solid;background:rgba(0,0,0,0.3);font-family:monospace;white-space:nowrap;cursor:default;transition:background 0.2s}' +
    '.dash-evt-node:hover{background:rgba(255,255,255,0.08)}' +
    '.dash-evt-arrow{font-size:8px;color:rgba(255,255,255,0.15);margin:0 1px}' +
    '.dash-evt-elapsed{font-size:8px;color:rgba(255,255,255,0.2);margin-left:4px}' +
    '.dash-evt-hot{display:flex;justify-content:space-between;padding:2px 0;font-size:11px}' +
    '.dash-evt-hot-name{color:rgba(239,159,39,0.8);font-family:monospace;font-size:10px}' +
    '.dash-evt-hot-count{color:rgba(239,159,39,0.6);font-size:10px}' +
    '.dash-reasoning-stats{margin-bottom:4px}' +
    '.dash-trace-list{display:flex;flex-direction:column;gap:2px}' +
    '.dash-trace-row{display:flex;align-items:baseline;gap:6px;padding:3px 0;border-bottom:1px solid rgba(255,255,255,0.03);font-size:11px}' +
    '.dash-trace-label{min-width:62px;font-size:10px;font-weight:600;white-space:nowrap}' +
    '.dash-trace-summary{flex:1;color:rgba(255,255,255,0.75);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}' +
    '.dash-trace-age{color:rgba(255,255,255,0.3);font-size:9px;white-space:nowrap;min-width:40px;text-align:right}' +
    // v5.8.0: Consciousness panel
    '.dash-consciousness-row{display:flex;align-items:center;gap:6px;padding:2px 0;font-size:12px;flex-wrap:wrap}' +
    '.dash-gauge-track{flex:1;height:8px;background:rgba(255,255,255,0.06);border-radius:4px;overflow:hidden;min-width:60px}' +
    '.dash-gauge-fill{height:100%;border-radius:4px;transition:width 0.5s ease}' +
    '.dash-gauge-awareness{background:linear-gradient(90deg,#6c8cff,#a78bfa)}' +
    '.dash-label{font-size:11px;color:rgba(255,255,255,0.5);white-space:nowrap}' +
    '.dash-value{font-size:12px;font-weight:500;white-space:nowrap}' +
    // v5.8.0: Energy panel
    '.dash-energy-gauge{display:flex;align-items:center;gap:8px;padding:4px 0;flex-wrap:wrap}' +
    '.dash-energy-stats{display:flex;align-items:center;gap:6px;padding:2px 0;font-size:12px}' +
    '.dash-gauge-ok{background:linear-gradient(90deg,#1d9e75,#639922)}' +
    '.dash-gauge-warn{background:linear-gradient(90deg,#ef9f27,#e8c547)}' +
    '.dash-gauge-danger{background:linear-gradient(90deg,#e24b4a,#c0392b)}' +
    '.dash-badge{display:inline-block;padding:1px 6px;border-radius:3px;font-size:9px;font-weight:700;text-transform:uppercase}' +
    '.dash-badge-full,.dash-badge-normal{background:rgba(29,158,117,0.15);color:#1d9e75}' +
    '.dash-badge-low{background:rgba(239,159,39,0.15);color:#ef9f27}' +
    '.dash-badge-depleted{background:rgba(226,75,74,0.15);color:#e24b4a}' +
    '.dash-badge-unknown{background:rgba(255,255,255,0.08);color:rgba(255,255,255,0.4)}' +
    // v5.8.0: Architecture panel
    '.dash-arch-summary{display:flex;flex-wrap:wrap;gap:10px;padding:4px 0}' +
    '.dash-stat{display:flex;align-items:baseline;gap:4px;font-size:12px}' +
    '.dash-stat-num{font-size:16px;font-weight:700;color:#6c8cff}' +
    '.dash-arch-phases{display:flex;flex-wrap:wrap;gap:3px;margin-top:4px}' +
    '.dash-phase-pill{font-size:9px;padding:2px 6px;border-radius:3px;background:rgba(108,140,255,0.1);color:rgba(108,140,255,0.7);display:flex;align-items:baseline;gap:3px}' +
    '.dash-phase-pill small{font-size:8px;opacity:0.6}' +
    // v5.8.0: Project Intelligence panel
    '.dash-project-grid{display:grid;grid-template-columns:auto 1fr;gap:2px 8px;font-size:12px;padding:2px 0}' +
    '.dash-project-conv{margin-top:4px;font-size:11px}' +
    // v5.8.0: Tool Synthesis panel
    '.dash-toolsynth-stats{display:flex;flex-wrap:wrap;gap:10px;padding:4px 0}' +
    '.dash-toolsynth-list{display:flex;flex-wrap:wrap;gap:3px;margin-top:4px}' +
    '.dash-tool-pill{font-size:9px;padding:2px 6px;border-radius:3px;background:rgba(29,158,117,0.12);color:rgba(29,158,117,0.8);font-family:monospace}' +
    // v5.9.0: MCP server toggle
    '.dash-mcp-toggle{margin:6px 0 2px;display:flex;gap:6px}' +
    // v5.9.2: Decision tree traces
    '.dash-trace-groups{display:flex;flex-direction:column;gap:2px}' +
    '.dash-trace-chain{border:1px solid rgba(255,255,255,0.06);border-radius:4px;padding:0}' +
    '.dash-trace-chain-head{cursor:pointer;padding:4px 8px;font-size:11px;display:flex;gap:8px;align-items:center}' +
    '.dash-trace-chain-count{font-size:9px;color:rgba(108,140,255,0.6);background:rgba(108,140,255,0.1);padding:1px 5px;border-radius:3px}' +
    '.dash-trace-child{padding-left:16px}' +
    '.dash-trace-connector{color:rgba(255,255,255,0.2);font-family:monospace;font-size:10px;min-width:18px}' +
    // v5.9.2: Insights Timeline
    '.dash-insights-header{display:flex;flex-wrap:wrap;gap:12px;padding:4px 0;margin-bottom:4px}' +
    '.dash-insights-timeline{display:flex;flex-direction:column;gap:3px}' +
    '.dash-insight-entry{display:flex;gap:6px;align-items:flex-start;font-size:11px;padding:3px 0;border-left:2px solid rgba(108,140,255,0.15);padding-left:8px}' +
    '.dash-insight-icon{font-size:12px;min-width:16px}' +
    '.dash-insight-content{display:flex;flex-direction:column;flex:1;min-width:0}' +
    '.dash-insight-activity{font-weight:600;color:rgba(255,255,255,0.8);font-size:11px}' +
    '.dash-insight-result{color:rgba(255,255,255,0.45);font-size:10px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}' +
    '.dash-insight-time{font-size:9px;color:rgba(255,255,255,0.3);min-width:36px;text-align:right}' +
    // v5.9.2: Hotspot Heatmap
    '.dash-hotspot-list{display:flex;flex-direction:column;gap:3px}' +
    '.dash-hotspot-row{display:flex;align-items:center;gap:6px;font-size:11px}' +
    '.dash-hotspot-name{min-width:120px;max-width:160px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-family:monospace;font-size:10px}' +
    '.dash-hotspot-bar-track{flex:1;height:8px;background:rgba(255,255,255,0.05);border-radius:4px;overflow:hidden}' +
    '.dash-hotspot-bar{height:100%;border-radius:4px;transition:width 0.3s}' +
    '.dash-hotspot-hot{background:linear-gradient(90deg,#e24b4a,#ef9f27)}' +
    '.dash-hotspot-warm{background:linear-gradient(90deg,#ef9f27,#e8c547)}' +
    '.dash-hotspot-cool{background:linear-gradient(90deg,#1d9e75,#639922)}' +
    '.dash-hotspot-count{min-width:50px;font-size:9px;color:rgba(255,255,255,0.4);text-align:right}' +
    // v5.9.7: Task Performance panel
    '.dash-taskperf-total{font-size:11px;color:rgba(255,255,255,0.5);margin-bottom:6px}' +
    '.dash-taskperf-total strong{color:rgba(255,255,255,0.8)}' +
    '.dash-taskperf-list{display:flex;flex-direction:column;gap:3px}' +
    '.dash-taskperf-row{display:flex;align-items:center;gap:6px;font-size:11px}' +
    '.dash-taskperf-name{min-width:90px;max-width:110px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-family:monospace;font-size:10px;color:rgba(255,255,255,0.7)}' +
    '.dash-taskperf-bar-track{flex:1;height:8px;background:rgba(255,255,255,0.05);border-radius:4px;overflow:hidden}' +
    '.dash-taskperf-bar{height:100%;border-radius:4px;transition:width 0.3s}' +
    '.dash-taskperf-good{background:linear-gradient(90deg,#1d9e75,#5dca80)}' +
    '.dash-taskperf-warn{background:linear-gradient(90deg,#ef9f27,#e8c547)}' +
    '.dash-taskperf-bad{background:linear-gradient(90deg,#e24b4a,#d85a30)}' +
    '.dash-taskperf-pct{min-width:28px;font-size:10px;font-weight:600;text-align:right}' +
    '.dash-taskperf-meta{font-size:9px;color:rgba(255,255,255,0.3);min-width:70px;text-align:right}' +
    '.dash-taskperf-backends{display:flex;flex-wrap:wrap;gap:6px;margin-top:4px}' +
    '.dash-taskperf-backend{font-size:10px;padding:2px 6px;border-radius:3px;background:rgba(255,255,255,0.05)}' +

    // v5.9.8: Cognitive Self-Model panel
    '.dash-sm-radar{display:flex;flex-direction:column;gap:3px}' +
    '.dash-sm-row{display:flex;align-items:center;gap:6px;font-size:11px}' +
    '.dash-sm-label{min-width:100px;max-width:120px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-family:monospace;font-size:10px;color:rgba(255,255,255,0.7)}' +
    '.dash-sm-track{flex:1;height:10px;background:rgba(255,255,255,0.05);border-radius:5px;overflow:hidden;position:relative}' +
    '.dash-sm-bar-raw{position:absolute;height:100%;border-radius:5px;background:rgba(255,255,255,0.08)}' +
    '.dash-sm-bar{position:absolute;height:100%;border-radius:5px;transition:width 0.3s}' +
    '.dash-sm-strong{background:linear-gradient(90deg,#1d9e75,#5dca80)}' +
    '.dash-sm-mid{background:linear-gradient(90deg,#3b82f6,#60a5fa)}' +
    '.dash-sm-weak{background:linear-gradient(90deg,#e24b4a,#d85a30)}' +
    '.dash-sm-val{min-width:28px;font-size:10px;font-weight:600;text-align:right}' +
    '.dash-sm-n{font-size:9px;color:rgba(255,255,255,0.3);min-width:35px;text-align:right}' +
    '.dash-sm-backends{display:flex;flex-wrap:wrap;gap:6px;margin-top:4px}' +
    '.dash-sm-rec{font-size:10px;padding:2px 8px;border-radius:3px;background:rgba(59,130,246,0.12);color:rgba(255,255,255,0.8)}' +
    '.dash-sm-rec strong{color:#60a5fa;margin-right:2px}' +
    '.dash-sm-biases{display:flex;flex-direction:column;gap:4px;margin-top:4px}' +
    '.dash-sm-bias{font-size:10px;padding:4px 8px;border-radius:4px;border-left:3px solid}' +
    '.dash-sm-bias strong{margin-right:4px}' +
    '.dash-sm-bias-ev{color:rgba(255,255,255,0.5)}' +
    '.dash-sm-bias-bad{background:rgba(226,75,74,0.1);border-color:#e24b4a}' +
    '.dash-sm-bias-warn{background:rgba(239,159,39,0.1);border-color:#ef9f27}' +
    '.dash-sm-bias-info{background:rgba(59,130,246,0.1);border-color:#3b82f6}';
  };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { applyStyles };
}
