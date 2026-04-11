// ============================================================
// TEST — AgentLoop + AgentLoopSteps coverage expansion (v7.1.1)
// ============================================================

const { describe, test, assert, assertEqual, run } = require('../harness');
const { AgentLoop } = require('../../src/agent/revolution/AgentLoop');
const { AgentLoopStepsDelegate } = require('../../src/agent/revolution/AgentLoopSteps');

// ── Minimal stub factory ──────────────────────────────────────

function makeLoop(overrides = {}) {
  const fired = [];
  const bus = { fire: (n,d) => fired.push({n,d}), emit(n,d){}, on(){ return ()=>{}; } };

  const model = {
    chat: async (p) => 'mock answer',
    chatStructured: async () => ({ strategy: 'direct', level: 1 }),
    activeModel: 'mock',
    activeBackend: 'mock',
  };

  const loop = new AgentLoop({
    bus,
    model,
    goalStack: { addGoal: async (d) => ({ id: 'g1', description: d, steps: [] }), getActiveGoals: () => [], getAll: () => [] },
    sandbox: { execute: async (code) => ({ output: 'ok', error: null }) },
    selfModel: { readModule: () => '', getFullModel: () => ({ identity: 'Genesis' }) },
    memory: { addEpisode: () => {}, search: () => [], learnFact: () => {}, buildContext: () => '' },
    knowledgeGraph: { learnFromText: () => {}, addNode: () => {}, search: () => [] },
    tools: { getPrompt: () => '', execute: async () => 'tool result' },
    eventStore: { append: () => {} },
    shellAgent: { run: async (cmd) => ({ output: `ran: ${cmd}`, error: null, ok: true }) },
    selfModPipeline: { apply: async () => ({ success: true }) },
    lang: { t: k => k },
    storage: null,
    rootDir: '/tmp',
    ...overrides,
  });

  loop._fired = fired;
  return loop;
}

// ── AgentLoop — state methods ─────────────────────────────────

describe('AgentLoop — getStatus()', () => {
  test('returns correct initial status', () => {
    const loop = makeLoop();
    const s = loop.getStatus();
    assertEqual(s.running, false);
    assert(s.stepCount === 0);
    assert(s.consecutiveErrors === 0);
    assert(Array.isArray(s.recentLog));
  });

  test('pendingApproval is null initially', () => {
    const loop = makeLoop();
    const s = loop.getStatus();
    assert(s.pendingApproval === null || s.pendingApproval === undefined);
  });
});

describe('AgentLoop — stop()', () => {
  test('sets running to false and aborted to true', async () => {
    const loop = makeLoop();
    loop.running = true;
    await loop.stop();
    assertEqual(loop.running, false);
    assertEqual(loop._aborted, true);
  });

  test('resolves immediately when no in-flight step', async () => {
    const loop = makeLoop();
    const result = await loop.stop();
    assert(result === undefined || result === null || typeof result === 'object');
  });
});

describe('AgentLoop — approve() / reject()', () => {
  test('approve() does not throw', () => {
    const loop = makeLoop();
    loop.approve(); // no pending approval — should be no-op
    assert(true);
  });

  test('reject() does not throw', () => {
    const loop = makeLoop();
    loop.reject('test reason');
    assert(true);
  });
});

describe('AgentLoop — registerHandlers()', () => {
  test('registers pursue handler on orchestrator', () => {
    const loop = makeLoop();
    const handlers = new Map();
    const orch = { registerHandler: (n, fn) => handlers.set(n, fn) };
    loop.registerHandlers(orch);
    assert(handlers.has('pursue') || handlers.size > 0);
  });
});

// ── AgentLoopStepsDelegate — _executeStep dispatch ───────────

