// ============================================================
// v7.9.27 — metabolism charges energy per LLM call.
//
// Energy was deducted only on chat:completed, so an idle agent running
// its own reasoning loops (autonomous llm:call-complete with no chat
// turn) spent nothing — loneliness/idle telemetry rose while energy sat
// flat. The real metabolic cost now rides on llm:call-complete, which
// fires for every call. chat:completed keeps per-turn accounting and
// cancels the crude fixed -0.02 EmotionalState applies, so a normal turn
// is charged exactly once, not twice.
// ============================================================

'use strict';

const path = require('path');
const { describe, test, run, assert, assertEqual } = require('../harness');

const ROOT = path.join(__dirname, '../..');
const { Metabolism } = require(path.join(ROOT, 'src/agent/organism/Metabolism'));

function mockBus() {
  const events = [];
  return {
    emit: (name, data, meta) => events.push({ name, data, meta }),
    fire: (name, data, meta) => events.push({ name, data, meta }),
    on: () => {},
    events,
  };
}

function fakeEmotional() {
  const adjusts = [];
  return { adjusts, _adjust(dim, delta) { adjusts.push({ dim, delta }); } };
}

function make() {
  const bus = mockBus();
  const m = new Metabolism({ bus, storage: null, intervals: null, config: {} });
  const es = fakeEmotional();
  m.emotionalState = es;
  return { m, bus, es };
}

describe('v7.9.27 — metabolism per-call energy', () => {
  test('an autonomous llm:call-complete draws energy', () => {
    const { m, bus, es } = make();
    const before = m._totalEnergySpent;
    m._onLlmCallComplete({ promptTokens: 1000, responseTokens: 1000, latencyMs: 3000, taskType: 'reflect' });
    const energyAdjust = es.adjusts.find(a => a.dim === 'energy');
    assert(energyAdjust && energyAdjust.delta < 0, 'energy is deducted (negative adjust)');
    assert(m._totalEnergySpent > before, 'total energy spent increased');
    const costEvt = bus.events.find(e => e.name === 'metabolism:cost');
    assert(costEvt && costEvt.data.cost > 0, 'metabolism:cost emitted with a positive cost');
    assertEqual(costEvt.data.tokens, 2000);
  });

  test('chat:completed does not charge cost — it cancels the fixed dip', () => {
    const { m, es } = make();
    const before = m._totalEnergySpent;
    m._onChatCompleted({ tokens: 2000 });
    const energyAdjust = es.adjusts.find(a => a.dim === 'energy');
    // The only energy move on a turn is the +baseFallback compensation.
    assert(energyAdjust && energyAdjust.delta > 0, 'compensation is positive (cancels EmotionalState -0.02)');
    assert(Math.abs(energyAdjust.delta - m._cost.baseFallback) < 1e-9, 'compensation equals baseFallback');
    assertEqual(m._totalEnergySpent, before, 'no metabolic cost charged on chat:completed');
    assertEqual(m._callCount, 1, 'the turn is counted once');
  });

  test('a chat turn nets a single charge (no double-count)', () => {
    const { m, es } = make();
    // One turn = one LLM call (llm:call-complete) + the turn marker (chat:completed).
    m._onLlmCallComplete({ promptTokens: 1000, responseTokens: 1000, latencyMs: 3000, taskType: 'chat' });
    const charged = m._totalEnergySpent;
    m._onChatCompleted({ tokens: 2000 });
    const callCharge = es.adjusts.find(a => a.dim === 'energy' && a.delta < 0).delta;     // -cost
    const turnComp   = es.adjusts.find(a => a.dim === 'energy' && a.delta > 0).delta;     // +0.02
    // EmotionalState applies its own -0.02 externally; turnComp cancels it, so the
    // surviving change is exactly the per-call charge.
    assert(Math.abs(turnComp - m._cost.baseFallback) < 1e-9, 'turn compensation cancels the external -0.02');
    assert(callCharge < 0, 'the per-call charge is the real cost');
    assertEqual(m._totalEnergySpent, charged, 'chat:completed adds no further cost');
  });

  test('repeated autonomous calls keep drawing without touching the turn counter', () => {
    const { m } = make();
    m._onLlmCallComplete({ promptTokens: 800, responseTokens: 800, latencyMs: 2500, taskType: 'plan' });
    const afterOne = m._totalEnergySpent;
    m._onLlmCallComplete({ promptTokens: 800, responseTokens: 800, latencyMs: 2500, taskType: 'plan' });
    assert(m._totalEnergySpent > afterOne, 'second autonomous call also draws energy');
    assertEqual(m._callCount, 0, 'autonomous calls are not counted as user-facing turns');
  });
});

if (require.main === module) run();
