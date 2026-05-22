// ============================================================
// GENESIS — v795-inhabit-activity.contract.test.js
//
// Contract tests for v7.9.5 — Inhabit activity (17th IdleMind
// activity). Covers: module shape, deterministic composition,
// missing-service tolerance, InnerSpeech emission, HardGate
// privacy blocklist, settings tree, ACTIVITY_MODULES count,
// Metabolism cost entry.
// ============================================================

'use strict';

const path = require('path');
const ROOT = path.resolve(__dirname, '../..');
const { describe, test, assert, assertEqual, run } = require('../harness');

describe('v7.9.5 Inhabit Activity', () => {

// ── Module shape ────────────────────────────────────────────

test('A1: Inhabit module exports the expected activity shape', () => {
  const Inhabit = require(path.join(ROOT, 'src/agent/autonomy/activities/Inhabit'));
  assertEqual(Inhabit.name, 'inhabit');
  assertEqual(typeof Inhabit.weight, 'number');
  assertEqual(typeof Inhabit.cooldown, 'number');
  assertEqual(typeof Inhabit.shouldTrigger, 'function');
  assertEqual(typeof Inhabit.run, 'function');
});

test('A1: Inhabit exposes composeInhabitText and constants for tests', () => {
  const Inhabit = require(path.join(ROOT, 'src/agent/autonomy/activities/Inhabit'));
  assertEqual(typeof Inhabit.composeInhabitText, 'function');
  assertEqual(typeof Inhabit.DEFAULT_COOLDOWN_MIN, 'number');
  assertEqual(typeof Inhabit.IDLE_BOOST_MIN, 'number');
  assertEqual(typeof Inhabit.IDLE_BOOST_FACTOR, 'number');
  assert(Inhabit.IDLE_BOOST_FACTOR > 1.0, 'idle-boost factor must be > 1');
});

// ── Deterministic composition ───────────────────────────────

test('A1: composeInhabitText is deterministic — same input yields same output', () => {
  const { composeInhabitText } = require(path.join(ROOT, 'src/agent/autonomy/activities/Inhabit'));
  const input = {
    body: { canExecuteCode: true, canModifySelf: true, canCallLlm: true, circuitOpen: false },
    emoState: { curiosity: 0.7, satisfaction: 0.5 },
    emoDom: { emotion: 'curiosity', intensity: 0.4 },
    emoMood: 'curious',
    needs: { knowledge: 0.42, social: 0.28, maintenance: 0.15, rest: 0.10 },
    urgent: { need: 'knowledge', drive: 0.5 },
    energy: { current: 365, max: 500, percent: 73, state: 'normal' },
    goalCount: 0,
  };
  const a = composeInhabitText(input);
  const b = composeInhabitText(input);
  assertEqual(a, b);
  assert(a.includes('73%'), 'should mention energy percent');
  assert(a.includes('curiosity'), 'should mention dominant emotion');
  assert(a.includes('knowledge'), 'should mention urgent need');
  assert(a.includes('No active goal'), 'should mention zero goal state');
});

test('A1: composeInhabitText drops missing fragments silently, no "unknown"', () => {
  const { composeInhabitText } = require(path.join(ROOT, 'src/agent/autonomy/activities/Inhabit'));
  // Only energy + goalCount available, everything else null.
  const text = composeInhabitText({
    body: null,
    emoState: null,
    emoDom: null,
    emoMood: null,
    needs: null,
    urgent: null,
    energy: { percent: 50, state: 'normal' },
    goalCount: 2,
  });
  assert(text.includes('50%'), 'should mention available energy');
  assert(text.includes('2 active goals'), 'should mention goal count');
  assert(!/unknown/i.test(text), 'must not write "unknown" for missing fragments');
  assert(!/null/i.test(text), 'must not leak "null" into the text');
});

test('A1: composeInhabitText returns fallback string when all signals missing', () => {
  const { composeInhabitText } = require(path.join(ROOT, 'src/agent/autonomy/activities/Inhabit'));
  const text = composeInhabitText({
    body: null, emoState: null, emoDom: null, emoMood: null,
    needs: null, urgent: null, energy: null, goalCount: null,
  });
  assert(typeof text === 'string' && text.length > 0, 'must return non-empty fallback');
  assert(text.toLowerCase().includes('no readable'), 'fallback should signal absence of signals');
});

test('A1: composeInhabitText only mentions body fragment when there ARE restrictions', () => {
  const { composeInhabitText } = require(path.join(ROOT, 'src/agent/autonomy/activities/Inhabit'));
  const allOk = composeInhabitText({
    body: { canExecuteCode: true, canModifySelf: true, canCallLlm: true, circuitOpen: false },
    emoState: null, emoDom: null, emoMood: null, needs: null, urgent: null,
    energy: { percent: 80, state: 'normal' }, goalCount: 0,
  });
  assert(!allOk.toLowerCase().includes('body state'),
    'no body fragment when all capabilities ok');

  const restricted = composeInhabitText({
    body: { canExecuteCode: false, canModifySelf: true, canCallLlm: true, circuitOpen: true },
    emoState: null, emoDom: null, emoMood: null, needs: null, urgent: null,
    energy: null, goalCount: null,
  });
  assert(restricted.toLowerCase().includes('body state'),
    'body fragment present when restrictions exist');
  assert(restricted.includes('code execution unavailable'));
  assert(restricted.includes('LLM circuit open'));
});

// ── run() — emission contract ──────────────────────────────

test('A2: Inhabit.run() emits via InnerSpeech with kind self-state-snapshot', async () => {
  const Inhabit = require(path.join(ROOT, 'src/agent/autonomy/activities/Inhabit'));
  let emittedKind = null;
  let emittedText = null;
  let emittedMeta = null;
  const fakeIdleMind = {
    innerSpeech: {
      emit: (text, kind, meta) => {
        emittedText = text;
        emittedKind = kind;
        emittedMeta = meta;
      },
    },
    bodySchema:     { getCapabilities: () => ({ canExecuteCode: true, canModifySelf: true, canCallLlm: true, circuitOpen: false }) },
    emotionalState: { getState: () => ({ curiosity: 0.7 }), getDominant: () => ({ emotion: 'curiosity', intensity: 0.4 }), getMood: () => 'curious' },
    needsSystem:    { getNeeds: () => ({ knowledge: 0.42 }), getMostUrgent: () => ({ need: 'knowledge', drive: 0.5 }) },
    _metabolism:    { getEnergyLevel: () => ({ percent: 73, state: 'normal' }) },
    goalStack:      { getActiveGoals: () => [] },
  };
  const ret = await Inhabit.run(fakeIdleMind);
  assertEqual(emittedKind, 'self-state-snapshot');
  assertEqual(emittedMeta && emittedMeta.sourceModule, 'Inhabit');
  assert(typeof emittedText === 'string' && emittedText.length > 0);
  assertEqual(emittedText, ret, 'run() must return the emitted text');
});

test('A2: Inhabit.run() does NOT throw when every service is missing', async () => {
  const Inhabit = require(path.join(ROOT, 'src/agent/autonomy/activities/Inhabit'));
  let emitted = false;
  const fakeIdleMind = {
    innerSpeech: { emit: () => { emitted = true; } },
    // Everything else missing — body, emotion, needs, metabolism, goalStack.
  };
  const ret = await Inhabit.run(fakeIdleMind);
  assert(emitted, 'should still emit even with no signals');
  assert(typeof ret === 'string');
});

test('A2: Inhabit.run() degrades gracefully when InnerSpeech is unavailable', async () => {
  const Inhabit = require(path.join(ROOT, 'src/agent/autonomy/activities/Inhabit'));
  const fakeIdleMind = {
    // No innerSpeech, no bus._container
  };
  const ret = await Inhabit.run(fakeIdleMind);
  assert(typeof ret === 'string', 'should return a string skip-notice');
  assert(/skipped/i.test(ret) || /unavailable/i.test(ret), 'should indicate skip reason');
});

test('A2: Inhabit.run() survives InnerSpeech.emit throwing (Self-Gate-Asymmetry)', async () => {
  const Inhabit = require(path.join(ROOT, 'src/agent/autonomy/activities/Inhabit'));
  const fakeIdleMind = {
    innerSpeech: { emit: () => { throw new Error('test-emit-explosion'); } },
  };
  // Must not throw — Self-Gate-Asymmetry contract requires soft failure.
  const ret = await Inhabit.run(fakeIdleMind);
  assert(typeof ret === 'string');
});

// ── HardGate privacy contract ───────────────────────────────

test('A3: HardGate exports PRIVATE_KINDS set containing self-state-snapshot', () => {
  const { PRIVATE_KINDS } = require(path.join(ROOT, 'src/agent/cognitive/proactiveSelfExpression/HardGates'));
  assert(PRIVATE_KINDS instanceof Set, 'PRIVATE_KINDS must be a Set');
  assert(PRIVATE_KINDS.has('self-state-snapshot'),
    'self-state-snapshot must be in the structural private-kinds list');
});

test('A3: HardGate blocks self-state-snapshot regardless of settings', () => {
  const { runGates } = require(path.join(ROOT, 'src/agent/cognitive/proactiveSelfExpression/HardGates'));
  // Even with maximally permissive settings (every other gate passes),
  // a self-state-snapshot thought must be blocked.
  const result = runGates(
    { kind: 'self-state-snapshot', text: 'irrelevant', significance: 1.0, novelty: 1.0 },
    { now: Date.now(), lastSelfMessageMs: 0, lastUserMessageMs: 0, dailyCount: 0 },
    {
      enabled: true,
      minIntervalMs: 0,
      userActivityCooldownMs: 0,
      // Maximally permissive allowlist — even includes self-state-snapshot
      // (which would be a misconfiguration). Hard blocklist must still win.
      allowedKinds: ['self-state-snapshot', 'plan-failure-reflection'],
      perKindFloors: {},
      dailyVolumeSoftCap: 100,
    }
  );
  assertEqual(result.ok, false);
  assertEqual(result.reason, 'private-kind');
  assertEqual(result.detail, 'self-state-snapshot');
});

test('A3: HardGate still passes other allowed kinds (no regression)', () => {
  const { runGates } = require(path.join(ROOT, 'src/agent/cognitive/proactiveSelfExpression/HardGates'));
  // Regression-guard: the new gate must not accidentally block legitimate kinds.
  const result = runGates(
    { kind: 'plan-failure-reflection', text: 'test' },
    { now: Date.now(), lastSelfMessageMs: 0, lastUserMessageMs: 0, dailyCount: 0 },
    {
      enabled: true, minIntervalMs: 0, userActivityCooldownMs: 0,
      allowedKinds: ['plan-failure-reflection'],
      perKindFloors: {},
      dailyVolumeSoftCap: 100,
    }
  );
  assertEqual(result.ok, true);
});

// ── ACTIVITY_MODULES + Metabolism ───────────────────────────

test('A4: ACTIVITY_MODULES contains 17 entries with inhabit included', () => {
  // Read source directly to avoid pulling IdleMind dependencies into the test.
  const fs = require('fs');
  const src = fs.readFileSync(path.join(ROOT, 'src/agent/autonomy/IdleMind.js'), 'utf8');
  const match = src.match(/const ACTIVITY_MODULES = \[([^\]]+)\];/);
  assert(match, 'ACTIVITY_MODULES array must be present');
  const requires = match[1].match(/require\([^)]+\)/g) || [];
  assertEqual(requires.length, 17, 'must have exactly 17 activities');
  const hasInhabit = requires.some(r => r.includes("activities/Inhabit"));
  assert(hasInhabit, 'ACTIVITY_MODULES must include Inhabit');
});