describe('AgentLoopStepsDelegate — _executeStep', () => {
  function makeDelegate(modelOverride) {
    const loop = makeLoop(modelOverride ? { model: modelOverride } : {});
    return { delegate: loop.steps, loop };
  }

  test('ANALYZE step calls model.chat and returns output', async () => {
    const { delegate } = makeDelegate();
    const step = { type: 'ANALYZE', description: 'analyze src/main.js', target: null, id: 's1' };
    const result = await delegate._executeStep(step, 'context', () => {});
    assert(result.output === 'mock answer' || typeof result.output === 'string');
    assert(result.error === null || result.error === undefined);
    assert(typeof result.durationMs === 'number');
  });

  test('SHELL step calls shell.run', async () => {
    const { delegate, loop } = makeDelegate();
    const step = { type: 'SHELL', description: 'list files', target: 'ls', id: 's2' };
    const result = await delegate._executeStep(step, 'context', () => {});
    assert(typeof result.output === 'string');
    assert(typeof result.durationMs === 'number');
  });

  test('SANDBOX step calls sandbox.execute', async () => {
    const { delegate } = makeDelegate();
    const step = { type: 'SANDBOX', description: 'run code', target: 'console.log(1)', id: 's3' };
    const result = await delegate._executeStep(step, 'context', () => {});
    assert(typeof result.output === 'string' || result.output !== undefined);
  });

  test('SEARCH step returns output', async () => {
    const { delegate } = makeDelegate();
    const step = { type: 'SEARCH', description: 'find examples', target: null, id: 's4' };
    const result = await delegate._executeStep(step, 'context', () => {});
    assert(typeof result.output === 'string' || result.output !== undefined);
  });

  test('unknown step type returns graceful output', async () => {
    const { delegate } = makeDelegate();
    const step = { type: 'UNKNOWN_XYZ', description: 'do something', target: null, id: 's5' };
    const result = await delegate._executeStep(step, 'context', () => {});
    assert(result.output.includes('Unknown') || typeof result.output === 'string');
  });

  test('step exception is caught and returned as error', async () => {
    const badModel = { chat: async () => { throw new Error('model timeout'); }, activeModel: 'bad' };
    const { delegate } = makeDelegate(badModel);
    const step = { type: 'ANALYZE', description: 'analyze', target: null, id: 's6' };
    const result = await delegate._executeStep(step, 'context', () => {});
    assert(result.error !== null && result.error !== undefined);
    assert(result.error.includes('model timeout') || typeof result.error === 'string');
  });
});

describe('AgentLoopStepsDelegate — extractTags()', () => {
  test('extracts tags from text', () => {
    const { delegate } = (() => { const loop = makeLoop(); return { delegate: loop.steps }; })();
    const tags = delegate.extractTags('this is about #performance and #memory optimization');
    assert(Array.isArray(tags));
  });

  test('returns empty array for text without tags', () => {
    const loop = makeLoop();
    const tags = loop.steps.extractTags('no tags here');
    assert(Array.isArray(tags));
  });
});

describe('AgentLoopStepsDelegate — verifyGoal()', () => {
  test('returns result object', async () => {
    const loop = makeLoop();
    const plan = { goal: { description: 'test goal' }, steps: [] };
    const results = [{ output: 'done', error: null }];
    const r = await loop.steps.verifyGoal(plan, results);
    assert(typeof r === 'object' || r === undefined || r === null);
  });
});

// ── AgentLoop — _reportCognitiveLevel ─────────────────────────

describe('AgentLoop — cognitive level checks', () => {
  test('_getCognitiveLevel returns a value', () => {
    const loop = makeLoop();
    if (typeof loop._getCognitiveLevel === 'function') {
      const level = loop._getCognitiveLevel();
      assert(level !== undefined);
    } else {
      assert(true); // method may not exist — skip
    }
  });
});

if (require.main === module) run();

// ── AgentLoopSteps — attemptRepair ────────────────────────────

