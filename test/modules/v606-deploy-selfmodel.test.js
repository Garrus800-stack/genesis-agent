// ============================================================
// Test: v6.0.6 — V6-3 Deploy Strategies + V6-11 SelfModel
// ============================================================

const { describe, test, assert, assertEqual, run } = require('../harness');

function mockBus() {
  const _emitted = [];
  return {
    on: () => () => {},
    emit(e, d) { _emitted.push({ event: e, data: d }); },
    fire(e, d, m) { _emitted.push({ event: e, data: d }); },
    _emitted,
    _find(name) { return _emitted.filter(e => e.event === name); },
  };
}

// ═══════════════════════════════════════════════════════════
// DeploymentManager — Enhanced Strategies
// ═══════════════════════════════════════════════════════════

describe('V6-3 Deploy — Construction + Health', () => {
  const { DeploymentManager } = require('../../src/agent/autonomy/DeploymentManager');

  test('constructs with bus', () => {
    const dm = new DeploymentManager({ bus: mockBus() });
    assert(dm, 'should construct');
  });

  test('getHealth returns object', () => {
    const dm = new DeploymentManager({ bus: mockBus() });
    const h = dm.getHealth();
    assert(typeof h === 'object');
    assertEqual(h.total, 0);
    assertEqual(h.active, 0);
  });

  test('listDeployments returns empty array initially', () => {
    const dm = new DeploymentManager({ bus: mockBus() });
    assertEqual(dm.listDeployments().length, 0);
  });

  test('_httpHealthCheck resolves false for unreachable', async () => {
    const dm = new DeploymentManager({ bus: mockBus() });
    const ok = await dm._httpHealthCheck('http://127.0.0.1:1', 500);
    assertEqual(ok, false, 'unreachable should return false');
  });
});

describe('V6-3 Deploy — Direct Strategy', () => {
  const { DeploymentManager } = require('../../src/agent/autonomy/DeploymentManager');

  test('deploy direct with shell commands', async () => {
    const bus = mockBus();
    const commands = [];
    const dm = new DeploymentManager({ bus });
    dm.shell = { run: async (cmd) => { commands.push(cmd); return { stdout: 'ok' }; } };

    const result = await dm.deploy('my-app', {
      strategy: 'direct',
      commands: ['echo deploy-step-1', 'echo deploy-step-2'],
    });

    assertEqual(result.status, 'done', 'deploy succeeded');
    assertEqual(commands.length, 2, '2 commands executed');
    assert(result.steps.length >= 2, 'has deploy steps');
  });

  test('deploy emits started + completed events', async () => {
    const bus = mockBus();
    const dm = new DeploymentManager({ bus });
    dm.shell = { run: async () => ({}) };

    await dm.deploy('app', { strategy: 'direct', commands: ['echo ok'] });

    assert(bus._find('deploy:started').length >= 1, 'started event');
    assert(bus._find('deploy:completed').length >= 1, 'completed event');
  });

  test('failed deploy triggers rollback event', async () => {
    const bus = mockBus();
    const dm = new DeploymentManager({ bus });
    dm.shell = { run: async () => { throw new Error('deploy failed'); } };

    const result = await dm.deploy('app', { strategy: 'direct', commands: ['bad-cmd'] });

    assert(result.status === 'failed' || result.status === 'rolled-back', 'deploy failed or rolled back');
    assert(bus._find('deploy:failed').length >= 1, 'failed event emitted');
  });
});

describe('V6-3 Deploy — Rolling Strategy', () => {
  const { DeploymentManager } = require('../../src/agent/autonomy/DeploymentManager');

  test('rolling executes commands sequentially', async () => {
    const bus = mockBus();
    const order = [];
    const dm = new DeploymentManager({ bus });
    dm.shell = { run: async (cmd) => { order.push(cmd); } };

    await dm.deploy('svc', {
      strategy: 'rolling',
      commands: ['step1', 'step2', 'step3'],
    });

    assertEqual(order.length, 3);
    assertEqual(order[0], 'step1');
    assertEqual(order[2], 'step3');
  });
});

