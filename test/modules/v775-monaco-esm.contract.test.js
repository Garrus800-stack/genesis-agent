'use strict';

// ============================================================
// v7.7.5 — Monaco AMD → ESM migration contract pins
//
// One file, multiple subtests covering the full migration:
//
//   A. package.json
//      A1. version is 7.7.5
//   B. editor.js — AMD removed, ESM in
//      B1. no AMD pattern (require.config / require(['vs/...]))
//      B2. MonacoEnvironment.getWorker setup present
//   C. index.html — cdnjs + amd-bypass removed, local Monaco bundle wired
//      C1. no cdnjs.cloudflare.com refs anywhere
//      C2. no amd-bypass-pre/post script tags
//      C3. local monaco.bundle.js + monaco.bundle.css linked
//   D. build-bundle.js — Monaco bundle step in, amd-bypass writeFileSync out
//      D1. no amd-bypass-pre.js or amd-bypass-post.js writeFileSync
//      D2. Monaco bundle step present (entryPoints: editor.main.js)
//      D3. Worker bundles present (5 workers: editor, ts, json, html, css)
//   E. main.js CSP — cdnjs out, blob: out
//      E1. no cdnjs.cloudflare.com in script/style/font/connect-src
//      E2. no blob: in script-src or worker-src
//   F. No regression of v7.7.4 audit pins
//      F1. audit-doc-drift still produces ≥ 53 checked claims
// ============================================================

const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { execSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`    ✅ ${name}`); passed++; }
  catch (e) { console.log(`    ❌ ${name}: ${e.message}`); failed++; }
}

const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf-8');

// ── A. package.json ────────────────────────────────

// A1 subtest below was retired in v7.7.6 — version-pin became obsolete
// once v7.7.6 shipped. The current version is pinned by
// `test/modules/v776-toolchain-refresh.contract.test.js` A1 instead.
//
// Same retirement pattern as v7.7.5 retiring v7.7.4's A1 (single-version
// pins are stage-marker tests, not invariants — they retire automatically
// when the next release ships).
//
// test('A1: package.json version is 7.7.5', () => {
//   const pkg = JSON.parse(read('package.json'));
//   assert.strictEqual(pkg.version, '7.7.5');
// });

// ── B. editor.js — AMD out, ESM in ─────────────────

