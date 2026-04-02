// ============================================================
// Test: v5.1.0 Audit Fixes (N-1 through N-5)
//
//   N-1: EffectorRegistry browser:open domain allowlist
//   N-2: Reflector.js atomic writes
//   N-3: 10 writeFileSync sites → atomicWriteFileSync
//   N-4: McpClient stale TODO removed
//   N-5: IntentRouter declarative INTENT_DEFINITIONS table
// ============================================================

let passed = 0, failed = 0;
const _testQueue = [];
function test(name, fn) { _testQueue.push({ name, fn }); }
function assert(c, m) { if (!c) throw new Error(m || 'Assertion failed'); }

const path = require('path');
const fs = require('fs');

const SRC = path.resolve(__dirname, '../../src/agent');

console.log('\n  📦 v5.1.0 Audit Fixes');

// ── N-1: EffectorRegistry Domain Allowlist ────────────────

test('N-1: SAFETY.EXTERNAL_ALLOWED_DOMAINS exists in Constants', () => {
  const { SAFETY } = require('../../src/agent/core/Constants');
  assert(SAFETY.EXTERNAL_ALLOWED_DOMAINS, 'EXTERNAL_ALLOWED_DOMAINS must exist');
  assert(SAFETY.EXTERNAL_ALLOWED_DOMAINS instanceof Set, 'must be a Set');
  assert(SAFETY.EXTERNAL_ALLOWED_DOMAINS.size >= 10, 'must have at least 10 domains');
});

test('N-1: allowlist contains known-safe domains', () => {
  const { SAFETY } = require('../../src/agent/core/Constants');
  const expected = ['github.com', 'npmjs.com', 'stackoverflow.com', 'developer.mozilla.org', 'en.wikipedia.org'];
  for (const domain of expected) {
    assert(SAFETY.EXTERNAL_ALLOWED_DOMAINS.has(domain), `must contain ${domain}`);
  }
});

test('N-1: allowlist mirrors kernel main.js domains (same count)', () => {
  const { SAFETY } = require('../../src/agent/core/Constants');
  const kernelDomains = [
    'github.com', 'raw.githubusercontent.com', 'gist.github.com',
    'npmjs.com', 'www.npmjs.com', 'registry.npmjs.org',
    'nodejs.org', 'electronjs.org', 'www.electronjs.org',
    'developer.mozilla.org', 'docs.anthropic.com', 'docs.python.org',
    'stackoverflow.com', 'www.stackoverflow.com',
    'en.wikipedia.org', 'pypi.org',
  ];
  for (const domain of kernelDomains) {
    assert(SAFETY.EXTERNAL_ALLOWED_DOMAINS.has(domain), `kernel domain "${domain}" missing from Constants`);
  }
  assert(SAFETY.EXTERNAL_ALLOWED_DOMAINS.size === kernelDomains.length,
    `size mismatch: Constants=${SAFETY.EXTERNAL_ALLOWED_DOMAINS.size} vs kernel=${kernelDomains.length}`);
});

test('N-1: EffectorRegistry imports SAFETY and checks EXTERNAL_ALLOWED_DOMAINS', () => {
  const source = fs.readFileSync(path.join(SRC, 'capabilities/EffectorRegistry.js'), 'utf-8');
  assert(source.includes("require('../core/Constants')"), 'must import Constants');
  assert(source.includes('SAFETY'), 'must destructure SAFETY');
  assert(source.includes('EXTERNAL_ALLOWED_DOMAINS'), 'must reference domain allowlist');
  assert(source.includes('not in allowlist'), 'must have rejection message');
});

// ── N-2 / N-3: Atomic Writes ──────────────────────────────

const ATOMIC_MIGRATED = [
  ['planning/Reflector.js', 'N-2'],
  ['capabilities/PluginRegistry.js', 'N-3'],
  ['capabilities/SkillManager.js', 'N-3'],
  ['capabilities/SnapshotManager.js', 'N-3'],
  ['capabilities/McpClient.js', 'N-3'],
  ['hexagonal/PeerNetwork.js', 'N-3'],
  ['core/Language.js', 'N-3'],
  ['autonomy/IdleMind.js', 'N-3'],
];

for (const [rel, id] of ATOMIC_MIGRATED) {
  test(`${id}: ${path.basename(rel)} imports atomicWriteFileSync`, () => {
    const source = fs.readFileSync(path.join(SRC, rel), 'utf-8');
    assert(source.includes('atomicWriteFileSync'), `${rel} must import atomicWriteFileSync`);
  });
}

