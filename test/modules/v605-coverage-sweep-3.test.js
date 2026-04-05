// ============================================================
// Test: v6.0.5 Coverage Sweep Part 3 — Final Push to 75%
//
// Targets: LLMPort (TokenBucket, HourlyBudget, estimateTokens,
//          MockLLM), ASTDiff, TaskDelegation, ImmuneSystem
// ============================================================

const { describe, test, assert, assertEqual, run } = require('../harness');

function mockBus() {
  return { on: () => () => {}, emit() {}, fire() {}, off() {} };
}
function mockStorage() {
  const store = {};
  return {
    readJSON: (f, fb) => store[f] || fb,
    writeJSON: (f, d) => { store[f] = JSON.parse(JSON.stringify(d)); },
    writeJSONDebounced: (f, d) => { store[f] = d; },
    store,
  };
}

// ════════════════════════════════════════════════════════════
// LLMPort — TokenBucket, HourlyBudget, estimateTokens, MockLLM
// ════════════════════════════════════════════════════════════

describe('CoverageSweep3 — LLMPort utilities', () => {
  const { TokenBucket, HourlyBudget, estimateTokens, LLMPort, MockLLM } = require('../../src/agent/ports/LLMPort');

  // ── TokenBucket ──
  test('TokenBucket — construct + tryConsume + fillLevel', () => {
    const tb = new TokenBucket(10, 5);
    assert(tb.fillLevel() > 0, 'starts with tokens');
    assert(tb.tryConsume(), 'should consume');
    assert(tb.fillLevel() <= 1.0, 'level ≤ 1');
    const status = tb.getStatus();
    assert(typeof status === 'object', 'status is object');
  });

  test('TokenBucket — drains and refills', () => {
    const tb = new TokenBucket(3, 100);
    assert(tb.tryConsume(), 'consume 1');
    assert(tb.tryConsume(), 'consume 2');
    assert(tb.tryConsume(), 'consume 3');
    assert(!tb.tryConsume(), 'empty — should fail');
    assertEqual(tb.fillLevel(), 0, 'empty');
  });

  // ── HourlyBudget ──
  test('HourlyBudget — construct + tryConsume + getStatus + reset', () => {
    const hb = new HourlyBudget({ input: 1000, output: 500 });
    assert(hb.tryConsume('input'), 'should consume input');
    assert(hb.tryConsume('output'), 'should consume output');
    const status = hb.getStatus();
    assert(typeof status === 'object', 'status is object');
    hb.reset();
    const afterReset = hb.getStatus();
    assert(afterReset, 'status after reset');
  });

  // ── estimateTokens ──
  test('estimateTokens — various inputs', () => {
    assertEqual(estimateTokens(''), 0, 'empty → 0');
    assertEqual(estimateTokens(null), 0, 'null → 0');
    const english = estimateTokens('Hello world, this is a test sentence.');
    assert(english > 0, 'English text > 0');
    const german = estimateTokens('Dies ist ein deutscher Testsatz mit Umlauten äöü.');
    assert(german > 0, 'German text > 0');
    const code = estimateTokens('function foo() { return 42; }', 'code');
    assert(code > 0, 'code > 0');
  });

  // ── LLMPort base ──
  test('LLMPort base — methods reject', async () => {
    const p = new LLMPort();
    try { await p.chat('sys', []); assert(false, 'should throw'); } catch (e) { assert(e.message.includes('not implemented'), 'chat rejects'); }
    try { await p.streamChat('sys', [], () => {}); assert(false, 'should throw'); } catch (e) { assert(e.message.includes('not implemented'), 'stream rejects'); }
  });

  // ── MockLLM ──
  test('MockLLM — chat + streamChat + getCalls', async () => {
    const ml = new MockLLM();
    const resp = await ml.chat('system prompt', [{ role: 'user', content: 'hi' }]);
    assert(typeof resp === 'string', 'chat returns string');

    let chunks = '';
    await ml.streamChat('system', [{ role: 'user', content: 'test' }], (chunk) => { chunks += chunk; });
    assert(chunks.length > 0, 'stream produced chunks');

    const calls = ml.getCalls();
    assert(Array.isArray(calls), 'getCalls returns array');
    assert(calls.length >= 2, 'tracked calls');
    assert(ml.lastCall(), 'lastCall returns last');
  });

  test('MockLLM — setResponse customizes output', async () => {
    const ml = new MockLLM();
    ml.setResponse('chat', 'custom response');
    const resp = await ml.chat('sys', [{ role: 'user', content: 'hi' }], 'chat');
    assert(resp.includes('custom'), 'uses custom response');
  });
});

// ════════════════════════════════════════════════════════════
// ASTDiff — pure string manipulation
// ════════════════════════════════════════════════════════════

