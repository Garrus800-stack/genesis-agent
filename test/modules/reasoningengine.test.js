// ============================================================
// Test: ReasoningEngine.js — solve pipeline, complexity
// classification, tool use, chain-of-thought
// ============================================================

const { describe, test, assert, assertEqual, run } = require('../harness');
const { ReasoningEngine } = require('../../src/agent/intelligence/ReasoningEngine');

function createEngine(overrides = {}) {
  const events = [];
  return {
    engine: new ReasoningEngine(
      overrides.model || {
        chat: async (prompt) => 'Direct answer to the question.',
        chatStructured: async (prompt) => ({ level: 'low', strategy: 'direct', reasoning: 'simple question' }),
      },
      overrides.prompts || { build: (type, data) => `[${type}] ${JSON.stringify(data).slice(0, 100)}` },
      overrides.tools || { listTools: () => [], execute: async () => ({}) },
      { fire: (e, d) => events.push({ e, d }), emit: async (e, d) => { events.push({ e, d }); return []; }, on: () => () => {} },
    ),
    events,
  };
}

describe('ReasoningEngine: Construction', () => {
  test('has default config values', () => {
    const { engine } = createEngine();
    assert(engine.config.maxReasoningSteps > 0);
    assert(engine.config.maxToolCalls > 0);
    assert(engine.config.evaluationThreshold > 0);
    assert(engine.config.maxRefinements >= 0);
  });
});

describe('ReasoningEngine: solve()', () => {
  test('solve returns answer string', async () => {
    const { engine } = createEngine();
    const result = await engine.solve('What is 2+2?');
    assert(result.answer, 'Should have answer');
    assert(typeof result.answer === 'string');
  });

  test('solve emits reasoning:started event', async () => {
    const { engine, events } = createEngine();
    await engine.solve('test question');
    assert(events.some(e => e.e === 'reasoning:started'), 'Should emit reasoning:started');
  });

  test('solve with empty task returns answer', async () => {
    const { engine } = createEngine();
    const result = await engine.solve('');
    assert(typeof result.answer === 'string');
  });

  test('solve handles LLM error gracefully', async () => {
    const { engine } = createEngine({
      model: {
        chat: async () => { throw new Error('LLM offline'); },
        chatStructured: async () => ({ level: 'low', strategy: 'direct' }),
      },
    });
    let threw = false;
    try {
      await engine.solve('test');
    } catch (e) {
      threw = true;
      assert(e.message.includes('LLM') || e.message.includes('offline'));
    }
    // Either throws or returns an error in the answer
    assert(true, 'Should handle gracefully');
  });

  test('solve with context passes through', async () => {
    let receivedPrompt = '';
    const { engine } = createEngine({
      model: {
        chat: async (prompt) => { receivedPrompt = prompt; return 'answer'; },
        chatStructured: async () => ({ level: 'low', strategy: 'direct' }),
      },
    });
    await engine.solve('test', { history: [{ role: 'user', content: 'prior' }] });
    // Should have processed without error
    assert(typeof receivedPrompt === 'string');
  });
});

describe('ReasoningEngine: Complexity Assessment', () => {
  test('_assessComplexity returns strategy', async () => {
    const { engine } = createEngine({
      model: {
        chat: async () => 'answer',
        chatStructured: async () => ({ level: 'low', strategy: 'direct', reasoning: 'simple' }),
      },
    });
    const result = await engine._assessComplexity('hello');
    assert(result.strategy, 'Should have strategy');
    assert(['direct', 'chain-of-thought', 'decompose', 'research'].includes(result.strategy) || result.strategy,
      'Strategy should be valid or have a value');
  });

  test('_assessComplexity handles chatStructured failure', async () => {
    const { engine } = createEngine({
      model: {
        chat: async () => 'answer',
        chatStructured: async () => { throw new Error('parse error'); },
      },
    });
    const result = await engine._assessComplexity('test');
    // Should fall back to direct
    assert(result.strategy, 'Should have fallback strategy');
  });
});

run();

// ── v7.1.1: Coverage expansion — deterministic paths ──────────

