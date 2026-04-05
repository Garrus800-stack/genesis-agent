// ============================================================
// GENESIS — test/modules/deployment-manager.test.js (v5.9.2)
//
// Tests DeploymentManager: strategies, health checks, rollback,
// step tracking, pre-flight, snapshots.
// ============================================================

const { describe, test, assert, assertEqual, assertRejects, run } = require('../harness');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const { DeploymentManager } = require(path.join(ROOT, 'src/agent/autonomy/DeploymentManager'));

// ── Mocks ───────────────────────────────────────────────────

function mockBus() {
  const fired = [];
  return {
    on: () => {},
    fire: (evt, data) => fired.push({ evt, data }),
    emit: () => {},
    _fired: fired,
  };
}

function mockShell(failOnCmd) {
  return {
    run: async (cmd) => {
      if (failOnCmd && cmd.includes(failOnCmd)) throw new Error(`Shell failed: ${cmd}`);
      return { stdout: 'ok', stderr: '' };
    },
  };
}

function mockHealthMonitor(healthy = true) {
  return { getHealth: () => ({ status: healthy ? 'ok' : 'critical' }) };
}

function mockHotReloader() {
  const reloaded = [];
  return { reload: async (file) => reloaded.push(file), _reloaded: reloaded };
}

function createDM(overrides = {}) {
  const bus = overrides.bus || mockBus();
  return new DeploymentManager({
    bus,
    shell: overrides.shell || mockShell(),
    healthMonitor: overrides.healthMonitor || mockHealthMonitor(),
    hotReloader: overrides.hotReloader || mockHotReloader(),
    config: overrides.config,
  });
}

// ── Tests ───────────────────────────────────────────────────

describe('DeploymentManager — Construction', () => {
  test('creates with defaults', () => {
    const dm = createDM();
    assertEqual(dm.META.id, 'deploymentManager');
    assertEqual(dm.config.defaultStrategy, 'direct');
    assertEqual(dm.config.maxRetries, 2);
  });

  test('accepts config', () => {
    const dm = createDM({ config: { defaultStrategy: 'rolling', healthTimeoutMs: 5000 } });
    assertEqual(dm.config.defaultStrategy, 'rolling');
    assertEqual(dm.config.healthTimeoutMs, 5000);
  });
});

describe('DeploymentManager — Direct Deploy', () => {
  test('deploys with shell commands', async () => {
    const dm = createDM();
    await dm.boot();
    const d = await dm.deploy('my-service', { commands: ['npm restart'] });
    assertEqual(d.status, 'done');
    assertEqual(d.target, 'my-service');
    assert(d.steps.length >= 3, 'Should have multiple steps');
    assert(d.steps.every(s => s.status === 'passed'), 'All steps should pass');
    assert(d.completedAt >= d.startedAt, 'Should have timing');
  });

  test('self-deploy uses HotReloader', async () => {
    const hr = mockHotReloader();
    const dm = createDM({ hotReloader: hr });
    await dm.boot();
    const d = await dm.deploy('self', { files: ['a.js', 'b.js'] });
    assertEqual(d.status, 'done');
    assertEqual(hr._reloaded.length, 2);
  });
});

describe('DeploymentManager — Strategies', () => {
  test('canary strategy', async () => {
    const dm = createDM();
    await dm.boot();
    const d = await dm.deploy('svc', { strategy: 'canary', commands: ['deploy canary'] });
    assertEqual(d.status, 'done');
    assertEqual(d.strategy, 'canary');
  });

  test('rolling strategy', async () => {
    const dm = createDM();
    await dm.boot();
    const d = await dm.deploy('svc', { strategy: 'rolling', commands: ['step1', 'step2'] });
    assertEqual(d.status, 'done');
    assertEqual(d.strategy, 'rolling');
  });

  test('blue-green strategy', async () => {
    const dm = createDM();
    await dm.boot();
    const d = await dm.deploy('svc', { strategy: 'blue-green', commands: ['swap'] });
    assertEqual(d.status, 'done');
  });
});

