#!/usr/bin/env node
// ============================================================
// Test: SelfModificationPipeline — Verification Gate (v4.13.1)
// Tests the _verifyCode gate and circuit breaker interaction.
// ============================================================

const { describe, test, assert, assertEqual, run } = require('../harness');
const { SelfModificationPipeline } = require('../../src/agent/hexagonal/SelfModificationPipeline');

// ── Minimal mock deps ─────────────────────────────────────

function makePipeline(overrides = {}) {
  return new SelfModificationPipeline({
    lang: { t: (k) => k, detect: () => {}, current: 'en' },
    bus: { emit: () => {} },
    selfModel: { readModule: () => '', commitSnapshot: async () => {}, scan: async () => {}, moduleCount: () => 0 },
    model: { chat: async () => '' },
    prompts: {},
    sandbox: { testPatch: async () => ({ success: true }) },
    reflector: {},
    skills: { listSkills: () => [] },
    cloner: {},
    reasoning: { solve: async () => ({ answer: '' }) },
    hotReloader: { reload: async () => {} },
    guard: { validateWrite: () => true },
    tools: {},
    eventStore: { append: () => {} },
    rootDir: '/tmp/test',
    astDiff: null,
    ...overrides,
  });
}

// ── Tests ─────────────────────────────────────────────────

describe('SelfModPipeline — Verification Gate', () => {
  test('_verifyCode blocks when no verifier bound (fail-closed, v4.13.2 P1)', () => {
    const pipe = makePipeline();
    const result = pipe._verifyCode('test.js', 'const x = 1;');
    assertEqual(result.pass, false);
    assert(result.reason.includes('not available'), 'should explain verifier missing');
  });

  test('_verifyCode passes when verifier returns pass', () => {
    const pipe = makePipeline();
    pipe.verifier = {
      verify: () => ({ status: 'pass', issues: [] }),
    };
    const result = pipe._verifyCode('test.js', 'const x = 1;');
    assertEqual(result.pass, true);
    assertEqual(result.degraded, undefined);
  });

  test('_verifyCode fails when verifier returns fail', () => {
    const pipe = makePipeline();
    pipe.verifier = {
      verify: () => ({
        status: 'fail',
        issues: [{ message: 'Undeclared variable' }, { message: 'Missing semicolon' }],
      }),
    };
    const result = pipe._verifyCode('test.js', 'x = 1');
    assertEqual(result.pass, false);
    assert(result.reason.includes('Undeclared variable'));
    assert(result.reason.includes('Missing semicolon'));
  });

  test('_verifyCode blocks when verifier throws (fail-closed, v4.13.2 P1)', () => {
    const pipe = makePipeline();
    pipe.verifier = {
      verify: () => { throw new Error('verifier crash'); },
    };
    const result = pipe._verifyCode('test.js', 'const x = 1;');
    assertEqual(result.pass, false);
    assert(result.reason.includes('verifier crash'), 'should include error message');
  });

  test('_verifyCode passes ambiguous results', () => {
    const pipe = makePipeline();
    pipe.verifier = {
      verify: () => ({ status: 'ambiguous', issues: [] }),
    };
    const result = pipe._verifyCode('test.js', 'const x = 1;');
    assertEqual(result.pass, true);
    assertEqual(result.status, 'ambiguous');
  });
});

describe('SelfModPipeline — Circuit Breaker', () => {
  test('initial state: not frozen', () => {
    const pipe = makePipeline();
    const status = pipe.getCircuitBreakerStatus();
    assertEqual(status.frozen, false);
    assertEqual(status.failures, 0);
  });

  test('_recordFailure increments counter', () => {
    const pipe = makePipeline();
    pipe._recordFailure('test fail 1');
    pipe._recordFailure('test fail 2');
    assertEqual(pipe._consecutiveFailures, 2);
    assertEqual(pipe._frozen, false);
  });

  test('circuit breaker trips after threshold', () => {
    const pipe = makePipeline();
    pipe._circuitBreakerThreshold = 2;
    pipe._recordFailure('fail 1');
    pipe._recordFailure('fail 2');
    assertEqual(pipe._frozen, true);
    assert(pipe._frozenReason !== null);
  });

  test('_recordSuccess resets failure counter', () => {
    const pipe = makePipeline();
    pipe._recordFailure('fail 1');
    pipe._recordFailure('fail 2');
    pipe._recordSuccess('test.js');
    assertEqual(pipe._consecutiveFailures, 0);
  });

  test('modify() refuses when frozen', async () => {
    const pipe = makePipeline();
    pipe._frozen = true;
    pipe._frozenReason = 'test freeze';
    pipe._consecutiveFailures = 3;
    const result = await pipe.modify('change something');
    assert(result.includes('frozen'), 'Should mention frozen');
  });
});

describe('SelfModPipeline — verifier slot', () => {
  test('verifier is null by default', () => {
    const pipe = makePipeline();
    assertEqual(pipe.verifier, null);
  });

  test('verifier can be set (simulating late-binding)', () => {
    const pipe = makePipeline();
    pipe.verifier = { verify: () => ({ status: 'pass' }) };
    assert(pipe.verifier !== null);
  });
});

run();
