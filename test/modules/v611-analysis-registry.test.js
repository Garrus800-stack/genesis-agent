// Test: v6.1.1 Coverage Sweep — Analysis + Registry modules
// Targets: Reflector, CodeAnalyzer, SelfOptimizer, ModuleRegistry

const { describe, test, assert, assertEqual, run } = require('../harness');

function mockBus() { return { on: () => () => {}, emit() {}, fire() {}, off() {} }; }

// ── Reflector ───────────────────────────────────────────────

describe('Reflector — diagnose', () => {
  const { Reflector } = require('../../src/agent/planning/Reflector');
  const _fs = require('fs');
  const _path = require('path');
  const _os = require('os');

  function _tmpDir() {
    const d = _path.join(_os.tmpdir(), `genesis-reflector-${Date.now()}-${Math.random().toString(36).slice(2,8)}`);
    _fs.mkdirSync(d, { recursive: true });
    return d;
  }

  function createReflector(overrides = {}) {
    const rootDir = overrides.rootDir || _tmpDir();
    return new Reflector(
      overrides.selfModel || {
        getFullModel: () => ({
          modules: overrides.modules || {},
          files: overrides.files || {},
        }),
        rootDir,
      },
      overrides.model || { chat: async () => 'fixed code' },
      overrides.prompts || { build: () => 'prompt', focusCode: (c) => c },
      overrides.sandbox || { syntaxCheck: async () => ({ valid: true }) },
      overrides.guard || { isProtected: () => false, verifyIntegrity: () => ({ ok: true, issues: [] }), validateWrite: () => {} },
    );
  }

  test('diagnose returns clean result when no modules', async () => {
    const r = createReflector();
    const result = await r.diagnose();
    assertEqual(result.issues.length, 0);
    assertEqual(result.scannedModules, 0);
  });

  test('diagnose detects kernel integrity failure', async () => {
    const r = createReflector({
      guard: {
        isProtected: () => false,
        verifyIntegrity: () => ({ ok: false, issues: [{ file: 'kernel.js', issue: 'tampered' }] }),
        validateWrite: () => {},
      },
    });
    const result = await r.diagnose();
    assert(result.issues.length > 0, 'should find kernel issue');
    assertEqual(result.issues[0].type, 'kernel');
    assertEqual(result.issues[0].severity, 'critical');
  });

  test('diagnose detects syntax errors in real file', async () => {
    const dir = _tmpDir();
    _fs.writeFileSync(_path.join(dir, 'bad.js'), 'function( { broken', 'utf-8');
    const r = createReflector({
      rootDir: dir,
      modules: { 'bad.js': { requires: [] } },
      files: { 'bad.js': { lines: 1 } },
      sandbox: { syntaxCheck: async () => ({ valid: false, error: 'Unexpected token' }) },
    });
    const result = await r.diagnose();
    const syntaxIssues = result.issues.filter(i => i.type === 'syntax');
    assert(syntaxIssues.length > 0, 'should find syntax issues');
  });

  test('suggestOptimizations finds large files', () => {
    const r = createReflector({
      modules: { 'src/big.js': { requires: ['a', 'b', 'c', 'd', 'e', 'f', 'g'] } },
      files: { 'src/big.js': { lines: 500 } },
    });
    const suggestions = r.suggestOptimizations();
    assert(suggestions.length >= 2, 'should suggest for large file + many deps');
    assert(suggestions.some(s => s.type === 'complexity'), 'should flag complexity');
    assert(suggestions.some(s => s.type === 'coupling'), 'should flag coupling');
  });

  test('repair handles kernel issues as unrepairable', async () => {
    const r = createReflector();
    const results = await r.repair([{ type: 'kernel', file: 'k.js' }]);
    assertEqual(results[0].fixed, false);
  });

  test('repair handles missing-dependency issues', async () => {
    const r = createReflector();
    const results = await r.repair([{ type: 'missing-dependency', file: 'x.js', detail: 'missing' }]);
    assertEqual(results[0].fixed, false);
  });

  test('repair handles unknown issue types', async () => {
    const r = createReflector();
    const results = await r.repair([{ type: 'alien', file: 'y.js' }]);
    assertEqual(results[0].fixed, false);
  });
});

// ── CodeAnalyzer ────────────────────────────────────────────