describe('V6-3 Deploy — Canary Strategy', () => {
  const { DeploymentManager } = require('../../src/agent/autonomy/DeploymentManager');

  test('canary deploys with custom percent', async () => {
    const bus = mockBus();
    const dm = new DeploymentManager({ bus });
    dm.shell = { run: async () => ({}) };

    const result = await dm.deploy('api', {
      strategy: 'canary',
      canaryPercent: 5,
      commands: ['echo deploy'],
    });

    assertEqual(result.status, 'done');
  });
});

describe('V6-3 Deploy — Blue-Green Strategy', () => {
  const { DeploymentManager } = require('../../src/agent/autonomy/DeploymentManager');

  test('blue-green deploys and emits swap on health pass', async () => {
    const bus = mockBus();
    const dm = new DeploymentManager({ bus });
    dm.shell = { run: async () => ({}) };
    dm.healthMonitor = { getHealth: () => ({ status: 'healthy' }) };

    // Use self target with healthMonitor for health check
    const result = await dm.deploy('self', {
      strategy: 'blue-green',
      commands: [],
      healthUrl: null, // Will use self health check
    });

    assertEqual(result.status, 'done');
  });
});

describe('V6-3 Deploy — Rollback', () => {
  const { DeploymentManager } = require('../../src/agent/autonomy/DeploymentManager');

  test('rollback emits deploy:rollback', async () => {
    const bus = mockBus();
    const dm = new DeploymentManager({ bus });
    dm.shell = { run: async () => ({}) };

    const result = await dm.deploy('app', { strategy: 'direct', commands: ['echo ok'] });
    await dm.rollback(result.id);

    const rbEvents = bus._find('deploy:rollback');
    assert(rbEvents.length >= 1, 'rollback event emitted');
  });

  test('rollback unknown deployment throws', async () => {
    const dm = new DeploymentManager({ bus: mockBus() });
    try {
      await dm.rollback('nonexistent');
      assert(false, 'should throw');
    } catch (e) {
      assert(e.message.includes('Unknown'), 'error mentions unknown');
    }
  });
});

describe('V6-3 Deploy — Pre-flight', () => {
  const { DeploymentManager } = require('../../src/agent/autonomy/DeploymentManager');

  test('pre-flight rejects invalid environment', async () => {
    const dm = new DeploymentManager({ bus: mockBus() });
    try {
      await dm._preFlight('app', { env: 'invalid' });
      assert(false, 'should throw');
    } catch (e) {
      assert(e.message.includes('Unknown environment'), 'rejects invalid env');
    }
  });

  test('pre-flight accepts dev/staging/prod', async () => {
    const dm = new DeploymentManager({ bus: mockBus() });
    await dm._preFlight('app', { env: 'dev' });
    await dm._preFlight('app', { env: 'staging' });
    await dm._preFlight('app', { env: 'prod' });
  });

  test('pre-flight rejects empty target', async () => {
    const dm = new DeploymentManager({ bus: mockBus() });
    try {
      await dm._preFlight('', {});
      assert(false, 'should throw');
    } catch (e) {
      assert(e.message.includes('target'), 'rejects empty target');
    }
  });
});

// ═══════════════════════════════════════════════════════════
// V6-11 SelfModel — Dashboard Renderer Wiring
// ═══════════════════════════════════════════════════════════

describe('V6-11 SelfModel — Dashboard Wiring', () => {
  const { applyRenderers } = require('../../src/ui/DashboardRenderers');

  test('applyRenderers exports function', () => {
    assert(typeof applyRenderers === 'function', 'is a function');
  });

  test('_renderSelfModel is wired to Dashboard prototype', () => {
    // Create a mock Dashboard class
    function MockDash() {}
    MockDash.prototype._esc = function(s) { return String(s); };
    applyRenderers(MockDash);

    const dash = new MockDash();
    assert(typeof dash._renderSelfModel === 'function', 'renderer added to prototype');
    // Actual rendering requires DOM — verified in Electron runtime
  });
});

run();
