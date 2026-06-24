// ============================================================
// v7.9.27 — continuation telemetry sink.
//
// ContinuationLoop emitted llm:continuation-round and -failed, but
// nothing consumed them, so a model that ran its whole round budget
// without completing left no persisted trace. A wire-level sink now
// records each round (done-reason, structural reason, per-round
// deltaChars, verdict) and each failure (reason, attempts) to
// continuation-telemetry.json.
// deltaChars (not tokens): the -round payload carries no token count.
//
// A round carries two independent signals: doneReason is what the model
// reported ('stop'/'length'), reason is why the completeness check still
// rejected the round (e.g. an unbalanced structure). The sink keeps them
// in separate fields so a 'stop' that never completed stays diagnosable.
// ============================================================

'use strict';

const path = require('path');
const { describe, test, run, assert, assertEqual } = require('../harness');

const ROOT = path.join(__dirname, '../..');
const { AgentCoreWire } = require(path.join(ROOT, 'src/agent/AgentCoreWire'));
const { EventBus } = require(path.join(ROOT, 'src/agent/core/EventBus'));

const FILE = 'continuation-telemetry.json';

function mockStorage() {
  const data = {};
  return {
    _data: data,
    readJSON: (f, dflt) => (f in data ? data[f] : dflt),
    writeJSON: (f, value) => { data[f] = value; },
  };
}

function wire() {
  const bus = new EventBus();
  const storage = mockStorage();
  const container = {
    has: (n) => n === 'storage',
    resolve: (n) => (n === 'storage' ? storage : null),
    tryResolve: () => null,
  };
  const w = new AgentCoreWire({ container, _bus: bus });
  w._wireEventHandlers();
  return { bus, storage };
}

describe('v7.9.27 — continuation telemetry sink', () => {
  test('a continuation-round is persisted with deltaChars / doneReason / verdict', () => {
    const { bus, storage } = wire();
    bus.emit('llm:continuation-round', {
      model: 'kimi', attempt: 3, doneReason: 'length', deltaChars: 512, verdict: 'incomplete',
    });
    const file = storage._data[FILE];
    assert(file && Array.isArray(file.records) && file.records.length === 1, 'one record persisted');
    const rec = file.records[0];
    assertEqual(rec.event, 'round');
    assertEqual(rec.model, 'kimi');
    assertEqual(rec.attempt, 3);
    assertEqual(rec.deltaChars, 512);
    assertEqual(rec.doneReason, 'length');
    assertEqual(rec.verdict, 'incomplete');
  });

  test('a round keeps doneReason and structural reason in separate fields', () => {
    const { bus, storage } = wire();
    bus.emit('llm:continuation-round', {
      model: 'kimi', attempt: 7, doneReason: 'stop', reason: 'json:unbalanced-braces',
      deltaChars: 0, verdict: 'incomplete',
    });
    const rec = storage._data[FILE].records[0];
    assertEqual(rec.doneReason, 'stop');
    assertEqual(rec.reason, 'json:unbalanced-braces');
    assertEqual(rec.verdict, 'incomplete');
  });

  test('a continuation-failed maps attempts→attempt and keeps its reason (doneReason null)', () => {
    const { bus, storage } = wire();
    bus.emit('llm:continuation-failed', { model: 'kimi', attempts: 10, reason: 'max-continuations' });
    const recs = storage._data[FILE].records;
    assertEqual(recs.length, 1);
    assertEqual(recs[0].event, 'failed');
    assertEqual(recs[0].attempt, 10);
    assertEqual(recs[0].reason, 'max-continuations');
    assertEqual(recs[0].doneReason, null);
  });

  test('records accumulate across events', () => {
    const { bus, storage } = wire();
    bus.emit('llm:continuation-round', { model: 'm', attempt: 1, deltaChars: 10 });
    bus.emit('llm:continuation-round', { model: 'm', attempt: 2, deltaChars: 20 });
    bus.emit('llm:continuation-failed', { model: 'm', attempts: 3, reason: 'x' });
    assertEqual(storage._data[FILE].records.length, 3);
  });
});

if (require.main === module) run();
