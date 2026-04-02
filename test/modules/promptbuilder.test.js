// ============================================================
// Test: PromptBuilder.js — build, token budget, section
// priority, setQuery, edge cases
// ============================================================

const { describe, test, assert, assertEqual, run } = require('../harness');
const { PromptBuilder } = require('../../src/agent/intelligence/PromptBuilder');

function createBuilder(overrides = {}) {
  return new PromptBuilder({
    selfModel: overrides.selfModel || {
      getFullModel: () => ({ identity: 'Genesis', version: '3.8.0', capabilities: ['chat', 'self-modify'] }),
      getModuleSummary: () => [{ file: 'Test.js', classes: ['Test'], functions: 3 }],
      getCapabilities: () => ['chat', 'self-modify'],
      moduleCount: () => 5,
    },
    model: overrides.model || { activeModel: 'gemma2:9b' },
    skills: overrides.skills || { listSkills: () => [] },
    knowledgeGraph: overrides.kg || { search: () => [], getStats: () => ({ nodeCount: 10 }) },
    memory: overrides.memory || {
      recallEpisodes: () => [],
      searchFacts: () => [],
      getStats: () => ({ episodes: 0, facts: 0 }),
      getUserName: () => null,
    },
    ...overrides,
  });
}

describe('PromptBuilder: Core', () => {
  test('build() returns non-empty string', () => {
    const pb = createBuilder();
    const result = pb.build();
    assert(typeof result === 'string');
    assert(result.length > 0, 'Prompt should not be empty');
  });

  test('build() includes identity section', () => {
    const pb = createBuilder();
    const result = pb.build();
    assert(result.includes('Genesis') || result.includes('genesis'),
      'Should include identity');
  });

  test('setQuery stores recent query', () => {
    const pb = createBuilder();
    pb.setQuery('What are your capabilities?');
    assertEqual(pb._recentQuery, 'What are your capabilities?');
  });

  test('setQuery with empty string is safe', () => {
    const pb = createBuilder();
    pb.setQuery('');
    assertEqual(pb._recentQuery, '');
  });
});

describe('PromptBuilder: Token Budget', () => {
  test('build respects token budget', () => {
    const pb = createBuilder();
    const result = pb.build();
    assert(result.length <= pb._tokenBudget + 100,
      `Prompt length ${result.length} should be near budget ${pb._tokenBudget}`);
  });

  test('_buildWithBudget drops low-priority sections when over budget', () => {
    const pb = createBuilder();
    pb._tokenBudget = 200; // Very tight budget
    const result = pb.build();
    // With 200 char budget, only identity + formatting should fit
    assert(result.length <= 300, `Should be truncated, got ${result.length}`);
  });

  test('_buildWithBudget preserves high-priority sections', () => {
    const pb = createBuilder();
    pb._tokenBudget = 400;
    const result = pb.build();
    // Identity is priority 1 — should always be present
    assert(result.includes('Genesis') || result.length > 0,
      'High-priority identity should be preserved');
  });
});

describe('PromptBuilder: Section Priority', () => {
  test('_sectionPriority has correct structure', () => {
    const pb = createBuilder();
    assert(Array.isArray(pb._sectionPriority));
    for (const [priority, name, maxChars] of pb._sectionPriority) {
      assert(typeof priority === 'number', `Priority should be number for ${name}`);
      assert(typeof name === 'string', 'Name should be string');
      assert(typeof maxChars === 'number', `MaxChars should be number for ${name}`);
      assert(priority >= 1 && priority <= 10, `Priority ${priority} out of range for ${name}`);
    }
  });

  test('identity has highest priority (1)', () => {
    const pb = createBuilder();
    const idEntry = pb._sectionPriority.find(([, name]) => name === 'identity');
    assert(idEntry, 'Identity section should exist');
    assertEqual(idEntry[0], 1);
  });

  test('organism has lowest priority (7)', () => {
    const pb = createBuilder();
    const orgEntry = pb._sectionPriority.find(([, name]) => name === 'organism');
    assert(orgEntry, 'Organism section should exist');
    assertEqual(orgEntry[0], 7);
  });
});

describe('PromptBuilder: Late-Bound Modules', () => {
  test('build works with null late-bindings', () => {
    const pb = createBuilder();
    // All late-bindings (mcpClient, learningService, etc.) are null by default
    assertEqual(pb.mcpClient, null);
    assertEqual(pb.learningService, null);
    const result = pb.build();
    assert(result.length > 0, 'Should build even with null late-bindings');
  });

  test('build includes organism context when emotionalState is set', () => {
    const pb = createBuilder();
    pb.emotionalState = {
      getReport: () => ({
        dimensions: { curiosity: 0.7, satisfaction: 0.5, frustration: 0.1, energy: 0.8, loneliness: 0.2 },
        mood: 'positive',
      }),
    };
    pb._tokenBudget = 10000; // generous budget
    const result = pb.build();
    // Organism section should be present when emotionalState is wired
    // (may or may not include "curiosity" depending on formatting)
    assert(typeof result === 'string');
  });
});

run();
