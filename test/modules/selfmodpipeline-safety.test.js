// ============================================================
// Test: SelfModificationPipeline.js — v3.8.0 Expanded Coverage
//
// Covers the critical paths missing from v3.8.0:
//   - Safety scanner integration (block + warn paths)
//   - ASTDiff modify path (success + failure + fallback)
//   - Full-file modify path with patches
//   - Guard validation during writes
//   - Event emissions through pipeline
//   - Multi-patch safety scanning
//   - Error recovery and status cleanup
//
// NOTE: Without acorn, CodeSafetyScanner blocks ALL self-mod
// (fail-safe design). Tests that need to reach past the scanner
// mock it at module level. Tests that verify the scanner's blocking
// behavior use the real scanner.
//
// Existing tests (16) from v3.8.0 are preserved in the original
// selfmodpipeline.test.js. These 28 tests cover the gaps.
// ============================================================

const { describe, test, assert, assertEqual, assertIncludes, run } = require('../harness');
const path = require('path');
const os = require('os');
const fs = require('fs');

// ── Scanner Mock ──────────────────────────────────────────
// Override the cached scanCodeSafety to allow testing paths
// beyond the safety gate. Individual tests that need to verify
// blocking behavior restore the real scanner.
const scannerModule = require('../../src/agent/intelligence/CodeSafetyScanner');
const _realScanCodeSafety = scannerModule.scanCodeSafety;

// Default mock: everything passes (safe: true)
let _scanMockFn = () => ({ safe: true, blocked: [], warnings: [], scanMethod: 'mock' });
scannerModule.scanCodeSafety = function(...args) { return _scanMockFn(...args); };

// Helper to set scanner behavior per test
function mockScannerSafe() { _scanMockFn = () => ({ safe: true, blocked: [], warnings: [], scanMethod: 'mock' }); }
function mockScannerBlock(desc = 'blocked by mock') {
  _scanMockFn = (code, file) => ({
    safe: false,
    blocked: [{ severity: 'block', description: desc, file, source: 'mock', count: 1 }],
    warnings: [],
    scanMethod: 'mock',
  });
}
function mockScannerWarn(desc = 'warning from mock') {
  _scanMockFn = (code, file) => ({
    safe: true,
    blocked: [],
    warnings: [{ severity: 'warn', description: desc, file, source: 'mock', count: 1 }],
    scanMethod: 'mock',
  });
}
function mockScannerReal() { _scanMockFn = _realScanCodeSafety; }

const { SelfModificationPipeline } = require('../../src/agent/hexagonal/SelfModificationPipeline');

// ── Mock Factory ──────────────────────────────────────────