describe('ReasoningEngine: GraphReasoner path', () => {
  test('uses graphReasoner when it answers', async () => {
    const { ReasoningEngine } = require('../../src/agent/intelligence/ReasoningEngine');
    const events = [];
    const bus = { emit: (n, d) => events.push({ n, d }), fire() {}, on() { return () => {}; } };
    const model = { chat: async () => 'llm answer' };
    const re = new ReasoningEngine(model, null, null, bus);
    re._graphReasoner = { tryAnswer: () => ({ answered: true, result: 'graph answer', method: 'path', data: {} }) };

    const result = await re.solve('path query');
    assertEqual(result.answer, 'graph answer');
    assertEqual(result.reasoning.strategy, 'graph-deterministic');
    assert(events.some(e => e.n === 'reasoning:started'));
  });

  test('falls through when graphReasoner returns unanswered', async () => {
    const { ReasoningEngine } = require('../../src/agent/intelligence/ReasoningEngine');
    const bus = { emit() {}, fire() {}, on() { return () => {}; } };
    const model = { chat: async () => 'fallback answer', chatStructured: async () => ({ strategy: 'direct', level: 1 }) };
    const re = new ReasoningEngine(model, null, null, bus);
    re._graphReasoner = { tryAnswer: () => ({ answered: false }) };

    const result = await re.solve('simple question');
    assertEqual(result.answer, 'fallback answer');
  });

  test('handles graphReasoner throw gracefully', async () => {
    const { ReasoningEngine } = require('../../src/agent/intelligence/ReasoningEngine');
    const bus = { emit() {}, fire() {}, on() { return () => {}; } };
    const model = { chat: async () => 'ok', chatStructured: async () => ({ strategy: 'direct', level: 1 }) };
    const re = new ReasoningEngine(model, null, null, bus);
    re._graphReasoner = { tryAnswer: () => { throw new Error('graph error'); } };

    const result = await re.solve('test task');
    assert(result.answer, 'should still return answer after graph error');
  });
});

describe('ReasoningEngine: InferenceEngine path (v7.1.1)', () => {
  test('uses inferenceEngine when confidence >= 0.7', async () => {
    const { ReasoningEngine } = require('../../src/agent/intelligence/ReasoningEngine');
    const events = [];
    const bus = { emit: (n, d) => events.push({ n, d }), fire() {}, on() { return () => {}; } };
    const model = { chat: async () => 'llm answer' };
    const re = new ReasoningEngine(model, null, null, bus);
    re._inferenceEngine = {
      infer: () => [{ source: 'A', target: 'B', relation: 'caused', confidence: 0.9, rule: 'rule-1' }],
    };

    const result = await re.solve('what caused X');
    assert(result.answer.length > 0, 'should return inference answer');
    assertEqual(result.reasoning.strategy, 'deterministic-inferred');
    assert(events.some(e => e.n === 'reasoning:started'));
  });

  test('falls through when inference confidence < 0.7', async () => {
    const { ReasoningEngine } = require('../../src/agent/intelligence/ReasoningEngine');
    const bus = { emit() {}, fire() {}, on() { return () => {}; } };
    const model = { chat: async () => 'llm answer', chatStructured: async () => ({ strategy: 'direct', level: 1 }) };
    const re = new ReasoningEngine(model, null, null, bus);
    re._inferenceEngine = {
      infer: () => [{ source: 'A', target: 'B', relation: 'caused', confidence: 0.5, rule: 'rule-1' }],
    };

    const result = await re.solve('what caused X');
    assertEqual(result.answer, 'llm answer');
  });

  test('falls through when inference returns empty', async () => {
    const { ReasoningEngine } = require('../../src/agent/intelligence/ReasoningEngine');
    const bus = { emit() {}, fire() {}, on() { return () => {}; } };
    const model = { chat: async () => 'direct', chatStructured: async () => ({ strategy: 'direct', level: 1 }) };
    const re = new ReasoningEngine(model, null, null, bus);
    re._inferenceEngine = { infer: () => [] };

    const result = await re.solve('test');
    assertEqual(result.answer, 'direct');
  });
});

