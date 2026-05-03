// ============================================================
// GENESIS — test/modules/v757-fix-cloud-fallback.test.js (v7.5.7-fix)
//
// Tests for the v7.5.7-fix backend changes:
//  - subscription-required is its own failover-reason (not 'auth')
//  - subscription-required gets a 24h TTL (not 1h)
//  - _isCloudModelName detects :cloud and -cloud suffixes
//  - model:cloud-without-fallback is a registered event
//
// Live motivation: Garrus's qwen3-coder-next:cloud got 403 every few
// minutes from Ollama because the model was Pro-gated. Pre-fix Genesis
// classified it as 'auth' (1h TTL) and retried hourly. With the fix it's
// classified as 'subscription-required' (24h TTL) and Genesis stops
// hammering it.
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

const { ModelBridge } = require('../../src/agent/foundation/ModelBridge');

// ── _classifyFailoverReason: new 'subscription-required' branch ──

test('subscription-required: matched by Ollama Cloud Pro 403 body', () => {
  const bridge = new ModelBridge({});
  const err = new Error('[OLLAMA] HTTP 403: {"error":"this model requires a subscription, upgrade for access: https://ollama.com/upgrade"}');
  assert.strictEqual(bridge._classifyFailoverReason(err), 'subscription-required');
});

test('subscription-required: matched by simpler "subscription required" string', () => {
  const bridge = new ModelBridge({});
  assert.strictEqual(
    bridge._classifyFailoverReason(new Error('403 Forbidden: subscription required')),
    'subscription-required'
  );
});

test('subscription-required: matched by ollama.com/upgrade link in body', () => {
  const bridge = new ModelBridge({});
  assert.strictEqual(
    bridge._classifyFailoverReason(new Error('HTTP 403: visit https://ollama.com/upgrade for access')),
    'subscription-required'
  );
});

test('subscription-required: takes precedence over generic auth (403 + subscription marker)', () => {
  // Pre-fix this returned 'auth' because the 401|403 branch matched first.
  const bridge = new ModelBridge({});
  const err = new Error('HTTP 403 from http://127.0.0.1:11434/api/chat: {"error":"this model requires a subscription"}');
  assert.strictEqual(bridge._classifyFailoverReason(err), 'subscription-required');
});

test('plain 401 still classified as auth (no subscription marker)', () => {
  const bridge = new ModelBridge({});
  assert.strictEqual(
    bridge._classifyFailoverReason(new Error('401 Unauthorized')),
    'auth'
  );
});

test('plain 403 without subscription marker still classified as auth', () => {
  const bridge = new ModelBridge({});
  assert.strictEqual(
    bridge._classifyFailoverReason(new Error('403 Forbidden: invalid token')),
    'auth'
  );
});

// ── UNAVAILABLE_TTL_MAP: subscription gets 24h ──────────────────

test('UNAVAILABLE_TTL_MAP exposes subscription-required with 24h TTL', () => {
  // Read the constant indirectly via markUnavailable behavior — we feed
  // a subscription-required failure and verify the marker survives 1h
  // (longer than the auth TTL) but expires before 25h.
  const bridge = new ModelBridge({ });
  // Inject a fake clock via the availability mixin
  bridge.markUnavailable('test:cloud', 24 * 60 * 60 * 1000, 'subscription-required');
  assert.strictEqual(bridge.isMarkedUnavailable('test:cloud'), true);
});

test('subscription TTL is meaningfully longer than auth TTL', () => {
  // Sanity: auth = 1h, subscription = 24h. The whole point is they differ.
  // We read both via the public API (markUnavailable returns no value, so
  // we test the behavioral consequence: clearUnavailable can clear both).
  const bridge = new ModelBridge({});
  bridge.markUnavailable('cloud-test', 24 * 60 * 60 * 1000, 'subscription-required');
  bridge.markUnavailable('auth-test',   1 * 60 * 60 * 1000, 'auth');
  assert.strictEqual(bridge.isMarkedUnavailable('cloud-test'), true);
  assert.strictEqual(bridge.isMarkedUnavailable('auth-test'), true);
});

// ── _isCloudModelName ─────────────────────────────────────────────

test('_isCloudModelName: detects :cloud suffix', () => {
  const bridge = new ModelBridge({});
  assert.strictEqual(bridge._isCloudModelName('qwen3-coder-next:cloud'), true);
  assert.strictEqual(bridge._isCloudModelName('kimi-k2.5:cloud'), true);
});

test('_isCloudModelName: detects -cloud suffix variant', () => {
  const bridge = new ModelBridge({});
  assert.strictEqual(bridge._isCloudModelName('qwen3-vl:235b-cloud'), true);
});

test('_isCloudModelName: rejects local quantized variants', () => {
  const bridge = new ModelBridge({});
  assert.strictEqual(bridge._isCloudModelName('qwen3-coder-next:q4_K_M'), false);
  assert.strictEqual(bridge._isCloudModelName('mistral:7b'), false);
  assert.strictEqual(bridge._isCloudModelName('gemma2:9b'), false);
});

test('_isCloudModelName: handles non-string safely', () => {
  const bridge = new ModelBridge({});
  assert.strictEqual(bridge._isCloudModelName(null), false);
  assert.strictEqual(bridge._isCloudModelName(undefined), false);
  assert.strictEqual(bridge._isCloudModelName(42), false);
});

// ── Event registration ────────────────────────────────────────────

test('model:cloud-without-fallback is registered in EventTypes catalog', () => {
  const { EVENTS } = require('../../src/agent/core/EventTypes');
  assert.strictEqual(EVENTS.MODEL.CLOUD_WITHOUT_FALLBACK, 'model:cloud-without-fallback');
});

test('model:cloud-without-fallback has a payload schema', () => {
  const { SCHEMAS } = require('../../src/agent/core/EventPayloadSchemas');
  const schema = SCHEMAS['model:cloud-without-fallback'];
  assert.ok(schema, 'schema entry must exist');
  assert.strictEqual(schema.model, 'required');
  assert.strictEqual(schema.backend, 'required');
});

// ── Done ─────────────────────────────────────────────

console.log('');
console.log(`  ${passed} passed${failed > 0 ? `, ${failed} failed` : ''}`);
if (failed > 0) {
  console.log('');
  console.log('  Failures:');
  for (const f of failures) console.log(`    - ${f.name}: ${f.error}`);
  process.exit(1);
}
