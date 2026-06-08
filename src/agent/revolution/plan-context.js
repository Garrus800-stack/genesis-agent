// ============================================================
// GENESIS — src/agent/revolution/plan-context.js
//
// Shared helpers for injecting goal-relevant codebase context into
// LLM plan prompts. Used by three callers in v7.9.6:
//   - AgentLoopPlanner._llmPlanGoal (the v7.x LLM fallback path)
//   - FormalPlanner._llmDecompose   (the primary planning path)
//   - ColonyOrchestrator._decompose (the multi-agent subtask path)
//
// The single shared utility is pickRelevantModules: given the full
// module list from SelfModel.getModuleSummary() and a goal string,
// return a goal-token-matched slice (up to 30) that the LLM should
// be shown so it stops inventing paths.
//
// History: pickRelevantModules first appeared inline in
// AgentLoopPlanner.js (v7.7.9 post-Phase-3c.4) after the live-Befund
// where the LLM invented paths like 'src/core/goal-stack.js' for a
// goal mentioning stalled goals (real path:
// 'src/agent/planning/GoalStack.js' + 'src/agent/cognitive/
// StalledGoalWatchdog.js'). The fix worked for the AgentLoop
// fallback path, but the FormalPlanner and Colony paths shipped
// without it. v7.9.5 outpost trace confirmed the same hallucination
// class persisting via the FormalPlanner path
// ('src/agent-core/goal-driver/recovery-logger.js' invented for a
// goal about goal-driver failure recovery logging — real paths:
// 'src/agent/agency/GoalDriver.js' + GoalDriverFailurePolicy.js).
//
// v7.9.6: extracted here so all three plan-prompt builders share
// one source of truth.
// ============================================================

'use strict';

const { LIMITS } = require('../core/Constants');

const _MAX_RELEVANT_MODULES = 30;
const _MIN_RELEVANT_MODULES = 5;

// v7.9.7 P2: core-infrastructure floor — the modules a Genesis-generated
// plan will almost always want to reference (Logger via createLogger,
// EventBus for fire/on, Container for resolve, Storage/Settings for
// persistence, IntervalManager for timers). Pre-fix, when a goal's
// tokens did not match these by name (e.g. "Research Activity Time
// Logging" — "logging" did not match "logger"), the LLM saw a path
// list that did not contain the Logger and invented a relative path
// that did not exist (`require('../../core/Logger')` from a fake
// position). Sandbox.testPatch then blocked with "Read access blocked"
// or "Cannot find module ...". Live-Befund v7.9.7 outpost trace: every
// pursuit of "Research Activity Time Logging" failed with this exact
// pattern.
//
// The floor injects these paths at the head of the picked-modules list
// (provided the entries actually exist in allModules — we do not
// fabricate non-existent files) so the LLM always has the real Logger
// path available to reference, regardless of token-match outcome. Six
// paths, ~30 LOC of prompt budget — cheap insurance against repeated
// hallucination.
const CORE_INFRASTRUCTURE_PATHS = Object.freeze([
  'src/agent/core/Logger.js',
  'src/agent/core/EventBus.js',
  'src/agent/core/Container.js',
  'src/agent/foundation/StorageService.js',
  'src/agent/foundation/Settings.js',
  'src/agent/core/IntervalManager.js',
]);

const _STOPWORDS = new Set([
  'the','and','for','with','from','into','that','this','your','about','some','any','all',
  'der','die','das','und','von','mit','für','aus','dem','den','ist','wie','was','wo','wer','warum','wann','soll','will','muss','dass','nicht','auch','nach','wenn','bei','auf','vor','zur','zum','beim','wieder',
]);

function _goalTokens(goal) {
  if (typeof goal !== 'string') return [];
  return goal.toLowerCase()
    .replace(/[^a-z0-9äöüß\s]/g, ' ')
    .split(/\s+/)
    .filter(t => t.length >= 3 && !_STOPWORDS.has(t));
}

function _moduleMatches(mod, tokens) {
  const file = (mod.file || '').toLowerCase();
  const classes = (mod.classes || []).map(c => String(c).toLowerCase());
  for (const t of tokens) {
    if (file.includes(t)) return true;
    for (const c of classes) {
      if (c.includes(t)) return true;
    }
  }
  return false;
}

/**
 * Goal-relevant module-path filter.
 *
 * Given the full module list from SelfModel.getModuleSummary() and a
 * goal-description string, return up to _MAX_RELEVANT_MODULES (30)
 * entries that token-match the goal. When fewer than _MIN_RELEVANT_MODULES
 * (5) match, mix in the first-N entries by manifest order so a generic
 * goal ("clean up the code") still receives baseline context.
 *
 * @param {Array<{file:string, classes?:string[]}>} allModules
 * @param {string} goalDescription
 * @returns {Array<{file:string, classes?:string[]}>}
 */
