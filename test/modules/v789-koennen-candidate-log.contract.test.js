// ============================================================
// GENESIS — test/modules/v789-koennen-candidate-log.contract.test.js
// Contract test for v7.8.9 KoennenCandidateLog:
//   • Subscriptions registered on start(), unregistered on stop()
//   • agent-loop:started without goalId → no-op
//   • agent-loop:started with goalId → _activeTaskStarts populated
//   • emotion:shift updates peaks (max-of) during active task
//   • emotion:shift without active task → no-op
//   • agent-loop:complete without prior :started → missedStarts++
//   • agent-loop:complete normal path → record persisted
//   • step_count == 0 → gatePass=false, skip_reason='no-steps'
//   • Triage gate: all 4 conditions must pass
//   • genome.consolidation modulates theta as specified
//   • TTL cleanup removes stale starts after 2h
//   • getRecentBoundaries(n) returns last n
// Every test name carries `koennen-v789 contract:` prefix.
// ============================================================

'use strict';

const { describe, test, assert, assertEqual, run } = require('../harness');
const path = require('path');
const fs = require('fs');
const os = require('os');

const ROOT = path.resolve(__dirname, '..', '..');
const { KoennenCandidateLog } = require(path.join(ROOT, 'src/agent/cognitive/KoennenCandidateLog'));

// ── Helpers ───────────────────────────────────────────────

function makeBus() {
  const subs = new Map();
  return {
    on: (event, fn) => {
      if (!subs.has(event)) subs.set(event, new Set());
      subs.get(event).add(fn);
      return () => subs.get(event).delete(fn);
    },
    fire: (event, data) => {
      const set = subs.get(event);
      if (set) for (const fn of set) try { fn(data); } catch (_e) {}
    },
    emit: function () { return this.fire.apply(this, arguments); },
    _listenerCount: function (event) {
      return subs.has(event) ? subs.get(event).size : 0;
    },
  };
}

function makeEmotionalState(overrides = {}) {
  const dims = {
    curiosity:    { value: overrides.curiosity    ?? 0.6, baseline: 0.6 },
    satisfaction: { value: overrides.satisfaction ?? 0.5, baseline: 0.5 },
    frustration:  { value: overrides.frustration  ?? 0.1, baseline: 0.1 },
    energy:       { value: overrides.energy       ?? 0.8, baseline: 0.7 },
    loneliness:   { value: overrides.loneliness   ?? 0.3, baseline: 0.3 },
  };
  return {
    dimensions: dims,
    getState() {
      const s = {};
      for (const [n, d] of Object.entries(dims)) {
        s[n] = Math.round(d.value * 100) / 100;
      }
      return s;
    },
    _setValue(name, value) {
      if (dims[name]) dims[name].value = value;
    },
  };
}

function makeSurpriseAccumulator(signals = []) {
  return {
    _buffer: signals.slice(),
    getSignalsSince(ts) {
      if (!ts || typeof ts !== 'number') return [];
      return this._buffer.filter(s => s.timestamp >= ts);
    },
  };
}

function makeGenome(consolidation = 0.5) {
  return {
    trait(name) {
      if (name === 'consolidation') return consolidation;
      return 0.5;
    },
  };
}

function makeStorage(dir) {
  return {
    appendText(filename, text) {
      const full = path.join(dir, filename);
      const subdir = path.dirname(full);
      if (!fs.existsSync(subdir)) fs.mkdirSync(subdir, { recursive: true });
      fs.appendFileSync(full, text, 'utf-8');
    },
    readText(filename, def = '') {
      const full = path.join(dir, filename);
      if (!fs.existsSync(full)) return def;
      return fs.readFileSync(full, 'utf-8');
    },
    writeText(filename, text) {
      const full = path.join(dir, filename);
      const subdir = path.dirname(full);
      if (!fs.existsSync(subdir)) fs.mkdirSync(subdir, { recursive: true });
      fs.writeFileSync(full, text, 'utf-8');
    },
  };
}

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'genesis-koennen-v789-'));
}

function cleanup(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_e) {}
}

function makeLog(overrides = {}) {
  const bus = overrides.bus || makeBus();
  const emo = overrides.emotionalState || makeEmotionalState();
  const sur = overrides.surpriseAccumulator || makeSurpriseAccumulator();
  const gen = overrides.genome || makeGenome();
  const dir = overrides.dir || tmpDir();
  const sto = overrides.storage || makeStorage(dir);
  const log = new KoennenCandidateLog({
    bus,
    storage: sto,
    emotionalState: emo,
    surpriseAccumulator: sur,
    genome: gen,
  });
  return { log, bus, emo, sur, gen, sto, dir };
}

// ── Tests ─────────────────────────────────────────────────

