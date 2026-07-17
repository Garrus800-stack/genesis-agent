// ============================================================
// TEST — v7.9.39 stream truth: the swallowed stop-signal + the repetition brake
//
// Exact test command:
//   node test/modules/v7939-stream-truth.contract.test.js
//
// Two roots, both field-observed (the awakening log: one paragraph streamed 50x):
//   A) OpenAI/Anthropic backends received finish_reason and threw it away, so
//      every cloud answer carried doneReason: null and downstream layers had to
//      guess completeness (field 18).
//   B) StreamingCompletion accumulated chunks with only time-based timers, no
//      content check — a model looping on a finished paragraph streamed it 50x,
//      on-time chunks, no timer fired.
//
// Pins: finish_reason/[DONE]/stop_reason forwarding; the tail-repetition
// detector (real silent backend → one copy, terminated); the detector interlock
// (stop-repetition = COMPLETE, never a cut); and the negative cases that keep
// legitimate text untouched.
// ============================================================
const assert = require('assert');
const { describe, test, run } = require('../harness');
const { streamingCompletion, detectTailRepetition } = require('../../src/agent/foundation/backends/StreamingCompletion');
const { isComplete } = require('../../src/agent/foundation/backends/TruncationDetector');

// A backend that streams a block `copies` times and never reports onDone,
// so doneReason stays null — exactly the silent-model case.
function loopBackend(block, copies) {
  return { async stream(_s, _m, onChunk, sig) { for (let i = 0; i < copies && !sig?.aborted; i++) onChunk(block); } };
}
// A backend that streams distinct text across two rounds and DOES report stop.
function cleanBackend(text) {
  return { async stream(_s, _m, onChunk, _sig, _t, _mo, _mx, onDone) { onChunk(text); if (typeof onDone === 'function') onDone('stop'); } };
}

describe('v7.9.39 — cloud backends forward the stop signal (root A)', () => {
  test('both cloud backends now forward the finish reason (source-verified)', () => {
    const fs = require('fs'); const path = require('path');
    for (const f of ['OpenAIBackend.js', 'AnthropicBackend.js']) {
      const src = fs.readFileSync(path.join(__dirname, '../../src/agent/foundation/backends/', f), 'utf8');
      assert.ok(/async stream\([^)]*onDone\)/.test(src), f + ' stream signature includes onDone');
      assert.ok(/onDone === 'function'/.test(src) && /onDone\(/.test(src), f + ' actually calls onDone (finish reason no longer swallowed)');
    }
    const { OpenAIBackend } = require('../../src/agent/foundation/backends/OpenAIBackend');
    assert.ok(new OpenAIBackend({ baseUrl: 'http://x', apiKey: 'k' }).stream.length >= 8, 'OpenAI stream arity includes onDone');
  });

  test('a backend that reports stop propagates doneReason through streamingCompletion', async () => {
    const r = await streamingCompletion({ backend: cleanBackend('A complete answer.'), systemPrompt: '', messages: [], options: {} });
    assert.strictEqual(r.doneReason, 'stop', 'the reported stop reason reaches the caller');
    assert.strictEqual(r.content, 'A complete answer.', 'content intact');
  });
});

describe('v7.9.39 — repetition brake in the streaming core (root B)', () => {
  test('a silent backend streaming one paragraph 50x yields exactly one copy, terminated', async () => {
    const block = 'Ich schaue jetzt einfach, zuerst mein Selbstmodell und Habitat.\n';
    const r = await streamingCompletion({ backend: loopBackend(block, 50), systemPrompt: '', messages: [], options: {} });
    const copies = (r.content.match(/Ich schaue jetzt einfach/g) || []).length;
    assert.strictEqual(copies, 1, 'all but one copy removed');
    assert.strictEqual(r.doneReason, 'stop-repetition', 'terminated with the dedicated reason');
  });

  test('the brake fires early — well before all 50 copies accumulate', async () => {
    let sent = 0;
    const block = 'A finished sentence of more than forty characters here.\n';
    const counting = { async stream(_s, _m, onChunk, sig) { for (let i = 0; i < 50 && !sig?.aborted; i++) { onChunk(block); sent++; } } };
    await streamingCompletion({ backend: counting, systemPrompt: '', messages: [], options: {} });
    assert.ok(sent < 50, `stream was aborted mid-way (sent ${sent} of 50)`);
  });

  test('interlock: stop-repetition is COMPLETE, never a truncation cut', () => {
    const v = isComplete('some finished answer', 'stop-repetition');
    assert.strictEqual(v.complete, true, 'the brake result is treated as complete');
    assert.strictEqual(v.reason, 'stream-repetition-brake', 'with its own reason');
  });

  test('continuation does not re-drive a brake-terminated answer', async () => {
    // The loop's completeness gate must accept it, so no second round is requested.
    const block = 'Repeated finished paragraph exceeding the forty char floor.\n';
    const r = await streamingCompletion({ backend: loopBackend(block, 40), systemPrompt: '', messages: [], options: {} });
    assert.strictEqual(isComplete(r.content, r.doneReason).complete, true, 'brake output reads complete → no continuation round');
  });
});

describe('v7.9.39 — the brake leaves legitimate text untouched', () => {
  test('two identical paragraphs (an echo) are not touched', () => {
    assert.strictEqual(detectTailRepetition('A whole paragraph with well over forty characters of text. '.repeat(2)), null, 'two copies is below the three-copy floor');
  });
  test('short repetitions below the block floor are not touched', () => {
    assert.strictEqual(detectTailRepetition('ha '.repeat(30)), null, 'blocks under 40 chars are ignored');
  });
  test('three short identical code lines are not touched', () => {
    assert.strictEqual(detectTailRepetition('  return x;\n  return x;\n  return x;\n'), null, 'short code lines stay below the block floor');
  });
  test('ordinary progressing prose is not touched', () => {
    assert.strictEqual(detectTailRepetition('This is ordinary flowing text that keeps advancing in content, sentence by sentence, without ever stacking the same block.'), null, 'no false positive on real prose');
  });
  test('a >=40-char block repeated three times IS detected', () => {
    const b = 'This block is comfortably over forty characters long.\n';
    const r = detectTailRepetition('prefix ' + b.repeat(3));
    assert.ok(r && r.copies >= 3, 'three copies of a long block are caught');
  });
});

if (require.main === module) run();
