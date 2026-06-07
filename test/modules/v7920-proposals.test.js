// ============================================================
// GENESIS — v7920-proposals.test.js
// Facet D: agent-loop-analysis insights -> improvement proposals (pure),
// with dedup, dismissed-cooldown, and the facet-O harm filter; plus the
// list / accept / reject lifecycle of the CommandHandlersProposals mixin.
// ============================================================
const { describe, test, assert, assertEqual, run } = require('../harness');
const { buildProposals } = require('../../src/agent/autonomy/activities/improvement-proposals');
const { commandHandlersProposals } = require('../../src/agent/hexagonal/CommandHandlersProposals');

const insight = (module, full) => ({ type: 'agent-loop-analysis', module, full });

describe('v7920 improvement proposals', () => {

  test('an insight becomes a proposal', () => {
    const out = buildProposals([insight('src/a.js', 'Add input validation to a.js')]);
    assertEqual(out.length, 1, 'one proposal built');
    assertEqual(out[0].status, 'proposed', 'status proposed');
    assertEqual(out[0].file, 'src/a.js', 'file carried');
  });

  test('dedup vs an existing proposed/attempted proposal', () => {
    const first = buildProposals([insight('src/a.js', 'Add input validation to a.js')]);
    const again = buildProposals([insight('src/a.js', 'Add input validation to a.js')], { existing: first });
    assertEqual(again.length, 0, 'same insight not re-proposed while live');
  });

  test('dismissed-cooldown dedup: blocked within cooldown, allowed after', () => {
    const now = 1_000_000_000_000;
    const dismissed = [{ key: 'src/a.js::add input validation to a.js', status: 'dismissed', cooldownUntil: now + 1000 }];
    const within = buildProposals([insight('src/a.js', 'Add input validation to a.js')], { existing: dismissed, now });
    assertEqual(within.length, 0, 'blocked while cooldown active');
    const after = buildProposals([insight('src/a.js', 'Add input validation to a.js')], { existing: dismissed, now: now + 2000 });
    assertEqual(after.length, 1, 're-proposable once cooldown expires');
  });

  test('facet-O harm filter: never propose touching a flagged file', () => {
    const out = buildProposals([insight('src/harmed.js', 'Refactor harmed.js')], { harmedFiles: ['src/harmed.js'] });
    assertEqual(out.length, 0, 'harmed file excluded');
  });

  test('respects the max cap', () => {
    const many = Array.from({ length: 10 }, (_, i) => insight(`src/f${i}.js`, `Inspect f${i}.js thoroughly`));
    assertEqual(buildProposals(many, { max: 3 }).length, 3, 'capped at max');
  });

  test('lifecycle: list -> accept -> reject via the mixin', async () => {
    let saved = 0;
    const ctx = {
      lang: { t: (k) => k },
      idleMind: {
        proposals: [
          { id: 'prop_1', key: 'k1', title: 'Document EventBus', file: 'src/bus.js', status: 'proposed' },
          { id: 'prop_2', key: 'k2', title: 'Map retries', file: null, status: 'proposed' },
        ],
        _saveProposals() { saved++; },
      },
    };
    const listing = await commandHandlersProposals.listProposals.call(ctx);
    assert(listing.includes('prop_1') && listing.includes('prop_2'), 'open proposals listed');

    const accepted = await commandHandlersProposals._acceptProposal.call(ctx, 'prop_1');
    assertEqual(accepted.status, 'attempted', 'accepted -> attempted');

    const rejected = await commandHandlersProposals._rejectProposal.call(ctx, 'prop_2');
    assertEqual(rejected.status, 'dismissed', 'rejected -> dismissed');
    assert(rejected.cooldownUntil > Date.now(), 'cooldown set on rejection');

    assert(saved >= 2, 'persistence invoked on each decision');
    const listing2 = await commandHandlersProposals.listProposals.call(ctx);
    assert(!listing2.includes('prop_1') && !listing2.includes('prop_2'), 'no longer open after decisions');
  });

  test('unknown id -> null (no throw)', async () => {
    const ctx = { idleMind: { proposals: [], _saveProposals() {} } };
    assertEqual(await commandHandlersProposals._acceptProposal.call(ctx, 'nope'), null, 'accept unknown safe');
    assertEqual(await commandHandlersProposals._rejectProposal.call(ctx, 'nope'), null, 'reject unknown safe');
  });

});

if (require.main === module) run();
