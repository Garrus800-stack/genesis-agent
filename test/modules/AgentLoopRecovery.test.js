#!/usr/bin/env node
// Test: AgentLoopRecoveryDelegate (v7.6.0)
// Covers: classifyAndRecover, attemptRepair, verifyGoal, reflectOnProgress, extractTags
const { describe, test, assert, assertEqual, run } = require('../harness');
const { AgentLoopRecoveryDelegate } = require('../../src/agent/revolution/AgentLoopRecovery');

// ── Fixtures ─────────────────────────────────────────────────

function mockLoop(overrides = {}) {
  return {
    currentGoalId: 'goal-test-1',
    consecutiveErrors: 1,
    episodicMemory: null,
    model: {
      activeModel: 'test-model',
      chat: async () => 'SUCCESS: goal was achieved',
      chatStructured: async () => ({ adjust: false }),
    },
    bus: { _container: null },
    steps: {
      _executeStep: async () => ({ output: 'ok', error: null }),
    },
    ...overrides,
  };
}

function mockPlan(overrides = {}) {
  return {
    title: 'Build REST API',
    successCriteria: 'All endpoints return 200',
    steps: [{ type: 'code', description: 'Create route' }],
    ...overrides,
  };
}

// ── extractTags ──────────────────────────────────────────────

describe('AgentLoopRecovery.extractTags', () => {

  test('returns empty array for empty string', () => {
    const r = new AgentLoopRecoveryDelegate(mockLoop());
    assertEqual(r.extractTags('').length, 0);
  });

  test('returns empty array for null', () => {
    const r = new AgentLoopRecoveryDelegate(mockLoop());
    assertEqual(r.extractTags(null).length, 0);
  });

  test('returns empty array for undefined', () => {
    const r = new AgentLoopRecoveryDelegate(mockLoop());
    assertEqual(r.extractTags(undefined).length, 0);
  });

  test('detects testing tag', () => {
    const r = new AgentLoopRecoveryDelegate(mockLoop());
    assert(r.extractTags('write jest tests for the module').includes('testing'));
    assert(r.extractTags('add spec coverage').includes('testing'));
    assert(r.extractTags('use mocha runner').includes('testing'));
  });

  test('detects refactoring tag', () => {
    const r = new AgentLoopRecoveryDelegate(mockLoop());
    assert(r.extractTags('refactor the authentication module').includes('refactoring'));
    assert(r.extractTags('clean up the codebase').includes('refactoring'));
    assert(r.extractTags('simplify the logic').includes('refactoring'));
  });

  test('detects bugfix tag', () => {
    const r = new AgentLoopRecoveryDelegate(mockLoop());
    assert(r.extractTags('fix the null pointer error').includes('bugfix'));
    assert(r.extractTags('repair the broken pipeline').includes('bugfix'));
    assert(r.extractTags('resolve error in startup').includes('bugfix'));
  });

  test('detects feature tag', () => {
    const r = new AgentLoopRecoveryDelegate(mockLoop());
    assert(r.extractTags('implement new endpoint').includes('feature'));
    assert(r.extractTags('add user authentication').includes('feature'));
  });

  test('detects security tag', () => {
    const r = new AgentLoopRecoveryDelegate(mockLoop());
    assert(r.extractTags('encrypt passwords with bcrypt').includes('security'));
    assert(r.extractTags('add auth middleware').includes('security'));
  });

  test('detects mcp tag', () => {
    const r = new AgentLoopRecoveryDelegate(mockLoop());
    assert(r.extractTags('update the MCP server transport').includes('mcp'));
    assert(r.extractTags('fix mcp client connection').includes('mcp'));
  });

  test('detects ui tag', () => {
    const r = new AgentLoopRecoveryDelegate(mockLoop());
    assert(r.extractTags('update the UI renderer component').includes('ui'));
    assert(r.extractTags('fix CSS layout bug').includes('ui'));
    assert(r.extractTags('render the dashboard').includes('ui'));
  });

  test('detects memory tag', () => {
    const r = new AgentLoopRecoveryDelegate(mockLoop());
    assert(r.extractTags('improve embedding search in memory').includes('memory'));
    assert(r.extractTags('update knowledge graph').includes('memory'));
  });

  test('detects api tag', () => {
    const r = new AgentLoopRecoveryDelegate(mockLoop());
    assert(r.extractTags('create REST API endpoint').includes('api'));
    assert(r.extractTags('expose new endpoint for users').includes('api'));
  });

  test('detects multiple tags in one string', () => {
    const r = new AgentLoopRecoveryDelegate(mockLoop());
    const tags = r.extractTags('fix the security bug in the API endpoint');
    assert(tags.includes('bugfix'));
    assert(tags.includes('security'));
    assert(tags.includes('api'));
  });

  test('is case-insensitive', () => {
    const r = new AgentLoopRecoveryDelegate(mockLoop());
    assert(r.extractTags('WRITE JEST TESTS').includes('testing'));
    assert(r.extractTags('Fix The Bug').includes('bugfix'));
    assert(r.extractTags('REFACTOR module').includes('refactoring'));
  });

  test('no duplicates when pattern matches multiple times', () => {
    const r = new AgentLoopRecoveryDelegate(mockLoop());
    const tags = r.extractTags('fix bug fix error repair issue');
    assertEqual(tags.filter(t => t === 'bugfix').length, 1);
  });

  test('returns only matched tags, not all tags', () => {
    const r = new AgentLoopRecoveryDelegate(mockLoop());
    const tags = r.extractTags('add a feature');
    assert(tags.includes('feature'));
    assert(!tags.includes('testing'));
    assert(!tags.includes('bugfix'));
  });
});

