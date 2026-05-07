// ============================================================
// GENESIS — test/modules/v763-eventstore-corruption-telemetry.test.js
//
// Regression test for v7.6.3 L3 finding: EventStore._readLog had a
// truly-silent catch around per-line JSON.parse that dropped corrupted
// rows with no observability. The fix counts them on
// this._corruptedRowsSkipped and fires `eventstore:corrupted-row` per
// affected line so audits and dashboards can detect log-integrity drift.
// ============================================================

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const { describe, test, assert, run } = require('../harness');

const ROOT = path.resolve(__dirname, '..', '..');

describe('v7.6.3 L3 — EventStore corruption telemetry', () => {

  test('source-presence: counter + bus.fire are wired in _readLog', () => {
    const src = fs.readFileSync(
      path.join(ROOT, 'src/agent/foundation/EventStore.js'), 'utf8');
    assert(/_corruptedRowsSkipped/.test(src),
      'corruption counter must be present');
    assert(/eventstore:corrupted-row/.test(src),
      'eventstore:corrupted-row event must be fired');
  });

  test('catalog: EVENTS.EVENTSTORE.CORRUPTED_ROW exists', () => {
    const { EVENTS } = require(path.join(ROOT, 'src/agent/core/EventTypes.js'));
    assert(EVENTS.EVENTSTORE && EVENTS.EVENTSTORE.CORRUPTED_ROW === 'eventstore:corrupted-row',
      'catalog entry missing');
  });

  test('schema: eventstore:corrupted-row payload schema exists', () => {
    const { SCHEMAS } = require(path.join(ROOT, 'src/agent/core/EventPayloadSchemas.js'));
    const s = SCHEMAS['eventstore:corrupted-row'];
    assert(s, 'schema missing');
    assert(s.file === 'required' && s.line === 'required' && s.error === 'required' && s.total === 'required',
      'schema fields incomplete');
  });

  test('behavior: malformed JSONL rows fire one event each + bump counter', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'genesis-eventstore-test-'));
    const logPath = path.join(tmpDir, 'events.jsonl');
    // 3 valid + 2 broken lines
    fs.writeFileSync(logPath, [
      JSON.stringify({ id: 0, type: 'AGENT_LOOP_STARTED', timestamp: 1, hash: 'a', prevHash: '0', payload: {} }),
      'this is not json',
      JSON.stringify({ id: 1, type: 'CHAT_MESSAGE', timestamp: 2, hash: 'b', prevHash: 'a', payload: {} }),
      '{"broken-json',
      JSON.stringify({ id: 2, type: 'AGENT_LOOP_COMPLETE', timestamp: 3, hash: 'c', prevHash: 'b', payload: {} }),
    ].join('\n'));

    const fired = [];
    const stubBus = {
      fire: (event, payload) => fired.push({ event, payload }),
      on: () => () => {},
    };

    const { EventStore } = require(path.join(ROOT, 'src/agent/foundation/EventStore.js'));
    // Constructor signature is (storageDir, bus, storage, opts)
    // _loadLastHash() in the constructor already calls _readLog, which means
    // the corrupted-row events fire once at boot. Reset and call explicitly
    // so the test isolates a single _readLog invocation.
    const es = new EventStore(tmpDir, stubBus, null);
    es._corruptedRowsSkipped = 0;
    fired.length = 0;
    const events = es._readLog();

    assert(events.length === 3, `expected 3 valid events, got ${events.length}`);
    assert(es._corruptedRowsSkipped === 2, `counter should be 2, got ${es._corruptedRowsSkipped}`);

    const corruptionEvents = fired.filter(e => e.event === 'eventstore:corrupted-row');
    assert(corruptionEvents.length === 2, `expected 2 fire events, got ${corruptionEvents.length}`);
    assert(corruptionEvents[0].payload.line === 1, 'first corrupted row was line 1');
    assert(corruptionEvents[1].payload.line === 3, 'second corrupted row was line 3');
    assert(corruptionEvents[0].payload.total === 1, 'cumulative total starts at 1');
    assert(corruptionEvents[1].payload.total === 2, 'cumulative total grows');

    // Cleanup
    fs.unlinkSync(logPath);
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
  });

  test('behavior: clean log fires nothing, counter stays undefined or 0', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'genesis-eventstore-clean-'));
    const logPath = path.join(tmpDir, 'events.jsonl');
    fs.writeFileSync(logPath,
      JSON.stringify({ id: 0, type: 'AGENT_LOOP_STARTED', timestamp: 1, hash: 'a', prevHash: '0', payload: {} }) + '\n');

    const fired = [];
    const stubBus = {
      fire: (event, payload) => fired.push({ event, payload }),
      on: () => () => {},
    };

    const { EventStore } = require(path.join(ROOT, 'src/agent/foundation/EventStore.js'));
    const es = new EventStore(tmpDir, stubBus, null);
    es._readLog();

    const corruption = fired.filter(e => e.event === 'eventstore:corrupted-row');
    assert(corruption.length === 0, 'no corruption events on clean log');
    assert(!es._corruptedRowsSkipped, 'counter should not be incremented');

    fs.unlinkSync(logPath);
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
  });
});

run();
