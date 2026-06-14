// @ts-checked-v5.7
// ============================================================
// GENESIS — activities/Plan.js (v7.3.1)
// Creates improvement plans; registers top plan as goal.
// Boost sources: EmotionalState idle priorities (curiosity+energy),
// NeedsSystem recommendations, UnfinishedWorkFrontier (1.6x).
// ============================================================

'use strict';

const fs = require('fs');
const path = require('path');
const { createLogger } = require('../../core/Logger');
const { READONLY_VERBS, extractLeadingVerb, _tokenize, _recentRelevantFailures,
  _recentGoalsByStatus, _overlapRedundant, buildRecentGoalContext,
  FAILURE_RELEVANCE_WINDOW_DAYS, OVERLAP_SKIP_RATIO, REDUNDANCY_FLOOR,
  _TERMINAL_GOAL_STATUS, _DONE_GOAL_STATUS } = require('../../core/goal-intent');
const { refineGoalDraft } = require('./plan-refine');
const { orderByReviewState } = require('./plan-review-feedback');
const _log = createLogger('IdleMind');

// v7.9.9 Fix 3: extract src-path-like tokens from a goal title/description
// and verify they exist in the realPaths catalogue or on disk. Pre-fix
// IdleMind/Plan generated goals referencing non-existent files (e.g.
// "Enhance Calibration Activity with Sensor Diagnostics" referenced
// src/agent/autonomy/activities/SensorDiagnostics.js which never existed),
// leading to 15-min stall-watchdog waits. The check rejects only the
// hallucination case (path mentioned, not in catalogue, not on disk).
// "Create new module Foo.js" without a concrete src/ path passes through —
// it's a legitimate new-file goal, not a hallucinated reference.
const _PATH_REGEX = /(?:src|test|scripts)\/[a-zA-Z0-9_\-/]+\.(?:js|ts|json|md)\b/g;
function _hasHallucinatedPaths(text, realPathsList, rootDir) {
  if (!text || !rootDir) return false;
  const matches = String(text).match(_PATH_REGEX) || [];
  if (matches.length === 0) return false;
  const realSet = new Set((realPathsList || '').split('\n').map(p => p.trim()).filter(Boolean));
  for (const ref of matches) {
    const normRef = ref.replace(/\\/g, '/');
    if (realSet.has(normRef)) continue;          // in catalogue → ok
    try {
      const abs = path.join(rootDir, normRef);
      if (fs.existsSync(abs)) continue;          // exists on disk → ok
    } catch (_e) { /* fall through to hallucination */ }
    return normRef;                              // hallucinated → return the bad path
  }
  return false;
}

// v7.9.20 (§8): _STOPWORDS, the dedup knobs, and the terminal/done status
// sets now live in core/goal-intent (imported above) so this activity stays
// under the RUNTIME-02 250-LOC cap.

// v7.9.9 Fix 1 (Stage A): allowed leading verbs for IdleMind goals. Closed
// whitelist — anything outside this set is refused. Catches paraphrased
// blacklist verbs ("Make X better", "Strengthen Y") that an explicit
// blacklist would miss. Only verbs that map to read-only or
// verification-capable activities are allowed; code-modification verbs
// (Improve, Refactor, Implement, Build, Add, Fix, Optimize) are
// implicitly refused by being absent from this set.
// v7.9.19 (Strang E): the verb list and leading-verb extraction now live in
// the shared core/goal-intent module so the planner and this activity
// use ONE vocabulary. Aliased here to keep the existing usage unchanged.
const _ALLOWED_VERBS = READONLY_VERBS;
const _extractLeadingVerb = extractLeadingVerb;

// v7.9.20 (§8): _tokenize, _recentRelevantFailures and _overlapRedundant now
// live in core/goal-intent (imported above) and are re-exported below for the
// existing dedup tests.

