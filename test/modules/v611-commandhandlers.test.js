// Test: v6.1.1 Coverage Sweep — CommandHandlers
// Target: 23% → ~60%+ (474 uncovered lines, biggest single win)

const { describe, test, assert, run } = require('../harness');
const { CommandHandlers } = require('../../src/agent/hexagonal/CommandHandlers');

function mockLang() {
  return { t: (k, v) => v ? `${k}:${JSON.stringify(v)}` : k, detect: () => {}, current: 'en' };
}
function mockBus() { return { on: () => () => {}, emit() {}, fire() {}, off() {} }; }

function createHandlers(overrides = {}) {
  return new CommandHandlers({
    bus: mockBus(), lang: mockLang(),
    sandbox: { execute: async (code) => ({ output: 'ok', error: null }) },
    fileProcessor: {
      getFileInfo: (f) => f === 'test.js' ? { name: 'test.js', extension: '.js', language: 'JavaScript', canExecute: true } : null,
      executeFile: async () => ({ output: 'file output', error: null }),
      getRuntimes: () => ({ node: true, python: false }),
      rootDir: '/tmp',
    },
    network: { scanLocalPeers: async () => [] },
    daemon: { stop() {}, start() {}, getStatus: () => ({ running: true, cycleCount: 5, knownGaps: [] }) },
    idleMind: { readJournal: (n) => [], getPlans: () => [] },
    analyzer: { analyze: async (msg) => 'analysis result' },
    goalStack: {
      addGoal: async (desc) => ({ description: desc, steps: [{ type: 'SHELL', action: 'test' }] }),
      getActiveGoals: () => [],
      getAll: () => [],
    },
    settings: {
      set: () => {},
      getAll: () => ({
        models: { anthropicApiKey: 'sk-test', openaiBaseUrl: null, preferred: 'auto' },
        daemon: { enabled: true, cycleMinutes: 5 },
        idleMind: { enabled: true, idleMinutes: 3 },
        security: { allowSelfModify: true },
      }),
    },
    webFetcher: {
      npmSearch: async (q) => ({ packages: [{ name: 'test-pkg', version: '1.0.0', description: 'A test' }] }),
      fetchText: async (url) => ({ ok: true, status: 200, body: 'Hello' }),
      ping: async (url) => ({ reachable: true, status: 200 }),
    },
    shellAgent: {
      run: async (cmd) => ({ ok: true, stdout: 'output', stderr: '', duration: 50, exitCode: 0 }),
      plan: async (task) => ({ summary: 'Planned: ' + task }),
      openWorkspace: async (dir) => ({ description: 'Workspace: ' + dir }),
    },
    mcpClient: {
      getStatus: () => ({ running: false, connectedServers: [] }),
    },
    ...overrides,
  });
}

// ── registerHandlers ────────────────────────────────────────

describe('CommandHandlers — registerHandlers', () => {
  test('registers all handler types', () => {
    const ch = createHandlers();
    const registered = [];
    const mockOrch = { registerHandler: (name) => registered.push(name) };
    ch.registerHandlers(mockOrch);
    assert(registered.length >= 15, `should register 15+ handlers, got ${registered.length}`);
    assert(registered.includes('execute-code'), 'should register execute-code');
    assert(registered.includes('goals'), 'should register goals');
    assert(registered.includes('trust-control'), 'should register trust-control');
    assert(registered.includes('run-skill'), 'should register run-skill');
  });
});

// ── executeCode ─────────────────────────────────────────────

describe('CommandHandlers — executeCode', () => {
  test('executes code block', async () => {
    const ch = createHandlers();
    const result = await ch.executeCode('run this:\n```js\nconsole.log(1)\n```');
    assert(result.includes('ok'), 'should contain sandbox output');
  });

  test('returns error when no code block', async () => {
    const ch = createHandlers();
    const result = await ch.executeCode('no code here');
    assert(result.includes('no_code_block'), 'should indicate no code block');
  });
});

// ── executeFile ─────────────────────────────────────────────

describe('CommandHandlers — executeFile', () => {
  test('executes known file', async () => {
    const ch = createHandlers();
    const result = await ch.executeFile('run test.js');
    assert(result.includes('file output'), 'should contain file output');
  });

  test('returns error for unknown file', async () => {
    const ch = createHandlers();
    const result = await ch.executeFile('run unknown.js');
    assert(result.includes('file_not_found'), 'should indicate file not found');
  });

  test('returns error when no file referenced', async () => {
    const ch = createHandlers();
    const result = await ch.executeFile('run something');
    assert(result.includes('no_file'), 'should indicate no file');
  });
});

