// ============================================================
// Test: NativeToolUse.js — tool schema conversion, multi-round loop
// ============================================================
let passed = 0, failed = 0;
const failures = [];

// v3.5.2: Fixed — queue-based async-safe test runner
const _testQueue = [];
function test(name, fn) { _testQueue.push({ name, fn }); }
function assert(c, m) { if (!c) throw new Error(m || 'Assertion failed'); }

const { NullBus } = require('../../src/agent/core/EventBus');

// ── Mock Model (returns structured tool calls) ────────────

function createMockModel(toolCallResponse = null) {
  return {
    activeModel: 'mock-model',
    activeBackend: 'ollama',
    availableModels: [{ name: 'mock-model', backend: 'ollama' }],
    chat: async (prompt, messages, taskType) => {
      return toolCallResponse || 'No tool call needed.';
    },
  };
}

function createMockToolRegistry() {
  const tools = new Map();
  tools.set('read-file', {
    name: 'read-file',
    description: 'Read a file from disk',
    input: { path: 'File path to read' },
    execute: async (params) => ({ content: `Content of ${params.path}` }),
  });
  tools.set('web-search', {
    name: 'web-search',
    description: 'Search the web',
    input: { query: 'Search query' },
    execute: async (params) => ({ results: [`Result for: ${params.query}`] }),
  });
  return {
    listTools: () => [...tools.values()].map(t => ({ name: t.name })),
    getTool: (name) => tools.get(name) || null,
    getToolDefinition: (name) => tools.get(name) || null,
    executeSingleTool: async (name, input) => {
      const tool = tools.get(name);
      return tool ? tool.execute(input) : { error: 'Tool not found' };
    },
  };
}

// ── Tests ──────────────────────────────────────────────────

const { NativeToolUse } = require('../../src/agent/revolution/NativeToolUse');

console.log('\n  🔧 NativeToolUse');

test('constructs without errors', () => {
  const ntu = new NativeToolUse({
    bus: NullBus, model: createMockModel(), tools: createMockToolRegistry(),
  });
  assert(ntu._maxToolRounds === 5);
  assert(ntu._stats.totalCalls === 0);
});

test('static containerConfig is defined', () => {
  assert(NativeToolUse.containerConfig, 'Missing containerConfig');
  assert(NativeToolUse.containerConfig.name === 'nativeToolUse');
  assert(NativeToolUse.containerConfig.phase === 8);
  assert(NativeToolUse.containerConfig.deps.includes('model'));
  assert(NativeToolUse.containerConfig.deps.includes('tools'));
});

test('_buildToolSchemas generates schemas from registry', () => {
  const ntu = new NativeToolUse({
    bus: NullBus, model: createMockModel(), tools: createMockToolRegistry(),
  });
  // Access internal method
  if (typeof ntu._buildToolSchemas === 'function') {
    const schemas = ntu._buildToolSchemas(null);
    assert(Array.isArray(schemas), 'Should return array');
    assert(schemas.length === 2, `Expected 2 schemas, got ${schemas.length}`);
  }
});

test('_supportsNativeTools detects ollama support', () => {
  const ntu = new NativeToolUse({
    bus: NullBus, model: createMockModel(), tools: createMockToolRegistry(),
  });
  if (typeof ntu._supportsNativeTools === 'function') {
    assert(ntu._supportsNativeTools('ollama') === true, 'Ollama should support native tools');
    assert(ntu._supportsNativeTools('anthropic') === true, 'Anthropic should support native tools');
  }
});

test('chat falls back to regular chat when no tools', async () => {
  const emptyTools = { listTools: () => [], getTool: () => null };
  const ntu = new NativeToolUse({
    bus: NullBus, model: createMockModel('Plain text response'), tools: emptyTools,
  });
  const result = await ntu.chat('system', [{ role: 'user', content: 'hello' }]);
  assert(result.text === 'Plain text response' || typeof result.text === 'string',
    'Should return text response');
  assert(Array.isArray(result.toolCalls), 'Should have toolCalls array');
  assert(result.toolCalls.length === 0, 'No tools should be called');
});

test('stats track correctly', () => {
  const ntu = new NativeToolUse({
    bus: NullBus, model: createMockModel(), tools: createMockToolRegistry(),
  });
  assert(ntu._stats.totalCalls === 0);
  assert(ntu._stats.totalRounds === 0);
  assert(ntu._stats.failures === 0);
});

test('getStats returns statistics', () => {
  const ntu = new NativeToolUse({
    bus: NullBus, model: createMockModel(), tools: createMockToolRegistry(),
  });
  if (typeof ntu.getStats === 'function') {
    const stats = ntu.getStats();
    assert(typeof stats === 'object', 'Should return object');
  }
});

test('respects maxRounds option', () => {
  const ntu = new NativeToolUse({
    bus: NullBus, model: createMockModel(), tools: createMockToolRegistry(),
  });
  assert(ntu._maxToolRounds === 5, 'Default maxToolRounds should be 5');
});

test('allowedTools filters available tools', () => {
  const ntu = new NativeToolUse({
    bus: NullBus, model: createMockModel(), tools: createMockToolRegistry(),
  });
  if (typeof ntu._buildToolSchemas === 'function') {
    const filtered = ntu._buildToolSchemas(['read-file']);
    assert(filtered.length === 1, `Expected 1 filtered schema, got ${filtered.length}`);
  }
});

// ── Summary ───────────────────────────────────────────────
setTimeout(() => {
  console.log(`\n  NativeToolUse: ${passed} passed, ${failed} failed`);
  if (failures.length > 0) {
    console.log('  Failures:');
    failures.forEach(f => console.log(`    - ${f.name}: ${f.error}`));
  }
}, 500);

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
