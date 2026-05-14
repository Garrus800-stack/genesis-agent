// ============================================================
// GENESIS — test/modules/v784-cleanup-integration.test.js (v7.8.4)
//
// cleanup-verifier contract integration: /cleanup-check slash
// command + AgentLoopSteps pre-deletion-audit auto-hook.
//
// Covers:
//   - /cleanup-check argument parsing (usage, path validation)
//   - report formatting (safe / blocking / informational)
//   - AgentLoopSteps._extractDeleteTarget heuristic (rm/del/Remove-Item)
//   - cleanup-check intent is registered + wired to handler
// ============================================================

'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

let passed = 0, failed = 0;
const failures = [];

function test(name, fn) {
  Promise.resolve().then(async () => {
    try {
      await fn();
      passed++;
      console.log(`    ✅ ${name}`);
    } catch (err) {
      failed++;
      failures.push({ name, error: err.message });
      console.log(`    ❌ ${name}: ${err.message}`);
    }
  });
}

function tmpRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'genesis-cleanup-int-'));
}

function writeFile(root, rel, content) {
  const p = path.join(root, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
}

// Bind the mixin to a host with the minimal shape it expects.
function makeHost(rootDir, lang = 'en') {
  const { commandHandlersCleanup } = require('../../src/agent/hexagonal/CommandHandlersCleanup');
  const host = {
    rootDir,
    bus: null,
    lang: { current: lang },
  };
  for (const [k, v] of Object.entries(commandHandlersCleanup)) {
    host[k] = v.bind(host);
  }
  return host;
}

// ── /cleanup-check parsing + formatting ──────────────────

test('cleanup-verifier contract: /cleanup-check without args prints usage (EN)', async () => {
  const host = makeHost(tmpRoot(), 'en');
  const out = await host.cleanupCheck('/cleanup-check');
  assert.match(out, /Usage:/);
  assert.match(out, /\/cleanup-check/);
});

test('cleanup-verifier contract: /cleanup-check without args prints usage (DE)', async () => {
  const host = makeHost(tmpRoot(), 'de');
  const out = await host.cleanupCheck('/cleanup-check');
  assert.match(out, /Verwendung:/);
});

test('cleanup-verifier contract: absolute paths are rejected', async () => {
  const host = makeHost(tmpRoot(), 'en');
  const abs = process.platform === 'win32' ? 'C:\\foo\\bar.js' : '/etc/passwd';
  const out = await host.cleanupCheck(`/cleanup-check ${abs}`);
  assert.match(out, /relative/i);
});

test('cleanup-verifier contract: paths with .. are rejected', async () => {
  const host = makeHost(tmpRoot(), 'en');
  const out = await host.cleanupCheck('/cleanup-check ../etc/foo');
  assert.match(out, /relative/i);
});

test('cleanup-verifier contract: safe-file report shows ✅', async () => {
  const root = tmpRoot();
  writeFile(root, 'src/lonely.js', 'module.exports = 1;\n');
  const host = makeHost(root, 'en');
  const out = await host.cleanupCheck('/cleanup-check src/lonely.js');
  assert.match(out, /Pre-deletion audit/);
  assert.match(out, /No findings/);
  assert.match(out, /✅/);
});

test('cleanup-verifier contract: blocking-finding report shows 🛑', async () => {
  const root = tmpRoot();
  writeFile(root, 'src/util.js', 'module.exports = { foo: 1 };\n');
  writeFile(root, 'src/main.js', "const util = require('./util');\n");
  const host = makeHost(root, 'en');
  const out = await host.cleanupCheck('/cleanup-check src/util.js');
  assert.match(out, /Blocking findings/i);
  assert.match(out, /🛑/);
  assert.match(out, /importers/);
});

test('cleanup-verifier contract: informational-only report shows ⚠', async () => {
  const root = tmpRoot();
  // Two files with same basename, no importer, no entry-point pattern
  writeFile(root, 'src/a/helper.js', '// version A\n');
  writeFile(root, 'src/b/helper.js', '// version B different\n');
  const host = makeHost(root, 'en');
  const out = await host.cleanupCheck('/cleanup-check src/a/helper.js');
  assert.match(out, /Findings present/);
  assert.match(out, /⚠/);
  assert.match(out, /sibling-name-matches/);
});

test('cleanup-verifier contract: quoted argument is stripped', async () => {
  const root = tmpRoot();
  writeFile(root, 'src/quoted.js', '// lone\n');
  const host = makeHost(root, 'en');
  const out = await host.cleanupCheck('/cleanup-check "src/quoted.js"');
  assert.match(out, /No findings/);
});

// ── AgentLoopSteps delete-target extraction ──────────────

test('cleanup-verifier contract: DeleteCommandHeuristic module exports extractDeleteTarget', () => {
  const mod = require('../../src/agent/revolution/DeleteCommandHeuristic');
  assert.strictEqual(typeof mod.extractDeleteTarget, 'function');
  assert.ok(Array.isArray(mod.DELETE_COMMAND_PATTERNS));
});

test('cleanup-verifier contract: delete patterns cover rm, unlink, Remove-Item, del, erase', () => {
  const src = fs.readFileSync(
    path.join(__dirname, '..', '..', 'src/agent/revolution/DeleteCommandHeuristic.js'),
    'utf-8'
  );
  const block = src.match(/DELETE_COMMAND_PATTERNS\s*=\s*\[([\s\S]+?)\];/);
  assert.ok(block, 'pattern array must exist');
  const text = block[1];
  assert.ok(text.includes('rm'),          'rm pattern must be present');
  assert.ok(text.includes('unlink'),      'unlink pattern must be present');
  assert.ok(text.includes('Remove-Item'), 'Remove-Item pattern must be present');
  assert.ok(text.includes('del'),         'del pattern must be present');
  assert.ok(text.includes('erase'),       'erase pattern must be present');
});

test('cleanup-verifier contract: extractDeleteTarget parses common forms and rejects globs', () => {
  const { extractDeleteTarget } = require('../../src/agent/revolution/DeleteCommandHeuristic');
  const root = '/tmp/project';
  // basic unix rm
  assert.strictEqual(extractDeleteTarget('rm src/foo.js', root), 'src/foo.js');
  assert.strictEqual(extractDeleteTarget('rm -f src/foo.js', root), 'src/foo.js');
  // unlink
  assert.strictEqual(extractDeleteTarget('unlink src/bar.js', root), 'src/bar.js');
  // Remove-Item (PowerShell)
  assert.strictEqual(extractDeleteTarget('Remove-Item src/baz.js', root), 'src/baz.js');
  // Glob rejected
  assert.strictEqual(extractDeleteTarget('rm src/*.js', root), null);
  assert.strictEqual(extractDeleteTarget('rm src/foo?.js', root), null);
  // Outside rootDir rejected
  assert.strictEqual(extractDeleteTarget('rm /etc/passwd', root), null);
  // No-match returns null
  assert.strictEqual(extractDeleteTarget('echo hello', root), null);
  // Empty inputs
  assert.strictEqual(extractDeleteTarget('', root), null);
  assert.strictEqual(extractDeleteTarget('rm src/foo.js', ''), null);
});

test('cleanup-verifier contract: _stepShell calls CleanupVerifier before approval', () => {
  const src = fs.readFileSync(
    path.join(__dirname, '..', '..', 'src/agent/revolution/AgentLoopSteps.js'),
    'utf-8'
  );
  // Hook uses the imported helper, fires before the shell-command approval.
  const idxHook = src.indexOf('extractDeleteTarget(command, loop.rootDir)');
  const idxApproval = src.indexOf("_requestApproval('shell-command'");
  assert.ok(idxHook > 0, 'hook must call extractDeleteTarget');
  assert.ok(idxApproval > 0, 'shell-command approval must exist');
  assert.ok(idxHook < idxApproval, 'hook must execute before approval prompt');
});

test('cleanup-verifier contract: cleanup-check intent is in SECURITY_REQUIRED_SLASH', () => {
  const { SECURITY_REQUIRED_SLASH } = require('../../src/agent/intelligence/IntentPatterns');
  assert.ok(
    SECURITY_REQUIRED_SLASH.has('cleanup-check'),
    'cleanup-check must be registered as slash-only'
  );
});

test('cleanup-verifier contract: cleanup-check intent has a slash pattern', () => {
  const { INTENT_DEFINITIONS } = require('../../src/agent/intelligence/IntentPatterns');
  const def = INTENT_DEFINITIONS.find((d) => d[0] === 'cleanup-check');
  assert.ok(def, 'cleanup-check INTENT_DEFINITIONS entry must exist');
  const patterns = def[1];
  assert.ok(Array.isArray(patterns) && patterns.length > 0, 'must have ≥1 pattern');
  // First pattern must match the slash form
  assert.ok(patterns[0].test('/cleanup-check src/foo.js'));
  // Fuzzy text without the slash must NOT match
  assert.ok(!patterns[0].test('please check cleanup of src/foo.js'));
});

// ── summary ───────────────────────────────────────────────

(async () => {
  await new Promise((r) => setTimeout(r, 300));
  if (failed > 0) {
    console.log(`\n  ${failed} failure(s):`);
    for (const f of failures) console.log(`    - ${f.name}: ${f.error}`);
    process.exit(1);
  }
  console.log(`    ${passed} passed`);
})();
