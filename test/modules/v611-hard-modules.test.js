// Test: v6.1.1 Coverage Sweep — Hard Modules (the 80% push)
// Targets: AgentLoop, AgentLoopSteps, McpTransport

const { describe, test, assert, assertEqual, run } = require('../harness');

function mockBus() {
  return { on: () => () => {}, emit() {}, fire() {}, off() {} };
}

// ── AgentLoop ───────────────────────────────────────────────

describe('AgentLoop — state management', () => {
  const { AgentLoop } = require('../../src/agent/revolution/AgentLoop');

  function createLoop(overrides = {}) {
    return new AgentLoop({
      bus: mockBus(),
      model: { chat: async () => 'ok', chatStructured: async () => ({ adjust: false }), activeModel: 'test', activeBackend: 'mock' },
      goalStack: { addGoal: async () => ({}), getActiveGoals: () => [] },
      sandbox: { execute: async () => ({ output: 'ok' }), syntaxCheck: async () => ({ valid: true }) },
      selfModel: { readModule: () => 'code', getCapabilities: () => ['code'] },
      memory: { buildContext: () => '' },
      knowledgeGraph: { search: () => [], learnFromText: () => {} },
      tools: { listTools: () => [], hasTool: () => false },
      guard: { isProtected: () => false },
      eventStore: { append: () => {} },
      shellAgent: { run: async () => ({ ok: true, stdout: 'out', stderr: '' }) },
      selfModPipeline: { modify: async () => 'done' },
      lang: { t: k => k },
      storage: null,
      rootDir: '/tmp',
      ...overrides,
    });
  }

  test('constructor initializes default state', () => {
    const loop = createLoop();
    assertEqual(loop.running, false);
    assertEqual(loop.stepCount, 0);
    assertEqual(loop.currentGoalId, null);
  });

  test('getStatus returns state object', () => {
    const loop = createLoop();
    const status = loop.getStatus();
    assertEqual(status.running, false);
    assertEqual(status.stepCount, 0);
    assert(status.pendingApproval === null, 'no pending approval');
    assert(Array.isArray(status.recentLog), 'should have recentLog');
  });

  test('approve with no pending is safe', () => {
    const loop = createLoop();
    loop.approve(); // no pending → no-op
    assert(true, 'should not throw');
  });

  test('reject with no pending is safe', () => {
    const loop = createLoop();
    loop.reject('test reason');
    assert(true, 'should not throw');
  });

  test('approve resolves pending', async () => {
    const loop = createLoop();
    const p = loop.approval.request('CODE', 'test');
    loop.approve();
    const result = await p;
    assertEqual(result, true);
  });

  test('reject resolves pending with false', async () => {
    const loop = createLoop();
    const p = loop.approval.request('SHELL', 'test');
    loop.reject('nope');
    const result = await p;
    assertEqual(result, false);
  });

  test('stop sets running to false and cleans up', async () => {
    const loop = createLoop();
    loop.running = true;
    loop._unsubs = [() => {}];
    await loop.stop();
    assertEqual(loop.running, false);
  });

  test('stop cancels pending approval', async () => {
    const loop = createLoop();
    const p = loop.approval.request('x', 'x');
    await loop.stop();
    const result = await p;
    assertEqual(result, false);
  });

  test('_reportCognitiveLevel NONE when no services', () => {
    const loop = createLoop();
    loop.verifier = null;
    loop.formalPlanner = null;
    loop.worldState = null;
    loop._reportCognitiveLevel();
    assertEqual(loop._cognitiveLevel, 'NONE');
  });

  test('_reportCognitiveLevel FULL when all core bound', () => {
    const loop = createLoop();
    loop.verifier = {};
    loop.formalPlanner = {};
    loop.worldState = {};
    loop._reportCognitiveLevel();
    assertEqual(loop._cognitiveLevel, 'FULL');
  });

  test('_reportCognitiveLevel PARTIAL when some missing', () => {
    const loop = createLoop();
    loop.verifier = {};
    loop.formalPlanner = null;
    loop.worldState = {};
    loop._reportCognitiveLevel();
    assertEqual(loop._cognitiveLevel, 'PARTIAL');
  });

  test('_buildStepContext builds formatted context', () => {
    const loop = createLoop();
    loop._workspace = { buildContext: () => '' };
    loop._currentPlan = {};
    const ctx = loop._buildStepContext(
      { type: 'SHELL', description: 'run tests', target: 'test/' },
      1,
      [{ type: 'ANALYZE' }, { type: 'SHELL' }, { type: 'CODE' }],
      [{ output: 'step 1 output' }],
    );
    assert(ctx.includes('Genesis'), 'should contain Genesis');
    assert(ctx.includes('step 2/3'), 'should contain step number');
    assert(ctx.includes('run tests'), 'should contain step description');
    assert(ctx.includes('test/'), 'should contain target');
  });

  test('_buildStepContext with consciousness and value context', () => {
    const loop = createLoop();
    loop._workspace = { buildContext: () => 'workspace data' };
    loop._currentPlan = {
      _consciousnessContext: 'Focused state',
      _valueContext: 'reliability',
    };
    const ctx = loop._buildStepContext({ type: 'CODE', description: 'fix' }, 0, [{}], []);
    assert(ctx.includes('Focused state'), 'should include consciousness');
    assert(ctx.includes('reliability'), 'should include values');
    assert(ctx.includes('workspace data'), 'should include workspace');
  });

  test('_reflectOnProgress returns null when no errors', async () => {
    const loop = createLoop();
    const result = await loop._reflectOnProgress(
      { title: 'Test', steps: [{}, {}], successCriteria: 'done' },
      [{ output: 'ok' }, { output: 'ok' }],
      1,
    );
    assert(result === null, 'should return null for no errors');
  });
});

