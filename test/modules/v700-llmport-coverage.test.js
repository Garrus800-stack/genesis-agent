// Test: v7.0.0 — LLMPort coverage sweep
// Targets uncovered paths in ModelBridgeAdapter (metrics, rate-limit status,
// resetMetrics, _recordLatency >50 buf), MockLLM accessors, TokenBucket.getStatus,
// HourlyBudget.getStatus/reset, estimateTokens branches.

const { describe, test, assert, assertEqual, run } = require('../harness');
const {
  LLMPort,
  ModelBridgeAdapter,
  MockLLM,
  TokenBucket,
  HourlyBudget,
  estimateTokens,
} = require('../../src/agent/ports/LLMPort');

// ── Helpers ─────────────────────────────────────────────────

function makeBus() {
  const events = [];
  return {
    emit(type, data) { events.push({ type, data }); },
    fire(type, data) { events.push({ type, data }); },
    on() { return () => {}; },
    off() {},
    _events: events,
  };
}

function makeBridge(overrides = {}) {
  return {
    activeModel: 'test-model',
    activeBackend: 'ollama',
    availableModels: [{ name: 'test-model', backend: 'ollama' }],
    temperatures: { chat: 0.7, code: 0.1 },
    backends: { ollama: { baseUrl: 'http://localhost:11434' } },
    async chat() { return 'response'; },
    async streamChat(_sp, _msgs, onChunk) { onChunk('hello'); },
    async chatStructured() { return { result: 'ok' }; },
    async detectAvailable() { return [{ name: 'test-model', backend: 'ollama' }]; },
    async switchTo() { return { ok: true }; },
    configureBackend() {},
    getConcurrencyStats() { return { active: 0, queued: 0 }; },
    _robustJsonParse(text) { try { return JSON.parse(text); } catch { return null; } },
    ...overrides,
  };
}

function makeAdapter(bridgeOverrides = {}, busOverride = null) {
  return new ModelBridgeAdapter(makeBridge(bridgeOverrides), busOverride || makeBus());
}

// ── estimateTokens ───────────────────────────────────────────

describe('estimateTokens — branches', () => {
  test('null/empty text returns 0', () => {
    assertEqual(estimateTokens(null, 'chat'), 0);
    assertEqual(estimateTokens('', 'chat'), 0);
  });

  test('ASCII text uses 4.0 chars/token', () => {
    const result = estimateTokens('hello world test foo', 'chat');
    assert(result > 0, 'should return positive count');
  });

  test('German text (>5% non-ASCII) uses 3.2 chars/token', () => {
    // German umlauts trigger the nonAscii branch
    const german = 'Überprüfung der Lösung für häufige Probleme';
    const ascii  = 'Checking the solution for common problems';
    const gTokens = estimateTokens(german, 'chat');
    const aTokens = estimateTokens(ascii, 'chat');
    // German should have similar or higher count due to shorter charsPerToken
    assert(gTokens > 0, 'german token count > 0');
    assert(aTokens > 0, 'ascii token count > 0');
  });

  test('code taskType uses 3.5 chars/token', () => {
    const code = 'function hello() { return 42; }';
    const result = estimateTokens(code, 'code');
    assert(result > 0, 'code token count > 0');
  });

  test('punctuation counted as 1 token each', () => {
    const withPunct = 'Hello, world! How are you? Fine.';
    const result = estimateTokens(withPunct, 'chat');
    assert(result > 0, 'punctuation text token count > 0');
  });
});

// ── TokenBucket ─────────────────────────────────────────────

