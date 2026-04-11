// ============================================================
// TEST — CommandHandlers.js (v7.1.1 coverage expansion)
// Target: 22% → 65%+ lines
// ============================================================

const { describe, test, assert, assertEqual, run } = require('../harness');
const { CommandHandlers } = require('../../src/agent/hexagonal/CommandHandlers');

// ── Mock factory ─────────────────────────────────────────────

function makeDeps(overrides = {}) {
  const bus = { emitted: [], emit(ev, d, o) { this.emitted.push({ ev, d }); }, fire() {} };
  bus._container = { resolve: () => null };

  return {
    bus,
    lang: { t: (k, v) => v ? `${k}:${JSON.stringify(v)}` : k, detect: () => {}, current: 'en' },
    sandbox: { execute: async (code) => ({ output: 'ok', error: null }) },
    fileProcessor: {
      getFileInfo: (f) => ({ name: f, extension: '.js', language: 'JavaScript', canExecute: true }),
      getRuntimes: () => ({ node: true }),
      executeFile: async () => ({ output: 'file output', error: null }),
      rootDir: '/tmp',
    },
    network: {
      peers: new Map(),
      _token: 'tok',
      scanLocalPeers: async () => [],
      getPeerStatus: () => [],
      getNetworkStats: () => ({ protocol: '1', listening: 3000, totalPeers: 0, healthyPeers: 0, trustedPeers: 0 }),
      trustPeer: () => true,
      importPeerSkill: async () => ({ success: true, reason: 'ok' }),
      compareWithPeer: async () => ({ decision: 'equal', analysis: 'same' }),
    },
    daemon: { stop() {}, start() {}, getStatus: () => ({ running: true, cycleCount: 5, knownGaps: [] }) },
    idleMind: {
      readJournal: (n) => [{ timestamp: '2026-04-11T12:00:00Z', activity: 'think', thought: 'test' }],
      getPlans: () => [{ title: 'Plan A', priority: 'high', status: 'active', description: 'desc' }],
    },
    analyzer: { analyze: async (m) => 'analysis result' },
    goalStack: {
      getActiveGoals: () => [],
      getAll: () => [],
      addGoal: async (d) => ({ description: d, steps: [{ type: 'think', action: 'do it' }] }),
      abandonGoal: () => {},
    },
    settings: {
      get: (k) => ({}),
      getAll: () => ({
        models: { anthropicApiKey: null, openaiBaseUrl: null, preferred: null },
        daemon: { enabled: true, cycleMinutes: 10 },
        idleMind: { enabled: true, idleMinutes: 5 },
        security: { allowSelfModify: false },
      }),
      set: () => {},
    },
    webFetcher: {
      npmSearch: async (q) => ({ packages: [{ name: q + '-lib', version: '1.0.0', description: 'desc' }] }),
      fetchText: async (url) => ({ ok: true, status: 200, body: 'page content here' }),
      ping: async (url) => ({ reachable: true, status: 200 }),
    },
    shellAgent: {
      plan: async (task) => ({ summary: `planned: ${task}` }),
      run: async (cmd) => ({ ok: true, stdout: 'output', stderr: '', exitCode: 0, blocked: false, duration: 10 }),
      openWorkspace: async (dir) => ({ description: `workspace: ${dir}` }),
    },
    mcpClient: {
      addServer: async (s) => ({ status: 'ready', toolCount: 5 }),
      removeServer: async (n) => true,
      reconnect: async (n) => ({ status: 'ready', toolCount: 3 }),
      startServer: async () => 9000,
      findRelevantTools: (q) => [],
      _allTools: () => [],
      getStatus: () => ({ serverCount: 1, connectedCount: 1, totalTools: 5, metaTools: ['list'], recipes: 2, skillCandidates: 1, serving: null, servers: [{ name: 'test', url: 'http://x', toolCount: 5, transport: 'sse', status: 'ready', error: null }] }),
    },

    ...overrides,
  };
}