// ── AgentLoopSteps ──────────────────────────────────────────

describe('AgentLoopSteps — step execution dispatch', () => {
  const { AgentLoopStepsDelegate } = require('../../src/agent/revolution/AgentLoopSteps');

  function createSteps(loopOverrides = {}) {
    const loop = {
      model: { chat: async () => 'LLM response', activeModel: 'test' },
      selfModel: { readModule: (f) => f === 'test.js' ? 'const x = 1;' : null },
      memory: { buildContext: () => '' },
      kg: { search: () => [], learnFromText: () => {} },
      sandbox: { execute: async (code) => ({ output: 'sandbox out', error: null }) },
      shell: { run: async (cmd) => ({ ok: true, stdout: 'shell out', stderr: '', exitCode: 0 }) },
      selfMod: { modify: async () => 'modified' },
      tools: { hasTool: () => false },
      eventStore: { append: () => {} },
      bus: mockBus(),
      lang: { t: k => k },
      currentGoalId: 'goal-1',
      _workspace: { store: () => {}, recall: () => null },
      _symbolicResolver: null,
      _pendingApproval: null,
      ...loopOverrides,
    };
    const steps = new AgentLoopStepsDelegate(loop);
    return steps;
  }

  test('ANALYZE step calls model and returns result', async () => {
    const steps = createSteps();
    const result = await steps._executeStep(
      { type: 'ANALYZE', description: 'check code', target: 'test.js' },
      'context', () => {},
    );
    assert(result.output !== undefined, 'should have output');
    assert(result.durationMs >= 0, 'should track duration');
    assert(!result.error, 'should not have error');
  });

  test('SHELL step executes command', async () => {
    const steps = createSteps();
    const result = await steps._executeStep(
      { type: 'SHELL', description: 'list files', target: 'ls -la' },
      'context', () => {},
    );
    assert(result.output !== undefined, 'should have output');
  });

  test('SANDBOX step runs code', async () => {
    const steps = createSteps();
    const result = await steps._executeStep(
      { type: 'SANDBOX', description: 'test code', target: 'console.log(1)' },
      'context', () => {},
    );
    assert(result.output !== undefined, 'should have output');
  });

  test('SEARCH step uses KG', async () => {
    const steps = createSteps();
    const result = await steps._executeStep(
      { type: 'SEARCH', description: 'find error handling patterns' },
      'context', () => {},
    );
    assert(result.output !== undefined, 'should have output');
  });

  test('ASK step emits approval request', async () => {
    const steps = createSteps();
    const progress = [];
    // ASK step waits for approval - we need to auto-approve
    const stepPromise = steps._executeStep(
      { type: 'ASK', description: 'Should I proceed?' },
      'context', (p) => {
        progress.push(p);
        // Auto-approve when asked
        if (p.phase === 'approval' && steps.loop._pendingApproval) {
          steps.loop._pendingApproval.resolve(true);
          steps.loop._pendingApproval = null;
        }
      },
    );
    const result = await stepPromise;
    assert(result !== undefined, 'should return result');
  });

  test('unknown step type returns gracefully', async () => {
    const steps = createSteps();
    const result = await steps._executeStep(
      { type: 'UNKNOWN_TYPE', description: 'mystery' },
      'context', () => {},
    );
    assert(result.output.includes('Unknown'), 'should indicate unknown type');
  });

  test('step with symbolic DIRECT resolution bypasses LLM', async () => {
    const steps = createSteps({
      _symbolicResolver: {
        resolve: () => ({
          level: 'direct',
          lesson: { id: 'l1', insight: 'use npm install', strategy: {} },
        }),
        recordOutcome: () => {},
      },
    });
    const result = await steps._executeStep(
      { type: 'ANALYZE', description: 'fix deps' },
      'context', () => {},
    );
    assert(result.symbolic === 'direct', 'should be symbolic direct');
    assert(result.output.includes('SYMBOLIC'), 'should contain SYMBOLIC marker');
  });

  test('step with symbolic GUIDED resolution enriches context', async () => {
    const steps = createSteps({
      _symbolicResolver: {
        resolve: () => ({
          level: 'guided',
          directive: 'DIRECTIVE: Try npm install first',
        }),
        recordOutcome: () => {},
      },
    });
    const result = await steps._executeStep(
      { type: 'ANALYZE', description: 'fix issue' },
      'original context', () => {},
    );
    assert(result.output !== undefined, 'should have output');
    // GUIDED enriches context but still calls LLM
  });

  test('error in step is caught gracefully', async () => {
    const steps = createSteps({
      model: { chat: async () => { throw new Error('LLM down'); } },
    });
    const result = await steps._executeStep(
      { type: 'ANALYZE', description: 'analyze' },
      'context', () => {},
    );
    assert(result.error !== null, 'should capture error');
    assert(result.error.includes('LLM down'), 'should contain error message');
  });
});

