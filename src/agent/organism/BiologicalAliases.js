// ============================================================
// GENESIS — BiologicalAliases.js (v5.0.0)
//
// v5.0.0: Lazy re-export aliases only. Biological names were
//         available for static require() but not in the DI container.
//
// v5.0.0: SERVICE_ALIAS_MAP added.
//         AgentCoreBoot calls container.alias() for each entry,
//         making biological names first-class DI service names.
//
//         container.resolve('morphogenesis')  === container.resolve('selfModPipeline')
//         container.resolve('connectome')     === container.resolve('knowledgeGraph')
//         container.resolve('colony')         === container.resolve('network')
//         container.resolve('hippocampalBuffer') === container.resolve('memory')
//         ...etc.
//
// Phase migration plan (unchanged from v5.0.0):
//   Phase 1 (v5.0.0-alpha): Aliases only. Zero breaking changes. ← current
//   Phase 2 (v5.0.0-beta):  New code uses biological names. Old emit warnings.
//   Phase 3 (v5.0.0):       Old names removed. Manifest updated.
//
// SERVICE_ALIAS_MAP format:
//   key   = camelCase biological alias (DI service name)
//   value = camelCase canonical service name as registered in ContainerManifest
//
// Note: SkillManager is registered as 'skills' (not 'skillManager'),
//       ConversationMemory as 'memory', PeerNetwork as 'network',
//       SelfModificationPipeline as 'selfModPipeline',
//       AutonomousDaemon as 'daemon'.
//       These are the actual strings used in manifest phase files.
// ============================================================

'use strict';

// ── Lazy re-exports (Phase 1: static require() aliases) ──────
// Each is a lazy getter to avoid circular dependency issues.

const _cache = {};

function _lazy(name, requirePath, exportName) {
  Object.defineProperty(module.exports, name, {
    get() {
      if (!_cache[name]) {
        const mod = require(requirePath);
        _cache[name] = mod[exportName || name];
      }
      return _cache[name];
    },
    enumerable:   true,
    configurable: true,
  });
}

// ── Organism Layer ────────────────────────────────────────────
_lazy('CellularActivity',    '../autonomy/AutonomousDaemon',             'AutonomousDaemon');
_lazy('ConsolidationPhase',  '../autonomy/IdleMind',                     'IdleMind');
_lazy('VitalSigns',          '../autonomy/HealthMonitor',                'HealthMonitor');

// ── Capabilities ──────────────────────────────────────────────
_lazy('Organogenesis',       '../capabilities/SkillManager',             'SkillManager');
_lazy('Reproduction',        '../capabilities/CloneFactory',             'CloneFactory');

// ── Foundation ────────────────────────────────────────────────
_lazy('Connectome',          '../foundation/KnowledgeGraph',             'KnowledgeGraph');
_lazy('HippocampalBuffer',   '../foundation/ConversationMemory',         'ConversationMemory');

// ── Hexagonal ─────────────────────────────────────────────────
_lazy('Morphogenesis',       '../hexagonal/SelfModificationPipeline',    'SelfModificationPipeline');
_lazy('Colony',              '../hexagonal/PeerNetwork',                 'PeerNetwork');

// ── Planning ──────────────────────────────────────────────────
_lazy('DriveSystem',         '../planning/GoalStack',                    'GoalStack');

// ── Revolution ────────────────────────────────────────────────
_lazy('CognitiveLoop',       '../revolution/AgentLoop',                  'AgentLoop');


// ── Mapping table (for programmatic access by DI system) ──────

/**
 * Maps PascalCase biological class alias → PascalCase canonical class name.
 * Used to describe the conceptual rename in documentation and migration tooling.
 */
module.exports.ALIAS_MAP = Object.freeze({
  CellularActivity:   'AutonomousDaemon',
  ConsolidationPhase: 'IdleMind',
  VitalSigns:         'HealthMonitor',
  Organogenesis:      'SkillManager',
  Reproduction:       'CloneFactory',
  Connectome:         'KnowledgeGraph',
  HippocampalBuffer:  'ConversationMemory',
  Morphogenesis:      'SelfModificationPipeline',
  Colony:             'PeerNetwork',
  DriveSystem:        'GoalStack',
  CognitiveLoop:      'AgentLoop',
});

/**
 * v5.0.0 — Maps camelCase biological DI alias → camelCase canonical DI service name.
 *
 * These are the ACTUAL strings used in Container.register() / Container.resolve().
 * AgentCoreBoot._registerBiologicalAliases() iterates this map and calls
 * container.alias(alias, primary) for each entry where the primary exists.
 *
 * @type {Record<string, string>}
 */
module.exports.SERVICE_ALIAS_MAP = Object.freeze({
  cellularActivity:   'daemon',           // AutonomousDaemon
  consolidationPhase: 'idleMind',         // IdleMind
  vitalSigns:         'healthMonitor',    // HealthMonitor
  organogenesis:      'skills',           // SkillManager (registered as 'skills')
  connectome:         'knowledgeGraph',   // KnowledgeGraph
  hippocampalBuffer:  'memory',           // ConversationMemory (registered as 'memory')
  morphogenesis:      'selfModPipeline',  // SelfModificationPipeline
  colony:             'network',          // PeerNetwork (registered as 'network')
  driveSystem:        'goalStack',        // GoalStack
  cognitiveLoop:      'agentLoop',        // AgentLoop
  // Note: 'Reproduction' (CloneFactory) is NOT included here because CloneFactory
  // is not directly resolvable as a service — it's used by SelfModificationPipeline.
  // A container alias would be misleading. Include when CloneFactory gets its own
  // phase-7 manifest entry.
});
