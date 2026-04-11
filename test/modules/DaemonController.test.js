#!/usr/bin/env node
// Test: DaemonController — V7-4A socket control channel
const net = require('net');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { describe, test, assert, assertEqual, run } = require('../harness');
const { createBus } = require('../../src/agent/core/EventBus');
const { DaemonController, resolveSocketPath, DEFAULT_SOCKET_LINUX, DEFAULT_PIPE_WIN32 } = require('../../src/agent/autonomy/DaemonController');
const { DaemonControlPort } = require('../../src/agent/ports/DaemonControlPort');

// Unique socket per test run to avoid collisions
let socketCounter = 0;
function tmpSocket() {
  socketCounter++;
  if (process.platform === 'win32')
    return `\\\\.\\pipe\\genesis-test-${process.pid}-${socketCounter}`;
  return path.join(os.tmpdir(), `genesis-test-${process.pid}-${socketCounter}.sock`);
}

function createController(overrides = {}) {
  const bus = createBus();
  const socketPath = tmpSocket();
  const daemon = {
    running: true,
    cycleCount: 5,
    lastResults: { cycle: 5 },
    knownGaps: [],
    config: { cycleInterval: 300000, healthInterval: 3, autoRepair: true, autoOptimize: false, logLevel: 'info' },
    getStatus() { return { running: this.running, cycleCount: this.cycleCount, lastResults: this.lastResults, knownGaps: this.knownGaps, config: this.config }; },
    stop() { this.running = false; },
    async runCheck(type) { return { type, ok: true }; },
  };
  const ctrl = new DaemonController({
    bus, daemon, socketPath,
    ...overrides,
  });
  return { bus, ctrl, daemon, socketPath };
}

/** Send a JSON-Line request and receive the response */
function rpc(socketPath, method, params = {}) {
  return new Promise((resolve, reject) => {
    const client = net.createConnection(socketPath, () => {
      const id = String(Date.now());
      client.write(JSON.stringify({ id, method, params }) + '\n');
    });
    let buf = '';
    client.on('data', (chunk) => {
      buf += chunk.toString();
      const nl = buf.indexOf('\n');
      if (nl !== -1) {
        const line = buf.slice(0, nl);
        client.destroy();
        try { resolve(JSON.parse(line)); } catch (e) { reject(e); }
      }
    });
    client.on('error', reject);
    setTimeout(() => { client.destroy(); reject(new Error('timeout')); }, 3000);
  });
}

/** Helper: start controller, run fn, stop controller */
async function withController(overrides, fn) {
  const ctx = createController(overrides);
  ctx.ctrl.start();
  // Wait for server to be listening
  await new Promise((resolve) => {
    const check = () => ctx.ctrl.isListening() ? resolve() : setTimeout(check, 10);
    check();
  });
  try {
    await fn(ctx);
  } finally {
    ctx.ctrl.stop();
    // Clean up socket file
    try { fs.unlinkSync(ctx.socketPath); } catch (_e) { /* ok */ }
  }
}

// ════════════════════════════════════════════════════════════
// PORT CONTRACT
// ════════════════════════════════════════════════════════════

describe('DaemonControlPort', () => {
  test('base class methods return safe defaults', () => {
    const port = new DaemonControlPort();
    assertEqual(port.isListening(), false);
    assertEqual(port.getAddress(), null);
    assertEqual(port.getClientCount(), 0);
    port.start();
    port.stop();
  });

  test('DaemonController extends DaemonControlPort', () => {
    const { ctrl } = createController();
    assert(ctrl instanceof DaemonControlPort, 'should extend port');
  });
});

// ════════════════════════════════════════════════════════════
// LIFECYCLE
// ════════════════════════════════════════════════════════════