// ── McpTransport ────────────────────────────────────────────

describe('McpTransport — URL validation', () => {
  const mod = require('../../src/agent/capabilities/McpTransport');
  const McpServerConnection = mod.McpServerConnection || mod.default || Object.values(mod)[0];

  function createConn(url = 'https://mcp.example.com/sse') {
    return new McpServerConnection({ name: 'test', url, transport: 'sse' }, mockBus());
  }

  test('constructor initializes state', () => {
    const conn = createConn();
    assertEqual(conn.status, 'disconnected');
    assertEqual(conn.tools.length, 0);
    assertEqual(conn.name, 'test');
  });

  test('_validateMcpUrl allows valid HTTPS URL', () => {
    const conn = createConn();
    conn._validateMcpUrl('https://mcp.example.com/sse');
    assert(true, 'should not throw');
  });

  test('_validateMcpUrl allows valid HTTP URL', () => {
    const conn = createConn();
    conn._validateMcpUrl('http://mcp.example.com:8080/api');
    assert(true, 'should not throw');
  });

  test('_validateMcpUrl blocks invalid URL', () => {
    const conn = createConn();
    let threw = false;
    try { conn._validateMcpUrl('not-a-url'); } catch (e) { threw = true; assert(e.message.includes('SSRF'), 'should be SSRF error'); }
    assert(threw, 'should throw for invalid URL');
  });

  test('_validateMcpUrl blocks non-HTTP protocol', () => {
    const conn = createConn();
    let threw = false;
    try { conn._validateMcpUrl('ftp://example.com'); } catch { threw = true; }
    assert(threw, 'should throw for FTP');
  });

  test('_validateMcpUrl blocks localhost', () => {
    const conn = createConn();
    let threw = false;
    try { conn._validateMcpUrl('http://localhost:3000'); } catch { threw = true; }
    assert(threw, 'should block localhost');
  });

  test('_validateMcpUrl blocks 127.0.0.1', () => {
    const conn = createConn();
    let threw = false;
    try { conn._validateMcpUrl('http://127.0.0.1:8080'); } catch { threw = true; }
    assert(threw, 'should block loopback');
  });

  test('_validateMcpUrl blocks private 10.x', () => {
    const conn = createConn();
    let threw = false;
    try { conn._validateMcpUrl('http://10.0.0.5:3000'); } catch { threw = true; }
    assert(threw, 'should block private IP');
  });

  test('_validateMcpUrl blocks private 192.168.x', () => {
    const conn = createConn();
    let threw = false;
    try { conn._validateMcpUrl('http://192.168.1.1'); } catch { threw = true; }
    assert(threw, 'should block private IP');
  });

  test('_validateMcpUrl blocks numeric IP obfuscation', () => {
    const conn = createConn();
    let threw = false;
    try { conn._validateMcpUrl('http://2130706433'); } catch { threw = true; }
    assert(threw, 'should block numeric IP');
  });
});

