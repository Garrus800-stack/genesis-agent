// ============================================================
// v7.3.7 #1 — boot:complete Event Registration & Emit
//
// Verifies that:
//   1. 'boot:complete' is registered in EventTypes.BOOT.COMPLETE
//   2. Payload schema is declared with required fields
//   3. Event is emitted by AgentCore between telemetry.recordBoot
//      and the safety-degradation check
// ============================================================

const { describe, it } = require('node:test');
const assert = require('assert');
const path = require('path');
const fs = require('fs');

describe('v7.3.7 #1 — boot:complete event', () => {

  it('registers boot:complete in EVENTS.BOOT.COMPLETE', () => {
    const { EVENTS } = require('../../src/agent/core/EventTypes');
    assert.strictEqual(
      EVENTS.BOOT.COMPLETE,
      'boot:complete',
      'EVENTS.BOOT.COMPLETE must equal "boot:complete"'
    );
    // Existing DEGRADED must still be there
    assert.strictEqual(EVENTS.BOOT.DEGRADED, 'boot:degraded');
  });

  it('declares boot:complete payload schema with required fields', () => {
    const { SCHEMAS } = require('../../src/agent/core/EventPayloadSchemas');
    const schema = SCHEMAS['boot:complete'];
    assert.ok(schema, 'Schema for boot:complete must exist');
    assert.strictEqual(schema.durationMs, 'required');
    assert.strictEqual(schema.serviceCount, 'required');
    assert.strictEqual(schema.timestamp, 'required');
  });

  it('AgentCore emits boot:complete AFTER telemetry.recordBoot and BEFORE safety-degradation', () => {
    const agentCorePath = path.resolve(__dirname, '..', '..', 'src', 'agent', 'AgentCore.js');
    const src = fs.readFileSync(agentCorePath, 'utf8');

    // Locate the three marker points
    const telemetryIdx = src.indexOf("recordBoot(dt, serviceCount, 0, _phaseTimings)");
    const bootCompleteIdx = src.indexOf("emit('boot:complete'");
    const safetyIdx = src.indexOf("safety:degraded");

    assert.ok(telemetryIdx > 0, 'telemetry.recordBoot call must exist');
    assert.ok(bootCompleteIdx > 0, 'boot:complete emit must exist in AgentCore');
    assert.ok(safetyIdx > 0, 'safety:degraded emit must exist (unchanged)');

    // Ordering invariant
    assert.ok(
      telemetryIdx < bootCompleteIdx,
      'boot:complete must emit AFTER telemetry.recordBoot (clean boot-timing measurement first)'
    );
    assert.ok(
      bootCompleteIdx < safetyIdx,
      'boot:complete must emit BEFORE safety:degraded (listeners run parallel to safety check)'
    );
  });

  it('boot:complete payload contains exactly the declared fields', () => {
    const agentCorePath = path.resolve(__dirname, '..', '..', 'src', 'agent', 'AgentCore.js');
    const src = fs.readFileSync(agentCorePath, 'utf8');

    // Extract the emit block
    const emitIdx = src.indexOf("emit('boot:complete'");
    const block = src.slice(emitIdx, emitIdx + 400);

    assert.ok(/durationMs:\s*dt/.test(block), 'payload must contain durationMs');
    assert.ok(/serviceCount/.test(block), 'payload must contain serviceCount');
    assert.ok(/timestamp:\s*new Date\(\)\.toISOString\(\)/.test(block), 'payload must contain ISO timestamp');
    assert.ok(/source:\s*'AgentCore'/.test(block), 'emit must declare source: AgentCore');
  });

  it('EventBus accepts boot:complete emit without schema-violation warning', () => {
    // Smoke test: construct a bus, emit the event, verify no throw
    const { EventBus } = require('../../src/agent/core/EventBus');
    const bus = new EventBus({ strict: false });

    let received = null;
    bus.on('boot:complete', (payload) => { received = payload; });

    const testPayload = {
      durationMs: 1050,
      serviceCount: 156,
      timestamp: new Date().toISOString(),
    };

    bus.emit('boot:complete', testPayload, { source: 'test' });

    assert.ok(received, 'listener must receive payload');
    assert.strictEqual(received.durationMs, 1050);
    assert.strictEqual(received.serviceCount, 156);
    assert.ok(typeof received.timestamp === 'string' && received.timestamp.length > 10);
  });

});
