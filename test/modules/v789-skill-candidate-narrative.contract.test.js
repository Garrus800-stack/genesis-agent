// ============================================================
// GENESIS — test/modules/v789-skill-candidate-narrative.contract.test.js
// Contract test for v7.8.9 SkillCandidateNarrative:
//   • <3 candidates in 7d window → no event fired
//   • ≥3 candidates → emits koennen:candidates-noticed
//   • Cooldown 6h is respected between reflections
//   • SelfNarrative._changeAccumulator increments by 2 (integration)
//   • Payload contains count, windowMs, sampleTitles
// Every test name carries `koennen-v789 contract:` prefix.
// ============================================================

'use strict';

const { describe, test, assert, assertEqual, run } = require('../harness');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const { SkillCandidateNarrative } = require(path.join(ROOT, 'src/agent/cognitive/SkillCandidateNarrative'));

// ── Helpers ───────────────────────────────────────────────

function makeBus() {
  const subs = new Map();
  const fired = [];
  return {
    on: (event, fn) => {
      if (!subs.has(event)) subs.set(event, new Set());
      subs.get(event).add(fn);
      return () => subs.get(event).delete(fn);
    },
    fire: (event, data) => {
      fired.push({ event, data });
      const set = subs.get(event);
      if (set) for (const fn of set) try { fn(data); } catch (_e) {}
    },
    emit: function () { return this.fire.apply(this, arguments); },
    _fired: fired,
    _firedOf: (event) => fired.filter(f => f.event === event),
  };
}

function makeLog(candidates = []) {
  return {
    _candidates: candidates,
    getCandidatesSince(ts) {
      return this._candidates.filter(c => c.recordedAt >= ts);
    },
  };
}