describe('McpTransport — health tracking', () => {
  const mod = require('../../src/agent/capabilities/McpTransport');
  const McpServerConnection = mod.McpServerConnection || mod.default || Object.values(mod)[0];

  function createConn() {
    return new McpServerConnection({ name: 'test', url: 'https://example.com/mcp', transport: 'sse' }, mockBus());
  }

  test('_recordLatency tracks latencies', () => {
    const conn = createConn();
    conn._recordLatency(100);
    conn._recordLatency(200);
    conn._recordLatency(50);
    assertEqual(conn._healthStats.latencies.length, 3);
    assertEqual(conn._healthStats.lastLatency, 50);
  });

  test('_recordLatency caps at 20 entries', () => {
    const conn = createConn();
    for (let i = 0; i < 25; i++) conn._recordLatency(i * 10);
    assertEqual(conn._healthStats.latencies.length, 20);
  });

  test('getLatencyPercentiles with no data', () => {
    const conn = createConn();
    const p = conn.getLatencyPercentiles();
    assertEqual(p.p50, 0);
    assertEqual(p.p95, 0);
    assertEqual(p.p99, 0);
  });

  test('getLatencyPercentiles with data', () => {
    const conn = createConn();
    for (let i = 1; i <= 20; i++) conn._recordLatency(i * 10);
    const p = conn.getLatencyPercentiles();
    assert(p.p50 > 0, 'p50 should be > 0');
    assert(p.p95 >= p.p50, 'p95 >= p50');
    assert(p.p99 >= p.p95, 'p99 >= p95');
  });

  test('enqueue adds to queue', () => {
    const conn = createConn();
    const promise = conn.enqueue('tools/list', {});
    assert(conn._requestQueue.length === 1, 'should have 1 queued');
    assert(promise instanceof Promise, 'should return promise');
    // Clean up - reject the promise to avoid unhandled rejection
    conn.disconnect();
  });

  test('enqueue throws when queue full', () => {
    const conn = createConn();
    conn._maxQueueDepth = 2;
    conn.enqueue('a', {});
    conn.enqueue('b', {});
    let threw = false;
    try { conn.enqueue('c', {}); } catch { threw = true; }
    assert(threw, 'should throw when full');
    conn.disconnect();
  });

  test('disconnect cleans up everything', () => {
    const conn = createConn();
    conn._recordLatency(100);
    conn.enqueue('test', {}).catch(() => {}); // will be rejected by disconnect
    conn.disconnect();
    assertEqual(conn.status, 'disconnected');
    assertEqual(conn.tools.length, 0);
    assertEqual(conn._requestQueue.length, 0);
    assertEqual(conn._pendingRequests.size, 0);
  });

  test('getStatus returns full status object', () => {
    const conn = createConn();
    conn._recordLatency(150);
    const status = conn.getStatus();
    assertEqual(status.name, 'test');
    assertEqual(status.status, 'disconnected');
    assert(status.health !== undefined, 'should have health');
    assert(status.health.percentiles !== undefined, 'should have percentiles');
    assert(status.circuitBreaker !== undefined, 'should have circuit breaker');
  });

  test('_maybeReconnect respects max reconnects', () => {
    const conn = createConn();
    conn._reconnectAttempts = conn._maxReconnects;
    conn._maybeReconnect(); // should be a no-op
    assertEqual(conn._reconnectAttempts, conn._maxReconnects);
  });
});

run();
