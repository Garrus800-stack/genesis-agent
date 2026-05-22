// ============================================================
// GENESIS — v795-livefix-pass.contract.test.js
//
// Contract tests for the v7.9.5 live-fix pass. Each block pins
// behavior the v7.9.4 live-test surfaced as a bug or UX gap:
//   - A: AgentCore.undoAvailability() + gating
//   - B: CommandHandlers.undo() gating + ToolRegistry preflight
//   - C: Shutdown session-summary skip + timeout
//   - D: AutonomousDaemon persistence (suggestions + health issues)
//   - E: AutonomousDaemon dedup fingerprint
//   - F: ArchReflect per-phase timing
//   - G: Container "optional skipped" surfaces names
//   - H: VectorMemory logs even when 0
//   - I: FileProcessor missing-runtimes log
//   - J: LessonsAutoCapture diagnostic counters
//   - K: PeerNetwork multicast token gating
//   - L: Settings: new live-fix keys present with expected shape
// ============================================================

'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');
const ROOT = path.resolve(__dirname, '../..');
const { describe, test, assert, assertEqual, run } = require('../harness');

describe('v7.9.5 livefix-pass', () => {

// ── A: AgentCore.undoAvailability() ───────────────────────────

test('A1: undoAvailability returns git-disabled when setting is off', () => {
  const { AgentCore } = require(path.join(ROOT, 'src/agent/AgentCore'));
  // Minimal fake — no real boot needed.
  const ac = Object.create(AgentCore.prototype);
  ac.rootDir = os.tmpdir();
  ac.container = {
    tryResolve: (k) => k === 'settings'
      ? { get: () => false }
      : null,
  };
  const r = ac.undoAvailability();
  assertEqual(r.available, false);
  assertEqual(r.reason, 'git-disabled');
});

test('A2: undoAvailability returns no-repo when setting is on but .git missing', () => {
  const { AgentCore } = require(path.join(ROOT, 'src/agent/AgentCore'));
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'genesis-livefix-'));
  try {
    const ac = Object.create(AgentCore.prototype);
    ac.rootDir = tmpDir;
    ac.container = {
      tryResolve: (k) => k === 'settings'
        ? { get: () => true }
        : null,
    };
    const r = ac.undoAvailability();
    assertEqual(r.available, false);
    assertEqual(r.reason, 'no-repo');
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  }
});

test('A3: undoAvailability returns available=true when both met', () => {
  const { AgentCore } = require(path.join(ROOT, 'src/agent/AgentCore'));
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'genesis-livefix-'));
  fs.mkdirSync(path.join(tmpDir, '.git'));
  try {
    const ac = Object.create(AgentCore.prototype);
    ac.rootDir = tmpDir;
    ac.container = {
      tryResolve: (k) => k === 'settings'
        ? { get: () => true }
        : null,
    };
    const r = ac.undoAvailability();
    assertEqual(r.available, true);
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  }
});

test('A4: undo() returns structured failure with reason field when not available', async () => {
  const { AgentCore } = require(path.join(ROOT, 'src/agent/AgentCore'));
  const ac = Object.create(AgentCore.prototype);
  ac.rootDir = os.tmpdir();
  ac.container = {
    tryResolve: (k) => k === 'settings'
      ? { get: () => false }
      : null,
  };
  const r = await ac.undo();
  assertEqual(r.ok, false);
  assertEqual(r.available, false);
  assertEqual(r.reason, 'git-disabled');
  assert(typeof r.error === 'string' && r.error.length > 0, 'error message provided');
});

// ── B: CommandHandlers.undo gating + ToolRegistry preflight ───

test('B1: CommandHandlers.undo() returns friendly message when gitAutoCommit off', async () => {
  const { CommandHandlers } = require(path.join(ROOT, 'src/agent/hexagonal/CommandHandlers'));
  const ch = new CommandHandlers({
    bus: null, lang: { t: (k) => k }, sandbox: null,
    fileProcessor: { rootDir: os.tmpdir() }, network: null, daemon: null,
    idleMind: null, analyzer: null, goalStack: null,
    settings: { get: () => false }, webFetcher: null, shellAgent: null,
    mcpClient: null, coreMemories: null, genesisDir: null,
  });
  const r = await ch.undo();
  assert(String(r).includes('chat.undo_disabled'), 'returns i18n key for disabled');
});

