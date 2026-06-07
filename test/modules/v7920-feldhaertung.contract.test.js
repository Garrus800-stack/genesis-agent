'use strict';
// v7.9.20 Feld-Härtung — F1 (toPosix), F2 (consolidation primitive),
// L1 (broad review filter), K1 (goal success flag).
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const ROOT = path.resolve(__dirname, '..', '..');
const { toPosix } = require(path.join(ROOT, 'src/agent/core/utils'));
const { orderByReviewState } = require(path.join(ROOT, 'src/agent/autonomy/activities/plan-review-feedback'));
const { AgentLoopStepsDelegate } = require(path.join(ROOT, 'src/agent/revolution/AgentLoopSteps'));
const GS = fs.readFileSync(path.join(ROOT, 'src/agent/planning/GoalStack.js'), 'utf8');
const GSL = fs.readFileSync(path.join(ROOT, 'src/agent/planning/GoalStackLifecycle.js'), 'utf8');

let passed = 0, failed = 0;
function test(n, fn){ try{ fn(); console.log('    \u2705 '+n); passed++; }catch(e){ console.log('    \u274c '+n+': '+e.message); failed++; } }

// F1
test('F1: toPosix normalises, idempotent, null-safe, Linux no-op', () => {
  assert.strictEqual(toPosix('src\\a\\b.js'), 'src/a/b.js');
  assert.strictEqual(toPosix(toPosix('src\\a')), 'src/a');
  assert.strictEqual(toPosix(null), null);
  assert.strictEqual(toPosix('src/a/b.js'), 'src/a/b.js');
});

// F2
test('F2: ANALYZE stores a durable insight node, novelty-gated, POSIX-keyed', () => {
  const nodes = [];
  const kg = { addNode:(t,l,p)=>{nodes.push({type:t,label:l,properties:p});return 'id';}, getNodesByType:(t)=>nodes.filter(n=>n.type===t) };
  const d = Object.create(AgentLoopStepsDelegate.prototype);
  const A = 'The HTNPlanner decomposes goals into ordered subtasks and caches results.';
  // simulate the F2 block deterministically through the real novelty gate
  const write = (target, analysis) => {
    const mk = toPosix(target||'');
    if (d._isNovelAnalysis(kg, mk, analysis)) { kg.addNode('insight', 'review: '+mk, {type:'agent-loop-analysis', module:mk||null, full:analysis.slice(0,400)}); return true; }
    return false;
  };
  assert.ok(write('src\\agent\\x.js', A), 'first English analysis must be stored');
  assert.strictEqual(nodes[0].properties.module, 'src/agent/x.js', 'module key must be POSIX');
  assert.ok(!write('src\\agent\\x.js', A), 'exact repeat must be blocked by novelty gate');
  assert.strictEqual(nodes.length, 1, 'repeat must not add a node');
  assert.ok(write('src\\agent\\x.js', 'A totally different note on retry backoff and error handling.'), 'new finding stored');
  assert.strictEqual(nodes.length, 2);
});

// L1
test('L1: broad filter catches Explore(file:), ReadSource+F2(module:), type-independent', () => {
  const modules = [{file:'src/a/Reflect.js'},{file:'src/a/Plan.js'},{file:'src/a/Goal.js'},{file:'src/a/New.js'}];
  const kg = { getNodesByType:(t)=> t==='insight' ? [
    {properties:{type:'code-review', file:'src/a/Reflect.js'}},
    {properties:{type:'self-read', module:'src/a/Plan.js'}},
    {properties:{type:'agent-loop-analysis', module:'src/a/Goal.js'}},
  ] : [] };
  const { realPaths, alreadyReviewed } = orderByReviewState(modules, kg);
  const lines = realPaths.split('\n');
  assert.strictEqual(lines[0], 'src/a/New.js', 'uncovered file must come first');
  ['Reflect.js','Plan.js','Goal.js'].forEach(f => assert.ok(alreadyReviewed.includes(f), f+' must be marked covered'));
});
test('L1: defensive without getNodesByType', () => {
  const r = orderByReviewState([{file:'x'}], {});
  assert.strictEqual(r.realPaths, 'x');
  assert.strictEqual(r.alreadyReviewed, '');
});

// K1
test('K1: all goal:completed emitters carry success:true', () => {
  const re = /fire\('goal:completed',\s*\{([\s\S]*?)\}/g;
  let m, total = 0, withSuccess = 0;
  for (const src of [GS, GSL]) { while ((m = re.exec(src))) { total++; if (/success:\s*true/.test(m[1])) withSuccess++; } }
  assert.strictEqual(total, 5, 'expected 5 emitters, found '+total);
  assert.strictEqual(withSuccess, 5, 'all 5 must set success:true, got '+withSuccess);
});

console.log('\n    '+passed+' passed \u00b7 '+failed+' failed \u00b7 v7.9.20 Feld-Härtung');
process.exit(failed>0?1:0);
