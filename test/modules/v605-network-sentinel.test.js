// ============================================================
// Test: v6.0.5 — NetworkSentinel (V6-10 Offline-First)
// ============================================================

const { describe, test, assert, assertEqual, run } = require('../harness');
const { NetworkSentinel } = require('../../src/agent/autonomy/NetworkSentinel');

// ── Mock Bus ────────────────────────────────────────────────
function mockBus() {
  const _listeners = new Map();
  const _emitted = [];
  return {
    on(event, fn, opts) {
      if (!_listeners.has(event)) _listeners.set(event, []);
      _listeners.get(event).push({ fn, ...opts });
      return () => {
        const a = _listeners.get(event);
        if (a) { const i = a.findIndex(l => l.fn === fn); if (i >= 0) a.splice(i, 1); }
      };
    },
    emit(event, data, meta) {
      _emitted.push({ event, data, meta });
      const ls = _listeners.get(event);
      if (ls) for (const l of ls) l.fn(data, meta);
    },
    fire(event, data, meta) { this.emit(event, data, meta); },
    _emitted,
    _listeners,
    _findEmitted(name) { return _emitted.filter(e => e.event === name); },
  };
}

// ── Mock ModelBridge ────────────────────────────────────────
function mockModelBridge(opts = {}) {
  return {
    activeModel: opts.model || 'claude-3-opus',
    activeBackend: opts.backend || 'anthropic',
    availableModels: opts.models || [
      { name: 'claude-3-opus', backend: 'anthropic' },
      { name: 'kimi-k2.5', backend: 'ollama' },
      { name: 'deepseek-coder', backend: 'ollama' },
    ],
    _selectBestModel(models) {
      return models[0] || null;
    },
    switchTo(name) {
      const m = this.availableModels.find(m => m.name === name);
      if (!m) throw new Error(`Model "${name}" not found`);
      this.activeModel = m.name;
      this.activeBackend = m.backend;
      return { ok: true, model: m.name, backend: m.backend };
    },
  };
}

// ═══════════════════════════════════════════════════════════
// Construction
// ═══════════════════════════════════════════════════════════

describe('NetworkSentinel — Construction', () => {

  test('constructs with defaults', () => {
    const bus = mockBus();
    const ns = new NetworkSentinel({ bus });
    assert(ns, 'should construct');
    assert(ns.isOnline, 'should be online by default');
    assert(!ns.isFailoverActive, 'no failover initially');
  });

  test('constructs with custom config', () => {
    const bus = mockBus();
    const ns = new NetworkSentinel({
      bus,
      config: { intervalMs: 5000, failureThreshold: 5 },
    });
    assertEqual(ns._config.intervalMs, 5000);
    assertEqual(ns._config.failureThreshold, 5);
  });

  test('getStatus returns complete status object', () => {
    const bus = mockBus();
    const ns = new NetworkSentinel({ bus });
    const status = ns.getStatus();
    assert('online' in status, 'status should have online');
    assert('ollamaAvailable' in status, 'status should have ollamaAvailable');
    assert('failoverActive' in status, 'status should have failoverActive');
    assert('stats' in status, 'status should have stats');
    assert('queueSize' in status, 'status should have queueSize');
  });
});

// ═══════════════════════════════════════════════════════════
// State Transitions
// ═══════════════════════════════════════════════════════════

describe('NetworkSentinel — State Transitions', () => {

  test('_onProbeFailure increments counter', () => {
    const bus = mockBus();
    const ns = new NetworkSentinel({ bus, config: { failureThreshold: 3 } });
    ns._running = true;

    ns._onProbeFailure();
    assertEqual(ns._consecutiveFailures, 1);
    assert(ns.isOnline, 'should still be online after 1 failure');

    ns._onProbeFailure();
    assertEqual(ns._consecutiveFailures, 2);
    assert(ns.isOnline, 'should still be online after 2 failures');
  });

  test('reaching threshold triggers offline', () => {
    const bus = mockBus();
    const ns = new NetworkSentinel({ bus, config: { failureThreshold: 3 } });
    ns._running = true;

    ns._onProbeFailure();
    ns._onProbeFailure();
    ns._onProbeFailure();

    assert(!ns.isOnline, 'should be offline after 3 failures');
    assertEqual(ns._stats.lastStatus, 'offline');
    assert(ns._stats.offlineSince, 'offlineSince should be set');

    const statusEvents = bus._findEmitted('network:status');
    assertEqual(statusEvents.length, 1, 'should emit network:status');
    assertEqual(statusEvents[0].data.online, false, 'status should be offline');
  });

  test('_onOnline resets failure counter and sets online', () => {
    const bus = mockBus();
    const ns = new NetworkSentinel({ bus, config: { failureThreshold: 2 } });
    ns._running = true;

    // Go offline
    ns._onProbeFailure();
    ns._onProbeFailure();
    assert(!ns.isOnline, 'should be offline');

    // Come back online
    ns._onOnline();
    assert(ns.isOnline, 'should be online again');
    assertEqual(ns._consecutiveFailures, 0, 'failures reset');
    assertEqual(ns._stats.offlineSince, null, 'offlineSince cleared');
  });

  test('online → online does not emit events', () => {
    const bus = mockBus();
    const ns = new NetworkSentinel({ bus });
    ns._running = true;

    ns._onOnline();
    ns._onOnline();
    ns._onOnline();

    const statusEvents = bus._findEmitted('network:status');
    assertEqual(statusEvents.length, 0, 'should not emit when already online');
  });

  test('offline → offline does not re-emit', () => {
    const bus = mockBus();
    const ns = new NetworkSentinel({ bus, config: { failureThreshold: 2 } });
    ns._running = true;

    // Go offline
    ns._onProbeFailure();
    ns._onProbeFailure();
    const count1 = bus._findEmitted('network:status').length;

    // More failures — should NOT re-emit
    ns._onProbeFailure();
    ns._onProbeFailure();
    const count2 = bus._findEmitted('network:status').length;
    assertEqual(count1, count2, 'should not re-emit offline status');
  });
});