describe('DeploymentManager — Pre-flight', () => {
  test('rejects empty target', async () => {
    const dm = createDM();
    await dm.boot();
    const d = await dm.deploy('', {});
    // Pre-flight fails before snapshot is created → rollback has no snapshot → status 'failed'
    assertEqual(d.status, 'failed');
    assert(d.error.includes('target is required'));
  });

  test('rejects unknown environment', async () => {
    const dm = createDM();
    await dm.boot();
    const d = await dm.deploy('svc', { env: 'moon' });
    assert(d.status === 'rolled-back' || d.status === 'failed');
    assert(d.error.includes('Unknown environment'));
  });
});

describe('DeploymentManager — Rollback', () => {
  test('auto-rollbacks on failure', async () => {
    const dm = createDM({ shell: mockShell('bad-cmd') });
    await dm.boot();
    const d = await dm.deploy('svc', { commands: ['bad-cmd'] });
    assertEqual(d.status, 'rolled-back');
  });

  test('manual rollback', async () => {
    const dm = createDM();
    await dm.boot();
    const d = await dm.deploy('svc', { commands: ['npm restart'] });
    assertEqual(d.status, 'done');
    await dm.rollback(d.id);
    assertEqual(dm.getDeployment(d.id).status, 'rolled-back');
  });

  test('rollback unknown deployment throws', async () => {
    const dm = createDM();
    try {
      await dm.rollback('nonexistent');
      assert(false, 'Should have thrown');
    } catch (err) {
      assert(err.message.includes('Unknown deployment'));
    }
  });
});

describe('DeploymentManager — Health Check', () => {
  test('fails on unhealthy target', async () => {
    const dm = createDM({ healthMonitor: mockHealthMonitor(false) });
    await dm.boot();
    const d = await dm.deploy('self', { files: ['x.js'] });
    // Health check fails → rollback
    assert(d.status === 'rolled-back' || d.status === 'failed');
  });
});

describe('DeploymentManager — Listing', () => {
  test('listDeployments returns recent', async () => {
    const dm = createDM();
    await dm.boot();
    await dm.deploy('a', { commands: ['echo'] });
    await dm.deploy('b', { commands: ['echo'] });
    await dm.deploy('c', { commands: ['echo'] });
    const list = dm.listDeployments(2);
    assertEqual(list.length, 2);
    assert(list[0].startedAt >= list[1].startedAt, 'Should be sorted newest first');
  });

  test('getDeployment returns null for unknown', () => {
    const dm = createDM();
    assertEqual(dm.getDeployment('nope'), null);
  });
});

describe('DeploymentManager — Health Snapshot', () => {
  test('reports deployment stats', async () => {
    const dm = createDM();
    await dm.boot();
    await dm.deploy('svc', { commands: ['echo'] });
    const h = dm.getHealth();
    assertEqual(h.total, 1);
    assertEqual(h.succeeded, 1);
    assertEqual(h.active, 0);
  });
});

describe('DeploymentManager — Events', () => {
  test('fires deploy:started and deploy:completed', async () => {
    const bus = mockBus();
    const dm = new DeploymentManager({
      bus, shell: mockShell(), healthMonitor: mockHealthMonitor(), hotReloader: mockHotReloader(),
    });
    await dm.boot();
    await dm.deploy('svc', { commands: ['echo'] });
    const events = bus._fired.map(e => e.evt);
    assert(events.includes('deploy:started'), 'Should fire started');
    assert(events.includes('deploy:completed'), 'Should fire completed');
  });

  test('fires deploy:failed on error', async () => {
    const bus = mockBus();
    const dm = new DeploymentManager({
      bus, shell: mockShell('fail'), healthMonitor: mockHealthMonitor(), hotReloader: mockHotReloader(),
    });
    await dm.boot();
    await dm.deploy('svc', { commands: ['fail'] });
    const events = bus._fired.map(e => e.evt);
    assert(events.includes('deploy:failed'), 'Should fire failed');
  });
});

run();
