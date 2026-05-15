// ============================================================
// GENESIS — test/modules/v786-modelbridge-context.contract.test.js
// Contract test for the v7.8.6 ModelBridge call-context split.
// Every test name carries `modelbridge-v786 contract:` prefix.
// ============================================================

'use strict';

const { describe, test, assert, assertEqual, run } = require('../harness');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const MBC_PATH = path.join(ROOT, 'src/agent/foundation/ModelBridgeContext');
const MB_PATH  = path.join(ROOT, 'src/agent/foundation/ModelBridge');

function makeBareBridge() {
  const { ModelBridge } = require(MB_PATH);
  return new ModelBridge({ bus: { fire: () => {}, emit: () => {} } });
}

describe('modelbridge-v786 contract: module exports', () => {

  test('modelbridge-v786 contract: module exports contextMixin and TASK_TYPE_ROUTING_MAP', () => {
    const mod = require(MBC_PATH);
    assert(mod.contextMixin && typeof mod.contextMixin === 'object');
    assert(mod.TASK_TYPE_ROUTING_MAP && typeof mod.TASK_TYPE_ROUTING_MAP === 'object');
  });

  test('modelbridge-v786 contract: contextMixin has exactly four methods', () => {
    const { contextMixin } = require(MBC_PATH);
    const keys = Object.keys(contextMixin).sort();
    assertEqual(keys.length, 4);
    assert(keys.includes('_resolveTemperature'));
    assert(keys.includes('_resolveRouting'));
    assert(keys.includes('_resolveBackendTarget'));
    assert(keys.includes('_resolvePriority'));
  });

  test('modelbridge-v786 contract: all four methods are functions', () => {
    const { contextMixin } = require(MBC_PATH);
    assertEqual(typeof contextMixin._resolveTemperature, 'function');
    assertEqual(typeof contextMixin._resolveRouting, 'function');
    assertEqual(typeof contextMixin._resolveBackendTarget, 'function');
    assertEqual(typeof contextMixin._resolvePriority, 'function');
  });

  test('modelbridge-v786 contract: TASK_TYPE_ROUTING_MAP has expected aliases', () => {
    const { TASK_TYPE_ROUTING_MAP } = require(MBC_PATH);
    assertEqual(TASK_TYPE_ROUTING_MAP['code'], 'code-gen');
    assertEqual(TASK_TYPE_ROUTING_MAP['dream-judgment'], 'classification');
    assertEqual(TASK_TYPE_ROUTING_MAP['dream-summarize'], 'summarization');
    assertEqual(TASK_TYPE_ROUTING_MAP['memory-classify'], 'classification');
    assertEqual(TASK_TYPE_ROUTING_MAP['wakeup'], 'reasoning');
  });

});

describe('modelbridge-v786 contract: ModelBridge.prototype mount', () => {

  test('modelbridge-v786 contract: prototype has _resolveTemperature', () => {
    const { ModelBridge } = require(MB_PATH);
    assertEqual(typeof ModelBridge.prototype._resolveTemperature, 'function');
  });

  test('modelbridge-v786 contract: prototype has _resolveRouting', () => {
    const { ModelBridge } = require(MB_PATH);
    assertEqual(typeof ModelBridge.prototype._resolveRouting, 'function');
  });

  test('modelbridge-v786 contract: prototype has _resolveBackendTarget', () => {
    const { ModelBridge } = require(MB_PATH);
    assertEqual(typeof ModelBridge.prototype._resolveBackendTarget, 'function');
  });

  test('modelbridge-v786 contract: prototype has _resolvePriority', () => {
    const { ModelBridge } = require(MB_PATH);
    assertEqual(typeof ModelBridge.prototype._resolvePriority, 'function');
  });

  test('modelbridge-v786 contract: mounted methods are identical references to mixin source', () => {
    const { ModelBridge } = require(MB_PATH);
    const { contextMixin } = require(MBC_PATH);
    assertEqual(ModelBridge.prototype._resolveTemperature, contextMixin._resolveTemperature);
    assertEqual(ModelBridge.prototype._resolveRouting, contextMixin._resolveRouting);
    assertEqual(ModelBridge.prototype._resolveBackendTarget, contextMixin._resolveBackendTarget);
    assertEqual(ModelBridge.prototype._resolvePriority, contextMixin._resolvePriority);
  });

  test('modelbridge-v786 contract: _dispatch is on the prototype', () => {
    const { ModelBridge } = require(MB_PATH);
    assertEqual(typeof ModelBridge.prototype._dispatch, 'function');
  });

  test('modelbridge-v786 contract: thin _dispatchChat wrapper preserved on prototype', () => {
    const { ModelBridge } = require(MB_PATH);
    assertEqual(typeof ModelBridge.prototype._dispatchChat, 'function');
  });

  test('modelbridge-v786 contract: thin _dispatchStream wrapper preserved on prototype', () => {
    const { ModelBridge } = require(MB_PATH);
    assertEqual(typeof ModelBridge.prototype._dispatchStream, 'function');
  });

});