// ── classifyAndRecover ───────────────────────────────────────

describe('AgentLoopRecovery.classifyAndRecover', () => {

  test('returns action:none when no failureTaxonomy available', async () => {
    const r = new AgentLoopRecoveryDelegate(mockLoop());
    const result = await r.classifyAndRecover(
      { type: 'code', description: 'do something' },
      { error: 'file not found' },
      0,
      () => {},
    );
    assertEqual(result.action, 'none');
  });

  test('resolves failureTaxonomy from bus._container', async () => {
    let classified = false;
    const ft = {
      classify: () => { classified = true; return { category: 'resource', strategy: 'none' }; },
    };
    const loop = mockLoop({
      bus: { _container: { resolve: (n) => n === 'failureTaxonomy' ? ft : null } },
    });
    const r = new AgentLoopRecoveryDelegate(loop);
    await r.classifyAndRecover({ type: 'code' }, { error: 'ENOENT' }, 0, () => {});
    assert(classified, 'should call ft.classify');
  });

  test('resolves failureTaxonomy from loop._failureTaxonomy fallback', async () => {
    let classified = false;
    const ft = {
      classify: () => { classified = true; return { category: 'network', strategy: 'none' }; },
    };
    const loop = mockLoop({ _failureTaxonomy: ft });
    const r = new AgentLoopRecoveryDelegate(loop);
    await r.classifyAndRecover({ type: 'shell' }, { error: 'timeout' }, 1, () => {});
    assert(classified);
  });

  test('emits failure-classified progress event', async () => {
    const ft = {
      classify: () => ({ category: 'timeout', strategy: 'retry_backoff', retryConfig: null }),
    };
    const loop = mockLoop({
      bus: { _container: { resolve: (n) => n === 'failureTaxonomy' ? ft : null } },
    });
    const r = new AgentLoopRecoveryDelegate(loop);
    const phases = [];
    await r.classifyAndRecover({ type: 'shell' }, { error: 'timeout' }, 0,
      (p) => phases.push(p.phase));
    assert(phases.includes('failure-classified'));
  });

  test('returns action:retry for retry_backoff with shouldRetry:true', async () => {
    const ft = {
      classify: () => ({
        category: 'timeout',
        strategy: 'retry_backoff',
        retryConfig: { shouldRetry: true, backoffMs: 1 },
      }),
    };
    const loop = mockLoop({
      bus: { _container: { resolve: (n) => n === 'failureTaxonomy' ? ft : null } },
    });
    const r = new AgentLoopRecoveryDelegate(loop);
    const result = await r.classifyAndRecover({ type: 'shell' }, { error: 'timeout' }, 0, () => {});
    assertEqual(result.action, 'retry');
    assertEqual(result.category, 'timeout');
  });

  test('emits retry-backoff progress event', async () => {
    const ft = {
      classify: () => ({
        category: 'network',
        strategy: 'retry_backoff',
        retryConfig: { shouldRetry: true, backoffMs: 1 },
      }),
    };
    const loop = mockLoop({
      bus: { _container: { resolve: (n) => n === 'failureTaxonomy' ? ft : null } },
    });
    const r = new AgentLoopRecoveryDelegate(loop);
    const phases = [];
    await r.classifyAndRecover({ type: 'shell' }, { error: 'net' }, 0,
      (p) => phases.push(p.phase));
    assert(phases.includes('retry-backoff'));
  });

  test('does NOT retry when shouldRetry is false', async () => {
    const ft = {
      classify: () => ({
        category: 'auth',
        strategy: 'retry_backoff',
        retryConfig: { shouldRetry: false, backoffMs: 1 },
      }),
    };
    const loop = mockLoop({
      bus: { _container: { resolve: (n) => n === 'failureTaxonomy' ? ft : null } },
    });
    const r = new AgentLoopRecoveryDelegate(loop);
    const result = await r.classifyAndRecover({ type: 'shell' }, { error: 'forbidden' }, 0, () => {});
    assertEqual(result.action, 'none');
  });

  test('triggers worldState refresh for update_world_replan strategy', async () => {
    let refreshed = false;
    const ft = {
      classify: () => ({ category: 'stale', strategy: 'update_world_replan', worldStateUpdates: true }),
    };
    const ws = { refresh: async () => { refreshed = true; } };
    const loop = mockLoop({
      bus: {
        _container: {
          resolve: (n) => n === 'failureTaxonomy' ? ft : n === 'worldState' ? ws : null,
        },
      },
    });
    const r = new AgentLoopRecoveryDelegate(loop);
    await r.classifyAndRecover({ type: 'code' }, { error: 'stale data' }, 0, () => {});
    assert(refreshed, 'worldState.refresh should be called');
  });

  test('does not refresh worldState when worldStateUpdates is falsy', async () => {
    let refreshed = false;
    const ft = {
      classify: () => ({ category: 'stale', strategy: 'update_world_replan', worldStateUpdates: false }),
    };
    const ws = { refresh: async () => { refreshed = true; } };
    const loop = mockLoop({
      bus: {
        _container: {
          resolve: (n) => n === 'failureTaxonomy' ? ft : n === 'worldState' ? ws : null,
        },
      },
    });
    const r = new AgentLoopRecoveryDelegate(loop);
    await r.classifyAndRecover({ type: 'code' }, { error: 'x' }, 0, () => {});
    assert(!refreshed);
  });

  test('triggers model escalation for escalate_model strategy', async () => {
    let escalated = false;
    const ft = {
      classify: () => ({ category: 'complexity', strategy: 'escalate_model', escalation: { to: 'opus' } }),
    };
    const mr = { escalate: () => { escalated = true; } };
    const loop = mockLoop({
      bus: {
        _container: {
          resolve: (n) => n === 'failureTaxonomy' ? ft : n === 'modelRouter' ? mr : null,
        },
      },
    });
    const r = new AgentLoopRecoveryDelegate(loop);
    await r.classifyAndRecover({ type: 'code' }, { error: 'too complex' }, 0, () => {});
    assert(escalated);
  });

  test('does not escalate when escalation field is falsy', async () => {
    let escalated = false;
    const ft = {
      classify: () => ({ category: 'complexity', strategy: 'escalate_model', escalation: null }),
    };
    const mr = { escalate: () => { escalated = true; } };
    const loop = mockLoop({
      bus: {
        _container: {
          resolve: (n) => n === 'failureTaxonomy' ? ft : n === 'modelRouter' ? mr : null,
        },
      },
    });
    const r = new AgentLoopRecoveryDelegate(loop);
    await r.classifyAndRecover({ type: 'code' }, { error: 'x' }, 0, () => {});
    assert(!escalated);
  });

  test('survives container.resolve throwing', async () => {
    const loop = mockLoop({
      bus: { _container: { resolve: () => { throw new Error('DI error'); } } },
    });
    const r = new AgentLoopRecoveryDelegate(loop);
    const result = await r.classifyAndRecover({ type: 'code' }, { error: 'x' }, 0, () => {});
    assertEqual(result.action, 'none');
  });

  test('survives null bus._container', async () => {
    const loop = mockLoop({ bus: { _container: null } });
    const r = new AgentLoopRecoveryDelegate(loop);
    const result = await r.classifyAndRecover({ type: 'code' }, { error: 'x' }, 0, () => {});
    assertEqual(result.action, 'none');
  });

  test('passes correct context to classify', async () => {
    let ctx = null;
    const ft = {
      classify: (error, c) => { ctx = c; return { category: 'x', strategy: 'none' }; },
    };
    const loop = mockLoop({
      bus: { _container: { resolve: (n) => n === 'failureTaxonomy' ? ft : null } },
      currentGoalId: 'my-goal',
      consecutiveErrors: 3,
      model: { activeModel: 'sonnet' },
    });
    const r = new AgentLoopRecoveryDelegate(loop);
    await r.classifyAndRecover({ type: 'deploy' }, { error: 'boom' }, 5, () => {});
    assertEqual(ctx.actionType, 'deploy');
    assertEqual(ctx.stepIndex, 5);
    assertEqual(ctx.goalId, 'my-goal');
    assertEqual(ctx.attempt, 2); // consecutiveErrors - 1
  });
});

