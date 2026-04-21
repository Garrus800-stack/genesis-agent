// ============================================================
// v7.3.6 #9 — Source-Read synchronous in chat
//
// Tests:
//   - SafeGuard.validateRead (new method)
//   - SelfModel.readSourceSync (budget, cache, event, truncation)
//   - ToolRegistry 'read-source' tool integration
// ============================================================

const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

const { describe, test, run } = require('../harness');

describe('#9 SafeGuard.validateRead', () => {
  const { SafeGuard } = require('../../src/kernel/SafeGuard');

  function makeGuard() {
    // Use the real repo root so the rules are realistic
    const root = path.resolve(__dirname, '../../');
    const guard = new SafeGuard([path.join(root, 'src/kernel')], root);
    return { guard, root };
  }

  test('validateRead allows normal file inside root', () => {
    const { guard, root } = makeGuard();
    assert.strictEqual(
      guard.validateRead(path.join(root, 'src/agent/foundation/SelfModel.js')),
      true
    );
  });

  test('validateRead allows reading kernel files (unlike validateWrite)', () => {
    const { guard, root } = makeGuard();
    // This is the key distinction from validateWrite — reading own kernel is OK
    assert.strictEqual(
      guard.validateRead(path.join(root, 'src/kernel/SafeGuard.js')),
      true
    );
  });

  test('validateRead blocks paths outside root (Path-Escape defence)', () => {
    const { guard } = makeGuard();
    assert.throws(
      () => guard.validateRead('/etc/passwd'),
      /outside project root/
    );
  });

  test('validateRead blocks .git/ internals', () => {
    const { guard, root } = makeGuard();
    assert.throws(
      () => guard.validateRead(path.join(root, '.git/config')),
      /\.git internals/
    );
  });

  test('validateRead blocks node_modules', () => {
    const { guard, root } = makeGuard();
    assert.throws(
      () => guard.validateRead(path.join(root, 'node_modules/some-pkg/index.js')),
      /node_modules/
    );
  });

  test('validateRead resolves relative traversal attempts', () => {
    const { guard, root } = makeGuard();
    // Path-traversal via ../../ out of root
    assert.throws(
      () => guard.validateRead(path.join(root, '../../etc/passwd')),
      /outside project root/
    );
  });
});

