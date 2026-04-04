// ============================================================
// TEST — DynamicContextBudget.js (v6.0.1)
// ============================================================

const { describe, test, run } = require('../harness');
const { DynamicContextBudget, DEFAULT_PROFILES } = require('../../src/agent/intelligence/DynamicContextBudget');

function makeBudget(opts = {}) {
  return new DynamicContextBudget({ bus: { emit() {} }, storage: null, ...opts });
}

describe('DynamicContextBudget', () => {
  test('allocate returns budget for all slots', () => {
    const dcb = makeBudget();
    const budgets = dcb.allocate('chat', { totalBudget: 8000 });
    const slots = ['system', 'memory', 'code', 'conversation', 'tools', 'selfNarrative', 'reserved'];
    for (const slot of slots) {
      if (typeof budgets[slot] !== 'number') throw new Error(`Missing slot: ${slot}`);
      if (budgets[slot] < 0) throw new Error(`Negative budget for ${slot}`);
    }
  });

  test('budgets sum approximately to totalBudget', () => {
    const dcb = makeBudget();
    const budgets = dcb.allocate('code-gen', { totalBudget: 10000 });
    const sum = Object.values(budgets).reduce((a, b) => a + b, 0);
    if (Math.abs(sum - 10000) > 200) throw new Error(`Sum ${sum} should be ~10000`);
  });

  test('code-gen allocates majority to code', () => {
    const dcb = makeBudget();
    const budgets = dcb.allocate('code-gen', { totalBudget: 10000 });
    if (budgets.code < budgets.conversation) throw new Error('Code-gen should prioritize code over conversation');
  });

  test('chat allocates majority to conversation', () => {
    const dcb = makeBudget();
    const budgets = dcb.allocate('chat', { totalBudget: 10000 });
    if (budgets.conversation < budgets.code) throw new Error('Chat should prioritize conversation over code');
  });

  test('unknown intent falls back to general profile', () => {
    const dcb = makeBudget();
    const budgets = dcb.allocate('unknown-intent', { totalBudget: 8000 });
    if (typeof budgets.system !== 'number') throw new Error('Should return valid budgets for unknown intent');
  });

  test('hasCode=false redistributes code budget', () => {
    const dcb = makeBudget();
    const withCode = dcb.allocate('chat', { totalBudget: 8000, hasCode: true });
    const noCode = dcb.allocate('chat', { totalBudget: 8000, hasCode: false });
    if (noCode.code >= withCode.code) throw new Error('hasCode=false should reduce code budget');
    if (noCode.conversation <= withCode.conversation) throw new Error('hasCode=false should increase conversation');
  });

  test('activeGoals boosts memory allocation', () => {
    const dcb = makeBudget();
    const noGoals = dcb.allocate('chat', { totalBudget: 8000, activeGoals: 0 });
    const withGoals = dcb.allocate('chat', { totalBudget: 8000, activeGoals: 3 });
    if (withGoals.memory <= noGoals.memory) throw new Error('Active goals should boost memory');
  });

  test('system slot has minimum of 200', () => {
    const dcb = makeBudget();
    const budgets = dcb.allocate('chat', { totalBudget: 500 });
    if (budgets.system < 200) throw new Error(`System should be >= 200, got ${budgets.system}`);
  });

  test('reserved slot has minimum of 100', () => {
    const dcb = makeBudget();
    const budgets = dcb.allocate('chat', { totalBudget: 500 });
    if (budgets.reserved < 100) throw new Error(`Reserved should be >= 100, got ${budgets.reserved}`);
  });

  test('stats track allocation count', () => {
    const dcb = makeBudget();
    dcb.allocate('chat');
    dcb.allocate('code-gen');
    dcb.allocate('analysis');
    const stats = dcb.getStats();
    if (stats.allocations !== 3) throw new Error(`Expected 3 allocations, got ${stats.allocations}`);
  });

  test('DEFAULT_PROFILES has expected intents', () => {
    const expected = ['code-gen', 'self-modify', 'analysis', 'chat', 'planning', 'reasoning', 'research', 'general'];
    for (const intent of expected) {
      if (!DEFAULT_PROFILES[intent]) throw new Error(`Missing default profile: ${intent}`);
    }
  });

  test('all default profiles sum to ~1.0', () => {
    for (const [name, profile] of Object.entries(DEFAULT_PROFILES)) {
      const sum = Object.values(profile).reduce((a, b) => a + b, 0);
      if (Math.abs(sum - 1.0) > 0.01) throw new Error(`Profile ${name} sums to ${sum}, should be ~1.0`);
    }
  });

  test('recordOutcome does not crash', () => {
    const dcb = makeBudget();
    dcb.recordOutcome('chat', { system: 500, conversation: 2000 }, true, {});
    dcb.recordOutcome('code-gen', { code: 5000 }, false, { truncated: ['code'] });
    // No assertions — just verify no crash
  });

  test('getProfiles returns all profiles', () => {
    const dcb = makeBudget();
    const profiles = dcb.getProfiles();
    if (typeof profiles !== 'object') throw new Error('Should return object');
    if (!profiles['chat']) throw new Error('Should include chat profile');
  });
});

if (require.main === module) run();
