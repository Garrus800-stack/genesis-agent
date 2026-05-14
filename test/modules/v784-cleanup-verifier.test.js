// ============================================================
// GENESIS — test/modules/v784-cleanup-verifier.test.js (v7.8.4)
//
// cleanup-verifier contract: CleanupVerifier must:
//   - return safe=false when target has importers
//   - return safe=false when target matches an entry-point pattern
//   - return safe=true when target is a lone file
//   - find identical-content siblings (sha256 hash compare)
//   - find sibling-name-matches in other directories
//   - fail gracefully on non-existent or directory targets
//   - emit a telemetry event when bus is supplied
//   - reject empty paths
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

const { CleanupVerifier, ENTRYPOINT_NAMES } = require('../../src/agent/capabilities/CleanupVerifier');

// ── helpers ────────────────────────────────────────────────

function tmpRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'genesis-cleanup-'));
}

function writeFile(root, rel, content) {
  const p = path.join(root, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
  return p;
}

// ── tests ──────────────────────────────────────────────────

test('cleanup-verifier contract: lone file with no importers is safe', async () => {
  const root = tmpRoot();
  writeFile(root, 'src/lonely.js', 'module.exports = 42;\n');
  writeFile(root, 'src/unrelated.js', '// nothing references lonely\n');
  const v = new CleanupVerifier({ rootDir: root });
  const result = await v.verify('src/lonely.js');
  assert.strictEqual(result.safe, true);
  assert.strictEqual(result.findings.length, 0);
});

test('cleanup-verifier contract: file with require()-importer is unsafe', async () => {
  const root = tmpRoot();
  writeFile(root, 'src/util.js', 'module.exports = { foo: 1 };\n');
  writeFile(root, 'src/main.js', "const util = require('./util');\nconsole.log(util.foo);\n");
  const v = new CleanupVerifier({ rootDir: root });
  const result = await v.verify('src/util.js');
  assert.strictEqual(result.safe, false);
  const f = result.findings.find((x) => x.kind === 'importers');
  assert.ok(f, 'must emit importers finding');
  assert.strictEqual(f.count, 1);
  assert.ok(f.refs.some((r) => r.includes('main.js')));
});

test('cleanup-verifier contract: file with import-from importer is unsafe', async () => {
  const root = tmpRoot();
  writeFile(root, 'src/lib.js', 'export const x = 1;\n');
  writeFile(root, 'src/main.mjs', "import { x } from './lib.js';\nconsole.log(x);\n");
  const v = new CleanupVerifier({ rootDir: root });
  const result = await v.verify('src/lib.js');
  assert.strictEqual(result.safe, false);
  assert.ok(result.findings.some((f) => f.kind === 'importers'));
});

test('cleanup-verifier contract: entrypoint-pattern fires for index.js', async () => {
  const root = tmpRoot();
  writeFile(root, 'index.js', '// entry\n');
  const v = new CleanupVerifier({ rootDir: root });
  const result = await v.verify('index.js');
  assert.strictEqual(result.safe, false);
  const f = result.findings.find((x) => x.kind === 'entrypoint-pattern');
  assert.ok(f, 'must emit entrypoint-pattern finding');
});

test('cleanup-verifier contract: entrypoint-pattern fires for preload.js even without importers', async () => {
  const root = tmpRoot();
  writeFile(root, 'preload.js', '// preload\n');
  const v = new CleanupVerifier({ rootDir: root });
  const result = await v.verify('preload.js');
  assert.strictEqual(result.safe, false);
});

test('cleanup-verifier contract: ENTRYPOINT_NAMES is non-empty and includes preload.js', () => {
  assert.ok(ENTRYPOINT_NAMES.size > 0);
  assert.ok(ENTRYPOINT_NAMES.has('preload.js'));
  assert.ok(ENTRYPOINT_NAMES.has('index.js'));
  assert.ok(ENTRYPOINT_NAMES.has('main.js'));
});

test('cleanup-verifier contract: identical-content siblings are found', async () => {
  const root = tmpRoot();
  const shared = "module.exports = 'duplicate';\n";
  writeFile(root, 'src/a.js', shared);
  writeFile(root, 'src/copies/b.js', shared);
  writeFile(root, 'src/copies/c.js', shared);
  writeFile(root, 'src/different.js', 'module.exports = "different";\n');
  const v = new CleanupVerifier({ rootDir: root });
  const result = await v.verify('src/a.js');
  const f = result.findings.find((x) => x.kind === 'identical-siblings');
  assert.ok(f, 'must emit identical-siblings finding');
  assert.strictEqual(f.count, 2);
});

test('cleanup-verifier contract: sibling-name-matches are found (informational only)', async () => {
  const root = tmpRoot();
  writeFile(root, 'src/utils/helper.js', '// version A\n');
  writeFile(root, 'src/legacy/helper.js', '// version B (different content)\n');
  const v = new CleanupVerifier({ rootDir: root });
  const result = await v.verify('src/utils/helper.js');
  const f = result.findings.find((x) => x.kind === 'sibling-name-matches');
  assert.ok(f, 'must emit sibling-name-matches finding');
  assert.strictEqual(f.count, 1);
  // Informational only — sibling-name alone must not flip safe to false
  // (no importers, not entrypoint).
  assert.strictEqual(result.safe, true);
});

test('cleanup-verifier contract: non-existent target returns safe=false with not-found', async () => {
  const root = tmpRoot();
  const v = new CleanupVerifier({ rootDir: root });
  const result = await v.verify('src/missing.js');
  assert.strictEqual(result.safe, false);
  assert.ok(result.findings.some((f) => f.kind === 'not-found'));
});

test('cleanup-verifier contract: directory target returns safe=false with is-directory', async () => {
  const root = tmpRoot();
  fs.mkdirSync(path.join(root, 'src/somedir'), { recursive: true });
  const v = new CleanupVerifier({ rootDir: root });
  const result = await v.verify('src/somedir');
  assert.strictEqual(result.safe, false);
  assert.ok(result.findings.some((f) => f.kind === 'is-directory'));
});

test('cleanup-verifier contract: empty path throws', async () => {
  const root = tmpRoot();
  const v = new CleanupVerifier({ rootDir: root });
  await assert.rejects(() => v.verify(''), /non-empty/);
  await assert.rejects(() => v.verify('   '), /non-empty/);
});

test('cleanup-verifier contract: emits cleanup-verifier:scan-complete event when bus supplied', async () => {
  const root = tmpRoot();
  writeFile(root, 'src/lonely.js', 'module.exports = 1;\n');
  const fired = [];
  const bus = {
    fire(eventName, payload, meta) {
      fired.push({ eventName, payload, meta });
    },
  };
  const v = new CleanupVerifier({ rootDir: root, bus });
  await v.verify('src/lonely.js');
  assert.strictEqual(fired.length, 1);
  assert.strictEqual(fired[0].eventName, 'cleanup-verifier:scan-complete');
  assert.strictEqual(fired[0].payload.target, 'src/lonely.js');
  assert.strictEqual(fired[0].payload.safe, true);
});

test('cleanup-verifier contract: bus throwing does not break verify()', async () => {
  const root = tmpRoot();
  writeFile(root, 'src/lonely.js', 'module.exports = 1;\n');
  const bus = { fire() { throw new Error('bus is angry'); } };
  const v = new CleanupVerifier({ rootDir: root, bus });
  const result = await v.verify('src/lonely.js');
  // Must still return a valid result — telemetry failure is not fatal.
  assert.strictEqual(result.safe, true);
});

test('cleanup-verifier contract: throws on construction without rootDir', () => {
  assert.throws(() => new CleanupVerifier({}), /rootDir/);
});

test('cleanup-verifier contract: skipped dirs (node_modules, .git, dist) are not scanned', async () => {
  const root = tmpRoot();
  writeFile(root, 'src/target.js', 'module.exports = 1;\n');
  // These would otherwise match as importers but live in skipped dirs
  writeFile(root, 'node_modules/somepkg/index.js', "require('../../src/target');\n");
  writeFile(root, 'dist/bundle.js', "require('../src/target');\n");
  writeFile(root, '.git/hooks/pre-commit', '// not js anyway\n');
  const v = new CleanupVerifier({ rootDir: root });
  const result = await v.verify('src/target.js');
  // No real importers — target is safe to delete from project's perspective
  assert.strictEqual(result.safe, true);
  assert.ok(!result.findings.some((f) => f.kind === 'importers'));
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
