// ============================================================
// GENESIS — test/modules/v783-coststream-failover-field.test.js (v7.8.3)
//
// Verifies the v7.8.3 failover-dimension addition:
//   - `llm:call-complete` payload includes `failover` field
//   - `cost:recorded` event payload includes `failover` field
//   - Default value is 'none' for original-backend calls
//   - When ModelBridge._handleFailoverError dispatches a retry,
//     options._failoverReason is stamped with the classified reason,
//     which then propagates through to the emitted row
// ============================================================

'use strict';

const assert = require('assert');

let passed = 0, failed = 0;
const failures = [];

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`    ✅ ${name}`);
  } catch (err) {
    failed++;
    failures.push({ name, error: err.message });
    console.log(`    ❌ ${name}: ${err.message}`);
  }
}

const schemas = require('../../src/agent/core/EventPayloadSchemas');

// ── Schema additions ─────────────────────────────────────

test('llm:call-complete schema declares failover (optional)', () => {
  const s = schemas.SCHEMAS['llm:call-complete'];
  assert.ok(s, 'llm:call-complete schema must exist');
  assert.strictEqual(s.failover, 'optional');
});

test('cost:recorded schema declares failover (optional)', () => {
  const s = schemas.SCHEMAS['cost:recorded'];
  assert.ok(s, 'cost:recorded schema must exist');
  assert.strictEqual(s.failover, 'optional');
});

// ── CostStream row construction ─────────────────────────

const { CostStream } = require('../../src/agent/foundation/CostStream');

function makeBus() {
  const subscribers = new Map();
  const fired = [];
  return {
    on: (event, handler) => {
      if (!subscribers.has(event)) subscribers.set(event, []);
      subscribers.get(event).push(handler);
      return () => {};
    },
    fire: (event, data) => {
      fired.push({ event, data });
      const hs = subscribers.get(event) || [];
      for (const h of hs) h(data);
    },
    fired,
  };
}

function makeCostStream() {
  const bus = makeBus();
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'v783-cost-'));
  const stream = new CostStream({
    bus,
    storage: { ensureDir: (d) => fs.mkdirSync(d, { recursive: true }) },
    genesisDir: tmp,
    intervals: null,
  });
  return { stream, bus, tmp };
}

test('CostStream row defaults failover to "none" when omitted', () => {
  const { stream, bus } = makeCostStream();
  stream._onCallComplete({
    taskType: 'chat',
    model: 'qwen2.5:7b',
    backend: 'ollama',
    promptTokens: 100,
    responseTokens: 50,
    latencyMs: 200,
    cached: false,
  });
  // Find the cost:recorded fire
  const cost = bus.fired.find(f => f.event === 'cost:recorded');
  assert.ok(cost, 'cost:recorded must be emitted');
  assert.strictEqual(cost.data.failover, 'none',
    'missing failover must default to "none"');
});

test('CostStream row preserves explicit failover reason', () => {
  const { stream, bus } = makeCostStream();
  stream._onCallComplete({
    taskType: 'chat',
    model: 'qwen2.5:7b-cloud',
    backend: 'ollama',
    promptTokens: 80,
    responseTokens: 30,
    latencyMs: 150,
    cached: false,
    failover: 'quota-exhausted',
  });
  const cost = bus.fired.find(f => f.event === 'cost:recorded');
  assert.strictEqual(cost.data.failover, 'quota-exhausted');
});

test('CostStream row preserves rate-limit failover reason', () => {
  const { stream, bus } = makeCostStream();
  stream._onCallComplete({
    taskType: 'reasoning',
    model: 'gpt-4o',
    backend: 'openai',
    promptTokens: 200,
    responseTokens: 100,
    latencyMs: 800,
    cached: false,
    failover: 'rate-limit',
  });
  const cost = bus.fired.find(f => f.event === 'cost:recorded');
  assert.strictEqual(cost.data.failover, 'rate-limit');
});

// ── ModelBridge integration: options._failoverReason stamped on failover-retry ──

const { ModelBridge } = require('../../src/agent/foundation/ModelBridge');

test('ModelBridge._handleFailoverError stamps options._failoverReason with the classified reason', async () => {
  const bus = makeBus();
  const bridge = new ModelBridge({ bus, settings: { get: () => null } });
  // Stub fallback dispatch
  bridge._findFallbackBackend = () => 'ollama';
  bridge._fallbackModel = { name: 'qwen2.5:7b' };
  bridge.markUnavailable = () => {};
  bridge._recordMetaOutcome = () => {};
  const opts = { someKey: 'value' };
  await bridge._handleFailoverError(
    new Error('Weekly quota exhausted on this account'),
    {
      taskType: 'chat',
      temp: 0.7,
      startTime: Date.now(),
      options: opts,
      calledModel: 'qwen2.5:7b-cloud',
      targetBackend: 'ollama-cloud',
      dispatch: async () => 'ok',
      label: 'chat',
    }
  );
  assert.strictEqual(opts._failoverReason, 'quota-exhausted',
    'options must be mutated to carry the classified reason');
});

test('ModelBridge._handleFailoverError uses "rate-limit" for transient rate-limits', async () => {
  const bus = makeBus();
  const bridge = new ModelBridge({ bus, settings: { get: () => null } });
  bridge._findFallbackBackend = () => 'ollama';
  bridge._fallbackModel = { name: 'qwen2.5:7b' };
  bridge.markUnavailable = () => {};
  bridge._recordMetaOutcome = () => {};
  const opts = {};
  await bridge._handleFailoverError(
    new Error('Rate limit exceeded, reset in 60 seconds'),
    {
      taskType: 'chat',
      temp: 0.7,
      startTime: Date.now(),
      options: opts,
      calledModel: 'qwen2.5:7b-cloud',
      targetBackend: 'ollama-cloud',
      dispatch: async () => 'ok',
      label: 'chat',
    }
  );
  assert.strictEqual(opts._failoverReason, 'rate-limit');
});

// ── summary ───────────────────────────────────────────────

(async () => {
  await new Promise((r) => setTimeout(r, 50));
  if (failed > 0) {
    console.log(`\n  ${failed} failure(s):`);
    for (const f of failures) console.log(`    - ${f.name}: ${f.error}`);
    process.exit(1);
  }
  console.log(`    ${passed} passed`);
})();
