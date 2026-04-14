// Genesis v7.1.9 — ExecutionProvenance.test.js
const { describe, test, assert, run } = require('../harness');
const { ExecutionProvenance } = require('../../src/agent/intelligence/ExecutionProvenance');

const mockBus = { on() {}, emit() {}, fire() {} };

describe('ExecutionProvenance', () => {
  test('beginTrace creates trace with input', () => {
    const ep = new ExecutionProvenance({ bus: mockBus });
    ep.start();
    const id = ep.beginTrace('hello world');
    assert(id, 'returns traceId');
    const trace = ep.getTrace(id);
    assert(trace, 'trace exists');
    assert(trace.input.message === 'hello world', 'message stored in input');
    assert(trace.timestamp > 0, 'timestamp set');
    ep.stop();
  });

  test('recordBudget attaches budget to trace', () => {
    const ep = new ExecutionProvenance({ bus: mockBus });
    ep.start();
    const id = ep.beginTrace('test');
    ep.recordBudget(id, { tier: 'standard', tokenBudget: 4000 });
    assert(ep.getTrace(id).budget, 'budget attached');
    ep.stop();
  });

  test('recordIntent updates trace intent', () => {
    const ep = new ExecutionProvenance({ bus: mockBus });
    ep.start();
    const id = ep.beginTrace('test');
    ep.recordIntent(id, { type: 'self-inspect', confidence: 0.9, method: 'regex' });
    assert(ep.getTrace(id).intent.type === 'self-inspect', 'intent type stored');
    ep.stop();
  });

  test('recordModel stores model info', () => {
    const ep = new ExecutionProvenance({ bus: mockBus });
    ep.start();
    const id = ep.beginTrace('test');
    ep.recordModel(id, { name: 'kimi-k2.5:cloud', backend: 'anthropic' });
    assert(ep.getTrace(id).model.name === 'kimi-k2.5:cloud', 'model stored');
    ep.stop();
  });

  test('endTrace finalizes trace with duration', () => {
    const ep = new ExecutionProvenance({ bus: mockBus });
    ep.start();
    const id = ep.beginTrace('test');
    ep.endTrace(id, { tokens: 100, outcome: 'success' });
    const trace = ep.getTrace(id);
    assert(trace.duration >= 0, 'duration set');
    assert(trace.response.outcome === 'success', 'response stored');
    ep.stop();
  });

  test('getRecentTraces returns traces', () => {
    const ep = new ExecutionProvenance({ bus: mockBus });
    ep.start();
    ep.beginTrace('a'); ep.beginTrace('b'); ep.beginTrace('c');
    const recent = ep.getRecentTraces(2);
    assert(recent.length === 2, 'returns 2');
    ep.stop();
  });

  test('getLastTrace returns last completed trace', () => {
    const ep = new ExecutionProvenance({ bus: mockBus });
    ep.start();
    const id1 = ep.beginTrace('first');
    ep.endTrace(id1, { tokens: 50, outcome: 'success' });
    ep.beginTrace('second');
    const last = ep.getLastTrace();
    assert(last.input.message === 'first', 'returns completed trace');
    ep.stop();
  });

  test('getActiveTrace returns uncompleted trace', () => {
    const ep = new ExecutionProvenance({ bus: mockBus });
    ep.start();
    const id = ep.beginTrace('active');
    assert(ep.getActiveTrace(), 'active trace found');
    ep.endTrace(id, { tokens: 10 });
    assert(!ep.getActiveTrace(), 'no active after end');
    ep.stop();
  });

  test('getTrace returns null for unknown id', () => {
    const ep = new ExecutionProvenance({ bus: mockBus });
    ep.start();
    assert(ep.getTrace('fake') === null, 'returns null');
    ep.stop();
  });

  test('recordBudget on unknown id does not throw', () => {
    const ep = new ExecutionProvenance({ bus: mockBus });
    ep.start();
    ep.recordBudget('fake', { tier: 'x' });
    assert(true, 'no throw');
    ep.stop();
  });
});

run();
