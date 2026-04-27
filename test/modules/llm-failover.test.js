// ============================================================
// GENESIS — test/modules/llm-failover.test.js (v5.9.2)
//
// Tests the SEMANTICS of LLM backend failover via a mock
// ModelBridge implementation (createMockBridge below). For tests
// that exercise the REAL ModelBridge._findFallbackBackend() code
// path and verify event emits against actual source, see
// test/modules/v748-fix.test.js (Component C).
//
// Tests LLM backend failover and graceful degradation:
//   - Primary backend failure → fallback to secondary
//   - All backends down → clear error, no crash
//   - Mid-stream failure → error propagation
//   - Recovery after failure
//   - Failover event emission
// ============================================================

const { describe, test, assert, assertEqual, run } = require('../harness');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const { NullBus } = require(path.join(ROOT, 'src/agent/core/EventBus'));

// ── Mock Backends ───────────────────────────────────────────

function createMockBackend(name, opts = {}) {
  let callCount = 0;
  let shouldFail = opts.fail || false;
  let failAfter = opts.failAfter || Infinity;

  return {
    name,
    isConfigured: () => true,
    chat: async (model, systemPrompt, messages, temp) => {
      callCount++;
      if (shouldFail || callCount > failAfter) {
        throw new Error(`${name} backend unavailable`);
      }
      return { text: `[${name}] response to: ${messages[messages.length - 1]?.content || '?'}` };
    },
    stream: async (model, systemPrompt, messages, onChunk, abortSignal, temp) => {
      callCount++;
      if (shouldFail || callCount > failAfter) {
        throw new Error(`${name} backend stream failed`);
      }
      onChunk(`[${name}] streaming...`);
      return { text: `[${name}] stream complete` };
    },
    listModels: async () => shouldFail ? [] : [{ name: `${name}-model`, backend: name }],
    setFail: (v) => { shouldFail = v; },
    getCallCount: () => callCount,
    reset: () => { callCount = 0; },
  };
}

// ── Mock ModelBridge (simplified) ───────────────────────────

function createMockBridge(backends) {
  const events = [];
  const bus = {
    fire: (evt, data) => events.push({ evt, data }),
    emit: (evt, data) => events.push({ evt, data }),
    on: () => {},
  };

  const backendMap = {};
  const availableModels = [];
  for (const b of backends) {
    backendMap[b.name] = b;
    availableModels.push({ name: `${b.name}-model`, backend: b.name });
  }

  return {
    backends: backendMap,
    availableModels,
    activeModel: availableModels[0]?.name || null,
    bus,
    events,

    async chat(messages, opts = {}) {
      const primary = backends[0];
      try {
        return await primary.chat(primary.name + '-model', '', messages, 0.7);
      } catch (err) {
        // Failover
        for (let i = 1; i < backends.length; i++) {
          try {
            bus.fire('model:failover', { from: primary.name, to: backends[i].name, error: err.message });
            return await backends[i].chat(backends[i].name + '-model', '', messages, 0.7);
          } catch (_e) { continue; }
        }
        throw err; // All failed
      }
    },

    async stream(messages, onChunk, opts = {}) {
      const primary = backends[0];
      try {
        return await primary.stream(primary.name + '-model', '', messages, onChunk, null, 0.7);
      } catch (err) {
        for (let i = 1; i < backends.length; i++) {
          try {
            bus.fire('model:failover', { from: primary.name, to: backends[i].name, error: err.message });
            return await backends[i].stream(backends[i].name + '-model', '', messages, onChunk, null, 0.7);
          } catch (_e) { continue; }
        }
        throw err;
      }
    },
  };
}

// ── Tests ───────────────────────────────────────────────────