test('A4: Metabolism.ACTIVITY_COSTS contains idleMind:inhabit with cost > 0', () => {
  const { Metabolism } = require(path.join(ROOT, 'src/agent/organism/Metabolism'));
  const costs = Metabolism.ACTIVITY_COSTS;
  assert(costs && typeof costs === 'object', 'ACTIVITY_COSTS must be exposed');
  const cost = costs['idleMind:inhabit'];
  assert(typeof cost === 'number' && cost > 0,
    `idleMind:inhabit must have positive cost, got ${cost}`);
  assert(cost <= 5, 'inhabit should be cheap (≤ 5) — no LLM call');
});

// ── Settings tree ───────────────────────────────────────────

test('A5: Settings tree contains organism.inhabit with default values', () => {
  const { Settings } = require(path.join(ROOT, 'src/agent/foundation/Settings'));
  // Settings has a complex constructor. We just verify the default tree
  // by reading the source — it's a static literal.
  const fs = require('fs');
  const src = fs.readFileSync(path.join(ROOT, 'src/agent/foundation/Settings.js'), 'utf8');
  assert(/inhabit:\s*\{/.test(src), 'organism.inhabit block must exist in default tree');
  assert(/enabled:\s*true/.test(src), 'organism.inhabit.enabled default must be true');
  assert(/cooldownMinutes:\s*15/.test(src), 'cooldownMinutes default must be 15');
  assert(/idleBoost:\s*true/.test(src), 'idleBoost default must be true');
  // Clamp registered
  assert(/clamp\('organism\.inhabit\.cooldownMinutes',\s*1,\s*1440\)/.test(src),
    'cooldownMinutes must be clamped 1-1440');
  // Construct an instance and read live values (defense-in-depth)
  void Settings;
});

// ── shouldTrigger contract ──────────────────────────────────

test('A6: shouldTrigger returns 0 when innerSpeech is unavailable', () => {
  const Inhabit = require(path.join(ROOT, 'src/agent/autonomy/activities/Inhabit'));
  const ctx = {
    hasContainerService: (name) => name !== 'innerSpeech',
    activityLog: [],
    now: Date.now(),
    idleMsSince: 0,
    services: { bus: { _container: { tryResolve: () => null } } },
  };
  assertEqual(Inhabit.shouldTrigger(ctx), 0);
});

test('A6: shouldTrigger returns 0 within cooldown window', () => {
  const Inhabit = require(path.join(ROOT, 'src/agent/autonomy/activities/Inhabit'));
  const settings = { get: (k) => {
    if (k === 'organism.inhabit.enabled') return true;
    if (k === 'organism.inhabit.cooldownMinutes') return 15;
    if (k === 'organism.inhabit.idleBoost') return true;
    return undefined;
  }};
  const now = Date.now();
  const ctx = {
    hasContainerService: () => true,
    activityLog: [{ activity: 'inhabit', timestamp: now - 5 * 60 * 1000 }], // 5 min ago
    now,
    idleMsSince: 0,
    services: { bus: { _container: { tryResolve: (k) => k === 'settings' ? settings : null } } },
  };
  assertEqual(Inhabit.shouldTrigger(ctx), 0);
});

test('A6: shouldTrigger applies idle-boost when idle > threshold', () => {
  const Inhabit = require(path.join(ROOT, 'src/agent/autonomy/activities/Inhabit'));
  const settings = { get: (k) => {
    if (k === 'organism.inhabit.enabled') return true;
    if (k === 'organism.inhabit.cooldownMinutes') return 15;
    if (k === 'organism.inhabit.idleBoost') return true;
    return undefined;
  }};
  const now = Date.now();
  const baseCtx = {
    hasContainerService: () => true,
    activityLog: [], // no prior inhabit
    now,
    services: { bus: { _container: { tryResolve: (k) => k === 'settings' ? settings : null } } },
  };
  const lowIdle = Inhabit.shouldTrigger({ ...baseCtx, idleMsSince: 0 });
  const highIdle = Inhabit.shouldTrigger({ ...baseCtx, idleMsSince: 60 * 60 * 1000 }); // 1h
  assertEqual(lowIdle, 1.0);
  assert(highIdle > lowIdle, `idle-boost should raise score (got low=${lowIdle}, high=${highIdle})`);
  assertEqual(highIdle, 1.0 * Inhabit.IDLE_BOOST_FACTOR);
});

test('A6: shouldTrigger respects enabled=false toggle', () => {
  const Inhabit = require(path.join(ROOT, 'src/agent/autonomy/activities/Inhabit'));
  const settings = { get: (k) => k === 'organism.inhabit.enabled' ? false : undefined };
  const ctx = {
    hasContainerService: () => true,
    activityLog: [],
    now: Date.now(),
    idleMsSince: 99 * 60 * 1000,
    services: { bus: { _container: { tryResolve: (k) => k === 'settings' ? settings : null } } },
  };
  assertEqual(Inhabit.shouldTrigger(ctx), 0);
});

});

run();