test('N-2/N-3: no bare fs.writeFileSync in migrated files', () => {
  for (const [rel] of ATOMIC_MIGRATED) {
    const source = fs.readFileSync(path.join(SRC, rel), 'utf-8');
    const lines = source.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (line.startsWith('//') || line.startsWith('*')) continue;
      assert(!line.includes('fs.writeFileSync'),
        `${rel}:${i + 1} still has bare fs.writeFileSync: "${line.slice(0, 60)}"`);
    }
  }
});

test('N-3: accepted exceptions use correct patterns', () => {
  // EventStore: already uses manual tmp+rename
  const es = fs.readFileSync(path.join(SRC, 'foundation/EventStore.js'), 'utf-8');
  assert(es.includes('.tmp'), 'EventStore must use .tmp');
  assert(es.includes('renameSync'), 'EventStore must use renameSync');
  // Settings salt: write-once at boot
  const st = fs.readFileSync(path.join(SRC, 'foundation/Settings.js'), 'utf-8');
  assert(st.includes('_loadOrCreateSalt'), 'Settings must have salt function');
  // BootRecovery sentinel: ephemeral flag
  const br = fs.readFileSync(path.join(SRC, 'foundation/BootRecovery.js'), 'utf-8');
  assert(br.includes('_writeSentinel'), 'BootRecovery must have sentinel function');
});

test('N-3: atomicWriteFileSync is functional', () => {
  const { atomicWriteFileSync } = require('../../src/agent/core/utils');
  const tmpFile = path.join(__dirname, '..', '..', 'sandbox', '_test_atomic_v510.json');
  try {
    atomicWriteFileSync(tmpFile, JSON.stringify({ test: true }), 'utf-8');
    const content = JSON.parse(fs.readFileSync(tmpFile, 'utf-8'));
    assert(content.test === true, 'written content must be readable');
  } finally {
    try { fs.unlinkSync(tmpFile); } catch { /* cleanup */ }
  }
});

// ── N-4: McpClient Stale TODO ─────────────────────────────

test('N-4: no TODO comments in McpClient', () => {
  const source = fs.readFileSync(path.join(SRC, 'capabilities/McpClient.js'), 'utf-8');
  const lines = source.split('\n');
  for (let i = 0; i < lines.length; i++) {
    assert(!lines[i].includes('TODO'),
      `McpClient.js:${i + 1} still has TODO: "${lines[i].trim().slice(0, 60)}"`);
  }
});

test('N-4: McpClient uses McpCodeExec delegate for isolation', () => {
  const source = fs.readFileSync(path.join(SRC, 'capabilities/McpClient.js'), 'utf-8');
  assert(source.includes('McpCodeExec'), 'must reference McpCodeExec delegate');
  assert(source.includes('_codeExec'), 'must reference _codeExec instance');
  // v5.2.0: Worker isolation is now in McpCodeExec.js, not McpClient directly
  const delegateSource = fs.readFileSync(path.join(SRC, 'capabilities/McpCodeExec.js'), 'utf-8');
  assert(delegateSource.includes('McpWorker'), 'delegate must reference McpWorker');
  assert(delegateSource.includes('_isolated'), 'delegate must have _isolated method');
});

// ── N-5: IntentRouter Declarative Table ───────────────────

test('N-5: INTENT_DEFINITIONS const exists', () => {
  const source = fs.readFileSync(path.join(SRC, 'intelligence/IntentRouter.js'), 'utf-8');
  assert(source.includes('const INTENT_DEFINITIONS'), 'must have INTENT_DEFINITIONS');
});

test('N-5: _registerDefaults uses table iteration', () => {
  const source = fs.readFileSync(path.join(SRC, 'intelligence/IntentRouter.js'), 'utf-8');
  assert(source.includes('for (const [name, patterns, priority, keywords] of INTENT_DEFINITIONS)'),
    '_registerDefaults must iterate INTENT_DEFINITIONS');
});

test('N-5: _registerDefaults body is concise (≤5 lines)', () => {
  const source = fs.readFileSync(path.join(SRC, 'intelligence/IntentRouter.js'), 'utf-8');
  const match = source.match(/_registerDefaults\(\)\s*\{([\s\S]*?)\n  \}/);
  assert(match, 'must find _registerDefaults method');
  const bodyLines = match[1].trim().split('\n').filter(l => l.trim().length > 0);
  assert(bodyLines.length <= 5, `body must be <=5 lines, got ${bodyLines.length}`);
});

