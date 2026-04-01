#!/usr/bin/env node
// ============================================================
// GENESIS — cli.js (v5.9.0 — Headless Mode)
//
// Run Genesis without Electron. Supports:
//   node cli.js                — Interactive REPL chat
//   node cli.js --serve        — MCP server only (daemon)
//   node cli.js --minimal      — Minimal boot profile
//   node cli.js --cognitive    — Cognitive boot profile
//   node cli.js --port 4000    — Custom MCP server port
//
// Use cases:
//   - MCP server on a remote machine / CI
//   - Background daemon for code verification
//   - CLI-based chat without UI overhead
//   - Testing / automation
// ============================================================

'use strict';

const path = require('path');
const fs   = require('fs');
const readline = require('readline');

const ROOT = path.resolve(__dirname);

// ── Parse CLI Arguments ─────────────────────────────────────

const args = process.argv.slice(2);
const flags = {
  serve:     args.includes('--serve') || args.includes('--daemon'),
  minimal:   args.includes('--minimal'),
  cognitive: args.includes('--cognitive'),
  quiet:     !args.includes('--verbose'),
  help:      args.includes('--help') || args.includes('-h'),
  port:      (() => {
    const idx = args.indexOf('--port');
    return idx >= 0 && args[idx + 1] ? parseInt(args[idx + 1], 10) : 3580;
  })(),
};

if (flags.help) {
  console.log(`
Genesis Agent — Headless CLI

Usage:
  node cli.js                Interactive REPL chat
  node cli.js --serve        MCP server daemon (no chat)
  node cli.js --port 4000    Custom MCP server port (default: 3580)
  node cli.js --minimal      Minimal boot profile (~50 services)
  node cli.js --cognitive    Cognitive profile (~90 services)
  node cli.js --verbose      Show all Genesis logs (default: warn only)
  node cli.js --help         Show this help

Environment:
  GENESIS_API_KEY            Anthropic API key (optional)
  GENESIS_OPENAI_KEY         OpenAI API key (optional)
  GENESIS_MODEL              Preferred model name (optional)
`);
  process.exit(0);
}

// ── Boot Agent ──────────────────────────────────────────────

const { SafeGuard }  = require('./src/kernel/SafeGuard');
const { AgentCore }  = require('./src/agent/AgentCore');
const { createLogger } = require('./src/agent/core/Logger');
const _log = createLogger('CLI');

const PROTECTED_PATHS = [
  path.join(ROOT, 'main.js'),
  path.join(ROOT, 'preload.mjs'),
  path.join(ROOT, 'preload.js'),
  path.join(ROOT, 'src', 'kernel'),
];

process.on('unhandledRejection', (reason) => {
  _log.error('[CLI] Unhandled rejection:', reason?.message || reason);
});

process.on('uncaughtException', (err) => {
  _log.error('[CLI] Uncaught exception:', err.message);
  process.exit(1);
});

async function boot() {
  console.log('\n╔══════════════════════════════════════════════╗');
  console.log('║     GENESIS — Headless Mode                  ║');
  console.log('╚══════════════════════════════════════════════╝\n');

  // SafeGuard
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

  // Boot profile
  const bootProfile = flags.minimal ? 'minimal' : flags.cognitive ? 'cognitive' : 'full';
  console.log(`[CLI] Boot profile: ${bootProfile}`);

  // Create AgentCore without window
  const agent = new AgentCore({
    rootDir: ROOT,
    guard,
    window: null,  // Headless — no BrowserWindow
    bootProfile,
  });

  // Apply environment overrides before boot
  _applyEnvOverrides(agent);

  await agent.boot();
  console.log('[CLI] Agent booted successfully.\n');

  // v5.9.1: Suppress info logs in CLI to keep output clean
  if (flags.quiet) {
    const { Logger } = require('./src/agent/core/Logger');
    Logger.setLevel('warn');
  }

  return agent;
}

/** Apply API keys from environment variables — Settings._load() reads them natively via ENV_MAP */
function _applyEnvOverrides(_agent) {
  // v5.9.0: Settings._applyEnvOverrides() handles GENESIS_API_KEY, ANTHROPIC_API_KEY,
  // GENESIS_OPENAI_KEY, OPENAI_API_KEY, GENESIS_MODEL natively during _load().
  // Nothing extra needed here.
}

// ── MCP Server Mode ─────────────────────────────────────────

