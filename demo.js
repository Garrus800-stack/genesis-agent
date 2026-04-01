#!/usr/bin/env node
// ============================================================
// GENESIS — demo.js
//
// Automated demo for terminal recording / showcasing.
// Boots Genesis headless, shows capabilities, exits cleanly.
//
// Usage:
//   node demo.js              — Full demo (~15s)
//   node demo.js --quick      — Quick health check only (~5s)
//
// Record with: npx terminalizer record demo --config demo.yml
// Or: asciinema rec demo.cast -c "node demo.js"
// ============================================================

'use strict';

const path = require('path');
const ROOT = path.resolve(__dirname);

const CYAN    = '\x1b[36m';
const GREEN   = '\x1b[32m';
const YELLOW  = '\x1b[33m';
const DIM     = '\x1b[2m';
const BOLD    = '\x1b[1m';
const RESET   = '\x1b[0m';

const quick = process.argv.includes('--quick');

function print(msg) { process.stdout.write(msg + '\n'); }
function header(msg) { print(`\n${CYAN}${BOLD}═══ ${msg} ═══${RESET}\n`); }
function step(msg) { print(`  ${GREEN}✓${RESET} ${msg}`); }
function info(label, val) { print(`  ${DIM}${label}:${RESET} ${BOLD}${val}${RESET}`); }
function pause(ms) { return new Promise(r => setTimeout(r, ms)); }