// ── analyzeCode ─────────────────────────────────────────────

describe('CommandHandlers — analyzeCode', () => {
  test('delegates to analyzer', async () => {
    const ch = createHandlers();
    const result = await ch.analyzeCode('analyze this code');
    assert(result === 'analysis result', 'should return analyzer result');
  });
});

// ── daemonControl ───────────────────────────────────────────

describe('CommandHandlers — daemonControl', () => {
  test('stops daemon', async () => {
    let stopped = false;
    const ch = createHandlers({ daemon: { stop() { stopped = true; }, start() {}, getStatus: () => ({}) } });
    await ch.daemonControl('stop the daemon');
    assert(stopped, 'should call daemon.stop()');
  });

  test('starts daemon', async () => {
    let started = false;
    const ch = createHandlers({ daemon: { stop() {}, start() { started = true; }, getStatus: () => ({}) } });
    await ch.daemonControl('start daemon');
    assert(started, 'should call daemon.start()');
  });

  test('shows status', async () => {
    const ch = createHandlers();
    const result = await ch.daemonControl('daemon status');
    assert(result.includes('Daemon'), 'should show daemon status');
  });
});

// ── journal ─────────────────────────────────────────────────

describe('CommandHandlers — journal', () => {
  test('empty journal', async () => {
    const ch = createHandlers();
    const result = await ch.journal();
    assert(result.includes('journal.empty'), 'should indicate empty');
  });

  test('journal with entries', async () => {
    const ch = createHandlers({
      idleMind: {
        readJournal: () => [{ timestamp: '2025-01-01T00:00:00Z', activity: 'think', thought: 'deep thought' }],
        getPlans: () => [],
      },
    });
    const result = await ch.journal();
    assert(result.includes('deep thought'), 'should show journal entry');
  });
});

// ── plans ───────────────────────────────────────────────────

describe('CommandHandlers — plans', () => {
  test('empty plans', async () => {
    const ch = createHandlers();
    const result = await ch.plans();
    assert(result.includes('plans.empty'), 'should indicate empty');
  });

  test('plans with entries', async () => {
    const ch = createHandlers({
      idleMind: {
        readJournal: () => [],
        getPlans: () => [{ title: 'Optimize', priority: 'high', status: 'pending', description: 'Improve perf' }],
      },
    });
    const result = await ch.plans();
    assert(result.includes('Optimize'), 'should show plan');
  });
});

// ── goals ───────────────────────────────────────────────────

describe('CommandHandlers — goals', () => {
  test('no goalStack', async () => {
    const ch = createHandlers({ goalStack: null });
    const result = await ch.goals('show goals');
    assert(result.includes('goals.unavailable'), 'should indicate unavailable');
  });

  test('empty goals', async () => {
    const ch = createHandlers();
    const result = await ch.goals('show goals');
    assert(result.includes('goals.empty'), 'should indicate empty');
  });

  test('add goal via message', async () => {
    const ch = createHandlers();
    const result = await ch.goals('set goal: fix all bugs');
    assert(result.includes('fix all bugs'), 'should confirm goal');
  });

  test('show active goals', async () => {
    const ch = createHandlers({
      goalStack: {
        addGoal: async () => ({}),
        getActiveGoals: () => [{ description: 'Test', status: 'active', steps: [], currentStep: 0, priority: 'high' }],
        getAll: () => [{ description: 'Test', status: 'active', steps: [{ action: 'do it' }], currentStep: 0, priority: 'high' }],
      },
    });
    const result = await ch.goals('show goals');
    assert(result.includes('Test'), 'should show goal');
  });
});

// ── handleSettings ──────────────────────────────────────────

describe('CommandHandlers — handleSettings', () => {
  test('show settings', () => {
    const ch = createHandlers();
    const result = ch.handleSettings('show settings');
    assert(result.includes('Anthropic'), 'should show settings');
    assert(result.includes('Daemon'), 'should show daemon setting');
  });

  test('set API key', () => {
    let savedKey = null;
    const ch = createHandlers({
      settings: {
        set: (k, v) => { savedKey = v; },
        getAll: () => ({ models: {}, daemon: {}, idleMind: {}, security: {} }),
      },
    });
    ch.handleSettings('anthropic api key: sk-test12345678rest');
    assert(savedKey === 'sk-test12345678rest', 'should save key');
  });

  test('no settings available', () => {
    const ch = createHandlers({ settings: null });
    const result = ch.handleSettings('show');
    assert(result.includes('settings.unavailable'), 'should indicate unavailable');
  });
});