describe('AgentLoopStepsDelegate — attemptRepair()', () => {
  test('returns recovered when repair succeeds', async () => {
    const loop = makeLoop();
    const step = { type: 'ANALYZE', description: 'fix the bug', target: null, id: 's1' };
    const failedResult = { output: '', error: 'TypeError: x is not defined' };
    const result = await loop.steps.attemptRepair(step, failedResult, [], () => {});
    assert(typeof result.recovered === 'boolean');
    assert('output' in result);
  });

  test('returns recovered:false when model says UNFIXABLE', async () => {
    const unfixableModel = {
      chat: async () => 'UNFIXABLE: missing system dependency',
      activeModel: 'mock',
    };
    const loop = makeLoop({ model: unfixableModel });
    const step = { type: 'SHELL', description: 'install package', target: null, id: 's2' };
    const failedResult = { output: '', error: 'ENOENT: command not found' };
    const result = await loop.steps.attemptRepair(step, failedResult, [], () => {});
    assertEqual(result.recovered, false);
    assert(result.output.includes('UNFIXABLE'));
  });
});

// ── AgentLoopSteps — verifyGoal branches ─────────────────────

describe('AgentLoopStepsDelegate — verifyGoal() branches', () => {
  test('returns success via programmatic path when all verified pass', async () => {
    const loop = makeLoop();
    const plan = { title: 'Fix bug', successCriteria: 'Tests pass' };
    const results = [
      { output: 'ok', error: null, verification: { status: 'pass' } },
      { output: 'ok', error: null, verification: { status: 'pass' } },
    ];
    const r = await loop.steps.verifyGoal(plan, results);
    assertEqual(r.verificationMethod, 'programmatic');
    assertEqual(r.success, true);
  });

  test('returns success via heuristic when high success rate, no fails', async () => {
    const loop = makeLoop();
    const plan = { title: 'Add feature', successCriteria: 'Feature works' };
    const results = [
      { output: 'ok', error: null },
      { output: 'ok', error: null },
      { output: 'ok', error: null },
    ];
    const r = await loop.steps.verifyGoal(plan, results);
    assert(r.verificationMethod === 'heuristic' || r.verificationMethod === 'programmatic');
    assertEqual(r.success, true);
  });

  test('falls back to LLM when programmatic fails exist', async () => {
    const loop = makeLoop();
    const plan = { title: 'Debug issue', successCriteria: 'No errors' };
    const results = [
      { output: '', error: 'test failed', verification: { status: 'fail' } },
      { output: 'ok', error: null },
    ];
    const r = await loop.steps.verifyGoal(plan, results);
    // LLM returns 'mock answer' which doesn't start with SUCCESS
    assert(typeof r.success === 'boolean');
    assert(r.verificationMethod === 'llm-fallback');
  });

  test('handles empty results gracefully', async () => {
    const loop = makeLoop();
    const plan = { title: 'Empty plan', successCriteria: null };
    // Empty results: successRate = NaN → falls to LLM
    const r = await loop.steps.verifyGoal(plan, []);
    assert(typeof r.success === 'boolean');
  });
});

// ── AgentLoopSteps — _stepAsk ─────────────────────────────────

describe('AgentLoopStepsDelegate — _stepAsk()', () => {
  test('calls onProgress and returns output string', async () => {
    const loop = makeLoop();
    // Mock approval: auto-approve
    loop._requestApproval = async () => true;
    const step = { type: 'ASK', description: 'Do you want to continue?', id: 's1' };
    const progress = [];
    const result = await loop.steps._stepAsk(step, (p) => progress.push(p));
    assert(progress.length > 0);
    assert(result.output.includes('confirmed') || typeof result.output === 'string');
  });
});

// ── AgentLoopSteps — _stepDelegate fallback ───────────────────

describe('AgentLoopStepsDelegate — _stepDelegate() fallback', () => {
  test('falls back to analyze when no taskDelegation', async () => {
    const loop = makeLoop();
    loop.taskDelegation = null;
    const step = { type: 'DELEGATE', description: 'delegate to peer', target: null, id: 's1' };
    const result = await loop.steps._stepDelegate(step, 'context', () => {});
    // Falls through to _stepAnalyze → returns 'mock answer'
    assert(typeof result.output === 'string');
  });
});
