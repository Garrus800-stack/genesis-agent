// ============================================================
// Test: v3.5.0 — CognitiveMonitor, HTNPlanner, TaskDelegation, Ports
// ============================================================
let passed = 0, failed = 0;
const failures = [];

function test(name, fn) {
  // v3.5.2: Fixed — try/catch around fn() for sync errors
  try {
    const result = fn();
    if (result && typeof result.then === 'function') {
      return result.then(() => {
        passed++; console.log(`    ✅ ${name}`);
      }).catch(err => {
        failed++; failures.push({ name, error: err.message });
        console.log(`    ❌ ${name}: ${err.message}`);
      });
    }
    passed++; console.log(`    ✅ ${name}`);
  } catch (err) {
    failed++; failures.push({ name, error: err.message });
    console.log(`    ❌ ${name}: ${err.message}`);
  }
}
function assert(c, m) { if (!c) throw new Error(m || 'Assertion failed'); }

const { NullBus } = require('../../src/agent/core/EventBus');

// ════════════════════════════════════════════════════════════
// PORTS
// ════════════════════════════════════════════════════════════

const { MockLLM, MockMemory, MockKnowledge, MockSandbox } = require('../../src/agent/ports');

console.log('\n  🔌 Hexagonal Ports');

test('MockLLM.chat returns configured response', async () => {
  const llm = new MockLLM({ chat: 'Hello back' });
  const result = await llm.chat('sys', [{ role: 'user', content: 'hi' }], 'chat');
  assert(result === 'Hello back', `Expected 'Hello back', got '${result}'`);
});

test('MockLLM records calls', async () => {
  const llm = new MockLLM({ default: 'ok' });
  await llm.chat('sys1', [], 'code');
  await llm.chat('sys2', [{ role: 'user', content: 'x' }], 'analysis');
  assert(llm.getCalls().length === 2);
  assert(llm.lastCall().taskType === 'analysis');
});

test('MockLLM.streamChat chunks response', async () => {
  const llm = new MockLLM({ default: 'word1 word2 word3' });
  const chunks = [];
  await llm.streamChat('sys', [], (chunk) => chunks.push(chunk));
  assert(chunks.length === 3, `Expected 3 chunks, got ${chunks.length}`);
});

test('MockMemory stores episodes', async () => {
  const mem = new MockMemory();
  await mem.addEpisode([{ role: 'user', content: 'test' }]);
  assert(mem._episodes.length === 1);
});

test('MockMemory semantic operations', () => {
  const mem = new MockMemory();
  mem.addSemantic('user.name', 'Garrus', 'test');
  assert(mem.getSemantic('user.name') === 'Garrus');
  assert(mem.getSemantic('nonexistent') === null);
});

test('MockKnowledge stores triples', () => {
  const kg = new MockKnowledge();
  kg.addTriple('Genesis', 'is', 'AI Agent');
  assert(kg._triples.length === 1);
  assert(kg._triples[0].s === 'Genesis');
});

test('MockSandbox tracks executions', async () => {
  const sbx = new MockSandbox();
  await sbx.execute('console.log("hi")');
  assert(sbx._executions.length === 1);
  assert(sbx.getAuditLog().length === 1);
});

test('MockSandbox configurable results', async () => {
  const sbx = new MockSandbox();
  sbx.setExecResult({ output: 'custom', error: null });
  const result = await sbx.execute('test');
  assert(result.output === 'custom');
});

// ════════════════════════════════════════════════════════════
// COGNITIVE MONITOR
// ════════════════════════════════════════════════════════════

const { CognitiveMonitor } = require('../../src/agent/autonomy/CognitiveMonitor');

console.log('\n  🧠 CognitiveMonitor');

test('constructs without errors', () => {
  const cm = new CognitiveMonitor({ bus: NullBus });
  assert(cm._toolCalls.length === 0);
  assert(cm._reasoningChains.length === 0);
  assert(cm._cognitiveLoad === 0);
});

test('recordToolCall tracks calls', () => {
  const cm = new CognitiveMonitor({ bus: NullBus });
  cm.recordToolCall('read-file', true, 150);
  cm.recordToolCall('read-file', true, 200);
  cm.recordToolCall('web-search', false, 500);
  const analytics = cm.getToolAnalytics();
  assert(analytics.perTool['read-file'].calls === 2);
  assert(analytics.perTool['read-file'].successRate === 100);
  assert(analytics.perTool['web-search'].calls === 1);
  assert(analytics.perTool['web-search'].successRate === 0);
});

test('detects redundant tool calls', () => {
  const cm = new CognitiveMonitor({ bus: NullBus });
  // Simulate 5 rapid calls to same tool
  for (let i = 0; i < 5; i++) {
    cm.recordToolCall('read-file', true, 10);
  }
  const analytics = cm.getToolAnalytics();
  assert(analytics.redundantPatterns.length > 0, 'Should detect redundant pattern');
  assert(analytics.redundantPatterns[0].tool === 'read-file');
});