test('N-5: all 23 intents are registered', () => {
  const { IntentRouter } = require('../../src/agent/intelligence/IntentRouter');
  const router = new IntentRouter({});
  const expected = [
    'self-inspect', 'self-reflect', 'self-modify', 'self-repair',
    'self-repair-reset', 'create-skill', 'clone', 'analyze-code',
    'run-skill', 'execute-code', 'execute-file', 'peer', 'daemon', 'mcp',
    'journal', 'plans', 'goals', 'settings', 'web-lookup',
    'undo', 'shell-task', 'shell-run', 'project-scan', 'retry', 'greeting',
  ];
  const registered = router.routes.map(r => r.name);
  for (const intent of expected) {
    assert(registered.includes(intent), `missing intent "${intent}"`);
  }
  assert(registered.length === expected.length,
    `route count ${registered.length} !== expected ${expected.length}`);
});

test('N-5: routing still works after refactor', () => {
  const { IntentRouter } = require('../../src/agent/intelligence/IntentRouter');
  const router = new IntentRouter({});
  const cases = [
    ['was bist du?', 'self-inspect'],
    ['hallo!', 'greeting'],
    ['npm install', 'shell-task'],
    ['mcp server status', 'mcp'],
    ['klone dich', 'clone'],
  ];
  for (const [msg, expected] of cases) {
    const result = router.classify(msg);
    assert(result.type === expected,
      `"${msg}" => "${result.type}", expected "${expected}"`);
  }
});

// ── Cross-cutting ─────────────────────────────────────────

test('Constants.js exports all expected keys', () => {
  const c = require('../../src/agent/core/Constants');
  for (const key of ['TIMEOUTS', 'LIMITS', 'INTERVALS', 'PRIORITIES', 'RATE_LIMIT', 'SAFETY']) {
    assert(c[key], `Constants must export ${key}`);
  }
});

test('SAFETY.CODE_PATTERNS still intact (>=15 entries)', () => {
  const { SAFETY } = require('../../src/agent/core/Constants');
  assert(Array.isArray(SAFETY.CODE_PATTERNS), 'CODE_PATTERNS must be array');
  assert(SAFETY.CODE_PATTERNS.length >= 15, `got ${SAFETY.CODE_PATTERNS.length}`);
});

// ── SA-3: Swallowed Error Catches ─────────────────────────

test('SA-3: previously swallowed catches now have debug logging', () => {
  const files = [
    ['capabilities/McpTransport.js', 'JSON parse fallback'],
    ['capabilities/ShellAgent.js', 'readdirSync failed'],
    ['capabilities/ShellAgent.js', 'git status unavailable'],
    ['foundation/EmbeddingService.js', 'Embedding request failed'],
    ['intelligence/PromptBuilderSections.js', 'Session context unavailable'],
    ['intelligence/PromptBuilderSections.js', 'Learning context unavailable'],
    ['intelligence/PromptBuilderSections.js', 'Organism context unavailable'],
    ['intelligence/PromptBuilderSections.js', 'Safety context unavailable'],
    ['intelligence/PromptBuilderSections.js', 'Metacognitive context unavailable'],
    ['intelligence/PromptBuilderSections.js', 'Episodic memory fallback'],
    ['revolution/MultiFileRefactor.js', 'Analysis request failed'],
  ];
  for (const [rel, marker] of files) {
    const source = fs.readFileSync(path.join(SRC, rel), 'utf-8');
    assert(source.includes(marker),
      `${rel} must contain debug marker "${marker}"`);
  }
});

test('SA-3: StorageService read catches have graceful markers', () => {
  const source = fs.readFileSync(path.join(SRC, 'foundation/StorageService.js'), 'utf-8');
  const matches = source.match(/graceful.*missing.*corrupt/g) || [];
  assert(matches.length >= 2, `StorageService must have >=2 graceful markers, got ${matches.length}`);
});

test('SA-3: DreamEngine selfTheory catch has graceful marker', () => {
  const source = fs.readFileSync(path.join(SRC, 'consciousness/DreamEngine.js'), 'utf-8');
  assert(source.includes('graceful: dream works without self-theory'),
    'DreamEngine must have graceful marker');
});

test('SA-3: innerHTML usage is sanitized via _esc()', () => {
  const dashboard = fs.readFileSync(
    path.resolve(__dirname, '../../src/ui/dashboard.js'), 'utf-8'
  );
  assert(dashboard.includes('_esc('), 'dashboard must use _esc() sanitizer');
  assert(dashboard.includes('textContent'), '_esc must use textContent-based escaping');
});

// ── Runner ────────────────────────────────────────────────
(async () => {
  for (const t of _testQueue) {
    try {
      const r = t.fn(); if (r && r.then) await r;
      passed++; console.log(`    ✅ ${t.name}`);
    } catch (err) {
      failed++; console.log(`    ❌ ${t.name}: ${err.message}`);
    }
  }
  console.log(`\n    ${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
})();
