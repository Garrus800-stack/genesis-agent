// ============================================================
// GENESIS — GoalStackPending.test.js (v7.5.1)
// Tests for the extracted pending-goals (negotiate-before-add)
// delegate. The five public methods plus _sweepExpiredPending
// live in GoalStackPending.js since v7.5.1; the original
// confirmPending/revisePending/dismissPending behaviours are
// covered by v737-pending-moments.test.js + v750-fix.test.js,
// this file adds direct coverage of the split-out module so
// the architectural-fitness Test Coverage Gaps check passes.
// ============================================================

'use strict';

const { describe, test, assert, assertEqual, run } = require('../harness');
const { GoalStack } = require('../../src/agent/planning/GoalStack');

function makeGS() {
  const events = [];
  const gs = new GoalStack({
    lang: { t: (k, v) => v ? `${k}: ${JSON.stringify(v)}` : k },
    bus: { emit(e, d) { events.push({ e, d }); }, fire() {}, on() {} },
    model: { chat: async () => 'think: do' },
    prompts: {},
    storage: null,
  });
  gs._events = events;
  return gs;
}

describe('GoalStackPending — proposePending', () => {
  test('returns pendingId for valid description', () => {
    const gs = makeGS();
    const id = gs.proposePending('lerne Rust');
    assert(typeof id === 'string' && id.startsWith('pending_'), 'id format');
    assertEqual(gs.pendingGoals.size, 1);
  });

  test('returns null for empty / too short description', () => {
    const gs = makeGS();
    assert(gs.proposePending('') === null);
    assert(gs.proposePending(null) === null);
    assert(gs.proposePending('a') === null);
    assertEqual(gs.pendingGoals.size, 0);
  });

  test('emits goal:proposed event', () => {
    const gs = makeGS();
    gs.proposePending('lerne Go');
    const proposed = gs._events.find(e => e.e === 'goal:proposed');
    assert(proposed, 'goal:proposed must fire');
    assertEqual(proposed.d.description, 'lerne Go');
  });

  test('v7.5.1: dedupe — identical description refreshes existing entry', () => {
    const gs = makeGS();
    const id1 = gs.proposePending('lerne Rust');
    const id2 = gs.proposePending('lerne Rust');
    assertEqual(id1, id2, 'duplicate returns existing id');
    assertEqual(gs.pendingGoals.size, 1, 'only one pending entry');
  });

  test('v7.5.1: dedupe is description-trimmed', () => {
    const gs = makeGS();
    const id1 = gs.proposePending('lerne Rust');
    const id2 = gs.proposePending('  lerne Rust  ');
    assertEqual(id1, id2);
    assertEqual(gs.pendingGoals.size, 1);
  });

  test('different descriptions get different ids', () => {
    const gs = makeGS();
    const id1 = gs.proposePending('lerne Rust');
    const id2 = gs.proposePending('lerne Go');
    assert(id1 !== id2, 'unique ids');
    assertEqual(gs.pendingGoals.size, 2);
  });
});

describe('GoalStackPending — confirmPending', () => {
  test('returns null for unknown id', async () => {
    const gs = makeGS();
    const r = await gs.confirmPending('pending_unknown');
    assertEqual(r, null);
  });

  test('moves entry to active stack via addGoal, removes from pending', async () => {
    const gs = makeGS();
    const id = gs.proposePending('lerne Rust');
    const goal = await gs.confirmPending(id);
    assert(goal, 'addGoal returned a goal');
    assertEqual(gs.pendingGoals.size, 0, 'pending entry removed');
    const confirmed = gs._events.find(e => e.e === 'goal:negotiation-confirmed');
    assert(confirmed, 'goal:negotiation-confirmed event fired');
  });
});

describe('GoalStackPending — revisePending', () => {
  test('returns false for unknown id', () => {
    const gs = makeGS();
    assertEqual(gs.revisePending('pending_unknown', 'new'), false);
  });

  test('returns false for invalid new description', () => {
    const gs = makeGS();
    const id = gs.proposePending('original');
    assertEqual(gs.revisePending(id, ''), false);
    assertEqual(gs.revisePending(id, null), false);
    assertEqual(gs.revisePending(id, 'a'), false);
    // Original entry unchanged
    assertEqual(gs.pendingGoals.get(id).description, 'original');
  });

  test('updates description and resets TTL on revision', () => {
    const gs = makeGS();
    const id = gs.proposePending('original');
    const before = gs.pendingGoals.get(id).createdAt;
    // Wait 5ms to ensure ts diff
    const target = Date.now() + 5;
    while (Date.now() < target) { /* spin */ }
    const ok = gs.revisePending(id, 'revised version');
    assertEqual(ok, true);
    const after = gs.pendingGoals.get(id);
    assertEqual(after.description, 'revised version');
    assert(after.createdAt > before, 'createdAt refreshed');
    const revised = gs._events.find(e => e.e === 'goal:negotiation-revised');
    assert(revised, 'goal:negotiation-revised event fired');
  });
});

describe('GoalStackPending — dismissPending', () => {
  test('returns null for unknown id', () => {
    const gs = makeGS();
    assertEqual(gs.dismissPending('pending_unknown'), null);
  });

  test('removes entry, returns description, fires event', () => {
    const gs = makeGS();
    const id = gs.proposePending('lerne Rust');
    const desc = gs.dismissPending(id);
    assertEqual(desc, 'lerne Rust');
    assertEqual(gs.pendingGoals.size, 0);
    const dismissed = gs._events.find(e => e.e === 'goal:negotiation-dismissed');
    assert(dismissed, 'goal:negotiation-dismissed event fired');
  });
});

describe('GoalStackPending — getPending', () => {
  test('returns array of pending entries (post-sweep)', () => {
    const gs = makeGS();
    gs.proposePending('lerne Rust');
    gs.proposePending('lerne Go');
    const list = gs.getPending();
    assert(Array.isArray(list));
    assertEqual(list.length, 2);
    assert(list.every(e => e.description));
  });

  test('returns empty array if no pending', () => {
    const gs = makeGS();
    const list = gs.getPending();
    assertEqual(list.length, 0);
  });
});

describe('GoalStackPending — _sweepExpiredPending', () => {
  test('drops entries older than _pendingTTL and fires expired event', () => {
    const gs = makeGS();
    const id = gs.proposePending('expires soon');
    // Force-expire the entry
    gs.pendingGoals.get(id).createdAt = Date.now() - (gs._pendingTTL + 1000);
    gs._sweepExpiredPending();
    assertEqual(gs.pendingGoals.size, 0);
    const expired = gs._events.find(e => e.e === 'goal:negotiation-expired');
    assert(expired, 'goal:negotiation-expired event fired');
  });

  test('keeps entries within TTL window', () => {
    const gs = makeGS();
    gs.proposePending('still alive');
    gs._sweepExpiredPending();
    assertEqual(gs.pendingGoals.size, 1);
  });
});

run();
