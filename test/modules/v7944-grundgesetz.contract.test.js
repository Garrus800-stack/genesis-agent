#!/usr/bin/env node
// GENESIS — v7.9.44 G: the first-visit constitution, his life cycle.
'use strict';
const { describe, test, assert, assertEqual, run, createTestRoot } = require('../harness');
const path = require('path'); const fs = require('fs');
const ROOT = path.resolve(__dirname,'..','..');
const CB = require(path.join(ROOT,'src/agent/cognitive/CapabilityBook.js'));
const src = (p) => fs.readFileSync(path.join(ROOT,p),'utf8');
describe('v7944 G — entdeckt → angetastet → beschrieben → integriert', () => {
  test('order is law: no skipping to integriert', () => {
    const d = createTestRoot('g-a'); CB.discover(d,{name:'auge'});
    assert(!CB.advance(d,'auge','integriert').ok, 'skip refused');
    assert(CB.advance(d,'auge','angetastet',{probeOp:'list'}).ok, 'next step fine');
  });
  test('P10: probing only behind the safe-name whitelist, refusal speaks', () => {
    assert(CB.probeAllowed('list-tools') && CB.probeAllowed('get-status'), 'safe names pass');
    assert(!CB.probeAllowed('delete-all') && !CB.probeAllowed('write-file'), 'unsafe refused');
  });
  test('his guide becomes a pending SKILL on the house promotion path', () => {
    const d = createTestRoot('g-b');
    const f = CB.writeGuide(d,'auge','Meine Version: so sehe ich.');
    assert(f && f.includes(path.join('koennen','skills-pending')), 'promotion path');
    assert(fs.readFileSync(f,'utf8').includes('meine Kurzanleitung'), 'his text, his frame');
  });
  test('P9 pin: integriert is HIS action — the tool routes it, the journal carries the change sentence', () => {
    const t = src('src/agent/cognitive/tools/v737-memory-tools.js');
    assert(t.includes("'begehung'") && t.includes('Integriert setzt NUR Genesis'), 'sovereignty stated at the tool');
    assert(/integrieren[\s\S]{0,600}journalWriter\.write/.test(t), 'change sentence goes through the real writer');
    assert(t.includes("Registered (v7.9.44): register-work, begehung"), 'registered log counts the new hands');
  });
});
run();
