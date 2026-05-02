// ============================================================
// Test: v7.5.6 — Thinking-Block Integration
//
// E2E tests that verify <think>...</think> filtering in all three
// ChatOrchestrator paths:
//   1. handleStream — streaming filter pipeline
//   2. _directChat (handleChat path) — non-streaming model.chat()
//   3. _processToolLoop synthesis — multi-round tool execution
//
// Strategy: instantiate a real ChatOrchestrator with mocked model,
// tools, intentRouter, and circuitBreaker. Drive the chat / stream
// paths with messages that include <think>...</think>. Assert that:
//   - onChunk only sees clean output (no <think>...</think>)
//   - chat:completed payload has clean response
//   - model:thinking-trace event was fired
//   - parseToolCalls is never called with text containing <tool_call>
//     INSIDE a <think> block (phantom-tool protection)
// ============================================================

'use strict';

let passed = 0, failed = 0;
const failures = [];
function test(name, fn) {
  try {
    const r = fn();
    if (r && typeof r.then === 'function') {
      return r.then(() => { passed++; console.log(`    ✅ ${name}`); })
              .catch(err => { failed++; failures.push({ name, error: err.message }); console.log(`    ❌ ${name}: ${err.message}`); });
    }
    passed++; console.log(`    ✅ ${name}`);
  } catch (err) { failed++; failures.push({ name, error: err.message }); console.log(`    ❌ ${name}: ${err.message}`); }
}
function assert(c, m) { if (!c) throw new Error(m || 'Assertion failed'); }
function assertEqual(a, b, m) { if (a !== b) throw new Error(`${m || 'not equal'}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`); }

const { ChatOrchestrator } = require('../../src/agent/hexagonal/ChatOrchestrator');

// Capture-bus
function makeBus() {
  const events = [];
  const handlers = new Map();
  return {
    events,
    fire(name, payload) { events.push({ name, payload }); },
    emit(name, payload) { events.push({ name, payload }); },
    on(name, fn) {
      if (!handlers.has(name)) handlers.set(name, []);
      handlers.get(name).push(fn);
      return () => {};
    },
  };
}

// Minimal lang
const lang = { t: (k) => k, detect: () => 'en', current: 'en' };

// Mock circuit-breaker that just runs the fn
const passthroughCB = { execute: (fn) => fn() };

// Mock context that provides system + messages
const passthroughContext = {
  build: ({ task, history }) => ({
    system: 'system prompt',
    messages: [...history, { role: 'user', content: task }],
  }),
  buildAsync: null,
};

// Mock prompt-builder
const passthroughPromptBuilder = {
  build: () => 'system prompt',
  buildAsync: null,
};

// Mock intent-router that returns 'general' for everything
const generalRouter = {
  classifyAsync: async () => ({ type: 'general', confidence: 0.9 }),
};

// Mock tools — by default: no tool-calls parsed, no execution
function makeMockTools(opts = {}) {
  const parseLog = [];
  const tools = {
    parseToolCalls(text) {
      parseLog.push(text);
      return opts.parseToolCalls
        ? opts.parseToolCalls(text)
        : { text, toolCalls: [] };
    },
    execute() { throw new Error('tools.execute should not be called in these tests'); },
    executeToolCalls() { throw new Error('tools.executeToolCalls should not be called'); },
    generateToolPrompt: () => '',
    parseLog,
  };
  return tools;
}

// Build a streaming-mock model: feeds the given chunks to onChunk.
function makeStreamingModel(chunks, opts = {}) {
  return {
    activeModel: opts.modelName || 'test-model',
    activeBackend: 'test',
    streamChat(system, messages, onChunk, _signal, _taskType) {
      for (const chunk of chunks) onChunk(chunk);
      return Promise.resolve(chunks.join(''));
    },
    chat(system, messages, _taskType) {
      return Promise.resolve(opts.chatResponse || chunks.join(''));
    },
  };
}

// Build a non-streaming chat-mock model: chat() returns scripted strings.
// Each call returns the next response in `responses`.
function makeChatModel(responses, opts = {}) {
  let i = 0;
  return {
    activeModel: opts.modelName || 'test-model',
    activeBackend: 'test',
    chat(system, messages, _taskType) {
      const r = responses[i] || responses[responses.length - 1];
      i++;
      return Promise.resolve(r);
    },
    streamChat() { throw new Error('streamChat should not be called in non-streaming tests'); },
  };
}