function makeHandler(overrides = {}) {
  const deps = makeDeps(overrides);
  const ch = new CommandHandlers(deps);
  // skillManager is late-bound (not a constructor dep)
  if (!overrides._sm_none) {
    ch.skillManager = overrides._sm || {
      listSkills: () => [{ name: 'test-skill', description: 'A test skill' }],
      executeSkill: async () => ({ output: 'skill ran' }),
    };
  }
  return { ch, ...deps };
}

// ── executeCode ───────────────────────────────────────────────

describe('CommandHandlers — executeCode', () => {
  test('executes code block and returns output', async () => {
    const { ch } = makeHandler();
    const result = await ch.executeCode('run this:\n```js\nconsole.log(1)\n```');
    assert(result.includes('ok'), 'should contain output');
  });

  test('returns no_code_block when no code fence found', async () => {
    const { ch } = makeHandler();
    const result = await ch.executeCode('no fences here');
    assertEqual(result, 'agent.no_code_block');
  });

  test('appends error when sandbox returns error', async () => {
    const { ch } = makeHandler({ sandbox: { execute: async () => ({ output: '', error: 'ReferenceError' }) } });
    const result = await ch.executeCode('```js\nbad code\n```');
    assert(result.includes('ReferenceError'), 'should show error');
  });
});

// ── executeFile ───────────────────────────────────────────────

describe('CommandHandlers — executeFile', () => {
  test('executes file and returns output', async () => {
    const { ch } = makeHandler();
    const result = await ch.executeFile('run script.js');
    assert(result.includes('file output'), 'should show file output');
  });

  test('returns no_file when no filename in message', async () => {
    const { ch } = makeHandler();
    const result = await ch.executeFile('run nothing');
    assertEqual(result, 'agent.no_file');
  });

  test('returns file_not_found when fp returns null', async () => {
    const { ch } = makeHandler({ fileProcessor: { ...makeDeps().fileProcessor, getFileInfo: () => null } });
    const result = await ch.executeFile('run missing.js');
    assert(result.includes('agent.file_not_found'), 'should report not found');
  });

  test('returns cannot_execute when file is not executable', async () => {
    const fp = { ...makeDeps().fileProcessor, getFileInfo: () => ({ name: 'f', extension: '.xyz', language: 'Unknown', canExecute: false }), getRuntimes: () => ({ node: true }) };
    const { ch } = makeHandler({ fileProcessor: fp });
    const result = await ch.executeFile('run data.xyz');
    assert(result.includes('agent.cannot_execute'), 'should report cannot execute');
  });
});

// ── analyzeCode ───────────────────────────────────────────────

describe('CommandHandlers — analyzeCode', () => {
  test('delegates to analyzer and returns result', async () => {
    const { ch } = makeHandler();
    const result = await ch.analyzeCode('analyze this function');
    assertEqual(result, 'analysis result');
  });
});

// ── peer ──────────────────────────────────────────────────────

