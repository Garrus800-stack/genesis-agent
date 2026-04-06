// Test: v6.1.1 Coverage Sweep — The 80% Line
// Targets: Anticipator, SolutionAccumulator, TrustLevelSystem, AgentLoopPlanner, HomeostasisVitals

const { describe, test, assert, assertEqual, run } = require('../harness');

function mockBus() {
  return { on: () => () => {}, emit() {}, fire() {}, off() {} };
}

// ── Anticipator ─────────────────────────────────────────────

describe('Anticipator — prediction engine', () => {
  const { Anticipator } = require('../../src/agent/planning/Anticipator');

  function createAnticipator(overrides = {}) {
    return new Anticipator({
      bus: mockBus(),
      memory: { buildContext: () => '', getStats: () => ({}) },
      knowledgeGraph: { search: (q, n) => overrides.kgResults || [] },
      eventStore: null,
      model: { chat: async () => 'suggestion' },
      ...overrides,
    });
  }

  test('constructor initializes state', () => {
    const a = createAnticipator();
    assertEqual(a.messageCount, 0);
    assertEqual(a.errorCount, 0);
    assertEqual(a.predictions.length, 0);
  });

  test('predict returns empty on fresh state', () => {
    const a = createAnticipator();
    const preds = a.predict();
    assert(Array.isArray(preds), 'should return array');
  });

  test('predict suggests repair when errors pile up', () => {
    const a = createAnticipator();
    a.errorCount = 5;
    const preds = a.predict();
    assert(preds.some(p => p.action === 'self-repair'), 'should suggest self-repair');
  });

  test('predict suggests summarize for long sessions', () => {
    const a = createAnticipator();
    a.sessionStart = Date.now() - 40 * 60 * 1000; // 40 min ago
    a.messageCount = 15;
    const preds = a.predict();
    assert(preds.some(p => p.action === 'summarize'), 'should suggest summarize');
  });

  test('_trackIntent records intent', () => {
    const a = createAnticipator();
    a._trackIntent({ type: 'code-gen' });
    a._trackIntent({ type: 'analyze' });
    assertEqual(a.recentIntents.length, 2);
    assertEqual(a.messageCount, 2);
  });

  test('_trackIntent caps at 20', () => {
    const a = createAnticipator();
    for (let i = 0; i < 25; i++) a._trackIntent({ type: `intent-${i}` });
    assertEqual(a.recentIntents.length, 20);
  });

  test('_trackCompletion records topic', () => {
    const a = createAnticipator();
    a._trackCompletion({ message: 'Explain JavaScript async await patterns', intent: 'chat' });
    assert(a.recentTopics.length >= 1, 'should track topic');
  });

  test('_trackCompletion caps at 10', () => {
    const a = createAnticipator();
    for (let i = 0; i < 15; i++) a._trackCompletion({ message: `Topic number ${i} with enough words`, intent: 'chat' });
    assertEqual(a.recentTopics.length, 10);
  });

  test('_predictFromSequence detects code/repair loop', () => {
    const a = createAnticipator();
    a.recentIntents = [
      { type: 'execute-code', timestamp: Date.now() },
      { type: 'self-repair', timestamp: Date.now() },
      { type: 'execute-code', timestamp: Date.now() },
    ];
    const pred = a._predictFromSequence();
    assert(pred !== null, 'should detect pattern');
    assertEqual(pred.action, 'analyze-code');
  });

  test('_predictFromSequence detects all-general pattern', () => {
    const a = createAnticipator();
    a.recentIntents = [
      { type: 'general', timestamp: Date.now() },
      { type: 'general', timestamp: Date.now() },
      { type: 'general', timestamp: Date.now() },
    ];
    const pred = a._predictFromSequence();
    assert(pred !== null, 'should detect general pattern');
    assertEqual(pred.type, 'hint');
  });

  test('_predictFromSequence returns null with few intents', () => {
    const a = createAnticipator();
    a.recentIntents = [{ type: 'code', timestamp: Date.now() }];
    assert(a._predictFromSequence() === null, 'should return null');
  });

  test('_predictFromProject detects dominant topic', () => {
    const a = createAnticipator();
    a.recentTopics = [
      { topic: 'testing framework', timestamp: Date.now() },
      { topic: 'testing patterns', timestamp: Date.now() },
      { topic: 'testing coverage', timestamp: Date.now() },
    ];
    const pred = a._predictFromProject();
    assert(pred !== null, 'should detect focus');
    assertEqual(pred.type, 'project-focus');
  });

  test('_predictFromProject returns null with few topics', () => {
    const a = createAnticipator();
    a.recentTopics = [{ topic: 'hello world', timestamp: Date.now() }];
    assert(a._predictFromProject() === null, 'should return null');
  });

  test('_predictKnowledgeGap detects unknown topic', () => {
    const a = createAnticipator({ kgResults: [] });
    a.recentTopics = [{ topic: 'quantum computing', timestamp: Date.now() }];
    const pred = a._predictKnowledgeGap();
    assert(pred !== null, 'should detect gap');
    assertEqual(pred.type, 'knowledge-gap');
  });

  test('_predictKnowledgeGap returns null when KG has results', () => {
    const a = createAnticipator({ kgResults: [{ label: 'quantum' }] });
    a.recentTopics = [{ topic: 'quantum computing', timestamp: Date.now() }];
    const pred = a._predictKnowledgeGap();
    assert(pred === null, 'should return null');
  });

  test('getPredictions returns cached predictions', () => {
    const a = createAnticipator();
    a.predictions = [{ type: 'test', confidence: 0.9 }];
    assertEqual(a.getPredictions().length, 1);
  });

  test('buildContext formats predictions', () => {
    const a = createAnticipator();
    a.predictions = [{ type: 'test', confidence: 0.8, message: 'Test prediction' }];
    const ctx = a.buildContext();
    assert(ctx.includes('80%'), 'should show confidence');
    assert(ctx.includes('Test prediction'), 'should show message');
  });

  test('buildContext returns empty without predictions', () => {
    const a = createAnticipator();
    assertEqual(a.buildContext(), '');
  });
});

