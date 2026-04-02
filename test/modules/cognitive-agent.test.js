// ============================================================
// GENESIS v3.5.0 — Test Suite for Cognitive Agent Modules
//
// Tests: VerificationEngine, WorldState, DesktopPerception,
//        FormalPlanner, MetaLearning, EpisodicMemory, ModelRouter
//
// Run: node test/modules/v4-cognitive.test.js
// ============================================================

const path = require('path');
const fs = require('fs');

// ── Test Framework (Genesis built-in) ─────────────────────
let passed = 0, failed = 0;
const failures = [];

function assert(condition, message) {
  if (condition) { passed++; process.stdout.write('    \x1b[32m✅ ' + message + '\x1b[0m\n'); }
  else { failed++; failures.push(message); process.stdout.write('    \x1b[31m❌ ' + message + '\x1b[0m\n'); }
}

function assertThrows(fn, message) {
  try { fn(); assert(false, message + ': should have thrown'); }
  catch { assert(true, message); }
}

function section(name) { console.log(`\n  \x1b[36m🧪 ${name}\x1b[0m`); }

// ── Mock Bus ──────────────────────────────────────────────
const { NullBus } = require('../../src/agent/core/EventBus');

// ── Temp directory for storage ────────────────────────────
const tmpDir = path.join(__dirname, '..', '..', '.genesis-test-v4');
if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });

// Simple mock storage
class MockStorage {
  constructor() { this._data = {}; }
  readJSON(key, def) { return this._data[key] || def; }
  writeJSONDebounced(key, val) { this._data[key] = val; }
  readText(key, def) { return this._data[key] || def; }
  appendText(key, val) { this._data[key] = (this._data[key] || '') + val; }
}

const mockStorage = new MockStorage();
const rootDir = path.resolve(__dirname, '..', '..');

// ═══════════════════════════════════════════════════════════
// VERIFICATION ENGINE
// ═══════════════════════════════════════════════════════════

section('VerificationEngine');

const { VerificationEngine, CodeVerifier, TestVerifier, ShellVerifier, FileVerifier, PASS, FAIL, AMBIGUOUS } = require('../../src/agent/intelligence/VerificationEngine');

const verifier = new VerificationEngine({ bus: NullBus, rootDir });

// CodeVerifier
const cv = new CodeVerifier(rootDir);

assert(cv.checkSyntax('const x = 1;').passed === true, 'valid JS syntax passes');
const syntaxCheck = cv.checkSyntax('const x = ;');
// acorn not installed → graceful fallback returns passed: true with note
const acornAvailable = !syntaxCheck.note;
assert(acornAvailable ? syntaxCheck.passed === false : syntaxCheck.passed === true, 'invalid JS syntax fails (or skipped without acorn)');
assert(cv.checkSyntax('function foo() { return 1; }').passed === true, 'function syntax passes');
assert(cv.checkSyntax('class Foo { bar() {} }').passed === true, 'class syntax passes');
assert(cv.checkSyntax('async function f() { await x(); }').passed === true, 'async/await syntax passes');

const codeResult = cv.verify('const path = require("path");\nmodule.exports = { test: 1 };', { rootDir });
assert(codeResult.status === PASS, 'valid code with builtin require passes');

const badCode = cv.verify('', { rootDir });
assert(badCode.status === FAIL, 'empty code fails verification');

const syntaxBad = cv.verify('function { broken', { rootDir });
assert(acornAvailable ? syntaxBad.status === FAIL : syntaxBad.status === PASS, 'syntax error code fails (or passes without acorn)');

// TestVerifier
const tv = new TestVerifier();

const passResult = tv.verify({ output: '12 passing\n0 failing', exitCode: 0 });
assert(passResult.status === PASS, 'all tests passing returns PASS');

const failResult = tv.verify({ output: '10 passing\n2 failing', exitCode: 1, stderr: 'AssertionError' });
assert(failResult.status === FAIL, 'failing tests return FAIL');

const timeoutResult = tv.verify({ output: '', exitCode: 1, stderr: 'ETIMEDOUT', timedOut: true });
assert(timeoutResult.status === FAIL, 'timeout returns FAIL');

// ShellVerifier
const sv = new ShellVerifier();

assert(sv.verify({ exitCode: 0, output: 'success' }).status === PASS, 'exit 0 returns PASS');
assert(sv.verify({ exitCode: 1, stderr: 'error' }).status === FAIL, 'exit 1 returns FAIL');
assert(sv.verify({ exitCode: 127, stderr: 'command not found' }).status === FAIL, 'command not found returns FAIL');
assert(sv.verify({ exitCode: 0, stderr: 'warn', output: 'ok' }).status === PASS, 'exit 0 with stderr warning returns PASS');

