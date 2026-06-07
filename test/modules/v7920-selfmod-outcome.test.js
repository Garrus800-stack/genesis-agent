// ============================================================
// GENESIS — v7920-selfmod-outcome.test.js
// Facet O: SelfModOutcomeTracker records a 'self-modification' lesson when a
// file churns past the threshold within the window, never rolls anything
// back, and unsubscribes cleanly. Cross-checks that the lesson it records is
// exactly what makes facet D skip that file.
// ============================================================
const { describe, test, assert, assertEqual, run } = require('../harness');
const { SelfModOutcomeTracker } = require('../../src/agent/cognitive/SelfModOutcomeTracker');
const { createBus } = require('../../src/agent/core/EventBus');
const { buildProposals } = require('../../src/agent/autonomy/activities/improvement-proposals');

function recordingStore() {
  const recorded = [];
  return { recorded, record: (l) => { recorded.push(l); return 'id'; }, recall: () => recorded };
}
const DAY = 86400000;

describe('v7920 self-mod outcome tracker', () => {

  test('churn past threshold records exactly one self-modification lesson', () => {
    const store = recordingStore();
    const t = new SelfModOutcomeTracker({ bus: null, lessonsStore: store });
    const now = 1_700_000_000_000;
    t._record({ file: 'src/a.js' }, now);
    t._record({ file: 'src/a.js' }, now + DAY);
    assertEqual(store.recorded.length, 0, 'below threshold: no lesson yet');
    t._record({ file: 'src/a.js' }, now + 2 * DAY);
    assertEqual(store.recorded.length, 1, 'threshold reached: one lesson');
    const lesson = store.recorded[0];
    assertEqual(lesson.category, 'self-modification', 'right category');
    assertEqual(lesson.strategy.file, 'src/a.js', 'flags the churning file');
  });

  test('does not record twice for the same file (dedup via _flagged)', () => {
    const store = recordingStore();
    const t = new SelfModOutcomeTracker({ bus: null, lessonsStore: store });
    const now = 1_700_000_000_000;
    for (let i = 0; i < 5; i++) t._record({ file: 'src/a.js' }, now + i * DAY);
    assertEqual(store.recorded.length, 1, 'only one lesson despite continued churn');
  });

  test('window pruning: changes older than the window do not count', () => {
    const store = recordingStore();
    const t = new SelfModOutcomeTracker({ bus: null, lessonsStore: store });
    const now = 1_700_000_000_000;
    t._record({ file: 'src/a.js' }, now);            // will age out
    t._record({ file: 'src/a.js' }, now + 1 * DAY);  // will age out
    t._record({ file: 'src/a.js' }, now + 30 * DAY); // only this is in-window relative to next
    assertEqual(store.recorded.length, 0, 'aged-out changes do not reach the threshold');
  });

  test('no autonomous rollback surface exists', () => {
    const t = new SelfModOutcomeTracker({ bus: null, lessonsStore: recordingStore() });
    assertEqual(typeof t.rollback, 'undefined', 'tracker exposes no rollback');
    assertEqual(typeof t.revert, 'undefined', 'tracker exposes no revert');
  });

  test('start() subscribes to selfmod:success; stop() unsubscribes', () => {
    const bus = createBus();
    const store = recordingStore();
    const t = new SelfModOutcomeTracker({ bus, lessonsStore: store, config: { churnThreshold: 1 } });
    t.start();
    bus.fire('selfmod:success', { file: 'src/live.js' }, { source: 'test' });
    assertEqual(store.recorded.length, 1, 'a fired event reached the tracker');
    t.stop();
    bus.fire('selfmod:success', { file: 'src/live.js' }, { source: 'test' });
    assertEqual(store.recorded.length, 1, 'no further records after stop()');
  });

  test('cross-check with D: a flagged file is excluded from proposals', () => {
    const store = recordingStore();
    const t = new SelfModOutcomeTracker({ bus: null, lessonsStore: store, config: { churnThreshold: 1 } });
    t._record({ file: 'src/churning.js' }, Date.now());
    const harmedFiles = store.recorded.map(l => l.strategy.file);
    const proposals = buildProposals(
      [{ type: 'agent-loop-analysis', module: 'src/churning.js', full: 'Refactor churning.js' }],
      { harmedFiles });
    assertEqual(proposals.length, 0, 'the file O flagged is never re-proposed by D');
  });

});

if (require.main === module) run();
