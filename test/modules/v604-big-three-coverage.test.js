// ============================================================
// Test: v6.0.4 — Big Three Branch Coverage
//
// Targeted tests for untested branches in the three most
// critical modules: SelfModificationPipeline, AgentLoop, Sandbox.
//
// Focus: error paths, edge cases, circuit breakers, race conditions.
// ============================================================

const { describe, test, assert, assertEqual, assertThrows, run, createTestRoot } = require('../harness');
const path = require('path');
const fs = require('fs');

// ── Shared mocks ─────────────────────────────────────────
function mockBus() {
  const _emitted = [];
  return {
    on(ev, fn, opts) { return () => {}; },
    emit(ev, data, meta) { _emitted.push({ event: ev, data, meta }); },
    fire(ev, data, meta) { _emitted.push({ event: ev, data, meta }); },
    _emitted,
  };
}

// ═══════════════════════════════════════════════════════════
// SelfModificationPipeline — Branch Coverage
// ═══════════════════════════════════════════════════════════

const { SelfModificationPipeline } = require('../../src/agent/hexagonal/SelfModificationPipeline');

describe('SelfModPipeline — Circuit Breaker Branches', () => {
  function makePipeline(opts = {}) {
    const bus = mockBus();
    return new SelfModificationPipeline({
      lang: { t: (k) => k, detect: () => {}, current: 'en' },
      bus,
      selfModel: { rootDir: '/tmp', readModule: () => null, commitSnapshot: async () => {}, scan: async () => {} },
      model: { chat: async () => '' },
      prompts: {},
      sandbox: { syntaxCheck: async () => ({ valid: true }), testPatch: async () => ({ success: true }), execute: async () => ({ output: '', error: null }) },
      reflector: {},
      skills: null,
      cloner: null,
      reasoning: null,
      hotReloader: { reload: async () => {} },
      guard: { validateWrite: () => true },
      tools: null,
      eventStore: { append: () => {} },
      rootDir: '/tmp',
      astDiff: null,
      ...opts,
    });
  }

  test('modify() returns frozen message when circuit breaker tripped', async () => {
    const p = makePipeline();
    p._frozen = true;
    p._frozenReason = 'test freeze';
    p._consecutiveFailures = 3;
    const result = await p.modify('add feature');
    assert(result.includes('frozen'), 'should mention frozen');
    assert(result.includes('test freeze'), 'should include reason');
  });

  test('modify() blocks when metabolism insufficient', async () => {
    const p = makePipeline();
    p._metabolism = {
      canAfford: () => false,
      getEnergyLevel: () => ({ current: 10, max: 100 }),
    };
    const result = await p.modify('add feature');
    assert(result.includes('energy') || result.includes('Insufficient'), 'should mention energy');
  });

  test('modify() consumes metabolism when available', async () => {
    let consumed = false;
    const p = makePipeline();
    p._metabolism = {
      canAfford: () => true,
      consume: () => { consumed = true; },
    };
    // modify will continue past consume and may throw on missing deps — that's ok
    try { await p.modify('add feature'); } catch (_e) { /* expected */ }
    assert(consumed, 'should consume metabolism');
  });

  test('_recordFailure increments counter', () => {
    const p = makePipeline();
    assertEqual(p._consecutiveFailures, 0);
    p._recordFailure('test error');
    assertEqual(p._consecutiveFailures, 1);
    assert(!p._frozen, 'should not be frozen after 1 failure');
  });

  test('_recordFailure trips circuit breaker at threshold', () => {
    const p = makePipeline();
    p._circuitBreakerThreshold = 2;
    p._recordFailure('error 1');
    assert(!p._frozen, 'not frozen after 1');
    p._recordFailure('error 2');
    assert(p._frozen, 'should be frozen after 2');
    assert(p._frozenReason.includes('error 2'), 'reason should contain last error');
  });

  test('_recordSuccess resets counter', () => {
    const p = makePipeline();
    p._consecutiveFailures = 5;
    p._recordSuccess('test.js');
    assertEqual(p._consecutiveFailures, 0);
  });

  test('resetCircuitBreaker clears frozen state', () => {
    const p = makePipeline();
    p._frozen = true;
    p._frozenReason = 'was frozen';
    p._consecutiveFailures = 5;
    p.resetCircuitBreaker();
    assert(!p._frozen, 'should not be frozen');
    assertEqual(p._consecutiveFailures, 0);
  });

  test('getCircuitBreakerStatus returns current state', () => {
    const p = makePipeline();
    p._consecutiveFailures = 2;
    const status = p.getCircuitBreakerStatus();
    assertEqual(status.failures, 2);
    assertEqual(status.frozen, false);
    assert(status.threshold >= 2, 'should have threshold');
  });

  test('_getCircuitBreakerThreshold uses genome when available', () => {
    const p = makePipeline();
    p._genome = { trait: (name) => name === 'riskTolerance' ? 0.8 : 0 };
    const threshold = p._getCircuitBreakerThreshold();
    // risk 0.8 → Math.ceil(1 + 0.8 * 4) = 5, clamped to max(2, 5) = 5
    assertEqual(threshold, 5);
  });

  test('_getCircuitBreakerThreshold defaults without genome', () => {
    const p = makePipeline();
    const threshold = p._getCircuitBreakerThreshold();
    assertEqual(threshold, 3); // default _circuitBreakerThreshold
  });

  test('_getCircuitBreakerThreshold floors at 2 for low risk', () => {
    const p = makePipeline();
    p._genome = { trait: () => 0.0 };
    const threshold = p._getCircuitBreakerThreshold();
    assert(threshold >= 2, 'minimum threshold is 2');
  });
});

