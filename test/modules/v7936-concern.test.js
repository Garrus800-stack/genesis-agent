// ============================================================
// TEST — v7.9.36 Concern-for-User (E3)
// The relationship gesture and its guards: the two-source rule
// (chat-derived never alone), the generic per-kind wallclock cap
// (gate 6.5) with decline respect, aggregate-only evidence, the
// concern shape checks (bitterness rejects, core markers required),
// the untouched neighbors, and the wiring source relations.
// Plan: e3-concern-plan-v3.md (G1=a, G2=a, G3=30d; reviews K1–K14 + F1–F7).
// ============================================================

const { describe, test, run } = require('../harness');
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const { ConcernMonitor } = require(path.join(ROOT, 'src/agent/cognitive/ConcernMonitor'));
const { runGates } = require(path.join(ROOT, 'src/agent/cognitive/proactiveSelfExpression/HardGates'));
const { runSanity } = require(path.join(ROOT, 'src/agent/cognitive/proactiveSelfExpression/ContentSanity'));
const { StateStore } = require(path.join(ROOT, 'src/agent/cognitive/proactiveSelfExpression/StateStore'));

// ── Doubles ─────────────────────────────────────────────────

const NOW = 1751900000000;
function mkClock(t = NOW) { const c = { t, now: () => c.t }; return c; }

function journalOf(sessions) {
  return sessions.map(s => JSON.stringify({
    ts: new Date(s.end).toISOString(), type: 'session:ending', durationMs: s.dur,
  })).join('\n') + '\n';
}
const LONG_DAYS = journalOf([1, 1.5, 2, 2.5, 3].map(d => ({ end: NOW - d * 86400000, dur: 5 * 3600000 })));

function mkMonitor({ journal = '', report = null, clock = mkClock() } = {}) {
  const emitted = [];
  const m = new ConcernMonitor({
    bus: { on: () => () => {} },
    storage: { readText: () => journal },
    clock,
  });
  if (report) m.userModel = { getReport: () => report };
  m.innerSpeech = { emit: (text, kind, md) => emitted.push({ text, kind, md }) };
  return { m, emitted, clock };
}

const STRAINED = { patience: 0.2, satisfaction: 0.2 };
const FINE = { patience: 0.8, satisfaction: 0.8 };

// ── Two-source rule ─────────────────────────────────────────

describe('v7.9.36 E3 — the two-source rule', () => {
  test('journal-only fires nothing (chat source silent)', () => {
    const { m, emitted } = mkMonitor({ journal: LONG_DAYS, report: FINE });
    m._onSessionEnd();
    assert.strictEqual(emitted.length, 0);
  });

  test('chat-only fires nothing (journal source silent)', () => {
    const { m, emitted } = mkMonitor({ journal: journalOf([]), report: STRAINED });
    m._onSessionEnd();
    assert.strictEqual(emitted.length, 0);
  });

  test('both sources → exactly one positional emit with both origins in contextRefs', () => {
    const { m, emitted } = mkMonitor({ journal: LONG_DAYS, report: STRAINED });
    m._onSessionEnd();
    assert.strictEqual(emitted.length, 1);
    assert.strictEqual(emitted[0].kind, 'concern');
    assert.deepStrictEqual(emitted[0].md.contextRefs.sources, ['journal', 'chat-model']);
    assert.strictEqual(emitted[0].md.significance, 0.9);
    assert.strictEqual(emitted[0].md.novelty, 0.7);
  });

  test('chat signal needs BOTH fields low (patience alone is not strain)', () => {
    const { m, emitted } = mkMonitor({ journal: LONG_DAYS, report: { patience: 0.2, satisfaction: 0.8 } });
    m._onSessionEnd();
    assert.strictEqual(emitted.length, 0);
  });

  test('night indicator derives start = ts − durationMs (6h total, 3 night starts)', () => {
    const night = (d) => { const s = new Date(NOW - d * 86400000); s.setHours(23, 30, 0, 0); return { end: s.getTime() + 2 * 3600000, dur: 2 * 3600000 }; };
    const { m, emitted } = mkMonitor({ journal: journalOf([night(1), night(2), night(3)]), report: STRAINED });
    m._onSessionEnd();
    assert.strictEqual(emitted.length, 1);
    assert.strictEqual(emitted[0].md.contextRefs.evidence.nightSessions, 3);
  });

  test('evidence stays aggregate: no raw affect numbers, no chat quotes in text', () => {
    const { m, emitted } = mkMonitor({ journal: LONG_DAYS, report: STRAINED });
    m._onSessionEnd();
    assert(!emitted[0].text.includes('0.2'));
    assert(!emitted[0].text.includes('25'));
    assert.strictEqual(typeof emitted[0].md.contextRefs.evidence.totalHours, 'number');
  });

  test('24h in-memory self-throttle: second trigger stays silent, frees after', () => {
    const { m, emitted, clock } = mkMonitor({ journal: LONG_DAYS, report: STRAINED });
    m._onSessionEnd(); m._onSessionEnd();
    assert.strictEqual(emitted.length, 1);
    clock.t += 25 * 3600000;
    m._onSessionEnd();
    assert.strictEqual(emitted.length, 2);
  });
});

