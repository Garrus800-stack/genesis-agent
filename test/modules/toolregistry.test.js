// ============================================================
// Test: ToolRegistry.js — registration, execution, safety,
// tool prompt generation, parseToolCalls, stats
// ============================================================

const { describe, test, assert, assertEqual, assertThrows, run } = require('../harness');
const { ToolRegistry } = require('../../src/agent/intelligence/ToolRegistry');

function createRegistry(opts = {}) {
  return new ToolRegistry({ bus: { fire: () => {}, emit: () => {} }, lang: opts.lang || null });
}

describe('ToolRegistry: Registration & Lookup', () => {
  test('register and hasTool', () => {
    const r = createRegistry();
    r.register('greet', { description: 'says hi' }, () => 'hi', 'test');
    assert(r.hasTool('greet'));
    assert(!r.hasTool('missing'));
  });

  test('listTools returns registered tools', () => {
    const r = createRegistry();
    r.register('a', { description: 'A' }, () => {}, 'x');
    r.register('b', { description: 'B' }, () => {}, 'y');
    const list = r.listTools();
    assertEqual(list.length, 2);
    assertEqual(list[0].name, 'a');
    assertEqual(list[1].source, 'y');
  });

  test('unregister removes tool', () => {
    const r = createRegistry();
    r.register('tmp', { description: 'temp' }, () => {});
    assert(r.hasTool('tmp'));
    const removed = r.unregister('tmp');
    assert(removed);
    assert(!r.hasTool('tmp'));
  });

  test('unregister returns false for unknown', () => {
    const r = createRegistry();
    assertEqual(r.unregister('ghost'), false);
  });

  test('re-registration overwrites', () => {
    const r = createRegistry();
    r.register('dup', { description: 'v1' }, () => 'v1');
    r.register('dup', { description: 'v2' }, () => 'v2');
    assertEqual(r.listTools().length, 1);
    assertEqual(r.listTools()[0].description, 'v2');
  });
});

describe('ToolRegistry: Execution', () => {
  test('execute calls handler and returns result', async () => {
    const r = createRegistry();
    r.register('add', { description: 'add' }, (input) => input.a + input.b);
    const result = await r.execute('add', { a: 3, b: 4 });
    assertEqual(result, 7);
  });

  test('execute throws for unknown tool', async () => {
    const r = createRegistry();
    let threw = false;
    try { await r.execute('nope'); } catch (e) { threw = true; }
    assert(threw, 'Should throw for unknown tool');
  });

  test('execute tracks stats', async () => {
    const r = createRegistry();
    r.register('stat-test', { description: 'x' }, () => 'ok');
    await r.execute('stat-test');
    await r.execute('stat-test');
    const stats = r.getStats();
    assertEqual(stats['stat-test'].calls, 2);
    assertEqual(stats['stat-test'].errors, 0);
    assert(stats['stat-test'].avgDuration >= 0);
  });

  test('execute records errors in stats', async () => {
    const r = createRegistry();
    r.register('fail', { description: 'x' }, () => { throw new Error('boom'); });
    try { await r.execute('fail'); } catch { /* expected */ }
    const stats = r.getStats();
    assertEqual(stats['fail'].errors, 1);
    assertEqual(stats['fail'].calls, 0);
  });

  test('executeToolCalls handles mixed success/failure', async () => {
    const r = createRegistry();
    r.register('ok', { description: '' }, () => 'fine');
    r.register('bad', { description: '' }, () => { throw new Error('oops'); });
    const results = await r.executeToolCalls([
      { name: 'ok', input: {} },
      { name: 'bad', input: {} },
    ]);
    assertEqual(results.length, 2);
    assert(results[0].success);
    assert(!results[1].success);
    assert(results[1].error.includes('oops'));
  });
});

describe('ToolRegistry: Tool Prompt Generation', () => {
  test('generateToolPrompt includes tool names', () => {
    const r = createRegistry();
    r.register('search', { description: 'Search the web', input: { query: 'string' } }, () => {});
    const prompt = r.generateToolPrompt();
    assert(prompt.includes('search'), 'Should include tool name');
    assert(prompt.includes('Search the web'));
    assert(prompt.includes('query'));
  });

  test('empty registry returns empty prompt', () => {
    const r = createRegistry();
    assertEqual(r.generateToolPrompt(), '');
  });

  test('German language mode uses German labels', () => {
    const r = createRegistry({ lang: { current: 'de' } });
    r.register('test', { description: 'Ein Test', input: {} }, () => {});
    const prompt = r.generateToolPrompt();
    assert(prompt.includes('Beschreibung') || prompt.includes('VERFUEGBARE'));
  });
});

describe('ToolRegistry: parseToolCalls', () => {
  test('parses single tool call', () => {
    const r = createRegistry();
    const resp = 'Some text\n<tool_call>\n{"name": "search", "input": {"query": "test"}}\n</tool_call>\nMore text';
    const { text, toolCalls } = r.parseToolCalls(resp);
    assertEqual(toolCalls.length, 1);
    assertEqual(toolCalls[0].name, 'search');
    assertEqual(toolCalls[0].input.query, 'test');
    assert(text.includes('Some text'));
    assert(!text.includes('tool_call'));
  });

  test('parses multiple tool calls', () => {
    const r = createRegistry();
    const resp = '<tool_call>{"name":"a","input":{}}</tool_call> and <tool_call>{"name":"b","input":{"x":1}}</tool_call>';
    const { toolCalls } = r.parseToolCalls(resp);
    assertEqual(toolCalls.length, 2);
    assertEqual(toolCalls[0].name, 'a');
    assertEqual(toolCalls[1].name, 'b');
  });

  test('skips malformed JSON in tool calls', () => {
    const r = createRegistry();
    const resp = '<tool_call>not json</tool_call> <tool_call>{"name":"ok"}</tool_call>';
    const { toolCalls } = r.parseToolCalls(resp);
    assertEqual(toolCalls.length, 1);
    assertEqual(toolCalls[0].name, 'ok');
  });

  test('returns empty array with no tool calls', () => {
    const r = createRegistry();
    const { toolCalls } = r.parseToolCalls('just regular text');
    assertEqual(toolCalls.length, 0);
  });
});

describe('ToolRegistry: Call History', () => {
  test('getHistory returns recent calls', async () => {
    const r = createRegistry();
    r.register('h', { description: '' }, () => 42);
    await r.execute('h', { x: 1 });
    const history = r.getHistory();
    assert(history.length >= 1);
    assertEqual(history[0].name, 'h');
  });

  test('history respects limit', async () => {
    const r = createRegistry();
    r.historyLimit = 3;
    r.register('t', { description: '' }, () => 'ok');
    for (let i = 0; i < 10; i++) await r.execute('t');
    assertEqual(r.getHistory().length, 3);
  });
});

run();