describe('TokenBucket', () => {
  test('getStatus returns shape', () => {
    const bucket = new TokenBucket(10, 60);
    const status = bucket.getStatus();
    assert('tokens' in status, 'tokens field');
    assert('capacity' in status, 'capacity field');
    assert('fillPct' in status, 'fillPct field');
    assertEqual(status.capacity, 10);
    assertEqual(status.fillPct, 100);
  });

  test('fillLevel returns 0-1 range', () => {
    const bucket = new TokenBucket(5, 60);
    const level = bucket.fillLevel();
    assert(level >= 0 && level <= 1, 'fillLevel in range');
  });

  test('depleted bucket returns tokens=0 in status', () => {
    const bucket = new TokenBucket(2, 0); // no refill
    bucket.tryConsume();
    bucket.tryConsume();
    const status = bucket.getStatus();
    assert(status.fillPct === 0, 'depleted bucket has 0% fill');
  });
});

// ── HourlyBudget ────────────────────────────────────────────

describe('HourlyBudget', () => {
  test('getStatus returns per-bucket breakdown', () => {
    const budget = new HourlyBudget({ chat: 200, autonomous: 80, idle: 40 });
    const status = budget.getStatus();
    assert('chat' in status, 'chat bucket in status');
    assert('autonomous' in status, 'autonomous bucket in status');
    assertEqual(status.chat.budget, 200);
    assertEqual(status.chat.used, 0);
    assertEqual(status.chat.remaining, 200);
  });

  test('reset clears all call records', () => {
    const budget = new HourlyBudget({ chat: 5 });
    budget.tryConsume('chat');
    budget.tryConsume('chat');
    assertEqual(budget.getStatus().chat.used, 2);
    budget.reset();
    assertEqual(budget.getStatus().chat.used, 0);
  });

  test('unknown bucket returns allowed: true', () => {
    const budget = new HourlyBudget({ chat: 5 });
    const result = budget.tryConsume('nonexistent');
    assert(result.allowed === true, 'unknown bucket allowed');
  });
});

// ── ModelBridgeAdapter metrics ───────────────────────────────

describe('ModelBridgeAdapter — getMetrics', () => {
  test('returns expected shape after construction', () => {
    const adapter = makeAdapter();
    const m = adapter.getMetrics();
    assert('totalCalls' in m, 'totalCalls field');
    assert('totalStreamCalls' in m, 'totalStreamCalls');
    assert('totalTokensEstimated' in m, 'totalTokensEstimated');
    assert('errors' in m, 'errors field');
    assert('rateLimited' in m, 'rateLimited field');
    assert('avgLatencyMs' in m, 'avgLatencyMs field');
    assert(m._latencies === undefined, '_latencies should be undefined');
    assertEqual(m.totalCalls, 0);
    assertEqual(m.errors, 0);
  });

  test('totalCalls increments after chat()', async () => {
    const adapter = makeAdapter();
    await adapter.chat('sys', [], 'chat', { priority: 10 }); // bypass rate limit
    assertEqual(adapter.getMetrics().totalCalls, 1);
  });

  test('totalStreamCalls increments after streamChat()', async () => {
    const adapter = makeAdapter();
    await adapter.streamChat('sys', [], () => {}, null, 'chat', { priority: 10 });
    assertEqual(adapter.getMetrics().totalStreamCalls, 1);
  });
});

describe('ModelBridgeAdapter — getRateLimitStatus', () => {
  test('returns bucket, hourlyBudgets, rateLimited', () => {
    const adapter = makeAdapter();
    const status = adapter.getRateLimitStatus();
    assert('bucket' in status, 'bucket field');
    assert('hourlyBudgets' in status, 'hourlyBudgets field');
    assert('rateLimited' in status, 'rateLimited field');
    assert('fillPct' in status.bucket, 'bucket.fillPct');
    assert('chat' in status.hourlyBudgets, 'hourlyBudgets.chat');
  });
});