describe('modelbridge-v786 contract: _resolveTemperature semantics', () => {

  test('modelbridge-v786 contract: returns taskType default from this.temperatures', () => {
    assertEqual(typeof makeBareBridge()._resolveTemperature('code', {}), 'number');
  });

  test('modelbridge-v786 contract: explicit options.temperature wins over default', () => {
    assertEqual(makeBareBridge()._resolveTemperature('code', { temperature: 0.42 }), 0.42);
  });

  test('modelbridge-v786 contract: MetaLearning recommendation overrides default for non-chat task', () => {
    const bridge = makeBareBridge();
    bridge.metaLearning = { recommend: () => ({ temperature: 0.99 }) };
    assertEqual(bridge._resolveTemperature('code', {}), 0.99);
  });

  test('modelbridge-v786 contract: MetaLearning skipped for chat taskType', () => {
    const bridge = makeBareBridge();
    bridge.metaLearning = { recommend: () => ({ temperature: 0.99 }) };
    assert(bridge._resolveTemperature('chat', {}) !== 0.99);
  });

  test('modelbridge-v786 contract: MetaLearning skipped when explicit option present', () => {
    const bridge = makeBareBridge();
    bridge.metaLearning = { recommend: () => ({ temperature: 0.99 }) };
    assertEqual(bridge._resolveTemperature('code', { temperature: 0.5 }), 0.5);
  });

  test('modelbridge-v786 contract: MetaLearning crash falls through silently', () => {
    const bridge = makeBareBridge();
    bridge.metaLearning = { recommend: () => { throw new Error('not ready'); } };
    assertEqual(typeof bridge._resolveTemperature('code', {}), 'number');
  });

});

describe('modelbridge-v786 contract: _resolveRouting semantics', () => {

  function withRouter(settings, router) {
    const bridge = makeBareBridge();
    bridge._settings = { get: (k) => settings[k] };
    bridge._modelRouter = router;
    bridge.activeModel = 'preferred-model';
    bridge.availableModels = [
      { name: 'preferred-model', backend: 'ollama' },
      { name: 'code-model',      backend: 'ollama' },
    ];
    return bridge;
  }

  test('modelbridge-v786 contract: autoRouteByTask=false short-circuits to null', () => {
    const bridge = withRouter({ 'agency.autoRouteByTask': false }, null);
    assertEqual(bridge._resolveRouting('code', {}), null);
  });

  test('modelbridge-v786 contract: no router returns null', () => {
    assertEqual(withRouter({}, null)._resolveRouting('code', {}), null);
  });

  test('modelbridge-v786 contract: options._userChat=true short-circuits to null', () => {
    const router = { route: () => ({ model: 'code-model' }) };
    assertEqual(withRouter({}, router)._resolveRouting('chat', { _userChat: true }), null);
  });

  test('modelbridge-v786 contract: router returns same model as active returns null', () => {
    const router = { route: () => ({ model: 'preferred-model' }) };
    assertEqual(withRouter({}, router)._resolveRouting('code', {}), null);
  });

  test('modelbridge-v786 contract: routed model not in availableModels returns null', () => {
    const router = { route: () => ({ model: 'unknown-model' }) };
    assertEqual(withRouter({}, router)._resolveRouting('code', {}), null);
  });

  test('modelbridge-v786 contract: successful routing returns switch and bumps stats', () => {
    const router = { route: () => ({ model: 'code-model', reason: 'task-aware' }) };
    const bridge = withRouter({}, router);
    const result = bridge._resolveRouting('code', {});
    assert(result);
    assertEqual(result.routedModel, 'code-model');
    assertEqual(result.routedBackend, 'ollama');
    assertEqual(bridge._routingStats.autoRouted, 1);
  });

  test('modelbridge-v786 contract: router throwing returns null without crash', () => {
    const router = { route: () => { throw new Error('router error'); } };
    assertEqual(withRouter({}, router)._resolveRouting('code', {}), null);
  });

});