describe('CommandHandlers — peer', () => {
  test('scan with no peers returns none_found', async () => {
    const { ch } = makeHandler();
    const result = await ch.peer('peer scan');
    assertEqual(result, 'peer.none_found');
  });

  test('scan with peers lists them', async () => {
    const net = { ...makeDeps().network, scanLocalPeers: async () => [{ id: 'p1', version: '7.0', protocol: '1', skills: ['calc'], capabilities: ['code'] }] };
    const { ch } = makeHandler({ network: net });
    const result = await ch.peer('discover peers');
    assert(result.includes('p1'), 'should list peer id');
    assert(result.includes('calc'), 'should list skills');
  });

  test('trust command trusts a peer', async () => {
    const map = new Map([['p1', { id: 'p1' }]]);
    const net = { ...makeDeps().network, peers: map, trustPeer: () => true };
    const { ch } = makeHandler({ network: net });
    const result = await ch.peer('peer trust p1');
    assert(result.includes('trusted'), 'should confirm trust');
  });

  test('trust unknown peer returns error', async () => {
    const { ch } = makeHandler();
    const result = await ch.peer('peer trust unknown-xyz');
    assert(result.includes('not found'), 'should report not found');
  });

  test('import skill from peer', async () => {
    const { ch } = makeHandler();
    const result = await ch.peer('import calc from p1');
    assert(result.includes('calc'), 'should confirm import');
  });

  test('compare module with peer', async () => {
    const { ch } = makeHandler();
    const result = await ch.peer('compare Agent.js with p1');
    assert(result.includes('equal'), 'should show verdict');
  });

  test('peer skills from peer', async () => {
    const map = new Map([['p1', { id: 'p1', skills: ['calc', 'grep'] }]]);
    const net = { ...makeDeps().network, peers: map };
    const { ch } = makeHandler({ network: net });
    const result = await ch.peer('skills from p1');
    assert(result.includes('calc'), 'should list skills');
  });

  test('default shows network stats when peers exist', async () => {
    const net = { ...makeDeps().network, getPeerStatus: () => [{ id: 'p1', host: 'localhost', port: 3000, protocol: '1', trusted: true, skills: [], health: { isHealthy: true, avgLatency: 5, score: 100 } }], getNetworkStats: () => ({ protocol: '1', listening: 3000, totalPeers: 1, healthyPeers: 1, trustedPeers: 1 }) };
    const { ch } = makeHandler({ network: net });
    const result = await ch.peer('peer status');
    assert(result.includes('p1'), 'should show peer');
  });

  test('default with no peers shows none_hint', async () => {
    const { ch } = makeHandler();
    const result = await ch.peer('peer');
    assertEqual(result, 'peer.none_hint');
  });
});

// ── daemonControl ─────────────────────────────────────────────

describe('CommandHandlers — daemonControl', () => {
  test('stop command stops daemon', async () => {
    let stopped = false;
    const { ch } = makeHandler({ daemon: { stop: () => { stopped = true; }, start() {}, getStatus: () => ({ running: false, cycleCount: 0, knownGaps: [] }) } });
    const result = await ch.daemonControl('stop daemon');
    assert(stopped, 'should have called stop');
    assertEqual(result, 'daemon.stopped');
  });

  test('start command starts daemon', async () => {
    let started = false;
    const { ch } = makeHandler({ daemon: { start: () => { started = true; }, stop() {}, getStatus: () => ({ running: true, cycleCount: 0, knownGaps: [] }) } });
    const result = await ch.daemonControl('start daemon');
    assert(started, 'should have called start');
    assertEqual(result, 'daemon.started');
  });

  test('default returns status string', async () => {
    const { ch } = makeHandler();
    const result = await ch.daemonControl('daemon status');
    assert(typeof result === 'string', 'should return string');
    assert(result.includes('Daemon'), 'should mention Daemon');
  });
});

// ── journal ───────────────────────────────────────────────────

describe('CommandHandlers — journal', () => {
  test('returns journal entries', async () => {
    const { ch } = makeHandler();
    const result = await ch.journal();
    assert(result.includes('Journal'), 'should mention Journal');
    assert(result.includes('think'), 'should include activity');
  });

  test('returns empty message when no entries', async () => {
    const { ch } = makeHandler({ idleMind: { ...makeDeps().idleMind, readJournal: () => [] } });
    const result = await ch.journal();
    assertEqual(result, 'journal.empty');
  });
});

// ── plans ─────────────────────────────────────────────────────

describe('CommandHandlers — plans', () => {
  test('returns plans list', async () => {
    const { ch } = makeHandler();
    const result = await ch.plans();
    assert(result.includes('Plan A'), 'should include plan title');
  });

  test('returns empty message when no plans', async () => {
    const { ch } = makeHandler({ idleMind: { ...makeDeps().idleMind, getPlans: () => [] } });
    const result = await ch.plans();
    assertEqual(result, 'plans.empty');
  });
});

// ── goals ─────────────────────────────────────────────────────

