// ============================================================
// TEST — v7.9.41 (B2) Der Traum fährt: Genesis' Kadenz 20/60,
//        eine Uhr, dominanter Overdue-Score, Früchte im Block
//   node test/modules/v7941-traum.contract.test.js
// Field 18.07.: four idle hours, ZERO dreams — the old gate
// (30min AND >=4, 6h fallback) never fired at real episode counts.
// ============================================================
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { describe, test, run } = require('../harness');
const ROOT = path.join(__dirname, '..', '..');
function src(rel) { return fs.readFileSync(path.join(ROOT, rel), 'utf-8'); }
const dream = require('../../src/agent/autonomy/activities/Dream');
const { PromptBuilder } = require('../../src/agent/intelligence/PromptBuilder');

function ctx(ageMin, unprocessed) {
  return { snap: { dreamAge: ageMin * 60 * 1000, dreamUnprocessed: unprocessed, genomeTraits: {}, memoryPressure: null } };
}

describe('v7.9.41 B2 — Traum-Kadenz', () => {
  test('never twice within 20 minutes (hard floor)', () => {
    assert.strictEqual(dream.shouldTrigger(ctx(10, 99)), 0);
    assert.strictEqual(dream.shouldTrigger(ctx(19, 99)), 0);
  });
  test('20-60 min window keeps the v7.9.23 material gate (>=4)', () => {
    assert.strictEqual(dream.shouldTrigger(ctx(30, 2)), 0, 'little material → wait');
    assert.ok(dream.shouldTrigger(ctx(30, 5)) > 0, 'enough material → eligible');
    assert.ok(dream.shouldTrigger(ctx(30, 5)) < 10, 'normal score, not the overdue boost');
  });
  test('after 60 min with ANY material the dream is DUE and dominates (10.0)', () => {
    assert.strictEqual(dream.shouldTrigger(ctx(61, 1)), 10.0);
    assert.strictEqual(dream.shouldTrigger(ctx(240, 1)), 10.0, 'the field case: hours idle, one episode');
  });
  test('no material at all → honest zero even when overdue', () => {
    assert.strictEqual(dream.shouldTrigger(ctx(120, 0)), 0);
  });
  test('ONE clock: DreamCycle default harmonised to 20 min (source pin)', () => {
    const t = src('src/agent/cognitive/DreamCycle.js');
    assert.ok(t.includes("20 * 60"), 'default at 20');
    assert.ok(t.includes('no second clock'), 'documented');
  });
  test('karenz stays the idle gate (source pin, unchanged)', () => {
    // v7.9.41 r4: pin by CONTENT, not line number — the r4 comment block above shifted lines; the gate itself is unchanged.
    const _t = src('src/agent/autonomy/IdleMind.js');
    assert.ok(_t.includes('idleTime >= this.idleThreshold'), 'karenz gate untouched');
  });
  test('dream fruits render in the full block from Layer-2 episodes only', () => {
    const p = Object.create(PromptBuilder.prototype);
    p._historyLength = 0; p._query = '';
    p._idleMind = { thoughtCount: 3, getStatus: () => ({ idleSince: 0 }), activityLog: [] };
    p._daemon = null; p._dreamCycle = null; p.eventStore = null; p.skills = null;
    p.goalStack = { getOpenGoals: () => [] };
    p.episodicMemory = { getRecent: () => [
      { layer: 1, topic: 'raw detail episode', timestampMs: Date.now() },
      { layer: 2, topic: 'Genesis prefers verified time anchors over guesses', timestampMs: Date.now() },
      { layer: 2, topic: 'Repeated CODE failures share one verifier root', timestampMs: Date.now() },
    ] };
    const out = p._autonomyContext();
    assert.ok(out.includes('Dream fruits (2):'), out);
    assert.ok(out.includes('verified time anchors'), 'fruit 1');
    assert.ok(!out.includes('raw detail episode'), 'Layer-1 stays out');
  });
  test('cadence head documentation matches the build (source pin)', () => {
    const t = src('src/agent/autonomy/activities/Dream.js');
    assert.ok(t.includes("never twice within 20 min"), 'head updated');
    assert.ok(!t.includes('unprocessed >= 10.'), 'stale head line gone');
  });
});
if (require.main === module) run();