describe('SelfModPipeline — Verification Branches', () => {
  function makePipeline(opts = {}) {
    return new SelfModificationPipeline({
      lang: { t: (k) => k, detect: () => {}, current: 'en' },
      bus: mockBus(), selfModel: {}, model: {}, prompts: {}, sandbox: {},
      reflector: {}, skills: null, cloner: null, reasoning: null,
      hotReloader: {}, guard: {}, tools: null, eventStore: null,
      rootDir: '/tmp', astDiff: null, ...opts,
    });
  }

  test('_verifyCode blocks when verifier not bound', () => {
    const p = makePipeline();
    // verifier is null by default (late-bound)
    const result = p._verifyCode('test.js', 'const x = 1;');
    assert(!result.pass, 'should not pass');
    assert(result.reason.includes('not available'), 'should explain');
  });

  test('_verifyCode passes when verifier succeeds', () => {
    const p = makePipeline();
    p.verifier = { verify: () => ({ status: 'pass' }) };
    const result = p._verifyCode('test.js', 'const x = 1;');
    assert(result.pass, 'should pass');
  });

  test('_verifyCode blocks when verifier fails', () => {
    const p = makePipeline();
    p.verifier = { verify: () => ({ status: 'fail', issues: [{ message: 'syntax error' }] }) };
    const result = p._verifyCode('test.js', 'const x = ;');
    assert(!result.pass, 'should not pass');
    assert(result.reason.includes('syntax error'), 'should include issue');
  });

  test('_verifyCode blocks when verifier throws (fail-closed)', () => {
    const p = makePipeline();
    p.verifier = { verify: () => { throw new Error('verifier crash'); } };
    const result = p._verifyCode('test.js', 'code');
    assert(!result.pass, 'should block on throw');
    assert(result.reason.includes('crash'), 'should include error');
  });

  test('_checkPreservation passes when not bound', () => {
    const p = makePipeline();
    const result = p._checkPreservation('test.js', 'old', 'new');
    assert(result.pass, 'should degrade gracefully');
  });

  test('_checkPreservation blocks on violation', () => {
    const p = makePipeline();
    p._preservation = {
      check: () => ({ safe: false, violations: [{ invariant: 'TEST', detail: 'rule removed' }] }),
    };
    const result = p._checkPreservation('test.js', 'old', 'new');
    assert(!result.pass, 'should block');
    assert(result.reason.includes('rule removed'), 'should include detail');
  });

  test('_checkPreservation blocks on throw (fail-closed)', () => {
    const p = makePipeline();
    p._preservation = { check: () => { throw new Error('invariant crash'); } };
    const result = p._checkPreservation('test.js', 'old', 'new');
    assert(!result.pass, 'should block on throw');
  });
});

// ═══════════════════════════════════════════════════════════
// Sandbox — Branch Coverage
// ═══════════════════════════════════════════════════════════

const { Sandbox } = require('../../src/agent/foundation/Sandbox');