describe('CommandHandlers — goals', () => {
  test('returns unavailable when no goalStack', async () => {
    const { ch } = makeHandler({ goalStack: null });
    const result = await ch.goals('show goals');
    assertEqual(result, 'goals.unavailable');
  });

  test('shows empty when no goals', async () => {
    const { ch } = makeHandler();
    const result = await ch.goals('show goals');
    assertEqual(result, 'goals.empty');
  });

  test('shows active goals', async () => {
    const gs = { ...makeDeps().goalStack, getAll: () => [{ id: 'g1', description: 'Fix bug', status: 'active', priority: 'high', steps: [{ type: 'think', action: 'analyze' }], currentStep: 0 }], getActiveGoals: () => [] };
    const { ch } = makeHandler({ goalStack: gs });
    const result = await ch.goals('show goals');
    assert(result.includes('Fix bug'), 'should show goal description');
  });

  test('cancel all goals', async () => {
    let abandoned = [];
    const gs = { ...makeDeps().goalStack, getActiveGoals: () => [{ id: 'g1', description: 'Fix' }], abandonGoal: (id) => abandoned.push(id) };
    const { ch } = makeHandler({ goalStack: gs });
    const result = await ch.goals('cancel all goals');
    assert(abandoned.includes('g1'), 'should abandon goal');
    assert(result.includes('1'), 'should report count');
  });

  test('cancel all goals when none active', async () => {
    const { ch } = makeHandler();
    const result = await ch.goals('cancel all goals');
    assert(result.includes('Keine'), 'should report none');
  });

  test('cancel one goal by index', async () => {
    let abandoned = null;
    const gs = { ...makeDeps().goalStack, getActiveGoals: () => [{ id: 'g1', description: 'Task 1' }], abandonGoal: (id) => { abandoned = id; } };
    const { ch } = makeHandler({ goalStack: gs });
    const result = await ch.goals('cancel goal 1');
    assertEqual(abandoned, 'g1');
    assert(result.includes('Task 1'), 'should show cancelled goal');
  });

  test('cancel goal out of range', async () => {
    const { ch } = makeHandler({ goalStack: { ...makeDeps().goalStack, getActiveGoals: () => [{ id: 'g1', description: 'x' }] } });
    const result = await ch.goals('cancel goal 9');
    assert(result.includes('nicht gefunden'), 'should report not found');
  });
});

// ── handleSettings ────────────────────────────────────────────

describe('CommandHandlers — handleSettings', () => {
  test('returns unavailable without settings', async () => {
    const { ch } = makeHandler({ settings: null });
    const result = ch.handleSettings('show settings');
    assertEqual(result, 'settings.unavailable');
  });

  test('shows settings', async () => {
    const { ch } = makeHandler();
    const result = ch.handleSettings('settings');
    assert(result.includes('Genesis'), 'should show settings');
  });

  test('saves API key', async () => {
    let saved = null;
    const { ch } = makeHandler({ settings: { ...makeDeps().settings, set: (k, v) => { saved = { k, v }; } } });
    const result = ch.handleSettings('anthropic key: sk-ant-test123456');
    assert(saved !== null, 'should save key');
    assert(saved.k.includes('anthropicApiKey'), 'should use correct key');
  });
});

// ── webLookup ─────────────────────────────────────────────────

describe('CommandHandlers — webLookup', () => {
  test('returns unavailable without web', async () => {
    const { ch } = makeHandler({ webFetcher: null });
    const result = await ch.webLookup('search npm react');
    assertEqual(result, 'web.unavailable');
  });

  test('npm search returns packages', async () => {
    const { ch } = makeHandler();
    const result = await ch.webLookup('npm search react');
    assert(result.includes('react-lib'), 'should show package');
  });

  test('url fetch returns content', async () => {
    const { ch } = makeHandler();
    const result = await ch.webLookup('fetch https://example.com/page');
    assert(result.includes('page content'), 'should show content');
  });

  test('ping check shows reachable', async () => {
    const { ch } = makeHandler();
    const result = await ch.webLookup('ping https://example.com');
    assert(typeof result === 'string', 'should return string');
  });

  test('returns hint without actionable message', async () => {
    const { ch } = makeHandler();
    const result = await ch.webLookup('web');
    assertEqual(result, 'web.hint');
  });
});

