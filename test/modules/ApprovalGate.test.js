#!/usr/bin/env node
// Test: ApprovalGate — approval lifecycle extracted from AgentLoop
const { describe, test, assert, assertEqual, run } = require('../harness');
const { createBus } = require('../../src/agent/core/EventBus');
const { ApprovalGate } = require('../../src/agent/revolution/ApprovalGate');

function create(overrides = {}) {
  return new ApprovalGate({ bus: createBus(), ...overrides });
}

describe('ApprovalGate', () => {

  test('initially not pending', () => {
    const gate = create();
    assertEqual(gate.isPending, false);
    assertEqual(gate.pendingAction, null);
  });

  test('request creates pending state', async () => {
    const gate = create({ timeoutMs: 5000 });
    const p = gate.request('test-action', 'Do something');
    assert(gate.isPending, 'should be pending');
    assertEqual(gate.pendingAction.action, 'test-action');
    gate.approve();
    const result = await p;
    assertEqual(result, true);
  });

  test('approve resolves with true', async () => {
    const gate = create({ timeoutMs: 5000 });
    const p = gate.request('write', 'Write a file');
    gate.approve();
    assertEqual(await p, true);
    assertEqual(gate.isPending, false);
  });

  test('reject resolves with false', async () => {
    const gate = create({ timeoutMs: 5000 });
    const p = gate.request('write', 'Write a file');
    gate.reject('Nope');
    assertEqual(await p, false);
    assertEqual(gate.isPending, false);
  });

  test('cancel resolves with false', async () => {
    const gate = create({ timeoutMs: 5000 });
    const p = gate.request('write', 'Write a file');
    gate.cancel();
    assertEqual(await p, false);
  });

  test('timeout auto-rejects', async () => {
    const gate = create({ timeoutMs: 50 }); // 50ms timeout
    const result = await gate.request('slow', 'Will timeout');
    assertEqual(result, false);
  });

  test('trust system auto-approves', async () => {
    const trustLevelSystem = {
      checkApproval: (action) => ({ approved: true, reason: 'trust level 3' }),
    };
    const bus = createBus();
    let autoApproved = null;
    bus.on('agent-loop:auto-approved', (data) => { autoApproved = data; });
    const gate = new ApprovalGate({ bus, trustLevelSystem, timeoutMs: 5000 });
    const result = await gate.request('write', 'Auto-approved action');
    assertEqual(result, true);
    assertEqual(gate.isPending, false); // never entered pending
    assert(autoApproved !== null, 'should emit auto-approved');
    assertEqual(autoApproved.action, 'write');
  });

  test('trust system does not auto-approve low trust', async () => {
    const trustLevelSystem = {
      checkApproval: () => ({ approved: false, reason: 'trust too low' }),
    };
    const gate = new ApprovalGate({ bus: createBus(), trustLevelSystem, timeoutMs: 100 });
    const p = gate.request('dangerous', 'Needs approval');
    assert(gate.isPending, 'should be pending when trust rejects');
    // Let it timeout
    assertEqual(await p, false);
  });

  test('emits approval-needed event', async () => {
    const bus = createBus();
    let event = null;
    bus.on('agent-loop:approval-needed', (data) => { event = data; });
    const gate = new ApprovalGate({ bus, timeoutMs: 5000 });
    gate.currentGoalId = 'goal-123';
    const p = gate.request('shell', 'Run npm test');
    assert(event !== null, 'should emit approval-needed');
    assertEqual(event.action, 'shell');
    assertEqual(event.goalId, 'goal-123');
    gate.approve();
    await p;
  });

  test('approve is no-op when nothing pending', () => {
    const gate = create();
    gate.approve(); // should not throw
  });

  test('reject is no-op when nothing pending', () => {
    const gate = create();
    gate.reject('test'); // should not throw
  });
});

run();