module.exports = {
  name: 'plan',
  weight: 1.0,
  cooldown: 0,

  shouldTrigger(ctx) {
    let boost = 1.0;

    const idlePrio = ctx.snap.idlePriorities || {};
    if (idlePrio.plan !== undefined) boost += idlePrio.plan * 2;

    const needRec = (ctx.snap.needs || []).find(n => n.activity === 'plan');
    if (needRec) boost += needRec.score * 3;

    // UnfinishedWorkFrontier → boost plan
    if ((ctx.snap.unfinishedWork || []).length > 0) {
      boost *= 1.6;
    }

    return boost;
  },

  async run(idleMind) {
    const modules = idleMind.selfModel?.getModuleSummary() || [];
    const caps = idleMind.selfModel?.getCapabilities() || [];
    const existingPlans = idleMind.plans.slice(-3);

    // v7.7.9 (post-burnin P2): list real source files so the LLM can only
    // reference them. v7.9.20 (L1): order not-yet-covered files first and
    // surface already-covered ones, reading ALL insight nodes (Explore/ReadSource/
    // F2) by module||file — this is what ends the idle inspection loop.
    const { realPaths, alreadyReviewed } = orderByReviewState(modules, idleMind.kg);

    // v7.7.9 + v7.9.20 (A): show recent FAILED and recent COMPLETED goals so
    // the LLM re-proposes neither. The completed list is drawn from the archive
    // ∪ live stack (buildRecentGoalContext) — a finished goal has left the live
    // stack for goals/archive.json, so reading only the live list would miss it.
    const { recentFailures, recentCompleted, failedHint: recentFailed, completedHint: recentDone } =
      buildRecentGoalContext({ goalStack: idleMind.goalStack, storage: idleMind.storage, now: Date.now(), log: _log });

    const prompt = `You are Genesis. Propose ONE concrete, verifiable activity that fits your current capabilities.\n\nReal source files you can reference (use EXACTLY these paths, do not invent):\n${realPaths}\n\nYour capabilities: ${caps.join(', ')}\n${existingPlans.length ? 'Previous plans:\n' + existingPlans.map(p => `- ${p.title}: ${p.status}`).join('\n') : ''}\n${alreadyReviewed ? '\nAlready covered (do NOT inspect again unless you have a genuinely new angle; prefer a file not in this list):\n' + alreadyReviewed : ''}\n${recentFailed ? '\nRecently FAILED goals (do NOT propose similar ones — they are obsolete):\n' + recentFailed : ''}${recentDone ? '\nRecently COMPLETED goals (do NOT propose these again — they are already done):\n' + recentDone : ''}\n\nRules:\n- Pick a SMALL, concrete activity (not an abstract meta-system).\n- TITLE must start with one of these verbs: Document, Reflect, Summarise, Research, Test, Verify, List, Compare, Investigate, Map, Index, Explore, Catalog, Inspect.\n- Reference ONLY real files from the list above.\n- The activity must be verifiable in <= 3 steps.\n- If you cannot find a small concrete activity, output: TITLE: SKIP\n\nFormat:\nTITLE: [Verb + short name, or SKIP if no concrete idea]\nPRIORITY: [high/medium/low]\nEFFORT: [small/medium/large]\nDESCRIPTION: [What exactly should be done, max 3 sentences]\nFIRST_STEP: [The very first concrete step, referencing a real file]`;

    const thought = await idleMind.model.chat(prompt, [], 'analysis');

    const titleMatch = thought.match(/TITLE:\s*(.+)/i) || thought.match(/TITEL:\s*(.+)/i);
    const prioMatch = thought.match(/PRIORITY:\s*(.+)/i) || thought.match(/PRIORITAET:\s*(.+)/i);
    if (titleMatch) {
      let title = titleMatch[1].trim();

      // v7.7.9 (post-burnin P2): respect SKIP signal from LLM and
      // skip empty/single-word abstract titles.
      if (/^skip$/i.test(title)) {
        _log.info('[IDLE-MIND] Plan: LLM returned SKIP — no concrete improvement found');
        return thought;
      }

      // v7.9.9 Fix 1 Stage A: closed verb whitelist. If the title doesn't
      // begin with a whitelisted activity verb, refuse the goal before any
      // further processing. Catches paraphrased non-actionable verbs
      // ("Improve", "Make X better", "Enhance", "Strengthen") that the LLM
      // produces under the "improvement" framing of the old prompt.
      const leadingVerb = _extractLeadingVerb(title);
      if (!leadingVerb || !_ALLOWED_VERBS.has(leadingVerb)) {
        _log.info(`[IDLE-MIND] Plan: skipping non-actionable verb: "${leadingVerb || '<none>'}" in title "${title.slice(0, 60)}"`);
        return thought;
      }

      // v7.7.9/v7.9.7 + v7.9.19 (Strang B): skip only a genuine re-run of a
      // RECENT failure (same aged list as the prompt). See _overlapRedundant.
      const titleTokens = new Set(_tokenize(title));
      let _skipOverlap = 0;
      for (const g of recentFailures.slice(-10)) {
        const { overlap, redundant } = _overlapRedundant(titleTokens, _tokenize(g.description || ''));
        if (redundant && overlap > _skipOverlap) _skipOverlap = overlap;
      }
      if (_skipOverlap > 0) {
        _log.info(`[IDLE-MIND] Plan: skipping "${title.slice(0, 50)}" — ${_skipOverlap} tokens overlap with a recent failure`);
        return thought;
      }

      // v7.9.20 (A): hard completed-skip — refuse a goal that re-proposes a
      // recently COMPLETED goal (same overlap test, over the archive ∪ live
      // view). This is the actual fix for the "same goal proposed for days"
      // bug: the finished goal lives only in the archive.
      let _skipDone = 0;
      for (const g of recentCompleted.slice(-10)) {
        const { overlap, redundant } = _overlapRedundant(titleTokens, _tokenize(g.description || g.title || ''));
        if (redundant && overlap > _skipDone) _skipDone = overlap;
      }
      if (_skipDone > 0) {
        _log.info(`[IDLE-MIND] Plan: skipping "${title.slice(0, 50)}" — ${_skipDone} tokens overlap with a recently completed goal`);
        return thought;
      }

      // v7.9.9 Fix 3: reject goals that reference non-existent src/ paths.
      // The LLM is told "use EXACTLY these paths" but ignores it. Pre-fix
      // this produced 15-min stall-watchdog waits on hallucinated files.
      const _rootDir = idleMind.selfModel?.rootDir || process.cwd();
      const _halluc = _hasHallucinatedPaths(thought, realPaths, _rootDir);
      if (_halluc) {
        _log.info(`[IDLE-MIND] Plan: skipping "${title.slice(0, 50)}" — references non-existent path: ${_halluc}`);
        return thought;
      }

      // v7.9.20 (E): one bound second look before the draft becomes an
      // irrevocable goal. The refined title is adopted in place (the addGoal(title)
      // landmark, Contract SRC-06, is preserved) only on a genuine, valid,
      // different improvement; any error leaves the draft untouched.
      try {
        const refined = await refineGoalDraft({
          title, description: thought, model: idleMind.model, allowedVerbs: _ALLOWED_VERBS,
          hasHallucinatedPaths: (txt) => _hasHallucinatedPaths(txt, realPaths, _rootDir),
        });
        if (refined && refined !== title) {
          _log.info(`[IDLE-MIND] Plan: refined title -> "${refined.slice(0, 60)}"`);
          title = refined;
        }
      } catch (e) { _log.debug('[catch] plan-refine:', e.message); }

      const priority = prioMatch?.[1]?.trim() || 'medium';
      const plan = {
        id: `plan_${Date.now()}`,
        title,
        priority,
        description: thought,
        status: 'new',
        created: new Date().toISOString(),
      };
      idleMind.plans.push(plan);
      if (idleMind.plans.length > 50) idleMind.plans = idleMind.plans.slice(-50);
      idleMind._savePlans();

      if (idleMind.goalStack && idleMind.goalStack.getActiveGoals().length < 3) {
        try {
          // v7.3.6 patch: pass triggerSource so Self-Gate can detect reflexivity
          // in the LLM output that produced this goal (e.g. "ich sollte X erstellen").
          const goal = await idleMind.goalStack.addGoal(title, 'idle-mind', priority, {
            triggerSource: thought.slice(0, 500),
          });
          // v7.9.22 Item 4: persist the goal<->plan back-link (goal may be null when
          // addGoal refuses it; the helper guards a falsy id).
          idleMind._linkGoalToPlan(goal?.id, plan.id);
        } catch (err) {
          _log.warn('[IDLE-MIND] Goal creation failed:', err.message);
        }
      }
    }

    return thought;
  },

  // v7.9.20 (§8): re-export the dedup test symbols (now imported from
  // core/goal-intent) so existing tests keep importing them from here.
  _tokenize,
  _recentRelevantFailures,
  _recentGoalsByStatus,
  _overlapRedundant,
  buildRecentGoalContext,
  FAILURE_RELEVANCE_WINDOW_DAYS,
  OVERLAP_SKIP_RATIO,
  REDUNDANCY_FLOOR,
  _DONE_GOAL_STATUS,
};