// ── attemptRepair ────────────────────────────────────────────

describe('AgentLoopRecovery.attemptRepair', () => {

  test('emits repairing progress event', async () => {
    const loop = mockLoop({
      model: { chat: async () => 'Try Y instead.' },
      steps: { _executeStep: async () => ({ output: 'fixed', error: null }) },
    });
    const r = new AgentLoopRecoveryDelegate(loop);
    const phases = [];
    await r.attemptRepair(
      { type: 'code', description: 'write function' },
      { error: 'SyntaxError', output: '' },
      [],
      (p) => phases.push(p.phase),
    );
    assert(phases.includes('repairing'));
  });

  test('returns recovered:false when model says UNFIXABLE', async () => {
    const loop = mockLoop({
      model: { chat: async () => 'UNFIXABLE: missing system dependency' },
      steps: { _executeStep: async () => ({ output: 'ok', error: null }) },
    });
    const r = new AgentLoopRecoveryDelegate(loop);
    const result = await r.attemptRepair(
      { type: 'shell', description: 'install pkg' },
      { error: 'command not found', output: '' },
      [],
      () => {},
    );
    assertEqual(result.recovered, false);
    assert(result.output.includes('UNFIXABLE'));
  });

  test('returns recovered:true when retry step succeeds', async () => {
    const loop = mockLoop({
      model: { chat: async () => 'Use require() instead of import' },
      steps: { _executeStep: async () => ({ output: 'success output', error: null }) },
    });
    const r = new AgentLoopRecoveryDelegate(loop);
    const result = await r.attemptRepair(
      { type: 'code', description: 'add module' },
      { error: 'Cannot use import', output: '' },
      [],
      () => {},
    );
    assertEqual(result.recovered, true);
    assertEqual(result.output, 'success output');
    assertEqual(result.error, null);
  });

  test('returns recovered:false when retry step also fails', async () => {
    const loop = mockLoop({
      model: { chat: async () => 'Try changing the approach' },
      steps: { _executeStep: async () => ({ output: '', error: 'still broken' }) },
    });
    const r = new AgentLoopRecoveryDelegate(loop);
    const result = await r.attemptRepair(
      { type: 'code', description: 'failing step' },
      { error: 'original error', output: '' },
      [],
      () => {},
    );
    assertEqual(result.recovered, false);
    assertEqual(result.error, 'still broken');
  });

  test('passes REPAIR ATTEMPT context into retried step', async () => {
    let capturedContext = null;
    const loop = mockLoop({
      model: { chat: async () => 'Use a different approach' },
      steps: {
        _executeStep: async (step, context) => {
          capturedContext = context;
          return { output: 'ok', error: null };
        },
      },
    });
    const r = new AgentLoopRecoveryDelegate(loop);
    await r.attemptRepair(
      { type: 'code', description: 'write fn' },
      { error: 'TypeError', output: 'bad output' },
      [],
      () => {},
    );
    assert(capturedContext && capturedContext.includes('REPAIR ATTEMPT'));
    assert(capturedContext.includes('TypeError'));
  });

  test('truncates long output in repair context', async () => {
    let promptSeen = '';
    const longOutput = 'x'.repeat(1000);
    const loop = mockLoop({
      model: {
        chat: async (prompt) => { promptSeen = prompt; return 'UNFIXABLE: too long'; },
      },
      steps: { _executeStep: async () => ({ output: 'ok', error: null }) },
    });
    const r = new AgentLoopRecoveryDelegate(loop);
    await r.attemptRepair(
      { type: 'code', description: 'step' },
      { error: 'err', output: longOutput },
      [],
      () => {},
    );
    // Output in prompt is sliced to 500
    assert(promptSeen.includes('x'.repeat(10)), 'prompt should contain some output');
    assert(!promptSeen.includes(longOutput), 'prompt should not contain full long output');
  });

  test('step retains type from original failed step', async () => {
    let retryCalled = false;
    let retryStep = null;
    const loop = mockLoop({
      model: { chat: async () => 'fix it' },
      steps: {
        _executeStep: async (step) => {
          retryCalled = true;
          retryStep = step;
          return { output: 'ok', error: null };
        },
      },
    });
    const r = new AgentLoopRecoveryDelegate(loop);
    await r.attemptRepair(
      { type: 'deploy', description: 'deploy step' },
      { error: 'failed', output: '' },
      [],
      () => {},
    );
    assert(retryCalled);
    assertEqual(retryStep.type, 'deploy');
  });
});