async function runServe(agent) {
  const mcpClient = agent.container.tryResolve('mcpClient');
  if (!mcpClient) {
    console.error('[CLI] MCP not available — check mcp.enabled in settings');
    process.exit(1);
  }

  const port = await mcpClient.startServer(flags.port);
  console.log(`[CLI] MCP server listening on http://127.0.0.1:${port}`);
  console.log('[CLI] Health: http://127.0.0.1:' + port + '/health');
  console.log('[CLI] SSE:    http://127.0.0.1:' + port + '/sse');
  console.log('\n[CLI] Running as daemon. Press Ctrl+C to stop.\n');

  // Keep alive
  const keepAlive = setInterval(() => {}, 60000);

  process.on('SIGINT', async () => {
    console.log('\n[CLI] Shutting down...');
    clearInterval(keepAlive);
    await agent.shutdown();
    process.exit(0);
  });

  process.on('SIGTERM', async () => {
    clearInterval(keepAlive);
    await agent.shutdown();
    process.exit(0);
  });
}

// ── Interactive REPL ────────────────────────────────────────

async function runREPL(agent) {
  // Also start MCP server in background
  const mcpClient = agent.container.tryResolve('mcpClient');
  if (mcpClient) {
    try {
      const port = await mcpClient.startServer(flags.port);
      console.log(`[CLI] MCP server on port ${port} (background)\n`);
    } catch (_e) { /* best effort */ }
  }

  const health = agent.getHealth();
  const model = health?.model?.active || 'unknown';
  console.log(`[CLI] Model: ${model}`);
  console.log('[CLI] Type your message. Commands: /health, /goals, /status, /quit\n');

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: 'You: ',
  });

  rl.prompt();

  rl.on('line', async (line) => {
    const input = line.trim();
    if (!input) { rl.prompt(); return; }

    // Commands
    if (input === '/quit' || input === '/exit') {
      console.log('\n[CLI] Shutting down...');
      rl.close();
      await agent.shutdown();
      process.exit(0);
    }

    if (input === '/health') {
      const h = agent.getHealth();
      console.log('\n' + JSON.stringify({
        model: h.model?.active,
        modules: h.modules,
        memory: h.memory,
        goals: h.goals,
        uptime: Math.round(h.uptime) + 's',
        services: h.services,
        organism: {
          mood: h.organism?.emotions?.mood,
          energy: h.organism?.metabolism?.energy,
        },
      }, null, 2) + '\n');
      rl.prompt();
      return;
    }

    if (input === '/goals') {
      const goalStack = agent.container.tryResolve('goalStack');
      const goals = goalStack ? goalStack.getAll() : [];
      if (goals.length === 0) {
        console.log('\nNo active goals.\n');
      } else {
        for (const g of goals) {
          console.log(`  [${g.status}] ${g.description} (${g.id.slice(0, 8)})`);
        }
        console.log();
      }
      rl.prompt();
      return;
    }

    if (input === '/status') {
      const h = agent.getHealth();
      console.log(`\n  Model:    ${h.model?.active || 'none'}`);
      console.log(`  Services: ${h.services}`);
      console.log(`  Uptime:   ${Math.round(h.uptime)}s`);
      console.log(`  Goals:    ${h.goals?.active || 0} active`);
      console.log(`  Circuit:  ${h.circuit?.state || 'unknown'}`);
      console.log(`  Memory:   ${h.memory?.conversations || 0} conversations\n`);
      rl.prompt();
      return;
    }

    if (input.startsWith('/')) {
      console.log('  Unknown command. Available: /health, /goals, /status, /quit\n');
      rl.prompt();
      return;
    }

    // Chat
    try {
      process.stdout.write('\nGenesis: ');
      await agent.handleChatStream(input,
        (chunk) => process.stdout.write(chunk),
        () => { process.stdout.write('\n\n'); rl.prompt(); }
      );
    } catch (err) {
      console.error(`\n[Error] ${err.message}\n`);
      rl.prompt();
    }
  });

  rl.on('close', async () => {
    await agent.shutdown();
    process.exit(0);
  });

  process.on('SIGINT', () => {
    console.log('\n');
    rl.close();
  });
}

// ── Main ────────────────────────────────────────────────────

(async () => {
  try {
    const agent = await boot();
    if (flags.serve) {
      await runServe(agent);
    } else {
      await runREPL(agent);
    }
  } catch (err) {
    console.error('[CLI] Boot failed:', err.message);
    console.error(err.stack);
    process.exit(1);
  }
})();
