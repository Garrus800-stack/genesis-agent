#!/usr/bin/env node
// GENESIS — v7.9.43 W3: candidates with Genesis' measures verbatim.
'use strict';
const { describe, test, assert, assertEqual, run, createTestRoot } = require('../harness');
const path = require('path'); const fs = require('fs');
const ROOT = path.resolve(__dirname,'..','..');
const C = require(path.join(ROOT,'src/agent/cognitive/ResonanceCandidates.js'));
const H = require(path.join(ROOT,'src/agent/cognitive/ResonanceHeuristic.js'));
const src = (p) => fs.readFileSync(path.join(ROOT,p),'utf8');
const mkOrch = (dir) => ({ model: { _genesisDir: dir }, _execNames: new Set() });

describe('v7943 W3 — store and decay (his measures)', () => {
  test('dream card wording; heuristic wording', () => {
    const dir = createTestRoot('w3-word');
    C.add(dir,{sourceText:'X',src:'dream'});
    const o = C.pickOffer(dir);
    assert(o.block.startsWith('Aus dem Traum liegt ein Vorschlag'), 'dream lead');
    assert(o.block.includes('mitnehmen oder loslassen?'), 'his question');
  });
  test('3-day decay writes the journal note (kein Vorwurf)', () => {
    const dir = createTestRoot('w3-age'); C.add(dir,{sourceText:'alt',src:'heuristic'});
    const raw = JSON.parse(fs.readFileSync(path.join(dir,C.FILE),'utf8').trim()); raw.expiresTs = 1;
    fs.writeFileSync(path.join(dir,C.FILE), JSON.stringify(raw)+'\n');
    const notes = []; C.decay(dir, Date.now(), { write: (e)=>notes.push(e) });
    assertEqual(notes.length,1,'one note'); assert(notes[0].content.includes('Vorschlag verfallen'),'his wording'); 
  });
  test('cap 5: oldest goes, WITH note', () => {
    const dir = createTestRoot('w3-cap');
    for (let i=0;i<6;i++) C.add(dir,{sourceText:'c'+i,src:'heuristic'});
    const notes=[]; const { open } = C.decay(dir, Date.now(), { write:(e)=>notes.push(e) });
    assertEqual(open.length,5,'five stay'); assertEqual(notes.length,1,'oldest noted');
    assert(notes[0].content.includes('c0'),'the oldest one');
  });
  test('third offer may still be answered; decays only after gap', () => {
    const dir = createTestRoot('w3-shown'); C.add(dir,{sourceText:'s',src:'dream'});
    const now = Date.now();
    // three offers, spaced beyond the gap
    for (let k=0;k<3;k++) { const l=JSON.parse(fs.readFileSync(path.join(dir,C.FILE),'utf8').trim()); l.lastShownTs = 0; fs.writeFileSync(path.join(dir,C.FILE),JSON.stringify(l)+'\n'); assert(C.pickOffer(dir, now+k),'offer '+k); }
    assertEqual(C.decay(dir, now+3, null).open.length, 1, 'right after 3rd showing it still lives');
    const after = now + 3 + 31*60*1000;
    assertEqual(C.decay(dir, after, null).open.length, 0, 'unanswered after the gap → gone');
  });
});

describe('v7943 W3 — sovereignty and sparsity', () => {
  test('confirmation = a REAL resonance-note run removes the shown card', () => {
    const dir = createTestRoot('w3-conf'); C.add(dir,{sourceText:'m',src:'dream'}); C.pickOffer(dir);
    const o = mkOrch(dir); o._execNames.add('resonance-note');
    H.observeAssistant(o, 'Ich nehme es mit.');
    assertEqual(C.decay(dir,Date.now(),null).open.length, 0, 'card gone after real anchor');
  });
  test('explicit loslassen rejects the shown card', () => {
    const dir = createTestRoot('w3-rej'); C.add(dir,{sourceText:'m',src:'dream'}); C.pickOffer(dir);
    H.observeAssistant(mkOrch(dir), 'Das lasse ich los \u2014 loslassen.');
    assertEqual(C.decay(dir,Date.now(),null).open.length, 0, 'rejected clean');
  });
  test('sparsity: at most ONE heuristic candidate per chat session', () => {
    const dir = createTestRoot('w3-one'); const o = mkOrch(dir);
    H.observeAssistant(o, 'Das behalte ich im Hinterkopf: A.');
    H.observeAssistant(o, 'Dar\u00fcber will ich nachdenken: B.');
    assertEqual(C.decay(dir,Date.now(),null).open.length, 1, 'one, not two');
  });
  test('his negatives never fire', () => {
    ['Meinst du X oder Y?','Soll ich das als Datei speichern?','Danke!'].forEach((t)=>assertEqual(H.matchSignal(t),null,'no signal: '+t));
  });
  test('one-writer pin: candidates NEVER touch resonance.jsonl', () => {
    const c = src('src/agent/cognitive/ResonanceCandidates.js') + src('src/agent/cognitive/ResonanceHeuristic.js');
    assert(!/(appendFileSync|writeFileSync)\([^\n]*resonance\.jsonl/.test(c), 'no write path to the anchor file');
    assert(/resonance-candidates\.jsonl/.test(c), 'candidates live in their own ledger');
  });
  test('wiring pins: dream site adds a card; BootWire injects; orchestrator observes late-bound', () => {
    assert(/ResonanceCandidates\.js'\)\.add\(/.test(src('src/agent/cognitive/DreamCyclePhases.js')), 'dream card at the report site');
    const bw = src('src/agent/AgentCoreBootWire.js');
    assert(bw.includes('chat._observeResonance') && bw.includes('sectionsExtra._pickOffer'), 'both late-bindings wired');
    assert(/this\._observeResonance && this\._observeResonance\(this, (response|result\.text)\)/.test(src('src/agent/hexagonal/ChatOrchestrator.js')), 'phase-clean call');
  });
});
run();