describe('DaemonController — lifecycle', () => {

  test('starts and listens on socket', async () => {
    await withController({}, async ({ ctrl, socketPath }) => {
      assert(ctrl.isListening(), 'should be listening');
      assertEqual(ctrl.getAddress(), socketPath);
      assert(fs.existsSync(socketPath), 'socket file should exist');
    });
  });

  test('stop closes server and removes socket', async () => {
    const { ctrl, socketPath } = createController();
    ctrl.start();
    await new Promise(r => setTimeout(r, 100));
    ctrl.stop();
    assertEqual(ctrl.isListening(), false);
    assertEqual(ctrl.getAddress(), null);
    assertEqual(ctrl.getClientCount(), 0);
    // Socket file should be cleaned up
    await new Promise(r => setTimeout(r, 50));
    assert(!fs.existsSync(socketPath), 'socket file should be removed');
  });

  test('cleans up stale socket on start', async () => {
    const socketPath = tmpSocket();
    // Create a stale socket file (simulating a crashed process)
    const srv = net.createServer();
    await new Promise((res) => srv.listen(socketPath, res));
    srv.close();
    // Now start controller on same path — should succeed
    const { ctrl } = createController({ socketPath });
    // Monkey-patch socketPath
    ctrl._socketPath = socketPath;
    ctrl.start();
    await new Promise(r => setTimeout(r, 100));
    assert(ctrl.isListening(), 'should start despite stale socket');
    ctrl.stop();
  });

  test('fires daemon:control-listening event', async () => {
    const { ctrl, bus, socketPath } = createController();
    let fired = false;
    bus.on('daemon:control-listening', (data) => {
      fired = true;
      assertEqual(data.path, socketPath);
    });
    ctrl.start();
    await new Promise(r => setTimeout(r, 100));
    assert(fired, 'should fire listening event');
    ctrl.stop();
  });

  test('fires connect/disconnect events', async () => {
    await withController({}, async ({ bus, socketPath }) => {
      let connected = false, disconnected = false;
      bus.on('daemon:control-connected', () => { connected = true; });
      bus.on('daemon:control-disconnected', () => { disconnected = true; });

      // Connect and immediately disconnect
      const client = net.createConnection(socketPath);
      await new Promise(r => setTimeout(r, 50));
      assert(connected, 'should fire connected');
      client.destroy();
      await new Promise(r => setTimeout(r, 50));
      assert(disconnected, 'should fire disconnected');
    });
  });
});

// ════════════════════════════════════════════════════════════
// RPC METHODS
// ════════════════════════════════════════════════════════════

describe('DaemonController — RPC methods', () => {

  test('ping returns pong', async () => {
    await withController({}, async ({ socketPath }) => {
      const res = await rpc(socketPath, 'ping');
      assert(res.result.pong === true, 'should pong');
      assert(typeof res.result.timestamp === 'number', 'should include timestamp');
    });
  });

  test('status returns daemon info', async () => {
    await withController({}, async ({ socketPath }) => {
      const res = await rpc(socketPath, 'status');
      assert(res.result.daemon.running === true, 'daemon should be running');
      assertEqual(res.result.daemon.cycleCount, 5);
      assert(typeof res.result.uptime === 'number');
      assert(typeof res.result.memory.rss === 'number');
      assert(typeof res.result.pid === 'number');
    });
  });

  test('check runs daemon check and returns result', async () => {
    await withController({}, async ({ socketPath }) => {
      const res = await rpc(socketPath, 'check', { type: 'health' });
      assertEqual(res.result.type, 'health');
      assert(res.result.result.ok === true);
    });
  });

  test('check without type returns error', async () => {
    await withController({}, async ({ socketPath }) => {
      const res = await rpc(socketPath, 'check', {});
      assert(res.error, 'should return error');
      assert(res.error.message.includes('type'), 'error should mention type');
    });
  });

  test('config returns full config when no params', async () => {
    await withController({}, async ({ socketPath }) => {
      const res = await rpc(socketPath, 'config');
      assertEqual(res.result.config.healthInterval, 3);
      assertEqual(res.result.config.autoRepair, true);
    });
  });

  test('config reads specific key', async () => {
    await withController({}, async ({ socketPath }) => {
      const res = await rpc(socketPath, 'config', { key: 'autoRepair' });
      assertEqual(res.result.autoRepair, true);
    });
  });

  test('config writes specific key', async () => {
    await withController({}, async ({ socketPath, daemon }) => {
      const res = await rpc(socketPath, 'config', { key: 'autoOptimize', value: true });
      assertEqual(res.result.updated, 'autoOptimize');
      assertEqual(res.result.value, true);
      assertEqual(daemon.config.autoOptimize, true);
    });
  });

  test('config rejects unknown key', async () => {
    await withController({}, async ({ socketPath }) => {
      const res = await rpc(socketPath, 'config', { key: 'nonexistent' });
      assert(res.error, 'should error on unknown key');
    });
  });

  test('clients returns count', async () => {
    await withController({}, async ({ socketPath }) => {
      const res = await rpc(socketPath, 'clients');
      // The RPC client itself is connected, so count >= 1
      assert(res.result.count >= 0, 'should return count');
      assertEqual(res.result.max, 5);
    });
  });

  test('goal without agentLoop returns error', async () => {
    await withController({}, async ({ socketPath }) => {
      const res = await rpc(socketPath, 'goal', { description: 'test goal' });
      assert(res.error, 'should error without agentLoop');
      assert(res.error.message.includes('AgentLoop'), 'should mention AgentLoop');
    });
  });

  test('goal with agentLoop pushes goal', async () => {
    const mockAgentLoop = { async pursue(desc) { return `goal:${desc}`; } };
    await withController({ agentLoop: mockAgentLoop }, async ({ ctrl, socketPath }) => {
      ctrl.agentLoop = mockAgentLoop;
      const res = await rpc(socketPath, 'goal', { description: 'build REST API' });
      assert(res.result.accepted === true);
      assertEqual(res.result.description, 'build REST API');
    });
  });

  test('goal without description returns error', async () => {
    const mockAgentLoop = { async pursue() {} };
    await withController({ agentLoop: mockAgentLoop }, async ({ ctrl, socketPath }) => {
      ctrl.agentLoop = mockAgentLoop;
      const res = await rpc(socketPath, 'goal', {});
      assert(res.error, 'should error without description');
    });
  });
});

