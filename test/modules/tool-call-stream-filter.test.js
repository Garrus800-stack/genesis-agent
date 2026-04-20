// Test: tool-call-stream-filter
// v7.3.4: Rewritten as a real unit test of the extracted filter.
// Previously the test replicated the state-machine inline and only
// verified its own copy. Now it calls the production function.
const { describe, test, run } = require('../harness');
const { createToolCallStreamFilter } = require('../../src/agent/core/tool-call-stream-filter');

// Helper: feed a string into the filter one chunk at a time and
// collect the concatenated filtered output including the final flush.
function runFilter(chunks) {
  const filter = createToolCallStreamFilter();
  const parts = [];
  for (const c of chunks) {
    const out = filter.push(c);
    if (out) parts.push(out);
  }
  const tail = filter.flush();
  if (tail) parts.push(tail);
  return { output: parts.join(''), inToolCall: filter.inToolCall };
}

describe('tool-call-stream-filter', () => {
  test('plain text without tool_call passes through unchanged', () => {
    const { output } = runFilter(['Hello world!']);
    if (output !== 'Hello world!') throw new Error('got: ' + output);
  });

  test('complete tool_call is removed entirely', () => {
    const input = 'before <tool_call>{"name":"x"}</tool_call> after';
    const { output, inToolCall } = runFilter([input]);
    if (output !== 'before  after') throw new Error('got: ' + JSON.stringify(output));
    if (inToolCall) throw new Error('should have left tool_call state');
  });

  test('tool_call streamed token-by-token is still removed', () => {
    const input = 'A<tool_call>B</tool_call>C';
    const chunks = input.split('');  // one char at a time
    const { output } = runFilter(chunks);
    if (output !== 'AC') throw new Error('got: ' + JSON.stringify(output));
  });

  test('multiple tool_call blocks in one stream', () => {
    const input = 'x<tool_call>a</tool_call>y<tool_call>b</tool_call>z';
    const { output } = runFilter([input]);
    if (output !== 'xyz') throw new Error('got: ' + JSON.stringify(output));
  });

  test('open tag split across chunks', () => {
    const { output } = runFilter(['hi <tool_', 'call>junk</tool_call> bye']);
    if (output !== 'hi  bye') throw new Error('got: ' + JSON.stringify(output));
  });

  test('close tag split across chunks', () => {
    const { output } = runFilter(['pre <tool_call>a</tool', '_call> post']);
    if (output !== 'pre  post') throw new Error('got: ' + JSON.stringify(output));
  });

  test('text that merely looks like a tag does not trigger filter', () => {
    const { output } = runFilter(['<tool>nope</tool>']);
    if (output !== '<tool>nope</tool>') throw new Error('got: ' + JSON.stringify(output));
  });

  test('truncated stream inside tool_call swallows the dangling bytes', () => {
    // Stream ends mid-block — flush should NOT leak the partial markup.
    const filter = createToolCallStreamFilter();
    const outs = [];
    let o = filter.push('kept<tool_call>truncated');
    if (o) outs.push(o);
    const tail = filter.flush();
    if (tail) outs.push(tail);
    const combined = outs.join('');
    if (combined !== 'kept') throw new Error('got: ' + JSON.stringify(combined));
  });

  test('inToolCall state is accurate between chunks', () => {
    const filter = createToolCallStreamFilter();
    filter.push('hello ');
    if (filter.inToolCall) throw new Error('should be false before tag');
    filter.push('<tool_call>');
    if (!filter.inToolCall) throw new Error('should be true after open tag');
    filter.push('payload</tool_call>');
    if (filter.inToolCall) throw new Error('should be false after close tag');
  });

  test('empty chunk does nothing', () => {
    const filter = createToolCallStreamFilter();
    const out = filter.push('');
    if (out !== '') throw new Error('got: ' + JSON.stringify(out));
  });
});

run();
