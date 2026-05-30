#!/usr/bin/env node
// ============================================================
// GENESIS — test/modules/v7917-trajectory-calibration.test.js
//
// v7.9.17 (TrajectoryCalibration: silent reality-check / ternary
// sign-score for SelfTrajectory). Covers the new service, the new
// EventCounter.summaryBetween window, the prediction-mechanism-review
// PSE-kind registration, the /trajectory review|calibration handlers,
// and the two structural guards (classifier-separation + silent
// two-stage contract).
//
//   1. Registration — event in the catalog; commit emits it; manifest
//      registers + wires the service; start + teardown lists; the PSE
//      kind in Settings/prompts/ContentSanity.
//   2. EventCounter.summaryBetween — bounded (since, until] window;
//      open at either end; summary/countSince unchanged.
//   3. Ternary mechanic — matched / opposite / expected-null /
//      actual-null / zero-on-either-side → null.
//   4. wachstum — durable two-window success-rate sign-delta; no prior
//      cycle → null; empty window → null.
//   5. schwaeche — commit-snapshot capability delta; task type absent in
//      a snapshot → null; no task type classified → null.
//   6. Offline / record-only / value — offline classifier → expected
//      null (not 0); offline embed → value-drift null (not 0); the four
//      record-only fields produce no score; value drift is a measured
//      number with no threshold.
//   7. Handler — /trajectory review routes + renders + emits the manual
//      prediction-mechanism-review thought with cycle/field refs;
//      /trajectory calibration shows history + per-field null-rate.
//   8. Guards — the classifier is a SEPARATE neutral classifier (never a
//      Genesis self-statement generator); no non-dashboard module reads
//      the calibration file; no service receives the calibration service
//      as a constructor dependency.
//
// Offline by construction: the model and embedding services are
// deterministic fakes. Storage is a real StorageService in a temp dir.
// ============================================================

'use strict';

const { describe, test, assert, assertEqual, run } = require('../harness');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const { StorageService } = require(path.join(ROOT, 'src/agent/foundation/StorageService'));
const TC = require(path.join(ROOT, 'src/agent/cognitive/TrajectoryCalibration'));
const {
  TrajectoryCalibration, DIRECTIONS_FILE, CALIBRATION_FILE, SIGN_FIELDS, RECORD_FIELDS,
} = TC;
const EC = require(path.join(ROOT, 'src/agent/cognitive/EventCounter'));
const { EVENTS } = require(path.join(ROOT, 'src/agent/core/EventTypes'));
const { commandHandlersTrajectory } =
  require(path.join(ROOT, 'src/agent/hexagonal/CommandHandlersTrajectory'));

// ── fixtures ────────────────────────────────────────────────

function freshDir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'tc-test-')); }

// Deterministic keyword classifier. besser→+1, schlechter→-1,
// gleich→0, anders→null. task_type from a keyword. offline → no method.
function fakeModel({ offline = false, throws = false } = {}) {
  if (offline) return {}; // no chatStructured → "model absent"
  return {
    chatStructured: async (_sys, msgs) => {
      if (throws) throw new Error('backend down');
      const t = String(msgs[0].content).toLowerCase();
      const direction = t.includes('besser') ? 1
        : t.includes('schlechter') ? -1
        : t.includes('gleich') ? 0
        : null;
      const task_type = t.includes('test') ? 'testing'
        : t.includes('plan') ? 'planning'
        : t.includes('code') ? 'code-gen'
        : null;
      return { direction, task_type };
    },
  };
}

// Deterministic embedder. Distinct texts → distinct unit vectors;
// identical text → identical vector (drift 0). offline → embed null.
function fakeEmbed({ offline = false } = {}) {
  const VEC = {
    'kindness': [1, 0],
    'kindness and rigor': [0.6, 0.8], // cosine with [1,0] = 0.6 → drift 0.4
  };
  return {
    embed: async (text) => (offline ? null : (VEC[String(text).trim()] || [0, 1])),
    cosineSimilarity: (a, b) => {
      if (!a || !b) return 0;
      const dot = a[0] * b[0] + a[1] * b[1];
      const na = Math.hypot(a[0], a[1]); const nb = Math.hypot(b[0], b[1]);
      return na && nb ? dot / (na * nb) : 0;
    },
  };
}

