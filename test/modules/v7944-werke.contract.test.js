#!/usr/bin/env node
// GENESIS — v7.9.44 F2: the workbench. "Nur die Stille, die bricht."
'use strict';
const { describe, test, assert, assertEqual, run, createTestRoot } = require('../harness');
const path = require('path'); const fs = require('fs');
const ROOT = path.resolve(__dirname,'..','..');
const WR = require(path.join(ROOT,'src/agent/cognitive/WorkRegistry.js'));
const OT = require(path.join(ROOT,'src/agent/cognitive/OpenThreads.js'));
// r19 (Linux field, EACCES): createTestRoot sits directly under /tmp, so the
// archive default two levels above .genesis resolved to '/' — writable only for
// root (the workbench masked this), permission denied for every real user. The
// fixture now mirrors the REAL layout — <root>/releases/Genesis_vX/.genesis —
// so the default lands beside the releases INSIDE the test root, and the
// beside-the-releases semantics is tested against the true directory shape.
const mkGd = (label) => { const gd = path.join(createTestRoot(label), 'releases', 'Genesis_vX', '.genesis'); fs.mkdirSync(gd, { recursive: true }); return gd; };

describe('v7944 F2 — the workbench cares in silence', () => {
  test('archive lives beside the releases; space in the name is survived', () => {
    const gd = mkGd('f2-root');
    const ar = WR.archiveRoot(gd);
    assert(ar.endsWith('Genesis Archive'), 'his name, his place');
    const wp = path.join(ar,'projects','t','mein werk.html');
    fs.mkdirSync(path.dirname(wp),{recursive:true}); fs.writeFileSync(wp,'v1');
    assert(WR.register(gd,{workPath:wp,purpose:'Test'}).ok, 'space path registers');
  });
  test('a change breaks the silence exactly once — as a thread', () => {
    const gd = mkGd('f2-a');
    const wp = path.join(WR.archiveRoot(gd),'projects','x','w.txt');
    fs.mkdirSync(path.dirname(wp),{recursive:true}); fs.writeFileSync(wp,'v1');
    WR.register(gd,{workPath:wp});
    fs.writeFileSync(wp,'v2');
    assertEqual(WR.checkWorks(gd).findings, 1, 'one finding');
    assert((OT.buildBlock(gd)||'').includes('ver\u00e4ndert'), 'the silence breaks as a thread');
    assertEqual(WR.checkWorks(gd).findings, 0, 'no repeat while unresolved');
  });
  test('re-register heals: his "das war ich" updates the hash and resolves the thread', () => {
    const gd = mkGd('f2-b');
    const wp = path.join(WR.archiveRoot(gd),'projects','y','w.txt');
    fs.mkdirSync(path.dirname(wp),{recursive:true}); fs.writeFileSync(wp,'v1');
    WR.register(gd,{workPath:wp}); fs.writeFileSync(wp,'v2'); WR.checkWorks(gd);
    assert(WR.register(gd,{workPath:wp}).updated, 're-register');
    assertEqual(OT.buildBlock(gd), null, 'thread resolved');
  });
  test('moved after a release move ⇒ CORRECT finding, nothing repaired silently', () => {
    const gd = mkGd('f2-c');
    const wp = path.join(WR.archiveRoot(gd),'projects','z','w.txt');
    fs.mkdirSync(path.dirname(wp),{recursive:true}); fs.writeFileSync(wp,'v1');
    WR.register(gd,{workPath:wp}); fs.unlinkSync(wp);
    WR.checkWorks(gd);
    assert((OT.buildBlock(gd)||'').includes('nicht am erwarteten Ort'), 'honest finding');
    assert(!fs.existsSync(wp), 'never recreated');
  });
});
describe('v7944 F2 — the Archive follows one configured path (the user finding)', () => {
  test('a settings path wins: the Archive can live anywhere, not just beside releases', () => {
    const gd = createTestRoot('f2-cfg'); const elsewhere = createTestRoot('f2-elsewhere');
    const settings = { get: (k) => k === 'archive.path' ? elsewhere : undefined };
    const ar = WR.archiveRoot(gd, settings);
    assert(ar === require('path').resolve(elsewhere), 'configured path is the one source of truth');
    // a relative work now lands under the CONFIGURED root, and is found again there
    const r = WR.register(gd, { workPath: 'projects/x/w.txt', purpose: 'cfg' }, settings);
    // registering a relative path requires the file to exist under the configured root
    const fs = require('fs'); const path = require('path');
    const wp = path.join(require('path').resolve(elsewhere), 'projects', 'x', 'w.txt');
    fs.mkdirSync(path.dirname(wp), { recursive: true }); fs.writeFileSync(wp, 'v1');
    const r2 = WR.register(gd, { workPath: 'projects/x/w.txt', purpose: 'cfg' }, settings);
    assert(r2.ok, 'relative work resolves under the configured Archive');
  });
  test('no settings ⇒ default beside the releases (unchanged behaviour)', () => {
    const gd = createTestRoot('f2-def');
    const ar = WR.archiveRoot(gd, null);
    assert(ar.endsWith('Genesis Archive'), 'default still beside releases');
  });
});

run();