// ── Gate 6.5: the generic cap ───────────────────────────────

describe('v7.9.36 E3 — per-kind wallclock cap (gate 6.5)', () => {
  const SETTINGS = { enabled: true, allowedKinds: ['concern', 'other'], perKindWallclockCaps: { concern: 604800000 } };
  const st = (o) => ({ now: NOW, lastSelfMessageMs: null, lastUserMessageMs: null, dailyCount: 0, mutedUntilMs: null, ...o });
  const th = (k) => ({ kind: k, significance: 0.9, novelty: 0.7 });

  test('capped kind blocks inside the window, passes after; uncapped kind unaffected', () => {
    const blocked = runGates(th('concern'), st({ lastKindFireMs: NOW - 3600000 }), SETTINGS);
    assert.strictEqual(blocked.reason, 'kind-wallclock-cap');
    assert(runGates(th('concern'), st({ lastKindFireMs: NOW - 8 * 86400000 }), SETTINGS).ok);
    assert(runGates(th('other'), st({ lastKindFireMs: NOW - 1 }), SETTINGS).ok);
  });

  test('decline blocks with its own reason and frees on expiry', () => {
    const d = runGates(th('concern'), st({ kindDeclinedUntilMs: NOW + 86400000 }), SETTINGS);
    assert.strictEqual(d.reason, 'kind-declined');
    assert(runGates(th('concern'), st({ kindDeclinedUntilMs: NOW - 1 }), SETTINGS).ok);
  });

  test('order pins: after kind-not-allowed, before the quality floors', () => {
    assert.strictEqual(runGates(th('stranger'), st({ lastKindFireMs: 1 }), SETTINGS).reason, 'kind-not-allowed');
    const floored = runGates({ kind: 'concern', significance: 0.1, novelty: 0.1 },
      st({}), { ...SETTINGS, perKindFloors: { concern: { sigFloor: 0.8 } } });
    assert.strictEqual(floored.reason, 'per-kind-floor-significance', 'cap silent when window free → floors speak');
    const src = fs.readFileSync(path.join(ROOT, 'src/agent/cognitive/proactiveSelfExpression/HardGates.js'), 'utf8');
    assert(src.indexOf("reason: 'kind-not-allowed'") < src.indexOf('6.5'), 'gate sits after allowlist');
    assert(src.indexOf('6.5') < src.indexOf('// 7. Per-kind floor'), 'gate sits before floors');
  });

  test('store roundtrip on the existing byKind field + new decline field survives load', () => {
    const os = require('os');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'g36-ss-'));
    const s1 = new StateStore({ storageDir: dir }); s1.load();
    s1.recordPublished('concern', NOW);
    s1.setDeclinedUntil('concern', NOW + 5);
    const s2 = new StateStore({ storageDir: dir }); s2.load();
    assert.strictEqual(s2.getLastSelfMessageOfKindMs('concern'), NOW);
    assert.strictEqual(s2.getDeclinedUntilMs('concern'), NOW + 5);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('orchestrator hands both per-kind fields into the gate state (source relation)', () => {
    const src = fs.readFileSync(path.join(ROOT, 'src/agent/cognitive/ProactiveSelfExpression.js'), 'utf8');
    const stateIdx = src.indexOf('lastKindFireMs: this.stateStore.getLastSelfMessageOfKindMs(thought.kind)');
    const gateIdx = src.indexOf('runGates(thought, state, settings)');
    assert(stateIdx > 0 && stateIdx < gateIdx, 'fields built before the gate call');
    assert(src.includes('kindDeclinedUntilMs: this.stateStore.getDeclinedUntilMs?.(thought.kind)'));
    assert(src.includes('declineKind(kind, untilMs)'), 'PSE decline seam present');
  });
});

