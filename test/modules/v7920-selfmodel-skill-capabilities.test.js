// ============================================================
// GENESIS — v7920-selfmodel-skill-capabilities.test.js
// Facet B: installed skills surface in both capability views,
// late-bound via DI, non-mutating, deduped, defensive on absence.
// ============================================================
const { describe, test, assert, assertEqual, run } = require('../harness');
const { SelfModel } = require('../../src/agent/foundation/SelfModel');

function fresh() {
  const sm = new SelfModel('/tmp/genesis-test', null);
  sm.manifest.capabilities = ['chat', 'self-awareness'];
  sm.manifest.capabilitiesDetailed = [
    { id: 'chat', module: null, class: null, category: 'core', tags: [], description: 'Converse', keywords: [] },
  ];
  return sm;
}
const stub = (skills) => ({ listSkills: () => skills });

describe('v7920 selfmodel skill capabilities', () => {

  test('no skillManager -> base capabilities unchanged (degrade gracefully)', () => {
    const sm = fresh();
    assertEqual(sm.skillManager, null, 'slot starts null');
    assert(sm.getCapabilities().includes('chat'), 'base id present');
    assertEqual(sm.getCapabilities().length, 2, 'no skills merged when absent');
    assertEqual(sm.getCapabilitiesDetailed().length, 1, 'detailed unchanged when absent');
  });

  test('installed skills appear in both views', () => {
    const sm = fresh();
    sm.skillManager = stub([
      { name: 'git-status', version: '1.0', description: 'Show git status', interface: {} },
      { name: 'code-stats', version: '1.0', description: 'Count lines', interface: {} },
    ]);
    const ids = sm.getCapabilities();
    assert(ids.includes('chat') && ids.includes('self-awareness'), 'base ids retained');
    assert(ids.includes('git-status') && ids.includes('code-stats'), 'skills merged into ids');

    const detailed = sm.getCapabilitiesDetailed();
    const git = detailed.find(c => c.id === 'git-status');
    assert(git, 'skill present in detailed view');
    assertEqual(git.category, 'skill', 'skill entries tagged category=skill');
    assertEqual(git.description, 'Show git status', 'description carried over');
    assert(Array.isArray(git.tags) && Array.isArray(git.keywords), 'shape matches detailed entries');
  });

  test('merge is non-mutating (manifest untouched)', () => {
    const sm = fresh();
    sm.skillManager = stub([{ name: 'file-search', description: 'find files' }]);
    sm.getCapabilities();
    sm.getCapabilitiesDetailed();
    assertEqual(sm.manifest.capabilities.length, 2, 'manifest.capabilities not mutated');
    assertEqual(sm.manifest.capabilitiesDetailed.length, 1, 'manifest.capabilitiesDetailed not mutated');
  });

  test('dedup: a skill whose name equals an existing id is not duplicated', () => {
    const sm = fresh();
    sm.skillManager = stub([{ name: 'chat', description: 'dup' }, { name: 'unique-skill', description: 'x' }]);
    const ids = sm.getCapabilities();
    assertEqual(ids.filter(i => i === 'chat').length, 1, 'chat appears once');
    assert(ids.includes('unique-skill'), 'genuinely new skill still added');
    const detailed = sm.getCapabilitiesDetailed();
    assertEqual(detailed.filter(c => c.id === 'chat').length, 1, 'chat not duplicated in detailed');
  });

  test('defensive: listSkills throwing -> base returned, no throw', () => {
    const sm = fresh();
    sm.skillManager = { listSkills: () => { throw new Error('boom'); } };
    assertEqual(sm.getCapabilities().length, 2, 'falls back to base ids on error');
    assertEqual(sm.getCapabilitiesDetailed().length, 1, 'falls back to base detailed on error');
  });

});

if (require.main === module) run();