describe('koennen-v789 contract: KoennenCandidateLog lifecycle', () => {

  test('koennen-v789 contract: start registers subscriptions, stop unregisters', () => {
    const { log, bus, dir } = makeLog();
    assertEqual(bus._listenerCount('agent-loop:started'), 0, 'no subs before start');
    log.start();
    assertEqual(bus._listenerCount('agent-loop:started'), 1, 'started sub registered');
    assertEqual(bus._listenerCount('emotion:shift'), 1, 'emotion-shift sub registered');
    assertEqual(bus._listenerCount('agent-loop:complete'), 1, 'complete sub registered');
    log.stop();
    assertEqual(bus._listenerCount('agent-loop:started'), 0, 'unsub on stop');
    cleanup(dir);
  });

});

describe('koennen-v789 contract: KoennenCandidateLog task tracking', () => {

  test('koennen-v789 contract: agent-loop:started without goalId is no-op', () => {
    const { log, bus, dir } = makeLog();
    log.start();
    bus.fire('agent-loop:started', { title: 'no-goalid-task' });
    assertEqual(log._activeTaskStarts.size, 0, 'nothing tracked');
    log.stop();
    cleanup(dir);
  });

  test('koennen-v789 contract: agent-loop:started with goalId populates activeTaskStarts', () => {
    const { log, bus, dir } = makeLog();
    log.start();
    bus.fire('agent-loop:started', { goalId: 'goal-A', title: 'analyze X' });
    assertEqual(log._activeTaskStarts.size, 1, 'one task tracked');
    const start = log._activeTaskStarts.get('goal-A');
    assert(start, 'start context exists');
    assertEqual(start.title, 'analyze X', 'title captured');
    assert(start.startTs > 0, 'startTs set');
    assertEqual(start.startState.satisfaction, 0.5, 'startState captured');
    assertEqual(start.peaks.frustration, 0.1, 'peaks initialized to start');
    log.stop();
    cleanup(dir);
  });

  test('koennen-v789 contract: emotion:shift updates peaks while task active', () => {
    const { log, bus, emo, dir } = makeLog();
    log.start();
    bus.fire('agent-loop:started', { goalId: 'goal-B', title: 't' });
    bus.fire('emotion:shift', { dimension: 'frustration', from: 0.1, to: 0.4 });
    bus.fire('emotion:shift', { dimension: 'frustration', from: 0.4, to: 0.6 });
    bus.fire('emotion:shift', { dimension: 'frustration', from: 0.6, to: 0.3 });  // decrease — keep max
    bus.fire('emotion:shift', { dimension: 'curiosity', from: 0.6, to: 0.85 });
    const start = log._activeTaskStarts.get('goal-B');
    assertEqual(start.peaks.frustration, 0.6, 'peak frustration is max');
    assertEqual(start.peaks.curiosity, 0.85, 'curiosity peak captured');
    log.stop();
    cleanup(dir);
  });

  test('koennen-v789 contract: emotion:shift without active task is no-op', () => {
    const { log, bus, dir } = makeLog();
    log.start();
    // No task started
    bus.fire('emotion:shift', { dimension: 'frustration', from: 0.1, to: 0.4 });
    assertEqual(log._activeTaskStarts.size, 0, 'no active tasks');
    // Doesn't crash
    log.stop();
    cleanup(dir);
  });

});

describe('koennen-v789 contract: KoennenCandidateLog completion paths', () => {

  test('koennen-v789 contract: agent-loop:complete without prior started → missedStarts++', () => {
    const { log, bus, dir } = makeLog();
    log.start();
    bus.fire('agent-loop:complete', {
      goalId: 'orphan-goal',
      title: 't',
      steps: 3,
      success: true,
    });
    assertEqual(log._stats.missedStarts, 1, 'missedStarts incremented');
    assertEqual(log._stats.totalEvaluated, 0, 'no evaluation happened');
    assertEqual(log._recentBoundaries.length, 0, 'nothing pushed to ring');
    log.stop();
    cleanup(dir);
  });

  test('koennen-v789 contract: normal complete path persists record and clears active', () => {
    const { log, bus, dir, sto } = makeLog({
      emotionalState: makeEmotionalState({ satisfaction: 0.7 }),  // post-success boost
    });
    log.start();
    bus.fire('agent-loop:started', { goalId: 'goal-X', title: 'task X' });
    bus.fire('agent-loop:complete', {
      goalId: 'goal-X',
      title: 'task X',
      steps: 5,
      success: true,
    });
    assertEqual(log._activeTaskStarts.size, 0, 'cleared from active');
    assertEqual(log._recentBoundaries.length, 1, 'pushed to ring');
    assertEqual(log._stats.totalEvaluated, 1, 'evaluated counter');

    // Verify persisted
    const raw = sto.readText('koennen/candidates.jsonl');
    assert(raw.length > 0, 'jsonl has content');
    const parsed = JSON.parse(raw.trim().split('\n')[0]);
    assertEqual(parsed.goalId, 'goal-X', 'goalId persisted');
    assert(parsed.candidateId.startsWith('cand_'), 'candidateId formatted');
    assert(typeof parsed.gatePass === 'boolean', 'gatePass set');
    log.stop();
    cleanup(dir);
  });

  test('koennen-v789 contract: step_count=0 yields gatePass=false with skip_reason', () => {
    const { log, bus, dir, sto } = makeLog();
    log.start();
    bus.fire('agent-loop:started', { goalId: 'goal-zero', title: 't' });
    bus.fire('agent-loop:complete', {
      goalId: 'goal-zero',
      title: 't',
      steps: 0,
      success: true,
    });
    const raw = sto.readText('koennen/candidates.jsonl');
    const parsed = JSON.parse(raw.trim().split('\n')[0]);
    assertEqual(parsed.gatePass, false, 'gate failed for zero steps');
    assertEqual(parsed.gateDetails.skip_reason, 'no-steps', 'skip_reason set');
    log.stop();
    cleanup(dir);
  });

});