function fakeCSM(profile) { return { getCapabilityProfile: () => profile }; }
function fakeEventCounter(byTypeByWindow) {
  // byTypeByWindow: fn(since, until) → byType map
  return { summaryBetween: (since, until) => ({ total: 0, byType: byTypeByWindow(since, until), byDay: {} }) };
}
function fakeSelfTrajectory(entries) { return { readEntries: () => entries }; }

function entry(id, start, end, fields) {
  return { cycle_id: id, wallclock_start: start, wallclock_end: end, fields };
}
const FULL = (over = {}) => Object.assign(
  { wachstum: 'x', schwaeche: 'y', traits: 'a', emotion: 'b', beziehung: 'c', value: 'v' }, over);

function build({ storage, model, embed, csm, ec, st } = {}) {
  const dir = freshDir();
  const s = storage || new StorageService(dir);
  const tc = new TrajectoryCalibration({ storage: s });
  if (model !== undefined) tc.model = model;
  if (embed !== undefined) tc.embeddingService = embed;
  if (csm !== undefined) tc.cognitiveSelfModel = csm;
  if (ec !== undefined) tc.eventCounter = ec;
  if (st !== undefined) tc.selfTrajectory = st;
  return { tc, storage: s, dir };
}

function readLines(storage, file) {
  const raw = storage.readText(file, '');
  return raw.split('\n').filter(Boolean).map(l => JSON.parse(l));
}

// ── 1. registration ─────────────────────────────────────────

describe('v7.9.17 — registration', () => {
  test('EventTypes catalog defines trajectory:committed', () => {
    assertEqual(EVENTS.TRAJECTORY.COMMITTED, 'trajectory:committed');
  });

  test('SelfTrajectory.commit emits trajectory:committed (fire-and-forget)', async () => {
    const ST = require(path.join(ROOT, 'src/agent/cognitive/SelfTrajectory'));
    const dir = freshDir();
    const storage = new StorageService(dir);
    const fired = [];
    const bus = { fire: (evt, data) => fired.push({ evt, data }), on: () => () => {} };
    const genome = { getTraits: () => ({ curiosity: 0.5 }) };
    const st = new ST.SelfTrajectory({ storage, genome, bus });
    await st.generateDraft();
    for (const k of ST.FIELD_NAMES) st.setDraftField(k, `seed-${k}`);
    st.setDraftNote('genesis', 'gn'); st.setDraftNote('garrus', 'hn');
    const r = st.commit();
    assert(r.ok, 'commit ok');
    const ev = fired.find(f => f.evt === 'trajectory:committed');
    assert(ev, 'trajectory:committed fired');
    assertEqual(ev.data.entry.cycle_id, r.entry.cycle_id, 'payload carries the entry');
  });

  test('phase9 manifest registers trajectoryCalibration with all source late-bindings', () => {
    const m = fs.readFileSync(path.join(ROOT, 'src/agent/manifest/phase9-cognitive.js'), 'utf8');
    assert(/'trajectoryCalibration'/.test(m), 'service registered');
    for (const dep of ['model', 'embeddingService', 'cognitiveSelfModel', 'eventCounter', 'selfTrajectory']) {
      assert(new RegExp(`service:\\s*'${dep}'`).test(m), `late-binds ${dep}`);
    }
  });

  test('phase5 manifest wires trajectoryCalibration + innerSpeech onto CommandHandlers', () => {
    const m = fs.readFileSync(path.join(ROOT, 'src/agent/manifest/phase5-hexagonal.js'), 'utf8');
    assert(/prop:\s*'trajectoryCalibration'/.test(m), 'trajectoryCalibration late-bound on handlers');
    assert(/prop:\s*'innerSpeech'/.test(m), 'innerSpeech late-bound on handlers');
  });

  test('start sequence + teardown list include trajectoryCalibration', () => {
    const wire = fs.readFileSync(path.join(ROOT, 'src/agent/AgentCoreWire.js'), 'utf8');
    const health = fs.readFileSync(path.join(ROOT, 'src/agent/AgentCoreHealth.js'), 'utf8');
    assert(/start\('trajectoryCalibration'\)/.test(wire), 'started in boot sequence');
    assert(/'trajectoryCalibration'/.test(health), 'in TO_STOP teardown list');
  });

  test('prediction-mechanism-review registered in Settings, prompts, ContentSanity', () => {
    const settings = fs.readFileSync(path.join(ROOT, 'src/agent/foundation/Settings.js'), 'utf8');
    const prompts = fs.readFileSync(path.join(ROOT, 'src/agent/cognitive/proactiveSelfExpression/prompts.js'), 'utf8');
    const sanity = fs.readFileSync(path.join(ROOT, 'src/agent/cognitive/proactiveSelfExpression/ContentSanity.js'), 'utf8');
    assert(/'prediction-mechanism-review'/.test(settings), 'in Settings (allowedKinds + floors)');
    assert(/'prediction-mechanism-review'/.test(prompts), 'has a KIND_PROMPT template');
    assert(/'prediction-mechanism-review'/.test(sanity), 'requires a concrete ref');
  });
});