// ── verifyGoal ───────────────────────────────────────────────

describe('AgentLoopRecovery.verifyGoal', () => {

  test('programmatic: succeeds when all pass and success rate >= 0.7', async () => {
    const r = new AgentLoopRecoveryDelegate(mockLoop());
    const results = [
      { verification: { status: 'pass' } },
      { verification: { status: 'pass' } },
      { verification: { status: 'pass' } },
    ];
    const outcome = await r.verifyGoal(mockPlan(), results);
    assertEqual(outcome.success, true);
    assertEqual(outcome.verificationMethod, 'programmatic');
    assert(outcome.summary.includes('Build REST API'));
  });

  test('programmatic: includes ambiguous count in summary', async () => {
    const r = new AgentLoopRecoveryDelegate(mockLoop());
    const results = [
      { verification: { status: 'pass' } },
      { verification: { status: 'ambiguous' } },
      { verification: { status: 'pass' } },
    ];
    const outcome = await r.verifyGoal(mockPlan(), results);
    assertEqual(outcome.success, true);
    assertEqual(outcome.verificationMethod, 'programmatic');
    assert(outcome.summary.includes('ambiguous'));
  });

  test('falls through to LLM when any programmatic fail', async () => {
    const loop = mockLoop({
      model: { chat: async () => 'FAILED: one step failed programmatic check' },
    });
    const r = new AgentLoopRecoveryDelegate(loop);
    const results = [
      { verification: { status: 'pass' } },
      { verification: { status: 'fail' } },
    ];
    const outcome = await r.verifyGoal(mockPlan(), results);
    assertEqual(outcome.verificationMethod, 'llm-fallback');
    assertEqual(outcome.success, false);
  });

  test('heuristic: succeeds with 100% success and no verifications', async () => {
    const r = new AgentLoopRecoveryDelegate(mockLoop());
    const results = Array(5).fill({ output: 'ok' });
    const outcome = await r.verifyGoal(mockPlan(), results);
    assertEqual(outcome.success, true);
    assertEqual(outcome.verificationMethod, 'heuristic');
    assert(outcome.summary.includes('100%'));
  });

  test('heuristic: falls through to LLM when success rate < 0.8', async () => {
    const loop = mockLoop({
      model: { chat: async () => 'FAILED: too many errors' },
    });
    const r = new AgentLoopRecoveryDelegate(loop);
    const results = [{ output: 'ok' }, { error: 'boom' }, { error: 'crash' }, { output: 'ok' }];
    const outcome = await r.verifyGoal(mockPlan(), results);
    assertEqual(outcome.verificationMethod, 'llm-fallback');
    assertEqual(outcome.success, false);
  });

  test('llm-fallback: SUCCESS response returns success:true', async () => {
    const loop = mockLoop({
      model: { chat: async () => 'SUCCESS: all endpoints are working correctly' },
    });
    const r = new AgentLoopRecoveryDelegate(loop);
    const results = [{ error: 'minor issue' }, { output: 'ok' }];
    const outcome = await r.verifyGoal(mockPlan(), results);
    assertEqual(outcome.success, true);
    assertEqual(outcome.verificationMethod, 'llm-fallback');
  });

  test('llm-fallback: PARTIAL response returns success:false', async () => {
    const loop = mockLoop({
      model: { chat: async () => 'PARTIAL: only two of three endpoints work' },
    });
    const r = new AgentLoopRecoveryDelegate(loop);
    const results = [{ error: 'route 3 failed' }, { output: 'ok' }];
    const outcome = await r.verifyGoal(mockPlan(), results);
    assertEqual(outcome.success, false);
    assertEqual(outcome.verificationMethod, 'llm-fallback');
  });

  test('llm-fallback: FAILED response returns success:false', async () => {
    const loop = mockLoop({
      model: { chat: async () => 'FAILED: the API is completely broken' },
    });
    const r = new AgentLoopRecoveryDelegate(loop);
    const results = [{ error: 'crash' }, { error: 'crash' }];
    const outcome = await r.verifyGoal(mockPlan(), results);
    assertEqual(outcome.success, false);
  });

  test('llm-fallback: summary truncated to 300 chars', async () => {
    const loop = mockLoop({
      model: { chat: async () => 'SUCCESS: ' + 'x'.repeat(500) },
    });
    const r = new AgentLoopRecoveryDelegate(loop);
    const outcome = await r.verifyGoal(mockPlan(), [{ error: 'x' }, { output: 'ok' }]);
    // v7.4.5.fix #28d: summary may include step outputs appended.
    // The LLM evaluation portion itself is truncated to 300 chars;
    // step outputs are a separate block. Verify the LLM portion
    // (the prefix before any "**Step" block) is capped at 300.
    const llmPart = outcome.summary.split('\n\n**Step ')[0];
    assert(llmPart.length <= 300, `LLM portion should be ≤300 chars, got ${llmPart.length}`);
  });

  test('records episode in episodicMemory on LLM success', async () => {
    let recorded = null;
    const loop = mockLoop({
      model: { chat: async () => 'SUCCESS: done' },
      episodicMemory: { recordEpisode: (ep) => { recorded = ep; } },
    });
    const r = new AgentLoopRecoveryDelegate(loop);
    await r.verifyGoal(mockPlan({ title: 'Build REST API' }), [{ error: 'minor' }, { output: 'ok' }]);
    assert(recorded !== null);
    assertEqual(recorded.outcome, 'success');
    assert(recorded.topic.includes('Build REST API'));
  });

  test('records failure episode for FAILED response', async () => {
    let recorded = null;
    const loop = mockLoop({
      model: { chat: async () => 'FAILED: broken' },
      episodicMemory: { recordEpisode: (ep) => { recorded = ep; } },
    });
    const r = new AgentLoopRecoveryDelegate(loop);
    await r.verifyGoal(mockPlan(), [{ error: 'crash' }, { error: 'crash' }]);
    assert(recorded !== null);
    assertEqual(recorded.outcome, 'failed');
  });

  test('does not throw when episodicMemory.recordEpisode throws', async () => {
    const loop = mockLoop({
      model: { chat: async () => 'SUCCESS: done' },
      episodicMemory: { recordEpisode: () => { throw new Error('storage full'); } },
    });
    const r = new AgentLoopRecoveryDelegate(loop);
    const outcome = await r.verifyGoal(mockPlan(), [{ output: 'ok' }, { output: 'ok' }]);
    assertEqual(outcome.success, true);
  });

  test('deduplicates toolsUsed in episode', async () => {
    let recorded = null;
    const loop = mockLoop({
      model: { chat: async () => 'SUCCESS: done' },
      episodicMemory: { recordEpisode: (ep) => { recorded = ep; } },
    });
    const r = new AgentLoopRecoveryDelegate(loop);
    // Mix of errors + typed results — triggers llm-fallback so episode is recorded
    const results = [
      { output: 'ok', type: 'code' },
      { error: 'boom', type: 'shell' },
      { output: 'ok', type: 'code' },
      { error: 'fail', type: 'shell' },
    ];
    await r.verifyGoal(mockPlan(), results);
    assert(recorded !== null, 'episode should be recorded via llm-fallback path');
    assertEqual(recorded.toolsUsed.filter(t => t === 'code').length, 1);
    assertEqual(recorded.toolsUsed.filter(t => t === 'shell').length, 1);
  });

  test('includes programmatic verification context in LLM prompt', async () => {
    let promptSeen = '';
    const loop = mockLoop({
      model: { chat: async (prompt) => { promptSeen = prompt; return 'FAILED: unclear'; } },
    });
    const r = new AgentLoopRecoveryDelegate(loop);
    await r.verifyGoal(mockPlan(), [{ verification: { status: 'fail' } }, { error: 'step error' }]);
    assert(promptSeen.includes('Programmatic verification'));
  });

  test('programmatic: success rate shown in summary', async () => {
    const r = new AgentLoopRecoveryDelegate(mockLoop());
    const results = [
      { verification: { status: 'pass' } },
      { verification: { status: 'pass' } },
      { verification: { status: 'pass' } },
    ];
    const outcome = await r.verifyGoal(mockPlan(), results);
    assert(outcome.summary.includes('100%'));
  });
});

