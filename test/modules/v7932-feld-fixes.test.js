// ============================================================
// TEST — v7.9.32 field fixes (F1–F5)
//
// First-live-run catches, each grounded in the 2026-07-05 trace:
//   F1  fitness emitter scan tolerates `?.fire?.(` (13 call sites)
//   F2a step-types splits comma lists in a single file target
//   F2b PathPlausibility judges list parts (live fixture below)
//   F2c no "backing off" promise for a goal that already left the stack
//   F3  Reflector thresholds bound to the fitness convention (cross-pin)
//   F4a goal reports condense KG-node arrays to label lists
//   F5  flight-recorder.log rename + one-time migration
// ============================================================

const { describe, test, run } = require('../harness');
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');

describe('v7.9.32 F1 — emitter scan sees optional-chaining fire form', () => {
  const src = fs.readFileSync(path.join(ROOT, 'scripts', 'architectural-fitness.js'), 'utf8');
  const m = src.match(/const emitRe = (\/.*\/g);/);
  test('emitRe carries the optional-chaining tolerance', () => {
    assert(m, 'emitRe literal not found');
    assert(m[1].includes('(?:\\?\\.)?'), 'optional-chaining group missing');
  });
  test('cautious form matches, normal and request forms unchanged', () => {
    const re = new Function('return ' + m[1])();
    const hit = (s) => { re.lastIndex = 0; const r = re.exec(s); return r && r[1]; };
    assert.strictEqual(hit("this.bus?.fire?.('skill:candidate-created', p)"), 'skill:candidate-created');
    assert.strictEqual(hit("bus.fire('a:b', d)"), 'a:b');
    assert.strictEqual(hit("this.bus.request('c:d')"), 'c:d');
  });
});

describe('v7.9.32 F2a — comma lists split at the token producer', () => {
  const { getStepRequirements } = require(path.join(ROOT, 'src/agent/core/step-types'));
  test('a comma list in one target yields one file: token per path', () => {
    const out = getStepRequirements('ANALYZE', { target: 'src/a.js, src/b.js, src/c.js' });
    const files = out.filter(t => t.startsWith('file:'));
    assert.deepStrictEqual(files, ['file:src/a.js', 'file:src/b.js', 'file:src/c.js']);
  });
  test('a single target stays a single token', () => {
    const out = getStepRequirements('ANALYZE', { target: 'src/agent/core/step-types.js' });
    assert.deepStrictEqual(out.filter(t => t.startsWith('file:')), ['file:src/agent/core/step-types.js']);
  });
});

describe('v7.9.32 F2b — plausibility judges list parts (live fixture)', () => {
  const { _filterImplausibleFilePaths } = require(path.join(ROOT, 'src/agent/revolution/PathPlausibility'));
  // The literal token shape from the 2026-07-05 trace: one file: token,
  // Windows separators, a comma list — every single path exists.
  const LIVE = 'file:src\\agent\\core\\Container.js, src\\agent\\core\\Logger.js, src\\agent\\core\\EventBus.js, src\\agent\\foundation\\Settings.js, src\\agent\\foundation\\StorageService.js, src\\agent\\core\\IntervalManager.js';
  test('the live salad token is plausible (goal survives)', () => {
    const out = _filterImplausibleFilePaths([LIVE], ROOT);
    assert.deepStrictEqual(out, []);
  });
  test('a pure fantasy list stays implausible', () => {
    const out = _filterImplausibleFilePaths(['file:zz/nope.js, zz/also-nope.js'], ROOT);
    assert.strictEqual(out.length, 1);
  });
  test('single-path behaviour unchanged (regression)', () => {
    assert.deepStrictEqual(_filterImplausibleFilePaths(['file:src/agent/core/step-types.js'], ROOT), []);
    assert.strictEqual(_filterImplausibleFilePaths(['file:zz/nope.js'], ROOT).length, 1);
  });
});

describe('v7.9.32 F2c — no backoff for a goal that left the stack', () => {
  const { failurePolicyMixin } = require(path.join(ROOT, 'src/agent/agency/GoalDriverFailurePolicy'));
  const mk = () => Object.assign({}, failurePolicyMixin);
  test('abandoned goal: early return, no burst bookkeeping', async () => {
    const d = mk();
    await d._applyFailurePause('g1', 'Max errors at step 3: x', { status: 'abandoned' });
    assert.strictEqual(d._failureBurst, undefined);
  });
  test('completed and failed goals are skipped too', async () => {
    for (const status of ['completed', 'failed', 'obsolete', 'stalled']) {
      const d = mk();
      await d._applyFailurePause('g2', 'err', { status });
      assert.strictEqual(d._failureBurst, undefined, status + ' should skip');
    }
  });
  test('a live goal still enters the pause path (maps created)', async () => {
    const d = mk();
    try { await d._applyFailurePause('g3', 'Some generic error', { description: 'x' }); }
    catch (_e) { /* bare mixin lacks driver collaborators — guard must not be the reason */ }
    assert(d._failureBurst instanceof Map, 'burst map should exist for live goals');
  });
});