describe('koennen-v789 contract: KoennenCandidateLog triage gate', () => {

  test('koennen-v789 contract: gate fails when success=false', () => {
    const { log, dir } = makeLog();
    const affect = {
      satisfaction_end: 0.9,
      frustration_peak: 0.05,
      surprise_sum: 5,
      step_count: 5,
    };
    const result = log.evaluateGate(affect, { success: false, step_count: 5 });
    assertEqual(result.pass, false, 'fails');
    assertEqual(result.details.success_check, 'failed', 'success_check labeled');
    cleanup(dir);
  });

  test('koennen-v789 contract: gate passes when all four conditions met', () => {
    const { log, dir, sur } = makeLog({
      emotionalState: makeEmotionalState(),  // baselines: sat 0.5, fru 0.1
      genome: makeGenome(0.5),  // theta = 0.45
    });
    // surprise_sum / step_count = 0.6 > theta 0.45 ✓
    const affect = {
      satisfaction_end: 0.7,   // 0.7 > 0.5+0.15=0.65 ✓
      frustration_peak: 0.3,   // 0.3 < 0.1+0.4=0.5 ✓
      surprise_sum: 3.0,
      step_count: 5,
    };
    const result = log.evaluateGate(affect, { success: true, step_count: 5 });
    assertEqual(result.pass, true, 'all conditions pass');
    assert(/passed/.test(result.details.satisfaction_check), 'sat passed labeled');
    assert(/passed/.test(result.details.frustration_check), 'fru passed labeled');
    assert(/passed/.test(result.details.surprise_check), 'sur passed labeled');
    cleanup(dir);
  });

  test('koennen-v789 contract: genome.consolidation modulates theta correctly', () => {
    // theta = 0.6 - (consolidation * 0.3)
    {
      const { log, dir } = makeLog({ genome: makeGenome(0.0) });
      assert(Math.abs(log._computeTheta() - 0.6) < 0.001, 'consolidation=0 → theta 0.6');
      cleanup(dir);
    }
    {
      const { log, dir } = makeLog({ genome: makeGenome(0.5) });
      assert(Math.abs(log._computeTheta() - 0.45) < 0.001, 'consolidation=0.5 → theta 0.45');
      cleanup(dir);
    }
    {
      const { log, dir } = makeLog({ genome: makeGenome(1.0) });
      // 0.6 - 0.3 = 0.3
      assert(Math.abs(log._computeTheta() - 0.3) < 0.001, 'consolidation=1 → theta 0.3');
      cleanup(dir);
    }
  });

});

describe('koennen-v789 contract: KoennenCandidateLog public API', () => {

  test('koennen-v789 contract: TTL cleanup removes stale starts older than 2h', () => {
    const { log, bus, dir } = makeLog();
    log.start();
    bus.fire('agent-loop:started', { goalId: 'stale-goal', title: 't' });
    // Manually backdate
    const start = log._activeTaskStarts.get('stale-goal');
    start.startTs = Date.now() - (3 * 60 * 60 * 1000);  // 3h ago

    // Fresh task too
    bus.fire('agent-loop:started', { goalId: 'fresh-goal', title: 't' });

    log._cleanupStaleStarts();
    assertEqual(log._activeTaskStarts.size, 1, 'stale removed, fresh kept');
    assert(log._activeTaskStarts.has('fresh-goal'), 'fresh-goal survived');
    log.stop();
    cleanup(dir);
  });

  test('koennen-v789 contract: getRecentBoundaries returns last n in order', () => {
    const { log, bus, dir } = makeLog();
    log.start();
    for (let i = 0; i < 5; i++) {
      bus.fire('agent-loop:started', { goalId: `g-${i}`, title: `task-${i}` });
      bus.fire('agent-loop:complete', {
        goalId: `g-${i}`, title: `task-${i}`, steps: 3, success: true,
      });
    }
    const recent = log.getRecentBoundaries(3);
    assertEqual(recent.length, 3, 'returns 3');
    assertEqual(recent[0].goalId, 'g-2', 'oldest of 3');
    assertEqual(recent[2].goalId, 'g-4', 'newest is last');
    log.stop();
    cleanup(dir);
  });

});

if (require.main === module) run();
