// ============================================================
// v7.4.1 — SelfModel Delegation Integrity Test
//
// Verifies that the v7.4.1 split of SelfModel.js into 4 files
// (SelfModelParsing, SelfModelCapabilities, SelfModelSourceRead)
// preserves the full API surface via prototype delegation.
//
// Pattern: same as PromptBuilder → PromptBuilderSections split.
// ============================================================

const { describe, test, assert, assertEqual, run } = require('../harness');
const path = require('path');
const fs = require('fs');

const { SelfModel } = require('../../src/agent/foundation/SelfModel');
const { selfModelParsing } = require('../../src/agent/foundation/SelfModelParsing');
const { selfModelCapabilities } = require('../../src/agent/foundation/SelfModelCapabilities');
const { selfModelSourceRead } = require('../../src/agent/foundation/SelfModelSourceRead');

const TEST_ROOT = path.join(__dirname, '..', '..', 'test');

describe('SelfModel Delegation (v7.4.1 split)', () => {

  // ── Parsing methods ──────────────────────────────────────

  test('_parseModule is available on prototype (SelfModelParsing)', () => {
    const sm = new SelfModel(TEST_ROOT, null);
    assert(typeof sm._parseModule === 'function', '_parseModule must be a function');
  });

  test('_scanDirAsync is available on prototype (SelfModelParsing)', () => {
    const sm = new SelfModel(TEST_ROOT, null);
    assert(typeof sm._scanDirAsync === 'function', '_scanDirAsync must be a function');
  });

  test('_scanDir is available on prototype (SelfModelParsing)', () => {
    const sm = new SelfModel(TEST_ROOT, null);
    assert(typeof sm._scanDir === 'function', '_scanDir must be a function');
  });

  test('_parseModule extracts class names correctly', () => {
    const sm = new SelfModel(TEST_ROOT, null);
    const result = sm._parseModule('class HealthMonitor { }\nclass EmotionalState extends HealthMonitor { }', 'test.js');
    assert(result.classes.includes('HealthMonitor'), 'should find HealthMonitor');
    assert(result.classes.includes('EmotionalState'), 'should find EmotionalState');
  });

  // ── Capability methods ───────────────────────────────────

  test('_detectCapabilities is available on prototype (SelfModelCapabilities)', () => {
    const sm = new SelfModel(TEST_ROOT, null);
    assert(typeof sm._detectCapabilities === 'function', '_detectCapabilities must be a function');
  });

  test('_classToCapId is available on prototype (SelfModelCapabilities)', () => {
    const sm = new SelfModel(TEST_ROOT, null);
    assertEqual(sm._classToCapId('IdleMind'), 'idle-mind');
    assertEqual(sm._classToCapId('HomeostasisV2'), 'homeostasis-v2');
  });

  test('_splitCamelCase is available on prototype (SelfModelCapabilities)', () => {
    const sm = new SelfModel(TEST_ROOT, null);
    const result = sm._splitCamelCase('CognitiveSelfModel');
    assert(result.includes('Cognitive'), 'should split CognitiveSelfModel');
    assert(result.includes('Self'), 'should split CognitiveSelfModel');
    assert(result.includes('Model'), 'should split CognitiveSelfModel');
  });

  test('_extractKeywordsFromHeader is available on prototype (SelfModelCapabilities)', () => {
    const sm = new SelfModel(TEST_ROOT, null);
    const kw = sm._extractKeywordsFromHeader('Regulates internal state via corrective feedback');
    assert(kw.length > 0, 'should extract keywords');
    assert(kw.includes('regulates'), 'should include "regulates"');
  });

  // ── Source-read methods ──────────────────────────────────

  test('readModule is available on prototype (SelfModelSourceRead)', () => {
    const sm = new SelfModel(TEST_ROOT, null);
    assert(typeof sm.readModule === 'function', 'readModule must be a function');
  });

  test('readSourceSync is available on prototype (SelfModelSourceRead)', () => {
    const sm = new SelfModel(TEST_ROOT, null);
    assert(typeof sm.readSourceSync === 'function', 'readSourceSync must be a function');
  });

  test('readModuleAsync is available on prototype (SelfModelSourceRead)', () => {
    const sm = new SelfModel(TEST_ROOT, null);
    assert(typeof sm.readModuleAsync === 'function', 'readModuleAsync must be a function');
  });

  test('describeModule is available on prototype (SelfModelSourceRead)', () => {
    const sm = new SelfModel(TEST_ROOT, null);
    assert(typeof sm.describeModule === 'function', 'describeModule must be a function');
  });

  test('startReadSourceTurn is available on prototype (SelfModelSourceRead)', () => {
    const sm = new SelfModel(TEST_ROOT, null);
    assert(typeof sm.startReadSourceTurn === 'function', 'startReadSourceTurn must be a function');
    sm.startReadSourceTurn('test-turn-1');
    assertEqual(sm._readSourceState.currentTurnId, 'test-turn-1');
  });

  test('getReadSourceBudget is available on prototype (SelfModelSourceRead)', () => {
    const sm = new SelfModel(TEST_ROOT, null);
    const budget = sm.getReadSourceBudget();
    assert(typeof budget.softPerTurn === 'number', 'budget should have softPerTurn');
    assert(typeof budget.turnCount === 'number', 'budget should have turnCount');
  });

  test('resetReadSourceSession is available on prototype (SelfModelSourceRead)', () => {
    const sm = new SelfModel(TEST_ROOT, null);
    sm._readSourceState.sessionCount = 5;
    sm.resetReadSourceSession();
    assertEqual(sm._readSourceState.sessionCount, 0);
  });

  // ── Core methods still on SelfModel ──────────────────────

  test('scan is still on SelfModel (not delegated)', () => {
    assert(SelfModel.prototype.hasOwnProperty('scan'), 'scan must be own method');
  });

  test('getFullModel is still on SelfModel (not delegated)', () => {
    assert(SelfModel.prototype.hasOwnProperty('getFullModel'), 'getFullModel must be own method');
  });

  test('commitSnapshot is still on SelfModel (not delegated)', () => {
    assert(SelfModel.prototype.hasOwnProperty('commitSnapshot'), 'commitSnapshot must be own method');
  });

  // ── Delegate objects export correctly ────────────────────

  test('selfModelParsing is a plain object with expected methods', () => {
    assert(typeof selfModelParsing._parseModule === 'function');
    assert(typeof selfModelParsing._scanDir === 'function');
    assert(typeof selfModelParsing._scanDirAsync === 'function');
  });

  test('selfModelCapabilities is a plain object with expected methods', () => {
    assert(typeof selfModelCapabilities._detectCapabilities === 'function');
    assert(typeof selfModelCapabilities._classToCapId === 'function');
  });

  test('selfModelSourceRead is a plain object with expected methods', () => {
    assert(typeof selfModelSourceRead.readModule === 'function');
    assert(typeof selfModelSourceRead.readSourceSync === 'function');
    assert(typeof selfModelSourceRead.readModuleAsync === 'function');
    assert(typeof selfModelSourceRead.describeModule === 'function');
  });
});

run();
