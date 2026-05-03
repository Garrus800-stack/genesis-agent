// ============================================================
// GENESIS — test/modules/v752-fix.test.js
//
// Regression tests for v7.5.2: Auto-Routing.
//
// Coverage:
//   A — Setting & Defaults                       (5 tests)
//   B — Routing-Aktivität + Backend-Resolution   (8 tests)
//   C — User-Chat-Schutz                         (5 tests)
//   D — TaskType-Aliase                          (4 tests)
//   E — Parallelität & Robustheit                (4 tests)
//   F — EmotionalSteering-Interaktion            (1 test)
//   G — Public API                               (4 tests)
// ============================================================

'use strict';

const { describe, test, assert, assertEqual, run } = require('../harness');
const path = require('path');
const fs = require('fs');
const os = require('os');

const ROOT = path.resolve(__dirname, '..', '..');
const { ModelBridge } = require(path.join(ROOT, 'src/agent/foundation/ModelBridge'));
const { Settings } = require(path.join(ROOT, 'src/agent/foundation/Settings'));

// ── Mock-Helpers ───────────────────────────────────────────

function makeBus() {
  const events = [];
  return {
    events,
    emit: (evt, data, meta) => events.push({ evt, data, meta }),
    fire: (evt, data, meta) => events.push({ evt, data, meta }),
    on:   () => {},
  };
}

function makeMockBackend(name, opts = {}) {
  return {
    name,
    isConfigured: () => true,
    latencyMs: opts.latencyMs || 0,
    callsLog: [],
    async chat(systemPrompt, messages, temperature, modelName, maxTokens) {
      this.callsLog.push({ modelName, taskType: 'inferred-from-context' });
      if (this.latencyMs) await new Promise(r => setTimeout(r, this.latencyMs));
      if (opts.fail) throw new Error(`${name} backend down`);
      return { text: `[${name}/${modelName}] ok` };
    },
    async stream(systemPrompt, messages, onChunk, abortSignal, temp, modelName, maxTokens) {
      this.callsLog.push({ modelName, taskType: 'stream' });
      if (this.latencyMs) await new Promise(r => setTimeout(r, this.latencyMs));
      if (opts.fail) throw new Error(`${name} stream down`);
      onChunk(`[${name}/${modelName}]`);
      return { text: 'done' };
    },
    async listModels() { return opts.models || [{ name: `${name}-default`, backend: name }]; },
  };
}

function makeMockRouter(opts = {}) {
  const callsLog = [];
  return {
    callsLog,
    route(taskCategory) {
      callsLog.push(taskCategory);
      if (opts.fail) throw new Error('Router error');
      if (opts.returnsNoModel) return { model: null };
      const m = opts.model || 'routed-model';
      return { model: m, reason: opts.reason || `Best for ${taskCategory}`, score: 0.9 };
    },
  };
}

function makeBridgeWithMocks(opts = {}) {
  const bus = makeBus();
  const bridge = new ModelBridge({ bus });

  // Mock settings
  bridge._settings = {
    get: (key) => {
      if (key === 'agency.autoRouteByTask') {
        return opts.routingEnabled !== undefined ? opts.routingEnabled : true;
      }
      return undefined;
    },
    hasAnthropic: () => false,
    hasOpenAI: () => false,
  };

  // Mock backends
  bridge.backends = {
    ollama: makeMockBackend('ollama', opts.ollamaOpts || {}),
    anthropic: makeMockBackend('anthropic', opts.anthropicOpts || {}),
    openai: makeMockBackend('openai', opts.openaiOpts || {}),
  };

  // Available models — multi-backend setup by default
  bridge.availableModels = opts.availableModels || [
    { name: 'qwen3:8b', backend: 'ollama', size: 8e9, quantization: 'q4', tier: 'standard' },
    { name: 'gemma2:2b', backend: 'ollama', size: 2e9, quantization: 'q4', tier: 'fast' },
    { name: 'claude-opus-4-7', backend: 'anthropic', size: 0, quantization: 'cloud', tier: 'premium' },
  ];
  bridge.activeModel = opts.activeModel || 'qwen3:8b';
  bridge.activeBackend = opts.activeBackend || 'ollama';

  // Mock router (optional)
  if (opts.router !== false) {
    bridge._modelRouter = opts.router || makeMockRouter(opts.routerOpts || {});
  }

  return { bridge, bus };
}