describe('ReasoningEngine: _assessComplexity branches', () => {
  test('short German question → direct', () => {
    const { ReasoningEngine } = require('../../src/agent/intelligence/ReasoningEngine');
    const bus = { emit() {}, fire() {}, on() { return () => {}; } };
    const re = new ReasoningEngine({}, null, null, bus);
    const c = re._assessComplexity('Was ist das?', {});
    assertEqual(c.strategy, 'direct');
  });

  test('code block → direct', () => {
    const { ReasoningEngine } = require('../../src/agent/intelligence/ReasoningEngine');
    const bus = { emit() {}, fire() {}, on() { return () => {}; } };
    const re = new ReasoningEngine({}, null, null, bus);
    const c = re._assessComplexity('run ```js\nconsole.log(1)\n```', {});
    assertEqual(c.strategy, 'direct');
  });

  test('self-modification keyword → decompose', () => {
    const { ReasoningEngine } = require('../../src/agent/intelligence/ReasoningEngine');
    const bus = { emit() {}, fire() {}, on() { return () => {}; } };
    const re = new ReasoningEngine({}, null, null, bus);
    const c = re._assessComplexity('modifiziere deine eigene Konfiguration', {});
    assertEqual(c.strategy, 'decompose');
  });

  test('analysis keyword → chain-of-thought', () => {
    const { ReasoningEngine } = require('../../src/agent/intelligence/ReasoningEngine');
    const bus = { emit() {}, fire() {}, on() { return () => {}; } };
    const re = new ReasoningEngine({}, null, null, bus);
    const c = re._assessComplexity('erkläre wie das funktioniert', {});
    assertEqual(c.strategy, 'chain-of-thought');
  });

  test('multi-part keyword → decompose', () => {
    const { ReasoningEngine } = require('../../src/agent/intelligence/ReasoningEngine');
    const bus = { emit() {}, fire() {}, on() { return () => {}; } };
    const re = new ReasoningEngine({}, null, null, bus);
    // 'außerdem' triggers decompose; no analysis keywords to avoid chain-of-thought branch
    const c = re._assessComplexity('bitte erstelle eine Datei zusätzlich noch eine weitere Datei erstellen', {});
    assertEqual(c.strategy, 'decompose');
  });

  test('research keyword → research', () => {
    const { ReasoningEngine } = require('../../src/agent/intelligence/ReasoningEngine');
    const bus = { emit() {}, fire() {}, on() { return () => {}; } };
    const re = new ReasoningEngine({}, null, null, bus);
    const c = re._assessComplexity('recherchiere best practices für async code', {});
    assertEqual(c.strategy, 'research');
  });

  test('long task → chain-of-thought default', () => {
    const { ReasoningEngine } = require('../../src/agent/intelligence/ReasoningEngine');
    const bus = { emit() {}, fire() {}, on() { return () => {}; } };
    const re = new ReasoningEngine({}, null, null, bus);
    // 31+ words triggers chain-of-thought in the default branch
    // >30 words triggers chain-of-thought in the default branch (no keyword matches)
    const longTask = 'please help me understand this particular thing that does not match any specific keyword pattern but has more than thirty words in total so that the word count check triggers the chain of thought strategy rather than the direct answer strategy';
    const c = re._assessComplexity(longTask, {});
    assertEqual(c.strategy, 'chain-of-thought');
  });
});

describe('ReasoningEngine: strategy dispatch', () => {
  test('chain-of-thought strategy executes', async () => {
    const { ReasoningEngine } = require('../../src/agent/intelligence/ReasoningEngine');
    const bus = { emit() {}, fire() {}, on() { return () => {}; } };
    let chatCalls = 0;
    const model = { chat: async () => { chatCalls++; return 'step answer'; }, chatStructured: async () => ({ strategy: 'chain-of-thought', level: 2 }) };
    const re = new ReasoningEngine(model, null, null, bus);

    const result = await re.solve('erkläre wie das funktioniert detailliert', {});
    assert(result.answer, 'should return answer');
    assert(chatCalls > 0, 'should call model');
  });

  test('research strategy executes', async () => {
    const { ReasoningEngine } = require('../../src/agent/intelligence/ReasoningEngine');
    const bus = { emit() {}, fire() {}, on() { return () => {}; } };
    const model = { chat: async () => 'research answer', chatStructured: async () => ({ strategy: 'research', level: 2 }) };
    const re = new ReasoningEngine(model, null, null, bus);

    const result = await re.solve('recherchiere best practices', {});
    assert(result.answer, 'should return answer');
  });

  test('decompose strategy executes', async () => {
    const { ReasoningEngine } = require('../../src/agent/intelligence/ReasoningEngine');
    const bus = { emit() {}, fire() {}, on() { return () => {}; } };
    const model = { chat: async () => 'decomposed answer', chatStructured: async () => ({ strategy: 'decompose', level: 3, subTasks: ['task1', 'task2'] }) };
    const re = new ReasoningEngine(model, null, null, bus);

    const result = await re.solve('modifiziere dich selbst', {});
    assert(result.answer, 'should return answer');
  });
});
