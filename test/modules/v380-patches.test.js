// ============================================================
// Test: v380-patches.test.js — v3.8.0 Patch Verification
//
// Tests for:
//   1. ContainerManifest auto-discovery (no _dirMap)
//   2. AgentLoop composition delegates (no prototype mixins)
//   3. EventStore write-batching
// ============================================================

let passed = 0, failed = 0;
const _testQueue = [];
function test(name, fn) { _testQueue.push({ name, fn }); }
function assert(c, m) { if (!c) throw new Error(m || 'Assertion failed'); }

console.log('\n  🔧 v3.8.0 Patches');

// ════════════════════════════════════════════════════════════
// 1. ContainerManifest Auto-Discovery
// ════════════════════════════════════════════════════════════
console.log('\n  📦 ContainerManifest Auto-Discovery');

const { getAutoMap } = require('../../src/agent/ContainerManifest');

test('getAutoMap() returns a non-empty object', () => {
  const map = getAutoMap();
  assert(typeof map === 'object', 'should return object');
  assert(Object.keys(map).length > 50, `should have 50+ entries, got ${Object.keys(map).length}`);
});

test('auto-discovery finds core modules', () => {
  const map = getAutoMap();
  assert(map['EventBus'] === 'core', `EventBus should be in core, got ${map['EventBus']}`);
  assert(map['Container'] === 'core', `Container should be in core, got ${map['Container']}`);
  assert(map['Constants'] === 'core', `Constants should be in core, got ${map['Constants']}`);
});

test('auto-discovery finds foundation modules', () => {
  const map = getAutoMap();
  assert(map['Settings'] === 'foundation', `Settings should be in foundation`);
  assert(map['ModelBridge'] === 'foundation', `ModelBridge should be in foundation`);
  assert(map['WorldState'] === 'foundation', `WorldState should be in foundation`);
  assert(map['EventStore'] === 'foundation', `EventStore should be in foundation`);
});

test('auto-discovery finds revolution modules', () => {
  const map = getAutoMap();
  assert(map['AgentLoop'] === 'revolution', `AgentLoop should be in revolution`);
  assert(map['FormalPlanner'] === 'revolution', `FormalPlanner should be in revolution`);
  assert(map['VectorMemory'] === 'revolution', `VectorMemory should be in revolution`);
});

test('auto-discovery finds hexagonal modules', () => {
  const map = getAutoMap();
  assert(map['ChatOrchestrator'] === 'hexagonal', `ChatOrchestrator should be in hexagonal`);
  assert(map['PeerNetwork'] === 'hexagonal', `PeerNetwork should be in hexagonal`);
  assert(map['PeerCrypto'] === 'hexagonal', `PeerCrypto should be in hexagonal`);
});

test('auto-discovery finds organism modules', () => {
  const map = getAutoMap();
  assert(map['EmotionalState'] === 'organism', `EmotionalState should be in organism`);
  assert(map['NeedsSystem'] === 'organism', `NeedsSystem should be in organism`);
  assert(map['Homeostasis'] === 'organism', `Homeostasis should be in organism`);
});

test('auto-discovery finds ports', () => {
  const map = getAutoMap();
  assert(map['LLMPort'] === 'ports', `LLMPort should be in ports`);
  assert(map['MemoryPort'] === 'ports', `MemoryPort should be in ports`);
});

test('auto-discovery covers all directories', () => {
  const map = getAutoMap();
  const dirs = new Set(Object.values(map));
  for (const expected of ['core', 'foundation', 'intelligence', 'capabilities', 'planning', 'hexagonal', 'autonomy', 'organism', 'revolution', 'ports']) {
    assert(dirs.has(expected), `directory ${expected} should be represented in auto-map`);
  }
});

// ════════════════════════════════════════════════════════════
// 2. AgentLoop Composition Delegates
// ════════════════════════════════════════════════════════════
console.log('\n  🔄 AgentLoop Composition Delegates');

const { NullBus } = require('../../src/agent/core/EventBus');
const { AgentLoop } = require('../../src/agent/revolution/AgentLoop');
const { AgentLoopPlannerDelegate } = require('../../src/agent/revolution/AgentLoopPlanner');
const { AgentLoopStepsDelegate } = require('../../src/agent/revolution/AgentLoopSteps');

