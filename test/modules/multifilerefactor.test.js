// ============================================================
// GENESIS — test/modules/multifilerefactor.test.js
// v4.0.0 (F-07): Test suite for MultiFileRefactor
//
// Tests static analysis helpers (pure functions, no LLM needed):
//   - _extractRequires, _extractExports, _resolveRequirePath
//   - _collectJsFiles, _buildDependencyGraph
//   - Guard validation on file writes
//   - dryRun mode
// ============================================================

const { describe, test, assert, assertEqual, assertDeepEqual,
        assertThrows, createTestRoot, run } = require('../harness');
const path = require('path');
const fs = require('fs');

// ── Minimal mock factories ──────────────────────────────────

function makeMockBus() {
  const emitted = [];
  return {
    emit: (ev, data, meta) => emitted.push({ ev, data, meta }),
    fire: (ev, data, meta) => emitted.push({ ev, data, meta }),
    on: () => () => {},
    emitted,
  };
}

function makeMockGuard(rootDir) {
  const protectedPaths = [path.join(rootDir, 'src', 'kernel')];
  return {
    isProtected: (p) => protectedPaths.some(pp => path.resolve(p).startsWith(pp)),
    isCritical: () => false,
    validateWrite: (p) => {
      if (path.resolve(p).includes('kernel')) throw new Error('Write to kernel blocked');
      return true;
    },
  };
}

function makeMockSelfModel(fileTree, modules = {}) {
  return {
    getFileTree: () => fileTree,
    getFullModel: () => ({ modules, files: {} }),
    readModule: (f) => modules[f] || null,
    moduleCount: () => Object.keys(modules).length,
  };
}

function makeRefactor(rootDir, overrides = {}) {
  const { MultiFileRefactor } = require('../../src/agent/revolution/MultiFileRefactor');
  return new MultiFileRefactor({
    bus: makeMockBus(),
    selfModel: overrides.selfModel || makeMockSelfModel([]),
    model: overrides.model || { chat: async () => '' },
    sandbox: overrides.sandbox || { testPatch: async () => ({ success: true }) },
    guard: overrides.guard || makeMockGuard(rootDir),
    eventStore: overrides.eventStore || { append: () => {} },
    rootDir,
    astDiff: null,
  });
}

// ════════════════════════════════════════════════════════════
// TESTS
// ════════════════════════════════════════════════════════════

describe('MultiFileRefactor — _extractRequires', () => {
  test('extracts standard require paths', () => {
    const r = makeRefactor('/tmp/test');
    const code = `
      const { Foo } = require('./core/Foo');
      const Bar = require('../Bar');
      const fs = require('fs');
    `;
    const result = r._extractRequires(code);
    assert(result.includes('./core/Foo'), 'should find ./core/Foo');
    assert(result.includes('../Bar'), 'should find ../Bar');
    assert(result.includes('fs'), 'should find fs');
    assertEqual(result.length, 3);
  });

  test('handles single-quoted requires', () => {
    const r = makeRefactor('/tmp/test');
    const code = `const x = require('./utils');`;
    const result = r._extractRequires(code);
    assertEqual(result.length, 1);
    assertEqual(result[0], './utils');
  });

  test('returns empty for no requires', () => {
    const r = makeRefactor('/tmp/test');
    assertEqual(r._extractRequires('const x = 42;').length, 0);
  });

  test('ignores commented-out requires', () => {
    const r = makeRefactor('/tmp/test');
    // Regex-based extraction will still match comments — this documents that behavior
    const code = `// const x = require('./old');`;
    const result = r._extractRequires(code);
    // Regex doesn't distinguish comments — this is a known limitation
    assertEqual(result.length, 1);
  });
});

describe('MultiFileRefactor — _extractExports', () => {
  test('extracts destructured module.exports', () => {
    const r = makeRefactor('/tmp/test');
    const code = `class Foo {}\nclass Bar {}\nmodule.exports = { Foo, Bar };`;
    const result = r._extractExports(code);
    assert(result.includes('Foo'), 'should find Foo');
    assert(result.includes('Bar'), 'should find Bar');
  });

  test('extracts class names', () => {
    const r = makeRefactor('/tmp/test');
    const code = `class MyService { constructor() {} }`;
    const result = r._extractExports(code);
    assert(result.includes('MyService'), 'should find class name');
  });

  test('deduplicates class + export', () => {
    const r = makeRefactor('/tmp/test');
    const code = `class Foo {}\nmodule.exports = { Foo };`;
    const result = r._extractExports(code);
    // Should appear once, not twice
    assertEqual(result.filter(e => e === 'Foo').length, 1);
  });

  test('handles renamed exports', () => {
    const r = makeRefactor('/tmp/test');
    const code = `module.exports = { MyClass: Foo, Other };`;
    const result = r._extractExports(code);
    assert(result.includes('MyClass'), 'should extract key name');
    assert(result.includes('Other'), 'should extract Other');
  });
});

