// ============================================================
// TEST — SelfModificationPipeline Deep Logic (v7.0.5)
// Covers: _getCircuitBreakerThreshold, _checkPreservation,
//         getGateStats, _retry, _extractPatches, _modifyFullFile flow
// ============================================================

const { describe, test, assert, assertEqual, run } = require('../harness');
const { SelfModificationPipeline } = require('../../src/agent/hexagonal/SelfModificationPipeline');

function mockBus() {
  const emitted = [];
  return {
    on: () => () => {},
    emit(event, data) { emitted.push({ event, data }); },
    fire(event, data) { emitted.push({ event, data }); },
    emitted,
  };
}

function mockLang() {
  return { t: (k) => k, detect: () => {}, current: 'en', get: () => 'en' };
}

function createPipeline(overrides = {}) {
  const bus = mockBus();
  return new SelfModificationPipeline({
    lang: mockLang(),
    bus,
    selfModel: overrides.selfModel || { readModule: () => null, getFullModel: () => ({ identity: 'Genesis', version: '7.0.5', capabilities: [], modules: {}, files: {} }), getModuleSummary: () => [], commitSnapshot: async () => {}, scan: async () => {} },
    model: overrides.model || { activeModel: 'test', chat: async () => 'mock' },
    prompts: {},
    sandbox: overrides.sandbox || { testPatch: async () => ({ success: true }) },
    reflector: overrides.reflector || { diagnose: async () => ({ issues: [] }) },
    skills: overrides.skills || { listSkills: () => [], createSkill: async (msg) => `✅ Created "${msg}"` },
    cloner: overrides.cloner || { createClone: async () => 'clone result' },
    reasoning: overrides.reasoning || { solve: async () => ({ answer: 'no patches' }) },
    hotReloader: overrides.hotReloader || { reload: async () => {} },
    guard: overrides.guard || { verifyIntegrity: () => ({ ok: true }), validateWrite: () => {} },
    tools: overrides.tools || { listTools: () => [], hasTool: () => false, register: () => {} },
    eventStore: overrides.eventStore || { append: () => ({}) },
    rootDir: '/tmp/genesis-test',
    astDiff: overrides.astDiff || null,
    ...overrides,
  });
}

// ════════════════════════════════════════════════════════════
// _getCircuitBreakerThreshold — Genome-driven dynamic threshold
// ════════════════════════════════════════════════════════════

describe('SelfModPipeline — _getCircuitBreakerThreshold', () => {
  test('returns default 3 without genome', () => {
    const p = createPipeline();
    assertEqual(p._getCircuitBreakerThreshold(), 3);
  });

  test('high riskTolerance (0.8) → threshold 5', () => {
    const p = createPipeline();
    p._genome = { trait: (name) => name === 'riskTolerance' ? 0.8 : 0.5 };
    const threshold = p._getCircuitBreakerThreshold();
    assertEqual(threshold, 5);
  });

  test('low riskTolerance (0.2) → threshold 2', () => {
    const p = createPipeline();
    p._genome = { trait: () => 0.2 };
    const threshold = p._getCircuitBreakerThreshold();
    assertEqual(threshold, 2);
  });

  test('zero riskTolerance → minimum threshold 2', () => {
    const p = createPipeline();
    p._genome = { trait: () => 0.0 };
    assert(p._getCircuitBreakerThreshold() >= 2, 'Threshold must be at least 2');
  });

  test('max riskTolerance (1.0) → threshold 5', () => {
    const p = createPipeline();
    p._genome = { trait: () => 1.0 };
    assertEqual(p._getCircuitBreakerThreshold(), 5);
  });
});

// ════════════════════════════════════════════════════════════
// _checkPreservation — Self-preservation invariant gate
// ════════════════════════════════════════════════════════════

describe('SelfModPipeline — _checkPreservation', () => {
  test('passes when preservation not bound', () => {
    const p = createPipeline();
    p._preservation = null;
    const result = p._checkPreservation('file.js', 'old', 'new');
    assert(result.pass === true, 'Should pass when not bound');
  });

  test('passes when preservation reports safe', () => {
    const p = createPipeline();
    p._preservation = { check: () => ({ safe: true, violations: [] }) };
    const result = p._checkPreservation('file.js', 'old', 'new');
    assert(result.pass === true);
  });

  test('blocks when preservation reports violations', () => {
    const p = createPipeline();
    p._preservation = {
      check: () => ({
        safe: false,
        violations: [
          { invariant: 'safety-gate-removal', detail: 'Removed CodeSafetyScanner call' },
          { invariant: 'trust-bypass', detail: 'Removed trust level check' },
        ],
      }),
    };
    const result = p._checkPreservation('file.js', 'old', 'new');
    assert(result.pass === false, 'Should block on violations');
    assert(result.reason.includes('safety-gate-removal'), 'Reason should contain violation');
    assert(result.reason.includes('trust-bypass'), 'Reason should contain all violations');
  });

  test('blocks when preservation throws (fail-closed)', () => {
    const p = createPipeline();
    p._preservation = { check: () => { throw new Error('Parse error'); } };
    const result = p._checkPreservation('file.js', 'old', 'new');
    assert(result.pass === false, 'Should fail-closed on error');
    assert(result.reason.includes('Parse error'), 'Should include error message');
  });
});