function makeOrchestrator(model, tools, opts = {}) {
  const bus = opts.bus || makeBus();
  // Constructor in source uses positional-keyword spread; the same shape is used
  // by phase5-hexagonal.js when wiring the real instance.
  const orch = new ChatOrchestrator({
    bus,
    lang,
    intentRouter: opts.router || generalRouter,
    model,
    context: passthroughContext,
    tools: tools || makeMockTools(),
    circuitBreaker: passthroughCB,
    promptBuilder: passthroughPromptBuilder,
    uncertaintyGuard: null,
    memory: null,
    unifiedMemory: null,
    storageDir: null,        // disables history persistence
    storage: null,
    selfGate: null,
  });
  // _withRetry is defined on ChatOrchestratorHelpers — short-circuit it for tests.
  /** @type {any} */ (orch)._withRetry = (fn) => fn();
  // _processToolLoop relies on the mixin too; ensure it's loaded.
  return { orch, bus };
}

console.log('  thinking-block-integration tests:');

// ──────────────────────────────────────────────────────────────
// Streaming-Pfad (handleStream)
// ──────────────────────────────────────────────────────────────

test('stream: <think> stripped from onChunk output', async () => {
  const model = makeStreamingModel(['Hello ', '<think>secret</think>', 'world']);
  const { orch, bus } = makeOrchestrator(model);
  const chunks = [];
  await orch.handleStream('hi', (c) => chunks.push(c), () => {});
  const out = chunks.join('');
  assert(!out.includes('<think>'), `onChunk leaked <think>: ${JSON.stringify(out)}`);
  assert(!out.includes('</think>'), 'onChunk leaked </think>');
  assert(!out.includes('secret'), 'onChunk leaked reasoning content');
  assert(out.includes('Hello'), 'onChunk should still include answer');
  assert(out.includes('world'), 'onChunk should still include answer');
});

test('stream: chat:completed payload has clean response', async () => {
  const model = makeStreamingModel(['Hello ', '<think>secret</think>', 'world']);
  const { orch, bus } = makeOrchestrator(model);
  await orch.handleStream('hi', () => {}, () => {});
  const completed = bus.events.find(e => e.name === 'chat:completed');
  assert(completed, 'chat:completed should fire');
  assert(!completed.payload.response.includes('<think>'),
    `chat:completed leaked <think>: ${completed.payload.response}`);
  assert(!completed.payload.response.includes('secret'),
    'chat:completed leaked reasoning');
});

test('stream: model:thinking-trace event fired with reasoning content', async () => {
  const model = makeStreamingModel(['<think>hidden reasoning</think>visible']);
  const { orch, bus } = makeOrchestrator(model);
  await orch.handleStream('hi', () => {}, () => {});
  const trace = bus.events.find(e => e.name === 'model:thinking-trace');
  assert(trace, 'model:thinking-trace must fire when reasoning is present');
  assertEqual(trace.payload.text, 'hidden reasoning');
  assertEqual(trace.payload.modelName, 'test-model');
});

test('stream: NO thinking-trace event when no <think> block in stream', async () => {
  const model = makeStreamingModel(['just a normal answer']);
  const { orch, bus } = makeOrchestrator(model);
  await orch.handleStream('hi', () => {}, () => {});
  const trace = bus.events.find(e => e.name === 'model:thinking-trace');
  assertEqual(trace, undefined, 'should not fire thinking-trace without <think>');
});

test('stream: phantom-tool-call inside <think> not seen by parseToolCalls', async () => {
  const model = makeStreamingModel([
    'Hi ',
    '<think>maybe I should call <tool_call>{"name":"bad","input":{}}</tool_call> here</think>',
    'Done.',
  ]);
  const tools = makeMockTools();
  const { orch } = makeOrchestrator(model, tools);
  await orch.handleStream('hi', () => {}, () => {});
  // _processToolLoop calls parseToolCalls on the response. With the filter
  // working, the text it sees must not contain the phantom tool-call.
  for (const t of tools.parseLog) {
    assert(!t.includes('"name":"bad"'),
      `parseToolCalls received phantom tool from inside <think>: ${t}`);
  }
});

test('stream: tag split across chunks still filtered', async () => {
  const model = makeStreamingModel(['Hi <thi', 'nk>secret</think> bye']);
  const { orch } = makeOrchestrator(model);
  const chunks = [];
  await orch.handleStream('hi', (c) => chunks.push(c), () => {});
  const out = chunks.join('');
  assert(!out.includes('secret'));
  assert(out.includes('Hi'));
  assert(out.includes('bye'));
});

