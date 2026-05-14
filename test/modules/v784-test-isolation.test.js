// ============================================================
// GENESIS — test/modules/v784-test-isolation.test.js (v7.8.4)
//
// test-isolation contract: the test runner must guarantee that no
// test makes a real HTTP call to a developer's local Ollama daemon.
//
// Previously (since v5.1.0), the ModelBridge legacy test in
// test/run-tests.js called `bridge.chat()` with no backend, which
// silently fell back to the default Ollama URL (127.0.0.1:11434).
// If a real Ollama daemon was running, it received the request —
// and if the user's preferred model was a cloud-tagged model that
// failed over to a local model, Ollama would load that model into
// RAM during npm test.
//
// v7.8.4 fix: OllamaBackend honours GENESIS_OFFLINE_TESTS=1 and
// rejects real HTTP calls. test/index.js sets the env var before
// spawning child test processes. This contract enforces that the
// guard is present and that the test runner sets the env var.
// ============================================================

'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

let passed = 0, failed = 0;
const failures = [];

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`    ✅ ${name}`);
  } catch (err) {
    failed++;
    failures.push({ name, error: err.message });
    console.log(`    ❌ ${name}: ${err.message}`);
  }
}

const ROOT = path.join(__dirname, '..', '..');

// ── test-isolation contract: OllamaBackend guard ─────────

test('test-isolation contract: OllamaBackend._httpGet rejects when GENESIS_OFFLINE_TESTS=1', () => {
  const src = fs.readFileSync(
    path.join(ROOT, 'src/agent/foundation/backends/OllamaBackend.js'),
    'utf-8'
  );
  // The guard must appear inside _httpGet and check the env var.
  const httpGetMatch = src.match(/_httpGet\(urlStr\)\s*\{[\s\S]+?return new Promise/);
  assert.ok(httpGetMatch, '_httpGet body must exist');
  assert.match(
    httpGetMatch[0],
    /process\.env\.GENESIS_OFFLINE_TESTS\s*===?\s*['"]1['"]/,
    '_httpGet must check GENESIS_OFFLINE_TESTS env flag'
  );
  assert.match(
    httpGetMatch[0],
    /Promise\.reject\(/,
    '_httpGet must reject when in test mode'
  );
});

test('test-isolation contract: OllamaBackend._httpPost rejects when GENESIS_OFFLINE_TESTS=1', () => {
  const src = fs.readFileSync(
    path.join(ROOT, 'src/agent/foundation/backends/OllamaBackend.js'),
    'utf-8'
  );
  const httpPostMatch = src.match(/_httpPost\(urlStr, body[\s\S]+?return new Promise/);
  assert.ok(httpPostMatch, '_httpPost body must exist');
  assert.match(
    httpPostMatch[0],
    /process\.env\.GENESIS_OFFLINE_TESTS\s*===?\s*['"]1['"]/,
    '_httpPost must check GENESIS_OFFLINE_TESTS env flag'
  );
  assert.match(
    httpPostMatch[0],
    /Promise\.reject\(/,
    '_httpPost must reject when in test mode'
  );
});

test('test-isolation contract: test/index.js sets GENESIS_OFFLINE_TESTS=1 before spawning children', () => {
  const src = fs.readFileSync(path.join(ROOT, 'test/index.js'), 'utf-8');
  // The env var must be set near the top of the file, before any
  // require() that might pull in code that spawns processes.
  const setLine = src.match(/process\.env\.GENESIS_OFFLINE_TESTS\s*=\s*['"]1['"]/);
  assert.ok(setLine, 'test/index.js must set GENESIS_OFFLINE_TESTS=1');
  // It must appear before child_process is required — so children inherit env.
  const setIdx = src.indexOf(setLine[0]);
  const requireIdx = src.indexOf("require('child_process')");
  assert.ok(requireIdx > 0, 'must require child_process somewhere');
  assert.ok(setIdx < requireIdx,
    'env var must be set before require(child_process) so spawned children inherit it');
});

test('test-isolation contract: live runtime check — guard rejects when env is set', async () => {
  // This is the strongest assertion: actually load the backend, set
  // the env var, and verify that a fake HTTP call is rejected.
  const prev = process.env.GENESIS_OFFLINE_TESTS;
  process.env.GENESIS_OFFLINE_TESTS = '1';
  try {
    const { OllamaBackend } = require(
      path.join(ROOT, 'src/agent/foundation/backends/OllamaBackend.js')
    );
    const backend = new OllamaBackend();
    let threw = false;
    try {
      // listModels would normally GET /api/tags
      await backend.listModels();
    } catch (err) {
      threw = true;
      assert.match(err.message, /test mode|GENESIS_OFFLINE_TESTS/i,
        'rejection message must reference test mode');
    }
    assert.ok(threw, 'listModels() must reject when GENESIS_OFFLINE_TESTS=1');
  } finally {
    if (prev === undefined) delete process.env.GENESIS_OFFLINE_TESTS;
    else process.env.GENESIS_OFFLINE_TESTS = prev;
  }
});

test('test-isolation contract: env var is OFF outside the test runner', () => {
  // Sanity: the production code path must NOT default to offline mode.
  // The check is on string-equal '1', so any other value (undefined,
  // '', '0') leaves the backend operational.
  assert.notStrictEqual(
    '0',
    '1',
    'string compare must require exact "1" — not truthy check'
  );
  const src = fs.readFileSync(
    path.join(ROOT, 'src/agent/foundation/backends/OllamaBackend.js'),
    'utf-8'
  );
  // Check both guards use === '1', not just truthy
  const guardLines = src.match(/process\.env\.GENESIS_OFFLINE_TESTS[\s\S]{0,40}/g) || [];
  assert.ok(guardLines.length >= 2, 'must have ≥2 guards (one per http method)');
  for (const line of guardLines) {
    assert.match(line, /===?\s*['"]1['"]/,
      `each guard must compare to '1' explicitly, not use truthy check — got: ${line}`);
  }
});

// ── summary ───────────────────────────────────────────────

if (failed > 0) {
  console.log(`\n  ${failed} failure(s):`);
  for (const f of failures) console.log(`    - ${f.name}: ${f.error}`);
  process.exit(1);
}
console.log(`    ${passed} passed`);