// ════════════════════════════════════════════════════════════
// A — Setting & Defaults
// ════════════════════════════════════════════════════════════

describe('v7.5.2/A · Setting & Defaults', () => {

  test('A1: agency.autoRouteByTask default is false (v7.5.7-fix Phase 2 — was true in v7.5.2; parallel model loads on CPU caused 180s timeouts. Users with GPU re-enable via UI.)', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gen-v752-'));
    const s = new Settings(dir);
    assertEqual(s.get('agency.autoRouteByTask'), false);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('A2: agency.autoRouteByTask can be toggled to false', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gen-v752-'));
    const s = new Settings(dir);
    s.set('agency.autoRouteByTask', false);
    assertEqual(s.get('agency.autoRouteByTask'), false);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('A3: TOGGLE_EVENT_KEYS contains agency.autoRouteByTask', () => {
    const settingsSrc = fs.readFileSync(
      path.join(ROOT, 'src/agent/foundation/Settings.js'), 'utf8');
    assert(/['"]agency\.autoRouteByTask['"]\s*:\s*['"]settings:auto-route-toggled['"]/.test(settingsSrc),
      'TOGGLE_EVENT_KEYS map should include agency.autoRouteByTask');
  });

  test('A4: model:auto-switched schema registered with routedBackend', () => {
    const { SCHEMAS } = require(path.join(ROOT, 'src/agent/core/EventPayloadSchemas'));
    const schema = SCHEMAS['model:auto-switched'];
    assert(schema, 'model:auto-switched schema must exist');
    assertEqual(schema.originalModel, 'required');
    assertEqual(schema.routedModel, 'required');
    assertEqual(schema.routedBackend, 'required');
    assertEqual(schema.taskType, 'required');
  });

  test('A5: settings:auto-route-toggled schema registered', () => {
    const { SCHEMAS } = require(path.join(ROOT, 'src/agent/core/EventPayloadSchemas'));
    const schema = SCHEMAS['settings:auto-route-toggled'];
    assert(schema, 'settings:auto-route-toggled schema must exist');
    assertEqual(schema.from, 'required');
    assertEqual(schema.to, 'required');
    assertEqual(schema.key, 'required');
  });
});

// ════════════════════════════════════════════════════════════
// B — Routing-Aktivität + Backend-Resolution
// ════════════════════════════════════════════════════════════

describe('v7.5.2/B · Routing-Aktivität + Backend-Resolution', () => {

  test('B1: autoRouteByTask=false → no routing call, no event', async () => {
    const { bridge, bus } = makeBridgeWithMocks({
      routingEnabled: false,
      routerOpts: { model: 'gemma2:2b' },
    });
    await bridge.chat('sys', [{ role: 'user', content: 'test' }], 'analysis');
    assert(bridge._modelRouter.callsLog.length === 0, 'router should not be called');
    const switched = bus.events.filter(e => e.evt === 'model:auto-switched');
    assertEqual(switched.length, 0);
  });

  test('B2: routingEnabled=true without _modelRouter → no crash, no routing', async () => {
    const { bridge, bus } = makeBridgeWithMocks({ router: false });
    const result = await bridge.chat('sys', [{ role: 'user', content: 'test' }], 'analysis');
    assert(result, 'chat should still complete');
    const switched = bus.events.filter(e => e.evt === 'model:auto-switched');
    assertEqual(switched.length, 0);
  });

  test('B3: routing → modelOverride passed + event + autoRouted++', async () => {
    const { bridge, bus } = makeBridgeWithMocks({
      routerOpts: { model: 'gemma2:2b', reason: 'Best for classification' },
    });
    assertEqual(bridge._routingStats.autoRouted, 0);
    await bridge.chat('sys', [{ role: 'user', content: 'test' }], 'classification');
    assertEqual(bridge._routingStats.autoRouted, 1);
    const switched = bus.events.filter(e => e.evt === 'model:auto-switched');
    assertEqual(switched.length, 1);
    assertEqual(switched[0].data.routedModel, 'gemma2:2b');
    assertEqual(switched[0].data.routedBackend, 'ollama');
    // Backend received the routed model
    const ollamaCall = bridge.backends.ollama.callsLog[0];
    assertEqual(ollamaCall.modelName, 'gemma2:2b');
  });

  test('B4: router returns same model → no switch, no event', async () => {
    const { bridge, bus } = makeBridgeWithMocks({
      activeModel: 'qwen3:8b',
      routerOpts: { model: 'qwen3:8b' },  // same as active
    });
    await bridge.chat('sys', [{ role: 'user', content: 'test' }], 'analysis');
    assertEqual(bridge._routingStats.autoRouted, 0);
    const switched = bus.events.filter(e => e.evt === 'model:auto-switched');
    assertEqual(switched.length, 0);
  });

  test('B5: router throws → silent fallback, activeModel unchanged', async () => {
    const { bridge, bus } = makeBridgeWithMocks({
      routerOpts: { fail: true },
    });
    const before = bridge.activeModel;
    const result = await bridge.chat('sys', [{ role: 'user', content: 'x' }], 'analysis');
    assert(result, 'chat must still succeed');
    assertEqual(bridge.activeModel, before);
    assertEqual(bridge._routingStats.autoRouted, 0);
  });

  test('B6: cache-bypass when routedSwitch is set', async () => {
    const { bridge } = makeBridgeWithMocks({
      routerOpts: { model: 'gemma2:2b' },
    });
    // Spy on cache
    let cacheGets = 0, cacheSets = 0;
    const origGet = bridge._cache.get.bind(bridge._cache);
    const origSet = bridge._cache.set.bind(bridge._cache);
    bridge._cache.get = (k) => { cacheGets++; return origGet(k); };
    bridge._cache.set = (k, v) => { cacheSets++; return origSet(k, v); };
    await bridge.chat('sys', [{ role: 'user', content: 'cached?' }], 'analysis');
    assertEqual(cacheGets, 0, 'cache.get must NOT be called when routing active');
    assertEqual(cacheSets, 0, 'cache.set must NOT be called when routing active');
  });

  test('B7: cache normal when no routing happens', async () => {
    const { bridge } = makeBridgeWithMocks({
      routerOpts: { model: 'qwen3:8b' },  // same as activeModel → no switch
    });
    let cacheGets = 0;
    const origGet = bridge._cache.get.bind(bridge._cache);
    bridge._cache.get = (k) => { cacheGets++; return origGet(k); };
    await bridge.chat('sys', [{ role: 'user', content: 'x' }], 'analysis');
    assertEqual(cacheGets, 1, 'cache.get must be called when no routing');
  });

  test('B8: routing to different backend switches targetBackend', async () => {
    const { bridge, bus } = makeBridgeWithMocks({
      activeModel: 'qwen3:8b',
      activeBackend: 'ollama',
      routerOpts: { model: 'claude-opus-4-7' },  // anthropic-backend
    });
    await bridge.chat('sys', [{ role: 'user', content: 'x' }], 'reasoning');
    // Ollama should NOT have been called
    assertEqual(bridge.backends.ollama.callsLog.length, 0,
      'ollama should NOT receive call for anthropic-backed model');
    // Anthropic should have received the call
    assertEqual(bridge.backends.anthropic.callsLog.length, 1);
    assertEqual(bridge.backends.anthropic.callsLog[0].modelName, 'claude-opus-4-7');
    // Event has correct backend
    const switched = bus.events.find(e => e.evt === 'model:auto-switched');
    assertEqual(switched.data.routedBackend, 'anthropic');
  });
});

// ════════════════════════════════════════════════════════════
// C — User-Chat-Schutz
// ════════════════════════════════════════════════════════════

describe('v7.5.2/C · User-Chat-Schutz', () => {

  test('C1: object-form chat({_userChat:true}) → no routing', async () => {
    const { bridge, bus } = makeBridgeWithMocks({
      routerOpts: { model: 'gemma2:2b' },
    });
    await bridge.chat({
      systemPrompt: 'sys',
      messages: [{ role: 'user', content: 'x' }],
      taskType: 'analysis',
      _userChat: true,
    });
    assertEqual(bridge._routingStats.autoRouted, 0);
    assertEqual(bus.events.filter(e => e.evt === 'model:auto-switched').length, 0);
  });

  test('C2: positional chat with options._userChat:true → no routing', async () => {
    const { bridge } = makeBridgeWithMocks({
      routerOpts: { model: 'gemma2:2b' },
    });
    await bridge.chat('sys', [{ role: 'user', content: 'x' }], 'analysis', { _userChat: true });
    assertEqual(bridge._routingStats.autoRouted, 0);
  });

  test('C3: positional chat without _userChat → routing active', async () => {
    const { bridge } = makeBridgeWithMocks({
      routerOpts: { model: 'gemma2:2b' },
    });
    await bridge.chat('sys', [{ role: 'user', content: 'x' }], 'analysis', {});
    assertEqual(bridge._routingStats.autoRouted, 1);
  });

  test('C4: streamChat({_userChat:true}) → no routing', async () => {
    const { bridge } = makeBridgeWithMocks({
      routerOpts: { model: 'gemma2:2b' },
    });
    let chunks = '';
    await bridge.streamChat({
      systemPrompt: 'sys',
      messages: [{ role: 'user', content: 'x' }],
      onChunk: (c) => { chunks += c; },
      taskType: 'analysis',
      _userChat: true,
    });
    assertEqual(bridge._routingStats.autoRouted, 0);
  });

  test('C5: ChatOrchestrator sets _userChat=true at all 4 sites', () => {
    const orchSrc = fs.readFileSync(
      path.join(ROOT, 'src/agent/hexagonal/ChatOrchestrator.js'), 'utf8');
    const helpersSrc = fs.readFileSync(
      path.join(ROOT, 'src/agent/hexagonal/ChatOrchestratorHelpers.js'), 'utf8');
    // Streaming call
    assert(/streamChat\([^)]*_userChat:\s*true/s.test(orchSrc) ||
           /_userChat:\s*true/g.test(orchSrc),
      'ChatOrchestrator should set _userChat:true');
    const orchOccurrences = (orchSrc.match(/_userChat:\s*true/g) || []).length;
    assert(orchOccurrences >= 3,
      `ChatOrchestrator should have 3 _userChat:true occurrences (streamChat + 2 chat), got ${orchOccurrences}`);
    const helpersOccurrences = (helpersSrc.match(/_userChat:\s*true/g) || []).length;
    assertEqual(helpersOccurrences, 1,
      'ChatOrchestratorHelpers should have 1 _userChat:true (synthesis)');
  });
});

// ════════════════════════════════════════════════════════════
// D — TaskType-Aliase
// ════════════════════════════════════════════════════════════

describe('v7.5.2/D · TaskType-Aliase', () => {

  test('D1: code → router gets code-gen', async () => {
    const { bridge } = makeBridgeWithMocks({
      routerOpts: { model: 'gemma2:2b' },
    });
    await bridge.chat('sys', [{ role: 'user', content: 'x' }], 'code');
    assertEqual(bridge._modelRouter.callsLog[0], 'code-gen');
  });

  test('D2: dream-judgment → router gets classification', async () => {
    const { bridge } = makeBridgeWithMocks({
      routerOpts: { model: 'gemma2:2b' },
    });
    await bridge.chat('sys', [{ role: 'user', content: 'x' }], 'dream-judgment');
    assertEqual(bridge._modelRouter.callsLog[0], 'classification');
  });

  test('D3: memory-classify → router gets classification', async () => {
    const { bridge } = makeBridgeWithMocks({
      routerOpts: { model: 'gemma2:2b' },
    });
    await bridge.chat('sys', [{ role: 'user', content: 'x' }], 'memory-classify');
    assertEqual(bridge._modelRouter.callsLog[0], 'classification');
  });

  test('D4: analysis → router gets analysis (no mapping)', async () => {
    const { bridge } = makeBridgeWithMocks({
      routerOpts: { model: 'gemma2:2b' },
    });
    await bridge.chat('sys', [{ role: 'user', content: 'x' }], 'analysis');
    assertEqual(bridge._modelRouter.callsLog[0], 'analysis');
  });
});

// ════════════════════════════════════════════════════════════
// E — Parallelität & Robustheit
// ════════════════════════════════════════════════════════════

describe('v7.5.2/E · Parallelität & Robustheit', () => {

  test('E1: parallel chat() with different taskTypes → no cross-contamination', async () => {
    // Build router that maps different categories to different models
    const routerCalls = [];
    const router = {
      route: (cat) => {
        routerCalls.push(cat);
        const map = {
          'classification': 'gemma2:2b',
          'code-gen': 'claude-opus-4-7',
        };
        return { model: map[cat] || 'qwen3:8b', reason: `for ${cat}` };
      },
    };
    const { bridge } = makeBridgeWithMocks({
      router,
      ollamaOpts: { latencyMs: 20 },
      anthropicOpts: { latencyMs: 20 },
    });
    const [r1, r2] = await Promise.all([
      bridge.chat('sys', [{ role: 'user', content: 'classify' }], 'memory-classify'),
      bridge.chat('sys', [{ role: 'user', content: 'code' }], 'code'),
    ]);
    assert(r1, 'r1 succeeded');
    assert(r2, 'r2 succeeded');
    // Each backend received its own routed model
    const ollamaCall = bridge.backends.ollama.callsLog.find(c => c.modelName === 'gemma2:2b');
    const anthropicCall = bridge.backends.anthropic.callsLog.find(c => c.modelName === 'claude-opus-4-7');
    assert(ollamaCall, 'ollama got gemma2:2b for classification');
    assert(anthropicCall, 'anthropic got claude-opus-4-7 for code-gen');
  });

  test('E2: thrown chat() leaves activeModel unchanged', async () => {
    const { bridge } = makeBridgeWithMocks({
      ollamaOpts: { fail: true },
      anthropicOpts: { fail: true },
      routerOpts: { model: 'gemma2:2b' },
    });
    const before = bridge.activeModel;
    let threw = false;
    try {
      await bridge.chat('sys', [{ role: 'user', content: 'x' }], 'analysis');
    } catch (_e) {
      threw = true;
    }
    assert(threw, 'chat must throw when all backends fail');
    assertEqual(bridge.activeModel, before, 'activeModel preserved');
  });

  test('E3: streamChat backend throws → activeModel unchanged', async () => {
    const { bridge } = makeBridgeWithMocks({
      ollamaOpts: { fail: true },
      anthropicOpts: { fail: true },
      routerOpts: { model: 'gemma2:2b' },
    });
    const before = bridge.activeModel;
    let threw = false;
    try {
      await bridge.streamChat('sys', [{ role: 'user', content: 'x' }], () => {}, null, 'analysis');
    } catch (_e) {
      threw = true;
    }
    assert(threw, 'streamChat must throw when all backends fail');
    assertEqual(bridge.activeModel, before);
  });

  test('E4: streamChat routing emits model:auto-switched before stream', async () => {
    const { bridge, bus } = makeBridgeWithMocks({
      routerOpts: { model: 'gemma2:2b' },
    });
    const eventsBeforeChunk = [];
    let firstChunk = null;
    await bridge.streamChat('sys', [{ role: 'user', content: 'x' }], (c) => {
      if (firstChunk === null) {
        firstChunk = c;
        // Capture events that fired before this first chunk
        eventsBeforeChunk.push(...bus.events.filter(e => e.evt === 'model:auto-switched'));
      }
    }, null, 'analysis');
    assertEqual(eventsBeforeChunk.length, 1, 'auto-switched event fired before first stream chunk');
  });
});

// ════════════════════════════════════════════════════════════
// F — EmotionalSteering-Interaktion
// ════════════════════════════════════════════════════════════

describe('v7.5.2/F · EmotionalSteering-Interaktion', () => {

  test('F1: when router escalates, routedModel reflects it', async () => {
    // ModelRouter has internal escalation logic — we test that whatever it
    // returns, the bridge passes through correctly.
    const escalatedRouter = {
      route: (cat) => ({
        model: 'claude-opus-4-7',
        reason: 'Escalated for classification (frustration high)',
        escalated: true,
      }),
    };
    const { bridge, bus } = makeBridgeWithMocks({ router: escalatedRouter });
    await bridge.chat('sys', [{ role: 'user', content: 'x' }], 'classification');
    const switched = bus.events.find(e => e.evt === 'model:auto-switched');
    assert(switched, 'event fired');
    assertEqual(switched.data.routedModel, 'claude-opus-4-7',
      'larger escalated model passed through');
    assert(switched.data.reason && switched.data.reason.includes('Escalated'),
      'reason includes escalation marker');
  });
});

// ════════════════════════════════════════════════════════════
// G — Public API
// ════════════════════════════════════════════════════════════

describe('v7.5.2/G · Public API', () => {

  test('G1: getRoutingStats returns correct shape', () => {
    const { bridge } = makeBridgeWithMocks({});
    const stats = bridge.getRoutingStats();
    assert(typeof stats === 'object', 'returns object');
    assert('autoRouted' in stats, 'has autoRouted');
    assert('lastRouted' in stats, 'has lastRouted');
    assert('routerAvailable' in stats, 'has routerAvailable');
    assert('enabled' in stats, 'has enabled');
    assertEqual(stats.autoRouted, 0);
    assertEqual(stats.lastRouted, null);
    assertEqual(stats.routerAvailable, true);
    assertEqual(stats.enabled, true);
  });

  test('G2: lastRouted contains details after switch', async () => {
    const { bridge } = makeBridgeWithMocks({
      routerOpts: { model: 'gemma2:2b', reason: 'Best for analysis' },
    });
    await bridge.chat('sys', [{ role: 'user', content: 'x' }], 'analysis');
    const stats = bridge.getRoutingStats();
    assert(stats.lastRouted, 'lastRouted populated');
    assertEqual(stats.lastRouted.routedModel, 'gemma2:2b');
    assertEqual(stats.lastRouted.routedBackend, 'ollama');
    assertEqual(stats.lastRouted.taskType, 'analysis');
    assert(typeof stats.lastRouted.at === 'number', 'has timestamp');
  });

  test('G3: lastRouted is defensive copy (mutation does not affect future reads)', async () => {
    const { bridge } = makeBridgeWithMocks({
      routerOpts: { model: 'gemma2:2b' },
    });
    await bridge.chat('sys', [{ role: 'user', content: 'x' }], 'analysis');
    const snap1 = bridge.getRoutingStats().lastRouted;
    snap1.routedModel = 'MUTATED';   // try to mutate the snapshot
    const snap2 = bridge.getRoutingStats().lastRouted;
    assertEqual(snap2.routedModel, 'gemma2:2b',
      'mutation of snapshot must not affect internal state');
  });

  test('G4: routerAvailable false when _modelRouter null', () => {
    const { bridge } = makeBridgeWithMocks({});
    bridge._modelRouter = null;
    const stats = bridge.getRoutingStats();
    assertEqual(stats.routerAvailable, false);
  });
});

run();
