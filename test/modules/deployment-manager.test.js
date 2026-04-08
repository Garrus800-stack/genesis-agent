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
    // v7.0.2: rollback is unavailable (placeholder snapshot), not silently rolled-back
    assert(d.status === 'rollback-unavailable' || d.status === 'failed');
    assert(d.error.includes('Unknown environment'));
  });
});

describe('DeploymentManager — Rollback', () => {
  test('auto-rollback refuses on placeholder snapshot (fail-honest)', async () => {
    const dm = createDM({ shell: mockShell('bad-cmd') });
    await dm.boot();
    const d = await dm.deploy('svc', { commands: ['bad-cmd'] });
    // v7.0.2: placeholder snapshot → rollback-unavailable, not silently rolled-back
    assertEqual(d.status, 'rollback-unavailable');
  });

  test('manual rollback refuses on placeholder snapshot', async () => {
    const dm = createDM();
    await dm.boot();
    const d = await dm.deploy('svc', { commands: ['npm restart'] });
    assertEqual(d.status, 'done');
    try {
      await dm.rollback(d.id);
      assert(false, 'Should have thrown');
    } catch (err) {
      assert(err.message.includes('placeholder'), 'Should mention placeholder');
    }
    assertEqual(dm.getDeployment(d.id).status, 'rollback-unavailable');
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
    // v7.0.2: health check fails → rollback attempted → placeholder → rollback-unavailable
    assert(d.status === 'rollback-unavailable' || d.status === 'failed');
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

describe('DeploymentManager — Fail-Honest (v7.0.2)', () => {
  test('snapshot is marked as placeholder', async () => {
    const dm = createDM();
    await dm.boot();
    const d = await dm.deploy('svc', { commands: ['echo'] });
    // Access internal snapshot before rollback cleans it up
    // After successful deploy, snapshot still exists
    const snap = dm._rollbackSnapshots.get(d.id);
    assert(snap, 'Snapshot should exist after deploy');
    assertEqual(snap.placeholder, true);
  });

  test('rollback-unavailable fires event', async () => {
    const bus = mockBus();
    const dm = new DeploymentManager({
      bus, shell: mockShell('fail'), healthMonitor: mockHealthMonitor(), hotReloader: mockHotReloader(),
    });
    await dm.boot();
    await dm.deploy('svc', { commands: ['fail'] });
    const rbEvents = bus._fired.filter(e => e.evt === 'deploy:rollback-unavailable');
    assertEqual(rbEvents.length, 1);
    assert(rbEvents[0].data.reason.includes('placeholder'), 'Should explain why');
    assertEqual(rbEvents[0].data.target, 'svc');
  });

  test('getHealth counts rollback-unavailable', async () => {
    const dm = createDM({ shell: mockShell('x') });
    await dm.boot();
    await dm.deploy('svc', { commands: ['x'] });
    const h = dm.getHealth();
    assertEqual(h.rollbackUnavailable, 1);
    assertEqual(h.rolledBack, 0);
  });

  test('real snapshot (non-placeholder) would allow rollback', async () => {
    // Simulate a future real snapshot by manually setting placeholder=false
    const dm = createDM();
    await dm.boot();
    const d = await dm.deploy('svc', { commands: ['echo'] });
    // Manually patch snapshot to simulate real backup (V7-4B)
    dm._rollbackSnapshots.set(d.id, {
      backup: { target: 'svc', createdAt: Date.now() },
      timestamp: Date.now(),
      placeholder: false,
    });
    await dm.rollback(d.id);
    assertEqual(dm.getDeployment(d.id).status, 'rolled-back');
  });
});

run();