// ── 2. EventCounter.summaryBetween ──────────────────────────

describe('v7.9.17 — EventCounter.summaryBetween', () => {
  function ecWith(lines) {
    const dir = freshDir(); const storage = new StorageService(dir);
    const ec = new EC.EventCounter({ storage });
    for (const l of lines) storage.appendText(EC.JOURNAL_FILE, JSON.stringify(l) + '\n');
    return ec;
  }
  const L = [
    { ts: '2026-01-01T00:00:00.000Z', type: 'goal:completed' },
    { ts: '2026-01-10T00:00:00.000Z', type: 'goal:failed' },
    { ts: '2026-01-20T00:00:00.000Z', type: 'goal:completed' },
    { ts: '2026-01-30T00:00:00.000Z', type: 'goal:abandoned' },
  ];

  test('bounded window (since, until]: excludes ≤since, includes =until', () => {
    const ec = ecWith(L);
    // (Jan-01, Jan-20] → Jan-10 and Jan-20, NOT Jan-01 (exclusive), NOT Jan-30
    const s = ec.summaryBetween('2026-01-01T00:00:00.000Z', '2026-01-20T00:00:00.000Z');
    assertEqual(s.total, 2, 'two events in window');
    assertEqual(s.byType['goal:failed'], 1);
    assertEqual(s.byType['goal:completed'], 1);
  });

  test('open lower bound (null, until]', () => {
    const ec = ecWith(L);
    const s = ec.summaryBetween(null, '2026-01-10T00:00:00.000Z');
    assertEqual(s.total, 2, 'Jan-01 + Jan-10');
  });

  test('open upper bound (since, null] equals open-ended count', () => {
    const ec = ecWith(L);
    const s = ec.summaryBetween('2026-01-10T00:00:00.000Z', null);
    assertEqual(s.total, 2, 'Jan-20 + Jan-30 (Jan-10 excluded)');
  });

  test('summary/countSince unchanged (half-open >since, no upper bound)', () => {
    const ec = ecWith(L);
    assertEqual(ec.countSince('2026-01-10T00:00:00.000Z'), 2, 'countSince still >since');
    assertEqual(ec.summary('2026-01-10T00:00:00.000Z').total, 2, 'summary still >since');
    assertEqual(ec.summary().total, 4, 'summary() all');
  });
});

// ── 3. ternary mechanic ─────────────────────────────────────

describe('v7.9.17 — ternary mechanic', () => {
  const { tc } = build({});
  test('matched (+1 vs +1) → +1', () => assertEqual(tc._ternary(1, 1), 1));
  test('opposite (+1 vs -1) → -1', () => assertEqual(tc._ternary(1, -1), -1));
  test('matched (-1 vs -1) → +1', () => assertEqual(tc._ternary(-1, -1), 1));
  test('expected null → null', () => assertEqual(tc._ternary(null, 1), null));
  test('actual null → null', () => assertEqual(tc._ternary(1, null), null));
  test('expected 0 → null (no-change claim is not scored)', () => assertEqual(tc._ternary(0, 1), null));
  test('actual 0 → null (flat trend is not scored)', () => assertEqual(tc._ternary(1, 0), null));
});

// ── 4. wachstum (durable two-window) ────────────────────────