test('recordReasoning detects circularity', () => {
  const cm = new CognitiveMonitor({ bus: NullBus, config: { circularityThreshold: 0.7 } });
  cm.recordReasoning('The solution is to refactor the module by extracting the service layer');
  cm.recordReasoning('We need to implement error handling in the API endpoint');
  const result = cm.recordReasoning('The solution is to refactor the module by extracting the service layer');
  assert(result.circular === true, 'Should detect circular reasoning');
});

test('detects oscillation pattern', () => {
  const cm = new CognitiveMonitor({ bus: NullBus, config: { circularityThreshold: 0.7 } });
  cm.recordReasoning('Approach A: use a singleton pattern for the service');
  cm.recordReasoning('Approach B: use dependency injection instead of singleton');
  const result = cm.recordReasoning('Approach A: use a singleton pattern for the service');
  // Should detect A→B→A oscillation
  assert(result.circular === true, 'Should detect oscillation');
});

test('token budget tracking', () => {
  const cm = new CognitiveMonitor({ bus: NullBus, config: { maxContextTokens: 8192 } });
  cm.updateTokenUsage(4000);
  const budget = cm.getTokenBudget();
  assert(budget.current === 4000);
  assert(budget.usagePercent === 49);

  cm.updateTokenUsage(7500);
  const budget2 = cm.getTokenBudget();
  assert(budget2.usagePercent === 92);
  assert(budget2.warnings > 0, 'Should have warned about high usage');
});

test('decision quality tracking', () => {
  const cm = new CognitiveMonitor({ bus: NullBus });
  cm.recordDecision('Use SQLite for storage', 'goal_1');
  cm.recordDecision('Implement caching layer', 'goal_1');
  cm.evaluateDecision(0, 'success');
  cm.evaluateDecision(1, 'failure');
  const quality = cm.getDecisionQuality();
  assert(quality.evaluated === 2);
  assert(quality.rollingQuality === 50, `Expected 50, got ${quality.rollingQuality}`);
});

test('cognitive load calculation', () => {
  const cm = new CognitiveMonitor({ bus: NullBus, config: { maxContextTokens: 8192 } });
  cm.updateTokenUsage(2000);
  const load = cm.getCognitiveLoad();
  assert(load.overall >= 0 && load.overall <= 100);
  assert(typeof load.components.tokenUsage === 'number');
  assert(typeof load.components.toolActivity === 'number');
});

test('getInsightsForPrompt returns null when idle', () => {
  const cm = new CognitiveMonitor({ bus: NullBus });
  const insights = cm.getInsightsForPrompt();
  assert(insights === null, 'Should return null when everything is normal');
});

test('getReport combines all sections', () => {
  const cm = new CognitiveMonitor({ bus: NullBus });
  cm.recordToolCall('test', true, 100);
  cm.recordReasoning('test reasoning');
  const report = cm.getReport();
  assert(report.cognitiveLoad, 'Should have cognitiveLoad');
  assert(report.toolAnalytics, 'Should have toolAnalytics');
  assert(report.circularity, 'Should have circularity');
  assert(report.tokenBudget, 'Should have tokenBudget');
  assert(report.decisionQuality, 'Should have decisionQuality');
});

// ════════════════════════════════════════════════════════════
// HTN PLANNER
// ════════════════════════════════════════════════════════════

const { HTNPlanner } = require('../../src/agent/revolution/HTNPlanner');

console.log('\n  📋 HTNPlanner');

test('constructs without errors', () => {
  const htn = new HTNPlanner({ bus: NullBus });
  assert(htn._defaultCosts.CODE, 'Should have default costs');
});

test('validatePlan checks CODE steps', async () => {
  const htn = new HTNPlanner({
    bus: NullBus, rootDir: require('path').join(require('os').tmpdir(), 'test-genesis'),
    guard: { isProtected: (p) => p.includes('kernel') },
  });
  const steps = [
    { type: 'CODE', action: 'Write new file', target: 'src/test.js' },
    { type: 'CODE', action: 'Modify kernel', target: 'src/kernel/SafeGuard.js' },
  ];
  const result = await htn.validatePlan(steps);
  // Kernel file should be flagged
  const kernelStep = result.steps.find(s => s.stepIndex === 1);
  assert(kernelStep.issues.length > 0, 'Kernel file should have issues');
});

test('validatePlan detects dangerous SHELL commands', async () => {
  const htn = new HTNPlanner({ bus: NullBus, rootDir: '/tmp' });
  const steps = [
    { type: 'SHELL', action: 'Clean up', target: 'rm -rf /' },
  ];
  const result = await htn.validatePlan(steps);
  assert(result.steps[0].issues.length > 0, 'Should flag dangerous rm -rf');
});

