// ============================================================
// TEST: benchmark-agent.js — V6-9 Agent Benchmark Suite
// ============================================================

const { describe, test, assertEqual, assert, run } = require('../harness');
const { TASKS } = require('../../scripts/benchmark-agent');

describe('Benchmark Tasks — definitions', () => {
  test('all tasks have required fields', () => {
    for (const t of TASKS) {
      assert(t.id, 'Task must have id');
      assert(t.type, 'Task must have type');
      assert(t.title, 'Task must have title');
      assert(t.input, 'Task must have input');
      assert(typeof t.verify === 'function', 'Task must have verify()');
    }
  });

  test('all task ids are unique', () => {
    const ids = TASKS.map(t => t.id);
    assertEqual(new Set(ids).size, ids.length);
  });

  test('task types cover key categories', () => {
    const types = new Set(TASKS.map(t => t.type));
    assert(types.has('code-gen'), 'Should have code-gen');
    assert(types.has('bug-fix'), 'Should have bug-fix');
    assert(types.has('refactoring'), 'Should have refactoring');
    assert(types.has('analysis'), 'Should have analysis');
  });

  test('at least 6 benchmark tasks defined', () => {
    assert(TASKS.length >= 6, `Expected ≥6 tasks, got ${TASKS.length}`);
  });
});

describe('Benchmark Tasks — verify functions', () => {
  test('cg-1 fizzbuzz: accepts valid implementation', () => {
    const task = TASKS.find(t => t.id === 'cg-1');
    const good = 'function fizzbuzz(n) { const r = []; for (let i=1;i<=n;i++) { if(i%15===0) r.push("fizzbuzz"); else if(i%3===0) r.push("fizz"); else if(i%5===0) r.push("buzz"); else r.push(String(i)); } return r; }';
    assert(task.verify(good).pass, 'Should accept valid fizzbuzz');
  });

  test('cg-1 fizzbuzz: rejects empty', () => {
    const task = TASKS.find(t => t.id === 'cg-1');
    assert(!task.verify('').pass, 'Should reject empty');
  });

  test('bf-1 off-by-one: accepts fix starting at 0', () => {
    const task = TASKS.find(t => t.id === 'bf-1');
    const fix = 'function evens(arr) { const result = []; for (let i = 0; i < arr.length; i += 2) { result.push(arr[i]); } return result; }';
    assert(task.verify(fix).pass, 'Should accept i=0 fix');
  });

  test('bf-2 async: accepts await fix', () => {
    const task = TASKS.find(t => t.id === 'bf-2');
    const fix = 'async function getData(url) { const r = await fetch(url); return r.json(); }';
    assert(task.verify(fix).pass, 'Should accept await fix');
  });

  test('rf-1 refactor: accepts extracted functions', () => {
    const task = TASKS.find(t => t.id === 'rf-1');
    const refactored = 'function validateOrder(order) { } function calculateTotal(items) { } function applyDiscounts(total, order) { } function processOrder(order) { validateOrder(order); const t = calculateTotal(order.items); return applyDiscounts(t, order); }';
    assert(task.verify(refactored).pass, 'Should accept 4 functions');
  });

  test('rf-1 refactor: rejects single function', () => {
    const task = TASKS.find(t => t.id === 'rf-1');
    assert(!task.verify('function processOrder(order) { return {}; }').pass, 'Should reject single function');
  });

  test('an-1 analysis: accepts multi-smell detection', () => {
    const task = TASKS.find(t => t.id === 'an-1');
    const analysis = 'SQL injection via string concatenation. God class with too many responsibilities. Cache invalidation not handled — stale data risk.';
    assert(task.verify(analysis).pass, 'Should accept 3 smell categories');
  });

  test('ch-1 chat: accepts reasonable explanation', () => {
    const task = TASKS.find(t => t.id === 'ch-1');
    const explanation = 'The Node.js event loop is a mechanism that handles asynchronous operations. When an async callback completes, it is placed in a queue. The event loop continuously checks this queue and executes pending callbacks when the call stack is empty.';
    assert(task.verify(explanation).pass, 'Should accept valid explanation');
  });

  test('ch-1 chat: rejects too-short response', () => {
    const task = TASKS.find(t => t.id === 'ch-1');
    assert(!task.verify('Event loop handles async.').pass, 'Should reject too-short');
  });
});

run();