describe('v7.9.17 — wachstum', () => {
  // prev cycle: 1/2 completed (rate .5); cur cycle: 2/2 completed (rate 1) → improving → +1
  const prev = entry('C1', '2026-01-01T00:00:00.000Z', '2026-01-15T00:00:00.000Z', FULL());
  const cur = entry('C2', '2026-01-15T00:00:00.000Z', '2026-01-29T00:00:00.000Z', FULL({ wachstum: 'ich werde besser' }));
  const ec = fakeEventCounter((since) => {
    // prev window keyed by its start, cur by its start
    if (since === '2026-01-01T00:00:00.000Z') return { 'goal:completed': 1, 'goal:failed': 1 };
    if (since === '2026-01-15T00:00:00.000Z') return { 'goal:completed': 2 };
    return {};
  });

  test('actual wachstum = sign(rateN - rateP); improving → +1', () => {
    const { tc } = build({ ec, st: fakeSelfTrajectory([prev, cur]) });
    assertEqual(tc._actualWachstum(cur, prev), 1);
  });

  test('no prior cycle → null', () => {
    const { tc } = build({ ec, st: fakeSelfTrajectory([cur]) });
    assertEqual(tc._actualWachstum(cur, null), null);
  });

  test('empty window (no goal events) → successRate null → actual null', () => {
    const ecEmpty = fakeEventCounter(() => ({}));
    const { tc } = build({ ec: ecEmpty, st: fakeSelfTrajectory([prev, cur]) });
    assertEqual(tc._actualWachstum(cur, prev), null);
  });
});

// ── 5. schwaeche (commit-snapshot delta) ────────────────────

describe('v7.9.17 — schwaeche', () => {
  test('actual schwaeche = sign(snapN[tt] - snapP[tt]); capability up → +1', () => {
    const { tc } = build({});
    const curDir = { schwaeche_task_type: 'testing', capability_snapshot: { testing: 0.85 } };
    const prevDir = { schwaeche_task_type: 'testing', capability_snapshot: { testing: 0.70 } };
    assertEqual(tc._actualSchwaeche(curDir, prevDir), 1);
  });

  test('task type absent in prior snapshot → null', () => {
    const { tc } = build({});
    const curDir = { schwaeche_task_type: 'testing', capability_snapshot: { testing: 0.85 } };
    const prevDir = { schwaeche_task_type: 'testing', capability_snapshot: { 'code-gen': 0.5 } };
    assertEqual(tc._actualSchwaeche(curDir, prevDir), null);
  });

  test('no task type classified → null', () => {
    const { tc } = build({});
    const curDir = { schwaeche_task_type: null, capability_snapshot: { testing: 0.85 } };
    const prevDir = { schwaeche_task_type: null, capability_snapshot: { testing: 0.70 } };
    assertEqual(tc._actualSchwaeche(curDir, prevDir), null);
  });
});

// ── 6. offline / record-only / value ────────────────────────

describe('v7.9.17 — offline, record-only, value', () => {
  const e = entry('C1', '2026-01-01T00:00:00.000Z', '2026-01-15T00:00:00.000Z',
    FULL({ wachstum: 'ich werde besser', schwaeche: 'ich bin schlechter beim test schreiben', value: 'kindness' }));

  test('offline classifier → expected directions explicit null (not 0), model_available false', async () => {
    const { tc, storage } = build({ model: fakeModel({ offline: true }), csm: fakeCSM({}), st: fakeSelfTrajectory([e]) });
    await tc._recordDirections(e);
    const [line] = readLines(storage, DIRECTIONS_FILE);
    assertEqual(line.expected.wachstum, null, 'wachstum null');
    assertEqual(line.expected.schwaeche, null, 'schwaeche null');
    assertEqual(line.model_available, false, 'model flagged unavailable');
  });

  test('classifier that throws → expected null (graceful)', async () => {
    const { tc, storage } = build({ model: fakeModel({ throws: true }), csm: fakeCSM({}), st: fakeSelfTrajectory([e]) });
    await tc._recordDirections(e);
    const [line] = readLines(storage, DIRECTIONS_FILE);
    assertEqual(line.expected.wachstum, null);
    assertEqual(line.expected.schwaeche, null);
  });

  test('offline embed → value_drift null (NOT 0)', async () => {
    const prior = entry('C0', '2025-12-15T00:00:00.000Z', '2025-12-31T00:00:00.000Z', FULL({ value: 'kindness' }));
    const { tc, storage } = build({
      model: fakeModel({}), embed: fakeEmbed({ offline: true }),
      csm: fakeCSM({}), st: fakeSelfTrajectory([prior, e]),
    });
    await tc._recordDirections(e);
    const [line] = readLines(storage, DIRECTIONS_FILE);
    assertEqual(line.value_drift, null, 'value drift null offline, not 0');
  });

  test('value drift is a measured number (no threshold) when embeddings present', async () => {
    const prior = entry('C0', '2025-12-15T00:00:00.000Z', '2025-12-31T00:00:00.000Z', FULL({ value: 'kindness' }));
    const cur = entry('C1', '2026-01-01T00:00:00.000Z', '2026-01-15T00:00:00.000Z', FULL({ value: 'kindness and rigor' }));
    const { tc, storage } = build({
      model: fakeModel({}), embed: fakeEmbed({}),
      csm: fakeCSM({}), st: fakeSelfTrajectory([prior, cur]),
    });
    await tc._recordDirections(cur);
    const [line] = readLines(storage, DIRECTIONS_FILE);
    assertEqual(typeof line.value_drift, 'number', 'a number, not a boolean verdict');
    assert(Math.abs(line.value_drift - 0.4) < 1e-6, `drift ≈ 0.4 (got ${line.value_drift})`);
  });

  test('record-only fields produce NO score key (only wachstum/schwaeche scored)', async () => {
    const prev = entry('C0', '2025-12-15T00:00:00.000Z', '2025-12-31T00:00:00.000Z', FULL());
    const cur = entry('C1', '2026-01-01T00:00:00.000Z', '2026-01-15T00:00:00.000Z',
      FULL({ wachstum: 'ich werde besser', schwaeche: 'ich bin besser beim test schreiben' }));
    const ec = fakeEventCounter(() => ({ 'goal:completed': 1 }));
    const csm = fakeCSM({ testing: { confidenceLower: 0.8 } });
    const { tc, storage } = build({ model: fakeModel({}), embed: fakeEmbed({}), csm, ec, st: fakeSelfTrajectory([prev, cur]) });
    await tc._recordDirections(prev);
    await tc._recordDirections(cur);
    const r = tc.reviewCycle();
    assert(r.ok, 'review ok');
    assertEqual(Object.keys(r.scores).sort().join(','), 'schwaeche,wachstum', 'only the two sign-fields scored');
    for (const f of RECORD_FIELDS) assert(!(f in r.scores), `${f} not scored`);
    // positions of record-only fields are recorded on the commit line
    const dirs = readLines(storage, DIRECTIONS_FILE);
    for (const f of RECORD_FIELDS) assert(f in dirs[dirs.length - 1].positions, `${f} position recorded`);
  });
});

