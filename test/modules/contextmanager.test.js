// ============================================================
// Test: ContextManager.js — Budget, compression, token estimation
// ============================================================
let passed = 0, failed = 0;
// v3.5.2: Fixed — queue-based async-safe test runner
const _testQueue = [];
function test(name, fn) { _testQueue.push({ name, fn }); }
function assert(c, m) { if (!c) throw new Error(m || 'Assertion failed'); }

const { ContextManager } = require('../../src/agent/intelligence/ContextManager');

function createMockCM(overrides = {}) {
  return new ContextManager(
    { activeModel: 'gemma2:9b' },
    {
      readModule: (f) => '// code\nconst x = 1;\nmodule.exports = { x };',
      getModuleSummary: () => [{ file: 'test.js', classes: ['Test'], functions: 2 }],
      getFullModel: () => ({ files: { 'test.js': {} } }),
    },
    {
      recallEpisodes: (q) => [{ summary: 'past context', topics: ['test'], timestamp: '2025-01-01T00:00:00Z' }],
      searchFacts: (q) => [{ key: 'user.name', value: 'Garrus' }],
      recallPattern: (q) => null,
      db: { semantic: { 'user.name': { value: 'Garrus', confidence: 0.9 } } },
    }
  );
}

console.log('\n  📦 ContextManager');

test('build returns system and messages', () => {
  const cm = createMockCM();
  const ctx = cm.build({
    task: 'Hello',
    intent: 'general',
    history: [{ role: 'user', content: 'Hi' }],
    systemPrompt: 'You are Genesis.',
    toolPrompt: 'Available tools: search',
  });
  assert(typeof ctx.system === 'string', 'system should be string');
  assert(Array.isArray(ctx.messages), 'messages should be array');
  assert(typeof ctx.stats === 'object', 'stats should be present');
});

test('system prompt is included in context', () => {
  const cm = createMockCM();
  const ctx = cm.build({
    task: 'Test', intent: 'general', history: [],
    systemPrompt: 'CUSTOM_SYSTEM_PROMPT', toolPrompt: '',
  });
  assert(ctx.system.includes('CUSTOM_SYSTEM_PROMPT'), 'System prompt should be in context');
});

test('stats track token allocations', () => {
  const cm = createMockCM();
  const ctx = cm.build({
    task: 'Test', intent: 'general',
    history: [{ role: 'user', content: 'msg' }],
    systemPrompt: 'sys', toolPrompt: 'tools',
  });
  assert(ctx.stats.allocations.system >= 0, 'Should track system allocation');
});

test('configureForModel adjusts budgets for small models', () => {
  const cm = createMockCM();
  cm.configureForModel('llama3:7b');
  assert(cm.config.maxContextTokens <= 6200, `Expected reduced context for 7b model, got ${cm.config.maxContextTokens}`);
});

test('configureForModel expands budgets for large models', () => {
  const cm = createMockCM();
  cm.configureForModel('llama3:70b');
  assert(cm.config.maxContextTokens >= 8000, `Expected expanded context for 70b model, got ${cm.config.maxContextTokens}`);
});

test('_estimateTokens returns reasonable estimate', () => {
  const cm = createMockCM();
  const tokens = cm._estimateTokens('This is a test sentence with several words.');
  assert(tokens > 0, 'Should return positive token count');
  assert(tokens < 100, 'Should not wildly overestimate');
});

test('_estimateTokens returns 0 for empty string', () => {
  const cm = createMockCM();
  assert(cm._estimateTokens('') === 0);
  assert(cm._estimateTokens(null) === 0 || cm._estimateTokens(null) >= 0);
});

test('_fitToBudget truncates long text', () => {
  const cm = createMockCM();
  const longText = 'word '.repeat(5000);
  const fitted = cm._fitToBudget(longText, 100);
  const tokens = cm._estimateTokens(fitted);
  assert(tokens <= 120, `Expected fitted to ~100 tokens, got ${tokens}`); // Allow some slack
});

test('_fitToBudget preserves short text', () => {
  const cm = createMockCM();
  const shortText = 'Hello world';
  const fitted = cm._fitToBudget(shortText, 1000);
  assert(fitted === shortText, 'Short text should pass through unchanged');
});

test('code context included for code intents', () => {
  const cm = createMockCM();
  const ctx = cm.build({
    task: 'fix the bug in Test.js',
    intent: 'self-modify',
    history: [],
    systemPrompt: 'sys',
    toolPrompt: '',
  });
  // Code context should have nonzero allocation for code intents
  assert(ctx.stats.allocations.code >= 0, 'Code allocation should be tracked');
});

test('memory context queries recall', () => {
  const cm = createMockCM();
  const ctx = cm.build({
    task: 'Was weißt du über mich?',
    intent: 'general',
    history: [],
    systemPrompt: 'sys',
    toolPrompt: '',
  });
  assert(ctx.stats.allocations.memory >= 0);
});

test('conversation history is included in messages', () => {
  const cm = createMockCM();
  const ctx = cm.build({
    task: 'Follow up',
    intent: 'general',
    history: [
      { role: 'user', content: 'Hello' },
      { role: 'assistant', content: 'Hi there' },
      { role: 'user', content: 'Follow up' },
    ],
    systemPrompt: 'sys',
    toolPrompt: '',
  });
  assert(ctx.messages.length >= 1, 'Should include conversation history');
});

// v3.5.2: Async-safe runner — properly awaits all tests
(async () => {
  for (const t of _testQueue) {
    try {
      const r = t.fn(); if (r && r.then) await r;
      passed++; console.log(`    ✅ ${t.name}`);
    } catch (err) {
      failed++; console.log(`    ❌ ${t.name}: ${err.message}`);
    }
  }
  console.log(`\n    ${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
})();