test('validatePlan detects duplicate file modifications', async () => {
  const htn = new HTNPlanner({ bus: NullBus, rootDir: '/tmp' });
  const steps = [
    { type: 'CODE', action: 'Write v1', target: 'src/app.js' },
    { type: 'CODE', action: 'Write v2', target: 'src/app.js' },
  ];
  const result = await htn.validatePlan(steps);
  assert(result.crossIssues.length > 0, 'Should detect duplicate file modification');
});

test('estimateCost returns per-step costs', () => {
  const htn = new HTNPlanner({ bus: NullBus });
  const steps = [
    { type: 'ANALYZE', action: 'Think' },
    { type: 'CODE', action: 'Write code' },
    { type: 'SANDBOX', action: 'Test' },
  ];
  const cost = htn.estimateCost(steps);
  assert(cost.totalSteps === 3);
  assert(cost.totalLLMCalls > 0);
  assert(cost.totalTokensEstimated > 0);
  assert(cost.perStep.length === 3);
  assert(typeof cost.estimatedDurationHuman === 'string');
});

test('recordActualCost updates history', () => {
  const htn = new HTNPlanner({ bus: NullBus });
  htn.recordActualCost('CODE', { llmCalls: 3, tokens: 5000, durationMs: 15000 });
  htn.recordActualCost('CODE', { llmCalls: 2, tokens: 3000, durationMs: 10000 });
  htn.recordActualCost('CODE', { llmCalls: 4, tokens: 6000, durationMs: 20000 });
  assert(htn._costHistory.byType.CODE.count === 3);
  assert(htn._costHistory.sampleCount === 3);
});

test('dryRun combines validation and cost', async () => {
  const htn = new HTNPlanner({ bus: NullBus, rootDir: '/tmp' });
  const steps = [
    { type: 'ANALYZE', action: 'Plan' },
    { type: 'CODE', action: 'Implement', target: 'src/new.js' },
  ];
  const report = await htn.dryRun(steps);
  assert(typeof report.valid === 'boolean');
  assert(report.validation, 'Should have validation');
  assert(report.cost, 'Should have cost');
  assert(typeof report.summary === 'string');
});

// ════════════════════════════════════════════════════════════
// TASK DELEGATION
// ════════════════════════════════════════════════════════════

const { TaskDelegation } = require('../../src/agent/hexagonal/TaskDelegation');

console.log('\n  🤝 TaskDelegation');

test('constructs without errors', () => {
  const td = new TaskDelegation({ bus: NullBus });
  assert(td._activeTasks.size === 0);
  assert(td._receivedTasks.size === 0);
});

test('delegate fails without network', async () => {
  const td = new TaskDelegation({ bus: NullBus });
  const result = await td.delegate('Test task', ['coding']);
  assert(result.success === false);
  assert(result.error.includes('PeerNetwork'));
});

test('receiveTask accepts and queues', () => {
  const td = new TaskDelegation({ bus: NullBus });
  td.setTaskHandler(async () => 'done');
  const result = td.receiveTask({
    taskId: 'task_1', description: 'Write tests', requiredSkills: ['testing'],
  });
  assert(result.accepted === true);
  assert(td._receivedTasks.size === 1);
});

test('receiveTask rejects when queue full', () => {
  const td = new TaskDelegation({ bus: NullBus });
  td.setTaskHandler(async () => 'done');
  td.receiveTask({ taskId: 't1', description: 'task 1' });
  td.receiveTask({ taskId: 't2', description: 'task 2' });
  td.receiveTask({ taskId: 't3', description: 'task 3' });
  const result = td.receiveTask({ taskId: 't4', description: 'task 4' });
  assert(result.accepted === false, `Should reject when queue is full, got: ${JSON.stringify(result)}`);
});

test('getTaskStatus returns unknown for missing tasks', () => {
  const td = new TaskDelegation({ bus: NullBus });
  const status = td.getTaskStatus('nonexistent');
  assert(status.status === 'unknown');
});

test('getTaskStatus tracks received tasks', () => {
  const td = new TaskDelegation({ bus: NullBus });
  td.setTaskHandler(async () => 'done');
  td.receiveTask({ taskId: 'task_x', description: 'test' });
  const status = td.getTaskStatus('task_x');
  assert(status.status === 'pending' || status.status === 'running' || status.status === 'done');
});

test('getStatus returns combined view', () => {
  const td = new TaskDelegation({ bus: NullBus });
  td.setTaskHandler(async () => 'done');
  td.receiveTask({ taskId: 'rx1', description: 'received task' });
  const status = td.getStatus();
  assert(typeof status.activeDelegations === 'number');
  assert(typeof status.receivedTasks === 'number');
  assert(status.receivedTasks === 1);
});

