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
  const tokens = _goalTokens(goalDescription);
  if (tokens.length === 0) return allModules.slice(0, LIMITS.PROMPT_MODULE_SLICE);
  const matches = allModules.filter(m => _moduleMatches(m, tokens));
  if (matches.length >= _MIN_RELEVANT_MODULES) {
    return matches.slice(0, _MAX_RELEVANT_MODULES);
  }
  const seen = new Set(matches.map(m => m.file));
  const fillers = allModules.filter(m => !seen.has(m.file)).slice(0, LIMITS.PROMPT_MODULE_SLICE);
  return [...matches, ...fillers].slice(0, _MAX_RELEVANT_MODULES);
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
  const { normalizeStepType } = require('./step-types');
  const log = opts.logger || null;
  const tag = opts.tag || '[PLAN-CTX]';
  for (const step of steps) {
    const normalized = normalizeStepType(step.type);
    if (normalized && normalized !== step.type) {
      if (log) log.info(`${tag} Normalized step type "${step.type}" → "${normalized}"`);
      step.type = normalized;
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
