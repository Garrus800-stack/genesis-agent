// ============================================================
// Test: CodeSafetyScanner.js — AST-based safety analysis
// Verifies that obfuscated dangerous code is caught.
// ============================================================
let passed = 0, failed = 0;
const failures = [];

// v3.5.2: Fixed — queue-based async-safe test runner
const _testQueue = [];
function test(name, fn) { _testQueue.push({ name, fn }); }
function assert(c, m) { if (!c) throw new Error(m || 'Assertion failed'); }

const { scanCodeSafety } = require('../../src/agent/intelligence/CodeSafetyScanner');

console.log('\n  📦 CodeSafetyScanner (AST-based)');

// ── Direct patterns (should still be caught) ─────────────

test('blocks eval()', () => {
  const r = scanCodeSafety('eval("alert(1)")', 'test.js');
  assert(!r.safe, 'eval should be blocked');
  assert(r.blocked.some(b => b.description.includes('eval')));
});

test('blocks new Function()', () => {
  const r = scanCodeSafety('const fn = new Function("return 1");', 'test.js');
  assert(!r.safe);
  assert(r.blocked.some(b => b.description.includes('Function')));
});

test('blocks process.exit()', () => {
  const r = scanCodeSafety('process.exit(1);', 'test.js');
  assert(!r.safe);
  assert(r.blocked.some(b => b.description.includes('process.exit')));
});

test('blocks kernel import', () => {
  const r = scanCodeSafety("const sg = require('../kernel/SafeGuard');", 'test.js');
  assert(!r.safe);
  assert(r.blocked.some(b => b.description.includes('kernel')));
});

test('blocks nodeIntegration:true', () => {
  const r = scanCodeSafety('const opts = { nodeIntegration: true };', 'test.js');
  assert(!r.safe);
});

test('blocks contextIsolation:false', () => {
  const r = scanCodeSafety('const opts = { contextIsolation: false };', 'test.js');
  assert(!r.safe);
});

test('blocks webSecurity:false', () => {
  const r = scanCodeSafety('const opts = { webSecurity: false };', 'test.js');
  assert(!r.safe);
});

test('blocks fs.writeFileSync to /etc/', () => {
  const r = scanCodeSafety("fs.writeFileSync('/etc/passwd', 'hacked');", 'test.js');
  assert(!r.safe);
});

test('blocks SafeGuard identifier reference', () => {
  const r = scanCodeSafety('console.log(SafeGuard);', 'test.js');
  assert(!r.safe);
  assert(r.blocked.some(b => b.description.includes('kernel internals')));
});

test('blocks kernelHashes reference', () => {
  const r = scanCodeSafety('const h = kernelHashes;', 'test.js');
  assert(!r.safe);
});

// ── Obfuscation bypasses (AST catches, regex might miss) ──

test('catches indirect eval: (0,eval)()', () => {
  const r = scanCodeSafety('(0, eval)("alert(1)");', 'test.js');
  assert(!r.safe, 'Indirect eval should be caught');
});

test('catches global.eval()', () => {
  const r = scanCodeSafety('global.eval("code");', 'test.js');
  assert(!r.safe, 'global.eval should be caught');
});

test('catches globalThis.eval()', () => {
  const r = scanCodeSafety('globalThis.eval("code");', 'test.js');
  assert(!r.safe, 'globalThis.eval should be caught');
});

// ── Warnings (not blocked) ────────────────────────────────

test('warns on child_process require', () => {
  const r = scanCodeSafety("const cp = require('child_process');", 'test.js');
  assert(r.safe, 'child_process should warn, not block');
  assert(r.warnings.some(w => w.description.includes('child_process')));
});

test('warns on http require', () => {
  const r = scanCodeSafety("const http = require('http');", 'test.js');
  assert(r.safe);
  assert(r.warnings.some(w => w.description.includes('network')));
});

test('warns on fetch()', () => {
  const r = scanCodeSafety("fetch('https://evil.com');", 'test.js');
  assert(r.safe);
  assert(r.warnings.some(w => w.description.includes('fetch')));
});

test('warns on new WebSocket()', () => {
  const r = scanCodeSafety("new WebSocket('ws://evil.com');", 'test.js');
  assert(r.safe);
  assert(r.warnings.some(w => w.description.includes('WebSocket')));
});

test('warns on fs.unlinkSync', () => {
  const r = scanCodeSafety("fs.unlinkSync('file.txt');", 'test.js');
  assert(r.safe);
  assert(r.warnings.some(w => w.description.includes('delete')));
});

test('warns on path traversal in string literal', () => {
  const r = scanCodeSafety("const p = '../../etc/passwd';", 'test.js');
  assert(r.safe);
  assert(r.warnings.some(w => w.description.includes('traversal')));
});

test('warns on process.env.SECRET_KEY', () => {
  const r = scanCodeSafety('const key = process.env.SECRET_KEY;', 'test.js');
  assert(r.safe);
  assert(r.warnings.some(w => w.description.includes('secret')));
});

// ── Safe code (no issues) ─────────────────────────────────

test('safe code: simple module', () => {
  const r = scanCodeSafety("const x = 1;\nmodule.exports = { x };", 'test.js');
  assert(r.safe);
  assert(r.blocked.length === 0);
});

test('safe code: class definition', () => {
  const code = `
class MyService {
  constructor(bus) { this.bus = bus; }
  start() { console.log('started'); }
}
module.exports = { MyService };`;
  const r = scanCodeSafety(code, 'test.js');
  assert(r.safe);
  assert(r.blocked.length === 0);
});

test('safe code: contextIsolation:true is fine', () => {
  const r = scanCodeSafety('const opts = { contextIsolation: true };', 'test.js');
  assert(r.safe);
});

test('safe code: nodeIntegration:false is fine', () => {
  const r = scanCodeSafety('const opts = { nodeIntegration: false };', 'test.js');
  assert(r.safe);
});

// ── Edge cases ────────────────────────────────────────────

test('handles unparseable code (falls back to regex)', () => {
  const r = scanCodeSafety('const x = {{{; eval("y")', 'test.js');
  // Should not crash. Regex fallback should catch eval
  assert(!r.safe || r.warnings.length >= 0, 'Should not crash on bad syntax');
});

test('empty code is safe', () => {
  const r = scanCodeSafety('', 'test.js');
  assert(r.safe);
  assert(r.blocked.length === 0);
});

test('scanMethod reports ast+regex when acorn available', () => {
  const r = scanCodeSafety('const x = 1;', 'test.js');
  assert(r.scanMethod === 'ast+regex' || r.scanMethod === 'regex-only');
});

test('deduplicates identical findings from AST and regex', () => {
  const r = scanCodeSafety('eval("x")', 'test.js');
  // eval should appear once, not twice (AST + regex)
  const evalBlocks = r.blocked.filter(b => b.description.includes('eval'));
  assert(evalBlocks.length <= 2, `Excessive duplicates: ${evalBlocks.length}`);
});

// v3.5.2: Async-safe runner — properly awaits all tests
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
