// @ts-checked
// ============================================================
// GENESIS — revolution/skill-step.js (v7.9.20)
// Lets an installed skill fulfil a single pursuit step — behind a triple
// gate, all three of which must pass before any skill code runs:
//   (1) opt-in:  the skill manifest declares "autonomous": true
//   (2) fit:     the step matches the skill at >= MATCH_THRESHOLD
//                (planning/CapabilityMatcher, TF-IDF cosine)
//   (3) safety:  the skill's own code passes the two-pass AST scan
//                (intelligence/CodeSafetyScanner, acorn)
// Any gate failure — or any thrown error — returns null so the caller
// falls through to the normal step switch. Skill code is NEVER executed
// un-gated. The logic lives here (not in AgentLoopSteps) so that file
// stays under the File Size Guard.
// ============================================================

'use strict';

const fs = require('fs');
const path = require('path');
const { createLogger } = require('../core/Logger');
const { match } = require('../planning/CapabilityMatcher');
const { scanCodeSafety } = require('../intelligence/CodeSafetyScanner');
const _log = createLogger('AgentLoop');

// Minimum CapabilityMatcher score for a skill to claim a step.
const MATCH_THRESHOLD = 0.75;

/**
 * @param {object} args
 * @param {object} args.step                 - the pursuit step ({ type, description, target })
 * @param {object} args.skillManager         - SkillManager ({ listSkills, executeSkill, loadedSkills })
 * @param {object} [args.log]                - logger
 * @returns {Promise<object|null>} a step result, or null to fall through
 */
async function trySkillStep({ step, skillManager, log } = {}) {
  const lg = log || _log;
  try {
    if (!step || !skillManager || typeof skillManager.listSkills !== 'function') return null;
    const description = `${step.description || ''} ${step.target || ''}`.trim();
    if (!description) return null;

    // Gate 1 — opt-in: only skills whose manifest sets autonomous:true.
    const candidates = (skillManager.listSkills() || []).filter(s => s && s.autonomous === true);
    if (candidates.length === 0) return null;

    // Gate 2 — fit: CapabilityMatcher score must clear the threshold.
    const caps = candidates.map(s => ({ id: s.name, name: s.name, description: s.description || s.name, keywords: [] }));
    const m = match(description, caps);
    if (!m || !m.matched || !(m.score >= MATCH_THRESHOLD)) return null;
    const name = m.matched.id || m.matched.name;
    if (!name) return null;

    // Gate 3 — safety: the skill's own code must pass the AST scan.
    const rec = skillManager.loadedSkills && skillManager.loadedSkills.get(name);
    const codePath = (rec && rec.dir && rec.entry) ? path.join(rec.dir, rec.entry) : null;
    if (!codePath || !fs.existsSync(codePath)) return null;
    let code;
    try { code = fs.readFileSync(codePath, 'utf-8'); } catch { return null; }
    const scan = scanCodeSafety(code, codePath);
    if (!scan || scan.safe !== true) {
      lg.debug(`[SKILL-STEP] "${name}" failed the AST safety scan — not run autonomously`);
      return null;
    }

    // All three gates passed — run the skill for this step.
    lg.info(`[SKILL-STEP] step fulfilled by skill "${name}" (match ${m.score.toFixed(2)})`);
    const out = await skillManager.executeSkill(name, { description, target: step.target });
    return {
      type: step.type,
      skill: name,
      matchScore: m.score,
      output: out,
      success: !(out && out.error),
      handledBySkill: true,
    };
  } catch (e) {
    (log || _log).debug('[SKILL-STEP] error (falling through to switch):', e.message);
    return null;
  }
}

module.exports = { trySkillStep, MATCH_THRESHOLD };
