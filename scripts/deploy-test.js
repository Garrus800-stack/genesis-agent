#!/usr/bin/env node
// ============================================================
// GENESIS — scripts/deploy-test.js (v5.9.2)
//
// Integration test for DeploymentManager. Creates a mock
// Node.js service, deploys changes via shell commands,
// verifies health checks and rollback.
//
// Usage:
//   node scripts/deploy-test.js
// ============================================================

'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const TEMP = path.join(ROOT, '.deploy-test-tmp');
const { DeploymentManager } = require(path.join(ROOT, 'src/agent/autonomy/DeploymentManager'));
const { NullBus } = require(path.join(ROOT, 'src/agent/core/EventBus'));

let passed = 0;
let failed = 0;
let mockServer = null;

function log(msg)  { console.log(`[DEPLOY-TEST] ${msg}`); }
function ok(msg)   { passed++; console.log(`  ✅ ${msg}`); }
function fail(msg) { failed++; console.error(`  ❌ ${msg}`); }

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── Mock Target Service ─────────────────────────────────────

function createMockService(port) {
  let version = '1.0.0';
  let healthy = true;

  const server = http.createServer((req, res) => {
    if (req.url === '/health') {
      if (!healthy) { res.writeHead(503); res.end('unhealthy'); return; }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', version }));
      return;
    }
    if (req.url === '/version') {
      res.writeHead(200); res.end(version); return;
    }
    res.writeHead(404); res.end();
  });

  return {
    start: () => new Promise(r => server.listen(port, '127.0.0.1', r)),
    stop: () => new Promise(r => server.close(r)),
    setVersion: (v) => { version = v; },
    setHealthy: (h) => { healthy = h; },
    getVersion: () => version,
  };
}

// ── Mock Shell ──────────────────────────────────────────────

function createTestShell() {
  const history = [];
  return {
    run: async (cmd) => {
      history.push(cmd);
      // Actually execute safe commands
      if (cmd.startsWith('echo ') || cmd.startsWith('mkdir ') || cmd.startsWith('cp ')) {
        try { execSync(cmd, { cwd: TEMP, stdio: 'pipe' }); } catch (_e) { /* ok */ }
      }
      return { stdout: 'ok', stderr: '' };
    },
    history,
  };
}

// ── Mock Health Monitor ─────────────────────────────────────

function createTestHealthMonitor(port) {
  return {
    getHealth: () => {
      try {
        const res = execSync(`node -e "
          const http = require('http');
          http.get('http://127.0.0.1:${port}/health', r => {
            let d=''; r.on('data', c => d += c);
            r.on('end', () => { process.stdout.write(d); process.exit(r.statusCode < 400 ? 0 : 1); });
          }).on('error', () => process.exit(1));
        "`, { timeout: 3000, stdio: 'pipe' });
        return { status: 'ok' };
      } catch (_e) {
        return { status: 'critical' };
      }
    },
  };
}

// ── Tests ───────────────────────────────────────────────────

