// ============================================================
// Test: v6.0.5 — Smart Model Ranking + First-Run UX
// ============================================================

const { describe, test, assert, assertEqual, run } = require('../harness');

// ── Mock ModelBridge for ranking tests ───────────────────
// We test _scoreModel and _selectBestModel directly via the class.

const { ModelBridge } = require('../../src/agent/foundation/ModelBridge');

function mockBus() {
  return { on() { return () => {}; }, emit() {}, fire() {} };
}

function makeBridge() {
  // ModelBridge constructor needs bus + backends — use minimal mocks
  const mb = Object.create(ModelBridge.prototype);
  mb.bus = mockBus();
  mb.availableModels = [];
  mb.activeModel = null;
  mb.activeBackend = null;
  return mb;
}

// ═══════════════════════════════════════════════════════════
// Model Scoring
// ═══════════════════════════════════════════════════════════

describe('ModelBridge — Smart Model Ranking', () => {
  test('_scoreModel scores Claude highest', () => {
    const mb = makeBridge();
    const score = mb._scoreModel('claude-3.5-sonnet');
    assertEqual(score, 100);
  });

  test('_scoreModel scores GPT-4o high', () => {
    const mb = makeBridge();
    assert(mb._scoreModel('gpt-4o') >= 90, 'GPT-4o should be tier 1');
  });

  test('_scoreModel scores Qwen 2.5 large high', () => {
    const mb = makeBridge();
    assert(mb._scoreModel('qwen2.5:72b') >= 85, 'Qwen 72b should be tier 1');
  });

  test('_scoreModel scores kimi-k2 high', () => {
    const mb = makeBridge();
    assert(mb._scoreModel('kimi-k2.5:cloud') >= 85, 'kimi-k2 should be tier 1');
  });

  test('_scoreModel scores Qwen 2.5 7b as tier 2', () => {
    const mb = makeBridge();
    const score = mb._scoreModel('qwen2.5:7b');
    assert(score >= 70 && score < 90, `Qwen 7b should be tier 2, got ${score}`);
  });

  test('_scoreModel scores minimax LOW', () => {
    const mb = makeBridge();
    const score = mb._scoreModel('minimax-m2.7:cloud');
    assert(score < 30, `minimax should be low tier, got ${score}`);
  });

  test('_scoreModel gives unknown models neutral score', () => {
    const mb = makeBridge();
    assertEqual(mb._scoreModel('totally-unknown-model:latest'), 50);
  });

  test('_scoreModel scores deepseek-coder high', () => {
    const mb = makeBridge();
    assert(mb._scoreModel('deepseek-coder:33b') >= 90, 'deepseek-coder should be tier 1');
  });

  test('_scoreModel scores Llama 3 8B as tier 2', () => {
    const mb = makeBridge();
    const score = mb._scoreModel('llama3:8b');
    assert(score >= 70 && score < 90, `Llama 3 8b should be tier 2, got ${score}`);
  });

  test('_scoreModel scores tinyllama low', () => {
    const mb = makeBridge();
    assert(mb._scoreModel('tinyllama:latest') < 50, 'tinyllama should be tier 3');
  });
});

describe('ModelBridge — _selectBestModel', () => {
  test('selects highest-scored model', () => {
    const mb = makeBridge();
    const models = [
      { name: 'minimax-m2.7:cloud', backend: 'ollama' },
      { name: 'kimi-k2.5:cloud', backend: 'ollama' },
      { name: 'qwen2.5:7b', backend: 'ollama' },
    ];
    const best = mb._selectBestModel(models);
    assertEqual(best.name, 'kimi-k2.5:cloud');
  });

  test('selects larger Qwen over smaller', () => {
    const mb = makeBridge();
    const models = [
      { name: 'qwen2.5:7b', backend: 'ollama' },
      { name: 'qwen2.5:72b', backend: 'ollama' },
    ];
    const best = mb._selectBestModel(models);
    assertEqual(best.name, 'qwen2.5:72b');
  });

  test('returns null for empty list', () => {
    const mb = makeBridge();
    assertEqual(mb._selectBestModel([]), null);
  });

  test('handles single model', () => {
    const mb = makeBridge();
    const models = [{ name: 'minimax-m2.7:cloud', backend: 'ollama' }];
    const best = mb._selectBestModel(models);
    assertEqual(best.name, 'minimax-m2.7:cloud');
  });

  test('prefers known good over unknown', () => {
    const mb = makeBridge();
    const models = [
      { name: 'mystery-model:latest', backend: 'ollama' }, // score 50
      { name: 'llama3:8b', backend: 'ollama' },            // score ~78
    ];
    const best = mb._selectBestModel(models);
    assertEqual(best.name, 'llama3:8b');
  });

  test('unknown model beats known weak', () => {
    const mb = makeBridge();
    const models = [
      { name: 'minimax-m2.7:cloud', backend: 'ollama' }, // score 15
      { name: 'mystery-model:latest', backend: 'ollama' }, // score 50
    ];
    const best = mb._selectBestModel(models);
    assertEqual(best.name, 'mystery-model:latest');
  });
});

