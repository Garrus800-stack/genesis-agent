// ============================================================
// Test: SelfStatementLog ↔ PromptBuilder integration (v7.5.5)
//
// Verifies:
//   - _introspectionContext now runs for every turn (not just self-inspect)
//   - setLastIntrospectionPopulated(true/false) is called per turn
//   - _selfAwarenessContext shows audit-stat when meetsThreshold && without > 0
//   - _selfAwarenessContext stays silent when meetsThreshold = false
//   - _selfAwarenessContext stays silent when without === 0
//   - _introspectionContext duplicate was removed from PromptBuilderSections.js
// ============================================================

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const { describe, test, assert, assertEqual, run } = require('../harness');
const { PromptBuilder } = require('../../src/agent/intelligence/PromptBuilder');
const { SelfStatementLog } = require('../../src/agent/cognitive/SelfStatementLog');

function freshDir() {
  const dir = path.join(os.tmpdir(), 'genesis-pi-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8));
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function makeBuilder(opts = {}) {
  const builder = new PromptBuilder({
    selfModel: opts.selfModel || {
      getFullModel: () => ({}), getModuleSummary: () => [], getCapabilities: () => [], moduleCount: () => 0,
      manifest: opts.manifest || null,
    },
    model: { activeModel: 'test-model' },
    skills: { listSkills: () => [] },
    knowledgeGraph: null,
    memory: null,
    storage: null,
  });
  if (opts.selfStatementLog !== undefined) builder.selfStatementLog = opts.selfStatementLog;
  if (opts.selfNarrative !== undefined) builder.selfNarrative = opts.selfNarrative;
  return builder;
}

// ────────────────────────────────────────────────────────
// _introspectionContext: trigger removal + populate-flag
// ────────────────────────────────────────────────────────

describe('_introspectionContext: trigger always runs (v7.5.5)', () => {
  test('runs for general intent (no longer locked to self-inspect)', () => {
    const log = new SelfStatementLog({
      bus: { fire: () => {} },
      storageDir: freshDir(),
      flushDebounceMs: 0,
    });
    const builder = makeBuilder({
      selfStatementLog: log,
      manifest: {
        version: '7.5.5',
        modules: { 'src/agent/foo.js': {} },
        capabilities: ['cap1', 'cap2'],
      },
    });
    builder.setIntent && builder.setIntent('general');

    const out = builder._introspectionContext();
    assert(out.includes('VERIFIED FACTS'), 'block populated for general intent');
    assertEqual(log._lastIntrospectionPopulated, true, 'flag set true');
  });

  test('reports populated=false when no self-data sources available', () => {
    const log = new SelfStatementLog({
      bus: { fire: () => {} },
      storageDir: freshDir(),
      flushDebounceMs: 0,
    });
    const builder = makeBuilder({ selfStatementLog: log /* no manifest, no other sources */ });
    builder.setIntent && builder.setIntent('general');

    const out = builder._introspectionContext();
    assertEqual(out, '', 'empty when nothing to inject');
    assertEqual(log._lastIntrospectionPopulated, false, 'flag set false');
  });

  test('does not crash when selfStatementLog is null', () => {
    const builder = makeBuilder({
      selfStatementLog: null,
      manifest: { version: '7.5.5', modules: { 'src/x.js': {} }, capabilities: ['c'] },
    });
    builder.setIntent && builder.setIntent('general');
    const out = builder._introspectionContext();
    assert(out.includes('VERIFIED FACTS'), 'still works without log');
  });
});

// ────────────────────────────────────────────────────────
// _selfAwarenessContext: audit-stat line
// ────────────────────────────────────────────────────────

describe('_selfAwarenessContext: audit-stat (v7.5.5)', () => {
  test('shows audit-stat line when meetsThreshold && without > 0', () => {
    const stubLog = {
      getAuditStat: () => ({ total: 5, withData: 2, without: 3, meetsThreshold: true }),
    };
    const builder = makeBuilder({ selfStatementLog: stubLog });
    const out = builder._selfAwarenessContext();
    assert(out.includes('Self-claim audit'), 'audit line present');
    assert(out.includes('5 structural'), 'shows total count');
    assert(out.includes('3 of them without'), 'shows without count');
  });

  test('hides audit-stat line when meetsThreshold === false', () => {
    const stubLog = {
      getAuditStat: () => ({ total: 1, withData: 0, without: 1, meetsThreshold: false }),
    };
    const builder = makeBuilder({ selfStatementLog: stubLog });
    const out = builder._selfAwarenessContext();
    assertEqual(out, '', 'no line below threshold');
  });

  test('hides audit-stat line when without === 0 (positive case silent)', () => {
    const stubLog = {
      getAuditStat: () => ({ total: 10, withData: 10, without: 0, meetsThreshold: true }),
    };
    const builder = makeBuilder({ selfStatementLog: stubLog });
    const out = builder._selfAwarenessContext();
    assertEqual(out, '', 'no line when nothing without backing');
  });
});

// ────────────────────────────────────────────────────────
// Boy-Scout: duplicate _introspectionContext removed from Sections.js
// ────────────────────────────────────────────────────────

describe('PromptBuilderSections: duplicate _introspectionContext removed (v7.5.5)', () => {
  test('Sections.js has no own _introspectionContext key', () => {
    const sectionsPath = path.join(__dirname, '..', '..', 'src', 'agent', 'intelligence', 'PromptBuilderSections.js');
    const text = fs.readFileSync(sectionsPath, 'utf8');
    // The string '_introspectionContext()' (the method definition) must
    // NOT appear in Sections.js anymore — only the comment block should.
    const matches = text.match(/_introspectionContext\(\s*\)/g) || [];
    assertEqual(matches.length, 0, 'no method definition for _introspectionContext in Sections.js');
  });

  test('Extra.js still has the live _introspectionContext method', () => {
    const extraPath = path.join(__dirname, '..', '..', 'src', 'agent', 'intelligence', 'PromptBuilderSectionsExtra.js');
    const text = fs.readFileSync(extraPath, 'utf8');
    const matches = text.match(/_introspectionContext\(\s*\)/g) || [];
    assertEqual(matches.length, 1, 'exactly one method definition in Extra.js');
  });
});

run();
