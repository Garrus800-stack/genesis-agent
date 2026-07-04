// ============================================================
// GENESIS — test/modules/v7928-xml-tool-calls.contract.test.js
//
// v7.9.28: models such as kimi/qwen/deepseek emit tool calls in the
// Anthropic XML form <function_calls><invoke name="tool">
// <parameter name="k">v</parameter></invoke></function_calls> rather than the
// <tool_call> JSON form. Before this fix the parser did not recognise them, so
// they rendered as raw text and never executed — the model looped forever
// "inspecting the project" and never built anything. This pins the parse.
// ============================================================

const { describe, test, assert, assertEqual, run } = require('../harness');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const { ToolRegistry } = require(path.join(ROOT, 'src/agent/intelligence/ToolRegistry'));

// Build the XML out of fragments so the test file itself contains no literal
// tool-call block that other scanners could trip over.
const P = 'parameter';
const I = 'invoke';
const F = 'function_calls';
const wrap = (inner) => `<${F}>\n${inner}\n</${F}>`;
const invoke = (name, params) => `<${I} name="${name}">\n` +
  params.map(([k, v]) => `<${P} name="${k}">${v}</${P}>`).join('\n') + `\n</${I}>`;

describe('v7.9.28 XML tool-call parsing', () => {
  test('parses a single <function_calls>/<invoke>/<parameter> block', () => {
    const tr = new ToolRegistry();
    const r = tr.parseToolCalls('I will inspect.\n' + wrap(invoke('file-list', [['dir', 'src']])));
    assertEqual(r.toolCalls.length, 1);
    assertEqual(r.toolCalls[0].name, 'file-list');
    assertEqual(r.toolCalls[0].input.dir, 'src');
  });

  test('strips the raw XML from the visible text', () => {
    const tr = new ToolRegistry();
    const r = tr.parseToolCalls('lead ' + wrap(invoke('file-list', [['dir', 'src']])) + ' tail');
    assert(!new RegExp(F).test(r.text), 'function_calls removed');
    assert(!new RegExp('<' + I).test(r.text), 'invoke removed');
    assert(!new RegExp('<' + P).test(r.text), 'parameter removed');
  });

  test('parses multiple invokes in one block', () => {
    const tr = new ToolRegistry();
    const r = tr.parseToolCalls(wrap(invoke('file-list', [['dir', 'src/modules']]) + '\n' + invoke('file-read', [['path', 'package.json']])));
    assertEqual(r.toolCalls.length, 2);
    assertEqual(r.toolCalls[1].name, 'file-read');
    assertEqual(r.toolCalls[1].input.path, 'package.json');
  });

  test('handles the antml:-prefixed tag variant', () => {
    const tr = new ToolRegistry();
    const xml = `<${F}><${I} name="shell"><${P} name="command">dir /b</${P}></${I}></${F}>`;
    const r = tr.parseToolCalls(xml);
    assertEqual(r.toolCalls.length, 1);
    assertEqual(r.toolCalls[0].name, 'shell');
    assertEqual(r.toolCalls[0].input.command, 'dir /b');
  });

  test('coerces JSON scalars but keeps plain strings', () => {
    const tr = new ToolRegistry();
    const r = tr.parseToolCalls(wrap(invoke('x', [['count', '5'], ['name', 'src'], ['flag', 'true']])));
    assertEqual(r.toolCalls[0].input.count, 5);
    assertEqual(r.toolCalls[0].input.name, 'src');
    assertEqual(r.toolCalls[0].input.flag, true);
  });

  test('does not regress the <tool_call> JSON form', () => {
    const tr = new ToolRegistry();
    const r = tr.parseToolCalls('<tool_call>{"name":"file-read","input":{"path":"a.js"}}</tool_call>');
    assertEqual(r.toolCalls.length, 1);
    assertEqual(r.toolCalls[0].name, 'file-read');
    assertEqual(r.toolCalls[0].input.path, 'a.js');
  });

  test('no false positive on prose that merely mentions invoke', () => {
    const tr = new ToolRegistry();
    const r = tr.parseToolCalls('Here is code: const invoke = 1; // not a tool call');
    assertEqual(r.toolCalls.length, 0);
  });

  // ---- generalized normalizer (v7.9.28): flexible field names + more shapes ----
  const withTools = () => { const tr = new ToolRegistry(); for (const nm of ['shell', 'system-info', 'file-list', 'file-read']) tr.register(nm, {}, async () => ({})); return tr; };
  const TT = 'tool';

  test('F1 <tool_call> accepts flexible fields (tool/arguments)', () => {
    const r = withTools().parseToolCalls('<tool_call>{"tool":"shell","arguments":{"command":"x"}}</tool_call>');
    assertEqual(r.toolCalls.length, 1);
    assertEqual(r.toolCalls[0].name, 'shell');
    assertEqual(r.toolCalls[0].input.command, 'x');
  });

  test('F5 <tool name="shell">{args}</tool> (inner JSON is the args)', () => {
    const r = withTools().parseToolCalls(`I use it.\n<${TT} name="shell">{"command": "dir /b", "description": "List root"}</${TT}>`);
    assertEqual(r.toolCalls.length, 1);
    assertEqual(r.toolCalls[0].name, 'shell');
    assertEqual(r.toolCalls[0].input.command, 'dir /b');
    assert(!new RegExp(`<${TT} name`).test(r.text), 'tag stripped from text');
  });

  test('F6 bare JSON with tool_type marker executes', () => {
    const r = withTools().parseToolCalls('{"tool_type": "function", "tool": "system-info", "arguments": {}}');
    assertEqual(r.toolCalls.length, 1);
    assertEqual(r.toolCalls[0].name, 'system-info');
  });

  test('F6 bare JSON shell with args', () => {
    const r = withTools().parseToolCalls('{"tool_type": "function", "tool": "shell", "arguments": {"command": "dir /b"}}');
    assertEqual(r.toolCalls.length, 1);
    assertEqual(r.toolCalls[0].input.command, 'dir /b');
  });

  test('F6 OpenAI-style nested function object', () => {
    const r = withTools().parseToolCalls('{"type":"function","function":{"name":"shell","arguments":{"command":"z"}}}');
    assertEqual(r.toolCalls.length, 1);
    assertEqual(r.toolCalls[0].name, 'shell');
    assertEqual(r.toolCalls[0].input.command, 'z');
  });

  test('F6 SECURITY: bare {name,input} with no marker and unregistered name is rejected', () => {
    const r = withTools().parseToolCalls('{"name":"totally-not-a-tool","input":{"x":1}}');
    assertEqual(r.toolCalls.length, 0);
  });

  test('F6 no false positive on an ordinary JSON object in prose', () => {
    const r = withTools().parseToolCalls('Example: {"user":"bob","age":30} in my answer.');
    assertEqual(r.toolCalls.length, 0);
  });
});

run();