// ════════════════════════════════════════════════════════════
// getGateStats — Aggregated self-modification gate statistics
// ════════════════════════════════════════════════════════════

describe('SelfModPipeline — getGateStats', () => {
  test('returns zeroes on fresh pipeline', () => {
    const p = createPipeline();
    const stats = p.getGateStats();
    assertEqual(stats.totalAttempts, 0);
    assertEqual(stats.passed, 0);
    assertEqual(stats.blockRate, 0);
    assertEqual(stats.consciousnessBlockRate, 0);
    assertEqual(stats.awarenessActive, false);
  });

  test('blockRate calculated correctly', () => {
    const p = createPipeline();
    p._gateStats.totalAttempts = 10;
    p._gateStats.passed = 7;
    p._gateStats.consciousnessBlocked = 2;
    const stats = p.getGateStats();
    assertEqual(stats.blockRate, 30); // (1 - 7/10) * 100 = 30%
    assertEqual(stats.consciousnessBlockRate, 20); // 2/10 * 100 = 20%
  });

  test('awarenessActive reflects real awareness', () => {
    const p = createPipeline();
    p._awareness = { getReport: () => ({ active: true }) };
    const stats = p.getGateStats();
    assertEqual(stats.awarenessActive, true);
  });

  test('awarenessActive false for NullAwareness', () => {
    const p = createPipeline();
    p._awareness = { getReport: () => ({ active: false }) };
    const stats = p.getGateStats();
    assertEqual(stats.awarenessActive, false);
  });
});

// ════════════════════════════════════════════════════════════
// _retry — Retry last failed operation with error context
// ════════════════════════════════════════════════════════════

describe('SelfModPipeline — _retry', () => {
  test('returns message when nothing to retry', async () => {
    const p = createPipeline();
    const result = await p._retry();
    assertEqual(result, 'Nothing to retry.');
  });

  test('retries with error context appended', async () => {
    let receivedMsg = null;
    const p = createPipeline({
      skills: {
        listSkills: () => [],
        createSkill: async (msg) => { receivedMsg = msg; return '⚠️ failed again'; },
      },
    });
    p._pendingRetry = 'create a calculator';
    p._pendingRetryError = 'SyntaxError: Unexpected token';
    p._retryCount = 0;

    await p._retry();
    assert(receivedMsg.includes('create a calculator'), 'Should include original message');
    assert(receivedMsg.includes('SyntaxError'), 'Should include error context');
    assertEqual(p._retryCount, 1);
  });

  test('stops after 3 retries', async () => {
    const p = createPipeline();
    p._pendingRetry = 'create something';
    p._retryCount = 3;

    const result = await p._retry();
    assert(result.includes('Max retries'), 'Should report max retries');
    assertEqual(p._pendingRetry, null, 'Should clear pending retry');
    assertEqual(p._retryCount, 0, 'Should reset count');
  });
});

// ════════════════════════════════════════════════════════════
// _extractPatches — Parse code patches from LLM response
// ════════════════════════════════════════════════════════════

describe('SelfModPipeline — _extractPatches', () => {
  test('extracts FILE: header pattern', () => {
    const p = createPipeline();
    const response = '// FILE: src/agent/test.js\n```javascript\nconsole.log("hello");\n```';
    const patches = p._extractPatches(response);
    assertEqual(patches.length, 1);
    assertEqual(patches[0].file, 'src/agent/test.js');
    assert(patches[0].code.includes('console.log'), 'Should extract code');
  });

  test('extracts --- header pattern', () => {
    const p = createPipeline();
    const response = '--- src/agent/core/Logger.js ---\n```js\nmodule.exports = {};\n```';
    const patches = p._extractPatches(response);
    assertEqual(patches.length, 1);
    assertEqual(patches[0].file, 'src/agent/core/Logger.js');
  });

  test('extracts multiple patches', () => {
    const p = createPipeline();
    const response = '// FILE: a.js\n```javascript\nconst a = 1;\n```\n\n// FILE: b.js\n```javascript\nconst b = 2;\n```';
    const patches = p._extractPatches(response);
    assertEqual(patches.length, 2);
    assertEqual(patches[0].file, 'a.js');
    assertEqual(patches[1].file, 'b.js');
  });

  test('returns empty for no patches', () => {
    const p = createPipeline();
    const patches = p._extractPatches('Just a normal response with no code blocks.');
    assertEqual(patches.length, 0);
  });
});

if (require.main === module) run();