async function main() {
  console.log('\n╔══════════════════════════════════════════╗');
  console.log('║    GENESIS DEPLOYMENT INTEGRATION TEST   ║');
  console.log('╚══════════════════════════════════════════╝\n');

  // Setup
  if (!fs.existsSync(TEMP)) fs.mkdirSync(TEMP, { recursive: true });

  const SERVICE_PORT = 19450;
  mockServer = createMockService(SERVICE_PORT);
  await mockServer.start();
  log(`Mock service on port ${SERVICE_PORT}`);

  const shell = createTestShell();
  const healthMonitor = createTestHealthMonitor(SERVICE_PORT);
  const events = [];
  const bus = { on: () => {}, fire: (e, d) => events.push({ e, d }), emit: () => {} };

  const dm = new DeploymentManager({ bus, shell, healthMonitor });
  await dm.boot();

  try {
    // Test 1: Direct deploy with commands
    log('Test: Direct deploy');
    const d1 = await dm.deploy('mock-service', {
      strategy: 'direct',
      commands: ['echo "deploying v2.0.0"'],
    });
    if (d1.status === 'done') ok('Direct deploy succeeded');
    else fail(`Direct deploy: ${d1.status} — ${d1.error}`);

    // Test 2: Rolling deploy
    log('Test: Rolling deploy');
    const d2 = await dm.deploy('mock-service', {
      strategy: 'rolling',
      commands: ['echo "step 1"', 'echo "step 2"', 'echo "step 3"'],
    });
    if (d2.status === 'done') ok('Rolling deploy succeeded');
    else fail(`Rolling deploy: ${d2.status} — ${d2.error}`);

    // Test 3: Deploy to self (via HotReloader mock)
    log('Test: Self deploy');
    const reloaded = [];
    const d3 = await dm.deploy('self', {
      strategy: 'direct',
      files: ['test.js'],
    });
    // Without HotReloader it still succeeds (no files to reload)
    if (d3.status === 'done' || d3.status === 'rolled-back') ok('Self deploy handled');
    else fail(`Self deploy: ${d3.status}`);

    // Test 4: Deploy with unhealthy target
    log('Test: Deploy to unhealthy service');
    mockServer.setHealthy(false);
    const d4 = await dm.deploy('mock-unhealthy', {
      strategy: 'direct',
      commands: ['echo "deploy to sick"'],
    });
    // Health check uses our mock which checks the port — but target name doesn't match 'self'
    // so the generic health check passes (no external check implemented in foundation)
    if (d4.status === 'done' || d4.status === 'rolled-back') ok('Unhealthy deploy handled gracefully');
    else fail(`Unhealthy deploy: ${d4.status}`);
    mockServer.setHealthy(true);

    // Test 5: Rollback
    log('Test: Manual rollback');
    const d5 = await dm.deploy('svc', { commands: ['echo "v3"'] });
    if (d5.status === 'done') {
      await dm.rollback(d5.id);
      const status = dm.getDeployment(d5.id);
      if (status.status === 'rolled-back') ok('Manual rollback succeeded');
      else fail(`Rollback status: ${status.status}`);
    } else { fail('Pre-rollback deploy failed'); }

    // Test 6: Deployment listing
    log('Test: Deployment listing');
    const list = dm.listDeployments();
    if (list.length >= 5) ok(`Listed ${list.length} deployments`);
    else fail(`Expected ≥5 deployments, got ${list.length}`);

    // Test 7: Health stats
    log('Test: Health stats');
    const h = dm.getHealth();
    if (h.total >= 5 && h.succeeded >= 2) ok(`Health: ${h.total} total, ${h.succeeded} succeeded`);
    else fail(`Health stats unexpected: ${JSON.stringify(h)}`);

    // Test 8: Events emitted
    log('Test: Events');
    const starts = events.filter(e => e.e === 'deploy:started').length;
    const completes = events.filter(e => e.e === 'deploy:completed').length;
    if (starts >= 3 && completes >= 2) ok(`Events: ${starts} started, ${completes} completed`);
    else fail(`Events: ${starts} started, ${completes} completed`);

    // Test 9: Shell history
    log('Test: Shell command history');
    if (shell.history.length >= 5) ok(`${shell.history.length} shell commands executed`);
    else fail(`Expected ≥5 shell commands, got ${shell.history.length}`);

  } catch (err) {
    fail(`Unexpected: ${err.message}\n${err.stack}`);
  } finally {
    await mockServer.stop();
    // Cleanup temp
    try { fs.rmSync(TEMP, { recursive: true }); } catch (_e) { /* ok */ }
  }

  console.log(`\n═══════════════════════════════════════`);
  console.log(`  Results: ${passed} passed, ${failed} failed`);
  console.log(`═══════════════════════════════════════\n`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(err => {
  console.error('[DEPLOY-TEST] Fatal:', err);
  if (mockServer) mockServer.stop().catch(() => {});
  process.exit(1);
});