// ── Decline respect (S4) ────────────────────────────────────

describe('v7.9.36 E3 — decline respect', () => {
  test('decline inside 24h sets a ~30-day window through the PSE seam', () => {
    const { m, clock } = mkMonitor({});
    let declined = null;
    m.proactiveSelfExpression = { declineKind: (k, u) => { declined = { k, u }; } };
    m._onSelfMessage({ kind: 'concern' });
    m._onChatCompleted({ message: 'danke, aber alles gut bei mir' });
    assert.strictEqual(declined.k, 'concern');
    assert.strictEqual(Math.round((declined.u - clock.now()) / 86400000), 30);
  });

  test('outside the 24h window a decline phrase sets nothing', () => {
    const { m, clock } = mkMonitor({});
    let declined = null;
    m.proactiveSelfExpression = { declineKind: () => { declined = true; } };
    m._onSelfMessage({ kind: 'concern' });
    clock.t += 25 * 3600000;
    m._onChatCompleted({ message: 'alles gut' });
    assert.strictEqual(declined, null);
  });
});

// ── Shape checks + guards untouched ─────────────────────────

describe('v7.9.36 E3 — concern shape and untouched neighbors', () => {
  const th = { kind: 'concern' };
  test('bitterness rejects and the suppression entry can carry the text', () => {
    const r = runSanity('Schon wieder so spät — wie geht es dir? Wenn ich falschliege, sag es einfach.', th);
    assert.strictEqual(r.reason, 'concern-bitterness');
    const store = new StateStore({ storageDir: null });
    store.recordSuppression({ thoughtId: 't1', kind: 'concern', reason: r.reason, detail: r.detail, generatedText: 'Schon wieder …' });
    assert.strictEqual(store.getSuppressionLog()[0].generatedTextPreview, 'Schon wieder …');
  });

  test('core markers required: exactly one question and the withdrawal clause', () => {
    assert.strictEqual(runSanity('Wie geht es dir? Und warum? Wenn ich falschliege, sag es einfach.', th).reason, 'concern-shape');
    assert.strictEqual(runSanity('Die letzten Tage waren lang. Wie geht es dir?', th).detail, 'withdrawal clause missing');
    assert(runSanity('Die letzten Tage waren lang. Wie geht es dir gerade? Wenn ich falschliege, sag es einfach.', th).ok);
  });

  test('PRIVATE_KINDS untouched (concern is deliberately public) and monitor never throws', () => {
    const src = fs.readFileSync(path.join(ROOT, 'src/agent/cognitive/proactiveSelfExpression/HardGates.js'), 'utf8');
    const m = src.match(/const PRIVATE_KINDS = new Set\(\[([^\]]*)\]\)/);
    assert(m && m[1].includes('self-state-snapshot') && m[1].includes('rest-mode') && !m[1].includes('concern'));
    const broken = new ConcernMonitor({ bus: { on: () => () => {} }, storage: { readText: () => { throw new Error('x'); } } });
    broken.userModel = { getReport: () => { throw new Error('y'); } };
    broken._onSessionEnd(); // must not throw
    assert(true);
  });
});

if (require.main === module) run();