describe('modelbridge-v786 contract: _resolveBackendTarget precedence', () => {

  test('modelbridge-v786 contract: routedSwitch wins over everything', () => {
    const bridge = makeBareBridge();
    bridge.activeBackend = 'ollama';
    bridge.activeModel = 'preferred-model';
    bridge.availableModels = [
      { name: 'preferred-model', backend: 'ollama' },
      { name: 'role-model',      backend: 'anthropic' },
    ];
    bridge.setRoles({ code: 'role-model' });
    const r = bridge._resolveBackendTarget('code', {
      routedBackend: 'openai',
      routedModel: 'routed-model',
    });
    assertEqual(r.targetBackend, 'openai');
    assertEqual(r.effectiveModel, 'routed-model');
  });

  test('modelbridge-v786 contract: roleOverride wins when no routedSwitch', () => {
    const bridge = makeBareBridge();
    bridge.activeBackend = 'ollama';
    bridge.activeModel = 'preferred-model';
    bridge.availableModels = [
      { name: 'preferred-model', backend: 'ollama' },
      { name: 'role-model',      backend: 'anthropic' },
    ];
    bridge.setRoles({ code: 'role-model' });
    const r = bridge._resolveBackendTarget('code', null);
    assertEqual(r.targetBackend, 'anthropic');
    assertEqual(r.effectiveModel, 'role-model');
  });

  test('modelbridge-v786 contract: falls through to activeBackend/activeModel', () => {
    const bridge = makeBareBridge();
    bridge.activeBackend = 'ollama';
    bridge.activeModel = 'preferred-model';
    const r = bridge._resolveBackendTarget('unknown-task', null);
    assertEqual(r.targetBackend, 'ollama');
    assertEqual(r.calledModel, 'preferred-model');
  });

});

describe('modelbridge-v786 contract: _resolvePriority semantics', () => {

  test('modelbridge-v786 contract: chat task gets priority 10 by default', () => {
    assertEqual(makeBareBridge()._resolvePriority('chat', {}), 10);
  });

  test('modelbridge-v786 contract: non-chat task gets priority 0 by default', () => {
    assertEqual(makeBareBridge()._resolvePriority('code', {}), 0);
  });

  test('modelbridge-v786 contract: options.priority overrides default for chat', () => {
    assertEqual(makeBareBridge()._resolvePriority('chat', { priority: 5 }), 5);
  });

  test('modelbridge-v786 contract: options.priority overrides default for non-chat', () => {
    assertEqual(makeBareBridge()._resolvePriority('code', { priority: 99 }), 99);
  });

  test('modelbridge-v786 contract: options.priority=0 honoured not falsy-defaulted', () => {
    assertEqual(makeBareBridge()._resolvePriority('chat', { priority: 0 }), 0);
  });

});

