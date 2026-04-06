// Test: v6.1.1 Coverage Sweep Part 2 — Intelligence + Learning
// Targets: ReasoningEngine, LearningService, PromptEvolution

const { describe, test, assert, assertEqual, run } = require('../harness');

function mockBus() {
  const emitted = [];
  return {
    on: () => () => {}, off() {},
    emit(evt, data) { emitted.push({ evt, data }); },
    fire(evt, data) { this.emit(evt, data); },
    _emitted: emitted,
  };
}

// ── ReasoningEngine ─────────────────────────────────────────

describe('ReasoningEngine — complexity assessment', () => {
  const { ReasoningEngine } = require('../../src/agent/intelligence/ReasoningEngine');

  function createEngine() {
    return new ReasoningEngine(
      { chat: async (prompt, history, type) => 'LLM answer' },
      { build: (t, d) => `prompt:${t}`, focusCode: (c) => c },
      {
        hasTool: (n) => n === 'search' || n === 'file-read',
        execute: async (name, input) => ({ result: 'tool result' }),
        listTools: () => [{ name: 'search', description: 'search files' }],
      },
      mockBus(),
    );
  }

  test('short factual question → direct', () => {
    const e = createEngine();
    const r = e._assessComplexity('Was ist JavaScript?', {});
    assertEqual(r.strategy, 'direct');
    assertEqual(r.level, 1);
  });

  test('code block → direct', () => {
    const e = createEngine();
    const r = e._assessComplexity('Führe aus: ```console.log(1)```', {});
    assertEqual(r.strategy, 'direct');
  });

  test('self-modification → decompose', () => {
    const e = createEngine();
    const r = e._assessComplexity('Modifiziere die EventBus Klasse', {});
    assertEqual(r.strategy, 'decompose');
    assertEqual(r.level, 3);
  });

  test('analysis question → chain-of-thought', () => {
    const e = createEngine();
    const r = e._assessComplexity('Analysiere die Architektur des Projekts', {});
    assertEqual(r.strategy, 'chain-of-thought');
  });

  test('multi-part request → decompose', () => {
    const e = createEngine();
    const r = e._assessComplexity('Erstens erstelle die Datei und dann teste sie außerdem deploy', {});
    assertEqual(r.strategy, 'decompose');
  });

  test('search request → research', () => {
    const e = createEngine();
    const r = e._assessComplexity('Suche nach best practices für error handling', {});
    assertEqual(r.strategy, 'research');
  });

  test('medium length generic → direct or chain-of-thought', () => {
    const e = createEngine();
    const r = e._assessComplexity('Tell me about this thing', {});
    assertEqual(r.strategy, 'direct');
  });

  test('long generic → chain-of-thought', () => {
    const e = createEngine();
    const long = 'Explain ' + 'word '.repeat(35);
    const r = e._assessComplexity(long, {});
    assertEqual(r.strategy, 'chain-of-thought');
  });
});

describe('ReasoningEngine — tool detection', () => {
  const { ReasoningEngine } = require('../../src/agent/intelligence/ReasoningEngine');

  function createEngine() {
    return new ReasoningEngine(
      { chat: async () => 'answer' }, {},
      { hasTool: (n) => ['search', 'file-read', 'system-info', 'sandbox'].includes(n), execute: async () => ({}), listTools: () => [] },
      mockBus(),
    );
  }

  test('detects system-info tool need', () => {
    const e = createEngine();
    const r = e._detectToolNeed('Show me system info about CPU');
    assert(r !== null, 'should detect tool need');
    assertEqual(r.tool, 'system-info');
  });

  test('detects file-read tool need', () => {
    const e = createEngine();
    const r = e._detectToolNeed('Datei lesen bitte');
    assert(r !== null, 'should detect file-read');
    assertEqual(r.tool, 'file-read');
  });

  test('detects search tool need', () => {
    const e = createEngine();
    const r = e._detectToolNeed('suche nach dem Bug');
    assert(r !== null, 'should detect search');
    assertEqual(r.tool, 'search');
  });

  test('returns null for no tool need', () => {
    const e = createEngine();
    const r = e._detectToolNeed('hello world');
    assert(r === null, 'should return null');
  });

  test('returns null with no tool registry', () => {
    const e = new ReasoningEngine({ chat: async () => '' }, {}, null, mockBus());
    const r = e._detectToolNeed('system info');
    assert(r === null, 'should return null without tools');
  });
});