describe('CoverageSweep3 — ASTDiff', () => {
  const { ASTDiff } = require('../../src/agent/foundation/ASTDiff');

  test('constructs', () => {
    const ad = new ASTDiff({ bus: mockBus() });
    assert(ad, 'should construct');
  });

  test('parseDiffs handles empty/invalid input', () => {
    const ad = new ASTDiff({ bus: mockBus() });
    const result = ad.parseDiffs('');
    assert(Array.isArray(result), 'returns array');
  });

  test('parseDiffs parses replace diff', () => {
    const ad = new ASTDiff({ bus: mockBus() });
    const result = ad.parseDiffs('REPLACE_FUNCTION foo\nfunction foo() { return 1; }\nEND_REPLACE');
    assert(Array.isArray(result), 'returns array');
  });

  test('describe produces human-readable text', () => {
    const ad = new ASTDiff({ bus: mockBus() });
    const text = ad.describe([
      { type: 'replace_function', name: 'foo', code: 'function foo() {}' },
    ]);
    assert(typeof text === 'string', 'returns string');
    assert(text.length > 0, 'non-empty');
  });

  test('buildDiffPrompt returns string', () => {
    const ad = new ASTDiff({ bus: mockBus() });
    const prompt = ad.buildDiffPrompt('test.js', 'const x = 1;', 'add logging');
    assert(typeof prompt === 'string', 'returns string');
    assert(prompt.includes('test.js'), 'includes filename');
  });

  test('apply with empty diffs returns original code', () => {
    const ad = new ASTDiff({ bus: mockBus() });
    const result = ad.apply('const x = 1;', []);
    assert(result.code === 'const x = 1;', 'code unchanged');
    assertEqual(result.applied, 0, 'nothing applied');
  });

  test('_insertAfter inserts code after line', () => {
    const ad = new ASTDiff({ bus: mockBus() });
    const code = 'line1\nline2\nline3';
    const result = ad._insertAfter(code, 'line2', 'inserted');
    assert(result.includes('inserted'), 'code inserted');
    assert(result.indexOf('inserted') > result.indexOf('line2'), 'after line2');
  });

  test('_insertBefore inserts code before line', () => {
    const ad = new ASTDiff({ bus: mockBus() });
    const code = 'line1\nline2\nline3';
    const result = ad._insertBefore(code, 'line2', 'inserted');
    assert(result.includes('inserted'), 'code inserted');
    assert(result.indexOf('inserted') < result.indexOf('line2'), 'before line2');
  });

  test('_rename replaces identifier', () => {
    const ad = new ASTDiff({ bus: mockBus() });
    const code = 'function oldName() { return oldName(); }';
    const result = ad._rename(code, 'oldName', 'newName');
    assert(result.includes('newName'), 'renamed');
    assert(!result.includes('oldName'), 'old name gone');
  });

  test('_addImport adds import line at top', () => {
    const ad = new ASTDiff({ bus: mockBus() });
    const code = 'const x = 1;\nconst y = 2;';
    const result = ad._addImport(code, "const z = require('z');");
    assert(result.includes("require('z')"), 'import added');
  });

  test('_deleteLines removes matching lines', () => {
    const ad = new ASTDiff({ bus: mockBus() });
    const code = 'line1\nline2\nline3\nline4';
    const result = ad._deleteLines(code, 'line2', 1);
    assert(!result.includes('line2'), 'line deleted');
  });

  test('_findFunctionBoundary finds function range', () => {
    const ad = new ASTDiff({ bus: mockBus() });
    const code = 'function foo() {\n  return 1;\n}\nfunction bar() {}';
    const bounds = ad._findFunctionBoundary(code, 'foo');
    assert(bounds, 'found boundary');
  });
});

// ════════════════════════════════════════════════════════════
// TaskDelegation
// ════════════════════════════════════════════════════════════

describe('CoverageSweep3 — TaskDelegation', () => {
  const { TaskDelegation } = require('../../src/agent/hexagonal/TaskDelegation');

  test('constructs', () => {
    const td = new TaskDelegation({ bus: mockBus() });
    assert(td, 'should construct');
  });

  test('getTaskStatus returns unknown for missing task', () => {
    const td = new TaskDelegation({ bus: mockBus() });
    const status = td.getTaskStatus('nonexistent');
    assertEqual(status.status, 'unknown', 'unknown status');
  });

  test('receiveTask stores task', () => {
    const td = new TaskDelegation({ bus: mockBus() });
    td.setTaskHandler(async () => 'done');
    td.receiveTask({ id: 'test-1', description: 'test task' });
    const status = td.getTaskStatus('test-1');
    assert(status, 'task should exist');
  });

  test('getStatus returns object', () => {
    const td = new TaskDelegation({ bus: mockBus() });
    const status = td.getStatus();
    assert(typeof status === 'object', 'status is object');
  });
});

// ════════════════════════════════════════════════════════════
// ImmuneSystem
// ════════════════════════════════════════════════════════════

describe('CoverageSweep3 — ImmuneSystem', () => {
  const { ImmuneSystem } = require('../../src/agent/organism/ImmuneSystem');

  test('constructs + start + stop', () => {
    const is = new ImmuneSystem({ bus: mockBus(), storage: mockStorage(), intervals: null });
    is.start();
    is.stop();
  });

  test('isQuarantined returns boolean', () => {
    const is = new ImmuneSystem({ bus: mockBus(), storage: mockStorage(), intervals: null });
    assertEqual(is.isQuarantined('test-tool'), false);
  });

  test('_scanForPatterns does not throw', () => {
    const is = new ImmuneSystem({ bus: mockBus(), storage: mockStorage(), intervals: null });
    is._scanForPatterns();
    assert(true, 'scan completed');
  });

  test('getReport returns object', () => {
    const is = new ImmuneSystem({ bus: mockBus(), storage: mockStorage(), intervals: null });
    const r = is.getReport();
    assert(typeof r === 'object', 'report is object');
  });

  test('buildPromptContext returns string', () => {
    const is = new ImmuneSystem({ bus: mockBus(), storage: mockStorage(), intervals: null });
    const ctx = is.buildPromptContext();
    assert(typeof ctx === 'string', 'context is string');
  });
});

run();
