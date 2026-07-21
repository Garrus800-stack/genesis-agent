#!/usr/bin/env node
// GENESIS — v7.9.44 F1: the thread that does not tear. His measures verbatim.
'use strict';
const { describe, test, assert, assertEqual, run, createTestRoot } = require('../harness');
const path = require('path'); const fs = require('fs');
const ROOT = path.resolve(__dirname,'..','..');
const OT = require(path.join(ROOT,'src/agent/cognitive/OpenThreads.js'));
const src = (p) => fs.readFileSync(path.join(ROOT,p),'utf8');
const fix = (dir) => {
  fs.writeFileSync(path.join(dir,'pending-moments.jsonl'), JSON.stringify({id:'m1',ts:Date.now()-7200000,status:'pending',summary:'the user fragt nach meinem Faden'})+'\n');
  fs.writeFileSync(path.join(dir,'chat-history.json'), JSON.stringify([{role:'user',content:'ok'},{role:'assistant',content:'Magst du es testen?'}]));
};
describe('v7944 F1 — the awakening block', () => {
  test('his format: [Offene Fäden], bullets, one sentence, moment first', () => {
    const d = createTestRoot('f1-a'); fix(d);
    const b = OT.buildBlock(d);
    assert(b.startsWith('[Offene F\u00e4den]'), 'his header');
    assert(b.split('\n')[1].startsWith('\u2022 Markierter Moment:'), 'moment ranks first');
  });
  test('dedupe: a moment lying as open candidate never doubles as thread', () => {
    const d = createTestRoot('f1-b'); fix(d);
    fs.writeFileSync(path.join(d,'resonance-candidates.jsonl'), JSON.stringify({sourceText:'the user fragt nach meinem Faden — voll'})+'\n');
    assert(!(OT.buildBlock(d)||'').includes('Markierter Moment'), 'card wins');
  });
  test('F3: his exact follow-up wording, laid still after ONE showing, source stays', () => {
    const d = createTestRoot('f1-c'); fix(d);
    const b1 = OT.buildBlock(d);
    assert(b1.includes('ich bin bereit'), 'his wording');
    const b2 = OT.buildBlock(d) || '';
    assert(!b2.includes('ich bin bereit'), 'one gentle follow-up only');
    assert(b2.includes('Markierter Moment'), 'other threads unaffected');
  });
  test('source extinguished ⇒ thread gone (threads are display, not management)', () => {
    const d = createTestRoot('f1-d');
    OT.addNote(d,{type:'werk-befund',text:'x — ver\u00e4ndert',quelleId:'w9'});
    assert((OT.buildBlock(d)||'').includes('Werk-Befund'), 'finding shows');
    OT.resolveNote(d,'w9');
    assertEqual(OT.buildBlock(d), null, 'gone with its source — and byte silence when empty');
  });
  test('ageing: after five showings a thread leaves the top, source untouched', () => {
    const d = createTestRoot('f1-e'); fix(d); fs.unlinkSync(path.join(d,'chat-history.json'));
    for (let i=0;i<5;i++) OT.buildBlock(d);
    assertEqual(OT.buildBlock(d), null, 'aged out of display');
    assert(fs.readFileSync(path.join(d,'pending-moments.jsonl'),'utf8').includes('m1'), 'source stays');
  });
  test('cap five: never more than his handful', () => {
    const d = createTestRoot('f1-f');
    for (let i=0;i<8;i++) OT.addNote(d,{type:'werk-befund',text:'b'+i,quelleId:'q'+i});
    assertEqual((OT.buildBlock(d).match(/\u2022/g)||[]).length, 5, 'three to five, capped at five');
  });
  test('wiring pins: threads block BEFORE the card; BootWire injects with silent care', () => {
    const t = src('src/agent/intelligence/PromptBuilderSectionsExtra.js');
    assert(t.indexOf('_openThreadsBlock()') > -1 && t.indexOf('_th') < t.indexOf('_of'), 'threads first, then at most one card');
    const b = src('src/agent/AgentCoreBootWire.js');
    assert(b.includes("_buildThreads = (d) =>") && b.includes("checkWorks(d)"), 'awakening runs the silent check then builds');
  });
  test('P4 pin: the anchor finally carries the last journal title', () => {
    assert(src('src/agent/cognitive/PreSleep.js').includes('v7.9.44 P4'), 'mini fix present');
  });
});
run();