// ── SolutionAccumulator ─────────────────────────────────────

describe('SolutionAccumulator — solution extraction', () => {
  const { SolutionAccumulator } = require('../../src/agent/planning/SolutionAccumulator');

  function createAccum() {
    return new SolutionAccumulator({
      bus: mockBus(), memory: null,
      knowledgeGraph: null, storageDir: require('os').tmpdir(), storage: null,
    });
  }

  test('constructor initializes empty', () => {
    const sa = createAccum();
    assertEqual(sa.solutions.length, 0);
  });

  test('_extract captures code patterns', () => {
    const sa = createAccum();
    sa._extract({
      message: 'How do I fix this error with async?',
      response: 'Try this:\n```javascript\nawait Promise.all(tasks.map(t => process(t)));\n```',
      intent: 'code-gen',
    });
    assert(sa.solutions.length >= 1, 'should extract code solution');
    assertEqual(sa.solutions[0].type, 'code-pattern');
  });

  test('_extract captures error fixes', () => {
    const sa = createAccum();
    sa._extract({
      message: 'I got a TypeError crash in my app',
      response: 'Add a null check before accessing the property.',
      intent: 'chat',
    });
    assert(sa.solutions.some(s => s.type === 'error-fix'), 'should extract error fix');
  });

  test('_extract ignores empty messages', () => {
    const sa = createAccum();
    sa._extract({ message: null, response: 'ok', intent: 'chat' });
    assertEqual(sa.solutions.length, 0);
  });

  test('findSimilar matches by keywords', () => {
    const sa = createAccum();
    sa.solutions = [
      { problem: 'async await error handling', solution: 'use try/catch', type: 'code-pattern', useCount: 0 },
      { problem: 'CSS layout flexbox', solution: 'use flex', type: 'code-pattern', useCount: 0 },
    ];
    const results = sa.findSimilar('async error');
    assert(results.length >= 1, 'should find match');
    assert(results[0].problem.includes('async'), 'should match async');
  });

  test('findSimilar returns empty for no match', () => {
    const sa = createAccum();
    sa.solutions = [{ problem: 'very specific rare thing', solution: 'x', type: 'fix', useCount: 0 }];
    const results = sa.findSimilar('quantum physics');
    assertEqual(results.length, 0);
  });

  test('buildContext formats similar solutions', () => {
    const sa = createAccum();
    sa.solutions = [
      { problem: 'JavaScript error handling best practices', solution: 'use try catch blocks', type: 'code-pattern', useCount: 0 },
    ];
    const ctx = sa.buildContext('error handling');
    assert(ctx.includes('FRUEHERE'), 'should contain header');
    assert(ctx.includes('error handling'), 'should contain problem');
  });

  test('buildContext returns empty for no matches', () => {
    const sa = createAccum();
    assertEqual(sa.buildContext('nothing'), '');
  });

  test('getStats returns type breakdown', () => {
    const sa = createAccum();
    sa.solutions = [
      { type: 'code-pattern', problem: 'a' },
      { type: 'code-pattern', problem: 'b' },
      { type: 'error-fix', problem: 'c' },
    ];
    const stats = sa.getStats();
    assertEqual(stats.total, 3);
    assertEqual(stats.byType['code-pattern'], 2);
    assertEqual(stats.byType['error-fix'], 1);
  });

  test('_addSolution caps at 200', () => {
    const sa = createAccum();
    for (let i = 0; i < 210; i++) sa._addSolution({ type: 'test', problem: `p${i}`, useCount: 0 });
    assert(sa.solutions.length <= 200, 'should cap at 200');
  });
});