describe('modelbridge-v786 contract: _dispatch routing', () => {

  function withBackend(backend) {
    const bridge = makeBareBridge();
    bridge.backends.ollama = backend;
    bridge.activeBackend = 'ollama';
    bridge.activeModel = 'm';
    bridge.availableModels = [{ name: 'm', backend: 'ollama' }];
    return bridge;
  }

  test('modelbridge-v786 contract: mode=chat routes to backend.chat', async () => {
    let captured = null;
    const backend = { chat: (sp, msgs, temp) => { captured = { temp }; return Promise.resolve('OK'); } };
    const bridge = withBackend(backend);
    const result = await bridge._dispatch({
      mode: 'chat', backendName: 'ollama', systemPrompt: 's', messages: [], temp: 0.5,
    });
    assertEqual(result, 'OK');
    assertEqual(captured.temp, 0.5);
  });

  test('modelbridge-v786 contract: mode=stream routes to backend.stream', async () => {
    let called = false;
    const backend = {
      chat: () => Promise.resolve('chat'),
      stream: (sp, msgs, onChunk) => { called = true; onChunk('chunk'); return Promise.resolve('streamed'); },
    };
    const bridge = withBackend(backend);
    let chunkSeen = null;
    await bridge._dispatch({
      mode: 'stream', backendName: 'ollama', systemPrompt: 's', messages: [], temp: 0.5,
      onChunk: (c) => { chunkSeen = c; },
    });
    assert(called);
    assertEqual(chunkSeen, 'chunk');
  });

  test('modelbridge-v786 contract: unknown mode throws', () => {
    let err = null;
    try { withBackend({ chat: () => {} })._dispatch({ mode: 'bogus', backendName: 'ollama' }); }
    catch (e) { err = e; }
    assert(err);
    assert(/Unknown dispatch mode/.test(err.message));
  });

});

describe('modelbridge-v786 contract: _prepareCallContext regression-snapshot', () => {

  test('modelbridge-v786 contract: output bag has exactly the seven documented keys', () => {
    const ctx = makeBareBridge()._prepareCallContext({ taskType: 'chat', options: {} });
    const keys = Object.keys(ctx).sort();
    assertEqual(keys.length, 7);
    for (const k of ['temp','routedSwitch','roleOverride','targetBackend','effectiveModel','calledModel','priority']) {
      assert(keys.includes(k));
    }
  });

  test('modelbridge-v786 contract: snapshot 1 — bare chat call', () => {
    const bridge = makeBareBridge();
    bridge.activeBackend = 'ollama';
    bridge.activeModel = 'preferred-model';
    const ctx = bridge._prepareCallContext({ taskType: 'chat', options: {} });
    assertEqual(ctx.routedSwitch, null);
    assertEqual(ctx.targetBackend, 'ollama');
    assertEqual(ctx.calledModel, 'preferred-model');
    assertEqual(ctx.priority, 10);
  });

  test('modelbridge-v786 contract: snapshot 2 — code task with explicit temperature', () => {
    const ctx = makeBareBridge()._prepareCallContext({
      taskType: 'code', options: { temperature: 0.1 },
    });
    assertEqual(ctx.temp, 0.1);
    assertEqual(ctx.priority, 0);
  });

  test('modelbridge-v786 contract: snapshot 3 — priority override', () => {
    const ctx = makeBareBridge()._prepareCallContext({
      taskType: 'chat', options: { priority: 42 },
    });
    assertEqual(ctx.priority, 42);
  });

  test('modelbridge-v786 contract: snapshot 4 — role override applies', () => {
    const bridge = makeBareBridge();
    bridge.activeBackend = 'ollama';
    bridge.activeModel = 'preferred-model';
    bridge.availableModels = [
      { name: 'preferred-model', backend: 'ollama' },
      { name: 'role-model',      backend: 'anthropic' },
    ];
    bridge.setRoles({ code: 'role-model' });
    const ctx = bridge._prepareCallContext({ taskType: 'code', options: {} });
    assertEqual(ctx.targetBackend, 'anthropic');
    assertEqual(ctx.effectiveModel, 'role-model');
  });

  test('modelbridge-v786 contract: snapshot 5 — userChat short-circuits routing', () => {
    const bridge = makeBareBridge();
    bridge.activeBackend = 'ollama';
    bridge.activeModel = 'preferred-model';
    bridge._modelRouter = { route: () => ({ model: 'should-not-apply' }) };
    bridge.availableModels = [
      { name: 'preferred-model',  backend: 'ollama' },
      { name: 'should-not-apply', backend: 'ollama' },
    ];
    const ctx = bridge._prepareCallContext({ taskType: 'chat', options: { _userChat: true } });
    assertEqual(ctx.routedSwitch, null);
  });

});

run();