function createMocks(overrides = {}) {
  const events = [];
  const writes = [];
  const tmpRoot = path.join(os.tmpdir(), `genesis-selfmod-test-${Date.now()}`);
  fs.mkdirSync(tmpRoot, { recursive: true });

  const bus = {
    emit: (event, data, meta) => { events.push({ event, data, meta }); },
    fire: (event, data, meta) => { events.push({ event, data, meta }); },
  };

  const selfModel = {
    getFullModel: () => ({
      identity: 'Genesis', version: '3.8.0',
      modules: { AgentCore: 1, Container: 1 },
      files: { 'AgentCore.js': 1, 'Container.js': 1 },
      capabilities: ['chat', 'self-modify'],
    }),
    getModuleSummary: () => [
      { file: 'src/agent/AgentCore.js', classes: ['AgentCore'], functions: 12, protected: false },
    ],
    readModule: (f) => {
      if (f === 'src/agent/Test.js') return 'const x = 1;\nmodule.exports = { x };';
      if (f === 'src/agent/Existing.js') return 'function hello() { return "world"; }';
      return null;
    },
    moduleCount: () => 2,
    getCapabilities: () => ['chat', 'self-modify'],
    scan: async () => {},
    commitSnapshot: async (msg) => { writes.push({ type: 'snapshot', msg }); },
  };

  const model = {
    chat: async (prompt) => 'LLM response: no changes needed',
    activeModel: 'gemma2:9b',
  };

  const sandbox = {
    testPatch: async (file, code) => ({ success: true }),
    execute: async (code) => ({ success: true, output: '' }),
  };

  const guard = {
    validateWrite: (p) => {
      if (p.includes('kernel') || p.includes('main.js')) {
        throw new Error('[SAFEGUARD] Write to protected kernel file blocked');
      }
      return true;
    },
    verifyIntegrity: () => ({ ok: true }),
  };

  const eventStore = {
    _log: [],
    append: (type, data, source) => { eventStore._log.push({ type, data, source }); },
  };

  const hotReloader = {
    _reloaded: [],
    reload: async (file) => { hotReloader._reloaded.push(file); },
  };

  const astDiff = {
    buildDiffPrompt: (file, code, msg) => `diff: ${file} for ${msg}`,
    parseDiffs: (response) => {
      // Default: return empty (no diffs). Override in specific tests.
      return [];
    },
    apply: (code, diffs) => ({ code, applied: 0, errors: [] }),
    describe: (diffs) => `${diffs.length} changes applied`,
  };

  const reasoning = {
    solve: async (task, ctx) => ({ answer: 'reasoning result with no code blocks' }),
  };

  const pipeline = new SelfModificationPipeline({
    lang: { t: (k) => k, detect: () => {}, current: 'en' },
    bus,
    selfModel,
    model,
    prompts: { build: () => 'prompt' },
    sandbox,
    reflector: {
      diagnose: async () => ({ issues: [] }),
      repair: async (issues) => issues.map(i => ({ file: i.file, fixed: true, detail: 'ok' })),
    },
    skills: {
      listSkills: () => [],
      createSkill: async () => 'done',
      executeSkill: async () => 'result',
    },
    cloner: { createClone: async () => 'clone ok' },
    reasoning,
    hotReloader,
    guard,
    tools: { listTools: () => [], hasTool: () => false, register: () => {} },
    eventStore,
    rootDir: tmpRoot,
    astDiff,
    ...overrides,
  });

  // FIX v5.0.0: Bind a mock VerificationEngine. v4.13.2 made _verifyCode()
  // fail-closed when no verifier is bound — tests that need to reach past
  // the verification gate require this late-binding to be satisfied.
  pipeline.verifier = {
    verify: ({ type, file, output, context }) => ({ status: 'pass', issues: [] }),
  };

  // FIX v5.1.0 (DI-1): CodeSafety via port lateBinding.
  // Wraps the test's _scanMockFn so existing mockScannerSafe/Block/Warn helpers work.
  pipeline._codeSafety = {
    scanCode: (code, file) => _scanMockFn(code, file),
    get available() { return true; },
  };

  // v7.2.1 (Adversarial Audit): PreservationInvariants now fail-closed when
  // not bound. Tests that need to reach past the preservation gate need this mock.
  pipeline._preservation = {
    check: (filePath, oldCode, newCode) => ({ safe: true, violations: [] }),
  };

  return { pipeline, bus, events, writes, selfModel, model, sandbox, guard, eventStore, hotReloader, astDiff, reasoning, tmpRoot };
}

// ══════════════════════════════════════════════════════════════
// TEST SUITES
// ══════════════════════════════════════════════════════════════