// FileVerifier
const fv = new FileVerifier(rootDir);

const pkgResult = fv.verify('package.json', {});
assert(pkgResult.status === PASS, 'existing package.json passes');

const missingResult = fv.verify('nonexistent-file-xyz.js', {});
assert(missingResult.status === FAIL, 'missing file fails');

// Composite verify
(async () => {
  const analyzeResult = await verifier.verify('ANALYZE', { type: 'ANALYZE' }, { output: 'done' });
  assert(analyzeResult.status === AMBIGUOUS, 'ANALYZE step is AMBIGUOUS (goes to LLM)');

  const shellOk = await verifier.verify('SHELL', { type: 'SHELL' }, { exitCode: 0, output: 'ok' });
  assert(shellOk.status === PASS, 'successful SHELL step passes');

  const stats = verifier.getStats();
  assert(stats.total > 0, 'stats track total verifications');

  // ═══════════════════════════════════════════════════════════
  // WORLD STATE
  // ═══════════════════════════════════════════════════════════

  section('WorldState');

  const { WorldState } = require('../../src/agent/foundation/WorldState');

  const ws = new WorldState({ bus: NullBus, storage: mockStorage, rootDir, settings: null });

  assert(ws.state.project.root === rootDir, 'project root is set');
  assert(ws.state.system.platform === process.platform, 'system platform detected');
  assert(typeof ws.state.system.totalRAM === 'number', 'total RAM detected');
  assert(ws.state.system.cpuCores > 0, 'CPU cores detected');

  // Precondition checks
  assert(ws.canWriteFile('src/agent/NewModule.js') === true, 'can write to src/agent/');
  assert(ws.canWriteFile('main.js') === false, 'cannot write to kernel file main.js');
  assert(ws.canWriteFile('node_modules/foo/bar.js') === false, 'cannot write to node_modules');
  assert(ws.canWriteFile('.git/config') === false, 'cannot write to .git');
  assert(ws.canWriteFile(process.platform === 'win32' ? 'C:\\Windows\\System32\\drivers\\etc\\hosts' : '/etc/passwd') === false, 'cannot write outside project');
  assert(ws.isKernelFile('main.js') === true, 'main.js is kernel file');
  assert(ws.isKernelFile('src/agent/AgentCore.js') === false, 'AgentCore.js is not kernel');

  assert(ws.canRunTests() === true, 'canRunTests with test script');
  assert(ws.canRunShell('npm test') === true, 'safe shell command allowed');
  assert(ws.canRunShell('rm -rf /') === false, 'dangerous shell command blocked');

  // Updates
  ws.recordUserTopic('MCP Client debugging');
  assert(ws.getRecentTopics().includes('MCP Client debugging'), 'topic recorded');

  ws.updateOllamaModels(['gemma2:9b', 'llama3:8b']);
  ws.updateOllamaStatus('running');
  assert(ws.canUseModel('gemma2:9b') === true, 'available model passes canUseModel');
  assert(ws.canUseModel('nonexistent:1b') === false, 'missing model fails canUseModel');

  // Clone for simulation
  const clone = ws.clone();
  assert(clone.canWriteFile('src/agent/Test.js') === true, 'cloned state has same preconditions');
  clone.markFileModified('src/agent/Test.js');
  assert(clone.getSimulatedChanges().length === 1, 'clone tracks simulated changes');

  // Context building
  const ctx = ws.buildContextSlice(['project', 'models', 'user']);
  assert(typeof ctx === 'string', 'buildContextSlice returns string');

  // ═══════════════════════════════════════════════════════════
  // DESKTOP PERCEPTION
  // ═══════════════════════════════════════════════════════════

  section('DesktopPerception');

  const { DesktopPerception } = require('../../src/agent/foundation/DesktopPerception');

  const dp = new DesktopPerception({ bus: NullBus, worldState: ws, rootDir, intervals: null });

  assert(dp._running === false, 'not running before start');
  const status = dp.getStatus();
  assert(typeof status.running === 'boolean', 'getStatus returns running flag');
  assert(typeof status.fileWatcher === 'boolean', 'getStatus returns fileWatcher flag');

  // ═══════════════════════════════════════════════════════════
  // META LEARNING
  // ═══════════════════════════════════════════════════════════

  section('MetaLearning');

  const { MetaLearning } = require('../../src/agent/planning/MetaLearning');

  const ml = new MetaLearning({ bus: NullBus, storage: new MockStorage() });

  // Record outcomes
  for (let i = 0; i < 60; i++) {
    ml.recordOutcome({
      taskCategory: 'code-gen',
      model: 'gemma2:9b',
      promptStyle: i < 45 ? 'json-schema' : 'free-text', // json-schema wins
      temperature: 0.3,
      success: i < 45 ? Math.random() > 0.15 : Math.random() > 0.5,
      latencyMs: 1000 + Math.random() * 2000,
    });
  }

  const mlStats = ml.getStats();
  assert(mlStats.totalRecords === 60, 'recorded 60 outcomes');
  assert(mlStats.categories.includes('code-gen'), 'code-gen category tracked');

  const rec = ml.recommend('code-gen', 'gemma2:9b');
  assert(rec !== null, 'recommendation returned');
  assert(rec.promptStyle === 'json-schema' || rec.promptStyle === 'free-text', 'recommends a valid promptStyle');

  const defaultRec = ml.recommend('unknown-category', 'unknown-model');
  assert(defaultRec !== null, 'returns defaults for unknown category');
  assert(defaultRec.isDefault === true, 'marks as default recommendation');

  const trend = ml.getTrend('code-gen');
  assert(['improving', 'stable', 'degrading'].includes(trend.trend), 'trend is valid');

  const rankings = ml.getModelRankings('code-gen');
  assert(Array.isArray(rankings), 'model rankings is an array');

  // ═══════════════════════════════════════════════════════════
  // EPISODIC MEMORY
  // ═══════════════════════════════════════════════════════════

  section('EpisodicMemory');

  const { EpisodicMemory } = require('../../src/agent/hexagonal/EpisodicMemory');

  const em = new EpisodicMemory({ bus: NullBus, storage: new MockStorage() });

  const ep1 = em.recordEpisode({
    topic: 'Fixed MCP transport reconnection bug',
    summary: 'SSE disconnects fixed by adding heartbeat timeout',
    outcome: 'success',
    duration: 1800,
    artifacts: [{ type: 'file-modified', path: 'src/agent/McpTransport.js' }],
    toolsUsed: ['shell', 'sandbox'],
    tags: ['mcp', 'networking', 'bugfix'],
    keyInsights: ['SSE needs heartbeat timeout independent of response timeout'],
  });

  assert(ep1.startsWith('ep_'), 'episode ID has correct prefix');
  assert(em.getStats().totalEpisodes === 1, 'episode count is 1');

  const ep2 = em.recordEpisode({
    topic: 'Refactored McpClient to use new transport',
    summary: 'Extracted transport layer into McpTransport.js',
    outcome: 'success',
    duration: 3600,
    artifacts: [
      { type: 'file-modified', path: 'src/agent/McpTransport.js' },
      { type: 'file-modified', path: 'src/agent/McpClient.js' },
    ],
    tags: ['mcp', 'refactoring'],
  });

  // Should detect causal link (shared files + tags)
  assert(em.getStats().causalLinks > 0, 'causal link detected between related episodes');

  // Recall
  const recalled = em.recall('MCP transport');
  assert(recalled.length > 0, 'recall finds MCP-related episodes');
  assert(recalled[0].topic.includes('MCP') || recalled[0].topic.includes('Mcp'), 'most relevant episode is MCP-related');

  // Tag search
  const mcpEps = em.getByTag('mcp');
  assert(mcpEps.length === 2, 'tag search finds both MCP episodes');

  const bugfixEps = em.getByTag('bugfix');
  assert(bugfixEps.length === 1, 'tag search finds 1 bugfix episode');

  // Recent
  const recent = em.getRecent(1);
  assert(recent.length === 2, 'both episodes are from today');

  // Context building
  const epCtx = em.buildContext('MCP reconnection');
  assert(epCtx.includes('EPISODIC MEMORY'), 'context block has header');
  assert(epCtx.includes('MCP') || epCtx.includes('mcp'), 'context mentions MCP');

  // Empty query
  const emptyCtx = em.buildContext('');
  assert(emptyCtx === '', 'empty query returns empty context');

  // Tag stats
  const tagStats = em.getTags();
  assert(tagStats.mcp === 2, 'mcp tag has 2 episodes');

  // ═══════════════════════════════════════════════════════════
  // FORMAL PLANNER
  // ═══════════════════════════════════════════════════════════

  section('FormalPlanner');

  const { FormalPlanner } = require('../../src/agent/revolution/FormalPlanner');

  // Mock model for planner
  const mockModel = {
    chatStructured: async (prompt) => ({
      title: 'Test plan',
      steps: [
        { type: 'ANALYZE', description: 'Read existing code', target: 'src/agent/AgentCore.js' },
        { type: 'CODE_GENERATE', description: 'Generate new module', target: 'src/agent/NewModule.js' },
        { type: 'WRITE_FILE', description: 'Save module', target: 'src/agent/NewModule.js' },
        { type: 'RUN_TESTS', description: 'Run test suite' },
      ],
      successCriteria: 'All tests pass',
    }),
    chat: async (prompt) => 'SUCCESS: Goal achieved.',
  };

  const fp = new FormalPlanner({
    bus: NullBus, worldState: ws, verifier, toolRegistry: null,
    model: mockModel, selfModel: null, sandbox: null, guard: null,
    eventStore: null, storage: new MockStorage(), rootDir,
  });

  assert(fp.getActionTypes().length >= 10, 'has 10+ action types registered');
  assert(fp.getActionTypes().includes('WRITE_FILE'), 'WRITE_FILE action registered');
  assert(fp.getActionTypes().includes('CODE_GENERATE'), 'CODE_GENERATE action registered');
  assert(fp.getActionTypes().includes('SELF_MODIFY'), 'SELF_MODIFY action registered');

  // Test plan creation
  const plan = await fp.plan('Create a new module for testing');
  assert(plan !== null, 'plan returned');
  assert(plan.steps.length > 0, 'plan has steps');
  assert(plan.steps.every(s => s.type), 'all steps have types');
  assert(plan.steps.every(s => typeof s.cost === 'number'), 'all steps have costs');
  assert(typeof plan.cost === 'number' && plan.cost > 0, 'plan has total cost');
  assert(typeof plan.valid === 'boolean', 'plan has valid flag');

  // Test plan simulation — writing to kernel should flag issues
  const mockModelKernel = {
    chatStructured: async () => ({
      title: 'Dangerous plan',
      steps: [
        { type: 'WRITE_FILE', description: 'Modify kernel', target: 'main.js' },
      ],
    }),
    chat: async () => 'FAILED',
  };

  const fpKernel = new FormalPlanner({
    bus: NullBus, worldState: ws, verifier, toolRegistry: null,
    model: mockModelKernel, selfModel: null, sandbox: null, guard: null,
    eventStore: null, storage: new MockStorage(), rootDir,
  });

  const kernelPlan = await fpKernel.plan('Modify main.js');
  assert(kernelPlan.valid === false || kernelPlan.issues.length > 0, 'kernel write plan has issues');

  // ═══════════════════════════════════════════════════════════
  // MODEL ROUTER
  // ═══════════════════════════════════════════════════════════

  section('ModelRouter');

  const { ModelRouter } = require('../../src/agent/revolution/ModelRouter');

  const mockBridge = {
    activeModel: 'gemma2:9b',
    availableModels: [
      { name: 'gemma2:2b' },
      { name: 'gemma2:9b' },
    ],
  };

  const mr = new ModelRouter({ bus: NullBus, modelBridge: mockBridge, metaLearning: ml, worldState: ws });

  // With 2 models available, routing should differentiate
  const codeRoute = mr.route('code-gen');
  assert(codeRoute.model !== null, 'code-gen route selects a model');
  assert(typeof codeRoute.score === 'number', 'route has score');

  const intentRoute = mr.route('intent');
  assert(intentRoute.model !== null, 'intent route selects a model');

  // With strategy
  const strategy = mr.routeWithStrategy('code-gen');
  assert(strategy.model !== null, 'routeWithStrategy returns model');
  assert(typeof strategy.promptStyle === 'string', 'routeWithStrategy returns promptStyle');
  assert(typeof strategy.temperature === 'number', 'routeWithStrategy returns temperature');

  // Single model fallback
  const singleBridge = { activeModel: 'gemma2:9b', availableModels: [{ name: 'gemma2:9b' }] };
  const mrSingle = new ModelRouter({ bus: NullBus, modelBridge: singleBridge, metaLearning: null, worldState: null });
  const singleRoute = mrSingle.route('code-gen');
  assert(singleRoute.model === 'gemma2:9b', 'single model fallback uses active model');
  assert(singleRoute.reason.includes('one model'), 'single model reason is clear');

  // ═══════════════════════════════════════════════════════════
  // SUMMARY
  // ═══════════════════════════════════════════════════════════

  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(`  v3.5.0 COGNITIVE TESTS: ${passed} passed, ${failed} failed`);
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

  if (failures.length > 0) {
    console.log('\n  Failures:');
    for (const f of failures) console.log(`    - ${f}`);
  }

  // Cleanup
  try { fs.rmSync(tmpDir, { recursive: true }); } catch {}

  process.exit(failed > 0 ? 1 : 0);
})();