test('B1: editor.js has no AMD loader pattern', () => {
  const src = read('src/ui/modules/editor.js');
  // Strip line comments before matching — historical references to
  // "no require.config()" in comments are intentional and should not fail this pin.
  const codeOnly = src.split('\n').map(l => l.split('//')[0]).join('\n');
  assert.ok(!/require\.config\s*\(/.test(codeOnly),
    'editor.js still contains require.config(...) in code');
  assert.ok(!/require\s*\(\s*\[\s*['"]vs\//.test(codeOnly),
    'editor.js still contains require(["vs/..."]) in code');
});

test('B2: editor.js sets up MonacoEnvironment.getWorker for ESM workers', () => {
  const src = read('src/ui/modules/editor.js');
  assert.ok(/MonacoEnvironment\s*=/.test(src),
    'editor.js must define self.MonacoEnvironment');
  assert.ok(/getWorker\s*\(/.test(src),
    'editor.js must define MonacoEnvironment.getWorker');
  assert.ok(/new Worker\s*\(/.test(src),
    'editor.js must construct workers via new Worker(...)');
});

// ── C. index.html — cdnjs + amd-bypass out ────────

test('C1: index.html has no cdnjs.cloudflare.com references', () => {
  const html = read('src/ui/index.html');
  assert.ok(!/cdnjs\.cloudflare\.com/.test(html),
    'index.html still references cdnjs.cloudflare.com');
});

test('C2: index.html has no amd-bypass script tags', () => {
  const html = read('src/ui/index.html');
  assert.ok(!/<script[^>]+amd-bypass-(pre|post)\.js/.test(html),
    'index.html still loads amd-bypass-pre/post.js scripts');
});

test('C3: index.html links local monaco.bundle.js and monaco.bundle.css', () => {
  const html = read('src/ui/index.html');
  assert.ok(/dist\/monaco\/monaco\.bundle\.js/.test(html),
    'index.html must reference dist/monaco/monaco.bundle.js');
  assert.ok(/dist\/monaco\/monaco\.bundle\.css/.test(html),
    'index.html must reference dist/monaco/monaco.bundle.css');
});

// ── D. build-bundle.js — Monaco step in, amd-bypass out ──

test('D1: build-bundle.js does not generate amd-bypass-{pre,post}.js anymore', () => {
  const src = read('scripts/build-bundle.js');
  // Look for writeFileSync calls writing amd-bypass files (not just mentions in comments)
  assert.ok(!/writeFileSync\s*\([^)]*amd-bypass-pre\.js/.test(src),
    'build-bundle.js still writes amd-bypass-pre.js');
  assert.ok(!/writeFileSync\s*\([^)]*amd-bypass-post\.js/.test(src),
    'build-bundle.js still writes amd-bypass-post.js');
});

test('D2: build-bundle.js has Monaco bundle build step', () => {
  const src = read('scripts/build-bundle.js');
  assert.ok(/editor\.main\.js/.test(src),
    'build-bundle.js must reference monaco editor.main.js entry');
  assert.ok(/globalName:\s*['"]monaco['"]/.test(src),
    'build-bundle.js must set globalName: "monaco"');
});

test('D3: build-bundle.js builds 5 worker bundles (editor, ts, json, html, css)', () => {
  const src = read('scripts/build-bundle.js');
  for (const w of ['editor.worker.js', 'ts.worker.js', 'json.worker.js', 'html.worker.js', 'css.worker.js']) {
    assert.ok(src.includes(w), `build-bundle.js must reference ${w}`);
  }
});

// ── E. main.js CSP — cdnjs + blob: out ────────────

test('E1: main.js CSP has no cdnjs.cloudflare.com', () => {
  const src = read('main.js');
  // Find the CSP block
  const cspMatch = /Content-Security-Policy[\s\S]*?\]/.exec(src);
  assert.ok(cspMatch, 'CSP block not found in main.js');
  assert.ok(!/cdnjs\.cloudflare\.com/.test(cspMatch[0]),
    'main.js CSP still contains cdnjs.cloudflare.com');
});

test('E2: main.js CSP has no blob: in script-src or worker-src', () => {
  const src = read('main.js');
  const cspMatch = /Content-Security-Policy[\s\S]*?\]/.exec(src);
  assert.ok(cspMatch, 'CSP block not found in main.js');
  // script-src directive
  const scriptSrc = /script-src ([^;]+);/.exec(cspMatch[0]);
  assert.ok(scriptSrc, 'script-src directive not found');
  assert.ok(!/\bblob:/.test(scriptSrc[1]),
    `script-src must not contain blob:, got "${scriptSrc[1].trim()}"`);
  // worker-src directive
  const workerSrc = /worker-src ([^;]+);/.exec(cspMatch[0]);
  assert.ok(workerSrc, 'worker-src directive not found');
  assert.ok(!/\bblob:/.test(workerSrc[1]),
    `worker-src must not contain blob:, got "${workerSrc[1].trim()}"`);
});

// ── F. No regression of v7.7.4 ────────────────────

test('F1: audit-doc-drift still produces ≥ 53 checked claims', () => {
  const out = execSync('node scripts/audit-doc-drift.js --json', {
    cwd: ROOT, encoding: 'utf-8',
  });
  const data = JSON.parse(out);
  assert.ok(Array.isArray(data.checked));
  assert.ok(data.checked.length >= 53,
    `expected ≥ 53 doc claims, got ${data.checked.length}`);
});

// ── Result ────────────────────────────────────────

console.log('');
console.log(`    ${passed} passed · ${failed} failed · v7.7.5 Monaco AMD → ESM contract`);
process.exit(failed > 0 ? 1 : 0);