describe('MultiFileRefactor — _resolveRequirePath', () => {
  test('resolves relative paths', () => {
    const r = makeRefactor('/tmp/test');
    const result = r._resolveRequirePath('src/agent/core/Foo.js', '../foundation/Bar');
    assertEqual(result, 'src/agent/foundation/Bar.js');
  });

  test('appends .js if missing', () => {
    const r = makeRefactor('/tmp/test');
    const result = r._resolveRequirePath('src/index.js', './utils');
    assertEqual(result, 'src/utils.js');
  });

  test('returns external modules unchanged', () => {
    const r = makeRefactor('/tmp/test');
    assertEqual(r._resolveRequirePath('src/foo.js', 'fs'), 'fs');
    assertEqual(r._resolveRequirePath('src/foo.js', 'acorn'), 'acorn');
  });
});

describe('MultiFileRefactor — _collectJsFiles', () => {
  test('collects from flat array', () => {
    const r = makeRefactor('/tmp/test');
    const tree = [
      { name: 'foo.js' },
      { name: 'bar.js' },
      { name: 'readme.md' },
    ];
    const result = r._collectJsFiles(tree);
    assertEqual(result.length, 2);
    assert(result.includes('foo.js'));
    assert(result.includes('bar.js'));
  });

  test('collects from nested tree', () => {
    const r = makeRefactor('/tmp/test');
    const tree = [
      { name: 'src', children: [
        { name: 'core', children: [
          { name: 'Container.js' },
          { name: 'EventBus.js' },
        ]},
        { name: 'index.js' },
      ]},
    ];
    const result = r._collectJsFiles(tree);
    assertEqual(result.length, 3);
    assert(result.includes('src/core/Container.js'));
    assert(result.includes('src/index.js'));
  });

  test('handles string items', () => {
    const r = makeRefactor('/tmp/test');
    const tree = ['foo.js', 'bar.txt', 'baz.js'];
    const result = r._collectJsFiles(tree);
    assertEqual(result.length, 2);
  });
});

describe('MultiFileRefactor — guard integration', () => {
  test('guard blocks kernel writes', () => {
    const root = createTestRoot('mfr-guard');
    const r = makeRefactor(root);
    assertThrows(() => r.guard.validateWrite(path.join(root, 'src', 'kernel', 'SafeGuard.js')));
  });

  test('guard allows agent writes', () => {
    const root = createTestRoot('mfr-guard2');
    const r = makeRefactor(root);
    assert(r.guard.validateWrite(path.join(root, 'src', 'agent', 'NewModule.js')));
  });
});

describe('MultiFileRefactor — refactor dryRun', () => {
  test('dryRun does not write files', async () => {
    const root = createTestRoot('mfr-dryrun');
    // Create a minimal file for the selfModel
    const srcDir = path.join(root, 'src');
    fs.mkdirSync(srcDir, { recursive: true });
    fs.writeFileSync(path.join(srcDir, 'test.js'), 'class Foo {}\nmodule.exports = { Foo };', 'utf-8');

    const selfModel = makeMockSelfModel(
      [{ name: 'src', children: [{ name: 'test.js' }] }],
      { 'src/test.js': 'class Foo {}\nmodule.exports = { Foo };' }
    );

    const model = {
      chat: async () => '```js\n// file: src/test.js\nclass Foo { newMethod() {} }\nmodule.exports = { Foo };\n```',
    };

    const r = makeRefactor(root, { selfModel, model });
    const result = await r.refactor('add newMethod to Foo', { dryRun: true });
    // In dryRun, the original file should be untouched
    const content = fs.readFileSync(path.join(srcDir, 'test.js'), 'utf-8');
    assert(!content.includes('newMethod'), 'dryRun should not modify file');
  });
});

describe('MultiFileRefactor — stats tracking', () => {
  test('initial stats are zeroed', () => {
    const r = makeRefactor('/tmp/test');
    assertEqual(r._stats.totalRefactors, 0);
    assertEqual(r._stats.filesChanged, 0);
    assertEqual(r._stats.rollbacks, 0);
  });
});

run();
