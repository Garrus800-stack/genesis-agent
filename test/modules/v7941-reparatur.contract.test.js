// ============================================================
// TEST — v7.9.41 (F) Reparaturen: DU-Form-Nachfrage, Fakten-Direktiven,
//        lastError am STEP-DIAG-Punkt
//   node test/modules/v7941-reparatur.contract.test.js
// Field 18.07.: "na, was hast du so gemacht?" never fired the ask tier
// (ich-form-only pattern); the model claimed idleness while the Autonomy
// Report with the exact counters sat in its context; archive.json carried
// abandoned goals with no outcome (checkpoints exist only for successes).
// ============================================================
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { describe, test, run } = require('../harness');
const ROOT = path.join(__dirname, '..', '..');
function src(rel) { return fs.readFileSync(path.join(ROOT, rel), 'utf-8'); }
const { PromptBuilder } = require('../../src/agent/intelligence/PromptBuilder');

function pb(fields) {
  const p = Object.create(PromptBuilder.prototype);
  p._historyLength = 5; p._query = '';
  p._idleMind = { thoughtCount: 2, getStatus: () => ({ idleSince: 5000 }),
    activityLog: [{ activity: 'ideate', timestamp: Date.now() - 3 * 60000 }] };
  p._daemon = null; p._dreamCycle = null;
  p.goalStack = { getOpenGoals: () => [{ id: 'g1', description: 'Inspect X', status: 'active', attempts: 1, updated: new Date().toISOString() }] };
  p.eventStore = null; p.skills = null;
  return Object.assign(p, fields || {});
}

describe('v7.9.41 F — Reparaturen', () => {
  test('F1: every DU-form of Daniels question fires the full block mid-conversation', () => {
    const forms = [
      'na, was hast du so gemacht?', 'was hast du gemacht', 'was hast du getan?',
      'was hast du gedacht', 'woran hast du gearbeitet?', 'was hast du im idle gemacht',
      'what did you do?', 'what have you been doing', 'what have you been working on',
    ];
    for (const q of forms) {
      const out = pb({ _query: q })._autonomyContext();
      assert.ok(out.includes('Open goals (1):'), `"${q}" must fire the full block, got: ${out.slice(0, 60)}`);
    }
  });
  test('F1: unrelated mid-conversation query keeps the existing behaviour', () => {
    const p = pb({ _query: 'wie ist das wetter?' });
    p._idleMind = { thoughtCount: 0, getStatus: () => ({ idleSince: 10000 }), activityLog: [] };
    assert.strictEqual(p._autonomyContext(), '');
  });
  test('F2: all three fact directives are pinned (rules line, report head, introspection head)', () => {
    const aw = src('src/agent/intelligence/PromptBuilderSectionsAwareness.js');
    assert.ok(aw.includes('answer FROM those lines; never claim you were idle'), 'sharpened rules line');
    assert.ok(aw.includes('never deny activity they show'), 'report head fact sentence');
    const ex = src('src/agent/intelligence/PromptBuilderSectionsExtra.js');
    assert.ok(ex.includes('never deny activity these facts show'), 'introspection head');
  });
  test('F2: report head sentence renders inside the built section', () => {
    const p = pb({ _historyLength: 0 });
    const out = p._autonomyContext();
    assert.ok(out.includes('Measured facts. If asked what you did'), out.slice(0, 200));
  });
  test('F3: Pursuit sets goal.lastError at the STEP-DIAG site (source pin)', () => {
    const t = src('src/agent/revolution/AgentLoopPursuit.js');
    assert.ok(t.includes('v7.9.41 (F3): step error ON the goal'), 'merged one-liner form (LOC guard)');
    assert.ok(t.indexOf('_g.lastError = String(result.error).slice(0, 500)') > t.indexOf('[STEP-DIAG]'));
  });
  test('F3: the dead .40 archive-side pull is REMOVED', () => {
    const t = src('src/agent/planning/GoalPersistence.js');
    assert.ok(!t.includes('v7.9.40 (B0): preserve'), 'dead pull gone');
    assert.ok(!t.includes('_stepCheckpoints.get(goalId)') || !t.includes('_fromList'), 'no stub-shaped remnant');
  });
  test('F3: outcome chain picks lastError up on archive (real form)', async () => {
    const { GoalPersistence } = require('../../src/agent/planning/GoalPersistence');
    const gp = Object.create(GoalPersistence.prototype);
    const goal = { id: 'g9', status: 'active', description: 'x',
      lastError: '[STEP-DIAG] Step 2 "CODE" failed \u2192 error: Verification failed: Unexpected token (1:5)' };
    gp._activeGoals = [goal]; gp._archive = []; gp._stats = { goalsArchived: 0 };
    gp._stepCheckpoints = new Map();
    gp.storage = { writeJSON: async () => {}, delete: async () => {} };
    await gp._archiveGoal('g9', 'abandoned');
    assert.ok(goal.outcome && goal.outcome.includes('Unexpected token (1:5)'), 'outcome: ' + goal.outcome);
  });
});
if (require.main === module) run();