test('B2: ToolRegistry git-log skips raw error when no .git', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'genesis-livefix-'));
  try {
    const { ToolRegistry } = require(path.join(ROOT, 'src/agent/intelligence/ToolRegistry'));
    const tr = new ToolRegistry();
    // Register system tools against tmpDir (no .git inside).
    tr.registerSystemTools({ rootDir: tmpDir, sandbox: null });
    const result = await tr.execute('git-log', { count: 3 });
    // Pre-fix surfaced raw `fatal: not a git repository`; now should be
    // a friendly "(no git repository in this installation)" string.
    assert(typeof result.commits === 'string', 'commits returned as string');
    assert(!/fatal: not a git repository/i.test(result.commits), 'no raw git error surfaced');
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  }
});

// ── C: Shutdown LLM-call protection ───────────────────────────

test('C1: Settings tree contains shutdown.sessionSummaryMinMs + TimeoutMs', () => {
  const { Settings } = require(path.join(ROOT, 'src/agent/foundation/Settings'));
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'genesis-livefix-set-'));
  try {
    const s = new Settings(tmpDir);
    assertEqual(typeof s.get('shutdown.sessionSummaryMinMs'), 'number');
    assertEqual(typeof s.get('shutdown.sessionSummaryTimeoutMs'), 'number');
    // Sanity range checks
    assert(s.get('shutdown.sessionSummaryTimeoutMs') >= 500, 'timeout floor reasonable');
    assert(s.get('shutdown.sessionSummaryTimeoutMs') <= 120000, 'timeout ceiling reasonable');
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  }
});

// ── D: AutonomousDaemon persistence ───────────────────────────

test('D1: _persistSuggestions writes jsonl file', () => {
  const { AutonomousDaemon } = require(path.join(ROOT, 'src/agent/autonomy/AutonomousDaemon'));
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'genesis-daemon-'));
  try {
    const d = Object.create(AutonomousDaemon.prototype);
    d._storage = { getRootDir: () => tmpDir };
    d.selfModel = { rootDir: tmpDir };
    d.cycleCount = 5;
    d._log = () => {};
    d._trimJsonlFile = AutonomousDaemon.prototype._trimJsonlFile;
    d._persistSuggestions = AutonomousDaemon.prototype._persistSuggestions;
    d._persistSuggestions([{ type: 'performance', detail: 'X' }]);
    const file = path.join(tmpDir, '.genesis', 'daemon-suggestions.jsonl');
    assert(fs.existsSync(file), 'file created');
    const content = fs.readFileSync(file, 'utf-8');
    assert(content.includes('"cycle":5'), 'cycle persisted');
    assert(content.includes('performance'), 'suggestion content persisted');
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  }
});

test('D2: _persistHealthIssues deduplicates same fingerprint', () => {
  const { AutonomousDaemon } = require(path.join(ROOT, 'src/agent/autonomy/AutonomousDaemon'));
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'genesis-daemon-'));
  try {
    const d = Object.create(AutonomousDaemon.prototype);
    d._storage = { getRootDir: () => tmpDir };
    d.selfModel = { rootDir: tmpDir };
    d.cycleCount = 1;
    d._log = () => {};
    d._trimJsonlFile = AutonomousDaemon.prototype._trimJsonlFile;
    d._persistHealthIssues = AutonomousDaemon.prototype._persistHealthIssues;
    const issues = [{ type: 'syntax', file: 'x.js', severity: 'warning' }];
    d._persistHealthIssues(issues);
    d._persistHealthIssues(issues);   // identical → should skip
    d._persistHealthIssues(issues);   // identical → should skip
    const file = path.join(tmpDir, '.genesis', 'daemon-health-issues.jsonl');
    const lines = fs.readFileSync(file, 'utf-8').split('\n').filter(Boolean);
    assertEqual(lines.length, 1, 'dedup keeps only one entry');
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  }
});

test('D3: _trimJsonlFile rolls oldest entries off the top', () => {
  const { AutonomousDaemon } = require(path.join(ROOT, 'src/agent/autonomy/AutonomousDaemon'));
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'genesis-daemon-trim-'));
  try {
    const file = path.join(tmpDir, 'x.jsonl');
    for (let i = 0; i < 150; i++) fs.appendFileSync(file, `{"i":${i}}\n`);
    const d = Object.create(AutonomousDaemon.prototype);
    d._trimJsonlFile = AutonomousDaemon.prototype._trimJsonlFile;
    d._trimJsonlFile(file, 100);
    const lines = fs.readFileSync(file, 'utf-8').split('\n').filter(Boolean);
    assertEqual(lines.length, 100, 'trimmed to ceiling');
    assert(lines[0].includes('"i":50'), 'oldest 50 dropped');
    assert(lines[99].includes('"i":149'), 'newest preserved');
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  }
});

// ── E: Slash-Commands registered ──────────────────────────────