// ── webLookup ───────────────────────────────────────────────

describe('CommandHandlers — webLookup', () => {
  test('npm search', async () => {
    const ch = createHandlers();
    const result = await ch.webLookup('npm search package for testing');
    assert(result.includes('test-pkg'), 'should show npm results');
  });

  test('URL fetch', async () => {
    const ch = createHandlers();
    const result = await ch.webLookup('fetch https://example.com');
    assert(result.includes('Hello'), 'should show fetched content');
  });

  test('ping check', async () => {
    const ch = createHandlers();
    const result = await ch.webLookup('ping example.com');
    assert(result.includes('web.reachable'), 'should show reachable');
  });

  test('no web available', async () => {
    const ch = createHandlers({ webFetcher: null });
    const result = await ch.webLookup('search something');
    assert(result.includes('web.unavailable'), 'should indicate unavailable');
  });

  test('generic web hint', async () => {
    const ch = createHandlers();
    const result = await ch.webLookup('web stuff');
    assert(result.includes('web.hint'), 'should show hint');
  });
});

// ── runSkill ────────────────────────────────────────────────

describe('CommandHandlers — runSkill', () => {
  test('no skillManager', async () => {
    const ch = createHandlers();
    ch.skillManager = null;
    const result = await ch.runSkill('run test-skill');
    assert(result.includes('No SkillManager'), 'should indicate no manager');
  });

  test('list skills when no name given', async () => {
    const ch = createHandlers();
    ch.skillManager = { listSkills: () => [{ name: 'git-status', description: 'Git info' }] };
    const result = await ch.runSkill('run skill');
    assert(result.includes('git-status'), 'should list skills');
  });

  test('execute named skill', async () => {
    const ch = createHandlers();
    ch.skillManager = {
      listSkills: () => [],
      executeSkill: async () => ({ output: 'skill-result' }),
    };
    const result = await ch.runSkill('run my-test-skill');
    assert(result.includes('skill-result'), 'should show result');
  });
});

// ── shellTask + shellRun ────────────────────────────────────

describe('CommandHandlers — shell', () => {
  test('shellTask plans execution', async () => {
    const ch = createHandlers();
    const result = await ch.shellTask('setup the project');
    assert(result.includes('Planned'), 'should show plan');
  });

  test('shellRun executes command', async () => {
    const ch = createHandlers();
    const result = await ch.shellRun('$ ls -la');
    assert(result.includes('output'), 'should show output');
  });

  test('shellRun with no shell', async () => {
    const ch = createHandlers({ shellAgent: null });
    const result = await ch.shellRun('ls');
    assert(result.includes('shell_unavailable'), 'should indicate unavailable');
  });

  test('shellRun with empty command', async () => {
    const ch = createHandlers();
    const result = await ch.shellRun('');
    assert(result.includes('no_command'), 'should indicate no command');
  });

  test('shellRun with blocked command', async () => {
    const ch = createHandlers({
      shellAgent: {
        run: async () => ({ ok: false, blocked: true, stderr: 'dangerous', stdout: '', exitCode: 1 }),
        plan: async () => ({}),
        openWorkspace: async () => ({}),
      },
    });
    const result = await ch.shellRun('rm -rf /');
    assert(result.includes('blocked_command'), 'should show blocked');
  });

  test('shellRun with error exit', async () => {
    const ch = createHandlers({
      shellAgent: {
        run: async () => ({ ok: false, blocked: false, stderr: 'not found', stdout: '', exitCode: 127, duration: 10 }),
        plan: async () => ({}),
        openWorkspace: async () => ({}),
      },
    });
    const result = await ch.shellRun('badcommand');
    assert(result.includes('127'), 'should show exit code');
  });
});

// ── projectScan ─────────────────────────────────────────────

describe('CommandHandlers — projectScan', () => {
  test('scans workspace', async () => {
    const ch = createHandlers();
    const result = await ch.projectScan('scan this directory');
    assert(result.includes('Workspace'), 'should show workspace info');
  });
});

// ── mcpControl ──────────────────────────────────────────────

describe('CommandHandlers — mcpControl', () => {
  test('no mcp available', async () => {
    const ch = createHandlers({ mcpClient: null });
    const result = await ch.mcpControl('mcp status');
    assert(result.includes('mcp.unavailable'), 'should indicate unavailable');
  });
});

run();
