// ============================================================
// Test: ChatOrchestrator stream filter for <tool_call> blocks
// v7.3.3: raw tool_call markup must not reach the UI during
// streaming — it's consumed by _processToolLoop afterwards.
// ============================================================

'use strict';

const { describe, test, assert, assertEqual, run } = require('../harness');

// Simulate the stream-filter state machine directly. This mirrors the
// implementation in ChatOrchestrator.handleStream so we can exercise it
// without booting the full orchestrator.
function makeStreamFilter(onChunk) {
  let inToolCall = false;
  let streamBuffer = '';
  return {
    push(chunk) {
      streamBuffer += chunk;
      let out = '';
      while (streamBuffer.length > 0) {
        if (!inToolCall) {
          const openIdx = streamBuffer.indexOf('<tool_call>');
          if (openIdx === -1) {
            if (streamBuffer.length > 11) {
              out += streamBuffer.slice(0, -11);
              streamBuffer = streamBuffer.slice(-11);
            }
            break;
          }
          out += streamBuffer.slice(0, openIdx);
          streamBuffer = streamBuffer.slice(openIdx + 11);
          inToolCall = true;
        } else {
          const closeIdx = streamBuffer.indexOf('</tool_call>');
          if (closeIdx === -1) {
            if (streamBuffer.length > 12) {
              streamBuffer = streamBuffer.slice(-12);
            }
            break;
          }
          streamBuffer = streamBuffer.slice(closeIdx + 12);
          inToolCall = false;
        }
      }
      if (out) onChunk(out);
    },
    flush() {
      if (!inToolCall && streamBuffer.length > 0) {
        onChunk(streamBuffer);
      }
    },
  };
}

describe('ChatOrchestrator: tool_call stream filter', () => {
  test('passes plain text through unchanged', () => {
    const chunks = [];
    const f = makeStreamFilter((c) => chunks.push(c));
    f.push('Hello, how can I help you today?');
    f.flush();
    assertEqual(chunks.join(''), 'Hello, how can I help you today?');
  });

  test('strips complete tool_call block in single chunk', () => {
    const chunks = [];
    const f = makeStreamFilter((c) => chunks.push(c));
    f.push('Before <tool_call>{"name":"x"}</tool_call> After');
    f.flush();
    assertEqual(chunks.join(''), 'Before  After');
  });

  test('strips tool_call split across many small chunks (token-by-token)', () => {
    const chunks = [];
    const f = makeStreamFilter((c) => chunks.push(c));
    const input = 'Ich beginne. <tool_call>{"name":"self-inspect"}</tool_call> Fertig.';
    // Feed one character at a time — worst case for the state machine
    for (const ch of input) f.push(ch);
    f.flush();
    assertEqual(chunks.join(''), 'Ich beginne.  Fertig.');
  });

  test('strips multiple tool_call blocks in one response', () => {
    const chunks = [];
    const f = makeStreamFilter((c) => chunks.push(c));
    f.push('A <tool_call>{"n":1}</tool_call> B <tool_call>{"n":2}</tool_call> C');
    f.flush();
    assertEqual(chunks.join(''), 'A  B  C');
  });

  test('handles tool_call tag split across chunk boundary', () => {
    const chunks = [];
    const f = makeStreamFilter((c) => chunks.push(c));
    // Split right in the middle of '<tool_call>'
    f.push('Text <tool_');
    f.push('call>{"name":"x"}</tool_call> more');
    f.flush();
    assertEqual(chunks.join(''), 'Text  more');
  });

  test('handles close tag split across chunk boundary', () => {
    const chunks = [];
    const f = makeStreamFilter((c) => chunks.push(c));
    f.push('Text <tool_call>{"name":"x"}</tool_');
    f.push('call> more');
    f.flush();
    assertEqual(chunks.join(''), 'Text  more');
  });

  test('does not leak tool_call opening tag itself', () => {
    const chunks = [];
    const f = makeStreamFilter((c) => chunks.push(c));
    f.push('Before<tool_call>inside</tool_call>After');
    f.flush();
    const out = chunks.join('');
    assert(!out.includes('<tool_call'), 'opening tag leaked: ' + JSON.stringify(out));
    assert(!out.includes('</tool_call'), 'closing tag leaked: ' + JSON.stringify(out));
    assert(!out.includes('inside'), 'tool_call body leaked: ' + JSON.stringify(out));
  });

  test('flush only emits buffered content when not inside a tool_call', () => {
    const chunks = [];
    const f = makeStreamFilter((c) => chunks.push(c));
    // Stream ends mid-tool-call (unusual but possible): buffered inside shouldn't leak
    f.push('Start <tool_call>{"partial":');
    f.flush();
    const out = chunks.join('');
    assertEqual(out, 'Start ');
  });
});

run();