// ── reflectOnProgress ────────────────────────────────────────

describe('AgentLoopRecovery.reflectOnProgress', () => {

  test('returns null when no recent errors', async () => {
    const r = new AgentLoopRecoveryDelegate(mockLoop());
    const results = [{ output: 'ok' }, { output: 'ok' }, { output: 'ok' }];
    assertEqual(await r.reflectOnProgress(mockPlan(), results, 2), null);
  });

  test('returns null when LLM says no adjustment', async () => {
    const loop = mockLoop({
      model: { chatStructured: async () => ({ adjust: false }) },
    });
    const r = new AgentLoopRecoveryDelegate(loop);
    const results = [{ output: 'ok' }, { error: 'minor' }, { error: 'minor' }];
    assertEqual(await r.reflectOnProgress(mockPlan(), results, 2), null);
  });

  test('returns newSteps when LLM suggests adjustment', async () => {
    const loop = mockLoop({
      model: {
        chatStructured: async () => ({
          adjust: true,
          reason: 'Simpler approach needed',
          newSteps: [
            { type: 'code', description: 'Simplified step 1' },
            { type: 'shell', description: 'Simplified step 2' },
          ],
        }),
      },
    });
    const r = new AgentLoopRecoveryDelegate(loop);
    const results = [{ output: 'ok' }, { error: 'error 1' }, { error: 'error 2' }];
    const outcome = await r.reflectOnProgress(mockPlan(), results, 2);
    assert(outcome !== null);
    assertEqual(outcome.reason, 'Simpler approach needed');
    assertEqual(outcome.newSteps.length, 2);
  });

  test('returns null when chatStructured throws', async () => {
    const loop = mockLoop({
      model: { chatStructured: async () => { throw new Error('LLM unavailable'); } },
    });
    const r = new AgentLoopRecoveryDelegate(loop);
    const results = [{ error: 'x' }, { error: 'y' }, { error: 'z' }];
    assertEqual(await r.reflectOnProgress(mockPlan(), results, 2), null);
  });

  test('only checks last 3 results — old errors alone do not trigger', async () => {
    const loop = mockLoop({
      model: { chatStructured: async () => ({ adjust: false }) },
    });
    const r = new AgentLoopRecoveryDelegate(loop);
    // 4 old errors, then 3 clean successes
    const results = [
      { error: 'old' }, { error: 'old' }, { error: 'old' }, { error: 'old' },
      { output: 'ok' }, { output: 'ok' }, { output: 'ok' },
    ];
    assertEqual(await r.reflectOnProgress(mockPlan(), results, 6), null);
  });

  test('uses fallback successCriteria when plan has none', async () => {
    let promptSeen = '';
    const loop = mockLoop({
      model: {
        chatStructured: async (prompt) => { promptSeen = prompt; return { adjust: false }; },
      },
    });
    const r = new AgentLoopRecoveryDelegate(loop);
    const results = [{ error: 'err1' }, { error: 'err2' }, { error: 'err3' }];
    await r.reflectOnProgress(mockPlan({ successCriteria: undefined }), results, 2);
    assert(promptSeen.includes('Complete all steps'));
  });

  test('prompt includes current step position', async () => {
    let promptSeen = '';
    const loop = mockLoop({
      model: {
        chatStructured: async (prompt) => { promptSeen = prompt; return { adjust: false }; },
      },
    });
    const r = new AgentLoopRecoveryDelegate(loop);
    const plan = mockPlan({ steps: Array(8).fill({ type: 'code', description: 'step' }) });
    const results = [{ output: 'ok' }, { error: 'err' }, { error: 'err' }];
    await r.reflectOnProgress(plan, results, 4);
    // "5/8 steps"
    assert(promptSeen.includes('5/8'));
  });
});

run();
