// ============================================================
// v7.9.27 #6 — capability-gap fires only on real limits.
//
// LearningService._detectCapabilityGap fired on any phrase of inability,
// including subjective ones ("I can't say which feels better"), and
// pushed each to the daemon as a skill to build. It now fires only on
// real limits — access / tool / execution / the current environment —
// and never when the user's message was itself subjective.
// ============================================================

'use strict';

const path = require('path');
const { describe, test, run, assert } = require('../harness');

const ROOT = path.join(__dirname, '../..');
const { LearningService } = require(path.join(ROOT, 'src/agent/hexagonal/LearningService'));

function make() {
  const fired = [];
  const bus = { fire: (ev, data) => fired.push({ ev, data }), on: () => {} };
  const ls = new LearningService({
    bus, memory: null, knowledgeGraph: null,
    eventStore: null, storageDir: null, intervals: null, storage: null,
  });
  const gapFired = () => fired.some(f => f.ev === 'learning:capability-gap');
  return { ls, gapFired };
}

describe('v7.9.27 #6 — capability-gap gate', () => {
  test('a real access limit fires', () => {
    const { ls, gapFired } = make();
    ls._detectCapabilityGap('kannst du die datei loeschen', 'Ich habe keinen Zugriff auf das Dateisystem.');
    assert(gapFired(), 'access limit must fire');
  });

  test('a real execution limit fires', () => {
    const { ls, gapFired } = make();
    ls._detectCapabilityGap('fuehre das script aus', 'I am unable to execute shell commands here.');
    assert(gapFired(), 'execution limit must fire');
  });

  test('a capability phrase with a SUBJECTIVE message does not fire', () => {
    const { ls, gapFired } = make();
    // response contains a real capability phrase, but the user asked something subjective
    ls._detectCapabilityGap('was bevorzugst du, rot oder blau', 'Ich habe keinen Zugriff auf eine Praeferenz.');
    assert(!gapFired(), 'subjective message must suppress the gap even with a capability phrase');
  });

  test('a subjective inability (no real limit) does not fire', () => {
    const { ls, gapFired } = make();
    ls._detectCapabilityGap('erzaehl mir einen witz', 'Ich kann nicht sagen, was lustig ist.');
    assert(!gapFired(), 'a plain "kann nicht sagen" is not a capability gap');
  });

  test('an opinion question does not fire', () => {
    const { ls, gapFired } = make();
    ls._detectCapabilityGap('was denkst du ueber diese architektur', 'Ich habe keine starke Meinung dazu.');
    assert(!gapFired(), 'opinion question must not fire');
  });
});

if (require.main === module) run();