// ── shellTask ─────────────────────────────────────────────────

describe('CommandHandlers — shellTask', () => {
  test('returns unavailable without shell', async () => {
    const { ch } = makeHandler({ shellAgent: null });
    const result = await ch.shellTask('setup project');
    assertEqual(result, 'agent.shell_unavailable');
  });

  test('plans and returns summary', async () => {
    const { ch } = makeHandler();
    const result = await ch.shellTask('setup a new nodejs project');
    assert(result.includes('planned'), 'should return plan summary');
  });
});

// ── shellRun ──────────────────────────────────────────────────

describe('CommandHandlers — shellRun', () => {
  test('returns unavailable without shell', async () => {
    const { ch } = makeHandler({ shellAgent: null });
    const result = await ch.shellRun('ls -la');
    assertEqual(result, 'agent.shell_unavailable');
  });

  test('runs command and returns output', async () => {
    const { ch } = makeHandler();
    const result = await ch.shellRun('ls -la');
    assert(result.includes('output'), 'should include stdout');
  });

  test('returns no_command for empty message', async () => {
    const { ch } = makeHandler();
    const result = await ch.shellRun('  ');
    assertEqual(result, 'agent.no_command');
  });

  test('handles blocked command', async () => {
    const sh = { ...makeDeps().shellAgent, run: async () => ({ ok: false, blocked: true, stdout: '', stderr: 'dangerous', exitCode: 1, duration: 0 }) };
    const { ch } = makeHandler({ shellAgent: sh });
    const result = await ch.shellRun('rm -rf /');
    assert(result.includes('agent.blocked_command'), 'should report blocked');
  });

  test('handles failed command with stderr', async () => {
    const sh = { ...makeDeps().shellAgent, run: async () => ({ ok: false, blocked: false, stdout: '', stderr: 'command not found', exitCode: 127, duration: 5 }) };
    const { ch } = makeHandler({ shellAgent: sh });
    const result = await ch.shellRun('badcmd');
    assert(result.includes('127'), 'should show exit code');
  });

  test('emits shell:outcome on bus', async () => {
    const { ch, bus } = makeHandler();
    await ch.shellRun('echo hello');
    const outcome = bus.emitted.find(e => e.ev === 'shell:outcome');
    assert(outcome, 'should emit shell:outcome');
    assert(outcome.d.success, 'should mark success');
  });
});

// ── projectScan ───────────────────────────────────────────────

describe('CommandHandlers — projectScan', () => {
  test('returns unavailable without shell', async () => {
    const { ch } = makeHandler({ shellAgent: null });
    const result = await ch.projectScan('scan project');
    assertEqual(result, 'agent.shell_unavailable');
  });

  test('scans and returns description', async () => {
    const { ch } = makeHandler();
    const result = await ch.projectScan('scan project');
    assert(result.includes('workspace'), 'should return workspace description');
  });
});

// ── mcpControl ────────────────────────────────────────────────

describe('CommandHandlers — mcpControl', () => {
  test('returns unavailable without mcp', async () => {
    const { ch } = makeHandler({ mcpClient: null });
    const result = await ch.mcpControl('mcp status');
    assertEqual(result, 'mcp.unavailable');
  });

  test('shows status by default', async () => {
    const { ch } = makeHandler();
    const result = await ch.mcpControl('mcp status');
    assert(result.includes('test'), 'should show server name');
  });

  test('no servers shows hint', async () => {
    const mcp0 = { ...makeDeps().mcpClient, getStatus: () => ({ serverCount: 0, connectedCount: 0, totalTools: 0, metaTools: [], recipes: 0, skillCandidates: 0, serving: null, servers: [] }) };
    const { ch } = makeHandler({ mcpClient: mcp0 });
    const result = await ch.mcpControl('mcp');
    assert(result.includes('mcp.no_servers'), 'should show no servers');
  });

  test('connect adds server', async () => {
    const { ch } = makeHandler();
    const result = await ch.mcpControl('mcp connect mygithub https://mcp.github.com/sse');
    assert(result.includes('mygithub'), 'should confirm server name');
  });

  test('disconnect removes server', async () => {
    const { ch } = makeHandler();
    const result = await ch.mcpControl('mcp disconnect test');
    assert(typeof result === 'string', 'should return string');
  });

  test('serve starts server', async () => {
    const { ch } = makeHandler();
    const result = await ch.mcpControl('mcp serve');
    assert(result.includes('9000') || result.includes('mcp.server_started'), 'should show port');
  });
});

