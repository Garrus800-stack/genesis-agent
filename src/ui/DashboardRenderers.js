// ============================================================
// GENESIS — DashboardRenderers.js (v7.0.1 — Barrel)
//
// v5.4.0: Extracted from Dashboard.js (God-Class fix).
// v7.0.1: Split into 4 themed renderer modules to reduce
//   per-file complexity and merge-conflict surface.
//
//   OrganismRenderers — mood, sparkline, radar, energy
//   AgentRenderers    — loop, cognitive, reasoning, consciousness
//   SystemRenderers   — vitals, memory, event flow, system info
//   IntelRenderers    — architecture, project intel, tools, insights,
//                       heatmap, task outcomes, self-model
// ============================================================

'use strict';

/**
 * Apply all rendering methods to Dashboard.prototype.
 * @param {Function} Dashboard - The Dashboard class
 *
 * Browser: sub-modules are loaded via <script> tags and register themselves
 *          as globals (window._genesis_*).  No require() needed.
 * Node/test: falls back to require() so tests still work.
 */
function applyRenderers(Dashboard) {
  const modules = [
    { global: '_genesis_OrganismRenderers', path: './renderers/OrganismRenderers' },
    { global: '_genesis_AgentRenderers',    path: './renderers/AgentRenderers' },
    { global: '_genesis_SystemRenderers',   path: './renderers/SystemRenderers' },
    { global: '_genesis_IntelRenderers',    path: './renderers/IntelRenderers' },
  ];

  for (const m of modules) {
    const fn = (typeof window !== 'undefined' && window[m.global])
      ? window[m.global]
      : require(m.path);
    fn(Dashboard);
  }
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { applyRenderers };
}