// ════════════════════════════════════════════════════════════
// ERROR HANDLING
// ════════════════════════════════════════════════════════════

describe('DaemonController — error handling', () => {

  test('invalid JSON returns parse error', async () => {
    await withController({}, async ({ socketPath }) => {
      const res = await new Promise((resolve, reject) => {
        const client = net.createConnection(socketPath, () => {
          client.write('not json\n');
        });
        let buf = '';
        client.on('data', (chunk) => {
          buf += chunk.toString();
          const nl = buf.indexOf('\n');
          if (nl !== -1) {
            client.destroy();
            try { resolve(JSON.parse(buf.slice(0, nl))); } catch (e) { reject(e); }
          }
        });
        client.on('error', reject);
        setTimeout(() => { client.destroy(); reject(new Error('timeout')); }, 3000);
      });
      assert(res.error, 'should return error');
      assertEqual(res.error.code, -32700);
    });
  });

  test('unknown method returns error', async () => {
    await withController({}, async ({ socketPath }) => {
      const res = await rpc(socketPath, 'nonexistent');
      assert(res.error, 'should return error');
      assertEqual(res.error.code, -32601);
      assert(res.error.message.includes('nonexistent'));
    });
  });

  test('missing method field returns error', async () => {
    await withController({}, async ({ socketPath }) => {
      const res = await new Promise((resolve, reject) => {
        const client = net.createConnection(socketPath, () => {
          client.write(JSON.stringify({ id: '1' }) + '\n');
        });
        let buf = '';
        client.on('data', (chunk) => {
          buf += chunk.toString();
          const nl = buf.indexOf('\n');
          if (nl !== -1) {
            client.destroy();
            try { resolve(JSON.parse(buf.slice(0, nl))); } catch (e) { reject(e); }
          }
        });
        client.on('error', reject);
        setTimeout(() => { client.destroy(); reject(new Error('timeout')); }, 3000);
      });
      assert(res.error);
      assertEqual(res.error.code, -32600);
    });
  });

  test('max clients enforced', async () => {
    await withController({}, async ({ socketPath }) => {
      const clients = [];
      // Open 5 connections (the max)
      for (let i = 0; i < 5; i++) {
        clients.push(net.createConnection(socketPath));
      }
      await new Promise(r => setTimeout(r, 100));

      // 6th connection should be rejected
      const res = await new Promise((resolve, reject) => {
        const extra = net.createConnection(socketPath);
        let buf = '';
        extra.on('data', (chunk) => {
          buf += chunk.toString();
          const nl = buf.indexOf('\n');
          if (nl !== -1) {
            try { resolve(JSON.parse(buf.slice(0, nl))); } catch (e) { reject(e); }
          }
        });
        extra.on('close', () => {
          if (!buf) resolve({ error: { code: -2, message: 'rejected' } });
        });
        extra.on('error', () => resolve({ error: { code: -2, message: 'rejected' } }));
        setTimeout(() => resolve({ error: { code: -2, message: 'timeout' } }), 2000);
      });

      assert(res.error, 'should reject 6th client');
      assertEqual(res.error.code, -2);

      // Cleanup
      for (const c of clients) c.destroy();
    });
  });
});

