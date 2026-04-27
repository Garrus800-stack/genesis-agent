// ============================================================
// Test: v7.4.8 — EnvironmentContext + Failover Reason
//
// Component A: EnvironmentContext helper (DRY for anti-hallucination
//   prompt block, shared between FormalPlanner and ShellAgent).
// Component B: Failover reason classification (additive on
//   model:failover) + new model:failover-unavailable event for the
//   null-return path of _findFallbackBackend.
// Component C: Source-path tests against the REAL ModelBridge
//   (closes the mock-only-test smell of llm-failover.test.js).
// ============================================================

'use strict';

const path = require('path');
const fs = require('fs');

let passed = 0, failed = 0;
const failures = [];
function test(name, fn) {
  try {
    const r = fn();
    if (r && typeof r.then === 'function') {
      return r.then(() => { passed++; console.log(`    ✅ ${name}`); })
              .catch(err => { failed++; failures.push({ name, error: err.message }); console.log(`    ❌ ${name}: ${err.message}`); });
    }
    passed++; console.log(`    ✅ ${name}`);
  } catch (err) { failed++; failures.push({ name, error: err.message }); console.log(`    ❌ ${name}: ${err.message}`); }
}
function assert(c, m) { if (!c) throw new Error(m || 'Assertion failed'); }
function assertEqual(a, b, m) { if (a !== b) throw new Error(`${m || 'not equal'}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`); }

