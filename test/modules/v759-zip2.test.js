// ============================================================
// GENESIS — test/modules/v759-zip2.test.js
//
// Tests for v7.5.9 ZIP 2 (Phases 1, 7, 3, 2):
//   Phase 1 — Sandbox 3-Tier with trust + scope coupling
//   Phase 7 — open-path uses READ-tier (subsumed by Phase 1)
//   Phase 3 — Tool-failure Resolution Loop (sandbox-block hints)
//   Phase 2 — _maybeReadSourceSync extended for "fasse README zusammen"
// ============================================================

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const ROOT = path.resolve(__dirname, '..', '..');

let _passed = 0, _failed = 0;
const _failures = [];

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assertion failed');
}

function assertEqual(a, b, msg) {
  if (a !== b) throw new Error((msg || 'assertEqual failed') + `: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
}

function describe(name, fn) {
  console.log(`\n  📦 ${name}`);
  fn();
}

function test(name, fn) {
  try {
    const res = fn();
    if (res && typeof res.then === 'function') {
      res.then(
        () => { _passed++; console.log(`    ✅ ${name}`); },
        (err) => { _failed++; _failures.push({ name, err }); console.log(`    ❌ ${name}\n      ${err.message}`); }
      );
      return res;
    }
    _passed++;
    console.log(`    ✅ ${name}`);
  } catch (err) {
    _failed++;
    _failures.push({ name, err });
    console.log(`    ❌ ${name}\n      ${err.message}`);
  }
}

// ── Phase 1 — Sandbox 3-Tier ─────────────────────────────────

describe('v7.5.9 ZIP2 Phase 1 — Sandbox 3-Tier with trust', () => {

  const { checkRootDirSandbox } = require(path.join(ROOT, 'src/agent/core/shell/ShellSafety'));
  const home = os.homedir();
  const projectRoot = ROOT;
  const homeDesktop = path.join(home, 'Desktop', 'github');

  test('source-presence: trustLevel parameter accepted', () => {
    const src = fs.readFileSync(path.join(ROOT, 'src/agent/core/shell/ShellSafety.js'), 'utf8');
    assert(/trustLevel/.test(src), 'trustLevel must be referenced');
    assert(/_isCriticalSystemPath|_isSecretFile|_isUserHomeSafeArea/.test(src),
      'tier-classification helpers must exist');
  });

  test('behavior: rootDir paths always allowed', () => {
    const r = checkRootDirSandbox(`ls "${projectRoot}/src"`, projectRoot, { trustLevel: 0 });
    assertEqual(r.ok, true, 'rootDir path must pass even at trust 0');
  });

  test('behavior: trust 0 blocks user-home', () => {
    const r = checkRootDirSandbox(`ls "${homeDesktop}"`, projectRoot, { trustLevel: 0 });
    assertEqual(r.ok, false, 'trust 0 blocks user-home');
  });

  test('behavior: trust 1 allows READ in user-home (AUTONOMOUS in 3-level system)', () => {
    const r = checkRootDirSandbox(`ls "${homeDesktop}"`, projectRoot, { trustLevel: 1 });
    assertEqual(r.ok, true, 'trust 1 allows ls in user-home');
  });

  test('behavior: trust 1 ALLOWS WRITE in user-home (AUTONOMOUS — was ASSISTED-read-only pre-v7.9.7)', () => {
    const r = checkRootDirSandbox(`rm "${homeDesktop}/file"`, projectRoot, { trustLevel: 1 });
    assertEqual(r.ok, true, 'v7.9.7: trust 1 (AUTONOMOUS) allows rm in user-home');
  });

  test('behavior: trust 2 allows WRITE in user-home (FULL_AUTONOMY in 3-level system)', () => {
    const r = checkRootDirSandbox(`rm "${homeDesktop}/file"`, projectRoot, { trustLevel: 2 });
    assertEqual(r.ok, true, 'trust 2 allows rm in user-home');
  });

  test('behavior: trust 0 blocks WRITE in user-home (SUPERVISED)', () => {
    const r = checkRootDirSandbox(`rm "${homeDesktop}/file"`, projectRoot, { trustLevel: 0 });
    assertEqual(r.ok, false, 'trust 0 (SUPERVISED) blocks rm in user-home');
  });

  test('behavior: critical system paths blocked at ALL trust levels', () => {
    for (const trust of [0, 1, 2]) {
      const r = checkRootDirSandbox('cat /etc/passwd', projectRoot, { trustLevel: trust });
      assertEqual(r.ok, false, `trust ${trust} must still block /etc/passwd`);
      assert(/critical system path/.test(r.reason), 'must mention critical system path');
    }
  });

  test('behavior: secret files blocked at ALL trust levels', () => {
    for (const trust of [0, 1, 2]) {
      const r = checkRootDirSandbox(`cat "${home}/.aws/credentials"`, projectRoot, { trustLevel: trust });
      assertEqual(r.ok, false, `trust ${trust} must still block .aws/credentials`);
    }
  });

  test('behavior: .ssh blocked even at FULL_AUTONOMY', () => {
    const r = checkRootDirSandbox(`cat "${home}/.ssh/id_rsa"`, projectRoot, { trustLevel: 2 });
    assertEqual(r.ok, false, 'trust 2 (FULL_AUTONOMY) must still block ~/.ssh');
  });

  test('behavior: .env blocked even at FULL_AUTONOMY', () => {
    const r = checkRootDirSandbox(`cat "${home}/.env"`, projectRoot, { trustLevel: 2 });
    assertEqual(r.ok, false, 'trust 2 (FULL_AUTONOMY) must still block .env');
  });

  test('behavior: drive-root recursive scan blocked', () => {
    const r = checkRootDirSandbox('dir /s C:\\', projectRoot, { trustLevel: 2 });
    assertEqual(r.ok, false, 'recursive C:\\ scan must always be blocked');
  });

  // v7.5.9 ZIP2 hot-fix: regression tests for Win-specific bugs found
  // during user testing on the Win-Rechner.

  test('regression Win: ls is universally a read-verb (Git-Bash etc.)', () => {
    // 'ls' must classify as READ on win32 too — Git-Bash, MSYS2, WSL,
    // Cygwin all use POSIX commands.
    const r = checkRootDirSandbox(`ls "${homeDesktop}"`, projectRoot,
      { trustLevel: 1, platform: 'win32' });
    // We can't fully simulate Win os.homedir() but we CAN verify intent.
    // If trust=1 + scope=user-home + intent=read → allowed (or
    // user-home-not-match → outside scope, but NOT "forbids writes").
    if (!r.ok) {
      assert(!/forbids writes/.test(r.reason || ''),
        `ls must not be classified as write — got reason: ${r.reason}`);
    }
  });

  test('regression Win: cat /etc/passwd blocked on win32 too', () => {
    const r = checkRootDirSandbox('cat /etc/passwd', projectRoot,
      { trustLevel: 2, platform: 'win32' });
    assertEqual(r.ok, false, 'POSIX system path blocked even on win32');
    assert(/critical system path/.test(r.reason || ''),
      `expected critical-system-path reason, got: ${r.reason}`);
  });

  test('regression Win: cat C:\\Windows\\System32 blocked on linux too', () => {
    const r = checkRootDirSandbox('type C:\\Windows\\System32\\config',
      '/home/claude/project', { trustLevel: 2, platform: 'linux' });
    assertEqual(r.ok, false, 'Win system path blocked even on linux');
    assert(/critical system path/.test(r.reason || ''),
      `expected critical-system-path reason, got: ${r.reason}`);
  });

  test('regression Win: case-insensitive variant resolution returns real-case', () => {
    const { _resolveFileWithVariants } = require(path.join(ROOT, 'src/agent/foundation/SelfModelSourceRead'));
    // README.md exists at project root; user-input "readme" must resolve
    // to the real on-disk case "README.md", not to "readme.md" (which
    // would happen on a case-insensitive FS via existsSync fast-path).
    const resolved = _resolveFileWithVariants(path.join(ROOT, 'readme'), ROOT);
    assert(resolved, 'must resolve');
    assertEqual(path.basename(resolved), 'README.md',
      `expected README.md (real case), got ${path.basename(resolved)}`);
  });

  test('behavior: scope=project rejects user-home even at trust 2', () => {
    const r = checkRootDirSandbox(`ls "${homeDesktop}"`, projectRoot, { trustLevel: 2, readScope: 'project' });
    assertEqual(r.ok, false, 'scope=project locks down to rootDir');
  });

  test('source-presence: ShellAgent late-binds trustLevelSystem + settings', () => {
    const agentSrc = fs.readFileSync(path.join(ROOT, 'src/agent/capabilities/ShellAgent.js'), 'utf8');
    assert(/this\.trustLevelSystem\s*=\s*null/.test(agentSrc),
      'ShellAgent must declare trustLevelSystem field');
    assert(/this\.settings\s*=\s*null/.test(agentSrc),
      'ShellAgent must declare settings field');
    const manifestSrc = fs.readFileSync(path.join(ROOT, 'src/agent/manifest/phase3-capabilities.js'), 'utf8');
    assert(/prop:\s*'trustLevelSystem'[^}]*service:\s*'trustLevelSystem'/.test(manifestSrc),
      'manifest must wire trustLevelSystem to shellAgent');
    assert(/prop:\s*'settings'[^}]*service:\s*'settings'/.test(manifestSrc),
      'manifest must wire settings to shellAgent');
  });

  test('source-presence: sandbox-check passes trustLevel + settings', () => {
    const agentSrc = fs.readFileSync(path.join(ROOT, 'src/agent/capabilities/ShellAgent.js'), 'utf8');
    assert(/checkRootDirSandbox\(command,\s*this\.rootDir,\s*\{[^}]*trustLevel/.test(agentSrc),
      'ShellAgent.run must pass trustLevel');
    assert(/checkRootDirSandbox\(command,\s*this\.rootDir,\s*\{[^}]*settings:\s*this\.settings/.test(agentSrc),
      'ShellAgent.run must pass settings');
  });

});

// ── Phase 2 — _maybeReadSourceSync extended ─────────────────

describe('v7.5.9 ZIP2 Phase 2 — _maybeReadSourceSync file-summary patterns', () => {

  test('source-presence: file-summary regex with capture-group', () => {
    const src = fs.readFileSync(path.join(ROOT, 'src/agent/hexagonal/ChatOrchestratorSourceRead.js'), 'utf8');
    assert(/f\?ass\(\?:e\|t\)\?\|summ/.test(src),
      'fasse-Pattern (typo-tolerant) with summarize variants must be present');
    assert(/_resolveFileWithVariants/.test(src),
      'must use _resolveFileWithVariants for resolution');
    assert(/file-not-found/.test(src),
      'must emit file-not-found hint when nothing matches');
  });

  test('behavior: pattern matches "fasse die README zusammen"', () => {
    const patterns = [
      /(?:f?ass(?:e|t)?|summ(?:arize|ar(?:y|isiere))|lies|read|zeig(?:e)?(?:\s+mir)?|show)\s+(?:mir\s+)?(?:die\s+|den\s+|das\s+|the\s+)?(?:datei\s+)?([\w][\w\s.-]*?\.(?:md|txt|json|js|ts|yaml|yml|toml|html|css))(?:\s|\b|$)/i,
      /(?:f?ass(?:e|t)?|lies|summ\w*)\s+(?:mir\s+)?(?:die\s+|den\s+)?([a-z][a-z0-9_-]{2,40})\s+(?:zusammen|durch)/i,
    ];
    let match = null;
    for (const p of patterns) {
      const m = 'fasse die README zusammen'.toLowerCase().match(p);
      if (m) { match = m[1]; break; }
    }
    assertEqual(match, 'readme', 'must capture filename');
  });

  test('behavior: pattern matches "lies ONTOGENESIS.md"', () => {
    const p = /(?:f?ass(?:e|t)?|summ(?:arize|ar(?:y|isiere))|lies|read|zeig(?:e)?(?:\s+mir)?|show)\s+(?:mir\s+)?(?:die\s+|den\s+|das\s+|the\s+)?(?:datei\s+)?([\w][\w\s.-]*?\.(?:md|txt|json|js|ts|yaml|yml|toml|html|css))(?:\s|\b|$)/i;
    const m = 'lies ONTOGENESIS.md'.toLowerCase().match(p);
    assert(m && m[1] === 'ontogenesis.md', 'must capture ontogenesis.md');
  });

  test('behavior: pattern does NOT match "fasse das gestrige Meeting zusammen"', () => {
    const patterns = [
      /(?:f?ass(?:e|t)?|summ(?:arize|ar(?:y|isiere))|lies|read|zeig(?:e)?(?:\s+mir)?|show)\s+(?:mir\s+)?(?:die\s+|den\s+|das\s+|the\s+)?(?:datei\s+)?([\w][\w\s.-]*?\.(?:md|txt|json|js|ts|yaml|yml|toml|html|css))(?:\s|\b|$)/i,
      /(?:f?ass(?:e|t)?|lies|summ\w*)\s+(?:mir\s+)?(?:die\s+|den\s+)?([a-z][a-z0-9_-]{2,40})\s+(?:zusammen|durch)/i,
    ];
    let match = null;
    for (const p of patterns) {
      const m = 'fasse das gestrige Meeting zusammen'.toLowerCase().match(p);
      if (m) { match = m[1]; break; }
    }
    // 'das gestrige Meeting' has spaces, doesn't match strict patterns
    assertEqual(match, null, 'should NOT match free text without filename');
  });

  test('behavior: variant resolution finds README.md from "readme"', () => {
    const { _resolveFileWithVariants } = require(path.join(ROOT, 'src/agent/foundation/SelfModelSourceRead'));
    const resolved = _resolveFileWithVariants(path.join(ROOT, 'readme'), ROOT);
    assert(resolved && resolved.endsWith('README.md'), `expected README.md, got ${resolved}`);
  });

  test('behavior: variant resolution finds docs/ONTOGENESIS.md from "ontogenesis"', () => {
    const { _resolveFileWithVariants } = require(path.join(ROOT, 'src/agent/foundation/SelfModelSourceRead'));
    const resolved = _resolveFileWithVariants(path.join(ROOT, 'ontogenesis'), ROOT);
    assert(resolved && /ONTOGENESIS\.md$/.test(resolved), `expected ONTOGENESIS.md, got ${resolved}`);
  });

});

// ── Phase 3 — Tool-failure Resolution Loop ──────────────────

describe('v7.5.9 ZIP2 Phase 3 — Tool-failure structured hints', () => {

  test('source-presence: _enrichToolResult method exists', () => {
    // _enrichToolResult lives in ChatOrchestratorHelpers.js (prototype-
    // delegated) to keep ChatOrchestrator.js under the 700-LOC limit.
    const src = fs.readFileSync(path.join(ROOT, 'src/agent/hexagonal/ChatOrchestratorHelpers.js'), 'utf8');
    assert(/_enrichToolResult\s*\(/.test(src),
      '_enrichToolResult method must exist in helpers');
    assert(/sandboxBlock/.test(src),
      'must handle sandbox-block pattern');
    assert(/exists\s*===\s*false/.test(src),
      'must handle exists:false pattern');
    assert(/HINT:/.test(src),
      'must emit HINT: prefixed messages');
  });

  test('source-presence: tool-loop calls _enrichToolResult', () => {
    const src = fs.readFileSync(path.join(ROOT, 'src/agent/hexagonal/ChatOrchestrator.js'), 'utf8');
    assert(/this\._enrichToolResult\(call,\s*result\)/.test(src),
      'tool-loop must call _enrichToolResult on each result');
  });

  test('behavior: _enrichToolResult adds HINT for exists:false', () => {
    const { ChatOrchestrator } = require(path.join(ROOT, 'src/agent/hexagonal/ChatOrchestrator'));
    // Construct a bare-bones instance using a stub
    const stub = Object.create(ChatOrchestrator.prototype);
    const out = stub._enrichToolResult(
      { name: 'file-read', input: { path: 'readme' } },
      { exists: false, content: '', size: 0 }
    );
    assert(/HINT:/.test(out), 'must include HINT');
    assert(/file-list/.test(out), 'must suggest file-list as alternative');
  });

  test('behavior: _enrichToolResult adds HINT for sandbox-block', () => {
    const { ChatOrchestrator } = require(path.join(ROOT, 'src/agent/hexagonal/ChatOrchestrator'));
    const stub = Object.create(ChatOrchestrator.prototype);
    const out = stub._enrichToolResult(
      { name: 'shell', input: { command: 'ls /tmp' } },
      { ok: false, stderr: '[SHELL] Sandbox: path "/tmp" is outside rootDir', exitCode: -1, sandboxBlock: true }
    );
    assert(/HINT:/.test(out), 'must include HINT');
    assert(/trust|user-home/i.test(out), 'must mention trust/user-home alternative');
  });

  test('behavior: _enrichToolResult passes through clean results unchanged', () => {
    const { ChatOrchestrator } = require(path.join(ROOT, 'src/agent/hexagonal/ChatOrchestrator'));
    const stub = Object.create(ChatOrchestrator.prototype);
    const out = stub._enrichToolResult(
      { name: 'file-read', input: { path: 'README.md' } },
      { exists: true, content: '# Hello', size: 7 }
    );
    assert(!/HINT:/.test(out), 'no HINT for successful read');
    assert(/Result:/.test(out), 'must include the result');
  });

});

// ── Summary ─────────────────────────────────────────────────

setTimeout(() => {
  console.log(`\n    ${_passed} passed · ${_failed} failed · ${_passed + _failed} assertions · ${Date.now()}ms\n`);
  if (_failed > 0) {
    process.exit(1);
  }
}, 100);
