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
    // v7.5.9 ZIP1 Phase 6: cache-hits NO LONGER count against budget.
    // Only the first read does I/O and counts. The second read is free.
    assert.strictEqual(budget.turnCount, 1, 'only first read counts');
    assert.strictEqual(budget.sessionCount, 1, 'only first read counts (session)');
  });

  test('hard-per-turn limit blocks further reads (returns null)', () => {
    const m = makeModel();
    // v7.5.9 ZIP1 Phase 6: defaults raised to softPerTurn:15 / hardPerTurn:30.
    // Cache-hits don't count, so we need 30 DISTINCT reads to hit the cap.
    // Build a list of 30 distinct .js files from src/agent/core + foundation.
    const root = path.resolve(__dirname, '../../');
    const distinctFiles = [];
    for (const subdir of ['src/agent/core', 'src/agent/foundation', 'src/agent/intelligence']) {
      const fullDir = path.join(root, subdir);
      if (!fs.existsSync(fullDir)) continue;
      for (const f of fs.readdirSync(fullDir)) {
        if (f.endsWith('.js')) distinctFiles.push(path.join(subdir, f));
        if (distinctFiles.length >= 30) break;
      }
      if (distinctFiles.length >= 30) break;
    }
    assert(distinctFiles.length >= 30, `need 30 distinct files, got ${distinctFiles.length}`);

    for (let i = 0; i < 30; i++) {
      m.readSourceSync(distinctFiles[i]);
    }
    // Now the 31st DISTINCT read must be blocked.
    const blocked = m.readSourceSync('CHANGELOG.md');
    assert.strictEqual(blocked, null, '31st read should be blocked');
  });

  test('hard-per-session limit blocks across turns', () => {
    const m = makeModel();
    // v7.5.9 ZIP1 Phase 6: defaults raised to hardPerSession:100. Plus cache
    // hits don't count. We need 100 DISTINCT (uncached) reads across turns.
    // Read .js files from multiple agent subfolders to get enough distinct paths.
    const dirs = ['core', 'foundation', 'intelligence', 'cognitive', 'capabilities'];
    const allFiles = [];
    for (const d of dirs) {
      const fullDir = path.join(__dirname, '../../src/agent', d);
      if (!fs.existsSync(fullDir)) continue;
      for (const f of fs.readdirSync(fullDir)) {
        if (f.endsWith('.js')) allFiles.push(path.join('src/agent', d, f));
        if (allFiles.length >= 100) break;
      }
      if (allFiles.length >= 100) break;
    }
    assert(allFiles.length >= 100, `need 100 distinct files, found ${allFiles.length}`);

    for (let i = 0; i < 100; i++) {
      m.startReadSourceTurn(`turn-${i}`);
      m.readSourceSync(allFiles[i]);
    }
    m.startReadSourceTurn('turn-101');
    const blocked = m.readSourceSync('CHANGELOG.md');
    assert.strictEqual(blocked, null, '101st read in session should be blocked');
  });

  test('startReadSourceTurn resets per-turn counter', () => {
    const m = makeModel();
    // v7.5.9 ZIP1 Phase 6: cache-hits don't count, so reading same file 8x
    // counts as 1. Use 8 different files to get turnCount=8.
    const files = ['package.json', 'README.md', 'CHANGELOG.md', 'AUDIT-BACKLOG.md',
      'LICENSE', 'src/kernel/SafeGuard.js', 'src/agent/AgentCore.js',
      'src/agent/AgentCoreBoot.js'];
    for (const f of files) {
      m.readSourceSync(f);
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