describe('SelfModPipeline: Safety Scanner Integration', () => {

  test('modify blocks code when scanner rejects (eval-like)', async () => {
    mockScannerBlock('eval() — arbitrary code execution');
    const { pipeline, eventStore, hotReloader } = createMocks();
    pipeline.astDiff.parseDiffs = () => [{ op: 'replace', range: [0, 10], text: 'eval("danger")' }];
    pipeline.astDiff.apply = (code, diffs) => ({
      code: 'eval("danger")', applied: 1, errors: [],
    });
    pipeline.selfModel.readModule = () => 'const x = 1;';
    pipeline.sandbox.testPatch = async () => ({ success: true });

    const result = await pipeline.modify('modify in src/agent/Test.js');
    assert(result.includes('Safety Block') || result.includes('⛔'),
      `Expected safety block message, got: ${result.slice(0, 120)}`);
    assertEqual(hotReloader._reloaded.length, 0, 'No files should be hot-reloaded when safety blocks');
  });

  test('modify logs safety block to eventStore', async () => {
    mockScannerBlock('new Function() detected');
    const { pipeline, eventStore } = createMocks();
    pipeline.astDiff.parseDiffs = () => [{ op: 'replace' }];
    pipeline.astDiff.apply = () => ({
      code: 'new Function("x")', applied: 1, errors: [],
    });
    pipeline.sandbox.testPatch = async () => ({ success: true });
    pipeline.selfModel.readModule = () => 'safe code';

    await pipeline.modify('modify in src/agent/Test.js');
    const safetyEvents = eventStore._log.filter(e => e.type === 'CODE_SAFETY_BLOCK');
    assert(safetyEvents.length >= 1, 'Should log CODE_SAFETY_BLOCK to eventStore');
    assert(safetyEvents[0].data.file || safetyEvents[0].data.files, 'Block event should reference file(s)');
  });

  test('modify emits code:safety-blocked event on block', async () => {
    mockScannerBlock('process.exit detected');
    const { pipeline, events } = createMocks();
    pipeline.astDiff.parseDiffs = () => [{ op: 'replace' }];
    pipeline.astDiff.apply = () => ({
      code: 'process.exit(1)', applied: 1, errors: [],
    });
    pipeline.sandbox.testPatch = async () => ({ success: true });
    pipeline.selfModel.readModule = () => 'safe code';

    await pipeline.modify('modify in src/agent/Test.js');
    const safetyEvents = events.filter(e => e.event === 'code:safety-blocked');
    assert(safetyEvents.length >= 1, 'Should emit code:safety-blocked');
    assert(safetyEvents[0].data.issues, 'Should include issues list');
  });

  test('full-file modify blocks multi-patch when scanner rejects', async () => {
    mockScannerBlock('dangerous pattern');
    const { pipeline, eventStore } = createMocks();
    pipeline.reasoning.solve = async () => ({
      answer: '// FILE: src/agent/Bad.js\n```js\neval("boom")\n```',
    });
    pipeline.sandbox.testPatch = async () => ({ success: true });

    const result = await pipeline.modify('add dangerous module');
    const blocks = eventStore._log.filter(e => e.type === 'CODE_SAFETY_BLOCK');
    assert(blocks.length >= 1, 'Should block multi-patch');
    assert(result.includes('Safety Block') || result.includes('⛔'),
      'Result should indicate safety block');
  });

  test('safety warnings are logged but code is still applied', async () => {
    mockScannerWarn('potential issue but non-blocking');
    const { pipeline, eventStore, hotReloader, tmpRoot } = createMocks();
    const safeCode = 'const path = require("path");\nmodule.exports = { path };';
    pipeline.astDiff.parseDiffs = () => [{ op: 'replace' }];
    pipeline.astDiff.apply = () => ({
      code: safeCode, applied: 1, errors: [],
    });
    pipeline.sandbox.testPatch = async () => ({ success: true });
    pipeline.selfModel.readModule = () => 'old code';

    // Create the target directory so writeFileSync works
    const targetDir = path.join(tmpRoot, 'src', 'agent');
    fs.mkdirSync(targetDir, { recursive: true });

    const result = await pipeline.modify('modify in src/agent/Test.js');
    // Safe code (with warnings) should be applied — no blocks
    const blocks = eventStore._log.filter(e => e.type === 'CODE_SAFETY_BLOCK');
    assertEqual(blocks.length, 0, 'Warnings should not produce safety blocks');
    // Should have applied and reloaded
    assert(hotReloader._reloaded.length >= 1, 'File should be reloaded despite warnings');
    // Warnings should be logged
    const warns = eventStore._log.filter(e => e.type === 'CODE_SAFETY_WARN');
    assert(warns.length >= 1, 'Warnings should be logged to eventStore');
  });

  test('real scanner (no acorn) blocks all self-mod as fail-safe', async () => {
    mockScannerReal();
    const { pipeline, hotReloader } = createMocks();
    pipeline.astDiff.parseDiffs = () => [{ op: 'replace' }];
    pipeline.astDiff.apply = () => ({ code: 'const x = 1;', applied: 1, errors: [] });
    pipeline.selfModel.readModule = () => 'old';
    pipeline.sandbox.testPatch = async () => ({ success: true });

    await pipeline.modify('modify in src/agent/Test.js');
    // Without acorn, even safe code is blocked
    assertEqual(hotReloader._reloaded.length, 0,
      'Without acorn, no files should be modified (fail-safe)');
    mockScannerSafe(); // restore for other tests
  });
});