describe('ReasoningEngine — helpers', () => {
  const { ReasoningEngine } = require('../../src/agent/intelligence/ReasoningEngine');

  test('_buildContextualPrompt builds prompt with memory', () => {
    const e = new ReasoningEngine({}, {}, null, mockBus());
    const prompt = e._buildContextualPrompt('test task', {
      memory: { buildContext: () => 'memory context' },
      selfModel: { getCapabilities: () => ['code', 'analyze'] },
    });
    assert(prompt.includes('Genesis'), 'should contain Genesis');
    assert(prompt.includes('memory context'), 'should contain memory');
    assert(prompt.includes('code'), 'should contain capabilities');
  });

  test('_buildContextualPrompt works without context', () => {
    const e = new ReasoningEngine({}, {}, null, mockBus());
    const prompt = e._buildContextualPrompt('test', {});
    assert(prompt.includes('Genesis'), 'should contain Genesis');
  });

  test('_parseSubTasks extracts numbered items', () => {
    const e = new ReasoningEngine({}, {}, null, mockBus());
    const tasks = e._parseSubTasks('1. Create the file\n2. Write tests\n3. Deploy it');
    assertEqual(tasks.length, 3);
    assert(tasks[0].includes('Create'), 'should extract task text');
  });

  test('_parseSubTasks filters short lines', () => {
    const e = new ReasoningEngine({}, {}, null, mockBus());
    const tasks = e._parseSubTasks('1. Do it\n2. x\n# Header\n3. Another longer task');
    assert(tasks.length <= 2, 'should filter short lines and headers');
  });

  test('_isToolRelevant checks keyword overlap', () => {
    const e = new ReasoningEngine({}, {}, null, mockBus());
    assert(e._isToolRelevant({ name: 'search', description: 'search files' }, 'search for bug'), 'should match');
    assert(!e._isToolRelevant({ name: 'deploy', description: 'deploy app' }, 'hello world'), 'should not match');
  });

  test('_callTool returns null without registry', async () => {
    const e = new ReasoningEngine({}, {}, null, mockBus());
    const r = await e._callTool('test', {});
    assert(r === null, 'should return null');
  });

  test('_directAnswer returns structured result', async () => {
    const e = new ReasoningEngine({ chat: async () => 'direct answer' }, {}, null, mockBus());
    const r = await e._directAnswer('question', {});
    assertEqual(r.answer, 'direct answer');
    assertEqual(r.reasoning.strategy, 'direct');
    assertEqual(r.toolsUsed.length, 0);
  });
});

// ── LearningService ─────────────────────────────────────────