// ── 7. handler routing ──────────────────────────────────────

describe('v7.9.17 — handler', () => {
  // A real TC over a temp store, with two committed cycles' directions
  // pre-seeded so reviewCycle produces a matched schwaeche score.
  function seededHandler() {
    const prev = entry('C0', '2025-12-15T00:00:00.000Z', '2025-12-31T00:00:00.000Z', FULL());
    const cur = entry('C1', '2026-01-01T00:00:00.000Z', '2026-01-15T00:00:00.000Z',
      FULL({ schwaeche: 'ich bin besser beim test schreiben' }));
    const ec = fakeEventCounter((since) =>
      since === '2025-12-15T00:00:00.000Z' ? { 'goal:completed': 1, 'goal:failed': 1 } : { 'goal:completed': 2 });
    const csm = fakeCSM({ testing: { confidenceLower: 0.85 } });
    const { tc, storage } = build({ model: fakeModel({}), embed: fakeEmbed({}), csm, ec, st: fakeSelfTrajectory([prev, cur]) });
    return { tc, storage, prev, cur };
  }

  test('/trajectory review routes to reviewCycle and renders an outcome label', async () => {
    const { tc } = seededHandler();
    // seed both directions lines
    await tc._recordDirections(tc.selfTrajectory.readEntries()[0]);
    await tc._recordDirections(tc.selfTrajectory.readEntries()[1]);
    const emitted = [];
    const h = Object.assign(
      { selfTrajectory: tc.selfTrajectory, trajectoryCalibration: tc,
        innerSpeech: { emit: (text, kind, meta) => emitted.push({ text, kind, meta }) } },
      commandHandlersTrajectory);
    const out = await h.trajectory('/trajectory review');
    assert(/Calibration review/.test(out), 'review header rendered');
    assert(/matched|opposite|no score/.test(out), 'an outcome label rendered');
  });

  test('/trajectory review emits prediction-mechanism-review with cycle + field refs', async () => {
    const { tc } = seededHandler();
    await tc._recordDirections(tc.selfTrajectory.readEntries()[0]);
    await tc._recordDirections(tc.selfTrajectory.readEntries()[1]);
    const emitted = [];
    const h = Object.assign(
      { selfTrajectory: tc.selfTrajectory, trajectoryCalibration: tc,
        innerSpeech: { emit: (text, kind, meta) => emitted.push({ text, kind, meta }) } },
      commandHandlersTrajectory);
    await h.trajectory('/trajectory review');
    const ev = emitted.find(e => e.kind === 'prediction-mechanism-review');
    assert(ev, 'prediction-mechanism-review emitted');
    assertEqual(ev.meta.contextRefs.cycleId, 'C1', 'cycle ref present');
    assert(Array.isArray(ev.meta.contextRefs.fields), 'field refs present');
  });

  test('/trajectory review with no entries → friendly message, no throw', async () => {
    const { tc } = build({ st: fakeSelfTrajectory([]) });
    const h = Object.assign({ selfTrajectory: tc.selfTrajectory, trajectoryCalibration: tc }, commandHandlersTrajectory);
    const out = await h.trajectory('/trajectory review');
    assert(/No committed cycle/.test(out), 'friendly empty message');
  });

  test('/trajectory review without calibration service → "not available"', async () => {
    const st = fakeSelfTrajectory([entry('C1', '2026-01-01T00:00:00.000Z', '2026-01-15T00:00:00.000Z', FULL())]);
    const h = Object.assign({ selfTrajectory: st, trajectoryCalibration: null }, commandHandlersTrajectory);
    const out = await h.trajectory('/trajectory review');
    assert(/not available/i.test(out), 'service-absent message');
  });

  test('/trajectory calibration shows history + per-field null-rate', async () => {
    const { tc } = seededHandler();
    await tc._recordDirections(tc.selfTrajectory.readEntries()[0]);
    await tc._recordDirections(tc.selfTrajectory.readEntries()[1]);
    tc.reviewCycle(); // produce one calibration row
    const h = Object.assign({ selfTrajectory: tc.selfTrajectory, trajectoryCalibration: tc }, commandHandlersTrajectory);
    const out = await h.trajectory('/trajectory calibration');
    assert(/Calibration/.test(out), 'calibration header');
    assert(/null-rate/.test(out), 'per-field null-rate shown');
    assert(/schwaeche/.test(out), 'fields listed');
  });
});

