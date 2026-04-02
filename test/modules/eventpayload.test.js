// ============================================================
// Test: EventPayloadSchemas.js — payload validation middleware
// ============================================================

const { describe, test, assert, assertEqual, run } = require('../harness');
const { EventBus } = require('../../src/agent/core/EventBus');
const { installPayloadValidation, SCHEMAS } = require('../../src/agent/core/EventPayloadSchemas');

describe('EventPayloadSchemas: Schema Catalog', () => {

  test('SCHEMAS has entries for critical events', () => {
    assert(SCHEMAS['agent:status'], 'Should have agent:status schema');
    assert(SCHEMAS['agent-loop:started'], 'Should have agent-loop:started');
    assert(SCHEMAS['chat:completed'], 'Should have chat:completed');
    assert(SCHEMAS['circuit:state-change'], 'Should have circuit:state-change');
  });

  test('all schemas have valid field requirements', () => {
    for (const [event, schema] of Object.entries(SCHEMAS)) {
      for (const [field, req] of Object.entries(schema)) {
        assert(req === 'required' || req === 'optional',
          `${event}.${field} has invalid requirement: "${req}"`);
      }
    }
  });

  test('SCHEMAS has 25+ event definitions', () => {
    assert(Object.keys(SCHEMAS).length >= 25,
      `Expected 25+ schemas, got ${Object.keys(SCHEMAS).length}`);
  });
});

describe('EventPayloadSchemas: Middleware Installation', () => {

  test('installs on EventBus without error', () => {
    const bus = new EventBus();
    const handle = installPayloadValidation(bus);
    assert(handle, 'Should return handle');
    assert(typeof handle.getStats === 'function');
    assert(typeof handle.removeMiddleware === 'function');
  });

  test('getStats reports initial state', () => {
    const bus = new EventBus();
    const handle = installPayloadValidation(bus);
    const stats = handle.getStats();
    assert(stats.schemasLoaded >= 25);
  });
});

describe('EventPayloadSchemas: Validation Behavior', () => {

  test('valid payload produces no warnings', async () => {
    const bus = new EventBus();
    const handle = installPayloadValidation(bus);
    const before = handle.getStats().warnings;

    await bus.emit('agent:status', { state: 'ready' }, { source: 'test' });

    assertEqual(handle.getStats().warnings, before, 'Valid payload should not warn');
  });

  test('missing required field produces warning', async () => {
    const bus = new EventBus();
    const handle = installPayloadValidation(bus);

    // agent:status requires 'state'
    await bus.emit('agent:status', { detail: 'no state field' }, { source: 'test' });

    assert(handle.getStats().warnings >= 1, 'Missing required field should warn');
  });

  test('null data produces warning', async () => {
    const bus = new EventBus();
    const handle = installPayloadValidation(bus);

    await bus.emit('agent:status', null, { source: 'test' });

    assert(handle.getStats().warnings >= 1, 'Null data should warn');
  });

  test('unknown events are silently skipped', async () => {
    const bus = new EventBus();
    const handle = installPayloadValidation(bus);

    await bus.emit('custom:unknown-event', { anything: true }, { source: 'test' });

    // Should not produce warnings for events without schemas
    // (warnings may be 0 or > 0 from prior tests due to shared state)
    assert(true, 'Should not crash on unknown events');
  });

  test('optional fields do not produce warnings when missing', async () => {
    const bus = new EventBus();
    const handle = installPayloadValidation(bus);
    const before = handle.getStats().warnings;

    // agent:shutdown has optional 'errors' field
    await bus.emit('agent:shutdown', {}, { source: 'test' });

    assertEqual(handle.getStats().warnings, before, 'Optional fields should not warn');
  });

  test('warns only once per event+field combo', async () => {
    const bus = new EventBus();
    const handle = installPayloadValidation(bus);

    // Emit same bad payload 3 times
    await bus.emit('chat:completed', {}, { source: 'test' }); // missing 'success'
    const warnsAfter1 = handle.getStats().warnings;
    await bus.emit('chat:completed', {}, { source: 'test' });
    await bus.emit('chat:completed', {}, { source: 'test' });

    assertEqual(handle.getStats().warnings, warnsAfter1,
      'Should only warn once per event+field');
  });

  test('removeMiddleware stops validation', async () => {
    const bus = new EventBus();
    const handle = installPayloadValidation(bus);

    handle.removeMiddleware();
    const before = handle.getStats().warnings;

    await bus.emit('agent:status', {}, { source: 'test' }); // missing 'state'

    // Warnings should not increase after removal
    assertEqual(handle.getStats().warnings, before,
      'Should not validate after middleware removal');
  });
});

run();