describe('Sandbox — Edge Case Branches', () => {
  const tmpRoot = createTestRoot('sandbox-branches');
  const sandbox = new Sandbox(tmpRoot);

  test('execute rejects Python code', async () => {
    const result = await sandbox.execute('def hello():\n  print("hi")');
    assert(result.error, 'should error');
    assert(result.detectedLanguage === 'Python', 'should detect Python');
  });

  test('execute rejects Bash code', async () => {
    const result = await sandbox.execute('#!/bin/bash\necho hello');
    assert(result.error, 'should error');
    assert(result.detectedLanguage === 'Shell', 'should detect Shell');
  });

  test('execute rejects PHP code', async () => {
    const result = await sandbox.execute('<?php echo "hello"; ?>');
    assert(result.error, 'should error');
    assert(result.detectedLanguage === 'PHP', 'should detect PHP');
  });

  test('execute handles timeout with SIGKILL', async () => {
    const result = await sandbox.execute('while(true){}', { timeout: 500 });
    assert(result.error, 'should timeout');
    assert(result.error.includes('Timeout'), 'should mention timeout');
  });

  test('execute returns JSON output when possible', async () => {
    const result = await sandbox.execute('console.log("test output")');
    assert(!result.error, 'should not error: ' + result.error);
    assert(result.output.includes('test output'), 'should capture output');
  });

  test('executeWithContext requires trusted flag', async () => {
    try {
      await sandbox.executeWithContext('1+1', {}, { trusted: false });
      assert(false, 'should throw');
    } catch (err) {
      assert(err.message.includes('trusted: true'), 'should mention trusted');
    }
  });

  test('executeWithContext blocks code with safety violations', async () => {
    sandbox._codeSafety = {
      scanCode: () => ({ blocked: [{ description: 'eval detected' }] }),
    };
    const result = await sandbox.executeWithContext('eval("x")', {}, { trusted: true });
    assert(result.error, 'should block');
    assert(result.error.includes('safety scanner') || result.mode === 'vm-blocked', 'should mention safety');
    sandbox._codeSafety = null;
  });

  test('syntaxCheck validates correct JS', async () => {
    const result = await sandbox.syntaxCheck('const x = 1 + 2;');
    assert(result.valid, 'should be valid');
  });

  test('syntaxCheck rejects invalid JS', async () => {
    const result = await sandbox.syntaxCheck('const x = {{{');
    assert(!result.valid, 'should be invalid');
    assert(result.error, 'should have error message');
  });

  test('getStats returns isolation info', () => {
    const stats = sandbox.getStats();
    assert(stats.sandboxDir, 'should have sandboxDir');
    assert(typeof stats.memoryLimitMB === 'number', 'should have memoryLimit');
    assert(stats.isolation, 'should have isolation info');
  });

  test('getIsolationStatus returns platform info', () => {
    const status = sandbox.getIsolationStatus();
    assert(status.platform, 'should have platform');
    assert(typeof status.processIsolation === 'boolean', 'should have processIsolation flag');
  });

  test('cleanup clears sandbox dir', () => {
    // Write a temp file
    const tmpFile = path.join(sandbox.sandboxDir, 'cleanup-test.txt');
    fs.writeFileSync(tmpFile, 'test');
    assert(fs.existsSync(tmpFile), 'file should exist before cleanup');
    sandbox.cleanup();
    assert(!fs.existsSync(tmpFile), 'file should be removed after cleanup');
  });

  test('_detectLanguage returns false for JS code', () => {
    const result = sandbox._detectLanguage('const x = require("path");');
    assert(!result.detected, 'JS should not be detected as foreign');
  });

  test('_detectLanguage detects Ruby', () => {
    const result = sandbox._detectLanguage('#!/usr/bin/ruby\nputs "hello"');
    assert(result.detected, 'should detect');
    assertEqual(result.lang, 'Ruby');
  });

  test('_audit caps at maxAuditEntries', () => {
    const s = new Sandbox(tmpRoot);
    s.maxAuditEntries = 3;
    s._audit('a', '1'); s._audit('b', '2'); s._audit('c', '3'); s._audit('d', '4');
    assertEqual(s.auditLog.length, 3, 'should cap at max');
    assertEqual(s.auditLog[0].action, 'b', 'oldest should be evicted');
  });
});

// ═══════════════════════════════════════════════════════════
// ContainerManifest — skipPhases
// ═══════════════════════════════════════════════════════════

describe('ContainerManifest — skipPhases', () => {
  test('buildManifest accepts skipPhases option', () => {
    // Import buildManifest
    const { buildManifest } = require('../../src/agent/ContainerManifest');
    const tmpDir = createTestRoot('manifest-skip');
    const genesisDir = path.join(tmpDir, '.genesis');
    fs.mkdirSync(genesisDir, { recursive: true });

    // Build with skip — should not throw
    const manifest = buildManifest({
      rootDir: path.resolve(__dirname, '../..'),
      genesisDir,
      guard: { validateWrite: () => true, isProtected: () => false, isCritical: () => false },
      bus: mockBus(),
      intervals: { register: () => {}, shutdown: () => {} },
      bootProfile: 'full',
      skipPhases: [13],
    });

    // Phase 13 services should not be in manifest
    const hasConsciousness = manifest.has('attentionalGate') || manifest.has('phenomenalField');
    assert(!hasConsciousness, 'phase 13 services should be skipped');

    // Phase 2 services should still be there
    assert(manifest.has('intentRouter'), 'phase 2 should still be present');
  });

  test('skipPhases ignores phases below 6', () => {
    const { buildManifest } = require('../../src/agent/ContainerManifest');
    const tmpDir = createTestRoot('manifest-skip2');
    const genesisDir = path.join(tmpDir, '.genesis');
    fs.mkdirSync(genesisDir, { recursive: true });

    const manifest = buildManifest({
      rootDir: path.resolve(__dirname, '../..'),
      genesisDir,
      guard: { validateWrite: () => true, isProtected: () => false, isCritical: () => false },
      bus: mockBus(),
      intervals: { register: () => {}, shutdown: () => {} },
      bootProfile: 'full',
      skipPhases: [1, 2, 3], // Should be ignored — phases 1-5 required
    });

    assert(manifest.has('intentRouter'), 'phase 2 cannot be skipped');
  });
});

// ═══════════════════════════════════════════════════════════

if (require.main === module) run();
