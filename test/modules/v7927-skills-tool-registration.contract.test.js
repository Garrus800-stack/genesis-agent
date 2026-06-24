// ============================================================
// v7.9.27 — skills are reachable as tools.
//
// refreshSkills registered loaded skills as skill:<name> tools, but ran
// only on a separate promotion path — never at boot or on skill
// creation. So execute('file-search') found nothing and fell through to
// tool synthesis, which produced a parallel, broken copy. Skills are now
// registered at boot, on creation, and on demand inside execute() before
// any synthesis; synthesis is reserved for names with no skill behind
// them.
// ============================================================

'use strict';

const path = require('path');
const { describe, test, run, assert } = require('../harness');

const ROOT = path.join(__dirname, '../..');
const { ToolRegistry } = require(path.join(ROOT, 'src/agent/intelligence/ToolRegistry'));

const noBus = { fire() {}, on() {} };

function mockSkillManager(skills) {
  return {
    _skills: skills.slice(),
    listSkills() { return this._skills; },
    async executeSkill(name, input) { return { ok: true, name, input }; },
    add(s) { this._skills.push(s); },
  };
}

function skill(name) {
  return { name, description: `${name} skill`, interface: { input: {}, output: {} } };
}

function withSynthesisSpy() {
  const state = { called: false };
  const synth = { synthesize: async () => { state.called = true; return { success: false }; } };
  return { synth, state };
}

describe('v7.9.27 — skills as tools', () => {
  test('refreshSkills registers skill:<name>', () => {
    const tr = new ToolRegistry({ bus: noBus });
    tr.refreshSkills(mockSkillManager([skill('file-search')]));
    assert(tr.hasTool('skill:file-search'), 'skill registered as a tool');
  });

  test('execute(file-search) runs the skill, not synthesis', async () => {
    const tr = new ToolRegistry({ bus: noBus });
    const { synth, state } = withSynthesisSpy();
    tr._toolSynthesis = synth;
    tr.refreshSkills(mockSkillManager([skill('file-search')]));
    const res = await tr.execute('file-search', { q: 'x' });
    assert(!state.called, 'synthesis must not run when a skill exists');
    assert(res && res.ok, 'the skill executed');
  });

  test('a skill created after the last refresh registers on demand before synthesis', async () => {
    const tr = new ToolRegistry({ bus: noBus });
    const { synth, state } = withSynthesisSpy();
    tr._toolSynthesis = synth;
    const sm = mockSkillManager([]);
    tr.refreshSkills(sm);          // empty at boot
    sm.add(skill('new-skill'));    // daemon creates it later
    const res = await tr.execute('new-skill', {});
    assert(!state.called, 'on-demand registration must precede synthesis');
    assert(res && res.ok, 'the newly created skill executed');
  });

  test('an unknown tool still reaches synthesis', async () => {
    const tr = new ToolRegistry({ bus: noBus });
    const { synth, state } = withSynthesisSpy();
    tr._toolSynthesis = synth;
    tr.refreshSkills(mockSkillManager([skill('file-search')]));
    try { await tr.execute('totally-unknown', {}); } catch (_e) { /* throws after failed synth */ }
    assert(state.called, 'a name with no skill must reach synthesis');
  });
});

if (require.main === module) run();
