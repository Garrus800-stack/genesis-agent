// @ts-checked-v5.7
// ============================================================
// GENESIS AGENT — PickContext.js (v7.3.1)
// ------------------------------------------------------------
// Central context object passed to each Activity's shouldTrigger(ctx).
// Computed ONCE per pick cycle in IdleMind, read by all 15 activities.
//
// PROBLEM BEFORE: IdleMind._pickActivity() was a 200-line scoring
// pipeline with 10 scorers referencing activities by name
// (scores.explore *= curMul, scores.improve *= (0.5 + sa)). Adding
// a new activity meant threading hardcoded references through
// multiple scorers. Splitting activities into separate files would
// scatter this logic.
//
// SOLUTION: Invert control flow. Each activity knows its own
// boost conditions via shouldTrigger(ctx). PickContext provides
// everything it could possibly need — emotional state, needs,
// genome traits, frontiers, recent history — pre-computed once.
//
// SCOPE: PickContext holds only data, never activity-specific
// logic. All "is activity X good right now?" decisions live in
// the activity file itself (src/agent/autonomy/activities/*.js).
//
// Services are kept as refs (not just snapshots) for activities
// that need deeper queries (e.g. research gate checks rate limit
// from activityLog, not from snap).
// ============================================================

'use strict';

const { createLogger } = require('../../core/Logger');
const _log = createLogger('PickContext');

/**
 * Build PickContext from IdleMind instance. Called once per pick cycle.
 *
 * @param {object} idleMind - The IdleMind instance (passed as `this`)
 * @returns {PickContext} Fully populated context for shouldTrigger()
 */
function buildPickContext(idleMind) {
  const now = Date.now();
  const activityLog = idleMind.activityLog || [];
  const recent = activityLog.slice(-5).map(a => a.activity);

  // Service refs — activities may need deeper queries than snap provides
  const services = {
    needsSystem:              idleMind.needsSystem,
    emotionalState:           idleMind.emotionalState,
    emotionalFrontier:        idleMind._emotionalFrontier,
    unfinishedWorkFrontier:   idleMind._unfinishedWorkFrontier,
    suspicionFrontier:        idleMind._suspicionFrontier,
    lessonFrontier:           idleMind._lessonFrontier,
    genome:                   idleMind._genome,
    cognitiveSelfModel:       idleMind._cognitiveSelfModel,
    homeostasis:              idleMind._homeostasis,
    trustLevelSystem:         idleMind._trustLevelSystem,
    dreamCycle:               idleMind.dreamCycle,
    mcpClient:                idleMind.mcpClient,
    webFetcher:               idleMind._webFetcher,
    model:                    idleMind.model,
    kg:                       idleMind.kg,
    storage:                  idleMind.storage,
    selfModel:                idleMind.selfModel,
    bus:                      idleMind.bus,
  };

  // Pre-computed snapshots — cheap reads all gathered once
  const snap = {
    emotional: _safeSnap(() => services.emotionalState?.getState?.() || null),
    idlePriorities: _safeSnap(() => services.emotionalState?.getIdlePriorities?.() || {}),
    needs: _safeSnap(() => services.needsSystem?.getActivityRecommendations?.() || []),
    needsRaw: _safeSnap(() => services.needsSystem?.getNeeds?.() || {}),
    genomeTraits: _safeSnap(() => {
      if (!services.genome) return {};
      return {
        curiosity:     services.genome.trait('curiosity'),
        consolidation: services.genome.trait('consolidation'),
        selfAwareness: services.genome.trait('selfAwareness'),
        exploration:   services.genome.trait('exploration'),
      };
    }),
    weakAreas: _safeSnap(() => {
      const profile = services.cognitiveSelfModel?.getCapabilityProfile?.();
      if (!profile) return [];
      return Object.entries(profile)
        .filter(([, p]) => p.isWeak)
        .sort((a, b) => (a[1].successRate || 0) - (b[1].successRate || 0));
    }),
    imprints: _safeSnap(() => services.emotionalFrontier?.getRecentImprints?.(3) || []),
    unfinishedWork: _safeSnap(() => services.unfinishedWorkFrontier?.getRecent?.(2) || []),
    suspicions: _safeSnap(() => services.suspicionFrontier?.getRecent?.(2) || []),
    lessons: _safeSnap(() => services.lessonFrontier?.getRecent?.(1) || []),
    memoryPressure: _safeSnap(() => {
      const vitals = services.homeostasis?.vitals || {};
      return vitals.memoryPressure?.value ?? 50;
    }),
    trustLevel: _safeSnap(() => services.trustLevelSystem?.getLevel?.() ?? 1),
    networkOk: _safeSnap(() => {
      if (!services.webFetcher) return false;
      return typeof idleMind._isNetworkAvailable === 'function'
        ? idleMind._isNetworkAvailable()
        : true;
    }),
    // v7.3.1: Dream-specific queries (needed for candidate check)
    dreamAge: _safeSnap(() => services.dreamCycle?.getTimeSinceLastDream?.() ?? 0),
    dreamUnprocessed: _safeSnap(() => services.dreamCycle?.getUnprocessedCount?.() ?? 0),
    mcpConnected: _safeSnap(() => services.mcpClient?.getStatus?.().connectedCount ?? 0),
  };

  // Carry across cycles: imprint cooldown tracker, currentWeakness
  const cycleState = {
    recentImprintIds: idleMind._recentImprintIds || new Set(),
    currentWeakness: idleMind._currentWeakness || null,
  };

  return {
    now,
    activityLog,
    recent,
    services,
    snap,
    cycleState,
    // Helpers for common checks
    hasContainerService: (name) => {
      try { return !!services.bus?._container?.resolve?.(name); }
      catch (_e) { return false; }
    },
    // Cooldown-aware idle duration — ms since last user interaction.
    // Uses IdleMind's real field name lastUserActivity.
    idleMsSince: _safeSnap(() => {
      const last = idleMind.lastUserActivity || idleMind.lastUserInteractionAt || idleMind._bootTime || now;
      return now - last;
    }),
  };
}

function _safeSnap(fn) {
  try { return fn(); }
  catch (err) {
    _log.debug('[snap] error:', err.message);
    return null;
  }
}

module.exports = { buildPickContext };

/**
 * @typedef {object} PickContext
 * @property {number} now - Current timestamp
 * @property {object[]} activityLog - Full activity history
 * @property {string[]} recent - Last 5 activity names
 * @property {object} services - Direct service refs (for deep queries)
 * @property {object} snap - Pre-computed snapshots (cheap reads)
 * @property {object} cycleState - Cross-cycle state (imprint cooldowns etc.)
 * @property {function} hasContainerService - Test if a service is registered
 * @property {number} idleMsSince - Ms since last user interaction
 */