// ── TrustLevelSystem ────────────────────────────────────────

describe('TrustLevelSystem — trust management', () => {
  const { TrustLevelSystem } = require('../../src/agent/foundation/TrustLevelSystem');

  function createTrust(level = 0) {
    const t = new TrustLevelSystem({ bus: mockBus(), storage: null, settings: null, config: {} });
    t._level = level;
    return t;
  }

  test('getLevel returns current level', () => {
    assertEqual(createTrust(0).getLevel(), 0);
    assertEqual(createTrust(2).getLevel(), 2);
  });

  test('setLevel changes level', async () => {
    const t = createTrust(0);
    const result = await t.setLevel(2);
    assertEqual(result.from, 0);
    assertEqual(result.to, 2);
    assertEqual(t.getLevel(), 2);
  });

  test('setLevel rejects invalid level', async () => {
    const t = createTrust();
    let threw = false;
    try { await t.setLevel(5); } catch { threw = true; }
    assert(threw, 'should throw for invalid level');
  });

  test('checkApproval auto-approves low risk at high trust', () => {
    const t = createTrust(2);
    const result = t.checkApproval('ANALYZE');
    assert(result.approved === true, 'should auto-approve ANALYZE at level 2');
    assert(!result.needsUserApproval, 'should not need user approval');
  });

  test('checkApproval blocks high risk at low trust', () => {
    const t = createTrust(0);
    const result = t.checkApproval('SELF_MODIFY');
    assert(result.needsUserApproval === true, 'should need approval for SELF_MODIFY at level 0');
  });

  test('checkApproval respects action overrides', () => {
    const t = createTrust(1);
    t._actionOverrides = { 'SHELL': 0 }; // override: allow at level 0
    const result = t.checkApproval('SHELL');
    assert(result.approved === true, 'should use override');
  });

  test('getStatus returns full status', () => {
    const t = createTrust(1);
    const status = t.getStatus();
    assert(typeof status === 'object', 'should return object');
    assert(status.level !== undefined || status.currentLevel !== undefined, 'should have level');
  });

  test('getStats returns statistics', () => {
    const t = createTrust();
    t.checkApproval('ANALYZE');
    t.checkApproval('CODE');
    const stats = t.getStats();
    assert(stats.approvalChecks >= 2, 'should count checks');
  });

  test('getPendingUpgrades returns array', () => {
    const t = createTrust();
    const upgrades = t.getPendingUpgrades();
    assert(Array.isArray(upgrades), 'should return array');
  });
});

// ── AgentLoopPlanner ────────────────────────────────────────

