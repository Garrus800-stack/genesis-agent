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

// v7.9.7 P15: extended stopwords for goal-token-overlap dedup. Pre-fix
// the tokeniser only filtered tokens shorter than 4 chars; it didn't
// filter generic goal-words. Both "Improve Calibration Activity Error
// Handling" and "Research Activity Time Logging" carried the token
// 'activity' but only that one overlapped, so the ≥2 threshold didn't
// trigger and both synthesised. With these in place only domain-content
// tokens count towards the overlap.
const _STOPWORDS = new Set([
  'activity', 'activities',
  'error', 'errors',
  'improve', 'improvement',
  'handle', 'handling',
  'system', 'method',
  'feature', 'function',
  'process', 'general',
  'better', 'support',
  'enable', 'allow',
]);

// v7.9.9 Fix 1 (Stage A): allowed leading verbs for IdleMind goals. Closed
// whitelist — anything outside this set is refused. Catches paraphrased
// blacklist verbs ("Make X better", "Strengthen Y") that an explicit
// blacklist would miss. Only verbs that map to read-only or
// verification-capable activities are allowed; code-modification verbs
// (Improve, Refactor, Implement, Build, Add, Fix, Optimize) are
// implicitly refused by being absent from this set.
const _ALLOWED_VERBS = new Set([
  'document', 'reflect', 'summarise', 'summarize', 'research',
  'test', 'verify', 'list', 'compare', 'investigate',
  'map', 'index', 'explore', 'catalog', 'catalogue', 'inspect',
]);

function _extractLeadingVerb(title) {
  if (!title || typeof title !== 'string') return null;
  // Strip leading punctuation / brackets, take first alphabetic token.
  const match = title.trim().match(/^[\[\(\{"'`*]*([A-Za-z]+)/);
  if (!match) return null;
  return match[1].toLowerCase();
}

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

    // v7.7.9 (post-burnin P2): list real source files so the LLM can
    // only reference them. Cap at 30 to keep prompt size manageable.
    const realPaths = modules.slice(0, 30).map(m => m.file).join('\n');

    // v7.7.9 (post-burnin P2): show recent failed/obsolete goals so the
    // LLM doesn't propose the same abstract meta-goal again.
    const recentFailed = (idleMind.goalStack?.goals || [])
      .filter(g => ['obsolete', 'stalled', 'failed'].includes(g.status))
      .slice(-5)
      .map(g => `- ${(g.description || '').slice(0, 80)} [${g.status}]`)
      .join('\n');

    const prompt = `You are Genesis. Propose ONE concrete, verifiable activity that fits your current capabilities.\n\nReal source files you can reference (use EXACTLY these paths, do not invent):\n${realPaths}\n\nYour capabilities: ${caps.join(', ')}\n${existingPlans.length ? 'Previous plans:\n' + existingPlans.map(p => `- ${p.title}: ${p.status}`).join('\n') : ''}\n${recentFailed ? '\nRecently FAILED goals (do NOT propose similar ones — they are obsolete):\n' + recentFailed : ''}\n\nRules:\n- Pick a SMALL, concrete activity (not an abstract meta-system).\n- TITLE must start with one of these verbs: Document, Reflect, Summarise, Research, Test, Verify, List, Compare, Investigate, Map, Index, Explore, Catalog, Inspect.\n- Reference ONLY real files from the list above.\n- The activity must be verifiable in <= 3 steps.\n- If you cannot find a small concrete activity, output: TITLE: SKIP\n\nFormat:\nTITLE: [Verb + short name, or SKIP if no concrete idea]\nPRIORITY: [high/medium/low]\nEFFORT: [small/medium/large]\nDESCRIPTION: [What exactly should be done, max 3 sentences]\nFIRST_STEP: [The very first concrete step, referencing a real file]`;

    const thought = await idleMind.model.chat(prompt, [], 'analysis');

    const titleMatch = thought.match(/TITLE:\s*(.+)/i) || thought.match(/TITEL:\s*(.+)/i);
    const prioMatch = thought.match(/PRIORITY:\s*(.+)/i) || thought.match(/PRIORITAET:\s*(.+)/i);
    if (titleMatch) {
      const title = titleMatch[1].trim();

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

      // v7.7.9 (post-burnin P2): token-overlap check against recently
      // failed goals. If 2+ tokens overlap with a recent failure → skip.
      // v7.9.7 P15: tokeniser filters _STOPWORDS to keep only domain-content
      // tokens — pre-fix two goals matched only on 'activity' and both
      // synthesised.
      const _tokenize = (s) => (s || '').toLowerCase()
        .replace(/[^a-z0-9äöüß]+/g, ' ').split(/\s+/)
        .filter(t => t.length >= 4 && !_STOPWORDS.has(t));
      const titleTokens = new Set(_tokenize(title));
      const recentFailedDescs = (idleMind.goalStack?.goals || [])
        .filter(g => ['obsolete', 'stalled', 'failed'].includes(g.status))
        .slice(-10)
        .map(g => g.description || '');
      let _maxOverlap = 0;
      for (const desc of recentFailedDescs) {
        const overlap = _tokenize(desc).filter(t => titleTokens.has(t)).length;
        if (overlap > _maxOverlap) _maxOverlap = overlap;
      }
      if (_maxOverlap >= 2) {
        _log.info(`[IDLE-MIND] Plan: skipping "${title.slice(0, 50)}" — ${_maxOverlap} tokens overlap with recent failures`);
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
          await idleMind.goalStack.addGoal(title, 'idle-mind', priority, {
            triggerSource: thought.slice(0, 500),
          });
        } catch (err) {
          _log.warn('[IDLE-MIND] Goal creation failed:', err.message);
        }
      }
    }

    return thought;
  },
};