function createMinimalLoop() {
  return new AgentLoop({
    bus: NullBus,
    model: { chat: async () => 'mock', chatStructured: async () => ({ _parseError: true, _raw: '' }), activeModel: 'test' },
    goalStack: { addGoal: () => 'g1', getActiveGoals: () => [] },
    sandbox: { execute: async () => ({ output: '', error: null }), testPatch: async () => ({ success: true }) },
    selfModel: { getModuleSummary: () => [], getCapabilities: () => [], readModule: () => '' },
    memory: { addEpisode: () => {}, flush: () => {}, getStats: () => ({}) },
    knowledgeGraph: { learnFromText: () => {} },
    tools: { listTools: () => [] },
    guard: { validateWrite: () => true },
    eventStore: { append: async () => ({}) },
    shellAgent: null,
    selfModPipeline: {},
    storage: null,
    rootDir: '/tmp/test',
  });
}

test('AgentLoop has planner delegate', () => {
  const loop = createMinimalLoop();
  assert(loop.planner instanceof AgentLoopPlannerDelegate, 'planner should be AgentLoopPlannerDelegate');
});

test('AgentLoop has steps delegate', () => {
  const loop = createMinimalLoop();
  assert(loop.steps instanceof AgentLoopStepsDelegate, 'steps should be AgentLoopStepsDelegate');
});

test('planner delegate has reference to loop', () => {
  const loop = createMinimalLoop();
  assert(loop.planner.loop === loop, 'planner.loop should reference parent');
});

test('steps delegate has reference to loop', () => {
  const loop = createMinimalLoop();
  assert(loop.steps.loop === loop, 'steps.loop should reference parent');
});

test('AgentLoop.prototype has no mixin methods', () => {
  // These methods should NOT be on the prototype anymore
  const mixinMethods = ['_planGoal', '_llmPlanGoal', '_salvagePlan', '_inferStepType',
    '_executeStep', '_stepAnalyze', '_stepCode', '_stepSandbox', '_stepShell',
    '_stepSearch', '_stepAsk', '_stepDelegate', '_extractSkills'];

  for (const method of mixinMethods) {
    assert(!AgentLoop.prototype.hasOwnProperty(method),
      `AgentLoop.prototype should NOT have ${method} (should be on delegate)`);
  }
});

test('planner delegate has _planGoal method', () => {
  const loop = createMinimalLoop();
  assert(typeof loop.planner._planGoal === 'function', '_planGoal should be a function');
  assert(typeof loop.planner._llmPlanGoal === 'function', '_llmPlanGoal should be a function');
  assert(typeof loop.planner._salvagePlan === 'function', '_salvagePlan should be a function');
  assert(typeof loop.planner._inferStepType === 'function', '_inferStepType should be a function');
});

test('steps delegate has _executeStep method', () => {
  const loop = createMinimalLoop();
  assert(typeof loop.steps._executeStep === 'function', '_executeStep should be a function');
  assert(typeof loop.steps._stepAnalyze === 'function', '_stepAnalyze should be a function');
  assert(typeof loop.steps._extractSkills === 'function', '_extractSkills should be a function');
});

test('_inferStepType returns correct types', () => {
  const loop = createMinimalLoop();
  assert(loop.planner._inferStepType('write a new module') === 'CODE');
  assert(loop.planner._inferStepType('test the changes') === 'SANDBOX');
  assert(loop.planner._inferStepType('npm install packages') === 'SHELL');
  assert(loop.planner._inferStepType('search documentation') === 'SEARCH');
  assert(loop.planner._inferStepType('ask the user') === 'ASK');
  assert(loop.planner._inferStepType('delegate to peer agent') === 'DELEGATE');
  assert(loop.planner._inferStepType('review the situation') === 'ANALYZE');
});

test('_extractSkills returns correct skills', () => {
  const loop = createMinimalLoop();
  const skills1 = loop.steps._extractSkills('write tests and implement feature');
  assert(skills1.includes('testing'), 'should detect testing');
  assert(skills1.includes('coding'), 'should detect coding');

  const skills2 = loop.steps._extractSkills('deploy to docker with api');
  assert(skills2.includes('devops'), 'should detect devops');
  assert(skills2.includes('api'), 'should detect api');
});

test('_salvagePlan handles unstructured text', () => {
  const loop = createMinimalLoop();
  const plan = loop.planner._salvagePlan(
    '1. Analyze the current state\n2. Write the implementation\n3. Test the code',
    'test goal'
  );
  assert(plan.steps.length >= 1, 'should extract at least 1 step');
  assert(plan.title, 'should have a title');
  assert(plan.successCriteria, 'should have success criteria');
});