function pickRelevantModules(allModules, goalDescription) {
  if (!Array.isArray(allModules) || allModules.length === 0) return [];

  // v7.9.7 P2: core-infrastructure floor at the head of the result.
  // We project allModules into a Map<filePath, entry> once, then walk
  // CORE_INFRASTRUCTURE_PATHS in order picking up the entries that
  // actually exist. The remaining picks (token matches + fillers) are
  // appended after, deduped against the floor.
  const byPath = new Map(allModules.map(m => [m.file, m]));
  const floor = [];
  const floorPaths = new Set();
  for (const p of CORE_INFRASTRUCTURE_PATHS) {
    if (byPath.has(p)) {
      floor.push(byPath.get(p));
      floorPaths.add(p);
    }
  }

  const tokens = _goalTokens(goalDescription);
  if (tokens.length === 0) {
    // v7.9.7 P2: floor takes priority but the empty-goal cap stays at
    // PROMPT_MODULE_SLICE total — subtract floor.length from the filler
    // slice so callers still see "at most PROMPT_MODULE_SLICE modules"
    // for the empty-goal fallback. Pre-fix this returned floor + slice(0, 20)
    // which produced 22 items in tests/contexts where floor had 2 entries.
    const fillerCap = Math.max(0, LIMITS.PROMPT_MODULE_SLICE - floor.length);
    const fillers = allModules.filter(m => !floorPaths.has(m.file)).slice(0, fillerCap);
    return [...floor, ...fillers].slice(0, _MAX_RELEVANT_MODULES);
  }

  const matches = allModules.filter(m => _moduleMatches(m, tokens) && !floorPaths.has(m.file));
  if (matches.length >= _MIN_RELEVANT_MODULES) {
    return [...floor, ...matches].slice(0, _MAX_RELEVANT_MODULES);
  }
  const seenAfterFloor = new Set([...floorPaths, ...matches.map(m => m.file)]);
  const fillers = allModules.filter(m => !seenAfterFloor.has(m.file)).slice(0, LIMITS.PROMPT_MODULE_SLICE);
  return [...floor, ...matches, ...fillers].slice(0, _MAX_RELEVANT_MODULES);
}

/**
 * Format a module-path list for inclusion in an LLM plan prompt.
 *
 * Produces a block like:
 *   - src/agent/agency/GoalDriver.js (GoalDriver)
 *   - src/agent/agency/GoalDriverFailurePolicy.js
 *   ...
 *
 * Returns the placeholder string '(no module manifest available)' when
 * the input is empty — so the caller can interpolate the result
 * unconditionally into the prompt.
 *
 * @param {Array<{file:string, classes?:string[]}>} modules
 * @returns {string}
 */
function formatModulePathList(modules) {
  if (!Array.isArray(modules) || modules.length === 0) {
    return '(no module manifest available)';
  }
  return modules.map(m =>
    `- ${m.file}${m.classes?.length ? ` (${m.classes.slice(0, 2).join(', ')})` : ''}`
  ).join('\n');
}

/**
 * In-place normalisation of step types via the central catalog.
 *
 * Used by every LLM-driven step producer in the codebase:
 *   - AgentLoopPlanner._llmPlanGoal  (initial plan parse, v7.3.5+)
 *   - AgentLoopPursuit replan loop   (every 3rd step, v7.9.6+)
 *
 * Known aliases (GIT_SNAPSHOT, WRITE_FILE, CODE_GENERATE etc.) are
 * rewritten to the canonical type via normalizeStepType. Steps with
 * a type the catalog cannot map fall back to ANALYZE with their
 * description prefixed by `[was <orig>]` so the fallback stays
 * visible in logs and self-statements.
 *
 * Mutates the steps array. Callers that want to log normalisations
 * pass a `logger` with `.info(msg)` / `.warn(msg)` methods plus an
 * optional `tag` string (defaults to '[PLAN-CTX]').
 *
 * @param {Array<{type?:string, description?:string}>} steps
 * @param {{ logger?: {info:Function,warn:Function}, tag?: string }} [opts]
 */
function normalizeStepTypes(steps, opts = {}) {
  if (!Array.isArray(steps)) return;
  const { normalizeStepType, applyStepTypeDefaults } = require('../core/step-types');
  const log = opts.logger || null;
  const tag = opts.tag || '[PLAN-CTX]';
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    // v7.9.7: guard against bare-string and other non-object array entries.
    // The reflect-LLM in AgentLoopRecovery.reflectOnProgress occasionally
    // returns mixed arrays of step-objects and bare strings; pre-fix this
    // crashed with `Cannot create property 'description' on string` because
    // the unknown-type fallback unconditionally wrote step.description.
    if (typeof step !== 'object' || step === null || Array.isArray(step)) {
      const kind = step === null ? 'null' : (Array.isArray(step) ? 'array' : typeof step);
      let asText;
      if (typeof step === 'string') {
        asText = step;
      } else {
        try { asText = JSON.stringify(step); } catch (_e) { asText = String(step); }
        if (typeof asText !== 'string') asText = String(step);
      }
      if (log) log.warn(`${tag} Step was not a plan object (${kind}) — wrapping as ANALYZE: "${asText.slice(0, 80)}"`);
      steps[i] = { type: 'ANALYZE', description: `[was ${kind}] ${asText}`.trim() };
      continue;
    }
    const _rawType = step.type;
    const normalized = normalizeStepType(step.type);
    if (normalized && normalized !== step.type) {
      if (log) log.info(`${tag} Normalized step type "${step.type}" → "${normalized}"`);
      step.type = normalized;
      // v7.9.21: covers the AgentLoopPlanner/replan paths, where RUN_TESTS is
      // rewritten to SHELL here (before the executor sees the raw type), so the
      // step carries `npm test` + the extended timeout from the start.
      applyStepTypeDefaults(step, _rawType);
    } else if (!normalized) {
      if (log) log.warn(`${tag} Unknown step type "${step.type}" — falling back to ANALYZE`);
      step.description = `[was ${step.type || '<missing>'}] ${step.description || ''}`.trim();
      step.type = 'ANALYZE';
    }
  }
}

module.exports = {
  pickRelevantModules,
  formatModulePathList,
  normalizeStepTypes,
};