// ──────────────────────────────────────────────────────────────
// Non-Streaming-Pfad (_directChat via handleChat)
// ──────────────────────────────────────────────────────────────

test('_directChat: <think> stripped from returned response', async () => {
  const model = makeChatModel(['Hi <think>private thoughts</think>Hello!']);
  const { orch, bus } = makeOrchestrator(model);
  const result = await orch._directChat('greet me');
  assert(!result.includes('<think>'), `result leaked <think>: ${result}`);
  assert(!result.includes('private thoughts'), 'result leaked reasoning');
  assert(result.includes('Hi'));
  assert(result.includes('Hello!'));
});

test('_directChat: model:thinking-trace fired with aggregated reasoning', async () => {
  const model = makeChatModel(['<think>step one</think>Done']);
  const { orch, bus } = makeOrchestrator(model);
  await orch._directChat('go');
  const trace = bus.events.find(e => e.name === 'model:thinking-trace');
  assert(trace, 'thinking-trace must fire from _directChat path');
  assertEqual(trace.payload.text, 'step one');
});

test('_directChat: NO thinking-trace when response has no <think>', async () => {
  const model = makeChatModel(['plain answer']);
  const { orch, bus } = makeOrchestrator(model);
  await orch._directChat('go');
  const trace = bus.events.find(e => e.name === 'model:thinking-trace');
  assertEqual(trace, undefined);
});

test('_directChat: phantom-tool-call inside <think> not parsed', async () => {
  const model = makeChatModel([
    'Hi <think>I want <tool_call>{"name":"shell","input":{"cmd":"rm -rf /"}}</tool_call></think>Done.',
  ]);
  const tools = makeMockTools();
  const { orch } = makeOrchestrator(model, tools);
  await orch._directChat('hi');
  for (const t of tools.parseLog) {
    assert(!t.includes('rm -rf'),
      `parseToolCalls saw phantom dangerous tool from <think>: ${t}`);
  }
});

// ──────────────────────────────────────────────────────────────
// Tool-Loop synthesis (_processToolLoop)
// ──────────────────────────────────────────────────────────────

test('synthesis: <think> in tool-loop synthesis stripped from chunks', async () => {
  // First model call in stream: emits a tool-call
  // _processToolLoop will then call model.chat() for the synthesis.
  // The synthesis response contains <think>...</think>; it must be stripped.
  let callCount = 0;
  const model = {
    activeModel: 'reasoner',
    activeBackend: 'test',
    streamChat(system, messages, onChunk) {
      onChunk('<tool_call>{"name":"echo","input":{"x":1}}</tool_call>');
      return Promise.resolve();
    },
    chat() {
      callCount++;
      // The tool-loop's synthesis call returns text WITH a thinking block.
      return Promise.resolve('<think>analyzing tool result</think>Final answer.');
    },
  };
  // Tools that recognize one tool-call in round 1, none after.
  let parseCount = 0;
  const tools = {
    parseToolCalls(text) {
      parseCount++;
      if (parseCount === 1) {
        return {
          text: '',
          toolCalls: [{ name: 'echo', input: { x: 1 } }],
        };
      }
      // Round 2 sees the synthesis (which should already be stripped of <think>)
      return { text, toolCalls: [] };
    },
    executeToolCalls: async (calls) => calls.map(c => ({ name: c.name, success: true, result: { ok: true } })),
    execute: async () => ({ ok: true }),
    generateToolPrompt: () => '',
    parseLog: [],
  };
  const { orch, bus } = makeOrchestrator(model, tools);
  const chunks = [];
  await orch.handleStream('do it', (c) => chunks.push(c), () => {});
  const out = chunks.join('');
  // The synthesis output should appear in the stream, but without <think>.
  assert(!out.includes('analyzing tool result'),
    `synthesis leaked reasoning: ${out}`);
  assert(!out.includes('<think>'));
  assert(out.includes('Final answer.'),
    `expected synthesis answer in chunks: ${out}`);
});

// ──────────────────────────────────────────────────────────────
// Summary
// ──────────────────────────────────────────────────────────────
(async () => {
  // Wait briefly for any pending tests
  await new Promise(r => setTimeout(r, 100));
  console.log(`\n  thinking-block-integration: ${passed} passed, ${failed} failed`);
  if (failed > 0) {
    console.log('  Failures:');
    failures.forEach(f => console.log(`    - ${f.name}: ${f.error}`));
    process.exit(1);
  }
})();
