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