describe('ModelBridge — getRankedModels', () => {
  test('returns sorted list with scores', () => {
    const mb = makeBridge();
    mb.availableModels = [
      { name: 'minimax-m2.7:cloud', backend: 'ollama' },
      { name: 'kimi-k2.5:cloud', backend: 'ollama' },
      { name: 'qwen2.5:7b', backend: 'ollama' },
    ];
    mb.activeModel = 'kimi-k2.5:cloud';
    const ranked = mb.getRankedModels();

    // Should be sorted by score descending
    assertEqual(ranked[0].name, 'kimi-k2.5:cloud');
    assert(ranked[0].score > ranked[1].score, 'first should have highest score');
    assertEqual(ranked[ranked.length - 1].name, 'minimax-m2.7:cloud');

    // Active marker
    assert(ranked[0].active, 'active model should be marked');
    assert(!ranked[1].active, 'inactive model should not be marked');
  });

  test('includes note for known models', () => {
    const mb = makeBridge();
    mb.availableModels = [{ name: 'minimax-m2.7:cloud', backend: 'ollama' }];
    mb.activeModel = null;
    const ranked = mb.getRankedModels();
    assert(ranked[0].note.includes('MiniMax'), 'should have descriptive note');
  });
});

// ═══════════════════════════════════════════════════════════
// IntentRouter — Code-Gen Guard
// ═══════════════════════════════════════════════════════════

const { IntentRouter } = require('../../src/agent/intelligence/IntentRouter');

describe('IntentRouter — Code-Gen Guard', () => {
  function makeRouter() {
    return new IntentRouter({ bus: mockBus() });
  }

  test('"Write a function" → general, not create-skill', () => {
    const r = makeRouter();
    const result = r.classify('Write a JavaScript function fizzbuzz(n) that returns an array');
    assertEqual(result.type, 'general');
    assert(result.confidence >= 0.9, `confidence should be high, got ${result.confidence}`);
  });

  test('"Create a class" → general', () => {
    const r = makeRouter();
    const result = r.classify('Create a class RateLimiter with constructor');
    assertEqual(result.type, 'general');
  });

  test('"Implement an API endpoint" → general', () => {
    const r = makeRouter();
    const result = r.classify('Implement an Express API endpoint for user authentication');
    assertEqual(result.type, 'general');
  });

  test('"Erstelle eine Funktion" → general', () => {
    const r = makeRouter();
    const result = r.classify('Erstelle eine Funktion die Primzahlen berechnet');
    assertEqual(result.type, 'general');
  });

  test('"Schreib mir eine Klasse" → general', () => {
    const r = makeRouter();
    const result = r.classify('Schreib mir eine Klasse für Datenbankverbindungen');
    assertEqual(result.type, 'general');
  });

  test('"Generate a component" → general', () => {
    const r = makeRouter();
    const result = r.classify('Generate a React component for a login form');
    assertEqual(result.type, 'general');
  });

  test('"Build me a server" → general', () => {
    const r = makeRouter();
    const result = r.classify('Build me a simple HTTP server in Node.js');
    assertEqual(result.type, 'general');
  });

  test('"Create a skill" still routes to create-skill', () => {
    const r = makeRouter();
    const result = r.classify('Create a skill for web scraping');
    assertEqual(result.type, 'create-skill');
  });

  test('"Erstell einen Skill" still routes to create-skill', () => {
    const r = makeRouter();
    const result = r.classify('Erstell einen Skill zum Web-Scraping');
    assertEqual(result.type, 'create-skill');
  });
});

// ═══════════════════════════════════════════════════════════

if (require.main === module) run();
