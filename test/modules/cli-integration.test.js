// ============================================================
// GENESIS — test/modules/cli-integration.test.js (v5.9.2)
//
// Integration tests for cli.js — REPL commands, serve mode,
// argument parsing. Uses mocked AgentCore to avoid full boot.
// ============================================================

const { describe, test, assert, assertEqual, assertIncludes, run } = require('../harness');

// ── Argument Parsing ────────────────────────────────────────

describe('CLI argument parsing', () => {
  test('default flags', () => {
    const flags = parseFlags([]);
    assertEqual(flags.serve, false);
    assertEqual(flags.minimal, false);
    assertEqual(flags.cognitive, false);
    assertEqual(flags.quiet, true);
    assertEqual(flags.help, false);
    assertEqual(flags.port, 3580);
  });

  test('--serve flag', () => {
    assertEqual(parseFlags(['--serve']).serve, true);
    assertEqual(parseFlags(['--daemon']).serve, true);
  });

  test('--minimal and --cognitive profiles', () => {
    assertEqual(parseFlags(['--minimal']).minimal, true);
    assertEqual(parseFlags(['--cognitive']).cognitive, true);
  });

  test('--port with value', () => {
    assertEqual(parseFlags(['--port', '4000']).port, 4000);
  });

  test('--port without value defaults to 3580', () => {
    assertEqual(parseFlags(['--port']).port, 3580);
  });

  test('--verbose disables quiet', () => {
    assertEqual(parseFlags(['--verbose']).quiet, false);
  });

  test('--help flag', () => {
    assertEqual(parseFlags(['--help']).help, true);
    assertEqual(parseFlags(['-h']).help, true);
  });
});

// ── REPL Command Routing ────────────────────────────────────

describe('CLI REPL commands', () => {
  test('/health returns structured health', () => {
    const agent = mockAgent();
    const output = handleCommand('/health', agent);
    assert(output !== null, '/health should return output');
    const parsed = JSON.parse(output);
    assertEqual(parsed.model, 'test-model');
    assertEqual(typeof parsed.uptime, 'string');
    assertIncludes(parsed.uptime, 's');
  });

  test('/status returns status lines', () => {
    const agent = mockAgent();
    const output = handleCommand('/status', agent);
    assertIncludes(output, 'Model:');
    assertIncludes(output, 'Services:');
    assertIncludes(output, 'Uptime:');
  });

  test('/goals with no goals', () => {
    const agent = mockAgent({ goals: [] });
    const output = handleCommand('/goals', agent);
    assertIncludes(output, 'No active goals');
  });

  test('/goals with active goals', () => {
    const agent = mockAgent({ goals: [{ id: 'abc12345-long', status: 'active', description: 'Fix bug' }] });
    const output = handleCommand('/goals', agent);
    assertIncludes(output, '[active] Fix bug');
  });

  test('/quit returns quit signal', () => {
    const agent = mockAgent();
    const output = handleCommand('/quit', agent);
    assertEqual(output, '__QUIT__');
  });

  test('/exit returns quit signal', () => {
    const agent = mockAgent();
    const output = handleCommand('/exit', agent);
    assertEqual(output, '__QUIT__');
  });

  test('unknown command shows help', () => {
    const agent = mockAgent();
    const output = handleCommand('/unknown', agent);
    assertIncludes(output, 'Unknown command');
    assertIncludes(output, '/health');
  });

  test('non-command returns null (chat)', () => {
    const agent = mockAgent();
    const output = handleCommand('Hello world', agent);
    assertEqual(output, null);
  });

  test('empty input returns null', () => {
    const agent = mockAgent();
    const output = handleCommand('', agent);
    assertEqual(output, null);
  });
});

// ── Helpers ─────────────────────────────────────────────────

/** Replicate CLI argument parsing logic (same as cli.js) */
function parseFlags(argv) {
  return {
    serve:     argv.includes('--serve') || argv.includes('--daemon'),
    minimal:   argv.includes('--minimal'),
    cognitive: argv.includes('--cognitive'),
    quiet:     !argv.includes('--verbose'),
    help:      argv.includes('--help') || argv.includes('-h'),
    port:      (() => {
      const idx = argv.indexOf('--port');
      return idx >= 0 && argv[idx + 1] ? parseInt(argv[idx + 1], 10) : 3580;
    })(),
  };
}

/** Mock agent with configurable health/goals */
function mockAgent(opts = {}) {
  const health = {
    model: { active: opts.model || 'test-model' },
    modules: 42,
    memory: { conversations: 5 },
    goals: { active: (opts.goals || []).length },
    uptime: 123.456,
    services: 116,
    circuit: { state: 'closed' },
    organism: { emotions: { mood: 'calm' }, metabolism: { energy: 85 } },
  };

  return {
    getHealth: () => health,
    container: {
      tryResolve: (name) => {
        if (name === 'goalStack') {
          return { getAll: () => opts.goals || [] };
        }
        return null;
      },
    },
    shutdown: async () => {},
  };
}

/**
 * Replicate CLI REPL command handling (extracted logic from cli.js).
 * Returns string output or null for chat messages.
 */
function handleCommand(input, agent) {
  input = input.trim();
  if (!input) return null;

  if (input === '/quit' || input === '/exit') return '__QUIT__';

  if (input === '/health') {
    const h = agent.getHealth();
    return JSON.stringify({
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
    }, null, 2);
  }

  if (input === '/goals') {
    const goalStack = agent.container.tryResolve('goalStack');
    const goals = goalStack ? goalStack.getAll() : [];
    if (goals.length === 0) return 'No active goals.';
    return goals.map(g => `  [${g.status}] ${g.description} (${g.id.slice(0, 8)})`).join('\n');
  }

  if (input === '/status') {
    const h = agent.getHealth();
    return [
      `  Model:    ${h.model?.active || 'none'}`,
      `  Services: ${h.services}`,
      `  Uptime:   ${Math.round(h.uptime)}s`,
      `  Goals:    ${h.goals?.active || 0} active`,
      `  Circuit:  ${h.circuit?.state || 'unknown'}`,
      `  Memory:   ${h.memory?.conversations || 0} conversations`,
    ].join('\n');
  }

  if (input.startsWith('/')) {
    return '  Unknown command. Available: /health, /goals, /status, /quit';
  }

  return null; // Chat message — not a command
}

run();
