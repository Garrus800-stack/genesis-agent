// ============================================================
// v7.4.3 "Aufräumen II" Bausteine B/C/D — Structure tests
//
// Locks invariants of the three structural splits in v7.4.3:
//
//   B. Container        (771 → 581 LOC, ContainerDiagnostics extracted)
//   C. IntentRouter     (713 → 450 LOC, IntentPatterns extracted as data)
//   D. SelfModPipeline  (704 → 453 LOC, Modify family extracted)
//
// If any of these tests fail, the split is broken in a way that
// functional tests won't catch (silent move to wrong file, missing
// Object.assign, file regrew past 700 LOC).
//
// Analog to v739-structure.test.js, v742-structure.test.js.
// ============================================================

'use strict';

const { describe, it } = require('node:test');
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const { Container } = require('../../src/agent/core/Container');
const { IntentRouter } = require('../../src/agent/intelligence/IntentRouter');
const { SelfModificationPipeline } = require('../../src/agent/hexagonal/SelfModificationPipeline');

const SRC = path.resolve(__dirname, '../../src/agent');

function loc(relPath) {
  const full = path.join(SRC, relPath);
  return fs.readFileSync(full, 'utf-8').split('\n').length;
}

describe('v7.4.3 Baustein B — Container / ContainerDiagnostics split', () => {

  it('Container.js is below the 700-LOC threshold', () => {
    const lines = loc('core/Container.js');
    assert.ok(lines <= 700, `Container.js grew to ${lines} LOC (threshold: 700)`);
  });

  it('ContainerDiagnostics.js exists', () => {
    const p = path.join(SRC, 'core/ContainerDiagnostics.js');
    assert.ok(fs.existsSync(p), 'ContainerDiagnostics.js must exist');
  });

  it('all four diagnostic methods are reachable on Container.prototype', () => {
    const expected = ['getDependencyGraph', 'validateRegistrations', '_topologicalSort', '_toLevels'];
    for (const m of expected) {
      assert.strictEqual(typeof Container.prototype[m], 'function',
        `Container.prototype.${m} must be a function (prototype delegation broken?)`);
    }
  });

  it('diagnostic methods produce expected results on a small graph', () => {
    const c = new Container();
    c.register('a', () => 'A');
    c.register('b', () => 'B', { deps: ['a'] });
    const graph = c.getDependencyGraph();
    assert.deepStrictEqual(Object.keys(graph).sort(), ['a', 'b']);
    const v = c.validateRegistrations();
    assert.strictEqual(v.valid, true);
    const topo = c._topologicalSort();
    assert.deepStrictEqual(topo, ['a', 'b']);
    const levels = c._toLevels();
    assert.deepStrictEqual(levels, [['a'], ['b']]);
  });
});

describe('v7.4.3 Baustein C — IntentRouter / IntentPatterns split', () => {

  it('IntentRouter.js is below the 700-LOC threshold', () => {
    const lines = loc('intelligence/IntentRouter.js');
    assert.ok(lines <= 700, `IntentRouter.js grew to ${lines} LOC (threshold: 700)`);
  });

  it('IntentPatterns.js exists and exports the three names', () => {
    const p = require('../../src/agent/intelligence/IntentPatterns');
    assert.ok(Array.isArray(p.INTENT_DEFINITIONS), 'INTENT_DEFINITIONS must be an array');
    assert.ok(p.INTENT_DEFINITIONS.length >= 25, 'should have at least 25 intents');
    assert.ok(p.SLASH_ONLY_INTENTS instanceof Set, 'SLASH_ONLY_INTENTS must be a Set');
    assert.ok(p.SLASH_ONLY_INTENTS.size >= 10, 'should have at least 10 slash-only intents');
    assert.strictEqual(typeof p.enforceSlashDiscipline, 'function');
  });

  it('IntentRouter loads patterns from IntentPatterns', () => {
    const r = new IntentRouter();
    assert.ok(r.listIntents().length >= 25, 'IntentRouter must load all default intents');
  });

  it('slash-discipline guard rewrites slash-only intents without /', () => {
    const { enforceSlashDiscipline } = require('../../src/agent/intelligence/IntentPatterns');
    // 'settings' is in SLASH_ONLY_INTENTS — without '/' it must rewrite to general
    const result = enforceSlashDiscipline(
      { type: 'settings', confidence: 0.9 },
      'show me the settings please'
    );
    assert.strictEqual(result.type, 'general');
  });

  it('slash-discipline guard preserves slash-only intents WITH /', () => {
    const { enforceSlashDiscipline } = require('../../src/agent/intelligence/IntentPatterns');
    const result = enforceSlashDiscipline(
      { type: 'settings', confidence: 0.9 },
      '/settings show'
    );
    assert.strictEqual(result.type, 'settings');
  });
});

