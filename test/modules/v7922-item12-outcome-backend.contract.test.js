'use strict';
// v7.9.22 Item 12 — every model-backed outcome channel attributes the answering backend;
// the shell channel records a distinct non-model label; the tracker still falls back to
// 'unknown' when a backend is genuinely absent.
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const ROOT = path.resolve(__dirname, '..', '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const orch = read('src/agent/hexagonal/ChatOrchestrator.js');
const purs = read('src/agent/revolution/AgentLoopPursuit.js');
const sm = read('src/agent/hexagonal/SelfModificationPipeline.js');
const sh = read('src/agent/hexagonal/CommandHandlersShell.js');
const tot = read('src/agent/cognitive/TaskOutcomeTracker.js');
let passed = 0, failed = 0;
function test(n, fn) { try { fn(); console.log('    \u2705 ' + n); passed++; } catch (e) { console.log('    \u274c ' + n + ': ' + e.message); failed++; } }

test('all four chat:completed payloads carry the active backend', () => {
  const lines = orch.split('\n').filter(l => l.includes("fire('chat:completed'"));
  assert.strictEqual(lines.length, 4, 'four chat:completed fires');
  assert.ok(lines.every(l => l.includes('backend: this.model.activeBackend')), 'each carries backend');
});
test('all three agent-loop:complete fires carry the active backend', () => {
  const m = purs.match(/backend: this\.model\?\.activeBackend \|\| 'unknown'/g) || [];
  assert.strictEqual(m.length, 3, 'three agent-loop:complete fires');
});
test('selfmod:success carries the active backend', () => {
  assert.ok(/'selfmod:success', \{ file, backend: this\.model\?\.activeBackend \|\| 'unknown' \}/.test(sm));
});
test('shell:outcome records the non-model label, not unknown', () => {
  assert.ok(/backend: 'shell'/.test(sh));
});
test('the tracker still falls back to unknown for a genuinely absent backend', () => {
  assert.ok(/backend: data\.backend \|\| 'unknown'/.test(tot));
});

console.log('\n    ' + passed + ' passed \u00b7 ' + failed + ' failed \u00b7 v7.9.22 Item 12 outcome-backend');
process.exit(failed > 0 ? 1 : 0);
