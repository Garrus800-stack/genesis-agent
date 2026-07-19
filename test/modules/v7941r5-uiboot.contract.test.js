#!/usr/bin/env node
// ============================================================
// GENESIS — test/modules/v7941r5-uiboot.contract.test.js
// v7.9.41 r5: boot responsiveness. Guards the four cuts that keep
// the window responsive during boot — and the invariants that must
// NOT move (shutdown stays synchronous; hash equivalence).
// ============================================================
'use strict';
const { describe, test, assert, assertEqual, run, createTestRoot } = require('../harness');
const path = require('path');
const fs = require('fs');
const ROOT = path.resolve(__dirname, '..', '..');
const { SnapshotManager } = require(path.join(ROOT, 'src/agent/capabilities/SnapshotManager'));

function makeTree(label, files) {
  const root = createTestRoot(label);
  for (const [rel, content] of files) {
    const p = path.join(root, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content);
  }
  return root;
}
const demoFiles = [];
for (let i = 0; i < 60; i++) demoFiles.push([path.join('src', 'm' + String(i).padStart(2, '0') + '.js'), 'module.exports = ' + i + ';\n']);
demoFiles.push(['package.json', '{"version":"9.9.9"}\n']);

describe('v7941r5 U0a — lazy web parsers', () => {
  const src = fs.readFileSync(path.join(ROOT, 'src/agent/capabilities/WebPerception.js'), 'utf8');
  test('no top-level eager require of cheerio/puppeteer remains', () => {
    assert(!/^let cheerio = null;\ntry \{ cheerio = require/m.test(src), 'old eager cheerio pattern gone');
    assert(!/^let puppeteer = null;\ntry \{ puppeteer = require/m.test(src), 'old eager puppeteer pattern gone');
    assert(/function _cheerio\(\)/.test(src) && /function _puppeteer\(\)/.test(src), 'lazy loaders exist');
  });
  test('availability is reported without loading (require.resolve)', () => {
    assert(/_canResolve\('puppeteer'\)/.test(src), 'headless availability via resolve');
    assert(/cheerioAvailable: _canResolve\('cheerio'\)/.test(src), 'status availability via resolve');
  });
  test('constructor does not call the lazy loaders', () => {
    const ctor = src.slice(src.indexOf('constructor('), src.indexOf('\n  }', src.indexOf('constructor(')));
    assert(!/_cheerio\(\)|_puppeteer\(\)/.test(ctor), 'no load at construction');
  });
});

describe('v7941r5 U0b — compile cache', () => {
  test('main.js enables the V8 compile cache before first require', () => {
    const main = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8');
    const i = main.indexOf('enableCompileCache');
    const j = main.indexOf("require('electron')");
    assert(i > -1 && j > -1 && i < j, 'cache line sits above the electron require');
  });
});

describe('v7941r5 U1 — snapshot async twin', () => {
  test('createAsync produces the IDENTICAL hash and fileCount as create()', async () => {
    const rootA = makeTree('uiboot-eq-a', demoFiles);
    const rootB = makeTree('uiboot-eq-b', demoFiles);
    const smA = new SnapshotManager({ rootDir: rootA });
    const smB = new SnapshotManager({ rootDir: rootB });
    const a = smA.create('probe');
    const b = await smB.createAsync('probe');
    assertEqual(a.fileCount, b.fileCount, 'same file count');
    assertEqual(a.hash, b.hash, 'same hash — incremental ≡ rehash');
    assertEqual(a.codeVersion, b.codeVersion, 'same codeVersion source');
  });
  test('createAsync breathes — the event loop is never starved', async () => {
    const many = [];
    for (let i = 0; i < 100; i++) many.push([path.join('src', 'f' + String(i).padStart(3, '0') + '.js'), 'x'.repeat(512)]); // r6: 100 files prove breathing as well as 300 did — a third of the disk cost on slow field drives
    many.push(['package.json', '{"version":"9.9.9"}\n']);
    const root = makeTree('uiboot-breath', many);
    const sm = new SnapshotManager({ rootDir: root });
    let last = Date.now(); let maxGap = 0;
    const t = setInterval(() => { const n = Date.now(); if (n - last > maxGap) maxGap = n - last; last = n; }, 25);
    await sm.createAsync('breath');
    clearInterval(t);
    assert(maxGap < 400, 'ticker max gap under 400ms (was: ' + maxGap + 'ms)');
  });
  test('create() itself stays synchronous (shutdown invariant)', () => {
    const src = fs.readFileSync(path.join(ROOT, 'src/agent/capabilities/SnapshotManager.js'), 'utf8');
    const body = src.slice(src.indexOf('  create(name'), src.indexOf('createAsync('));
    assert(/copyFileSync|_copyRecursive/.test(body), 'sync copy path intact in create()');
    assert(!/await /.test(body), 'no await inside create()');
  });
  test('only the boot snapshot switches — crash/deploy callers stay sync', () => {
    const br = fs.readFileSync(path.join(ROOT, 'src/agent/foundation/BootRecovery.js'), 'utf8');
    assert(/createAsync\('_last_good_boot'\)/.test(br), 'boot snapshot uses the async twin');
    assert(/create\(`_crash_recovery_/.test(br), 'crash recovery stays on sync create()');
    const dm = fs.readFileSync(path.join(ROOT, 'src/agent/autonomy/DeploymentManager.js'), 'utf8');
    assert(/\.create\(snapshotName/.test(dm), 'pre-deploy backup stays on sync create()');
  });
});

describe('v7941r5 U2 — boot breathing points', () => {
  test('container loops breathe (sequential and parallel resolve)', () => {
    const src = fs.readFileSync(path.join(ROOT, 'src/agent/core/Container.js'), 'utf8');
    const hits = (src.match(/await new Promise\(\(r\) => setImmediate\(r\)\)/g) || []).length;
    assert(hits >= 2, 'both boot loops carry a breath (found ' + hits + ')');
  });
  test('eager foundation resolves breathe after each service', () => {
    const src = fs.readFileSync(path.join(ROOT, 'src/agent/AgentCoreBoot.js'), 'utf8');
    const i = src.indexOf("'worldState',");
    const seg = src.slice(i, i + 400);
    assert(/setImmediate/.test(seg), 'breath inside the eager resolve loop');
  });
  test('breaths never reorder services (sequential loop shape intact)', () => {
    const src = fs.readFileSync(path.join(ROOT, 'src/agent/core/Container.js'), 'utf8');
    const seq = src.slice(src.indexOf('async _bootAllSequential'), src.indexOf('async _bootAllSequential') + 900);
    assert(/const order = this\._topologicalSort\(\)/.test(seq), 'topological order untouched');
    assert(seq.indexOf('_topologicalSort') < seq.indexOf('setImmediate'), 'breath sits inside the ordered loop');
  });
});

describe('v7941r6 — IPC boot gate', () => {
  test('queries wait for boot; streams re-dispatch after boot', () => {
    const main = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8');
    assert(/if \(!_bootDone\) await _bootReady;/.test(main), 'invoke dispatcher gates on boot');
    assert(/_bootReady\.then\(\(\) => ipcMain\.emit\('agent:request-stream'/.test(main), 'early stream re-dispatches after boot');
    const okIdx = main.indexOf("console.log('[KERNEL] Agent booted successfully.')");
    const gateIdx = main.indexOf('_bootReadyResolve(); // r6: open the IPC gate');
    assert(gateIdx > -1 && gateIdx < okIdx, 'gate opens exactly at boot success');
    assert(/_bootReadyResolve\(\); \/\/ r6: never leave the UI waiting forever/.test(main), 'gate also opens on boot error');
  });
});

describe('v7941r6 — boot overlay (U3-light)', () => {
  test('overlay exists, is wired first, never says erwacht, and main removes it', () => {
    const ov = fs.readFileSync(path.join(ROOT, 'src/ui/boot-overlay.js'), 'utf8');
    const html = fs.readFileSync(path.join(ROOT, 'src/ui/index.html'), 'utf8');
    const main = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8');
    assert(!/erwacht/i.test(ov) && !/erwacht/i.test(html), 'no awaken slogan anywhere (contract)');
    assert(/boot-overlay\.js/.test(html), 'overlay script referenced');
    assert(html.indexOf('boot-overlay.js') < html.indexOf('renderers/'), 'overlay loads before the app scripts');
    assert(/__genesisBootComplete/.test(ov) && /__genesisBootComplete/.test(main), 'completion signal wired both sides');
    assert(/__genesisBootFailed/.test(ov) && /__genesisBootFailed/.test(main), 'failure signal wired both sides');
  });
});

describe('v7941r6b — welcome card fires once', () => {
  test('onAgentReady is idempotent (guard before any side effect)', () => {
    const rm = fs.readFileSync(path.join(ROOT, 'src/ui/renderer-main.js'), 'utf8');
    const fn = rm.slice(rm.indexOf('async function onAgentReady'), rm.indexOf('async function onAgentReady') + 500);
    assert(/if \(agentReady\) return;/.test(fn), 'guard exists inside onAgentReady');
    assert(fn.indexOf('if (agentReady) return;') < fn.indexOf('agentReady = true'), 'guard sits before the ready flag flips');
  });
});

run();