describe('CodeAnalyzer — analyze routing', () => {
  const { CodeAnalyzer } = require('../../src/agent/intelligence/CodeAnalyzer');

  function createAnalyzer() {
    return new CodeAnalyzer(
      {
        readModule: (f) => f === 'test.js' ? 'function hello() { return 1; }' : null,
        getFileTree: () => [{ path: 'test.js' }],
        getModuleSummary: () => ({ modules: 1 }),
      },
      { chat: async (prompt) => 'LLM analysis result' },
      { build: (t, d) => `prompt:${t}`, focusCode: (code, fn) => code },
    );
  }

  test('analyze routes file reference to _analyzeFile', async () => {
    const a = createAnalyzer();
    const result = await a.analyze('analyze file test.js');
    assert(result === 'LLM analysis result', 'should call LLM for file analysis');
  });

  test('analyze routes inline code to _analyzeInlineCode', async () => {
    const a = createAnalyzer();
    const result = await a.analyze('check this:\n```js\nconst x = 1;\n```');
    assert(result === 'LLM analysis result', 'should call LLM for inline analysis');
  });

  test('analyze falls back to _analyzeOwnCode', async () => {
    const a = createAnalyzer();
    const result = await a.analyze('how is the architecture?');
    assert(result === 'LLM analysis result', 'should call LLM for general analysis');
  });

  test('_analyzeFile returns file list when file not found', async () => {
    const a = createAnalyzer();
    const result = await a.analyze('analyze file unknown.js');
    assert(result.includes('not found'), 'should indicate file not found');
    assert(result.includes('test.js'), 'should list available files');
  });

  test('compareWith compares own code with alternative', async () => {
    const a = createAnalyzer();
    const result = await a.compareWith('test.js', 'function better() {}', 'test');
    assert(result === 'LLM analysis result', 'should return comparison');
  });

  test('compareWith returns error for missing file', async () => {
    const a = createAnalyzer();
    const result = await a.compareWith('missing.js', 'code', 'ctx');
    assert(result.includes('not found'), 'should indicate not found');
  });
});

// ── SelfOptimizer ───────────────────────────────────────────

describe('SelfOptimizer — analysis methods', () => {
  const { SelfOptimizer } = require('../../src/agent/planning/SelfOptimizer');

  function createOptimizer(metrics = {}) {
    const opt = new SelfOptimizer({
      bus: mockBus(),
      eventStore: null,
      memory: null,
      goalStack: null,
      storageDir: '/tmp',
      storage: null,
    });
    opt.metrics = {
      responses: metrics.responses || [],
      errors: metrics.errors || [],
      analysisCount: 0,
    };
    return opt;
  }

  test('analyze returns report with all sections', async () => {
    const opt = createOptimizer();
    const report = await opt.analyze();
    assert(report.responseQuality !== undefined, 'should have responseQuality');
    assert(report.errorPatterns !== undefined, 'should have errorPatterns');
    assert(report.intentAccuracy !== undefined, 'should have intentAccuracy');
    assert(report.topicCoverage !== undefined, 'should have topicCoverage');
    assert(Array.isArray(report.recommendations), 'should have recommendations');
  });

  test('_analyzeResponseQuality with no data', () => {
    const opt = createOptimizer();
    const result = opt._analyzeResponseQuality();
    assertEqual(result.avgLength, 0);
    assertEqual(result.total, 0);
  });

  test('_analyzeResponseQuality computes averages', () => {
    const opt = createOptimizer({
      responses: [
        { respLength: 100, hasCode: true, success: true, intent: 'code' },
        { respLength: 200, hasCode: false, success: true, intent: 'chat' },
      ],
    });
    const result = opt._analyzeResponseQuality();
    assertEqual(result.avgLength, 150);
    assertEqual(result.total, 2);
  });

  test('_analyzeErrors computes error rate', () => {
    const opt = createOptimizer({
      responses: [
        { success: true, intent: 'a' },
        { success: false, intent: 'b' },
        { success: true, intent: 'c' },
        { success: false, intent: 'd' },
      ],
      errors: [{ message: 'TypeError: x' }, { message: 'TypeError: y' }],
    });
    const result = opt._analyzeErrors();
    assertEqual(result.errorRate, 0.5);
    assertEqual(result.totalErrors, 2);
    assert(result.commonPatterns.length > 0, 'should find patterns');
  });

  test('_analyzeIntents computes unknownRate', () => {
    const opt = createOptimizer({
      responses: [
        { intent: 'code', success: true },
        { intent: 'general', success: true },
        { intent: 'general', success: true },
      ],
    });
    const result = opt._analyzeIntents();
    assert(result.unknownRate > 0.6, 'should detect high general rate');
    assert(result.distribution.general === 2, 'should count general');
  });

  test('_analyzeTopics finds gaps', () => {
    const opt = createOptimizer({
      responses: [
        { intent: 'code', success: false },
        { intent: 'code', success: false },
        { intent: 'code', success: false },
        { intent: 'chat', success: true },
      ],
    });
    const result = opt._analyzeTopics();
    assert(result.gaps.includes('code'), 'should flag code as gap');
  });

  test('analyze generates recommendations for short responses', async () => {
    const opt = createOptimizer({
      responses: [{ respLength: 10, hasCode: false, success: true, intent: 'chat' }],
    });
    const report = await opt.analyze();
    assert(report.recommendations.some(r => r.area === 'response-depth'), 'should recommend more depth');
  });

  test('getLatestReport and buildContext', async () => {
    const opt = createOptimizer();
    await opt.analyze();
    const report = opt.getLatestReport();
    assert(report !== null, 'should have latest report');
    const ctx = opt.buildContext();
    assert(typeof ctx === 'string', 'should return context string');
  });

  test('_trackQuality records response', () => {
    const opt = createOptimizer();
    opt._trackQuality({ message: 'hello', response: 'hi there!', intent: 'chat', success: true });
    assertEqual(opt.metrics.responses.length, 1);
    assertEqual(opt.metrics.responses[0].intent, 'chat');
  });

  test('_trackError records error', () => {
    const opt = createOptimizer();
    opt._trackError({ message: 'something broke' });
    assertEqual(opt.metrics.errors.length, 1);
  });
});