// ── 8. structural guards ────────────────────────────────────

describe('v7.9.17 — classifier separation + silent contract', () => {
  const src = fs.readFileSync(path.join(ROOT, 'src/agent/cognitive/TrajectoryCalibration.js'), 'utf8');

  test('the classifier is a SEPARATE neutral classifier (states it is NOT the author)', () => {
    // The expected-side direction must NOT come from Genesis judging itself.
    assert(/NOT the author/i.test(src), 'classifier prompt declares non-authorship');
    // And the service must not pull a Genesis self-statement generator for it.
    assert(!/generateDraft|selfStatement|innerSpeech\.|proactiveSelfExpression/.test(src),
      'no Genesis self-statement generator used for classification');
  });

  test('silent contract A: no NON-dashboard module reads the calibration file', () => {
    const files = listJs(path.join(ROOT, 'src'));
    const offenders = [];
    for (const f of files) {
      const txt = fs.readFileSync(f, 'utf8');
      if (!txt.includes('self-trajectory-calibration')) continue;
      const base = path.basename(f);
      // Allowed: the service that owns the file. The handler reads it ONLY
      // through the service's getters (it must not name the file itself).
      if (base === 'TrajectoryCalibration.js') continue;
      offenders.push(base);
    }
    assertEqual(offenders.join(','), '', `only the service names the calibration file (offenders: ${offenders.join(',')})`);
  });

  test('silent contract B: no service receives trajectoryCalibration as a constructor dependency', () => {
    const manifests = listJs(path.join(ROOT, 'src/agent/manifest'));
    const offenders = [];
    for (const f of manifests) {
      const txt = fs.readFileSync(f, 'utf8');
      // A constructor dep appears in a deps:[...] array or a c.resolve(...)
      // call. Late-binding (service:'trajectoryCalibration') is allowed —
      // that is the one-way observer wiring, not an injection into logic.
      if (/deps:\s*\[[^\]]*'trajectoryCalibration'/.test(txt)) offenders.push(path.basename(f) + ' (deps)');
      if (/resolve\(\s*'trajectoryCalibration'\s*\)/.test(txt)) offenders.push(path.basename(f) + ' (resolve)');
    }
    assertEqual(offenders.join(','), '', `calibration never injected as a dep (offenders: ${offenders.join(',')})`);
  });
});

function listJs(dir) {
  const out = [];
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name);
    const st = fs.statSync(full);
    if (st.isDirectory()) out.push(...listJs(full));
    else if (name.endsWith('.js')) out.push(full);
  }
  return out;
}

run();