// ═══════════════════════════════════════════════════════════
// Failover
// ═══════════════════════════════════════════════════════════

describe('NetworkSentinel — Failover', () => {

  test('failover switches to Ollama model', async () => {
    const bus = mockBus();
    const ns = new NetworkSentinel({ bus });
    const mb = mockModelBridge();
    ns._modelBridge = mb;
    ns._running = true;

    await ns._failoverToOllama();

    assertEqual(mb.activeBackend, 'ollama', 'should switch to ollama');
    assert(ns.isFailoverActive, 'failover should be active');
    assertEqual(ns._previousModel, 'claude-3-opus', 'previous model saved');
    assertEqual(ns._previousBackend, 'anthropic', 'previous backend saved');
    assertEqual(ns._stats.failovers, 1, 'failover stat incremented');
  });

  test('failover emits network:failover event', async () => {
    const bus = mockBus();
    const ns = new NetworkSentinel({ bus });
    ns._modelBridge = mockModelBridge();
    ns._running = true;

    await ns._failoverToOllama();

    const events = bus._findEmitted('network:failover');
    assertEqual(events.length, 1, 'should emit failover event');
    assertEqual(events[0].data.from.backend, 'anthropic');
    assertEqual(events[0].data.to.backend, 'ollama');
    assertEqual(events[0].data.reason, 'network-offline');
  });

  test('no failover when already on Ollama', async () => {
    const bus = mockBus();
    const ns = new NetworkSentinel({ bus });
    ns._modelBridge = mockModelBridge({ model: 'llama3', backend: 'ollama' });
    ns._running = true;

    await ns._failoverToOllama();

    assert(!ns.isFailoverActive, 'should not activate failover');
    assertEqual(ns._stats.failovers, 0, 'no failover recorded');
  });

  test('no failover without ModelBridge', async () => {
    const bus = mockBus();
    const ns = new NetworkSentinel({ bus });
    ns._running = true;

    await ns._failoverToOllama();
    assert(!ns.isFailoverActive, 'should not failover without ModelBridge');
  });

  test('no failover when no Ollama models available', async () => {
    const bus = mockBus();
    const ns = new NetworkSentinel({ bus });
    ns._modelBridge = mockModelBridge({
      models: [{ name: 'claude-3-opus', backend: 'anthropic' }],
    });
    ns._running = true;

    await ns._failoverToOllama();
    assert(!ns.isFailoverActive, 'should not failover without Ollama models');
  });
});

// ═══════════════════════════════════════════════════════════
// Restore
// ═══════════════════════════════════════════════════════════

