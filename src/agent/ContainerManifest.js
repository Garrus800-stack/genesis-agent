// ============================================================
// GENESIS — ContainerManifest.js (v3.8.0 — Auto-Discovery)
//
// v3.8.0 UPGRADE: Eliminates the 120-line _dirMap.
// Module resolution now works by scanning the src/agent/
// directory tree at boot time and building the map automatically.
// New modules only need to exist in the right directory — no
// manual registration in _dirMap required.
//
// The phase files remain the source of truth for WHAT gets
// registered and HOW (factory, deps, lateBindings). The dirMap
// only controlled WHERE to find the file, which is now automatic.
//
// Fallback: If a module isn't found by scan, the phase file's
// R() call throws a clear error with the scanned directories.
//
// Phase files:
//   manifest/phase1-foundation.js    — 17 services
//   manifest/phase2-intelligence.js  — 10 services
//   manifest/phase3-capabilities.js  — 8 services
//   manifest/phase4-planning.js      — 5 services
//   manifest/phase5-hexagonal.js     — 7 services
//   manifest/phase6-autonomy.js      — 4 services
//   manifest/phase7-organism.js      — 3 services
//   manifest/phase8-revolution.js    — 9 services
//
// Each phase file exports a function(ctx, R) → Array<[name, config]>
// This file composes them into the final Map for Container.
// ============================================================

const path = require('path');
const fs = require('fs');
const { createLogger } = require('./core/Logger');
const _log = createLogger('ContainerManifest');

const { phase1 } = require('./manifest/phase1-foundation');
const { phase2 } = require('./manifest/phase2-intelligence');
const { phase3 } = require('./manifest/phase3-capabilities');
const { phase4 } = require('./manifest/phase4-planning');
const { phase5 } = require('./manifest/phase5-hexagonal');
const { phase6 } = require('./manifest/phase6-autonomy');
const { phase7 } = require('./manifest/phase7-organism');
const { phase8 } = require('./manifest/phase8-revolution');
const { phase9 } = require('./manifest/phase9-cognitive');
const { phase10 } = require('./manifest/phase10-agency');
const { phase11 } = require('./manifest/phase11-extended');
const { phase12 } = require('./manifest/phase12-hybrid');
const { phase13 } = require('./manifest/phase13-consciousness');

// ── Auto-Discovery Module Resolver ──────────────────────
// Scans src/agent/ subdirectories once at boot and builds
// a filename → directory map. Replaces the manual _dirMap.

const SCAN_DIRS = [
  'core', 'foundation', 'intelligence', 'capabilities',
  'planning', 'hexagonal', 'autonomy', 'organism',
  'revolution', 'ports',
  'cognitive',  // Phase 9: Cognitive Architecture
  'consciousness',  // Phase 13: Bewusstseinssubstrat
  // Phase 10-12: Extended Agency
];

let _autoMap = null;

function _buildAutoMap() {
  if (_autoMap) return _autoMap;
  _autoMap = new Map();
  const agentDir = __dirname; // src/agent/

  for (const dir of SCAN_DIRS) {
    const fullDir = path.join(agentDir, dir);
    if (!fs.existsSync(fullDir)) continue;

    const files = fs.readdirSync(fullDir).filter(f => f.endsWith('.js'));
    for (const file of files) {
      const moduleName = file.replace('.js', '');
      // First-found wins (prevents ambiguity)
      if (!_autoMap.has(moduleName)) {
        _autoMap.set(moduleName, dir);
      }
    }
  }

  return _autoMap;
}

/**
 * Build the full container manifest.
 * @param {object} ctx - Boot context
 * @returns {Map<string, object>}
 */
function buildManifest(ctx) {
  const autoMap = _buildAutoMap();

  const R = (mod) => {
    const dir = autoMap.get(mod);
    if (dir) return require(`./${dir}/${mod}`);

    // Fallback: try direct require (for modules in agent/ root)
    try { return require(`./${mod}`); }
    catch (err) {
      const scanned = SCAN_DIRS.join(', ');
      throw new Error(
        `[MANIFEST] Module "${mod}" not found. Scanned: [${scanned}]. ` +
        `Ensure the file exists as src/agent/<dir>/${mod}.js`
      );
    }
  };

  // ── Boot profiles ──────────────────────────────────────
  // v5.2.0: Skip higher phases based on profile.
  //   full      → all 13 phases (default)
  //   cognitive → phases 1-12 (skip consciousness)
  //   minimal   → phases 1-8 (core agent loop only)
  const profile = ctx.bootProfile || 'full';

  const PHASE_MAP = {
    full:      [phase1, phase2, phase3, phase4, phase5, phase6, phase7, phase8, phase9, phase10, phase11, phase12, phase13],
    cognitive: [phase1, phase2, phase3, phase4, phase5, phase6, phase7, phase8, phase9, phase10, phase11, phase12],
    minimal:   [phase1, phase2, phase3, phase4, phase5, phase6, phase7, phase8],
  };

  let phases = PHASE_MAP[profile] || PHASE_MAP.full;

  // v6.0.4: --skip-phase N[,N] — skip specific phases for A/B benchmarking.
  // Usage: node cli.js --skip-phase 13        (skip consciousness)
  //        node cli.js --skip-phase 7,13      (skip organism + consciousness)
  // Phases 1-5 cannot be skipped (core infrastructure).
  if (ctx.skipPhases && Array.isArray(ctx.skipPhases)) {
    const PHASE_FN_MAP = { 1: phase1, 2: phase2, 3: phase3, 4: phase4, 5: phase5, 6: phase6, 7: phase7, 8: phase8, 9: phase9, 10: phase10, 11: phase11, 12: phase12, 13: phase13 };
    const skippable = ctx.skipPhases.filter(p => p >= 6); // Phases 1-5 are required
    if (skippable.length > 0) {
      phases = phases.filter(fn => {
        for (const p of skippable) {
          if (PHASE_FN_MAP[p] === fn) return false;
        }
        return true;
      });
      _log.info(`[MANIFEST] Skipping phases: ${skippable.join(', ')}`);
    }
  }

  // Compose selected phases
  const entries = [];
  for (const phaseFn of phases) {
    entries.push(...phaseFn(ctx, R));
  }

  return new Map(entries);
}

/** Exposed for diagnostics / ModuleRegistry */
function getAutoMap() {
  return Object.fromEntries(_buildAutoMap());
}

module.exports = { buildManifest, getAutoMap };