// ── runSkill ──────────────────────────────────────────────────

describe('CommandHandlers — runSkill', () => {
  test('returns unavailable without skillManager', async () => {
    const { ch } = makeHandler({ _sm_none: true });
    const result = await ch.runSkill('run test-skill');
    assert(result.includes('No SkillManager'), 'should report unavailable');
  });

  test('lists skills when no name given', async () => {
    const { ch } = makeHandler();
    const result = await ch.runSkill('skills');
    assert(result.includes('test-skill'), 'should list skills');
  });

  test('executes named skill', async () => {
    const { ch } = makeHandler();
    const result = await ch.runSkill('use test-skill');
    assert(result.includes('test-skill'), 'should confirm skill ran');
  });

  test('handles skill error', async () => {
    const sm = { listSkills: () => [{ name: 'test-skill', description: 'A' }], executeSkill: async () => ({ error: 'skill failed' }) };
    const { ch } = makeHandler({ _sm: sm });
    const result = await ch.runSkill('run test-skill');
    assert(result.includes('error'), 'should report error');
  });
});

// ── trustControl ──────────────────────────────────────────────

describe('CommandHandlers — trustControl', () => {
  test('returns unavailable when no trustSystem', async () => {
    const { ch } = makeHandler();
    // bus._container.resolve returns null by default
    const result = await ch.trustControl('trust status');
    assert(result.includes('not available'), 'should report unavailable');
  });

  test('shows trust level table when no target parsed', async () => {
    const trust = { getLevel: () => 1, setLevel: () => {}, checkApproval: () => true };
    const { ch, bus } = makeHandler();
    bus._container = { resolve: () => trust };
    const result = await ch.trustControl('trust status');
    assert(result.includes('Trust Level'), 'should show table');
    assert(result.includes('ASSISTED'), 'should show level name');
  });

  test('sets level by name', async () => {
    let set = null;
    const trust = { getLevel: () => 1, setLevel: (l) => { set = l; }, checkApproval: () => true };
    const { ch, bus } = makeHandler();
    bus._container = { resolve: () => trust };
    await ch.trustControl('trust autonomous');
    assertEqual(set, 2);
  });

  test('increments level with increase keyword', async () => {
    let set = null;
    const trust = { getLevel: () => 1, setLevel: (l) => { set = l; }, checkApproval: () => true };
    const { ch, bus } = makeHandler();
    bus._container = { resolve: () => trust };
    await ch.trustControl('trust more');
    assertEqual(set, 2);
  });
});

// ── openPath ─────────────────────────────────────────────────

describe('CommandHandlers — openPath', () => {
  test('returns unavailable without shell', async () => {
    const { ch } = makeHandler({ shellAgent: null });
    const result = await ch.openPath('open /tmp');
    assertEqual(result, 'agent.shell_unavailable');
  });

  test('opens unix path', async () => {
    const { ch } = makeHandler();
    const result = await ch.openPath('open /tmp/test');
    assert(result.includes('/tmp/test'), 'should confirm path');
  });

  test('resolves desktop alias', async () => {
    const { ch } = makeHandler();
    const result = await ch.openPath('open Desktop');
    assert(typeof result === 'string', 'should return string');
  });

  test('returns prompt when no path found', async () => {
    const { ch } = makeHandler();
    const result = await ch.openPath('was soll geöffnet werden');
    assert(result.includes('Welchen'), 'should ask for path');
  });
});

if (require.main === module) run();