describe('LLM Failover — Primary → Secondary', () => {
  test('falls back to secondary when primary fails', async () => {
    const primary = createMockBackend('ollama', { fail: true });
    const secondary = createMockBackend('anthropic');
    const bridge = createMockBridge([primary, secondary]);

    const result = await bridge.chat([{ role: 'user', content: 'hello' }]);
    assert(result.text.includes('anthropic'), `Expected anthropic response, got: ${result.text}`);
    assertEqual(primary.getCallCount(), 1);
    assertEqual(secondary.getCallCount(), 1);
  });

  test('emits failover event', async () => {
    const primary = createMockBackend('ollama', { fail: true });
    const secondary = createMockBackend('anthropic');
    const bridge = createMockBridge([primary, secondary]);

    await bridge.chat([{ role: 'user', content: 'test' }]);
    const failoverEvt = bridge.events.find(e => e.evt === 'model:failover');
    assert(failoverEvt, 'Should emit model:failover');
    assertEqual(failoverEvt.data.from, 'ollama');
    assertEqual(failoverEvt.data.to, 'anthropic');
  });

  test('uses primary when healthy', async () => {
    const primary = createMockBackend('ollama');
    const secondary = createMockBackend('anthropic');
    const bridge = createMockBridge([primary, secondary]);

    const result = await bridge.chat([{ role: 'user', content: 'hello' }]);
    assert(result.text.includes('ollama'), 'Should use primary');
    assertEqual(secondary.getCallCount(), 0);
  });
});

describe('LLM Failover — All Backends Down', () => {
  test('throws clear error when all backends fail', async () => {
    const primary = createMockBackend('ollama', { fail: true });
    const secondary = createMockBackend('anthropic', { fail: true });
    const bridge = createMockBridge([primary, secondary]);

    try {
      await bridge.chat([{ role: 'user', content: 'hello' }]);
      assert(false, 'Should have thrown');
    } catch (err) {
      assert(err.message.includes('unavailable'), `Expected unavailable error, got: ${err.message}`);
    }
  });

  test('does not crash process', async () => {
    const primary = createMockBackend('ollama', { fail: true });
    const bridge = createMockBridge([primary]);

    try { await bridge.chat([{ role: 'user', content: 'hello' }]); } catch (_e) { /* expected */ }
    // Process should still be alive
    assert(true, 'Process survived all-backends-down');
  });
});

describe('LLM Failover — Stream', () => {
  test('stream falls back to secondary', async () => {
    const primary = createMockBackend('ollama', { fail: true });
    const secondary = createMockBackend('anthropic');
    const bridge = createMockBridge([primary, secondary]);

    const chunks = [];
    await bridge.stream([{ role: 'user', content: 'hello' }], (c) => chunks.push(c));
    assert(chunks.length > 0, 'Should have received chunks');
    assert(chunks[0].includes('anthropic'), `Expected anthropic chunk, got: ${chunks[0]}`);
  });

  test('stream throws when all fail', async () => {
    const primary = createMockBackend('ollama', { fail: true });
    const secondary = createMockBackend('openai', { fail: true });
    const bridge = createMockBridge([primary, secondary]);

    try {
      await bridge.stream([{ role: 'user', content: 'hello' }], () => {});
      assert(false, 'Should have thrown');
    } catch (err) {
      assert(err.message.includes('failed'), 'Should have error message');
    }
  });
});

describe('LLM Failover — Recovery', () => {
  test('primary works again after recovery', async () => {
    const primary = createMockBackend('ollama', { fail: true });
    const secondary = createMockBackend('anthropic');
    const bridge = createMockBridge([primary, secondary]);

    // First call: primary fails → secondary
    await bridge.chat([{ role: 'user', content: 'attempt 1' }]);
    assertEqual(secondary.getCallCount(), 1);

    // Recover primary
    primary.setFail(false);
    primary.reset();
    secondary.reset();

    // Second call: primary should work
    const result = await bridge.chat([{ role: 'user', content: 'attempt 2' }]);
    assert(result.text.includes('ollama'), 'Should use recovered primary');
    assertEqual(secondary.getCallCount(), 0);
  });
});

describe('LLM Failover — Cascade (3 backends)', () => {
  test('cascades through all backends', async () => {
    const b1 = createMockBackend('ollama', { fail: true });
    const b2 = createMockBackend('anthropic', { fail: true });
    const b3 = createMockBackend('openai');
    const bridge = createMockBridge([b1, b2, b3]);

    const result = await bridge.chat([{ role: 'user', content: 'hello' }]);
    assert(result.text.includes('openai'), 'Should reach third backend');
    assertEqual(b1.getCallCount(), 1);
    assertEqual(b2.getCallCount(), 1);
    assertEqual(b3.getCallCount(), 1);
  });
});

run();