describe('v7.4.3 Baustein D — SelfModPipeline / Modify split', () => {

  it('SelfModificationPipeline.js is below the 700-LOC threshold', () => {
    const lines = loc('hexagonal/SelfModificationPipeline.js');
    assert.ok(lines <= 700, `SelfModificationPipeline.js grew to ${lines} LOC (threshold: 700)`);
  });

  it('SelfModificationPipelineModify.js exists', () => {
    const p = path.join(SRC, 'hexagonal/SelfModificationPipelineModify.js');
    assert.ok(fs.existsSync(p), 'SelfModificationPipelineModify.js must exist');
  });

  it('all four modify-family methods are reachable on prototype', () => {
    const expected = ['modify', '_modifyWithDiff', '_modifyFullFile', '_extractPatches'];
    for (const m of expected) {
      assert.strictEqual(typeof SelfModificationPipeline.prototype[m], 'function',
        `SelfModificationPipeline.prototype.${m} must be a function (mixin missing?)`);
    }
  });

  it('inspect / reflect / repair / clone stay in core (not in mixin)', () => {
    // These are NOT moved — they remain class methods. We verify by checking
    // they're not in the mixin export.
    const { selfModificationPipelineModify } = require('../../src/agent/hexagonal/SelfModificationPipelineModify');
    const mixinKeys = Object.keys(selfModificationPipelineModify);
    for (const m of ['inspect', 'reflect', 'repair', 'clone', 'createSkill', '_greeting']) {
      assert.ok(!mixinKeys.includes(m),
        `${m} should stay in the pipeline core, not be in the modify mixin`);
    }
  });

  it('_extractPatches works through prototype delegation', () => {
    const p = Object.create(SelfModificationPipeline.prototype);
    const sample = '// FILE: foo.js\n```js\nconst x = 1;\n```';
    const patches = p._extractPatches(sample);
    assert.strictEqual(patches.length, 1);
    assert.strictEqual(patches[0].file, 'foo.js');
  });
});

describe('v7.4.3 — O-8 progress tracker', () => {

  it('three of four files-over-700 from v7.4.2 are now under threshold', () => {
    const reduced = {
      'core/Container.js': 700,
      'intelligence/IntentRouter.js': 700,
      'hexagonal/SelfModificationPipeline.js': 700,
    };
    for (const [rel, max] of Object.entries(reduced)) {
      const lines = loc(rel);
      assert.ok(lines <= max,
        `${rel} should be ≤ ${max} LOC after v7.4.3 split. Current: ${lines}`);
    }
  });

  it('PromptBuilderSections deliberately stays open (O-12)', () => {
    // This test does NOT assert PromptBuilderSections is under 700 — it
    // documents that the file is intentionally left for v7.6 BeliefStore
    // re-org. If someone later splits it without re-org context, this test
    // is the place to update the rationale.
    const lines = loc('intelligence/PromptBuilderSections.js');
    assert.ok(lines > 0, 'PromptBuilderSections.js must exist');
    // No upper bound — it WILL be re-organised in v7.6. See O-12.
  });
});