describe('v7.9.32 F3 — one structure truth for both self-assessment organs', () => {
  const reflector = fs.readFileSync(path.join(ROOT, 'src/agent/planning/Reflector.js'), 'utf8');
  const fitness = fs.readFileSync(path.join(ROOT, 'scripts/architectural-fitness.js'), 'utf8');
  test('Reflector LOC threshold equals fitness WARN_THRESHOLD (cross-pin)', () => {
    const r = reflector.match(/OPTIMIZE_LOC_THRESHOLD = (\d+)/);
    // The fitness script declares several WARN_THRESHOLD constants in
    // different guard scopes — anchor the LOC one via its context line.
    const lines = fitness.split('\n');
    // Anchor: the declaration nearest ABOVE the `lines > WARN_THRESHOLD`
    // comparison of the file-size guard — unambiguous across scopes.
    const useIdx = lines.findIndex(l => /lines > WARN_THRESHOLD/.test(l));
    let loc = null;
    for (let i = useIdx; i >= 0; i--) {
      const m = lines[i].match(/WARN_THRESHOLD = (\d+)/);
      if (m) { loc = m[1]; break; }
    }
    assert(r && loc, 'threshold constants not found');
    assert.strictEqual(r[1], loc, `Reflector ${r && r[1]} vs fitness LOC ${loc}`);
  });
  test('dependency threshold raised to 15 and wired into the check', () => {
    assert(/OPTIMIZE_DEP_THRESHOLD = 15/.test(reflector));
    assert(/requires\.length > OPTIMIZE_DEP_THRESHOLD/.test(reflector));
    assert(/lines > OPTIMIZE_LOC_THRESHOLD/.test(reflector));
  });
});

describe('v7.9.32 F4a — reports condense node arrays to labels', () => {
  const { _condenseNodeArray } = require(path.join(ROOT, 'src/agent/revolution/AgentLoopRecovery'));
  const nodes = JSON.stringify([
    { node: { id: 'n1', label: 'GoalDriverFailurePolicy insight', properties: { full: 'x'.repeat(400) } } },
    { node: { id: 'n2', label: 'BootRecovery wiring', properties: { full: 'y'.repeat(400) } } },
    { node: { id: 'n3', label: 'Third hit' } },
  ]);
  test('node-array JSON becomes a capped label list without properties', () => {
    const out = _condenseNodeArray(nodes);
    assert(out.startsWith('3 graph hits:'), out.slice(0, 40));
    assert(out.includes('GoalDriverFailurePolicy insight'));
    assert(!out.includes('properties'));
  });
  test('plain text and non-node JSON pass through untouched', () => {
    assert.strictEqual(_condenseNodeArray('normal step output'), 'normal step output');
    assert.strictEqual(_condenseNodeArray('[1,2,3]'), '[1,2,3]');
  });
});

describe('v7.9.32 F5 — flight recorder name truth + migration', () => {
  const { CrashLog } = require(path.join(ROOT, 'src/agent/core/CrashLog'));
  const tmp = () => { const d = path.join(os.tmpdir(), 'g32-fr-' + Date.now() + Math.random().toString(36).slice(2, 6)); fs.mkdirSync(d, { recursive: true }); return d; };
  test('legacy crash.log (and .1) migrate once to flight-recorder.log', () => {
    const dir = tmp();
    fs.writeFileSync(path.join(dir, 'crash.log'), '[2026-07-05T14:45:48.512Z] [WARN ] [PeerTransport] legacy line\n');
    fs.writeFileSync(path.join(dir, 'crash.log.1'), 'rotated');
    const cl = new CrashLog(dir);
    assert(fs.existsSync(path.join(dir, 'flight-recorder.log')), 'migrated file missing');
    assert(fs.existsSync(path.join(dir, 'flight-recorder.log.1')), 'rotated companion missing');
    assert(!fs.existsSync(path.join(dir, 'crash.log')), 'legacy should be renamed away');
    cl.start();
    const entries = cl.getRecent(10);
    assert.strictEqual(entries.length, 1, 'migrated entry should load');
    cl.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  test('an existing flight-recorder.log is never clobbered by a stray legacy file', () => {
    const dir = tmp();
    fs.writeFileSync(path.join(dir, 'flight-recorder.log'), '[2026-07-05T15:00:00.000Z] [ERROR] [New] keep me\n');
    fs.writeFileSync(path.join(dir, 'crash.log'), '[2026-07-05T14:00:00.000Z] [WARN ] [Old] stray\n');
    new CrashLog(dir); // eslint-disable-line no-new
    const kept = fs.readFileSync(path.join(dir, 'flight-recorder.log'), 'utf8');
    assert(kept.includes('keep me'));
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

if (require.main === module) run();