test('E1: /daemon-suggestions registered in SLASH_COMMANDS', () => {
  const { SLASH_COMMANDS } = require(path.join(ROOT, 'src/agent/intelligence/slash-commands'));
  const cmd = SLASH_COMMANDS.find(c => c.name === 'daemon-suggestions');
  assert(cmd, 'daemon-suggestions in registry');
  assert(Array.isArray(cmd.aliases) && cmd.aliases.includes('suggestions'), 'has suggestions alias');
  assertEqual(cmd.sinceVersion, 'v7.9.5');
});

test('E2: /daemon-health-issues registered in SLASH_COMMANDS', () => {
  const { SLASH_COMMANDS } = require(path.join(ROOT, 'src/agent/intelligence/slash-commands'));
  const cmd = SLASH_COMMANDS.find(c => c.name === 'daemon-health-issues');
  assert(cmd, 'daemon-health-issues in registry');
  assert(Array.isArray(cmd.aliases) && cmd.aliases.includes('health-issues'), 'has health-issues alias');
});

test('E3: IntentPatterns matches /daemon-suggestions [N]', () => {
  const { INTENT_DEFINITIONS } = require(path.join(ROOT, 'src/agent/intelligence/IntentPatterns'));
  const def = INTENT_DEFINITIONS.find(d => d[0] === 'daemon-suggestions');
  assert(def, 'daemon-suggestions in INTENT_DEFINITIONS');
  const [_name, patterns] = def;
  assert(patterns[0].test('/daemon-suggestions'),           'bare command matches');
  assert(patterns[0].test('/suggestions'),                  'alias matches');
  assert(patterns[0].test('/daemon-suggestions 5'),         'with N matches');
  assert(!patterns[0].test('please give me suggestions'),   'free-text does not match');
});

// ── F: ContinuationLoop maxAttempts setting ───────────────────

test('F1: llm.continuation.maxAttempts default 4', () => {
  const { Settings } = require(path.join(ROOT, 'src/agent/foundation/Settings'));
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'genesis-livefix-cl-'));
  try {
    const s = new Settings(tmpDir);
    assertEqual(s.get('llm.continuation.maxAttempts'), 4);
    // Clamp range is enforced by _sanityClampOnLoad at load time. Verify
    // by writing directly into data and re-clamping.
    s.data.llm.continuation.maxAttempts = 999;
    s._sanityClampOnLoad();
    assertEqual(s.get('llm.continuation.maxAttempts'), 20, 'clamped to ceiling');
    s.data.llm.continuation.maxAttempts = 0;
    s._sanityClampOnLoad();
    assertEqual(s.get('llm.continuation.maxAttempts'), 1, 'clamped to floor');
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  }
});

// ── G: ArchReflect staleThreshold setting ─────────────────────

test('G1: cognitive.architectureReflection.staleThresholdMs default 900000 (15min)', () => {
  const { Settings } = require(path.join(ROOT, 'src/agent/foundation/Settings'));
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'genesis-livefix-ar-'));
  try {
    const s = new Settings(tmpDir);
    assertEqual(s.get('cognitive.architectureReflection.staleThresholdMs'), 900000);
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  }
});

// ── H: PeerNetwork token subtree ──────────────────────────────

test('H1: peer.discoveryToken subtree present, empty by default', () => {
  const { Settings } = require(path.join(ROOT, 'src/agent/foundation/Settings'));
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'genesis-livefix-pn-'));
  try {
    const s = new Settings(tmpDir);
    assertEqual(s.get('peer.discoveryToken'), '');
    s.set('peer.discoveryToken', 'shared-secret');
    assertEqual(s.get('peer.discoveryToken'), 'shared-secret');
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  }
});

// ── I: LessonsAutoCapture diagnostic counters ─────────────────

test('I1: LessonsAutoCapture exposes getDiagnostics with per-trigger counters', () => {
  const { LessonsAutoCapture } = require(path.join(ROOT, 'src/agent/cognitive/LessonsAutoCapture'));
  const fakeBus = { on: () => () => {} };
  const fakeStore = { _stats: { autoCaptures: 0 }, record: () => {} };
  const lac = new LessonsAutoCapture({ bus: fakeBus, store: fakeStore });
  const diag = lac.getDiagnostics();
  assert(typeof diag === 'object', 'diagnostics object');
  assert('online-learning:streak-detected' in diag, 'has streak counter');
  assert('shell:outcome' in diag, 'has shell counter');
  assert('dream:complete' in diag, 'has dream counter');
  assertEqual(diag['shell:outcome'].received, 0);
  assertEqual(diag['shell:outcome'].captured, 0);
});

});

run();