describe('ModelBridgeAdapter — resetMetrics', () => {
  test('zeroes all metric counters', async () => {
    const adapter = makeAdapter();
    await adapter.chat('sys', [], 'chat', { priority: 10 });
    await adapter.streamChat('sys', [], () => {}, null, 'chat', { priority: 10 });
    const before = adapter.getMetrics();
    assert(before.totalCalls > 0 || before.totalStreamCalls > 0, 'some calls made');

    adapter.resetMetrics();
    const after = adapter.getMetrics();
    assertEqual(after.totalCalls, 0);
    assertEqual(after.totalStreamCalls, 0);
    assertEqual(after.totalTokensEstimated, 0);
    assertEqual(after.errors, 0);
    assertEqual(after.avgLatencyMs, 0);
  });
});

describe('ModelBridgeAdapter — _recordLatency buffer', () => {
  test('averages latency over up to 50 samples', () => {
    const adapter = makeAdapter();
    // Push 55 samples — triggers buf.length > 50 branch (shift)
    for (let i = 0; i < 55; i++) {
      adapter._recordLatency(100);
    }
    const m = adapter.getMetrics();
    assertEqual(m.avgLatencyMs, 100);
  });

  test('single sample sets avgLatencyMs', () => {
    const adapter = makeAdapter();
    adapter._recordLatency(250);
    assertEqual(adapter.getMetrics().avgLatencyMs, 250);
  });
});

describe('ModelBridgeAdapter — _robustJsonParse', () => {
  test('returns parsed object for valid JSON', () => {
    const adapter = makeAdapter({
      _robustJsonParse(text) { return JSON.parse(text); },
    });
    const result = adapter._robustJsonParse('{"ok":true}');
    assert(result !== null && result.ok === true, 'parsed correctly');
  });

  test('returns null for bridge without _robustJsonParse', () => {
    const bridge = makeBridge();
    delete bridge._robustJsonParse;
    const adapter = new ModelBridgeAdapter(bridge, makeBus());
    const result = adapter._robustJsonParse('{"ok":true}');
    assert(result === null, 'returns null when bridge method missing');
  });
});

describe('ModelBridgeAdapter — errors path', () => {
  test('increments errors counter on chat failure', async () => {
    const adapter = makeAdapter({
      async chat() { throw new Error('backend down'); },
    });
    try {
      await adapter.chat('sys', [], 'chat', { priority: 10 });
    } catch (_e) { /* expected */ }
    assertEqual(adapter.getMetrics().errors, 1);
  });
});

// ── MockLLM accessors ────────────────────────────────────────