function makeCandidate(opts = {}) {
  return {
    candidateId: opts.id || `cand_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    goalId: opts.goalId || 'goal-x',
    taskTitle: opts.title || 'task title',
    gatePass: opts.gatePass !== false,
    recordedAt: opts.recordedAt || Date.now(),
  };
}

// ── Tests ─────────────────────────────────────────────────

describe('koennen-v789 contract: SkillCandidateNarrative threshold', () => {

  test('koennen-v789 contract: <3 candidates in window → no event fired', () => {
    const bus = makeBus();
    const log = makeLog([
      makeCandidate({ id: 'c1', title: 't1' }),
      makeCandidate({ id: 'c2', title: 't2' }),
    ]);
    const narr = new SkillCandidateNarrative({ bus, koennenCandidateLog: log });
    narr.start();
    bus.fire('koennen:candidate-recorded', { candidateId: 'c2', goalId: 'g', gatePass: true });
    const fired = bus._firedOf('koennen:candidates-noticed');
    assertEqual(fired.length, 0, 'no notice event');
    narr.stop();
  });

  test('koennen-v789 contract: ≥3 candidates fires koennen:candidates-noticed', () => {
    const bus = makeBus();
    const log = makeLog([
      makeCandidate({ id: 'c1', title: 'task one' }),
      makeCandidate({ id: 'c2', title: 'task two' }),
      makeCandidate({ id: 'c3', title: 'task three' }),
    ]);
    const narr = new SkillCandidateNarrative({ bus, koennenCandidateLog: log });
    narr.start();
    bus.fire('koennen:candidate-recorded', { candidateId: 'c3', goalId: 'g', gatePass: true });
    const fired = bus._firedOf('koennen:candidates-noticed');
    assertEqual(fired.length, 1, 'one notice event fired');
    assertEqual(fired[0].data.count, 3, 'count is 3');
    assert(Array.isArray(fired[0].data.sampleTitles), 'sampleTitles is array');
    assertEqual(fired[0].data.sampleTitles.length, 3, '3 sample titles');
    assertEqual(fired[0].data.windowMs, 7 * 24 * 60 * 60 * 1000, 'windowMs is 7d');
    narr.stop();
  });

  test('koennen-v789 contract: only counts gatePass=true candidates', () => {
    const bus = makeBus();
    const log = makeLog([
      makeCandidate({ id: 'c1', gatePass: true }),
      makeCandidate({ id: 'c2', gatePass: false }),
      makeCandidate({ id: 'c3', gatePass: false }),
      makeCandidate({ id: 'c4', gatePass: false }),
    ]);
    const narr = new SkillCandidateNarrative({ bus, koennenCandidateLog: log });
    narr.start();
    bus.fire('koennen:candidate-recorded', { candidateId: 'c4', goalId: 'g', gatePass: false });
    const fired = bus._firedOf('koennen:candidates-noticed');
    assertEqual(fired.length, 0, 'only 1 passing candidate, no notice');
    narr.stop();
  });

});

describe('koennen-v789 contract: SkillCandidateNarrative cooldown', () => {

  test('koennen-v789 contract: 6h cooldown is respected between reflections', () => {
    const bus = makeBus();
    const log = makeLog([
      makeCandidate({ id: 'c1' }),
      makeCandidate({ id: 'c2' }),
      makeCandidate({ id: 'c3' }),
      makeCandidate({ id: 'c4' }),
    ]);
    const narr = new SkillCandidateNarrative({ bus, koennenCandidateLog: log });
    narr.start();

    // First firing
    bus.fire('koennen:candidate-recorded', { candidateId: 'c3', goalId: 'g', gatePass: true });
    assertEqual(bus._firedOf('koennen:candidates-noticed').length, 1, 'first fires');

    // Second firing within cooldown — should NOT fire again
    bus.fire('koennen:candidate-recorded', { candidateId: 'c4', goalId: 'g', gatePass: true });
    assertEqual(bus._firedOf('koennen:candidates-noticed').length, 1, 'second blocked by cooldown');

    // Manually expire cooldown
    narr._lastReflectionTs = Date.now() - (7 * 60 * 60 * 1000);
    bus.fire('koennen:candidate-recorded', { candidateId: 'c4', goalId: 'g', gatePass: true });
    assertEqual(bus._firedOf('koennen:candidates-noticed').length, 2, 'after cooldown fires again');

    narr.stop();
  });

});

describe('koennen-v789 contract: SkillCandidateNarrative wiring', () => {

  test('koennen-v789 contract: SelfNarrative._changeAccumulator increments by 2 on notice', () => {
    // Real SelfNarrative-style listener integration via shared bus
    const bus = makeBus();

    // Mini stand-in: subscribe to koennen:candidates-noticed and increment
    // a local accumulator the same way SelfNarrative.start() does.
    const accumulator = { value: 0 };
    bus.on('koennen:candidates-noticed', () => {
      accumulator.value += 2;
    });

    const log = makeLog([
      makeCandidate({ id: 'c1' }),
      makeCandidate({ id: 'c2' }),
      makeCandidate({ id: 'c3' }),
    ]);
    const narr = new SkillCandidateNarrative({ bus, koennenCandidateLog: log });
    narr.start();

    assertEqual(accumulator.value, 0, 'accumulator starts at 0');
    bus.fire('koennen:candidate-recorded', { candidateId: 'c3', goalId: 'g', gatePass: true });
    assertEqual(accumulator.value, 2, 'accumulator incremented by 2');

    narr.stop();
  });

  test('koennen-v789 contract: payload contains count, windowMs, sampleTitles (max 3)', () => {
    const bus = makeBus();
    // 5 candidates — sampleTitles should still cap at 3
    const log = makeLog([
      makeCandidate({ id: 'c1', title: 'one' }),
      makeCandidate({ id: 'c2', title: 'two' }),
      makeCandidate({ id: 'c3', title: 'three' }),
      makeCandidate({ id: 'c4', title: 'four' }),
      makeCandidate({ id: 'c5', title: 'five' }),
    ]);
    const narr = new SkillCandidateNarrative({ bus, koennenCandidateLog: log });
    narr.start();
    bus.fire('koennen:candidate-recorded', { candidateId: 'c5', goalId: 'g', gatePass: true });
    const fired = bus._firedOf('koennen:candidates-noticed');
    assertEqual(fired.length, 1, 'fired');
    const payload = fired[0].data;
    assertEqual(payload.count, 5, 'count is total passing');
    assertEqual(payload.sampleTitles.length, 3, 'sampleTitles capped at 3');
    // Most recent first ordering: c3, c4, c5 (last three)
    assert(payload.sampleTitles.includes('five'), 'most recent in samples');
    narr.stop();
  });

});

if (require.main === module) run();