describe('SelfModPipeline: ASTDiff Modify Path', () => {

  test('ASTDiff success: applies code, snapshots, reloads', async () => {
    mockScannerSafe();
    const { pipeline, hotReloader, writes, tmpRoot, eventStore } = createMocks();
    const newCode = 'const y = 2;\nmodule.exports = { y };';
    pipeline.astDiff.parseDiffs = () => [{ op: 'replace', from: 0, to: 5, text: 'const y = 2' }];
    pipeline.astDiff.apply = () => ({
      code: newCode, applied: 1, errors: [],
    });
    pipeline.selfModel.readModule = () => 'const x = 1;';
    pipeline.sandbox.testPatch = async () => ({ success: true });

    // Create target directory
    const targetDir = path.join(tmpRoot, 'src', 'agent');
    fs.mkdirSync(targetDir, { recursive: true });

    const result = await pipeline.modify('modify in src/agent/Test.js');

    // Should have created snapshots (pre + post)
    const snapshots = writes.filter(w => w.type === 'snapshot');
    assert(snapshots.length >= 2, `Expected at least 2 snapshots, got ${snapshots.length}`);
    assert(snapshots[0].msg.includes('pre-diff'), 'First snapshot should be pre-diff');
    assert(snapshots[1].msg.includes('post-diff'), 'Second snapshot should be post-diff');

    // Should have reloaded the file
    assert(hotReloader._reloaded.length >= 1, 'File should be hot-reloaded');

    // EventStore should log CODE_MODIFIED
    const modEvents = eventStore._log.filter(e => e.type === 'CODE_MODIFIED');
    assert(modEvents.length >= 1, 'CODE_MODIFIED should be logged');
    assert(modEvents[0].data.method === 'ast-diff', 'Method should be ast-diff');
  });

  test('ASTDiff test failure: returns error, no file written', async () => {
    mockScannerSafe();
    const { pipeline, hotReloader } = createMocks();
    pipeline.astDiff.parseDiffs = () => [{ op: 'replace' }];
    pipeline.astDiff.apply = () => ({
      code: 'broken code', applied: 1, errors: [],
    });
    pipeline.selfModel.readModule = () => 'const x = 1;';
    pipeline.sandbox.testPatch = async () => ({ success: false, error: 'SyntaxError: Unexpected token' });

    const result = await pipeline.modify('modify in src/agent/Test.js');
    assert(result.includes('test failed') || result.includes('SyntaxError'),
      `Expected error in result, got: ${result.slice(0, 100)}`);
    assertEqual(hotReloader._reloaded.length, 0, 'Failed test should prevent reload');
  });

  test('ASTDiff parse returns empty: falls back to full-file', async () => {
    mockScannerSafe();
    const { pipeline } = createMocks();
    pipeline.astDiff.parseDiffs = () => []; // No diffs
    pipeline.selfModel.readModule = () => 'const x = 1;';

    const result = await pipeline.modify('modify in src/agent/Test.js');
    // Should fall through to full-file path and get reasoning result
    assert(typeof result === 'string', 'Should return string result');
    // Full-file path returns reasoning result
    assert(result.includes('reasoning result'), 'Should fall back to reasoning');
  });

  test('ASTDiff throws: falls back to full-file gracefully', async () => {
    mockScannerSafe();
    const { pipeline } = createMocks();
    pipeline.astDiff.parseDiffs = () => { throw new Error('Parse explosion'); };
    pipeline.selfModel.readModule = () => 'const x = 1;';

    const result = await pipeline.modify('modify in src/agent/Test.js');
    assert(typeof result === 'string', 'Should handle error and return result');
  });

  test('ASTDiff with errors array: includes warnings in response', async () => {
    mockScannerSafe();
    const { pipeline, tmpRoot } = createMocks();
    const newCode = 'const z = 3;\nmodule.exports = { z };';
    pipeline.astDiff.parseDiffs = () => [{ op: 'replace' }];
    pipeline.astDiff.apply = () => ({
      code: newCode, applied: 1, errors: ['could not apply hunk 2'],
    });
    pipeline.selfModel.readModule = () => 'const x = 1;';
    pipeline.sandbox.testPatch = async () => ({ success: true });

    const targetDir = path.join(tmpRoot, 'src', 'agent');
    fs.mkdirSync(targetDir, { recursive: true });

    const result = await pipeline.modify('modify in src/agent/Test.js');
    // If applied succeeds, warnings should appear in output
    if (result.includes('astdiff_applied') || result.includes('changes applied')) {
      assert(result.includes('hunk 2') || result.includes('warnings'),
        'ASTDiff errors should be in response');
    }
  });
});

