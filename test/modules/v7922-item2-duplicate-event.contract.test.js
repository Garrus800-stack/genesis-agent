'use strict';
// v7.9.22 Item 2 — event hash-chain integrity across a crash-restart fork. Both
// walkers tolerate the two benign artifacts a crash-restart can leave in the
// append-only log — an exact duplicate line, and a superseded restart-fork orphan
// (a reused id whose branch is dead while a live sibling carries the chain on) —
// regardless of which sibling the flush race wrote first, while a genuinely altered
// payload (same id, different valid hash, no live continuation) still fails both.
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const ROOT = path.resolve(__dirname, '..', '..');
const { EventStore } = require(path.join(ROOT, 'src/agent/foundation/EventStore'));
let passed = 0, failed = 0;
function test(n, fn) { try { fn(); console.log('    \u2705 ' + n); passed++; } catch (e) { console.log('    \u274c ' + n + ': ' + e.message); failed++; } }

function makeStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'es-'));
  const fired = [];
  const bus = { fire: (n, d) => fired.push({ n, d }), emit() {}, on() { return () => {}; } };
  const store = new EventStore(dir, bus, null, {});
  store._fired = fired; store._dir = dir;
  store.projections.set('count', { state: { total: 0 }, reducer: (s) => ({ total: (s.total || 0) + 1 }) });
  return store;
}
function chain(store, n) {
  let prevHash = '0000000000000000'; const out = [];
  for (let i = 0; i < n; i++) {
    const e = { id: i, type: 'TEST', payload: { n: i }, source: 'test', timestamp: 1000 + i, isoTime: 'x', prevHash };
    e.hash = store._computeHash(e); prevHash = e.hash; out.push(e);
  }
  return out;
}
function writeLog(store, events) {
  fs.writeFileSync(path.join(store._dir, 'events.jsonl'), events.map(e => JSON.stringify(e)).join('\n') + '\n', 'utf8');
}
// A crash-restart fork at id 3: a parent (id 2), an orphan child and a live sibling
// child that share the parent with different valid hashes, and a continuation that
// chains onto the LIVE sibling. orphanFirst toggles the flush-race write order.
function forkLog(store, orphanFirst) {
  const base = chain(store, 3);                              // ids 0,1,2
  const parent = base[2];
  const mk = (id, prevHash, n) => {
    const e = { id, type: 'TEST', payload: { n }, source: 'test', timestamp: 2000 + id, isoTime: 'x', prevHash };
    e.hash = store._computeHash(e); return e;
  };
  const live = mk(3, parent.hash, 301);                      // the branch the chain continues from
  const orphan = mk(3, parent.hash, 302);                    // same id + parent, different payload → dead branch
  const cont = mk(4, live.hash, 4);                          // chains onto the LIVE sibling
  return [...base, ...(orphanFirst ? [orphan, live] : [live, orphan]), cont];
}
function runFork(orphanFirst, label) {
  const store = makeStore();
  writeLog(store, forkLog(store, orphanFirst));
  store.replay();
  assert.ok(!store._fired.some(f => f.n === 'store:integrity-violation'), label + ': no false violation');
  assert.strictEqual(store.projections.get('count').state.total, 5, label + ': live branch projected (5), orphan skipped');
  const v = store.verifyIntegrity();
  assert.ok(!v.violations.some(x => x.issue === 'broken-chain'), label + ': verifyIntegrity sees no broken chain');
}

test('a duplicated {id,hash} line: no integrity-violation, projected once, verifies clean', () => {
  const store = makeStore();
  const evs = chain(store, 3);
  writeLog(store, [...evs, { ...evs[2] }]);            // exact duplicate of the last event
  store.replay();
  assert.ok(!store._fired.some(f => f.n === 'store:integrity-violation'), 'no false violation');
  assert.strictEqual(store.projections.get('count').state.total, 3, 'duplicate not projected twice');
  const v = store.verifyIntegrity();
  assert.ok(!v.violations.some(x => x.issue === 'broken-chain'), 'verifyIntegrity sees no broken chain');
});

test('a same-id line with a different hash still fails both walkers', () => {
  const store = makeStore();
  const evs = chain(store, 3);
  const tamper = { ...evs[2], payload: { n: 999 } };   // same id, altered payload
  tamper.hash = store._computeHash(tamper);            // its own (different) hash
  writeLog(store, [...evs, tamper]);
  store.replay();
  assert.ok(store._fired.some(f => f.n === 'store:integrity-violation'), 'replay flags real tamper');
  const v = store.verifyIntegrity();
  assert.ok(v.violations.some(x => x.issue === 'broken-chain'), 'verifyIntegrity flags real tamper');
});

test('restart-fork, orphan written before its live sibling: live branch projected, orphan skipped, verifies clean', () => runFork(true, 'orphan-first'));
test('restart-fork, live sibling written before the orphan: same result regardless of flush order', () => runFork(false, 'live-first'));

console.log('\n    ' + passed + ' passed \u00b7 ' + failed + ' failed \u00b7 v7.9.22 Item 2 event-chain integrity');
process.exit(failed > 0 ? 1 : 0);
