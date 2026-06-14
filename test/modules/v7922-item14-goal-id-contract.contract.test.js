'use strict';
// v7.9.22 Item 14 — every goal state event names the id `id`: the loop's abandoned fires
// send `id`, the schema requires it for goal:abandoned and names it `id` on the other
// state events, and the .d.ts matches. No goal state event still carries the id as goalId.
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const ROOT = path.resolve(__dirname, '..', '..');
let passed = 0, failed = 0;
function test(n, fn) { try { fn(); console.log('    \u2705 ' + n); passed++; } catch (e) { console.log('    \u274c ' + n + ': ' + e.message); failed++; } }
const pursuit = fs.readFileSync(path.join(ROOT, 'src/agent/revolution/AgentLoopPursuit.js'), 'utf8');
const schema = fs.readFileSync(path.join(ROOT, 'src/agent/core/EventPayloadSchemas.js'), 'utf8');
const dts = fs.readFileSync(path.join(ROOT, 'src/agent/core/EventPayloads.d.ts'), 'utf8');

test('both goal:abandoned fires send the id as id', () => {
  const m = pursuit.match(/id: this\.currentGoalId/g) || [];
  assert.strictEqual(m.length, 2, 'two abandoned fires send id');
});
test('schema marks goal:abandoned id required', () => {
  assert.ok(/'goal:abandoned':\s*\{ id: 'required'/.test(schema));
});
test('the five goal state events name the id `id` in the schema (no goalId)', () => {
  for (const ev of ['goal:created', 'goal:resumed', 'goal:replanned', 'goal:unblocked']) {
    const line = schema.split('\n').find(l => l.includes(`'${ev}':`));
    assert.ok(line && /\bid[?]?: /.test(line.replace(`'${ev}'`, '')) && !/goalId/.test(line), `${ev} names id, not goalId`);
  }
});
test('the .d.ts entries name the id `id`', () => {
  for (const ev of ['goal:abandoned', 'goal:created', 'goal:resumed', 'goal:replanned', 'goal:unblocked']) {
    const idx = dts.indexOf(`'${ev}': {`);
    assert.ok(idx >= 0, `${ev} present`);
    const after = dts.slice(idx + `'${ev}': {`.length);
    const block = after.slice(0, after.indexOf('}'));
    assert.ok(/id[?]?: any;/.test(block) && !/goalId/.test(block), `${ev} names id in .d.ts`);
  }
});

console.log('\n    ' + passed + ' passed \u00b7 ' + failed + ' failed \u00b7 v7.9.22 Item 14 goal-id-contract');
process.exit(failed > 0 ? 1 : 0);