describe('SelfModPipeline: Full-File Modify Path', () => {

  test('patches extracted and applied on success', async () => {
    mockScannerSafe();
    const { pipeline, hotReloader, writes, tmpRoot, eventStore } = createMocks();
    const patchCode = 'const patched = true;\nmodule.exports = { patched };';
    pipeline.reasoning.solve = async () => ({
      answer: `Here is the fix:\n// FILE: src/agent/Patched.js\n\`\`\`js\n${patchCode}\n\`\`\`\n\nDone.`,
    });
    // No ASTDiff target in message
    const targetDir = path.join(tmpRoot, 'src', 'agent');
    fs.mkdirSync(targetDir, { recursive: true });

    const result = await pipeline.modify('refactor the caching logic');

    // Should have created pre+post snapshots
    const snapshots = writes.filter(w => w.type === 'snapshot');
    assert(snapshots.length >= 2, `Should create snapshots, got ${snapshots.length}`);

    // File should have been written
    const filePath = path.join(tmpRoot, 'src', 'agent', 'Patched.js');
    assert(fs.existsSync(filePath), 'Patch file should exist on disk');
    assertEqual(fs.readFileSync(filePath, 'utf-8'), patchCode, 'File content should match patch');

    // CODE_MODIFIED event
    const modEvents = eventStore._log.filter(e => e.type === 'CODE_MODIFIED');
    assert(modEvents.length >= 1, 'Should log CODE_MODIFIED');
    assertEqual(modEvents[0].data.method, 'full-file', 'Method should be full-file');
    assertEqual(modEvents[0].data.success, true, 'Should mark as success');
  });

  test('test failure prevents all patches from being written', async () => {
    mockScannerSafe();
    const { pipeline, hotReloader, tmpRoot } = createMocks();
    pipeline.reasoning.solve = async () => ({
      answer: '// FILE: src/agent/Bad.js\n```js\nbroken\n```',
    });
    pipeline.sandbox.testPatch = async () => ({ success: false, error: 'SyntaxError' });

    const result = await pipeline.modify('break everything');
    assert(result.includes('tests_failed') || result.includes('SyntaxError'));
    const filePath = path.join(tmpRoot, 'src', 'agent', 'Bad.js');
    assert(!fs.existsSync(filePath), 'Failed patch should not be written to disk');
  });

  test('no patches extracted: returns raw LLM answer', async () => {
    mockScannerSafe();
    const { pipeline } = createMocks();
    pipeline.reasoning.solve = async () => ({
      answer: 'I analyzed the code and found no changes needed.',
    });

    const result = await pipeline.modify('check for issues');
    assert(result.includes('no changes needed'), 'Should return raw answer when no patches');
  });
});

