// ============================================================
// GENESIS — test/modules/v757-fix-fallback-ui.test.js (v7.5.7-fix)
//
// Tests for the Fallback-Chain UI logic in src/ui/modules/settings.js.
// Replaces the v5.1.0 multi-select <select multiple size="3"> Ctrl+Click
// pattern with explicit click-to-add / move / remove buttons. Logic is
// exposed as pure helpers (fbAdd / fbRemove / fbMove / fbIsCloud) so it
// can be tested without a DOM.
//
// Live motivation: Garrus saw the old <select multiple> dialog with 24
// installed Ollama models and could not tell whether "marked" meant
// "selected" — a documented usability failure that prevented the
// fallback-chain from being configurable in practice. After live 403s
// from qwen3-coder-next:cloud and no fallback-chain, Genesis stalled
// instead of switching to a local model.
// ============================================================

'use strict';

// v7.7.2: pure helpers now live in settings-fallback-ui.js with explicit
// exports — direct require replaces the v7.5.7 regex-source-parsing
// hack that was needed when these helpers were trapped inside the
// monolithic settings.js with no public surface.
const path = require('path');
const { fbAdd, fbRemove, fbMove, fbIsCloud } = require(
  path.join(__dirname, '..', '..', 'src', 'ui', 'modules', 'settings-fallback-ui')
);

let passed = 0, failed = 0;
const failures = [];

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`    ✅ ${name}`);
  } catch (err) {
    failed++;
    failures.push({ name, error: err.message });
    console.log(`    ❌ ${name}: ${err.message}`);
  }
}
function assert(cond, msg) { if (!cond) throw new Error(msg || 'Assertion failed'); }
function assertEqual(actual, expected, msg) {
  const aJson = JSON.stringify(actual);
  const eJson = JSON.stringify(expected);
  if (aJson !== eJson) throw new Error((msg || 'Mismatch') + `: expected ${eJson}, got ${aJson}`);
}

// ── fbAdd ────────────────────────────────────────────────────────

test('fbAdd: appends a new model to empty chain', () => {
  assertEqual(fbAdd([], 'gemma2:9b'), ['gemma2:9b']);
});

test('fbAdd: appends to non-empty chain', () => {
  assertEqual(fbAdd(['mistral:7b'], 'gemma2:9b'), ['mistral:7b', 'gemma2:9b']);
});

test('fbAdd: refuses duplicate (returns copy unchanged)', () => {
  const chain = ['mistral:7b', 'gemma2:9b'];
  const result = fbAdd(chain, 'mistral:7b');
  assertEqual(result, ['mistral:7b', 'gemma2:9b']);
});

test('fbAdd: rejects empty / null / non-string input', () => {
  assertEqual(fbAdd(['x'], ''), ['x']);
  assertEqual(fbAdd(['x'], null), ['x']);
  assertEqual(fbAdd(['x'], undefined), ['x']);
  assertEqual(fbAdd(['x'], 42), ['x']);
});

test('fbAdd: returns a NEW array (does not mutate input)', () => {
  const chain = ['a', 'b'];
  const result = fbAdd(chain, 'c');
  assert(result !== chain, 'result should be a new array');
  assertEqual(chain, ['a', 'b']);  // original unchanged
});

// ── fbRemove ─────────────────────────────────────────────────────

test('fbRemove: removes by valid index', () => {
  assertEqual(fbRemove(['a', 'b', 'c'], 1), ['a', 'c']);
});

test('fbRemove: removes first / last', () => {
  assertEqual(fbRemove(['a', 'b', 'c'], 0), ['b', 'c']);
  assertEqual(fbRemove(['a', 'b', 'c'], 2), ['a', 'b']);
});

test('fbRemove: out-of-bounds index returns copy unchanged', () => {
  assertEqual(fbRemove(['a', 'b'], 5), ['a', 'b']);
  assertEqual(fbRemove(['a', 'b'], -1), ['a', 'b']);
});

test('fbRemove: non-integer / non-array safe', () => {
  assertEqual(fbRemove([], 0), []);
  assertEqual(fbRemove(['a'], 'not-a-number'), ['a']);
  assertEqual(fbRemove(null, 0), []);
});

test('fbRemove: does not mutate input', () => {
  const chain = ['a', 'b', 'c'];
  fbRemove(chain, 1);
  assertEqual(chain, ['a', 'b', 'c']);
});

// ── fbMove ───────────────────────────────────────────────────────

test('fbMove: moves item up by one position', () => {
  assertEqual(fbMove(['a', 'b', 'c'], 1, 0), ['b', 'a', 'c']);
});

