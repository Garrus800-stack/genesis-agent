// ============================================================
// TEST — v7.9.40 (B1) Selbst-Spur: Self clock + Ziele/Spur im Gespräch
//   node test/modules/v7940-selbstspur.contract.test.js
// Field 17.07.: "Noch nichts. Ich bin gerade erst aufgewacht" after 3h52m
// awake with 13 idle thoughts and 3 goal runs; PreSleep said "0 Ziele
// offen" while one goal sat blocked. These pins hold the cure.
// ============================================================
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { describe, test, run } = require('../harness');
const ROOT = path.join(__dirname, '..', '..');
function src(rel) { return fs.readFileSync(path.join(ROOT, rel), 'utf-8'); }
const { PromptBuilder } = require('../../src/agent/intelligence/PromptBuilder');
const { GoalStack } = require('../../src/agent/planning/GoalStack');
const { EVENT_STORE_BUS_MAP: EM } = require('../../src/agent/core/EventTypes');

function pb(fields) {
  const p = Object.create(PromptBuilder.prototype);
  p._historyLength = 0; p._query = '';
  p._idleMind = null; p._daemon = null; p._dreamCycle = null;
  p.goalStack = null; p.eventStore = null; p.skills = null;
  return Object.assign(p, fields || {});
}

describe('v7.9.40 B1 — Selbst-Spur', () => {
  test('source pins: autonomy promoted to P2/700 and removed from BOTH trivial gates', () => {
    const t = src('src/agent/intelligence/PromptBuilder.js');
    assert.ok(t.includes("[2, 'autonomy',      700]"));
    const lines = t.split('\n');
    assert.ok(!lines[163].includes("'autonomy'"), 'gate :164 free');
    assert.ok(!lines[374].includes("'autonomy'"), 'gate :375 free');
  });
  test('source pins: goalStack + eventStore late-bindings in the existing manifest block', () => {
    const t = src('src/agent/manifest/phase2-intelligence.js');
    assert.ok(t.includes("prop: 'goalStack', service: 'goalStack'"));
    assert.ok(t.includes("prop: 'eventStore', service: 'eventStore'"));
  });
  test('getOpenGoals: not-terminal without obsolete (heals the PreSleep field finding)', () => {
    const s = Object.create(GoalStack.prototype);
    s.goals = [
      { id: 'a', status: 'active' }, { id: 'b', status: 'paused' },
      { id: 'c', status: 'stalled' }, { id: 'd', status: 'blocked' },
      { id: 'e', status: 'completed' }, { id: 'f', status: 'failed' },
      { id: 'g', status: 'abandoned' }, { id: 'h', status: 'obsolete' },
    ];
    assert.strictEqual(s.getOpenGoals().map(g => g.id).sort().join(','), 'a,b,c,d');
    assert.strictEqual(s.getActiveGoals().length, 1, 'old narrow accessor untouched');
  });
  test('PreSleep counts open goals via the new semantics (source pin with fallback)', () => {
    assert.ok(src('src/agent/cognitive/PreSleep.js')
      .includes('getOpenGoals?.() || this.goalStack?.getActiveGoals?.()'));
  });
  test('awakening (historyLength===0) renders the FULL block: goals, compressed failure, trace', () => {
    const p = pb({
      _historyLength: 0,
      _idleMind: { thoughtCount: 13, getStatus: () => ({ idleSince: 0 }),
        activityLog: [{ activity: 'ideate', timestamp: Date.now() - 12 * 60000 }] },
      goalStack: { getOpenGoals: () => [{
        id: 'g1', description: 'Inspect AgentCoreHealth implementation',
        status: 'blocked', attempts: 3,
        stalledReason: 'Read access blocked: D:\\Genesis Home\\Genesis\\src\\agent\\core\\AgentCoreHealth.js',
        updated: new Date(Date.now() - 41 * 60000).toISOString(),
      }] },
    });
    const out = p._autonomyContext();
    assert.ok(out.includes('Open goals (1):'), out);
    assert.ok(out.includes('[blocked]'));
    assert.ok(/failed 3\u00d7, last: Read access blocked/.test(out));
    assert.ok(out.includes('last worked 41m ago'));
    assert.ok(out.includes('Last idle trace: ideate (12m ago)'));
    assert.ok(out.length <= 700, 'budget: ' + out.length);
  });
  test('mid-conversation without ask: EXISTING behaviour unchanged (fresh idle → empty)', () => {
    const p = pb({
      _historyLength: 5,
      _idleMind: { thoughtCount: 0, getStatus: () => ({ idleSince: 10000 }), activityLog: [] },
      goalStack: { getOpenGoals: () => [{ id: 'x', description: 'y', status: 'active' }] },
    });
    assert.strictEqual(p._autonomyContext(), '');
  });
  test('explicit ask ("was hatte ich vor") renders the FULL block mid-conversation', () => {
    const p = pb({
      _historyLength: 5, _query: 'sag mal, was hatte ich vor?',
      _idleMind: { thoughtCount: 2, getStatus: () => ({ idleSince: 5000 }),
        activityLog: [{ activity: 'research', timestamp: Date.now() - 3 * 60000 }] },
      goalStack: { getOpenGoals: () => [{ id: 'g2', description: 'Compare GoalDriver policies', status: 'active', attempts: 1, updated: new Date().toISOString() }] },
    });
    const out = p._autonomyContext();
    assert.ok(out.includes('Open goals (1):') && out.includes('Compare GoalDriver'), out);
    assert.ok(!/failed/.test(out), 'attempts=1: no failure compression');
  });
  test('self clock: awake · thoughts · goal runs · last dream — from live holders', () => {
    const p = pb({
      _idleMind: { thoughtCount: 14 },
      eventStore: { query: () => [
        { type: EM.AGENT_LOOP_STARTED.store }, { type: EM.AGENT_LOOP_STARTED.store },
        { type: EM.AGENT_LOOP_STARTED.bus }, { type: 'something:else' },
      ] },
      _dreamCycle: { getTimeSinceLastDream: () => 41 * 60000 },
    });
    const line = p._selfClockLine();
    assert.ok(/Self clock: awake \d/.test(line), line);
    assert.ok(line.includes('14 idle thoughts'));
    assert.ok(line.includes('3 goal runs'));
    assert.ok(line.includes('last dream 41m ago'));
    assert.ok(!/mood|energy|feel/i.test(line), 'no mood — "sie muss wahr sein"');
  });
  test('self clock omits over guessing: missing holders drop their segments', () => {
    const line = pb({})._selfClockLine();
    assert.ok(line.includes('awake '));
    assert.ok(!line.includes('goal runs') && !line.includes('dream') && !line.includes('thoughts'), line);
  });
  test('self clock is wired as the FIRST verified fact in introspection (source pin)', () => {
    const t = src('src/agent/intelligence/PromptBuilderSectionsExtra.js');
    assert.ok(t.includes('the self clock is the FIRST verified fact'));
    assert.ok(t.indexOf('_selfClockLine') < t.indexOf('SelfModel: module counts'));
    assert.ok(t.includes('EVENT_STORE_BUS_MAP: EM'));
  });
});
if (require.main === module) run();
