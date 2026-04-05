// ============================================================
// Test: CloneFactory.js — clone creation, planning, edge cases
// ============================================================

const { describe, test, assert, assertEqual, run, createTestRoot } = require('../harness');
const path = require('path');
const fs = require('fs');
const { CloneFactory } = require('../../src/agent/capabilities/CloneFactory');

function createFactory() {
  const tmpRoot = createTestRoot('clonefactory');
  const factory = new CloneFactory(
    tmpRoot,
    {
      getFullModel: () => ({ identity: 'Genesis', version: '3.8.0', modules: {}, files: {} }),
      readModule: () => 'const x = 1;',
      getModuleSummary: () => [],
    },
    {
      chat: async (prompt) => JSON.stringify({
        improvements: ['Better error handling'],
        files: [{ path: 'src/test.js', action: 'modify', description: 'Add error handling' }],
      }),
      activeModel: 'gemma2:9b',
    },
    { build: (type, data) => `[${type}]` },
  );
  // FIX v5.1.0 (DI-1): CodeSafety via lateBinding
  const { MockCodeSafety } = require('../../src/agent/ports/CodeSafetyPort');
  factory._codeSafety = new MockCodeSafety();
  return { factory, tmpRoot };
}

describe('CloneFactory: Construction', () => {
  test('constructor sets rootDir', () => {
    const { factory, tmpRoot } = createFactory();
    assertEqual(factory.rootDir, tmpRoot);
  });
});

describe('CloneFactory: Clone Planning', () => {
  test('_planClone returns structured plan', async () => {
    const { factory } = createFactory();
    const plan = await factory._planClone('better error handling', []);
    assert(plan, 'Should return plan');
    // Plan may be parsed JSON or raw string depending on LLM response
    assert(typeof plan === 'object' || typeof plan === 'string');
  });
});

describe('CloneFactory: createClone', () => {
  test('createClone returns result string', async () => {
    const { factory } = createFactory();
    const result = await factory.createClone({
      improvements: 'Add better error handling',
      conversation: [],
    });
    assert(typeof result === 'string', 'Should return string result');
  });

  test('createClone with empty improvements still works', async () => {
    const { factory } = createFactory();
    const result = await factory.createClone({
      improvements: '',
      conversation: [],
    });
    assert(typeof result === 'string');
  });
});

run();