// ── ModuleRegistry ──────────────────────────────────────────

describe('ModuleRegistry — registration and validation', () => {
  const { ModuleRegistry } = require('../../src/agent/revolution/ModuleRegistry');

  function createRegistry() {
    return new ModuleRegistry(
      { has: (n) => false, resolve: () => ({}), register: () => {} },
      mockBus(),
    );
  }

  test('register adds to manifest', () => {
    const reg = createRegistry();
    class TestModule {}
    reg.register('test', TestModule, { phase: 3, deps: [], tags: ['test'] });
    const manifest = reg.getManifest();
    assert(manifest.test !== undefined, 'should be in manifest');
    assertEqual(manifest.test.phase, 3);
  });

  test('registerSelf uses static containerConfig', () => {
    const reg = createRegistry();
    class SelfModule { static containerConfig = { name: 'selfMod', phase: 5, deps: [], tags: [], lateBindings: [] }; }
    reg.registerSelf(SelfModule);
    assert(reg.getManifest().selfMod !== undefined, 'should register from containerConfig');
  });

  test('registerSelf throws without containerConfig', () => {
    const reg = createRegistry();
    class NoConfig {}
    let threw = false;
    try { reg.registerSelf(NoConfig); } catch { threw = true; }
    assert(threw, 'should throw');
  });

  test('validate detects missing deps', () => {
    const reg = createRegistry();
    class A {}
    reg.register('a', A, { phase: 1, deps: ['nonexistent'], tags: [] });
    const issues = reg.validate();
    assert(issues.length > 0, 'should find missing dep');
    assert(issues[0].includes('nonexistent'), 'should name the missing dep');
  });

  test('validate detects phase ordering violations', () => {
    const reg = createRegistry();
    class Early {}
    class Late {}
    reg.register('early', Early, { phase: 1, deps: ['late'], tags: [] });
    reg.register('late', Late, { phase: 5, deps: [], tags: [] });
    const issues = reg.validate();
    assert(issues.some(i => i.includes('phase ordering')), 'should detect phase violation');
  });

  test('validate passes for clean manifest', () => {
    const reg = createRegistry();
    class A {}
    class B {}
    reg.register('a', A, { phase: 1, deps: [], tags: [] });
    reg.register('b', B, { phase: 2, deps: ['a'], tags: [] });
    const issues = reg.validate();
    assertEqual(issues.length, 0);
  });

  test('getManifest includes late binding info', () => {
    const reg = createRegistry();
    class X {}
    reg.register('x', X, { phase: 1, deps: [], tags: [], lateBindings: [{ target: 'y', property: 'z' }] });
    const manifest = reg.getManifest();
    assert(manifest.x.lateBindings[0] === 'y.z', 'should format late binding');
  });
});

run();
