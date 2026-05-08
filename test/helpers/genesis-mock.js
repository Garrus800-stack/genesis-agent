// ============================================================
// GENESIS test/helpers/genesis-mock.js (v7.7.0)
//
// Minimal window.genesis IPC mock for testing UI modules under Node.
// Replaces the inline mock that lived inside renderer.test.js.
//
// What modules need from window.genesis:
//   - genesis.invoke(channel, ...args)   → Promise
//   - genesis.send(channel, ...args)     → fire-and-forget
//   - genesis.on(channel, handler)       → register listener
//
// The mock records every call/listener so tests can assert.
// ============================================================

'use strict';

function createGenesisMock() {
  const calls = { invoke: [], send: [] };
  const listeners = {};
  const handlers = {};   // channel → response generator
  const mock = {
    invoke(channel, ...args) {
      calls.invoke.push({ channel, args });
      const h = handlers[channel];
      if (typeof h === 'function') return Promise.resolve(h(...args));
      return Promise.resolve(null);
    },
    send(channel, ...args) {
      calls.send.push({ channel, args });
    },
    on(channel, fn) {
      (listeners[channel] = listeners[channel] || []).push(fn);
    },
  };
  return {
    mock,
    calls,
    listeners,
    /** Register a response handler for a given IPC channel. */
    setHandler(channel, fn) { handlers[channel] = fn; },
    /** Trigger a registered listener (simulates push from main process). */
    trigger(channel, payload) {
      const arr = listeners[channel] || [];
      for (const fn of arr) fn(payload);
    },
    /** Reset call log + listeners (for tests sharing the mock). */
    reset() {
      calls.invoke.length = 0;
      calls.send.length = 0;
      for (const k of Object.keys(listeners)) delete listeners[k];
      for (const k of Object.keys(handlers)) delete handlers[k];
    },
  };
}

module.exports = { createGenesisMock };