describe('LearningService — learning pipeline', () => {
  const { LearningService } = require('../../src/agent/hexagonal/LearningService');

  function createService() {
    const bus = mockBus();
    return new LearningService({
      bus,
      memory: {
        learnFact: (k, v, c, s) => {},
        learnPattern: (t, a, s) => {},
      },
      knowledgeGraph: {
        learnFromText: (t, s) => {},
        addNode: (type, label, data) => {},
      },
      eventStore: { append: (type, payload, source) => {} },
      storageDir: null,
      intervals: null,
      storage: null,
    });
  }

  test('constructor initializes metrics', () => {
    const svc = createService();
    assert(typeof svc._metrics.intents === 'object', 'should have intents');
    assert(typeof svc._metrics.toolUsage === 'object', 'should have toolUsage');
    assert(Array.isArray(svc._metrics.errorPatterns), 'should have errorPatterns');
  });

  test('_extractFacts extracts German name', () => {
    const facts = {};
    const svc = createService();
    svc.memory = { learnFact: (k, v) => { facts[k] = v; }, learnPattern: () => {} };
    svc._extractFacts('ich heisse Garrus');
    assertEqual(facts['user.name'], 'Garrus');
  });

  test('_extractFacts extracts English name', () => {
    const facts = {};
    const svc = createService();
    svc.memory = { learnFact: (k, v) => { facts[k] = v; }, learnPattern: () => {} };
    svc._extractFacts('my name is Daniel');
    assertEqual(facts['user.name'], 'Daniel');
  });

  test('_extractPreferences stores implicit preference', () => {
    let stored = null;
    const svc = createService();
    svc.memory = { learnFact: (k, v, c, s) => { stored = { k, v, s }; }, learnPattern: () => {} };
    svc._extractPreferences('Ich bevorzuge TypeScript');
    assert(stored !== null, 'should store preference');
    assertEqual(stored.s, 'implicit-preference');
  });

  test('_recordIntentOutcome tracks success', () => {
    const svc = createService();
    svc._recordIntentOutcome('code', true);
    svc._recordIntentOutcome('code', true);
    svc._recordIntentOutcome('code', false);
    assertEqual(svc._metrics.intents.code.total, 3);
    assertEqual(svc._metrics.intents.code.success, 2);
    assertEqual(svc._metrics.intents.code.fail, 1);
  });

  test('_recordIntentOutcome ignores null intent', () => {
    const svc = createService();
    svc._recordIntentOutcome(null, true);
    assertEqual(Object.keys(svc._metrics.intents).length, 0);
  });

  test('_trackToolUsage records tool calls', () => {
    const svc = createService();
    svc._trackToolUsage({ name: 'shell', success: true });
    svc._trackToolUsage({ name: 'shell', success: false });
    assertEqual(svc._metrics.toolUsage.shell.calls, 2);
    assertEqual(svc._metrics.toolUsage.shell.successes, 1);
    assertEqual(svc._metrics.toolUsage.shell.failures, 1);
  });

  test('_trackIntentSequence builds sequence', () => {
    const svc = createService();
    svc._trackIntentSequence('code');
    svc._trackIntentSequence('analyze');
    svc._trackIntentSequence('code');
    assertEqual(svc._recentIntentSequence.length, 3);
  });

  test('_learnFromChat processes full pipeline', () => {
    const svc = createService();
    svc._learnFromChat({
      message: 'my name is Test',
      response: 'Hello Test!',
      intent: 'chat',
      success: true,
    });
    assertEqual(svc._metrics.intents.chat.total, 1);
    assertEqual(svc._recentIntentSequence.length, 1);
  });

  test('_learnFromChat handles missing message gracefully', () => {
    const svc = createService();
    svc._learnFromChat({ message: null, response: 'x', intent: 'chat', success: true });
    // Should not throw
    assert(true, 'should handle null message');
  });

  test('start and stop lifecycle', () => {
    const svc = createService();
    svc.start();
    svc.stop();
    assert(true, 'start/stop should not throw');
  });
});

// ── PromptEvolution ─────────────────────────────────────────

describe('PromptEvolution — variant management', () => {
  const { PromptEvolution } = require('../../src/agent/intelligence/PromptEvolution');

  function createEvolution() {
    return new PromptEvolution({
      bus: mockBus(),
      storage: null,
      metaLearning: null,
    });
  }

  test('constructor initializes state', () => {
    const pe = createEvolution();
    assert(pe._sections !== undefined || pe._variants !== undefined || pe._experiments !== undefined, 'should have internal state');
  });

  test('getSection returns default when no variant', () => {
    const pe = createEvolution();
    const result = pe.getSection('unknown-section', 'default text');
    assertEqual(result.text, 'default text');
    assert(result.variantId === null, 'variantId should be null');
  });

  test('getStatus returns overview', () => {
    const pe = createEvolution();
    const status = pe.getStatus();
    assert(typeof status === 'object', 'should return object');
  });

  test('setEnabled toggles state', () => {
    const pe = createEvolution();
    pe.setEnabled(false);
    pe.setEnabled(true);
    assert(true, 'should toggle without error');
  });

  test('buildPromptContext returns string', () => {
    const pe = createEvolution();
    const ctx = pe.buildPromptContext();
    assert(typeof ctx === 'string', 'should return string');
  });

  test('recordOutcome with unknown section is safe', () => {
    const pe = createEvolution();
    pe.recordOutcome('nonexistent', 'v1', true);
    assert(true, 'should not throw for unknown section');
  });

  test('stop is safe', () => {
    const pe = createEvolution();
    pe.stop();
    assert(true, 'stop should not throw');
  });
});

run();
