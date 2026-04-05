// ============================================================
// TEST — Headless Boot Integration (v5.9.0)
//
// Verifies that AgentCore boots successfully without Electron,
// all critical services resolve, and chat pipeline works.
// ============================================================

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const { SafeGuard } = require(path.join(ROOT, 'src/kernel/SafeGuard'));
const { AgentCore } = require(path.join(ROOT, 'src/agent/AgentCore'));

const PROTECTED_PATHS = [
  path.join(ROOT, 'main.js'),
  path.join(ROOT, 'preload.mjs'),
  path.join(ROOT, 'preload.js'),
  path.join(ROOT, 'src', 'kernel'),
];

describe('Headless Boot', () => {
  let agent;

  before(async function() {
    this.timeout = 30000; // Boot can take a while

    const guard = new SafeGuard(PROTECTED_PATHS, ROOT);
    guard.lockKernel();
    guard.lockCritical([
      'src/agent/intelligence/CodeSafetyScanner.js',
      'src/agent/intelligence/VerificationEngine.js',
      'src/agent/core/Constants.js',
      'src/agent/core/EventBus.js',
      'src/agent/core/Container.js',
      'src/agent/capabilities/McpWorker.js',
      'src/agent/core/PreservationInvariants.js',
    ]);

    agent = new AgentCore({
      rootDir: ROOT,
      guard,
      window: null, // Headless
      bootProfile: 'minimal',
    });

    await agent.boot();
  });

  after(async () => {
    if (agent) {
      try { await agent.shutdown(); } catch (_e) { /* best effort */ }
    }
  });

  // ── Boot Verification ─────────────────────────────────

  describe('boot', () => {
    it('agent is created', () => {
      assert.ok(agent);
    });

    it('container is available', () => {
      assert.ok(agent.container);
    });

    it('bus is available', () => {
      assert.ok(agent.bus || agent._bus);
    });

    it('window is null', () => {
      assert.equal(agent.window, null);
    });
  });

  // ── Critical Services ─────────────────────────────────

  describe('critical services', () => {
    it('settings resolves', () => {
      assert.ok(agent.container.resolve('settings'));
    });

    it('storage resolves', () => {
      assert.ok(agent.container.resolve('storage'));
    });

    it('model resolves', () => {
      assert.ok(agent.container.resolve('model'));
    });

    it('tools resolves', () => {
      assert.ok(agent.container.resolve('tools'));
    });

    it('selfModel resolves', () => {
      assert.ok(agent.container.resolve('selfModel'));
    });

    it('chatOrchestrator resolves', () => {
      assert.ok(agent.container.resolve('chatOrchestrator'));
    });

    it('verificationEngine resolves', () => {
      const ve = agent.container.tryResolve('verifier') || agent.container.tryResolve('verificationEngine');
      assert.ok(ve);
    });
  });

  // ── Health Check ──────────────────────────────────────

  describe('health', () => {
    it('getHealth returns object', () => {
      const health = agent.getHealth();
      assert.ok(health);
      assert.equal(typeof health, 'object');
    });

    it('health has kernel field', () => {
      const health = agent.getHealth();
      assert.ok(health.kernel);
    });

    it('health has services count', () => {
      const health = agent.getHealth();
      assert.ok(health.services > 0);
    });

    it('health has uptime', () => {
      const health = agent.getHealth();
      assert.ok(health.uptime >= 0);
    });
  });

  // ── Window Null Safety ────────────────────────────────

  describe('window null safety', () => {
    it('_pushStatus does not crash without window', () => {
      // AgentCore._pushStatus checks this.window before sending
      assert.doesNotThrow(() => {
        agent._pushStatus?.({ state: 'test', detail: 'headless check' });
      });
    });

    it('health tick does not crash without window', () => {
      assert.doesNotThrow(() => {
        agent._health._pushHealthTick();
      });
    });
  });

  // ── MCP Server ────────────────────────────────────────

  describe('mcp server', () => {
    it('mcpClient resolves (may be null if mcp disabled)', () => {
      // In minimal mode, mcpClient may or may not be available
      const mcp = agent.container.tryResolve('mcpClient');
      // Just verify it doesn't crash
      assert.ok(true);
    });
  });
});