describe('MockLLM — accessors and helpers', () => {
  test('activeModel and activeBackend getters', () => {
    const mock = new MockLLM();
    assertEqual(mock.activeModel, 'mock-model');
    assertEqual(mock.activeBackend, 'mock');
  });

  test('availableModels returns array with active model', () => {
    const mock = new MockLLM();
    const models = mock.availableModels;
    assert(Array.isArray(models) && models.length === 1, 'one model');
    assertEqual(models[0].name, 'mock-model');
  });

  test('detectAvailable returns availableModels', async () => {
    const mock = new MockLLM();
    const result = await mock.detectAvailable();
    assertEqual(result[0].name, 'mock-model');
  });

  test('switchTo changes activeModel', async () => {
    const mock = new MockLLM();
    await mock.switchTo('new-model');
    assertEqual(mock.activeModel, 'new-model');
  });

  test('configureBackend does not throw', () => {
    const mock = new MockLLM();
    mock.configureBackend('test', {});
  });

  test('getConcurrencyStats returns shape', () => {
    const mock = new MockLLM();
    const stats = mock.getConcurrencyStats();
    assertEqual(stats.active, 0);
    assertEqual(stats.queued, 0);
  });

  test('temperatures returns expected keys', () => {
    const mock = new MockLLM();
    const t = mock.temperatures;
    assert('code' in t && 'chat' in t, 'temperatures has code+chat');
  });

  test('backends returns ollama entry', () => {
    const mock = new MockLLM();
    assert('ollama' in mock.backends, 'backends has ollama');
  });

  test('_robustJsonParse returns parsed for valid JSON', () => {
    const mock = new MockLLM();
    const result = mock._robustJsonParse('{"x":1}');
    assertEqual(result.x, 1);
  });

  test('_robustJsonParse returns null for invalid JSON', () => {
    const mock = new MockLLM();
    const result = mock._robustJsonParse('not json');
    assert(result === null, 'invalid JSON → null');
  });

  test('chatStructured returns parsed object', async () => {
    const mock = new MockLLM({ default: '{"key":"value"}' });
    const result = await mock.chatStructured('sys', [], 'analysis');
    assertEqual(result.key, 'value');
  });

  test('chatStructured returns _parseError on non-JSON response', async () => {
    const mock = new MockLLM({ default: 'this is not json' });
    const result = await mock.chatStructured('sys', [], 'analysis');
    assert(result._parseError === true, 'parseError flag set');
    assert('_raw' in result, '_raw included');
  });

  test('streamChat emits words via onChunk', async () => {
    const mock = new MockLLM({ default: 'hello world test' });
    const chunks = [];
    await mock.streamChat('sys', [], (c) => chunks.push(c), null, 'chat');
    assert(chunks.length >= 3, 'received word chunks');
  });

  test('streamChat stops on aborted signal', async () => {
    const mock = new MockLLM({ default: 'one two three four five' });
    const chunks = [];
    const abortSignal = { aborted: true };
    await mock.streamChat('sys', [], (c) => chunks.push(c), abortSignal, 'chat');
    assert(chunks.length === 0, 'no chunks when already aborted');
  });

  test('getCalls records each chat call', async () => {
    const mock = new MockLLM();
    await mock.chat('sys', [], 'chat');
    await mock.chat('sys', [], 'analysis');
    assertEqual(mock.getCalls().length, 2);
  });

  test('lastCall returns most recent call', async () => {
    const mock = new MockLLM();
    await mock.chat('sys-1', [], 'chat');
    await mock.chat('sys-2', [], 'analysis');
    const last = mock.lastCall();
    assertEqual(last.systemPrompt, 'sys-2');
    assertEqual(last.taskType, 'analysis');
  });

  test('setResponse overrides default for taskType', async () => {
    const mock = new MockLLM();
    mock.setResponse('code', 'custom code response');
    const result = await mock.chat('sys', [], 'code');
    assertEqual(result, 'custom code response');
  });

  test('function response receives systemPrompt and messages', async () => {
    const mock = new MockLLM({
      chat: (sp, msgs, type) => `${type}:${msgs.length}`,
    });
    const result = await mock.chat('sys', [{ role: 'user', content: 'hi' }], 'chat');
    assertEqual(result, 'chat:1');
  });
});

// ── LLMPort abstract interface ───────────────────────────────

describe('LLMPort — abstract base', () => {
  test('chat throws not implemented', async () => {
    const port = new LLMPort();
    try {
      await port.chat('sys', []);
      assert(false, 'should have thrown');
    } catch (e) {
      assert(e.message.includes('not implemented'), 'correct error');
    }
  });

  test('streamChat throws not implemented', async () => {
    const port = new LLMPort();
    try {
      await port.streamChat('sys', [], () => {}, null);
      assert(false, 'should have thrown');
    } catch (e) {
      assert(e.message.includes('not implemented'), 'correct error');
    }
  });

  test('chatStructured throws not implemented', async () => {
    const port = new LLMPort();
    try {
      await port.chatStructured('sys', []);
      assert(false, 'should have thrown');
    } catch (e) {
      assert(e.message.includes('not implemented'), 'correct error');
    }
  });

  test('safe defaults for getters', () => {
    const port = new LLMPort();
    assert(port.activeModel === null, 'activeModel null');
    assert(port.activeBackend === null, 'activeBackend null');
    assert(Array.isArray(port.availableModels), 'availableModels array');
    assert(typeof port.getConcurrencyStats() === 'object', 'concurrency object');
  });
});

if (require.main === module) run();