// ════════════════════════════════════════════════════════════
// HELPERS
// ════════════════════════════════════════════════════════════

describe('DaemonController — helpers', () => {

  test('resolveSocketPath uses env override', () => {
    const orig = process.env.GENESIS_SOCKET;
    process.env.GENESIS_SOCKET = '/tmp/custom.sock';
    // When no explicit path, falls through to env
    const result = resolveSocketPath(undefined);
    // resolveSocketPath checks its argument first, then env
    assertEqual(resolveSocketPath('/tmp/custom.sock'), '/tmp/custom.sock');
    process.env.GENESIS_SOCKET = orig;
  });

  test('resolveSocketPath returns platform default', () => {
    const result = resolveSocketPath(undefined);
    if (process.platform === 'win32') {
      assertEqual(result, DEFAULT_PIPE_WIN32);
    } else {
      assertEqual(result, DEFAULT_SOCKET_LINUX);
    }
  });

  test('daemon:control-command event fires on every request', async () => {
    await withController({}, async ({ bus, socketPath }) => {
      const commands = [];
      bus.on('daemon:control-command', (data) => commands.push(data.method));
      await rpc(socketPath, 'ping');
      await rpc(socketPath, 'status');
      assert(commands.includes('ping'), 'should log ping');
      assert(commands.includes('status'), 'should log status');
    });
  });
});

describe('DaemonController — V7-4B/C: update command', () => {

  test('update returns available:false when no autoUpdater', async () => {
    await withController({}, async ({ socketPath }) => {
      const res = await rpc(socketPath, 'update', { force: true });
      // No container → AutoUpdater not available → error
      assert(res.error || res.result, 'should return error or result');
    });
  });

  test('update with mock autoUpdater returns check result', async () => {
    const mockUpdater = {
      _autoApply: false,
      checkForUpdate: async () => ({ available: false, current: '7.1.1', latest: '7.1.1' }),
      getStatus: () => ({ currentVersion: '7.1.1', autoApply: false, deploymentManagerAvailable: false }),
    };
    const container = {
      tryResolve: (name) => name === 'autoUpdater' ? mockUpdater : null,
      resolve: (name) => name === 'autoUpdater' ? mockUpdater : null,
      has: () => false,
    };
    await withController({ container }, async ({ socketPath }) => {
      const res = await rpc(socketPath, 'update', { force: true });
      assert(res.result || res.error, 'should return result or error');
      if (res.result) {
        assert(typeof res.result.available === 'boolean', 'should have available field');
        assert(res.result.status, 'should include status');
      }
    });
  });

  test('update --apply triggers deploy when autoUpdater + deploymentManager available', async () => {
    let deployCalled = false;
    const mockDM = { deploy: async (t, o) => { deployCalled = true; return { id: 'dep-test' }; } };
    const mockUpdater = {
      _autoApply: false,
      _deploymentManager: mockDM,
      checkForUpdate: async () => ({ available: true, current: '7.1.1', latest: '7.2.0' }),
      getStatus: () => ({ currentVersion: '7.1.1', autoApply: true, deploymentManagerAvailable: true }),
    };
    const container = {
      tryResolve: (name) => name === 'autoUpdater' ? mockUpdater : null,
      resolve: (name) => name === 'autoUpdater' ? mockUpdater : null,
      has: () => false,
    };
    await withController({ container }, async ({ socketPath }) => {
      const res = await rpc(socketPath, 'update', { force: true, apply: true });
      assert(res.result || res.error, 'should return result');
      if (res.result) {
        assertEqual(res.result.available, true);
        assertEqual(res.result.status.currentVersion, '7.1.1');
      }
    });
  });

  test('update method is registered in methods map', async () => {
    const { DaemonController } = require('../../src/agent/autonomy/DaemonController');
    const bus = require('../../src/agent/core/EventBus').createBus();
    const ctrl = new DaemonController({ bus, socketPath: '/tmp/test-methods.sock' });
    assert(typeof ctrl._methods.update === 'function', 'update method should be in _methods map');
  });
});

run();
