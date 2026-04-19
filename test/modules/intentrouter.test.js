// Test: IntentRouter.js — online learning from LLM fallbacks
let passed = 0, failed = 0;
// v3.5.2: Fixed — queue-based async-safe test runner
const _testQueue = [];
function test(name, fn) { _testQueue.push({ name, fn }); }
function assert(c, m) { if (!c) throw new Error(m || 'Assertion failed'); }

const { IntentRouter } = require('../../src/agent/intelligence/IntentRouter');

console.log('\n  📦 IntentRouter Online Learning');

test('classifies known intents via regex', () => {
  const r = new IntentRouter();
  // v7.3.3: "Architektur" alone no longer triggers self-inspect —
  // that's a conversational question, goes to general (LLM). Only
  // explicit "show modules / list source" imperatives trigger self-inspect.
  const result = r.classify('zeig mir deine module');
  assert(result.type === 'self-inspect', `Expected self-inspect, got ${result.type}`);
  assert(result.confidence >= 0.9, 'High confidence for regex match');
});

test('classifies greeting correctly', () => {
  const r = new IntentRouter();
  const result = r.classify('Hallo!');
  assert(result.type === 'greeting', `Expected greeting, got ${result.type}`);
});

test('returns general for unknown input', () => {
  const r = new IntentRouter();
  const result = r.classify('xyz abc 123');
  assert(result.type === 'general', `Expected general, got ${result.type}`);
});

test('shell-task patterns are merged (no duplicates)', () => {
  const r = new IntentRouter();
  const shellRoutes = r.routes.filter(rt => rt.name === 'shell-task');
  assert(shellRoutes.length === 1, `Expected 1 shell-task route, got ${shellRoutes.length}`);
  assert(shellRoutes[0].patterns.length >= 10, 'Merged route has all patterns');
});

test('_learnFromLLMResult accumulates fallback data', () => {
  const r = new IntentRouter();
  // Simulate 5 LLM fallbacks for same intent
  for (let i = 0; i < 5; i++) {
    r._learnFromLLMResult(`analysiere die performance von modul ${i}`, 'analyze-code');
  }
  assert(r._llmFallbackLog.length === 5, 'Logged 5 fallbacks');
});

test('learns new keywords after threshold', () => {
  const r = new IntentRouter();
  const route = r.routes.find(rt => rt.name === 'analyze-code');
  const kwBefore = route.keywords.length;

  // Simulate 5 messages with common word "performance"
  for (let i = 0; i < 5; i++) {
    r._learnFromLLMResult(`pruefe die performance des systems teil ${i}`, 'analyze-code');
  }

  const kwAfter = route.keywords.length;
  assert(kwAfter > kwBefore, `Expected new keywords: before=${kwBefore}, after=${kwAfter}`);
});

test('getLearnedPatterns returns learned data', () => {
  const r = new IntentRouter();
  for (let i = 0; i < 5; i++) {
    r._learnFromLLMResult(`teste die api verbindung zu server ${i}`, 'web-lookup');
  }
  const learned = r.getLearnedPatterns();
  assert(Object.keys(learned).length > 0, 'Has learned patterns');
});

test('importLearnedPatterns restores keywords', () => {
  const r = new IntentRouter();
  r.importLearnedPatterns({ 'greeting': ['moinsen', 'gruezi'] });
  const route = r.routes.find(rt => rt.name === 'greeting');
  assert(route.keywords.includes('moinsen'), 'Imported keyword present');
  assert(route.keywords.includes('gruezi'), 'Imported keyword present');
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