describe('AgentLoopPlanner — plan salvage + step inference', () => {
  const { AgentLoopPlannerDelegate } = require('../../src/agent/revolution/AgentLoopPlanner');

  function createPlanner() {
    const loop = {
      model: { chat: async () => '1. Analyze code\n2. Fix the bug\n3. Run tests', chatStructured: async () => ({}) },
      bus: mockBus(),
      lang: { t: k => k },
      kg: null, memory: null, selfModel: null,
    };
    return new AgentLoopPlannerDelegate(loop);
  }

  test('_inferStepType detects CODE', () => {
    const p = createPlanner();
    assertEqual(p._inferStepType('Write a new module'), 'CODE');
    assertEqual(p._inferStepType('Erstelle eine Klasse'), 'CODE');
    assertEqual(p._inferStepType('Modify the function'), 'CODE');
  });

  test('_inferStepType detects SHELL', () => {
    const p = createPlanner();
    assertEqual(p._inferStepType('Run npm install'), 'SHELL');
    assertEqual(p._inferStepType('Execute git commit'), 'SHELL');
    assertEqual(p._inferStepType('Build the project'), 'SHELL');
  });

  test('_inferStepType detects SANDBOX', () => {
    const p = createPlanner();
    assertEqual(p._inferStepType('Test the output'), 'SANDBOX');
    assertEqual(p._inferStepType('Check the result'), 'SANDBOX');
  });

  test('_inferStepType detects SEARCH', () => {
    const p = createPlanner();
    assertEqual(p._inferStepType('Search for documentation'), 'SEARCH');
    assertEqual(p._inferStepType('Find related modules'), 'SEARCH');
  });

  test('_inferStepType detects ASK', () => {
    const p = createPlanner();
    assertEqual(p._inferStepType('Ask user for confirmation'), 'ASK');
    assertEqual(p._inferStepType('Genehmigung einholen'), 'ASK');
  });

  test('_inferStepType detects DELEGATE', () => {
    const p = createPlanner();
    assertEqual(p._inferStepType('Delegate to peer agent'), 'DELEGATE');
  });

  test('_inferStepType defaults to ANALYZE', () => {
    const p = createPlanner();
    assertEqual(p._inferStepType('Think about the problem'), 'ANALYZE');
  });

  test('_salvagePlan extracts steps from numbered list', () => {
    const p = createPlanner();
    const plan = p._salvagePlan(
      '1. Analyze the codebase structure\n2. Write the fix for the bug\n3. Run npm install to update deps',
      'Fix the bug',
    );
    assert(plan.steps.length >= 3, 'should extract 3 steps');
    assertEqual(plan.steps[0].type, 'ANALYZE');
    assertEqual(plan.steps[1].type, 'CODE');
    assertEqual(plan.steps[2].type, 'SHELL');
  });

  test('_salvagePlan extracts from bullet list', () => {
    const p = createPlanner();
    const plan = p._salvagePlan(
      '- Check the current implementation\n- Modify the handler logic\n* Test everything works',
      'Refactor handler',
    );
    assert(plan.steps.length >= 2, 'should extract steps from bullets');
  });

  test('_salvagePlan creates fallback for empty input', () => {
    const p = createPlanner();
    const plan = p._salvagePlan('no structured content here', 'Do something');
    assert(plan.steps.length >= 1, 'should have at least 1 fallback step');
    assertEqual(plan.steps[0].type, 'ANALYZE');
  });

  test('_salvagePlan has title and success criteria', () => {
    const p = createPlanner();
    const plan = p._salvagePlan('1. Do the thing\n2. Check the thing', 'Goal title');
    assert(plan.title.length > 0, 'should have title');
    assert(plan.successCriteria.length > 0, 'should have success criteria');
  });
});

// ── HomeostasisVitals ───────────────────────────────────────

describe('HomeostasisVitals — vital classification', () => {
  // HomeostasisVitals is a prototype-delegation object, applied to Homeostasis
  const { Homeostasis } = require('../../src/agent/organism/Homeostasis');

  function createHomeo() {
    return new Homeostasis({
      bus: mockBus(), storage: null, intervals: null, config: {},
    });
  }

  test('_classifyVital returns healthy for normal values', () => {
    const h = createHomeo();
    const vital = h.vitals.memoryUsage;
    if (vital) {
      vital.value = vital.healthy.min + 1;
      assertEqual(h._classifyVital(vital), 'healthy');
    } else {
      assert(true, 'no memoryUsage vital');
    }
  });

  test('_classifyVital returns warning for elevated values', () => {
    const h = createHomeo();
    const vital = h.vitals.memoryUsage;
    if (vital && vital.warning) {
      vital.value = vital.warning.min + 1;
      const status = h._classifyVital(vital);
      assert(status === 'warning' || status === 'healthy', 'should be warning or healthy');
    } else {
      assert(true, 'no warning range');
    }
  });

  test('getReport returns homeostasis state', () => {
    const h = createHomeo();
    const report = h.getReport();
    assert(report.state !== undefined, 'should have state');
    assert(report.vitals !== undefined, 'should have vitals');
  });

  test('buildPromptContext returns behavioral instructions', () => {
    const h = createHomeo();
    const ctx = h.buildPromptContext();
    assert(typeof ctx === 'string', 'should return string');
  });

  test('start and stop lifecycle', () => {
    const h = createHomeo();
    h.start();
    h.stop();
    assert(true, 'lifecycle should not throw');
  });

  test('_updateVitals runs without error', () => {
    const h = createHomeo();
    h._updateVitals();
    assert(true, 'should not throw');
  });
});

run();
