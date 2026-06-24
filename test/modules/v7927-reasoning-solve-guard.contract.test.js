// ============================================================
// v7.9.27 #8 — reasoning:solve is wrapped, null on reject.
//
// The reasoning:solve handler returned reasoning.solve(...) directly
// (fire-and-forget), so a reject surfaced as an unhandled rejection
// rather than a null result the caller can branch on. It is now wrapped
// symmetrically with the web:search handler.
// ============================================================

'use strict';

const path = require('path');
const { describe, test, run, assert, assertEqual } = require('../harness');

const ROOT = path.join(__dirname, '../..');
const { AgentCoreWire } = require(path.join(ROOT, 'src/agent/AgentCoreWire'));
const { EventBus } = require(path.join(ROOT, 'src/agent/core/EventBus'));

function handlerFor(event, resolveMap) {
  const bus = new EventBus();
  const container = {
    has: (n) => n in resolveMap,
    resolve: (n) => resolveMap[n],
    tryResolve: () => null,
  };
  const wire = new AgentCoreWire({ container, _bus: bus });
  wire._wireEventHandlers();
  const set = bus.listeners.get(event);
  assert(set && set.size > 0, `a listener for ${event} must be registered`);
  return [...set][0].handler;
}

describe('v7.9.27 #8 — reasoning:solve guard', () => {
  test('a rejecting reasoning.solve resolves to null (no unhandled rejection)', async () => {
    const handler = handlerFor('reasoning:solve', {
      reasoning: { solve: async () => { throw new Error('boom'); } },
      memory: {}, selfModel: {},
    });
    const result = await handler({ task: 't' });
    assertEqual(result, null, 'reject must become null');
  });

  test('a resolving reasoning.solve passes its value through', async () => {
    const handler = handlerFor('reasoning:solve', {
      reasoning: { solve: async () => ({ answer: 42 }) },
      memory: {}, selfModel: {},
    });
    const result = await handler({ task: 't' });
    assert(result && result.answer === 42, 'success value must pass through');
  });
});

if (require.main === module) run();
