// ============================================================
// Test: v7.6.9 — AgentLoop pursuit mixin extraction contract
//
// Pins the structural contract of the split:
//   - AgentLoopPursuit.js exports agentLoopPursuitMixin with
//     exactly { pursue, _executeLoop }
//   - AgentLoop.js mounts the mixin onto AgentLoop.prototype
//   - prototype methods are identity-equal to mixin members
//   - AgentLoop.js does not redefine the methods at class level
//   - AgentLoop.js requires AgentLoopPursuit and Object.assigns
//     onto the prototype
// ============================================================

let passed = 0, failed = 0;
const failures = [];

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`    ✅ ${name}`);
  } catch (err) {
    failed++;
    failures.push({ name, err });
    console.log(`    ❌ ${name}: ${err.message}`);
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'Assertion failed');
}

const path = require('path');
const fs = require('fs');

const ROOT = path.resolve(__dirname, '..', '..');
const AGENT_LOOP_PATH = path.join(ROOT, 'src/agent/revolution/AgentLoop.js');
const PURSUIT_PATH = path.join(ROOT, 'src/agent/revolution/AgentLoopPursuit.js');

// ── 1. Mixin exports exactly { pursue, _executeLoop } ────────
test('AgentLoopPursuit exports agentLoopPursuitMixin with exactly 2 keys', () => {
  const m = require(PURSUIT_PATH);
  assert(m.agentLoopPursuitMixin, 'must export agentLoopPursuitMixin');
  const keys = Object.keys(m.agentLoopPursuitMixin).sort();
  assert(keys.length === 2, `expected 2 keys, got ${keys.length}: ${keys}`);
  assert(keys[0] === '_executeLoop', `expected _executeLoop, got ${keys[0]}`);
  assert(keys[1] === 'pursue', `expected pursue, got ${keys[1]}`);
});

// ── 2. AgentLoopPursuit module loads cleanly (all requires resolve) ──
test('AgentLoopPursuit module loads cleanly (requires resolve)', () => {
  // implicit success if require above did not throw, but we re-require fresh
  delete require.cache[require.resolve(PURSUIT_PATH)];
  const m = require(PURSUIT_PATH);
  assert(typeof m === 'object');
  assert(m.agentLoopPursuitMixin);
  assert(typeof m.agentLoopPursuitMixin.pursue === 'function');
  assert(typeof m.agentLoopPursuitMixin._executeLoop === 'function');
});

// ── 3. Object.assign mounts onto AgentLoop.prototype ─────────
test('AgentLoop.prototype has pursue and _executeLoop after require', () => {
  const { AgentLoop } = require(AGENT_LOOP_PATH);
  assert(typeof AgentLoop.prototype.pursue === 'function',
    'AgentLoop.prototype.pursue must be a function');
  assert(typeof AgentLoop.prototype._executeLoop === 'function',
    'AgentLoop.prototype._executeLoop must be a function');
});

// ── 4. identity-equality: prototype.pursue === mixin.pursue ──
test('identity-equality: AgentLoop.prototype.pursue === mixin.pursue', () => {
  const { AgentLoop } = require(AGENT_LOOP_PATH);
  const { agentLoopPursuitMixin } = require(PURSUIT_PATH);
  assert(AgentLoop.prototype.pursue === agentLoopPursuitMixin.pursue,
    'pursue is not identity-equal — mixin mount may have been overridden');
});

// ── 5. identity-equality: prototype._executeLoop === mixin._executeLoop ──
test('identity-equality: AgentLoop.prototype._executeLoop === mixin._executeLoop', () => {
  const { AgentLoop } = require(AGENT_LOOP_PATH);
  const { agentLoopPursuitMixin } = require(PURSUIT_PATH);
  assert(AgentLoop.prototype._executeLoop === agentLoopPursuitMixin._executeLoop,
    '_executeLoop is not identity-equal — mixin mount may have been overridden');
});

// ── 6. source-presence: AgentLoop.js does NOT redefine the methods ──
test('AgentLoop.js does not redefine pursue() at class level', () => {
  const src = fs.readFileSync(AGENT_LOOP_PATH, 'utf8');
  // class-body method definition: 2-space indent + (async )?pursue(
  // Excludes prototype assignment (which is at module level, not class level)
  // and excludes property names like "this.pursue".
  assert(!/^\s{2}async\s+pursue\s*\(/m.test(src),
    'AgentLoop.js must not redefine async pursue() at class level — regression of structural extraction');
  assert(!/^\s{2}pursue\s*\(/m.test(src),
    'AgentLoop.js must not redefine pursue() at class level');
});

test('AgentLoop.js does not redefine _executeLoop() at class level', () => {
  const src = fs.readFileSync(AGENT_LOOP_PATH, 'utf8');
  assert(!/^\s{2}async\s+_executeLoop\s*\(/m.test(src),
    'AgentLoop.js must not redefine async _executeLoop() at class level');
  assert(!/^\s{2}_executeLoop\s*\(/m.test(src),
    'AgentLoop.js must not redefine _executeLoop() at class level');
});

// ── 7. mount-line presence ───────────────────────────────────
test('AgentLoop.js requires AgentLoopPursuit and Object.assigns onto prototype', () => {
  const src = fs.readFileSync(AGENT_LOOP_PATH, 'utf8');
  assert(src.includes("require('./AgentLoopPursuit')"),
    "AgentLoop.js must require('./AgentLoopPursuit')");
  assert(/Object\.assign\s*\(\s*AgentLoop\.prototype\s*,\s*\w*[Pp]ursuit/.test(src),
    'AgentLoop.js must Object.assign(AgentLoop.prototype, agentLoopPursuitMixin)');
});

// ── 8. AgentLoopPursuit.js LOC under File-Size-Guard threshold ──
test('AgentLoopPursuit.js stays under File-Size-Guard threshold (<700 LOC)', () => {
  const src = fs.readFileSync(PURSUIT_PATH, 'utf8');
  const loc = src.split('\n').length;
  assert(loc < 700,
    `AgentLoopPursuit.js has ${loc} LOC — must stay under 700 (File-Size-Guard threshold). ` +
    `If split needs to grow, consider further extraction.`);
});

// ── Summary ──────────────────────────────────────────────────
console.log('');
console.log(`    ${passed} passed · ${failed} failed · v7.6.9 AgentLoop pursuit split contract`);

if (failed > 0) {
  console.error(`    ${failed} test(s) failed:`);
  failures.forEach(f => console.error(`      - ${f.name}: ${f.err.message}`));
  process.exit(1);
}
