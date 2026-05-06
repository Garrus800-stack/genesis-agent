// ============================================================
// Test: v7.5.6 — Same-Backend Failover + Model-Availability TTL
//                + Reasoning-Block Filter + DE/EN Pattern Parity
//
// Component A: ModelBridge same-backend fallback (Item 1).
//   Old _findFallbackBackend rejected any chain entry whose backend
//   matched the failed backend, making models.fallbackChain useless
//   when all configured fallbacks lived on the same backend (e.g.
//   all Ollama). New version skips only the specific failed model
//   plus marked-unavailable models; same-backend fallback works.
// Component B: ModelBridge unavailable-marking with TTL (Item 2).
//   Source-presence + schema validation. Behavioral tests live in
//   model-availability.test.js (in-process, no I/O).
// Component C: Reasoning-block stream filter (Item 3).
//   Source-presence; behavioral tests in thinking-block-*.test.js.
// Component D: SelfStatementLog DE/EN parity (Item 4).
//   Source-presence + load-time parity assertion. Behavioral tests
//   extend the existing self-statement-log.test.js suite.
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
  console.log('  v756-fix tests:');

  // ──────────────────────────────────────────────────────────────
  // Component A — Same-Backend Failover (Item 1)
  // ──────────────────────────────────────────────────────────────

  await test('A1 source-presence: _findFallbackBackend signature accepts failedModelName', () => {
    const mbSrc = fs.readFileSync(path.join(__dirname, '../../src/agent/foundation/ModelBridge.js'), 'utf8');
    assert(/_findFallbackBackend\s*\(\s*failedBackend\s*,\s*failedModelName\s*=\s*null\s*\)/.test(mbSrc),
      '_findFallbackBackend must accept (failedBackend, failedModelName = null)');
  });

  await test('A2 source-presence: _findFallbackBackend skips failed model and marked-unavailable', () => {
    const mbSrc = fs.readFileSync(path.join(__dirname, '../../src/agent/foundation/ModelBridge.js'), 'utf8');
    assert(/if\s*\(\s*modelName\s*===\s*failedModelName\s*\)\s*continue/.test(mbSrc),
      'must skip when modelName === failedModelName');
    assert(/if\s*\(\s*this\.isMarkedUnavailable\s*\(\s*modelName\s*\)\s*\)\s*continue/.test(mbSrc),
      'must skip marked-unavailable models in chain');
  });

  await test('A3 source-presence: cross-backend ollama check filters marked-unavailable', () => {
    const mbSrc = fs.readFileSync(path.join(__dirname, '../../src/agent/foundation/ModelBridge.js'), 'utf8');
    assert(/m\.backend\s*===\s*'ollama'\s*&&\s*!this\.isMarkedUnavailable\s*\(\s*m\.name\s*\)/.test(mbSrc),
      'cross-backend ollama check must filter marked-unavailable');
  });

  await test('A4 source-presence: old strict check (model.backend !== failedBackend) is gone', () => {
    const mbSrc = fs.readFileSync(path.join(__dirname, '../../src/agent/foundation/ModelBridge.js'), 'utf8');
    assert(!/model\.backend\s*!==\s*failedBackend/.test(mbSrc),
      'the strict cross-backend-only check must be removed');
  });

  await test('A5 behavior: _findFallbackBackend handles same-backend chain', () => {
    const { ModelBridge } = require('../../src/agent/foundation/ModelBridge');
    const { NullBus } = require('../../src/agent/core/EventBus');
    const bridge = new ModelBridge({ bus: NullBus });
    bridge._settings = {
      get: (k) => k === 'models.fallbackChain' ? ['model-a', 'model-b', 'model-c'] : null,
    };
    bridge.availableModels = [
      { name: 'model-a', backend: 'ollama' },
      { name: 'model-b', backend: 'ollama' },
      { name: 'model-c', backend: 'ollama' },
    ];

    const result = bridge._findFallbackBackend('ollama', 'model-a');
    assertEqual(result, 'ollama', 'should fallback within ollama backend');
    assert(bridge._fallbackModel, '_fallbackModel must be set');
    assertEqual(bridge._fallbackModel.name, 'model-b', 'should pick model-b after skipping model-a');
  });

  await test('A6 behavior: skips marked-unavailable models in chain', () => {
    const { ModelBridge } = require('../../src/agent/foundation/ModelBridge');
    const { NullBus } = require('../../src/agent/core/EventBus');
    const bridge = new ModelBridge({ bus: NullBus });
    bridge._settings = {
      get: (k) => k === 'models.fallbackChain' ? ['model-a', 'model-b', 'model-c'] : null,
    };
    bridge.availableModels = [
      { name: 'model-a', backend: 'ollama' },
      { name: 'model-b', backend: 'ollama' },
      { name: 'model-c', backend: 'ollama' },
    ];
    bridge.markUnavailable('model-b', 60000, 'auth');

    const result = bridge._findFallbackBackend('ollama', 'model-a');
    assertEqual(result, 'ollama');
    assertEqual(bridge._fallbackModel.name, 'model-c', 'should skip marked model-b, pick model-c');
  });

  await test('A7 behavior: backwards-compat — single-arg call still works', () => {
    const { ModelBridge } = require('../../src/agent/foundation/ModelBridge');
    const { NullBus } = require('../../src/agent/core/EventBus');
    const bridge = new ModelBridge({ bus: NullBus });
    bridge._settings = {
      get: (k) => k === 'models.fallbackChain' ? ['fallback-x'] : null,
    };
    bridge.availableModels = [{ name: 'fallback-x', backend: 'openai' }];
    bridge.backends = { ollama: { isConfigured: () => false }, anthropic: { isConfigured: () => false }, openai: { isConfigured: () => true } };

    const result = bridge._findFallbackBackend('anthropic');
    assertEqual(result, 'openai', 'single-arg call must still find chain entry');
  });

  await test('A8 behavior: returns null when chain exhausted and only-ollama available', () => {
    const { ModelBridge } = require('../../src/agent/foundation/ModelBridge');
    const { NullBus } = require('../../src/agent/core/EventBus');
    const bridge = new ModelBridge({ bus: NullBus });
    bridge._settings = { get: () => [] };
    bridge.availableModels = [{ name: 'only-model', backend: 'ollama' }];
    bridge.backends = { ollama: { isConfigured: () => true }, anthropic: { isConfigured: () => false }, openai: { isConfigured: () => false } };

    const result = bridge._findFallbackBackend('ollama');
    assertEqual(result, null, 'no fallback when only ollama and chain empty');
  });

  // ──────────────────────────────────────────────────────────────
  // Component B — Unavailable Marking (Item 2) — source-presence
  // ──────────────────────────────────────────────────────────────

  await test('B1 source-presence: ModelBridge has markUnavailable/isMarkedUnavailable/clearUnavailable', () => {
    const mbSrc = fs.readFileSync(path.join(__dirname, '../../src/agent/foundation/ModelBridge.js'), 'utf8');
    const mixinSrc = fs.readFileSync(path.join(__dirname, '../../src/agent/foundation/ModelBridgeAvailability.js'), 'utf8');
    const combined = mbSrc + '\n' + mixinSrc;
    assert(/\bmarkUnavailable\s*\(/.test(combined), 'markUnavailable missing');
    assert(/\bisMarkedUnavailable\s*\(/.test(combined), 'isMarkedUnavailable missing');
    assert(/\bclearUnavailable\s*\(/.test(combined), 'clearUnavailable missing');
  });

  await test('B2 source-presence: persistence helpers _loadUnavailable/_persistUnavailable', () => {
    const mbSrc = fs.readFileSync(path.join(__dirname, '../../src/agent/foundation/ModelBridge.js'), 'utf8');
    const mixinSrc = fs.readFileSync(path.join(__dirname, '../../src/agent/foundation/ModelBridgeAvailability.js'), 'utf8');
    // Methods may live in the mixin (v7.5.6 split for LOC budget), so check both files.
    const combined = mbSrc + '\n' + mixinSrc;
    assert(/_loadUnavailable\s*\(/.test(combined), '_loadUnavailable missing');
    assert(/_persistUnavailable\s*\(/.test(combined), '_persistUnavailable missing');
    assert(/atomicWriteFileSync/.test(combined), 'atomicWriteFileSync usage missing');
    assert(/safeJsonParse/.test(combined), 'safeJsonParse usage missing');
    // ModelBridge must wire the mixin. v7.5.8 added a second mixin
    // (ModelBridgeDiscovery), so the call became
    // Object.assign(ModelBridge.prototype, availability, discovery).
    // The check accepts both single- and multi-mixin forms.
    assert(/Object\.assign\s*\(\s*ModelBridge\.prototype\s*,[^)]*\bavailability\b/.test(mbSrc),
      'ModelBridge must Object.assign(availability) at module bottom');
  });

  await test('B3 source-presence: constructor accepts genesisDir', () => {
    const mbSrc = fs.readFileSync(path.join(__dirname, '../../src/agent/foundation/ModelBridge.js'), 'utf8');
    assert(/constructor\s*\(\s*\{\s*[^}]*genesisDir[^}]*\}\s*=\s*\{\s*\}\s*\)/.test(mbSrc),
      'constructor must accept { ..., genesisDir }');
  });

  await test('B4 source-presence: failover handler triggers markUnavailable with TTL map', () => {
    const mbSrc = fs.readFileSync(path.join(__dirname, '../../src/agent/foundation/ModelBridge.js'), 'utf8');
    // v7.5.6: chat() and streamChat() share a single _handleFailoverError
    // helper; the markUnavailable trigger lives there now (was duplicated
    // in both catch-blocks pre-helper). One trigger site is correct.
    assert(/this\.markUnavailable\s*\(\s*calledModel/.test(mbSrc),
      'markUnavailable must be called with calledModel from the failover handler');
    assert(/_handleFailoverError\s*\(/.test(mbSrc),
      'shared _handleFailoverError must exist');
    // Both chat() and streamChat() must invoke the helper
    const helperCalls = (mbSrc.match(/this\._handleFailoverError\s*\(/g) || []).length;
    assert(helperCalls >= 2, `chat() and streamChat() must both call _handleFailoverError (got ${helperCalls})`);
    // TTL map must exist as module constant
    assert(/UNAVAILABLE_TTL_MAP\s*=\s*\{/.test(mbSrc), 'UNAVAILABLE_TTL_MAP module constant must be defined');
    assert(/'auth'\s*:\s*60\s*\*\s*60\s*\*\s*1000/.test(mbSrc), 'auth TTL must be 1h');
    assert(/'rate-limit'\s*:\s*5\s*\*\s*60\s*\*\s*1000/.test(mbSrc), 'rate-limit TTL must be 5min');
    assert(/'timeout'\s*:\s*10\s*\*\s*60\s*\*\s*1000/.test(mbSrc), 'timeout TTL must be 10min');
  });

  await test('B5 source-presence: detectAvailable filters marked at all 4 priorities', () => {
    const mbSrc = fs.readFileSync(path.join(__dirname, '../../src/agent/foundation/ModelBridge.js'), 'utf8');
    // v7.5.7: detectAvailable + _scoreModel + _selectBestModel + getRankedModels
    // were extracted to ModelBridgeDiscovery.js (mixin) for the LOC budget.
    // Search both files together — the boot-time selection still has to skip
    // marked-unavailable models at every priority.
    const discoverySrc = fs.readFileSync(path.join(__dirname, '../../src/agent/foundation/ModelBridgeDiscovery.js'), 'utf8');
    const combined = mbSrc + '\n' + discoverySrc;
    const isMarkedHits = combined.match(/this\.isMarkedUnavailable\s*\(/g) || [];
    // 1× fallback + 1× cross-backend ollama + 4× boot-selection (P1, P2 anthropic, P2 openai, P3 + P4 each via filter) = at least 5
    assert(isMarkedHits.length >= 5, `boot-time + fallback isMarkedUnavailable usage too low (${isMarkedHits.length})`);
  });

  await test('B6 schema-presence: model:marked-unavailable + model:unavailable-cleared', () => {
    const schemasSrc = fs.readFileSync(path.join(__dirname, '../../src/agent/core/EventPayloadSchemas.js'), 'utf8');
    assert(/'model:marked-unavailable'\s*:\s*\{[^}]*modelName:\s*'required'[^}]*reason:\s*'required'[^}]*ttlMs:\s*'required'/.test(schemasSrc),
      'model:marked-unavailable schema missing or wrong shape');
    assert(/'model:unavailable-cleared'\s*:\s*\{[^}]*modelName:\s*'required'[^}]*automatic:\s*'required'/.test(schemasSrc),
      'model:unavailable-cleared schema missing or wrong shape');
  });

  await test('B7 EventTypes-presence: MARKED_UNAVAILABLE + UNAVAILABLE_CLEARED', () => {
    const { EVENTS } = require('../../src/agent/core/EventTypes');
    assertEqual(EVENTS.MODEL.MARKED_UNAVAILABLE, 'model:marked-unavailable');
    assertEqual(EVENTS.MODEL.UNAVAILABLE_CLEARED, 'model:unavailable-cleared');
  });

  await test('B8 source-presence: /model-reset registered as slash-only intent', () => {
    const slashCmds = fs.readFileSync(path.join(__dirname, '../../src/agent/intelligence/slash-commands.js'), 'utf8');
    assert(/name:\s*'model-reset'/.test(slashCmds), 'model-reset must be in slash-commands.js');
    const intentSrc = fs.readFileSync(path.join(__dirname, '../../src/agent/intelligence/IntentPatterns.js'), 'utf8');
    assert(/'model-reset'\s*,\s*\[\s*\/\(\?:\^\|\\s\)\\\/model-reset/.test(intentSrc),
      'model-reset pattern must be registered in IntentPatterns');
  });

  await test('B9 source-presence: CommandHandlers has modelReset handler', () => {
    const handlerSrc = fs.readFileSync(path.join(__dirname, '../../src/agent/hexagonal/CommandHandlers.js'), 'utf8');
    assert(/registerHandler\s*\(\s*'model-reset'/.test(handlerSrc),
      'CommandHandlers must registerHandler for model-reset');
    assert(/async\s+modelReset\s*\(/.test(handlerSrc),
      'modelReset method must exist');
  });

  // ──────────────────────────────────────────────────────────────
  // Component C — Thinking-Block Filter (Item 3) — source-presence
  // ──────────────────────────────────────────────────────────────

  await test('C1 source-presence: thinking-block-stream-filter module exists with both exports', () => {
    const filterPath = path.join(__dirname, '../../src/agent/core/thinking-block-stream-filter.js');
    assert(fs.existsSync(filterPath), 'thinking-block-stream-filter.js must exist');
    const src = fs.readFileSync(filterPath, 'utf8');
    assert(/createThinkingBlockStreamFilter/.test(src), 'must export createThinkingBlockStreamFilter');
    assert(/stripThinkingBlocks/.test(src), 'must export stripThinkingBlocks');
    assert(/module\.exports\s*=\s*\{[^}]*createThinkingBlockStreamFilter/.test(src),
      'createThinkingBlockStreamFilter must be exported');
    assert(/module\.exports\s*=\s*\{[^}]*stripThinkingBlocks/.test(src),
      'stripThinkingBlocks must be exported');
  });

  await test('C2 EventTypes-presence: MODEL.THINKING_TRACE', () => {
    const { EVENTS } = require('../../src/agent/core/EventTypes');
    assertEqual(EVENTS.MODEL.THINKING_TRACE, 'model:thinking-trace');
  });

  await test('C3 schema-presence: model:thinking-trace', () => {
    const schemasSrc = fs.readFileSync(path.join(__dirname, '../../src/agent/core/EventPayloadSchemas.js'), 'utf8');
    assert(/'model:thinking-trace'\s*:\s*\{[^}]*text:\s*'required'[^}]*modelName:\s*'required'/.test(schemasSrc),
      'model:thinking-trace schema missing or wrong shape');
  });

  await test('C4 source-presence: ChatOrchestrator imports + uses thinking-block filter', () => {
    const orchSrc = fs.readFileSync(path.join(__dirname, '../../src/agent/hexagonal/ChatOrchestrator.js'), 'utf8');
    assert(/createThinkingBlockStreamFilter|stripThinkingBlocks/.test(orchSrc),
      'ChatOrchestrator must import the filter');
    assert(/cleanResponse/.test(orchSrc),
      'ChatOrchestrator must use cleanResponse variable name');
  });

  await test('C5 source-presence: ChatOrchestratorHelpers strips thinking from synthesis', () => {
    const helperSrc = fs.readFileSync(path.join(__dirname, '../../src/agent/hexagonal/ChatOrchestratorHelpers.js'), 'utf8');
    assert(/stripThinkingBlocks/.test(helperSrc),
      'ChatOrchestratorHelpers must use stripThinkingBlocks for synthesis');
  });

  await test('C6 source-presence: ReasoningTracer subscribes to model:thinking-trace', () => {
    const tracerSrc = fs.readFileSync(path.join(__dirname, '../../src/agent/cognitive/ReasoningTracer.js'), 'utf8');
    assert(/model:thinking-trace/.test(tracerSrc),
      'ReasoningTracer TRACE_SUBSCRIPTIONS must include model:thinking-trace');
  });

  // ──────────────────────────────────────────────────────────────
  // Component D — Self-Statement-Log DE/EN parity (Item 4)
  // ──────────────────────────────────────────────────────────────

  await test('D1 source-presence: SelfStatementClassifier uses module-level LANG_PATTERNS', () => {
    // v7.6.1 Track A: patterns moved from SelfStatementLog to SelfStatementClassifier.
    const sslSrc = fs.readFileSync(path.join(__dirname, '../../src/agent/cognitive/SelfStatementClassifier.js'), 'utf8');
    assert(/const\s+LANG_PATTERNS\s*=\s*\{/.test(sslSrc), 'LANG_PATTERNS const must exist at module level');
    assert(/de\s*:\s*\{[\s\S]*?firstPersonExplicit[\s\S]*?verbFirst[\s\S]*?promiseMarkers[\s\S]*?emotionMarkers/.test(sslSrc),
      'LANG_PATTERNS.de must have all 4 keys');
    assert(/en\s*:\s*\{[\s\S]*?firstPersonExplicit[\s\S]*?verbFirst[\s\S]*?promiseMarkers[\s\S]*?emotionMarkers/.test(sslSrc),
      'LANG_PATTERNS.en must have all 4 keys');
  });

  await test('D2 source-presence: NEUTRAL_PATTERNS module-level (deduped MODULE_PREFIX)', () => {
    // v7.6.1 Track A: NEUTRAL_PATTERNS lives in SelfStatementClassifier; the
    // old MODULE_PREFIX duplicate must remain absent in BOTH SelfStatementLog
    // (where it was originally) and SelfStatementClassifier (the new home).
    const classifierSrc = fs.readFileSync(path.join(__dirname, '../../src/agent/cognitive/SelfStatementClassifier.js'), 'utf8');
    const logSrc = fs.readFileSync(path.join(__dirname, '../../src/agent/cognitive/SelfStatementLog.js'), 'utf8');
    assert(/const\s+NEUTRAL_PATTERNS\s*=\s*\{/.test(classifierSrc), 'NEUTRAL_PATTERNS const must exist in SelfStatementClassifier');
    const dupHitsClassifier = classifierSrc.match(/const\s+MODULE_PREFIX\s*=/g) || [];
    const dupHitsLog        = logSrc.match(/const\s+MODULE_PREFIX\s*=/g) || [];
    assertEqual(dupHitsClassifier.length + dupHitsLog.length, 0,
      'duplicate const MODULE_PREFIX inside methods must be removed (use NEUTRAL_PATTERNS instead)');
  });

  await test('D3 lang-parity assertion runs at module-load', () => {
    // Loading the module triggers the parity check in module body.
    // If keys mismatch, the require() throws synchronously.
    require('../../src/agent/cognitive/SelfStatementLog');
    // No throw = parity holds. Assertion is implicit.
    assert(true);
  });

  // ──────────────────────────────────────────────────────────────
  // Component E — _recordMetaOutcome calledModel parameter (Item 5)
  //
  // Pre-v7.5.6 _recordMetaOutcome read this.activeModel. During
  // failover the original-failed model stayed in activeModel even
  // after the fallback dispatch, so MetaLearning saw:
  //   * the dead model with success=true (post-fallback)
  //   * the dead model with success=false (no-fallback path)
  //   * NEVER the actual fallback model with anything
  // Both per-model success-rate readings were biased.
  // ──────────────────────────────────────────────────────────────

  await test('E1 source-presence: _recordMetaOutcome accepts calledModel parameter', () => {
    const mbSrc = fs.readFileSync(path.join(__dirname, '../../src/agent/foundation/ModelBridge.js'), 'utf8');
    assert(/_recordMetaOutcome\([^)]*calledModel\s*=\s*null\s*\)/.test(mbSrc),
      '_recordMetaOutcome must accept calledModel parameter');
    assert(/model:\s*calledModel\s*\|\|\s*this\.activeModel/.test(mbSrc),
      'recordOutcome must use calledModel || activeModel for model field');
  });

  await test('E2 source-presence: chat() catch passes calledModel for failure path', () => {
    const mbSrc = fs.readFileSync(path.join(__dirname, '../../src/agent/foundation/ModelBridge.js'), 'utf8');
    // Failure path records with calledModel
    assert(/_recordMetaOutcome\([^)]*false[^)]*options[^)]*calledModel\)/.test(mbSrc),
      'failure-path _recordMetaOutcome must include calledModel arg');
    // Success path records with calledModel
    assert(/_recordMetaOutcome\([^)]*true[^)]*options[^)]*calledModel\)/.test(mbSrc),
      'success-path _recordMetaOutcome must include calledModel arg');
  });

  await test('E3 source-presence: post-failover success records fallbackModelName', () => {
    const mbSrc = fs.readFileSync(path.join(__dirname, '../../src/agent/foundation/ModelBridge.js'), 'utf8');
    assert(/fallbackModelName\s*=\s*this\._fallbackModel\?\.name/.test(mbSrc),
      'must capture _fallbackModel.name BEFORE _dispatchChat consumes it');
    assert(/_recordMetaOutcome\([^)]*failover:\s*true\s*\}[^)]*fallbackModelName\)/.test(mbSrc),
      'post-failover _recordMetaOutcome must pass fallbackModelName');
  });

  await test('E4 behavior: success path attributes correct model', () => {
    const { ModelBridge } = require('../../src/agent/foundation/ModelBridge');
    const recorded = [];
    const fakeMeta = { recordOutcome: (entry) => recorded.push(entry) };
    const bridge = new ModelBridge({ bus: { fire: () => {}, emit: () => {} } });
    bridge.metaLearning = fakeMeta;
    bridge._recordMetaOutcome('chat', 0.7, Date.now(), true, {}, 'specific-model');
    assertEqual(recorded.length, 1);
    assertEqual(recorded[0].model, 'specific-model',
      'when calledModel is passed, it must be used (not this.activeModel)');
  });

  await test('E5 behavior: backwards-compat — no calledModel falls back to activeModel', () => {
    const { ModelBridge } = require('../../src/agent/foundation/ModelBridge');
    const recorded = [];
    const fakeMeta = { recordOutcome: (entry) => recorded.push(entry) };
    const bridge = new ModelBridge({ bus: { fire: () => {}, emit: () => {} } });
    bridge.metaLearning = fakeMeta;
    bridge.activeModel = 'fallback-model';
    bridge._recordMetaOutcome('chat', 0.7, Date.now(), true, {});
    assertEqual(recorded[0].model, 'fallback-model',
      'when calledModel omitted/null, must read this.activeModel');
  });

  await test('E6 source-presence: streamChat records to MetaLearning (parity with chat)', () => {
    const mbSrc = fs.readFileSync(path.join(__dirname, '../../src/agent/foundation/ModelBridge.js'), 'utf8');
    // v7.5.6: streamChat now records via _handleFailoverError (failure +
    // post-failover success) and directly on the success path. Pre-v7.5.6
    // streamChat had no MetaLearning recording at all — streaming-failure
    // rates were invisible to the learner. Verify both paths exist.
    const streamMatch = mbSrc.match(/async\s+streamChat\s*\([^)]*\)\s*\{[\s\S]+?^  \}/m);
    assert(streamMatch, 'streamChat method must be findable');
    const streamBody = streamMatch[0];
    // Direct success-path record + delegation to _handleFailoverError
    assert(/_recordMetaOutcome\([^)]*true[^)]*calledModel\)/.test(streamBody),
      'streamChat success path must record outcome with calledModel');
    assert(/_handleFailoverError\(/.test(streamBody),
      'streamChat must delegate failure handling to _handleFailoverError');
    // startTime must be captured
    assert(/const\s+startTime\s*=\s*Date\.now\(\)/.test(streamBody),
      'streamChat must capture startTime for latency measurement');
  });

  // ──────────────────────────────────────────────────────────────
  // Component F — LinuxSandboxHelper isAvailable contract (Item 6)
  //
  // Pre-v7.5.6 isAvailable() returned true on user-NS-only systems,
  // but wrapCommand() would still passthrough (user-NS isn't in any
  // of the four namespace flags it consumes). Callers who treated
  // isAvailable() === true as "isolation will happen" were misled.
  // The fix tightens isAvailable() to require at least one wrappable
  // namespace.
  // ──────────────────────────────────────────────────────────────

  await test('F1 source-presence: isAvailable filters by wrappable namespaces', () => {
    const lshSrc = fs.readFileSync(path.join(__dirname, '../../src/agent/foundation/LinuxSandboxHelper.js'), 'utf8');
    // The new isAvailable must check the four wrappable flags
    assert(/caps\.includes\(['"]pid['"]\)\s*\|\|\s*caps\.includes\(['"]net['"]\)/.test(lshSrc),
      'isAvailable must check pid/net/mount/ipc');
    // Old `return detect().available` should no longer exist as the only line
    const isAvailableMatch = lshSrc.match(/function\s+isAvailable\s*\(\s*\)\s*\{[\s\S]*?\n\}/);
    assert(isAvailableMatch, 'isAvailable function must exist');
    assert(!/^function\s+isAvailable\s*\(\s*\)\s*\{\s*return\s+detect\(\)\.available\s*;\s*\}\s*$/.test(isAvailableMatch[0]),
      'isAvailable must not be the old one-liner');
  });

  await test('F2 behavior: isAvailable agrees with wrapCommand outcome', () => {
    // Reset cache so we read the real platform state.
    const lsh = require('../../src/agent/foundation/LinuxSandboxHelper');
    lsh._resetCache();
    const available = lsh.isAvailable();
    const wrapped = lsh.wrapCommand('node', ['x.js']);
    if (available) {
      // If isAvailable says yes, wrapCommand MUST actually wrap.
      assertEqual(wrapped.isolated, true,
        'isAvailable=true must imply wrapCommand isolates');
    } else {
      // If isAvailable says no, passthrough is the contract.
      assertEqual(wrapped.isolated, false,
        'isAvailable=false must imply passthrough');
    }
  });

  // ──────────────────────────────────────────────────────────────
  // Summary
  // ──────────────────────────────────────────────────────────────
  console.log(`\n  v756-fix: ${passed} passed, ${failed} failed`);
  if (failed > 0) {
    console.log('  Failures:');
    failures.forEach(f => console.log(`    - ${f.name}: ${f.error}`));
    process.exit(1);
  }
})();