describe('SelfModPipeline: Guard Validation', () => {

  test('modify respects guard.validateWrite for kernel files', async () => {
    mockScannerSafe();
    const { pipeline, tmpRoot } = createMocks();
    pipeline.reasoning.solve = async () => ({
      answer: '// FILE: main.js\n```js\nconsole.log("hacked")\n```',
    });
    pipeline.sandbox.testPatch = async () => ({ success: true });

    // Guard blocks main.js writes
    let blocked = false;
    pipeline.guard.validateWrite = (p) => {
      if (p.includes('main.js')) {
        blocked = true;
        throw new Error('[SAFEGUARD] Write to protected kernel file blocked');
      }
      return true;
    };

    try {
      const result = await pipeline.modify('modify main.js');
      // Either the error propagates or it's caught internally
    } catch (err) {
      assert(err.message.includes('SAFEGUARD'), 'Should throw SafeGuard error');
    }
    // The key: main.js should not have been created
    assert(!fs.existsSync(path.join(tmpRoot, 'main.js')), 'Kernel file should not be written');
  });
});

describe('SelfModPipeline: Event Emission & Status Lifecycle', () => {

  test('modify emits self-modifying status on entry and ready on exit', async () => {
    mockScannerSafe();
    const { pipeline, events } = createMocks();
    await pipeline.modify('test change');

    const statusEvents = events.filter(e => e.event === 'agent:status');
    assert(statusEvents.length >= 2, `Expected at least 2 status events, got ${statusEvents.length}`);
    assertEqual(statusEvents[0].data.state, 'self-modifying', 'First status should be self-modifying');
    assertEqual(statusEvents[statusEvents.length - 1].data.state, 'ready', 'Last status should be ready');
  });

  test('reflect emits thinking then ready status', async () => {
    const { pipeline, events } = createMocks();
    await pipeline.reflect('what are my weaknesses?');

    const statusEvents = events.filter(e => e.event === 'agent:status');
    assert(statusEvents.length >= 2, 'Should emit at least 2 status events');
    assertEqual(statusEvents[0].data.state, 'thinking', 'First should be thinking');
    assertEqual(statusEvents[statusEvents.length - 1].data.state, 'ready', 'Last should be ready');
  });

  test('repair emits self-repairing then ready status', async () => {
    const { pipeline, events } = createMocks();
    await pipeline.repair();

    const statusEvents = events.filter(e => e.event === 'agent:status');
    assert(statusEvents.length >= 2, 'Should emit at least 2 status events');
    assertEqual(statusEvents[0].data.state, 'self-repairing', 'First should be self-repairing');
  });

  test('status returns to ready even when reasoning throws during modify', async () => {
    mockScannerSafe();
    const { pipeline, events } = createMocks();
    pipeline.reasoning.solve = async () => { throw new Error('LLM crashed'); };

    let threw = false;
    try {
      await pipeline.modify('crash test');
    } catch (e) {
      threw = true;
    }

    // If it threw, verify status was set to self-modifying at least
    // If it didn't throw, the last status should be ready
    const statusEvents = events.filter(e => e.event === 'agent:status');
    assert(statusEvents.length >= 1, 'Should emit at least 1 status event');
    // First event should be self-modifying
    assertEqual(statusEvents[0].data.state, 'self-modifying',
      'First status should be self-modifying');
    // If the pipeline caught the error, last should be ready
    if (!threw) {
      const lastStatus = statusEvents[statusEvents.length - 1];
      assertEqual(lastStatus.data.state, 'ready', 'Status should return to ready');
    }
  });
});

describe('SelfModPipeline: Inspect', () => {

  test('inspect includes kernel integrity status', async () => {
    const { pipeline } = createMocks();
    const result = await pipeline.inspect();
    // Guard returns ok: true, so should show intact message
    assert(result.includes('inspect.kernel_intact') || result.includes('intact'),
      'Should include kernel status');
  });

  test('inspect shows compromised when guard reports issues', async () => {
    const { pipeline } = createMocks();
    pipeline.guard.verifyIntegrity = () => ({ ok: false, issues: ['modified file'] });
    const result = await pipeline.inspect();
    assert(result.includes('inspect.kernel_compromised') || result.includes('compromised'),
      'Should indicate kernel compromise');
  });

  test('inspect lists module summaries', async () => {
    const { pipeline } = createMocks();
    const result = await pipeline.inspect();
    assert(result.includes('Genesis'), 'Should list identity');
  });
});

// ── Cleanup ────────────────────────────────────────────────
// (Test harness handles process exit)

run();