(async () => {
  print(`\n${CYAN}${BOLD}╔══════════════════════════════════════════════════════╗${RESET}`);
  print(`${CYAN}${BOLD}║     GENESIS — Self-Modifying Cognitive AI Agent      ║${RESET}`);
  print(`${CYAN}${BOLD}╚══════════════════════════════════════════════════════╝${RESET}`);

  // ── Boot ────────────────────────────────────────────
  header('Phase 1: Boot');
  print(`  ${DIM}Booting without Electron (headless mode)...${RESET}`);

  // Suppress all Genesis logs for clean demo output
  const _origLog = console.log;
  const _origWarn = console.warn;
  const _origInfo = console.info;
  const _origDebug = console.debug;
  console.log = () => {};
  console.warn = () => {};
  console.info = () => {};
  console.debug = () => {};

  const { SafeGuard } = require('./src/kernel/SafeGuard');
  const { AgentCore } = require('./src/agent/AgentCore');
  const { Logger } = require('./src/agent/core/Logger');
  Logger.setLevel('error');

  const guard = new SafeGuard([
    path.join(ROOT, 'main.js'), path.join(ROOT, 'preload.mjs'),
    path.join(ROOT, 'preload.js'), path.join(ROOT, 'src', 'kernel'),
  ], ROOT);
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

  const t0 = Date.now();
  const agent = new AgentCore({ rootDir: ROOT, guard, window: null, bootProfile: quick ? 'minimal' : 'cognitive' });
  await agent.boot();

  // Restore console
  console.log = _origLog;
  console.warn = _origWarn;
  console.info = _origInfo;
  console.debug = _origDebug;
  const bootMs = Date.now() - t0;

  step(`Boot complete in ${bootMs}ms`);

  // ── Health ──────────────────────────────────────────
  header('Phase 2: System Health');
  const h = agent.getHealth();

  info('Services', h.services);
  info('Model', h.model?.active || 'none (configure Ollama or API key)');
  info('Modules', h.modules);
  info('Tools', h.tools);
  info('Memory', `${h.memory?.conversations || 0} conversations`);
  info('Goals', `${h.goals?.active || 0} active / ${h.goals?.total || 0} total`);
  info('Circuit Breaker', h.circuit?.state || 'CLOSED');
  info('Kernel Integrity', h.kernel?.ok ? `${GREEN}OK${RESET}` : `${YELLOW}DEGRADED${RESET}`);
  info('Uptime', `${Math.round(h.uptime)}s`);

  if (h.organism) {
    const mood = h.organism.emotions?.mood || 'neutral';
    const energy = h.organism.metabolism?.energy;
    info('Mood', mood);
    if (energy) info('Energy', `${energy.current}/${energy.max} (${energy.percent}%)`);
  }

  await pause(500);

  if (!quick) {
    // ── Architecture ──────────────────────────────────
    header('Phase 3: Architecture Reflection');
    const ar = agent.container.tryResolve('architectureReflection');
    if (ar) {
      console.log = () => {}; console.info = () => {};
      const snap = ar.getSnapshot();
      console.log = _origLog; console.info = _origInfo;
      info('Services indexed', snap.services || 0);
      info('Events tracked', snap.events || 0);
      info('Layers', snap.layers || 0);
      info('Cross-phase couplings', snap.crossPhaseCouplings || snap.couplings || 0);

      const phases = snap.phases || {};
      const phaseStr = Object.entries(phases)
        .map(([p, svcs]) => `P${p}:${Array.isArray(svcs) ? svcs.length : 0}`)
        .join('  ');
      if (phaseStr) info('Phase map', phaseStr);
    } else {
      print(`  ${DIM}(ArchitectureReflection not available in minimal profile)${RESET}`);
    }
    await pause(500);

    // ── MCP Server ────────────────────────────────────
    header('Phase 4: MCP Server');
    const mcp = agent.container.tryResolve('mcpClient');
    if (mcp) {
      try {
        console.log = () => {}; console.warn = () => {}; console.info = () => {};
        const port = await mcp.startServer(0);
        console.log = _origLog; console.warn = _origWarn; console.info = _origInfo;
        step(`MCP server started on port ${port}`);

        const server = mcp.mcpServer;
        const tools = server._collectToolSchemas();
        info('Tools exposed', tools.length);
        for (const t of tools.slice(0, 5)) {
          print(`    ${DIM}→${RESET} ${t.name}: ${t.description?.slice(0, 60) || ''}...`);
        }
        if (tools.length > 5) print(`    ${DIM}  ...and ${tools.length - 5} more${RESET}`);

        const resources = server._collectResources();
        if (resources.length > 0) {
          info('Resources exposed', resources.length);
          for (const r of resources) {
            print(`    ${DIM}→${RESET} ${r.uri}`);
          }
        }

        console.log = () => {}; console.warn = () => {};
        await server.stop();
        console.log = _origLog; console.warn = _origWarn;
        step('MCP server stopped');
      } catch (err) {
        console.log = _origLog; console.warn = _origWarn; console.info = _origInfo;
        print(`  ${YELLOW}MCP: ${err.message}${RESET}`);
      }
    }
    await pause(500);

    // ── Verification ──────────────────────────────────
    header('Phase 5: Code Verification');
    const ve = agent.container.tryResolve('verifier');
    const cv = ve?._verifiers?.code;
    if (cv) {
      const good = cv.verify('const x = 1 + 2; module.exports = { x };');
      step(`Valid code: ${good.status} (${good.checks?.length || 0} checks)`);

      const bad = cv.verify('function { broken syntax');
      step(`Invalid code: ${bad.status} — ${bad.reason}`);

      const dangerous = cv.verify('const fs = require("fs"); fs.unlinkSync("/etc/passwd");');
      step(`Dangerous code: ${dangerous.status} — ${dangerous.checks?.filter(c => !c.passed).map(c => c.name).join(', ') || 'blocked'}`);
    } else {
      print(`  ${DIM}(VerificationEngine not available)${RESET}`);
    }
    await pause(300);
  }

  // ── Shutdown ────────────────────────────────────────
  header('Shutdown');
  console.log = () => {}; console.warn = () => {}; console.info = () => {}; console.debug = () => {};
  await agent.shutdown();
  console.log = _origLog; console.warn = _origWarn; console.info = _origInfo; console.debug = _origDebug;
  step('Clean shutdown complete');

  print(`\n${CYAN}${BOLD}══════════════════════════════════════════════════════${RESET}`);
  print(`${BOLD}  Genesis v${require('./package.json').version}${RESET}`);
  print(`  ${DIM}218 modules · 116 services · 13 boot phases${RESET}`);
  print(`  ${DIM}github.com/Garrus800-stack/genesis-agent${RESET}`);
  print(`${CYAN}${BOLD}══════════════════════════════════════════════════════${RESET}\n`);

  process.exit(0);
})();
