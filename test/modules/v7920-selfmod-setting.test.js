// ============================================================
// GENESIS — v7920-selfmod-setting.test.js
// Facet S: SELF_MODIFY is 'critical' (so only FULL_AUTONOMY auto-approves);
// security.selfModifyRequiresConfirmation gates the proposal path; a proposal
// is auto-approved ('attempted', no human card) ONLY at full autonomy with
// confirmation off — otherwise it waits for the human ('proposed').
// ============================================================
const { describe, test, assert, assertEqual, run } = require('../harness');
const { TrustLevelSystem, TRUST_LEVELS } = require('../../src/agent/foundation/TrustLevelSystem');
const ProposeImprovements = require('../../src/agent/autonomy/activities/ProposeImprovements');

const bus = { fire() {}, on() { return () => {}; }, emit() {} };
const storage = { readJSON: () => null, writeJSON() {}, writeJSONDebounced() {} };
const tls = (level, settings = null) =>
  new TrustLevelSystem({ bus, storage, settings, config: { level } });
const settingsWith = (v) => ({ get: (k) => (k === 'security.selfModifyRequiresConfirmation' ? v : undefined) });

function fakeIdleMind(trust) {
  return {
    kg: { getNodesByType: (t) => (t === 'insight'
      ? [{ label: 'review: src/x.js', properties: { type: 'agent-loop-analysis', module: 'src/x.js', full: 'Inspect x.js thoroughly' } }]
      : []) },
    lessonsStore: null,
    proposals: [],
    _saveProposals() {},
    _trustLevelSystem: trust,
  };
}

describe('v7920 self-mod setting + trust gate', () => {

  test('SELF_MODIFY is critical: not auto-approved at AUTONOMOUS, approved at FULL_AUTONOMY', () => {
    assertEqual(tls(TRUST_LEVELS.AUTONOMOUS).checkApproval('SELF_MODIFY').approved, false, 'AUTONOMOUS must still ask for self-mod');
    assertEqual(tls(TRUST_LEVELS.FULL_AUTONOMY).checkApproval('SELF_MODIFY').approved, true, 'FULL_AUTONOMY auto-approves self-mod');
    // SHELL_EXEC stays 'high' — auto-approved at AUTONOMOUS (regression guard).
    assertEqual(tls(TRUST_LEVELS.AUTONOMOUS).checkApproval('SHELL_EXEC').approved, true, 'SHELL_EXEC (high) still auto-approved at AUTONOMOUS');
  });

  test('selfModRequiresConfirmation defaults to true and reflects the setting', () => {
    assertEqual(tls(TRUST_LEVELS.FULL_AUTONOMY).selfModRequiresConfirmation(), true, 'default true (no setting)');
    assertEqual(tls(TRUST_LEVELS.FULL_AUTONOMY, settingsWith(true)).selfModRequiresConfirmation(), true, 'true when set true');
    assertEqual(tls(TRUST_LEVELS.FULL_AUTONOMY, settingsWith(false)).selfModRequiresConfirmation(), false, 'false when set false');
  });

  test('guard: confirmation ON keeps proposals human-confirmed even at full autonomy', async () => {
    const im = fakeIdleMind(tls(TRUST_LEVELS.FULL_AUTONOMY, settingsWith(true)));
    await ProposeImprovements.run(im);
    assertEqual(im.proposals[0].status, 'proposed', 'confirmation on -> human decides');
  });

  test('guard: confirmation OFF + full autonomy auto-approves (attempted, no card)', async () => {
    const im = fakeIdleMind(tls(TRUST_LEVELS.FULL_AUTONOMY, settingsWith(false)));
    await ProposeImprovements.run(im);
    assertEqual(im.proposals[0].status, 'attempted', 'off + full autonomy -> auto-approved');
  });

  test('guard: confirmation OFF but only AUTONOMOUS still waits (critical not approved)', async () => {
    const im = fakeIdleMind(tls(TRUST_LEVELS.AUTONOMOUS, settingsWith(false)));
    await ProposeImprovements.run(im);
    assertEqual(im.proposals[0].status, 'proposed', 'critical risk not approved below full autonomy');
  });

  test('guard: no trust system -> safe human-confirmed default', async () => {
    const im = fakeIdleMind(undefined);
    await ProposeImprovements.run(im);
    assertEqual(im.proposals[0].status, 'proposed', 'absent trust system -> proposed');
  });

});

if (require.main === module) run();