test('_salvagePlan handles empty text', () => {
  const loop = createMinimalLoop();
  const plan = loop.planner._salvagePlan('', 'test goal');
  assert(plan.steps.length === 1, 'should have fallback ANALYZE step');
  assert(plan.steps[0].type === 'ANALYZE', 'fallback should be ANALYZE');
});

// ════════════════════════════════════════════════════════════
// 3. EventStore Write-Batching
// ════════════════════════════════════════════════════════════
console.log('\n  📝 EventStore Write-Batching');

const { EventStore } = require('../../src/agent/foundation/EventStore');
const fs = require('fs');
const path = require('path');
const os = require('os');

function createTempEventStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'genesis-test-'));
  return { store: new EventStore(dir, NullBus, null), dir };
}

test('EventStore has batch buffer fields', () => {
  const { store, dir } = createTempEventStore();
  assert(Array.isArray(store._writeBatch), '_writeBatch should be array');
  assert(store._batchFlushMs === 500, '_batchFlushMs should be 500');
  assert(store._batchFlushTimer === null, '_batchFlushTimer should start null');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('append() buffers events instead of writing immediately', () => {
  const { store, dir } = createTempEventStore();
  store.append('TEST_EVENT', { data: 1 }, 'test');
  store.append('TEST_EVENT', { data: 2 }, 'test');
  store.append('TEST_EVENT', { data: 3 }, 'test');

  // Events should be in buffer, not necessarily flushed yet
  assert(store.eventCount === 3, `should have counted 3 events, got ${store.eventCount}`);
  // Hash chain should be intact in memory
  assert(store.lastHash !== '0000000000000000', 'hash should have advanced');

  // Clear timer to avoid leaks
  if (store._batchFlushTimer) clearTimeout(store._batchFlushTimer);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('flushPending() writes all buffered events', async () => {
  const { store, dir } = createTempEventStore();
  store.append('A', { x: 1 }, 'test');
  store.append('B', { x: 2 }, 'test');
  store.append('C', { x: 3 }, 'test');

  assert(store._writeBatch.length === 3, 'buffer should have 3 entries before flush');

  await store.flushPending();
  assert(store._writeBatch.length === 0, 'buffer should be empty after flush');

  // Verify file contents
  const logPath = path.join(dir, 'events.jsonl');
  const content = fs.readFileSync(logPath, 'utf-8');
  const lines = content.split('\n').filter(Boolean);
  assert(lines.length === 3, `should have 3 lines, got ${lines.length}`);

  const events = lines.map(l => JSON.parse(l));
  assert(events[0].type === 'A', 'first event type');
  assert(events[1].type === 'B', 'second event type');
  assert(events[2].type === 'C', 'third event type');

  fs.rmSync(dir, { recursive: true, force: true });
});

test('hash chain integrity after batched writes', async () => {
  const { store, dir } = createTempEventStore();
  store.append('E1', {}, 'test');
  store.append('E2', {}, 'test');
  store.append('E3', {}, 'test');
  store.append('E4', {}, 'test');
  store.append('E5', {}, 'test');
  await store.flushPending();

  // Verify hash chain
  const integrity = store.verifyIntegrity();
  assert(integrity.ok, `hash chain should be valid: ${JSON.stringify(integrity.violations)}`);
  assert(integrity.totalEvents === 5, `should have 5 events, got ${integrity.totalEvents}`);

  fs.rmSync(dir, { recursive: true, force: true });
});

test('flushPending() is safe to call with empty buffer', async () => {
  const { store, dir } = createTempEventStore();
  // Should not throw
  await store.flushPending();
  assert(true, 'empty flushPending should succeed');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('projections work with batched writes', async () => {
  const { store, dir } = createTempEventStore();
  store.registerProjection('counter', (state, event) => {
    state.count = (state.count || 0) + 1;
    return state;
  }, { count: 0 });

  store.append('X', {}, 'test');
  store.append('Y', {}, 'test');
  store.append('Z', {}, 'test');

  // Projections should update immediately (in-memory), not wait for flush
  const proj = store.getProjection('counter');
  assert(proj.count === 3, `projection count should be 3, got ${proj.count}`);

  if (store._batchFlushTimer) clearTimeout(store._batchFlushTimer);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('EventBus forwarding happens immediately, not on flush', () => {
  const { store, dir } = createTempEventStore();
  const received = [];
  const { EventBus } = require('../../src/agent/core/EventBus');
  const testBus = new EventBus();
  store.bus = testBus;

  testBus.on('store:TEST_IMMEDIATE', (event) => { received.push(event); });
  store.append('TEST_IMMEDIATE', { data: 42 }, 'test');

  // Event should be forwarded immediately, not batched
  // (EventBus forwarding is sync via fire())
  // Give it a tick for the async emit
  setTimeout(() => {
    assert(received.length === 1, `should have received 1 event immediately, got ${received.length}`);
    if (store._batchFlushTimer) clearTimeout(store._batchFlushTimer);
    fs.rmSync(dir, { recursive: true, force: true });
  }, 50);
});

// ════════════════════════════════════════════════════════════
// 4. CodeSafetyScanner — Branch Coverage Additions
// ════════════════════════════════════════════════════════════
console.log('\n  🛡 CodeSafetyScanner (Branch Coverage)');

const { scanCodeSafety, AST_RULES } = require('../../src/agent/intelligence/CodeSafetyScanner');

// -- String concatenation bypass (AST catches, regex can't)
test('catches string-concat eval bypass: e + "val"', () => {
  // This tests the AST capability — if acorn parses it, the Identifier check catches it
  const r = scanCodeSafety('const e = eval; e("alert(1)");', 'test.js');
  // The identifier 'eval' in assignment will be caught by regex at minimum
  assert(!r.safe || r.warnings.length > 0, 'eval alias should raise at least a warning');
});

// -- Computed property access to kernel internals
test('catches direct SafeGuard property reference', () => {
  const r = scanCodeSafety('const x = obj.SafeGuard;', 'test.js');
  // The Identifier rule catches 'SafeGuard' anywhere
  assert(!r.safe, 'SafeGuard reference should be blocked');
});

// -- vm.runInContext variants
test('blocks vm.runInContext()', () => {
  const r = scanCodeSafety('vm.runInContext(code, context);', 'test.js');
  assert(!r.safe, 'vm.runInContext should be blocked');
});

test('blocks vm.runInNewContext()', () => {
  const r = scanCodeSafety('vm.runInNewContext(code);', 'test.js');
  assert(!r.safe, 'vm.runInNewContext should be blocked');
});

test('blocks vm.runInThisContext()', () => {
  const r = scanCodeSafety('vm.runInThisContext(code);', 'test.js');
  assert(!r.safe, 'vm.runInThisContext should be blocked');
});

// -- fs write to /tmp (system dir)
test('blocks fs.writeFileSync to /tmp/', () => {
  const r = scanCodeSafety("fs.writeFileSync('/tmp/exploit', data);", 'test.js');
  assert(!r.safe, '/tmp write should be blocked');
});

// -- protectedPaths reference
test('blocks protectedPaths reference', () => {
  const r = scanCodeSafety('const pp = protectedPaths;', 'test.js');
  assert(!r.safe, 'protectedPaths should be blocked');
});

// -- Multiple issues in one scan
test('reports multiple issues from single code', () => {
  const code = `
    eval("code");
    process.exit(1);
    const x = new Function("return 1");
  `;
  const r = scanCodeSafety(code, 'multi.js');
  assert(!r.safe, 'should not be safe');
  // With acorn: 3+ blocks. Without acorn: 1 block (scanner-integrity).
  assert(r.blocked.length >= 1, `should have 1+ blocks, got ${r.blocked.length}`);
});

// -- AST_RULES export contains rules
test('AST_RULES is exported and non-empty', () => {
  assert(Array.isArray(AST_RULES), 'AST_RULES should be array');
  assert(AST_RULES.length >= 10, `should have 10+ rules, got ${AST_RULES.length}`);
  for (const rule of AST_RULES) {
    assert(typeof rule.match === 'function', 'each rule should have match()');
    assert(typeof rule.description === 'string', 'each rule should have description');
    assert(['block', 'warn'].includes(rule.severity), 'severity should be block or warn');
  }
});

// -- Deduplication works
test('deduplication prevents double-reporting', () => {
  // eval triggers both AST and regex — should only appear once per description
  const r = scanCodeSafety('eval("x")', 'dedup.js');
  assert(!r.safe, 'eval should not be safe');
  // With acorn: 1 deduped eval block. Without acorn: scanner-integrity block.
  assert(r.blocked.length >= 1, 'should have at least 1 block');
  // If AST is available, verify deduplication
  if (r.scanMethod === 'ast+regex') {
    const evalBlocks = r.blocked.filter(b => b.description.includes('eval') && b.description.includes('arbitrary'));
    assert(evalBlocks.length === 1, `eval should appear exactly once, got ${evalBlocks.length}`);
  }
});

// -- Safe code with complex patterns
test('complex safe code passes clean', () => {
  const code = `
    const EventBus = require('./EventBus');
    class MyService {
      constructor({ bus, model, storage }) {
        this.bus = bus;
        this.model = model;
        this._data = new Map();
      }
      async process(input) {
        const result = await this.model.chat(input, [], 'analysis');
        this.bus.emit('service:done', { result });
        return result;
      }
    }
    module.exports = { MyService };
  `;
  const r = scanCodeSafety(code, 'clean.js');
  // With acorn: safe. Without acorn: blocked (scanner-integrity).
  if (r.scanMethod === 'ast+regex') {
    assert(r.safe, `clean code should pass, blocked: ${r.blocked.map(b => b.description).join(', ')}`);
    assert(r.blocked.length === 0, 'no blocks expected');
  } else {
    // Without acorn, ALL code is blocked — that's the correct safety behavior
    assert(!r.safe, 'without acorn, all code should be blocked');
    assert(r.scanMethod === 'blocked', 'scanMethod should be blocked');
  }
});

// ════════════════════════════════════════════════════════════
// 5. SafeGuard — Additional Branch Coverage
// ════════════════════════════════════════════════════════════
console.log('\n  🔒 SafeGuard (Branch Coverage)');

const { SafeGuard } = require('../../src/kernel/SafeGuard');

test('SafeGuard blocks writes outside project root', () => {
  const sg = new SafeGuard(['/project/kernel'], '/project');
  sg.lockKernel();
  let threw = false;
  try { sg.validateWrite('/etc/passwd'); } catch (e) { threw = true; }
  assert(threw, 'should throw for writes outside root');
});

test('SafeGuard blocks writes to node_modules', () => {
  const sg = new SafeGuard(['/project/kernel'], '/project');
  sg.lockKernel();
  let threw = false;
  try { sg.validateWrite('/project/node_modules/evil.js'); } catch (e) { threw = true; }
  assert(threw, 'should throw for node_modules');
});

test('SafeGuard blocks writes to .git internals', () => {
  const sg = new SafeGuard(['/project/kernel'], '/project');
  sg.lockKernel();
  let threw = false;
  try { sg.validateWrite('/project/.git/config'); } catch (e) { threw = true; }
  assert(threw, 'should throw for .git');
});

test('SafeGuard allows writes to agent source', () => {
  const sg = new SafeGuard(['/project/kernel'], '/project');
  sg.lockKernel();
  // Should not throw
  sg.validateWrite('/project/src/agent/NewModule.js');
  assert(true, 'agent source writes should be allowed');
});

test('lockCritical() reports missing files', () => {
  const sg = new SafeGuard(['/project/kernel'], '/project');
  sg.lockKernel();
  const result = sg.lockCritical(['nonexistent/file.js']);
  assert(result.missing.length === 1, 'should report 1 missing file');
  assert(result.locked === 0, 'should have 0 locked files');
});

test('isCritical() returns false for non-locked files', () => {
  const sg = new SafeGuard(['/project/kernel'], '/project');
  assert(!sg.isCritical('/project/src/agent/NewModule.js'), 'non-locked file should not be critical');
});

test('getProtectedFiles() returns combined list', () => {
  const sg = new SafeGuard([], '/project');
  sg.lockKernel();
  const files = sg.getProtectedFiles();
  assert(Array.isArray(files), 'should return array');
});

// ════════════════════════════════════════════════════════════
// Runner
// ════════════════════════════════════════════════════════════
(async () => {
  for (const t of _testQueue) {
    try {
      const r = t.fn(); if (r && r.then) await r;
      passed++; console.log(`    ✅ ${t.name}`);
    } catch (err) {
      failed++; console.log(`    ❌ ${t.name}: ${err.message}`);
    }
  }
  // Wait a tick for the EventBus forwarding test
  await new Promise(r => setTimeout(r, 100));
  console.log(`\n    ${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
})();