(async () => {
  console.log('  v748-fix tests:');

  // ──────────────────────────────────────────────────────────────
  // Component A — EnvironmentContext
  // ──────────────────────────────────────────────────────────────

  await test('A1 buildOsContext({isWindows:true}) contains find /V /C and DO NOT patterns', () => {
    const { buildOsContext } = require('../../src/agent/core/EnvironmentContext');
    const { osContext, osName, isWindows } = buildOsContext({ isWindows: true, platform: 'win32', rootDir: 'C:\\genesis' });
    assertEqual(osName, 'Windows');
    assertEqual(isWindows, true);
    assert(osContext.includes('find /V /C ":"'), 'Windows correct-form rule missing');
    assert(osContext.includes('DO NOT use `find /c "*"`'), 'Windows DO NOT #1 missing');
    assert(osContext.includes('DO NOT use `find /c /v ""`'), 'Windows DO NOT #2 missing');
    assert(osContext.includes('DO NOT use `wc -l`'), 'Windows DO NOT #3 missing');
    assert(osContext.includes('DO NOT use "/s"'), 'Windows DO NOT #4 missing');
  });

  await test('A2 buildOsContext({isWindows:false}) excludes Windows-only block', () => {
    const { buildOsContext } = require('../../src/agent/core/EnvironmentContext');
    const { osContext, osName } = buildOsContext({ isWindows: false, platform: 'linux', rootDir: '/home/genesis' });
    assertEqual(osName, 'Linux');
    assert(!osContext.includes('find /V /C'), 'should not contain Windows-only directive');
    assert(!osContext.includes('DO NOT use `find /c'), 'should not contain Windows DO-NOT block');
    assert(osContext.includes('rootDir'), 'should still contain rootDir reference');
    assert(osContext.includes('ls'), 'Linux list cmd should be present');
  });

  await test('A3 macOS detection works', () => {
    const { buildOsContext } = require('../../src/agent/core/EnvironmentContext');
    const { osName } = buildOsContext({ isWindows: false, platform: 'darwin' });
    assertEqual(osName, 'macOS');
  });

  await test('A4 source-presence: FormalPlanner imports and uses EnvironmentContext', () => {
    const fpSrc = fs.readFileSync(path.join(__dirname, '..', '..', 'src/agent/revolution/FormalPlanner.js'), 'utf8');
    assert(fpSrc.includes("require('../core/EnvironmentContext')"), 'FormalPlanner must require EnvironmentContext from core/');
    assert(/buildOsContext\(\s*\{/.test(fpSrc), 'FormalPlanner must call buildOsContext()');
    // Verify the helper output is concatenated into the prompt (osContext used in template literal)
    assert(/\$\{osContext\}/.test(fpSrc), 'FormalPlanner must use ${osContext} in prompt');
  });

  await test('A5 source-presence: ShellAgent imports and uses EnvironmentContext', () => {
    const saSrc = fs.readFileSync(path.join(__dirname, '..', '..', 'src/agent/capabilities/ShellAgent.js'), 'utf8');
    assert(saSrc.includes("require('../core/EnvironmentContext')"), 'ShellAgent must require EnvironmentContext from core/');
    assert(/buildOsContext\(\s*\{/.test(saSrc), 'ShellAgent must call buildOsContext()');
    assert(/\$\{osContext\}/.test(saSrc), 'ShellAgent must use ${osContext} in prompt');
  });

  // ──────────────────────────────────────────────────────────────
  // Component B — Failover Reason Classification
  // ──────────────────────────────────────────────────────────────

  await test('B1 _classifyFailoverReason classifies all 5 categories correctly', () => {
    const { ModelBridge } = require('../../src/agent/foundation/ModelBridge');
    const bridge = new ModelBridge({});
    // rate-limit
    assertEqual(bridge._classifyFailoverReason(new Error('rate limit exceeded')), 'rate-limit');
    assertEqual(bridge._classifyFailoverReason(new Error('429 Too Many Requests')), 'rate-limit');
    // timeout
    assertEqual(bridge._classifyFailoverReason(new Error('Request timed out after 30s')), 'timeout');
    assertEqual(bridge._classifyFailoverReason(new Error('ETIMEDOUT')), 'timeout');
    // connection-error (incl. reviewer-suggested edge cases)
    assertEqual(bridge._classifyFailoverReason(new Error('ECONNREFUSED ::1:11434')), 'connection-error');
    assertEqual(bridge._classifyFailoverReason(new Error('EAI_AGAIN getaddrinfo')), 'connection-error');
    assertEqual(bridge._classifyFailoverReason(new Error('socket hang up')), 'connection-error');
    assertEqual(bridge._classifyFailoverReason(new Error('fetch failed')), 'connection-error');
    // auth
    assertEqual(bridge._classifyFailoverReason(new Error('401 Unauthorized')), 'auth');
    assertEqual(bridge._classifyFailoverReason(new Error('Invalid API key')), 'auth');
    // other
    assertEqual(bridge._classifyFailoverReason(new Error('weird unknown failure')), 'other');
    assertEqual(bridge._classifyFailoverReason(null), 'other');
    assertEqual(bridge._classifyFailoverReason(undefined), 'other');
  });

  await test('B2 source-presence: model:failover emits include both error AND reason fields', () => {
    const mbSrc = fs.readFileSync(path.join(__dirname, '..', '..', 'src/agent/foundation/ModelBridge.js'), 'utf8');
    // Find all model:failover emit lines (not failover-unavailable)
    const emitLines = mbSrc.split('\n').filter(l => /bus\.fire\('model:failover'/.test(l));
    assert(emitLines.length >= 2, `expected at least 2 model:failover emit sites, got ${emitLines.length}`);
    for (const line of emitLines) {
      assert(/error:\s*err\.message/.test(line), `emit line missing error field: ${line.trim()}`);
      assert(/reason/.test(line), `emit line missing reason field: ${line.trim()}`);
    }
  });

  await test('B3 source-presence: chat() and streamChat() both emit model:failover-unavailable on null path', () => {
    const mbSrc = fs.readFileSync(path.join(__dirname, '..', '..', 'src/agent/foundation/ModelBridge.js'), 'utf8');
    // Pattern-based check (not line-range-based, per reviewer feedback):
    // Find chat() body — between `async chat(` and next `async ` declaration
    const chatStart = mbSrc.indexOf('async chat(');
    assert(chatStart > 0, 'chat() function not found');
    const afterChat = mbSrc.indexOf('async ', chatStart + 10);
    assert(afterChat > 0, 'next async function after chat() not found');
    const chatBody = mbSrc.slice(chatStart, afterChat);
    assert(chatBody.includes('_emitFailoverUnavailable'), 'chat() must call _emitFailoverUnavailable on null-return path');

    // streamChat()
    const streamStart = mbSrc.indexOf('async streamChat(');
    assert(streamStart > 0, 'streamChat() function not found');
    const afterStream = mbSrc.indexOf('async ', streamStart + 10);
    // afterStream may be -1 if streamChat is the last async; in that case use end of file
    const streamEnd = afterStream > 0 ? afterStream : mbSrc.length;
    const streamBody = mbSrc.slice(streamStart, streamEnd);
    assert(streamBody.includes('_emitFailoverUnavailable'), 'streamChat() must call _emitFailoverUnavailable on null-return path');
  });

  await test('B4 _emitFailoverUnavailable selects no-chain-configured when chain is empty', () => {
    const { ModelBridge } = require('../../src/agent/foundation/ModelBridge');
    const events = [];
    const fakeBus = { fire: (k, p) => events.push({ k, p }), emit: () => {}, on: () => {} };
    const bridge = new ModelBridge({ bus: fakeBus });
    bridge._settings = { get: () => null }; // no chain configured
    bridge._emitFailoverUnavailable('anthropic', new Error('rate limit'));
    const ev = events.find(e => e.k === 'model:failover-unavailable');
    assert(ev, 'expected model:failover-unavailable to fire');
    assertEqual(ev.p.from, 'anthropic');
    assertEqual(ev.p.reason, 'no-chain-configured');
    assert(ev.p.error.includes('rate limit'), 'error field should be set');
  });

  await test('B5 _emitFailoverUnavailable selects all-other-backends-unavailable when chain set', () => {
    const { ModelBridge } = require('../../src/agent/foundation/ModelBridge');
    const events = [];
    const fakeBus = { fire: (k, p) => events.push({ k, p }), emit: () => {}, on: () => {} };
    const bridge = new ModelBridge({ bus: fakeBus });
    bridge._settings = {
      get: (k) => k === 'models.fallbackChain' ? ['model-x', 'model-y'] : null,
    };
    bridge._emitFailoverUnavailable('anthropic', new Error('all backends down'));
    const ev = events.find(e => e.k === 'model:failover-unavailable');
    assert(ev, 'expected model:failover-unavailable to fire');
    assertEqual(ev.p.reason, 'all-other-backends-unavailable');
  });

  // ──────────────────────────────────────────────────────────────
  // Component C — Real Source-Path Tests against actual ModelBridge
  // ──────────────────────────────────────────────────────────────

  await test('C1 ModelBridge._findFallbackBackend selects from configured chain (real source path)', () => {
    const { ModelBridge } = require('../../src/agent/foundation/ModelBridge');
    const { NullBus } = require('../../src/agent/core/EventBus');
    const bridge = new ModelBridge({ bus: NullBus });

    // Override late-bound and internal properties (constructor only takes bus + maxConcurrentLLM)
    bridge._settings = {
      get: (key) => key === 'models.fallbackChain' ? ['model-b'] : null,
    };
    bridge.availableModels = [
      { name: 'model-a', backend: 'anthropic' },
      { name: 'model-b', backend: 'openai' },
    ];
    bridge.activeBackend = 'anthropic';
    bridge.backends.anthropic = { isConfigured: () => true };
    bridge.backends.openai    = { isConfigured: () => true };

    const result = bridge._findFallbackBackend('anthropic');
    assertEqual(result, 'openai', 'falls back to openai when chain has model-b on openai');
    assert(bridge._fallbackModel, 'expected _fallbackModel to be set');
    assertEqual(bridge._fallbackModel.name, 'model-b');
  });

  await test('C2 ModelBridge._findFallbackBackend returns null when nothing else configured', () => {
    const { ModelBridge } = require('../../src/agent/foundation/ModelBridge');
    const { NullBus } = require('../../src/agent/core/EventBus');
    const bridge = new ModelBridge({ bus: NullBus });

    bridge._settings = { get: () => null }; // no chain
    bridge.availableModels = []; // no models at all
    bridge.activeBackend = 'anthropic';
    // Mark all backends as unconfigured
    bridge.backends.anthropic = { isConfigured: () => false };
    bridge.backends.openai    = { isConfigured: () => false };
    bridge.backends.ollama    = { isConfigured: () => false };

    const result = bridge._findFallbackBackend('anthropic');
    assertEqual(result, null, 'returns null when no other backend available');
  });

  // ──────────────────────────────────────────────────────────────
  // Summary
  // ──────────────────────────────────────────────────────────────

  console.log(`\n  v748-fix: ${passed} passed, ${failed} failed`);
  if (failed > 0) {
    console.log('  Failures:');
    for (const f of failures) console.log(`    - ${f.name}: ${f.error}`);
    process.exitCode = 1;
  }
})();