describe('NetworkSentinel — Restore', () => {

  test('restore switches back to previous model', async () => {
    const bus = mockBus();
    const ns = new NetworkSentinel({ bus });
    const mb = mockModelBridge();
    ns._modelBridge = mb;
    ns._running = true;

    // Failover first
    await ns._failoverToOllama();
    assertEqual(mb.activeBackend, 'ollama');

    // Restore
    await ns._restoreModel();
    assertEqual(mb.activeModel, 'claude-3-opus', 'model restored');
    assertEqual(mb.activeBackend, 'anthropic', 'backend restored');
    assert(!ns.isFailoverActive, 'failover deactivated');
    assertEqual(ns._stats.restores, 1, 'restore stat incremented');
  });

  test('restore emits network:restored event', async () => {
    const bus = mockBus();
    const ns = new NetworkSentinel({ bus });
    ns._modelBridge = mockModelBridge();
    ns._running = true;

    await ns._failoverToOllama();
    await ns._restoreModel();

    const events = bus._findEmitted('network:restored');
    assertEqual(events.length, 1, 'should emit restored event');
    assertEqual(events[0].data.model, 'claude-3-opus');
    assertEqual(events[0].data.backend, 'anthropic');
  });

  test('restore no-ops if previous model disappeared', async () => {
    const bus = mockBus();
    const ns = new NetworkSentinel({ bus });
    const mb = mockModelBridge();
    ns._modelBridge = mb;
    ns._running = true;

    await ns._failoverToOllama();
    // Remove the previous model from available list
    mb.availableModels = mb.availableModels.filter(m => m.name !== 'claude-3-opus');

    await ns._restoreModel();
    assert(!ns.isFailoverActive, 'failover should be cleared even if model gone');
    assertEqual(ns._stats.restores, 0, 'no restore stat if model gone');
  });

  test('full offline→failover→online→restore cycle', async () => {
    const bus = mockBus();
    const ns = new NetworkSentinel({ bus, config: { failureThreshold: 2, autoRestore: true } });
    const mb = mockModelBridge();
    ns._modelBridge = mb;
    ns._ollamaAvailable = true;
    ns._running = true;

    // Go offline
    ns._onProbeFailure();
    ns._onProbeFailure();
    assert(!ns.isOnline, 'should be offline');

    // Failover should have been triggered by _onProbeFailure
    // (only if _ollamaAvailable was true before the transition)
    // Manually trigger for test clarity
    await ns._failoverToOllama();
    assertEqual(mb.activeBackend, 'ollama', 'should be on ollama');

    // Come back online — should auto-restore
    ns._failoverActive = true;
    ns._onOnline();

    // _onOnline calls _restoreModel if autoRestore && failoverActive
    // Wait for async restore
    await new Promise(r => setTimeout(r, 10));

    // Verify restore happened via event
    const restored = bus._findEmitted('network:restored');
    assertEqual(restored.length, 1, 'should auto-restore on reconnect');
  });
});

// ═══════════════════════════════════════════════════════════
// Mutation Queue
// ═══════════════════════════════════════════════════════════

describe('NetworkSentinel — Mutation Queue', () => {

  test('queues mutations during offline', () => {
    const bus = mockBus();
    const ns = new NetworkSentinel({ bus });

    ns.queueMutation({ event: 'kg:sync', data: { node: 'test' } });
    ns.queueMutation({ event: 'lessons:sync', data: { lesson: 'abc' } });

    assertEqual(ns.getStatus().queueSize, 2, 'should have 2 queued');
  });

  test('flushQueue replays mutations on reconnect', () => {
    const bus = mockBus();
    const ns = new NetworkSentinel({ bus, config: { failureThreshold: 1 } });
    ns._running = true;

    // Queue mutations
    ns.queueMutation({ event: 'kg:sync', data: { node: 'A' } });
    ns.queueMutation({ event: 'kg:sync', data: { node: 'B' } });

    // Go offline then back online
    ns._onProbeFailure();
    ns._onOnline();

    // Mutations should have been replayed
    const replayed = bus._emitted.filter(e => e.event === 'kg:sync');
    assertEqual(replayed.length, 2, 'should replay 2 mutations');
    assert(replayed[0].data._replayed, 'should have _replayed flag');
    assertEqual(ns.getStatus().queueSize, 0, 'queue should be empty after flush');
  });

  test('queue ring buffer limits to 500', () => {
    const bus = mockBus();
    const ns = new NetworkSentinel({ bus });

    for (let i = 0; i < 510; i++) {
      ns.queueMutation({ event: 'test', data: { i } });
    }

    assertEqual(ns._mutationQueue.length, 500, 'should cap at 500');
    assertEqual(ns._mutationQueue[0].data.i, 10, 'oldest entries evicted');
  });
});

// ═══════════════════════════════════════════════════════════
// Lifecycle
// ═══════════════════════════════════════════════════════════

describe('NetworkSentinel — Lifecycle', () => {

  test('start + stop lifecycle', () => {
    const bus = mockBus();
    const ns = new NetworkSentinel({ bus, config: { intervalMs: 100_000 } });

    ns.start();
    assert(ns._running, 'should be running after start');

    ns.stop();
    assert(!ns._running, 'should not be running after stop');
    assert(!ns._probeTimer, 'timer should be cleared');
  });

  test('double start is safe', () => {
    const bus = mockBus();
    const ns = new NetworkSentinel({ bus, config: { intervalMs: 100_000 } });

    ns.start();
    ns.start(); // should not throw
    ns.stop();
  });

  test('stop cleans up subscriptions', () => {
    const bus = mockBus();
    const ns = new NetworkSentinel({ bus, config: { intervalMs: 100_000 } });

    ns.start();
    assert(ns._unsubs.length > 0, 'should have subscriptions');

    ns.stop();
    assertEqual(ns._unsubs.length, 0, 'subscriptions cleared');
  });

  test('getStats returns probe statistics', () => {
    const bus = mockBus();
    const ns = new NetworkSentinel({ bus });

    const stats = ns.getStats();
    assert('probes' in stats, 'should have probes');
    assert('failures' in stats, 'should have failures');
    assert('failovers' in stats, 'should have failovers');
    assert('restores' in stats, 'should have restores');
  });
});

run();