test('fbMove: moves item down by one position', () => {
  assertEqual(fbMove(['a', 'b', 'c'], 0, 1), ['b', 'a', 'c']);
});

test('fbMove: moves from middle to end', () => {
  assertEqual(fbMove(['a', 'b', 'c'], 1, 2), ['a', 'c', 'b']);
});

test('fbMove: moves from end to start', () => {
  assertEqual(fbMove(['a', 'b', 'c'], 2, 0), ['c', 'a', 'b']);
});

test('fbMove: same from/to is a no-op (returns copy)', () => {
  const chain = ['a', 'b', 'c'];
  const result = fbMove(chain, 1, 1);
  assertEqual(result, ['a', 'b', 'c']);
  assert(result !== chain, 'should return a new array even on no-op');
});

test('fbMove: out-of-bounds indices safe', () => {
  assertEqual(fbMove(['a', 'b'], 5, 0), ['a', 'b']);
  assertEqual(fbMove(['a', 'b'], 0, 5), ['a', 'b']);
  assertEqual(fbMove(['a', 'b'], -1, 0), ['a', 'b']);
});

test('fbMove: does not mutate input', () => {
  const chain = ['a', 'b', 'c'];
  fbMove(chain, 0, 2);
  assertEqual(chain, ['a', 'b', 'c']);
});

// ── fbIsCloud ────────────────────────────────────────────────────

test('fbIsCloud: detects :cloud suffix', () => {
  assert(fbIsCloud('qwen3-coder-next:cloud') === true);
  assert(fbIsCloud('kimi-k2.5:cloud') === true);
  assert(fbIsCloud('qwen3-vl:235b-cloud') === true);
});

test('fbIsCloud: does NOT match local quantized variants', () => {
  assert(fbIsCloud('qwen3-coder-next:q4_K_M') === false);
  assert(fbIsCloud('mannix/deepseek-coder-v2-lite-instruct:fp16') === false);
  assert(fbIsCloud('mistral:7b') === false);
  assert(fbIsCloud('gemma2:9b') === false);
});

test('fbIsCloud: case-insensitive', () => {
  assert(fbIsCloud('foo:CLOUD') === true);
  assert(fbIsCloud('foo:Cloud') === true);
});

test('fbIsCloud: handles non-string / null safely', () => {
  assert(fbIsCloud(null) === false);
  assert(fbIsCloud(undefined) === false);
  assert(fbIsCloud(42) === false);
  assert(fbIsCloud({}) === false);
});

// ── Integration: simulate Garrus's flow ──────────────────────────

test('integration: Garrus configures a 4-model fallback chain', () => {
  // Start: empty chain, available models include Garrus's actual installed list
  let chain = [];
  // 1. Add primary fallback (local coder)
  chain = fbAdd(chain, 'qwen3-coder-next:q4_K_M');
  // 2. Add second fallback (proven good)
  chain = fbAdd(chain, 'mannix/deepseek-coder-v2-lite-instruct:fp16');
  // 3. Add third (general purpose)
  chain = fbAdd(chain, 'mistral-nemo:12b');
  // 4. Add fourth (smallest, last-resort)
  chain = fbAdd(chain, 'gemma2:9b');
  // Expected order
  assertEqual(chain, [
    'qwen3-coder-next:q4_K_M',
    'mannix/deepseek-coder-v2-lite-instruct:fp16',
    'mistral-nemo:12b',
    'gemma2:9b',
  ]);
  // 5. Decide gemma should come BEFORE mistral
  chain = fbMove(chain, 3, 2);
  assertEqual(chain, [
    'qwen3-coder-next:q4_K_M',
    'mannix/deepseek-coder-v2-lite-instruct:fp16',
    'gemma2:9b',
    'mistral-nemo:12b',
  ]);
  // 6. Try to add a duplicate — must be rejected
  const before = chain.slice();
  chain = fbAdd(chain, 'gemma2:9b');
  assertEqual(chain, before);
  // 7. Remove deepseek
  chain = fbRemove(chain, 1);
  assertEqual(chain, [
    'qwen3-coder-next:q4_K_M',
    'gemma2:9b',
    'mistral-nemo:12b',
  ]);
});

// ── Done ─────────────────────────────────────────────────────────

console.log('');
console.log(`  ${passed} passed${failed > 0 ? `, ${failed} failed` : ''}`);
if (failed > 0) {
  console.log('');
  console.log('  Failures:');
  for (const f of failures) console.log(`    - ${f.name}: ${f.error}`);
  process.exit(1);
}
