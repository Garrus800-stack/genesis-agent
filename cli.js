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
  full:      args.includes('--full'),
  quiet:     !args.includes('--verbose'),
  noBoot:    args.includes('--no-boot-log'),
  help:      args.includes('--help') || args.includes('-h'),
  once:      args.includes('--once'),
  // V7-4A: Control channel client mode
  ctl:       args.includes('ctl'),
  backend:   (() => {
    const idx = args.indexOf('--backend');
    return idx >= 0 && args[idx + 1] ? args[idx + 1] : null;
  })(),
  port:      (() => {
    const idx = args.indexOf('--port');
    return idx >= 0 && args[idx + 1] ? parseInt(args[idx + 1], 10) : 3580;
  })(),
  // v6.0.4: --skip-phase N[,N] for layer A/B benchmarking
  skipPhases: (() => {
    const idx = args.indexOf('--skip-phase');
    if (idx < 0 || !args[idx + 1]) return [];
    return args[idx + 1].split(',').map(Number).filter(n => n >= 6 && n <= 13);
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
  node cli.js --cognitive    Cognitive profile — default (~140 services)
  node cli.js --full         Full profile (same as cognitive since v7.0.0)
  node cli.js --skip-phase 7       Skip specific phases (6-12) for A/B testing
  node cli.js --skip-phase 7,9     Skip multiple phases
  node cli.js --verbose      Show all Genesis logs (default: warn only)
  node cli.js --no-boot-log  Suppress boot messages (for scripts)
  node cli.js --once "msg"   Send one message, print response, exit
  node cli.js --backend X    Use specific backend (ollama, anthropic, openai)
  node cli.js ctl <cmd>      Control a running Genesis instance (no boot)
  node cli.js --help         Show this help

Control commands (ctl):
  node cli.js ctl ping                  Check if daemon is reachable
  node cli.js ctl status                Show daemon status
  node cli.js ctl goal "description"    Push a goal to the agent loop
  node cli.js ctl chat "message"       Send a chat message and get response
  node cli.js ctl check health          Run a daemon check (health|optimize|gaps|consolidate|learn)
  node cli.js ctl config                Show daemon config
  node cli.js ctl config key value      Set daemon config key
  node cli.js ctl stop                  Stop the daemon gracefully
  node cli.js ctl update                Check for updates (report only)
  node cli.js ctl update --apply        Check and apply update via DeploymentManager

Environment:
  GENESIS_API_KEY            Anthropic API key (optional)
  GENESIS_OPENAI_KEY         OpenAI API key (optional)
  GENESIS_MODEL              Preferred model name (optional)
  GENESIS_SOCKET             Custom socket path for control channel (optional)
  GENESIS_AB_MODE            A/B test mode: baseline, no-organism, no-consciousness
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
  if (!flags.noBoot) {
    console.log('\n╔══════════════════════════════════════════════╗');
    console.log('║     GENESIS — Headless Mode                  ║');
    console.log('╚══════════════════════════════════════════════╝\n');
  }

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
  // v6.0.4: Default changed to cognitive — consciousness A/B showed 0pp impact
  const bootProfile = flags.minimal ? 'minimal' : flags.full ? 'full' : 'cognitive';
  if (!flags.noBoot) console.log(`[CLI] Boot profile: ${bootProfile}`);

  // Create AgentCore without window
  const agent = new AgentCore({
    rootDir: ROOT,
    guard,
    window: null,  // Headless — no BrowserWindow
    bootProfile,
    skipPhases: flags.skipPhases,
  });

  // Apply environment overrides before boot
  _applyEnvOverrides(agent);

  await agent.boot();
  if (!flags.noBoot) console.log('[CLI] Agent booted successfully.\n');

  // FIX v6.0.4: --backend flag was parsed but never applied.
  // switchModel() must be called AFTER boot (ModelBridge needs Ollama model list).
  // Format: --backend ollama:model-name → strip prefix, switchTo expects just model name.
  if (flags.backend) {
    try {
      const modelName = flags.backend.includes(':')
        ? flags.backend.replace(/^(ollama|anthropic|openai):/, '')
        : flags.backend;
      await agent.switchModel(modelName);
      if (!flags.noBoot) console.log(`[CLI] Switched to backend: ${modelName}`);
    } catch (err) {
      console.warn(`[CLI] Failed to switch to ${flags.backend}: ${err.message}`);
    }
  }

  // v5.9.1: Suppress info logs in CLI to keep output clean
  if (flags.quiet || flags.noBoot) {
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
  const modelBridge = agent.container.tryResolve('model');
  const settings = agent.container.tryResolve('settings');
  const activeModel = health?.model?.active || 'unknown';
  const preferred = settings?.get?.('models.preferred');

  // v6.0.5: First-run detection — help user pick a good model
  if (!preferred && modelBridge) {
    const ranked = modelBridge.getRankedModels();
    const score = modelBridge._scoreModel(activeModel);

    if (ranked.length > 1 && score < 50) {
      // Currently using a weak model — suggest better alternatives
      console.log(`\n  ⚠  Current model: ${activeModel} (quality: ${score}/100 — not recommended for code tasks)`);
      const better = ranked.filter(m => m.score > score).slice(0, 3);
      if (better.length > 0) {
        console.log('  Better models available:');
        for (const m of better) {
          console.log(`    → /model ${m.name}  (${m.note}, score: ${m.score})`);
        }
      }
      console.log('  Run /models for full list. Your choice is saved automatically.\n');
    } else if (ranked.length === 0) {
      console.log('\n  ⚠  No models found. Start Ollama or set an API key:');
      console.log('     ollama serve                         (start Ollama)');
      console.log('     Anthropic API-Key: sk-ant-...        (in chat)\n');
    } else {
      console.log(`[CLI] Model: ${activeModel} (score: ${score}/100)`);
    }
  } else {
    console.log(`[CLI] Model: ${activeModel}`);
  }

  console.log('[CLI] Commands: /models, /model <name>, /health, /status, /goals, /skills, /network, /trace, /traces, /replay <id>, /selfmodel, /quit\n');

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

    // ── v6.0.5: Model management ──────────────────────────
    if (input === '/models') {
      const model = agent.container.tryResolve('model');
      if (!model) { console.log('\n  ModelBridge not available.\n'); rl.prompt(); return; }
      const ranked = model.getRankedModels();
      if (ranked.length === 0) {
        console.log('\n  No models available. Start Ollama or configure an API key.\n');
      } else {
        console.log('\n  Available models (ranked by capability):\n');
        for (const m of ranked) {
          const marker = m.active ? ' ← active' : '';
          const bar = '█'.repeat(Math.round(m.score / 10)) + '░'.repeat(10 - Math.round(m.score / 10));
          console.log(`    ${bar} ${String(m.score).padStart(3)} ${m.name} (${m.backend})${marker}`);
          console.log(`${''.padStart(16)}${m.note}`);
        }
        console.log(`\n  Switch: /model <name>   Example: /model qwen2.5:7b\n`);
      }
      rl.prompt();
      return;
    }

    if (input.startsWith('/model ')) {
      const modelName = input.slice('/model '.length).trim();
      if (!modelName) { console.log('\n  Usage: /model <name>\n'); rl.prompt(); return; }
      try {
        await agent.switchModel(modelName);
        const model = agent.container.tryResolve('model');
        console.log(`\n  ✅ Switched to: ${model.activeModel} (${model.activeBackend})`);
        // Save as preferred
        const settings = agent.container.tryResolve('settings');
        if (settings) {
          settings.set('models.preferred', modelName);
          console.log(`  Saved as preferred model.\n`);
        }
      } catch (err) {
        console.log(`\n  ❌ ${err.message}`);
        console.log('  Run /models to see available models.\n');
      }
      rl.prompt();
      return;
    }

    // ── v6.0.0 (V6-6): Skill CLI commands ─────────────────
    if (input === '/skills' || input === '/skill list') {
      const registry = agent.container.tryResolve('skillRegistry');
      const manager = agent.container.tryResolve('skills');
      if (!registry && !manager) {
        console.log('\n  SkillRegistry not available.\n');
      } else {
        const installed = registry ? registry.list() : [];
        const builtIn = manager?.listSkills?.() || [];
        if (builtIn.length > 0) {
          console.log('\n  Built-in skills:');
          for (const s of builtIn) console.log(`    ✓ ${s.name || s}`);
        }
        if (installed.length > 0) {
          console.log('  Community skills:');
          for (const s of installed) console.log(`    ◆ ${s.name}@${s.version} (${s.source})`);
        }
        if (builtIn.length === 0 && installed.length === 0) {
          console.log('\n  No skills installed.');
        }
        console.log();
      }
      rl.prompt();
      return;
    }

    if (input.startsWith('/skill install ')) {
      const source = input.slice('/skill install '.length).trim();
      if (!source) {
        console.log('\n  Usage: /skill install <github-url|npm:package|gist-url>\n');
        rl.prompt();
        return;
      }
      const registry = agent.container.tryResolve('skillRegistry');
      if (!registry) {
        console.log('\n  SkillRegistry not available.\n');
        rl.prompt();
        return;
      }
      console.log(`\n  Installing from ${source}...`);
      try {
        const result = await registry.install(source);
        console.log(`  ✓ Installed ${result.name}@${result.version}\n`);
      } catch (err) {
        console.log(`  ✗ Install failed: ${err.message}\n`);
      }
      rl.prompt();
      return;
    }

    if (input.startsWith('/skill uninstall ')) {
      const name = input.slice('/skill uninstall '.length).trim();
      if (!name) {
        console.log('\n  Usage: /skill uninstall <name>\n');
        rl.prompt();
        return;
      }
      const registry = agent.container.tryResolve('skillRegistry');
      if (!registry) {
        console.log('\n  SkillRegistry not available.\n');
        rl.prompt();
        return;
      }
      try {
        await registry.uninstall(name);
        console.log(`\n  ✓ Uninstalled ${name}\n`);
      } catch (err) {
        console.log(`\n  ✗ Uninstall failed: ${err.message}\n`);
      }
      rl.prompt();
      return;
    }

    if (input.startsWith('/skill update ')) {
      const name = input.slice('/skill update '.length).trim();
      if (!name) {
        console.log('\n  Usage: /skill update <name>\n');
        rl.prompt();
        return;
      }
      const registry = agent.container.tryResolve('skillRegistry');
      if (!registry) {
        console.log('\n  SkillRegistry not available.\n');
        rl.prompt();
        return;
      }
      try {
        const result = await registry.update(name);
        console.log(`\n  ✓ Updated ${result.name}@${result.version}\n`);
      } catch (err) {
        console.log(`\n  ✗ Update failed: ${err.message}\n`);
      }
      rl.prompt();
      return;
    }

    // ── v6.0.0: Consolidation + Replay CLI commands ──────
    if (input === '/consolidate') {
      const mc = agent.container.tryResolve('memoryConsolidator');
      if (!mc) {
        console.log('\n  MemoryConsolidator not available.\n');
      } else {
        console.log('\n  Running memory consolidation...');
        try {
          const report = await mc.consolidate();
          if (report.skipped) {
            console.log(`  ⏳ Skipped: ${report.reason}\n`);
          } else {
            console.log(`  ✓ KG: ${report.kg.merged} merged, ${report.kg.pruned} pruned`);
            console.log(`  ✓ Lessons: ${report.lessons.archived} archived, ${report.lessons.decayed} decayed`);
            console.log(`  ✓ Duration: ${report.durationMs}ms\n`);
          }
        } catch (err) {
          console.log(`  ✗ Failed: ${err.message}\n`);
        }
      }
      rl.prompt();
      return;
    }

    if (input === '/replays') {
      const tr = agent.container.tryResolve('taskRecorder');
      if (!tr) {
        console.log('\n  TaskRecorder not available.\n');
      } else {
        const recent = tr.list(10);
        if (recent.length === 0) {
          console.log('\n  No recordings yet.\n');
        } else {
          console.log('\n  Recent recordings:');
          for (const r of recent) {
            const date = new Date(r.startedAt).toISOString().slice(0, 16);
            const status = r.outcome?.success ? '✓' : r.outcome?.success === false ? '✗' : '·';
            console.log(`    ${status} ${r.id.slice(0, 16)} ${date} ${(r.goalDescription || '').slice(0, 50)}`);
          }
          console.log();
        }
      }
      rl.prompt();
      return;
    }

    if (input.startsWith('/replay ')) {
      const tr = agent.container.tryResolve('taskRecorder');
      if (!tr) {
        console.log('\n  TaskRecorder not available.\n');
      } else {
        const recordingId = input.slice(8).trim();
        const manifest = tr.buildReplayManifest(recordingId);
        if (!manifest) {
          // Try partial match
          const recent = tr.list(50);
          const match = recent.find(r => r.id.startsWith(recordingId));
          if (match) {
            const m = tr.buildReplayManifest(match.id);
            console.log('\n' + tr.formatReplay(m) + '\n');
          } else {
            console.log(`\n  Recording "${recordingId}" not found. Run /replays to see available.\n`);
          }
        } else {
          console.log('\n' + tr.formatReplay(manifest) + '\n');
        }
      }
      rl.prompt();
      return;
    }

    if (input.startsWith('/')) {
      // ── v6.0.5: Network status + Provenance trace ──

      if (input === '/network') {
        const ns = agent.container.tryResolve('networkSentinel');
        if (!ns) {
          console.log('\n  NetworkSentinel not available.\n');
        } else {
          const s = ns.getStatus();
          const icon = s.online ? '🟢' : '🔴';
          console.log(`\n  Network: ${icon} ${s.online ? 'ONLINE' : 'OFFLINE'}`);
          if (s.failoverActive) console.log(`  Failover: active → local Ollama (was: ${s.previousModel})`);
          console.log(`  Ollama local: ${s.ollamaAvailable ? 'available' : 'not detected'}`);
          console.log(`  Probes: ${s.stats.probes} total, ${s.stats.failures} failed`);
          console.log(`  Failovers: ${s.stats.failovers} | Restores: ${s.stats.restores}`);
          if (s.queueSize > 0) console.log(`  Mutation queue: ${s.queueSize} pending`);
          console.log();
        }
        rl.prompt();
        return;
      }

      if (input === '/trace') {
        const ep = agent.container.tryResolve('executionProvenance');
        if (!ep) {
          console.log('\n  ExecutionProvenance not available.\n');
        } else {
          const last = ep.getLastTrace();
          if (!last) {
            console.log('\n  No traces recorded yet.\n');
          } else {
            console.log('\n' + ep.formatTrace(last) + '\n');
          }
        }
        rl.prompt();
        return;
      }

      if (input === '/traces') {
        const ep = agent.container.tryResolve('executionProvenance');
        if (!ep) {
          console.log('\n  ExecutionProvenance not available.\n');
        } else {
          const recent = ep.getRecentTraces(5);
          if (recent.length === 0) {
            console.log('\n  No traces recorded yet.\n');
          } else {
            console.log(`\n  Recent traces (${recent.length}):\n`);
            for (const t of recent) {
              const msg = (t.input?.message || '').slice(0, 50);
              const tier = t.budget?.tier || '?';
              const ms = t.duration || 0;
              const outcome = t.response?.outcome || '·';
              const icon = outcome === 'success' ? '✓' : outcome === 'error' ? '✗' : '·';
              console.log(`    ${icon} [${tier}] ${ms}ms  "${msg}"`);
            }
            console.log();
          }
        }
        rl.prompt();
        return;
      }

      // ── v6.0.1: Budget, Backup, CrashLog, Update CLI commands ──

      if (input === '/budget') {
        const cg = agent.container.tryResolve('costGuard');
        if (!cg) {
          console.log('\n  CostGuard not available.\n');
        } else {
          const u = cg.getUsage();
          console.log('\n  LLM Budget:');
          console.log(`    Session: ${u.session.pct}% used (${u.session.tokens} / ${u.session.limit} tokens, ${u.session.calls} calls)`);
          console.log(`    Daily:   ${u.daily.pct}% used (${u.daily.tokens} / ${u.daily.limit} tokens, ${u.daily.calls} calls)`);
          console.log(`    Blocked: ${u.blocked} calls | Uptime: ${u.sessionUptime} min\n`);
        }
        rl.prompt();
        return;
      }

      if (input === '/export') {
        const { BackupManager } = require('./src/agent/capabilities/BackupManager');
        const bm = new BackupManager(agent._genesisDir || require('path').join(require('os').homedir(), '.genesis'), { bus: agent.bus });
        console.log('\n  Exporting data...');
        try {
          const result = await bm.export();
          if (result.success) {
            console.log(`  ✓ Exported ${result.stats.files} files → ${result.path}`);
            console.log(`    Size: ${(result.stats.archiveSize / 1024).toFixed(0)} KB\n`);
          } else {
            console.log(`  ✗ Export failed: ${result.error}\n`);
          }
        } catch (err) {
          console.log(`  ✗ Export failed: ${err.message}\n`);
        }
        rl.prompt();
        return;
      }

      if (input.startsWith('/import ')) {
        const filePath = input.slice(8).trim();
        if (!filePath) {
          console.log('\n  Usage: /import <path-to-backup.tar.gz>\n');
        } else {
          const { BackupManager } = require('./src/agent/capabilities/BackupManager');
          const bm = new BackupManager(agent._genesisDir || require('path').join(require('os').homedir(), '.genesis'), { bus: agent.bus });
          console.log(`\n  Importing from ${filePath}...`);
          try {
            const result = await bm.import(filePath);
            if (result.success) {
              console.log(`  ✓ Imported ${result.stats.imported} files, skipped ${result.stats.skipped}\n`);
            } else {
              console.log(`  ✗ Import failed: ${result.error}\n`);
            }
          } catch (err) {
            console.log(`  ✗ Import failed: ${err.message}\n`);
          }
        }
        rl.prompt();
        return;
      }

      if (input === '/crashlog') {
        const cl = agent.container.tryResolve('crashLog');
        if (!cl) {
          console.log('\n  CrashLog not available.\n');
        } else {
          const stats = cl.getStats();
          const entries = cl.getRecent(20);
          console.log(`\n  Crash Log (${stats.totalEntries} entries: ${stats.errors} errors, ${stats.warns} warnings):`);
          if (entries.length === 0) {
            console.log('    No entries.\n');
          } else {
            for (const e of entries) {
              const time = e.ts.slice(11, 19);
              const icon = e.level === 'error' ? '✗' : '⚠';
              console.log(`    ${icon} ${time} [${e.module}] ${e.msg.slice(0, 100)}`);
            }
            console.log();
          }
        }
        rl.prompt();
        return;
      }

      if (input === '/update') {
        const au = agent.container.tryResolve('autoUpdater');
        if (!au) {
          console.log('\n  AutoUpdater not available.\n');
        } else {
          console.log('\n  Checking for updates...');
          try {
            const result = await au.checkForUpdate();
            if (result.available) {
              console.log(`  ✓ New version available: v${result.latest} (current: v${result.current})`);
              console.log(`    Download: ${result.url}\n`);
            } else {
              console.log(`  ✓ Up to date (v${result.current})\n`);
            }
          } catch (err) {
            console.log(`  ✗ Check failed: ${err.message}\n`);
          }
        }
        rl.prompt();
        return;
      }

      // v6.0.6: SelfModel Dashboard — CLI view of cognitive self-awareness
      if (input === '/selfmodel') {
        const sm = agent.container.tryResolve('cognitiveSelfModel');
        if (!sm) {
          console.log('\n  CognitiveSelfModel not available.\n');
        } else {
          const report = sm.getReport();
          console.log('\n  ── Cognitive Self-Model ──');

          // Capability Profile
          const profile = report.profile || {};
          const types = Object.keys(profile);
          if (types.length > 0) {
            console.log('\n  Capability Profile:');
            for (const type of types) {
              const p = profile[type];
              const bar = '█'.repeat(Math.round((p.successRate || 0) * 10)).padEnd(10, '░');
              const weak = p.isWeak ? ' ⚠ WEAK' : p.isStrong ? ' ★ STRONG' : '';
              console.log(`    ${type.padEnd(15)} ${bar} ${Math.round((p.successRate || 0) * 100)}%${weak}`);
            }
          } else {
            console.log('\n  No capability data yet — needs more task outcomes.');
          }

          // Backend Strength Map
          const backends = report.backendMap || {};
          const bKeys = Object.keys(backends);
          if (bKeys.length > 0) {
            console.log('\n  Backend Strength:');
            for (const bk of bKeys) {
              const b = backends[bk];
              console.log(`    ${bk.padEnd(20)} score: ${b.score?.toFixed(2) || '?'}  tasks: ${b.tasks || 0}`);
            }
          }

          // Bias Patterns
          const biases = report.biases || [];
          if (biases.length > 0) {
            console.log('\n  Detected Biases:');
            for (const bias of biases) {
              console.log(`    ⚠ ${bias.type}: ${bias.description || bias.evidence || ''}`);
            }
          }

          console.log(`\n  Stats: ${report.stats?.outcomesProcessed || 0} outcomes processed`);
          console.log();
        }
        rl.prompt();
        return;
      }

      // v6.0.6: Deployment status + history
      if (input === '/deploy') {
        const dm = agent.container.tryResolve('deploymentManager');
        if (!dm) {
          console.log('\n  DeploymentManager not available.\n');
        } else {
          const health = dm.getHealth();
          const recent = dm.listDeployments(5);
          console.log('\n  ── Deployments ──');
          console.log(`  Total: ${health.total} | Active: ${health.active} | Succeeded: ${health.succeeded} | Failed: ${health.failed} | Rolled back: ${health.rolledBack}`);
          if (recent.length > 0) {
            console.log('\n  Recent:');
            for (const d of recent) {
              const icon = d.status === 'done' ? '✓' : d.status === 'failed' ? '✗' : d.status === 'rolled-back' ? '↩' : '·';
              const dur = d.completedAt ? `${d.completedAt - d.startedAt}ms` : 'running';
              console.log(`    ${icon} ${d.id.slice(0, 12)} [${d.strategy}] ${d.target} → ${d.status} (${dur})`);
            }
          } else {
            console.log('\n  No deployments yet.');
          }
          console.log();
        }
        rl.prompt();
        return;
      }

      // v6.0.2: Manual adaptation cycle
      if (input === '/adapt') {
        const strategy = agent.container.tryResolve('adaptiveStrategy');
        if (!strategy) {
          console.log('\n  AdaptiveStrategy not available.\n');
        } else {
          console.log('\n  Running adaptation cycle...');
          try {
            const result = await strategy.runCycle();
            if (result) {
              const icon = result.status === 'confirmed' ? '✓' : result.status === 'rolled-back' ? '✗' : '⏳';
              console.log(`  ${icon} ${result.type}: ${result.evidence || 'n/a'}`);
              if (result.delta != null) {
                console.log(`    Delta: ${result.delta >= 0 ? '+' : ''}${Math.round(result.delta * 100)}pp`);
              }
              console.log(`    Status: ${result.status}\n`);
            } else {
              console.log('  No adaptation needed — all metrics stable.\n');
            }
          } catch (err) {
            console.log(`  ✗ Adaptation failed: ${err.message}\n`);
          }
        }
        rl.prompt();
        return;
      }

      // v6.0.2: Adaptation history
      if (input === '/adaptations') {
        const strategy = agent.container.tryResolve('adaptiveStrategy');
        if (!strategy) {
          console.log('\n  AdaptiveStrategy not available.\n');
        } else {
          const report = strategy.getReport();
          console.log(`\n  Adaptations — proposed: ${report.stats.proposed}, applied: ${report.stats.applied}, ` +
            `confirmed: ${report.stats.confirmed}, rolled back: ${report.stats.rolledBack}`);

          if (report.active.length > 0) {
            console.log('  Active:');
            for (const a of report.active) {
              console.log(`    ⏳ ${a.type}: ${a.evidence || a.hypothesis || 'n/a'} (${a.status})`);
            }
          }

          const recent = report.history.slice(-10);
          if (recent.length > 0) {
            console.log('  Recent:');
            for (const a of recent) {
              const icon = a.status === 'confirmed' ? '✓' : a.status === 'rolled-back' ? '✗' : '○';
              const delta = a.delta != null ? ` ${a.delta >= 0 ? '+' : ''}${Math.round(a.delta * 100)}pp` : '';
              console.log(`    ${icon} ${a.type}: ${a.evidence || 'n/a'}${delta}`);
            }
          } else if (report.active.length === 0) {
            console.log('  No adaptations recorded yet.');
          }
          console.log();
        }
        rl.prompt();
        return;
      }

      // v6.0.7: Earned Autonomy report
      if (input === '/autonomy') {
        const ea = agent.container.tryResolve('earnedAutonomy');
        const trust = agent.container.tryResolve('trustLevelSystem');
        if (!ea) {
          console.log('\n  EarnedAutonomy not available.\n');
        } else {
          const report = ea.getReport();
          const stats = ea.getStats();
          const trustStatus = trust?.getStatus?.();

          console.log('\n  ── Earned Autonomy ──');
          if (trustStatus) {
            console.log(`  Trust level: ${trustStatus.levelName} (${trustStatus.level})`);
            console.log(`  Auto-approves: ${trustStatus.autoApproves.join(', ') || 'none'}`);
            const overrides = Object.keys(trustStatus.overrides);
            if (overrides.length > 0) {
              console.log(`  Earned overrides: ${overrides.join(', ')}`);
            }
          }

          if (report.length > 0) {
            console.log('\n  Per-Action Confidence (Wilson score lower bound):');
            for (const r of report) {
              const bar = '█'.repeat(Math.round(r.wilsonLower / 10)).padEnd(10, '░');
              const status = r.promoted ? ' ✓ EARNED' : '';
              console.log(`    ${r.actionType.padEnd(18)} ${bar} ${r.wilsonLower}% (${r.successes}/${r.samples})${status}`);
            }
          } else {
            console.log('\n  No action data yet — needs task executions.');
          }

          console.log(`\n  Stats: ${stats.recorded} recorded, ${stats.promotions} promotions, ${stats.revocations} revocations\n`);
        }
        rl.prompt();
        return;
      }

      console.log('  Unknown command. Available: /health, /goals, /network, /trace, /traces, /replay <id>, /selfmodel, /status, /skills, /skill install|uninstall|update, /consolidate, /replays, /budget, /export, /import, /crashlog, /update, /adapt, /adaptations, /autonomy, /quit\n');
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

// ── Single Message Mode ────────────────────────────────────

async function runOnce(agent) {
  // Collect message from remaining args (after flags)
  const skipFlags = new Set(['--once', '--no-boot-log', '--minimal', '--cognitive', '--full', '--verbose', '--backend', '--ab-mode', '--skip-phase']);
  const msgParts = [];
  let skipNext = false;
  for (const arg of args) {
    if (skipNext) { skipNext = false; continue; }
    if (skipFlags.has(arg)) { if (arg === '--backend' || arg === '--ab-mode' || arg === '--skip-phase') skipNext = true; continue; }
    if (arg.startsWith('--')) continue;
    msgParts.push(arg);
  }
  const message = msgParts.join(' ').trim();

  if (!message) {
    console.error('[CLI] --once requires a message. Usage: node cli.js --once "your message"');
    await agent.shutdown();
    process.exit(1);
  }

  try {
    let response = '';
    await agent.handleChatStream(message,
      (chunk) => { response += chunk; },
      () => {},
    );
    // Output clean response (no [CLI] prefix, no formatting — for script consumption)
    process.stdout.write(response);
  } catch (err) {
    console.error('[CLI:once] Error:', err.message);
  }

  await agent.shutdown();
  process.exit(0);
}

// ── Control Channel Client (V7-4A) ─────────────────────────

async function runCtl() {
  const net = require('net');
  const { resolveSocketPath } = require('./src/agent/autonomy/DaemonController');
  const socketPath = resolveSocketPath(process.env.GENESIS_SOCKET);

  // Parse: node cli.js ctl <method> [arg1] [arg2]
  const ctlIdx = args.indexOf('ctl');
  const ctlArgs = args.slice(ctlIdx + 1).filter(a => !a.startsWith('--'));
  const method = ctlArgs[0];

  if (!method) {
    console.error('Usage: node cli.js ctl <method> [params]\nMethods: ping, status, goal, chat, check, config, stop, clients');
    process.exit(1);
  }

  // Build params based on method
  let params = {};
  if (method === 'goal') {
    params = { description: ctlArgs.slice(1).join(' ') };
  } else if (method === 'chat') {
    params = { message: ctlArgs.slice(1).join(' ') };
  } else if (method === 'check') {
    params = { type: ctlArgs[1] || 'health' };
  } else if (method === 'config' && ctlArgs[1]) {
    params = ctlArgs[2] !== undefined
      ? { key: ctlArgs[1], value: isNaN(ctlArgs[2]) ? ctlArgs[2] : Number(ctlArgs[2]) }
      : { key: ctlArgs[1] };
  } else if (method === 'update') {
    // --apply triggers DeploymentManager if autoUpdater has _deploymentManager wired
    const apply = args.includes('--apply');
    params = { force: true, apply };
  }

  const id = String(Date.now());
  const req = JSON.stringify({ id, method, params }) + '\n';

  return new Promise((resolve) => {
    const client = net.createConnection(socketPath, () => {
      client.write(req);
    });

    let buf = '';
    client.on('data', (chunk) => {
      buf += chunk.toString();
      const nl = buf.indexOf('\n');
      if (nl !== -1) {
        const line = buf.slice(0, nl);
        client.destroy();
        try {
          const res = JSON.parse(line);
          if (res.error) {
            console.error(`Error: ${res.error.message} (code ${res.error.code})`);
            process.exit(1);
          } else {
            console.log(JSON.stringify(res.result, null, 2));
            process.exit(0);
          }
        } catch (e) {
          console.error('Invalid response:', line);
          process.exit(1);
        }
      }
    });

    client.on('error', (err) => {
      if (err.code === 'ENOENT' || err.code === 'ECONNREFUSED') {
        console.error(`Cannot connect to Genesis at ${socketPath}\nIs Genesis running with the control channel enabled?`);
      } else {
        console.error(`Connection error: ${err.message}`);
      }
      process.exit(1);
    });

    setTimeout(() => {
      client.destroy();
      console.error('Timeout: no response within 10s');
      process.exit(1);
    }, 10000);
  });
}

// ── Main ────────────────────────────────────────────────────

(async () => {
  // V7-4A: ctl mode runs without booting the agent
  if (flags.ctl) {
    await runCtl();
    return;
  }

  try {
    const agent = await boot();
    if (flags.serve) {
      await runServe(agent);
    } else if (flags.once) {
      await runOnce(agent);
    } else {
      await runREPL(agent);
    }
  } catch (err) {
    console.error('[CLI] Boot failed:', err.message);
    console.error(err.stack);
    process.exit(1);
  }
})();