test('getEndpointHandlers returns three handlers', () => {
  const td = new TaskDelegation({ bus: NullBus });
  const handlers = td.getEndpointHandlers();
  assert(typeof handlers.submit === 'function');
  assert(typeof handlers.status === 'function');
  assert(typeof handlers.cancel === 'function');
});

test('setTaskHandler registers custom handler', () => {
  const td = new TaskDelegation({ bus: NullBus });
  let called = false;
  td.setTaskHandler(async (desc) => { called = true; return 'done'; });
  assert(td._taskHandler !== null);
});

// ════════════════════════════════════════════════════════════
// PROMPTBUILDER METACOGNITION
// ════════════════════════════════════════════════════════════

const { PromptBuilder } = require('../../src/agent/intelligence/PromptBuilder');

console.log('\n  🧩 PromptBuilder metacognition');

test('PromptBuilder has cognitiveMonitor slot', () => {
  const pb = new PromptBuilder({
    selfModel: { getFullModel: () => ({ identity: 'test', version: '1' }), getCapabilities: () => [] },
    model: { activeModel: 'test' },
    skills: null, knowledgeGraph: null, memory: null,
  });
  assert(pb.cognitiveMonitor === null, 'cognitiveMonitor should start as null');
});

test('_metacognitiveContext returns empty when no monitor', () => {
  const pb = new PromptBuilder({
    selfModel: { getFullModel: () => ({ identity: 'test', version: '1' }), getCapabilities: () => [] },
    model: { activeModel: 'test' },
    skills: null, knowledgeGraph: null, memory: null,
  });
  assert(pb._metacognitiveContext() === '', 'Should return empty string without monitor');
});

test('_metacognitiveContext returns insights when wired', () => {
  const pb = new PromptBuilder({
    selfModel: { getFullModel: () => ({ identity: 'test', version: '1' }), getCapabilities: () => [] },
    model: { activeModel: 'test' },
    skills: null, knowledgeGraph: null, memory: null,
  });
  // Wire a mock CognitiveMonitor
  const cm = new CognitiveMonitor({ bus: NullBus, config: { maxContextTokens: 100 } });
  cm.updateTokenUsage(90); // 90% usage → should produce insight
  pb.cognitiveMonitor = cm;
  const ctx = pb._metacognitiveContext();
  assert(typeof ctx === 'string');
  assert(ctx.includes('META') || ctx.includes('Token'), `Expected META insight, got: "${ctx}"`);
});

test('build() includes metacognition section', () => {
  const pb = new PromptBuilder({
    selfModel: { getFullModel: () => ({ identity: 'test', version: '1' }), getCapabilities: () => [] },
    model: { activeModel: 'test' },
    skills: null, knowledgeGraph: null, memory: null,
  });
  const cm = new CognitiveMonitor({ bus: NullBus, config: { maxContextTokens: 100 } });
  cm.updateTokenUsage(90);
  pb.cognitiveMonitor = cm;
  const prompt = pb.build();
  assert(prompt.includes('META') || prompt.includes('Token'),
    'Build output should include metacognitive insights when load is high');
});

// ════════════════════════════════════════════════════════════
// LLMPORT EXTENDED API
// ════════════════════════════════════════════════════════════

console.log('\n  🔌 LLMPort extended');

test('MockLLM.chatStructured returns parsed JSON', async () => {
  const llm = new MockLLM({ default: '{"result": "ok"}' });
  const result = await llm.chatStructured('sys', [], 'analysis');
  assert(result.result === 'ok', `Expected parsed JSON, got: ${JSON.stringify(result)}`);
});

test('MockLLM.chatStructured handles non-JSON gracefully', async () => {
  const llm = new MockLLM({ default: 'not json' });
  const result = await llm.chatStructured('sys', [], 'analysis');
  assert(result._parseError === true, 'Should flag parse error');
  assert(result._raw === 'not json');
});

test('MockLLM exposes temperatures', () => {
  const llm = new MockLLM({});
  assert(typeof llm.temperatures === 'object');
  assert(llm.temperatures.code === 0.1);
});

test('MockLLM exposes backends', () => {
  const llm = new MockLLM({});
  assert(typeof llm.backends === 'object');
  assert(llm.backends.ollama, 'Should have ollama backend');
});

// ── Summary ───────────────────────────────────────────────
setTimeout(() => {
  console.log(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
  console.log(`  v3.5.0 Modules: ${passed} passed, ${failed} failed`);
  console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
  if (failures.length > 0) {
    console.log('  Failures:');
    failures.forEach(f => console.log(`    - ${f.name}: ${f.error}`));
  }
}, 500);