describe('#9 SelfModel.readSourceSync — budget + cache', () => {
  const { SelfModel } = require('../../src/agent/foundation/SelfModel');
  const { SafeGuard } = require('../../src/kernel/SafeGuard');

  function makeModel() {
    const root = path.resolve(__dirname, '../../');
    const guard = new SafeGuard([path.join(root, 'src/kernel')], root);
    return new SelfModel(root, guard);
  }

  test('reads existing file inside root', () => {
    const m = makeModel();
    const content = m.readSourceSync('src/agent/foundation/SelfModel.js');
    assert(content, 'should return content');
    assert(content.includes('class SelfModel'), 'should include class declaration');
  });

  test('returns null for non-existent file', () => {
    const m = makeModel();
    const content = m.readSourceSync('does-not-exist-xyz-123.js');
    assert.strictEqual(content, null);
  });

  test('returns null on validateRead failure (outside root)', () => {
    const m = makeModel();
    const content = m.readSourceSync('/etc/passwd');
    assert.strictEqual(content, null);
  });

  test('caches within session — second read is cache hit', () => {
    const m = makeModel();
    const first = m.readSourceSync('package.json');
    const second = m.readSourceSync('package.json');
    assert.strictEqual(first, second, 'same content returned');
    const budget = m.getReadSourceBudget();
    assert.strictEqual(budget.cacheSize, 1, 'cache has exactly 1 entry');
    // But both calls still counted for budget purposes
    assert.strictEqual(budget.turnCount, 2);
  });

  test('hard-per-turn limit blocks further reads (returns null)', () => {
    const m = makeModel();
    // Do 10 successful reads of different paths by artificial key
    // Since we only have finite real files, read package.json then 9 more
    // from cache (but cache hits still count against budget).
    for (let i = 0; i < 10; i++) {
      m.readSourceSync('package.json');
    }
    const blocked = m.readSourceSync('package.json');
    assert.strictEqual(blocked, null, '11th read should be blocked');
  });

  test('hard-per-session limit blocks across turns', () => {
    const m = makeModel();
    for (let i = 0; i < 20; i++) {
      m.startReadSourceTurn(`turn-${i}`);
      m.readSourceSync('package.json');
    }
    m.startReadSourceTurn('turn-21');
    const blocked = m.readSourceSync('package.json');
    assert.strictEqual(blocked, null, '21st read in session should be blocked');
  });

  test('startReadSourceTurn resets per-turn counter', () => {
    const m = makeModel();
    for (let i = 0; i < 8; i++) {
      m.readSourceSync('package.json');
    }
    let b = m.getReadSourceBudget();
    assert.strictEqual(b.turnCount, 8);
    m.startReadSourceTurn('new-turn');
    b = m.getReadSourceBudget();
    assert.strictEqual(b.turnCount, 0, 'turn counter reset');
    // But session count persists
    assert.strictEqual(b.sessionCount, 8);
  });

  test('resetReadSourceSession clears everything', () => {
    const m = makeModel();
    m.readSourceSync('package.json');
    m.readSourceSync('README.md');
    let b = m.getReadSourceBudget();
    assert(b.sessionCount > 0);
    assert(b.cacheSize > 0);
    m.resetReadSourceSession();
    b = m.getReadSourceBudget();
    assert.strictEqual(b.sessionCount, 0);
    assert.strictEqual(b.turnCount, 0);
    assert.strictEqual(b.cacheSize, 0);
  });

  test('fires read-source:called event on bus', () => {
    const m = makeModel();
    const events = [];
    const bus = {
      fire: (event, payload) => events.push({ event, payload }),
    };
    m.startReadSourceTurn('my-turn-id');
    m.readSourceSync('package.json', { bus });
    assert.strictEqual(events.length, 1, 'exactly one event');
    assert.strictEqual(events[0].event, 'read-source:called');
    assert(events[0].payload.path.includes('package.json'), 'payload has path');
    assert(typeof events[0].payload.bytes === 'number', 'payload has bytes');
    assert.strictEqual(events[0].payload.turnId, 'my-turn-id', 'turnId propagated');
  });

  test('cache hit does NOT re-fire event (disk not touched)', () => {
    const m = makeModel();
    const events = [];
    const bus = { fire: (e, p) => events.push({ e, p }) };
    m.readSourceSync('package.json', { bus });
    m.readSourceSync('package.json', { bus });  // cache hit
    assert.strictEqual(events.length, 1, 'cache hit should not fire event');
  });

  test('truncates files over 20 KB with marker', () => {
    const m = makeModel();
    // Create a temp large file via writing a huge fixture? Too heavy.
    // Instead, just verify the cap by shrinking it temporarily.
    m._readSourceBudget.maxFileBytes = 100;  // shrink for test
    const content = m.readSourceSync('package.json');
    assert(content, 'content returned');
    assert(content.includes('[... truncated,'), 'truncation marker present');
    assert(content.length <= 100 + 200, 'truncated size within cap + marker');
  });
});

describe('#9 ToolRegistry read-source tool', () => {
  const { ToolRegistry } = require('../../src/agent/intelligence/ToolRegistry');
  const { SelfModel } = require('../../src/agent/foundation/SelfModel');
  const { SafeGuard } = require('../../src/kernel/SafeGuard');

  function makeRegistry() {
    const root = path.resolve(__dirname, '../../');
    const guard = new SafeGuard([path.join(root, 'src/kernel')], root);
    const selfModel = new SelfModel(root, guard);
    const bus = { fire: () => {}, on: () => () => {}, emit: () => {} };
    const registry = new ToolRegistry({ bus });
    registry.registerBuiltins({ selfModel });
    return { registry, selfModel };
  }

  test('read-source tool is registered', () => {
    const { registry } = makeRegistry();
    assert(registry.tools.has('read-source'), 'tool should be registered');
  });

  test('read-source returns {code, truncated, blocked} shape', async () => {
    const { registry } = makeRegistry();
    const results = await registry.executeToolCalls([
      { name: 'read-source', input: { file: 'package.json' } }
    ]);
    assert.strictEqual(results.length, 1);
    const r = results[0];
    assert(r.success, `should succeed, got error: ${r.error}`);
    assert(typeof r.result.code === 'string');
    assert(typeof r.result.truncated === 'boolean');
    assert(typeof r.result.blocked === 'boolean');
    assert(r.result.code.length > 0, 'content non-empty');
    assert.strictEqual(r.result.blocked, false);
  });

  test('read-source returns blocked=true for path outside root', async () => {
    const { registry } = makeRegistry();
    const results = await registry.executeToolCalls([
      { name: 'read-source', input: { file: '/etc/passwd' } }
    ]);
    const r = results[0];
    assert(r.success, 'tool call should not throw');
    assert.strictEqual(r.result.blocked, true);
    assert.strictEqual(r.result.code, '');
  });
});

run();
