// ============================================================
// GENESIS — v7920-plan-refine.test.js
// Facet E: the bound second look sharpens a draft goal title ONLY on a
// genuine, valid, same-verb, path-clean improvement; any error or
// non-improvement leaves the original draft untouched (never blocks).
// ============================================================
const { describe, test, assert, assertEqual, run } = require('../harness');
const { refineGoalDraft } = require('../../src/agent/autonomy/activities/plan-refine');
const { READONLY_VERBS } = require('../../src/agent/core/goal-intent');

const modelReturning = (line) => ({ chat: async () => line });
const base = { allowedVerbs: READONLY_VERBS };

describe('v7920 plan-refine', () => {

  test('adopts a genuine, sharper, same-verb improvement', async () => {
    const out = await refineGoalDraft({
      title: 'Document the bus', model: modelReturning('TITLE: Document the EventBus contract'), ...base,
    });
    assertEqual(out, 'Document the EventBus contract', 'sharper same-verb title adopted');
  });

  test('rejects a different leading verb (no silent intent drift)', async () => {
    const out = await refineGoalDraft({
      title: 'Document the bus', model: modelReturning('TITLE: Refactor the EventBus'), ...base,
    });
    assertEqual(out, 'Document the bus', 'verb change rejected, draft kept');
  });

  test('rejects a verb outside the read-only whitelist', async () => {
    const out = await refineGoalDraft({
      title: 'Implement the bus', model: modelReturning('TITLE: Implement the EventBus fully'), ...base,
    });
    assertEqual(out, 'Implement the bus', 'non-whitelisted verb rejected');
  });

  test('rejects an invented file path', async () => {
    const out = await refineGoalDraft({
      title: 'Document the bus',
      model: modelReturning('TITLE: Document src/agent/core/Nope.js internals'),
      hasHallucinatedPaths: (t) => (/Nope\.js/.test(t) ? 'src/agent/core/Nope.js' : false),
      ...base,
    });
    assertEqual(out, 'Document the bus', 'invented path rejected');
  });

  test('keeps the draft when the model repeats it unchanged', async () => {
    const out = await refineGoalDraft({
      title: 'Document the EventBus', model: modelReturning('TITLE: Document the EventBus'), ...base,
    });
    assertEqual(out, 'Document the EventBus', 'no-op refinement keeps draft');
  });

  test('never blocks: a throwing model returns the original draft', async () => {
    const out = await refineGoalDraft({
      title: 'Document the bus', model: { chat: async () => { throw new Error('model down'); } }, ...base,
    });
    assertEqual(out, 'Document the bus', 'error leaves draft untouched');
  });

  test('no model -> original draft (defensive)', async () => {
    assertEqual(await refineGoalDraft({ title: 'Document the bus', ...base }), 'Document the bus', 'missing model safe');
  });

});

if (require.main === module) run();
