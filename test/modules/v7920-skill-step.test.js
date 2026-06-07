// ============================================================
// GENESIS — v7920-skill-step.test.js
// Facet C: trySkillStep runs an installed skill for a step ONLY when all
// three gates pass — autonomous:true, CapabilityMatcher score >= 0.75, and
// a clean two-pass AST scan. Any gate failure falls through (returns null)
// and never executes skill code.
// ============================================================
const { describe, test, assert, assertEqual, run } = require('../harness');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { trySkillStep } = require('../../src/agent/revolution/skill-step');

const SAFE = 'module.exports = function(input){ return { branch: "main", ok: true }; };';
const UNSAFE = 'module.exports = function(input){ return eval("1+1"); };';

// Build a minimal SkillManager stub backed by real on-disk skill files
// (the AST gate reads and parses the actual code).
function makeManager(skills) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'genesis-skillstep-'));
  const loaded = new Map();
  const calls = [];
  for (const s of skills) {
    const dir = path.join(root, s.name);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'index.js'), s.code);
    loaded.set(s.name, { name: s.name, description: s.description, autonomous: s.autonomous, dir, entry: 'index.js' });
  }
  return {
    _calls: calls,
    loadedSkills: loaded,
    listSkills: () => Array.from(loaded.values()).map(s => ({
      name: s.name, version: '1.0', description: s.description, interface: {}, autonomous: s.autonomous === true,
    })),
    executeSkill: async (name, input) => { calls.push({ name, input }); return { ran: name }; },
  };
}

const gitSkill = (autonomous, code = SAFE) => ({
  name: 'git-status', description: 'git status branch commits dirty staged', autonomous, code,
});
const stepFor = (desc) => ({ type: 'ANALYZE', description: desc, target: '' });

describe('v7920 skill-step triple gate', () => {

  test('all gates pass -> skill runs and returns a handled result', async () => {
    const mgr = makeManager([gitSkill(true)]);
    const res = await trySkillStep({ step: stepFor('git status branch commits dirty staged'), skillManager: mgr });
    assert(res, 'a result is returned when all gates pass');
    assertEqual(res.handledBySkill, true, 'flagged handledBySkill');
    assertEqual(res.skill, 'git-status', 'the matched skill ran');
    assert(res.matchScore >= 0.75, 'match score cleared the 0.75 threshold');
    assertEqual(mgr._calls.length, 1, 'executeSkill was called exactly once');
  });

  test('gate 1: a non-autonomous skill is never a candidate', async () => {
    const mgr = makeManager([gitSkill(false)]);
    const res = await trySkillStep({ step: stepFor('git status branch commits dirty staged'), skillManager: mgr });
    assertEqual(res, null, 'falls through when no skill opts in');
    assertEqual(mgr._calls.length, 0, 'skill code never executed');
  });

  test('gate 2: an unrelated step does not clear the match threshold', async () => {
    const mgr = makeManager([gitSkill(true)]);
    const res = await trySkillStep({ step: stepFor('summarise the quarterly weather forecast for tomorrow'), skillManager: mgr });
    assertEqual(res, null, 'falls through on low capability match');
    assertEqual(mgr._calls.length, 0, 'skill code never executed');
  });

  test('gate 3: unsafe skill code is blocked by the AST scan (and not executed)', async () => {
    const mgr = makeManager([gitSkill(true, UNSAFE)]);
    const res = await trySkillStep({ step: stepFor('git status branch commits dirty staged'), skillManager: mgr });
    assertEqual(res, null, 'falls through when the AST scan fails');
    assertEqual(mgr._calls.length, 0, 'unsafe skill code is never executed');
  });

  test('defensive: no skillManager / missing code -> null, no throw', async () => {
    assertEqual(await trySkillStep({ step: stepFor('anything') }), null, 'missing manager safe');
    const mgr = makeManager([gitSkill(true)]);
    mgr.loadedSkills.get('git-status').entry = 'does-not-exist.js';
    const res = await trySkillStep({ step: stepFor('git status branch commits dirty staged'), skillManager: mgr });
    assertEqual(res, null, 'missing code file -> fall through');
  });

});

if (require.main === module) run();
