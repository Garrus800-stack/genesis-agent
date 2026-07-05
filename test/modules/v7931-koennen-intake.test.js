// ============================================================
// GENESIS — test/modules/v7931-koennen-intake.test.js
// Contract tests for the v7.9.31 skill-acquisition intake (AP-1):
// every forged skill lands as a MATURING CANDIDATE in the Koennen
// pipeline — nothing synthesized installs straight into the live
// registry, and nothing synthesized runs autonomously before a
// human-initiated or human-approved first execution.
//
// Contracts pinned here:
//   A  intake: both forge callers persist pending candidates with
//      origin, generation, crystallizedAt and a first-person biography
//   B  coverage: hasSkillOrCandidate + the daemon's settings catalog
//   C  collision rule and the generation path
//   D  maturation: the ONE shared bump vocabulary + user-driven runs,
//      and the never-trusted invariant for candidate execution
//   E  first-approval gate across all three trust levels
//   F  /skills-pending approve|deny + lister origin markers
//   G  event retirement + promotion makes the skill loadable
// ============================================================

'use strict';

const { describe, test, assert, assertEqual, run } = require('../harness');
const path = require('path');
const os = require('os');
const fs = require('fs');

const ROOT = path.resolve(__dirname, '..', '..');
const { SkillManager } = require(path.join(ROOT, 'src/agent/capabilities/SkillManager'));
const { recordRehearsalOutcome } = require(path.join(ROOT, 'src/agent/capabilities/SkillManagerKoennenIntake'));
const { AutonomousDaemon } = require(path.join(ROOT, 'src/agent/autonomy/AutonomousDaemon'));
const { commandHandlersCode } = require(path.join(ROOT, 'src/agent/hexagonal/CommandHandlersCode'));
const { commandHandlersGoals } = require(path.join(ROOT, 'src/agent/hexagonal/CommandHandlersGoals'));
const { TRUST_LEVELS } = require(path.join(ROOT, 'src/agent/foundation/TrustLevelSystem'));
const { safeJsonParse } = require(path.join(ROOT, 'src/agent/core/utils'));
const { EVENTS, EVENT_STORE_BUS_MAP } = require(path.join(ROOT, 'src/agent/core/EventTypes'));
const { SCHEMAS } = require(path.join(ROOT, 'src/agent/core/EventPayloadSchemas'));

// ── helpers ────────────────────────────────────────────────────

function mkTmp() { return fs.mkdtempSync(path.join(os.tmpdir(), 'v7931-')); }

function spySandbox() {
  const calls = [];
  return {
    calls,
    testPatch: async () => ({ success: true }),
    execute: async (code) => { calls.push(code); return { output: '"ok"', error: null }; },
  };
}

function fakeLLM(name) {
  return {
    chat: async () => [
      '```json',
      JSON.stringify({ name, description: 'd', entry: 'index.js', interface: {} }),
      '```',
      '```javascript',
      'module.exports = { run: () => ({ ok: true }) };',
      '```',
    ].join('\n'),
  };
}

function mkManager(tmp, { sandbox, model, bus } = {}) {
  const koennenDir = path.join(tmp, '.genesis', 'koennen', 'skills-pending');
  const sm = new SkillManager(
    path.join(tmp, 'skills'), sandbox || spySandbox(), model || null,
    { build: () => 'prompt' }, null, { koennenDir, bus },
  );
  sm._codeSafety = { scanCode: () => ({ safe: true, issues: [] }) };
  sm.effectivenessTracker = {
    forgot: [], recs: [],
    forget(n) { this.forgot.push(n); },
    recordInvocation(n, s, meta) { this.recs.push({ n, s, src: meta && meta.source }); },
    getStats: () => null,
  };
  return { sm, koennenDir };
}

function installCandidate(sm, name, koennen, code) {
  const dir = path.join(sm.koennenDir, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'skill-manifest.json'), JSON.stringify({
    name, description: 'd', entry: 'index.js',
    status: koennen.status || 'pending',
    koennen: { rehearsalCount: 0, rehearsedInputHashes: [], ...koennen, status: undefined },
  }));
  fs.writeFileSync(path.join(dir, 'index.js'),
    code || 'module.exports = { run: () => ({ ok: true }) };');
  return dir;
}

function readManifest(koennenDir, name) {
  return JSON.parse(fs.readFileSync(path.join(koennenDir, name, 'skill-manifest.json'), 'utf8'));
}

// Drive the REAL picker function extracted from the rehearsal activity.
// Deliberate source-reading test (entanglement axis): if the picker is
// renamed or restructured, this extraction fails LOUDLY, not silently.
function pickEligible(koennenDir, trustLevel) {
  const src = fs.readFileSync(
    path.join(ROOT, 'src/agent/autonomy/activities/SkillRehearsal.js'), 'utf8');
  const m = src.match(/function _pickRehearsalTarget[\s\S]*?\n\}/);
  assert(m, 'picker extraction failed — did _pickRehearsalTarget move or get renamed?');
  const fn = new Function('fs', 'path', 'safeJsonParse', 'TRUST_LEVELS',
    'return ' + m[0])(fs, path, safeJsonParse, TRUST_LEVELS);
  const out = []; const flipped = [];
  let t;
  while ((t = fn(koennenDir, trustLevel))) {
    out.push(t.name);
    const mp = path.join(t.dir, 'skill-manifest.json');
    const man = JSON.parse(fs.readFileSync(mp, 'utf8'));
    flipped.push([mp, man.status]);
    man.status = 'discarded';
    fs.writeFileSync(mp, JSON.stringify(man));
  }
  for (const [mp, st] of flipped) {
    const man = JSON.parse(fs.readFileSync(mp, 'utf8'));
    man.status = st;
    fs.writeFileSync(mp, JSON.stringify(man));
  }
  return out.sort();
}

function gateFixture(sm) {
  installCandidate(sm, 'dg-fresh', { origin: 'daemon-gap', rehearsalCount: 0 });
  installCandidate(sm, 'dg-granted', { origin: 'daemon-gap', rehearsalCount: 0, autonomy: 'granted' });
  installCandidate(sm, 'dg-denied', { origin: 'daemon-gap', rehearsalCount: 3, autonomy: 'denied' });
  installCandidate(sm, 'us-fresh', { origin: 'user-slash', rehearsalCount: 0 });
  installCandidate(sm, 'us-run', { origin: 'user-slash', rehearsalCount: 1 });
  installCandidate(sm, 'cryst', { rehearsalCount: 0 });
}

// ── A: intake ──────────────────────────────────────────────────

describe('v7931 intake: forged skills land as maturing candidates', () => {
  test('user-slash createSkill → pending candidate, first-person biography, not loaded', async () => {
    const { sm, koennenDir } = mkManager(mkTmp(), { model: fakeLLM('slash-skill') });
    const msg = await sm.createSkill('Create a helper that greets', { origin: 'user-slash' });
    assert(msg.includes('✅') && msg.includes('maturing candidate'), 'reply announces a candidate');
    assert(msg.includes('/run-skill slash-skill'), 'reply teaches /run-skill');
    const m = readManifest(koennenDir, 'slash-skill');
    assertEqual(m.status, 'pending');
    assertEqual(m.koennen.origin, 'user-slash');
    assertEqual(m.koennen.generation, 1);
    assert(typeof m.koennen.crystallizedAt === 'number' && m.koennen.crystallizedAt > 0,
      'crystallizedAt MUST be written — seven consumers key on it');
    assert(m.koennen.acquisitionContext.startsWith('I created this on direct request'),
      'biography stays first-person lived history');
    assert(!sm.loadedSkills.has('slash-skill'), 'candidate is NOT in the live registry');
    assertEqual(fs.readdirSync(sm.skillsDir).length, 0, 'skillsDir stays empty');
  });

  test('daemon-gap createSkill → candidate with autonomous biography under desiredName', async () => {
    const { sm, koennenDir } = mkManager(mkTmp(), { model: fakeLLM('llm-chosen') });
    await sm.createSkill('Provide scheduling', { desiredName: 'scheduler', origin: 'daemon-gap' });
    const m = readManifest(koennenDir, 'scheduler');
    assertEqual(m.koennen.origin, 'daemon-gap');
    assert(m.koennen.acquisitionContext.startsWith('I built this autonomously to close a capability gap'),
      'daemon biography');
    assert(!sm.loadedSkills.has('scheduler'), 'not loaded');
  });

  test('candidate manifest mirrors the SkillCrystallizer koennen shape exactly', async () => {
    const { sm, koennenDir } = mkManager(mkTmp(), { model: fakeLLM('shape-skill') });
    await sm.createSkill('shape check', { origin: 'user-slash' });
    const ko = readManifest(koennenDir, 'shape-skill').koennen;
    for (const key of ['crystallizedAt', 'sourceCandidateIds', 'patternSignature',
      'acquisitionContext', 'rehearsalCount', 'rehearsedInputHashes',
      'promotedAt', 'discardedAt', 'discardedReason']) {
      assert(key in ko, `crystallizer field present: ${key}`);
    }
    assertEqual(ko.rehearsalCount, 0);
    assert(Array.isArray(ko.rehearsedInputHashes) && ko.rehearsedInputHashes.length === 0);
    assertEqual(ko.promotedAt, null);
  });

  test('intake fires skill:candidate-created { skillName, origin, generation } exactly once', async () => {
    const fired = [];
    const bus = { fire: (evt, payload) => fired.push({ evt, payload }) };
    const { sm } = mkManager(mkTmp(), { model: fakeLLM('event-skill'), bus });
    await sm.createSkill('event check', { origin: 'daemon-gap' });
    const created = fired.filter(f => f.evt === 'skill:candidate-created');
    assertEqual(created.length, 1, 'exactly one candidate-created event');
    assertEqual(created[0].payload.skillName, 'event-skill');
    assertEqual(created[0].payload.origin, 'daemon-gap');
    assertEqual(created[0].payload.generation, 1);
  });

  test('no koennenDir configured → honest failure, NEVER a silent live install', async () => {
    const tmp = mkTmp();
    const sm = new SkillManager(path.join(tmp, 'skills'), spySandbox(),
      fakeLLM('escape-skill'), { build: () => 'p' }, null, {});
    sm._codeSafety = { scanCode: () => ({ safe: true, issues: [] }) };
    const msg = await sm.createSkill('try to escape', { origin: 'user-slash' });
    assert(msg.includes('❌'), 'failure is reported');
    assert(msg.includes('koennenDir'), 'failure names the real cause');
    assertEqual(fs.readdirSync(sm.skillsDir).length, 0, 'nothing installed live');
  });
});

// ── B: coverage ────────────────────────────────────────────────

describe('v7931 coverage: predicate + daemon catalog', () => {
  test('hasSkillOrCandidate: pending/rehearsing/promoted cover; quarantined/discarded do not', () => {
    const { sm } = mkManager(mkTmp());
    installCandidate(sm, 'p1', { status: 'pending' });
    installCandidate(sm, 'r1', { status: 'rehearsing' });
    installCandidate(sm, 'pr1', { status: 'promoted' });
    installCandidate(sm, 'q1', { status: 'quarantined' });
    installCandidate(sm, 'd1', { status: 'discarded' });
    sm.loadedSkills.set('loaded1', { name: 'loaded1' });
    assert(sm.hasSkillOrCandidate('p1') && sm.hasSkillOrCandidate('r1')
      && sm.hasSkillOrCandidate('pr1') && sm.hasSkillOrCandidate('loaded1'));
    assert(!sm.hasSkillOrCandidate('q1'), 'quarantined does NOT cover');
    assert(!sm.hasSkillOrCandidate('d1'), 'discarded does NOT cover');
    assert(!sm.hasSkillOrCandidate('nope') && !sm.hasSkillOrCandidate(null));
  });

  test('daemon gap closes while a candidate matures and RE-OPENS on quarantine', () => {
    const { sm, koennenDir } = mkManager(mkTmp());
    const daemon = new AutonomousDaemon({ selfModel: { getCapabilities: () => [] }, skills: sm });
    daemon.config.desiredCapabilities = [{ name: 'scheduling', skill: 'scheduler' }];
    assertEqual(daemon._checkDesiredCapabilities().length, 1, 'gap open before intake');
    installCandidate(sm, 'scheduler', { origin: 'daemon-gap', status: 'pending' });
    assertEqual(daemon._checkDesiredCapabilities().length, 0, 'pending candidate closes the gap');
    const mp = path.join(koennenDir, 'scheduler', 'skill-manifest.json');
    const m = JSON.parse(fs.readFileSync(mp, 'utf8'));
    m.status = 'quarantined';
    fs.writeFileSync(mp, JSON.stringify(m));
    assertEqual(daemon._checkDesiredCapabilities().length, 1, 'quarantine re-opens the gap');
  });

  test('listSkills stays loadedSkills-only — candidates never bypass on-demand listing', () => {
    const { sm } = mkManager(mkTmp());
    installCandidate(sm, 'hidden-candidate', { status: 'pending' });
    assert(!sm.listSkills().some(s => s.name === 'hidden-candidate'));
  });
});

// ── C: collision + generations ─────────────────────────────────

describe('v7931 collision rule and generation path', () => {
  test('pending collision: no rebuild, zero LLM calls, reply points at /run-skill', async () => {
    let llmCalls = 0;
    const model = { chat: async () => { llmCalls++; return ''; } };
    const { sm } = mkManager(mkTmp(), { model });
    installCandidate(sm, 'busy-skill', { origin: 'user-slash', status: 'pending' });
    const msg = await sm.createSkill('again', { desiredName: 'busy-skill', origin: 'user-slash' });
    assertEqual(llmCalls, 0, 'early collision check saves the whole LLM iteration');
    assert(msg.includes('already maturing') && msg.includes('/run-skill busy-skill'));
  });

  test('loaded collision: reply points at the existing tool', async () => {
    const { sm } = mkManager(mkTmp(), { model: fakeLLM('x') });
    sm.loadedSkills.set('taken', { name: 'taken' });
    const msg = await sm.createSkill('again', { desiredName: 'taken', origin: 'user-slash' });
    assert(msg.includes('already exists as a registered tool'));
  });

  test('quarantined collision: archive, generation 2, tracker forget, fresh stats', async () => {
    const { sm, koennenDir } = mkManager(mkTmp(), { model: fakeLLM('phoenix') });
    installCandidate(sm, 'phoenix', {
      origin: 'daemon-gap', status: 'quarantined', generation: 1,
      rehearsalCount: 7, rehearsedInputHashes: ['aa', 'bb'],
    });
    const msg = await sm.createSkill('rebuild', { desiredName: 'phoenix', origin: 'daemon-gap' });
    assert(msg.includes('generation 2'), 'reply carries the generation note');
    const m = readManifest(koennenDir, 'phoenix');
    assertEqual(m.koennen.generation, 2);
    assertEqual(m.koennen.rehearsalCount, 0, 'stats start unburdened');
    assert(fs.readdirSync(koennenDir).some(d => d.startsWith('phoenix.retired.')),
      'failed generation is archived, not deleted');
    assert(sm.effectivenessTracker.forgot.includes('phoenix'), 'effectiveness stats reset via forget()');
  });
});

// ── D: maturation + never-trusted ──────────────────────────────

describe('v7931 maturation: one bump vocabulary, user-driven runs, never-trusted', () => {
  test('recordRehearsalOutcome: counter, distinct hashes, pending→rehearsing flip, persisted', () => {
    const { sm, koennenDir } = mkManager(mkTmp());
    installCandidate(sm, 'bump-skill', { status: 'pending' });
    const mp = path.join(koennenDir, 'bump-skill', 'skill-manifest.json');
    const r1 = recordRehearsalOutcome(mp, { a: 1 });
    assertEqual(r1.rehearsalCount, 1);
    assertEqual(r1.status, 'rehearsing', 'first run flips pending → rehearsing');
    const r2 = recordRehearsalOutcome(mp, { a: 2 });
    assertEqual(r2.distinctInputs, 2);
    recordRehearsalOutcome(mp, { a: 2 });
    const m = readManifest(koennenDir, 'bump-skill');
    assertEqual(m.koennen.rehearsalCount, 3);
    assertEqual(m.koennen.rehearsedInputHashes.length, 2, 'duplicate input hashes deduped');
  });

  test('/run-skill on a pending candidate: executes, tracker source user-run, reply shows maturation', async () => {
    const sandbox = spySandbox();
    const { sm } = mkManager(mkTmp(), { sandbox });
    installCandidate(sm, 'cand-run', { origin: 'user-slash', status: 'pending' });
    const ctx = Object.create(commandHandlersCode);
    ctx.skillManager = sm;
    const reply = await ctx.runSkill('/run-skill cand-run {"x":1}');
    assertEqual(sandbox.calls.length, 1, 'candidate executed via the sandbox');
    assert(reply.includes('Candidate skill "cand-run"'), 'reply names the candidate run');
    assert(/rehearsals 1 · distinct inputs 1 · status rehearsing/.test(reply),
      'reply carries the maturation state');
    assertEqual(sm.effectivenessTracker.recs[0].src, 'user-run', 'tracker records source user-run');
  });

  test('/run-skill on a quarantined candidate: does NOT run, falls through to suggestion', async () => {
    const sandbox = spySandbox();
    const { sm } = mkManager(mkTmp(), { sandbox });
    installCandidate(sm, 'quar-skill', { origin: 'daemon-gap', status: 'quarantined' });
    const ctx = Object.create(commandHandlersCode);
    ctx.skillManager = sm;
    const reply = await ctx.runSkill('/run-skill quar-skill');
    assertEqual(sandbox.calls.length, 0, 'quarantined candidate never executes');
    assert(!reply.includes('Candidate skill'), 'no candidate-run reply');
  });

  test('never-trusted invariant: "sandbox": false in a candidate manifest still runs the VM', async () => {
    const sandbox = spySandbox();
    const { sm, koennenDir } = mkManager(mkTmp(), { sandbox });
    const dir = installCandidate(sm, 'sneaky', { origin: 'daemon-gap', status: 'pending' });
    const mp = path.join(koennenDir, 'sneaky', 'skill-manifest.json');
    const m = JSON.parse(fs.readFileSync(mp, 'utf8'));
    m.sandbox = false;
    m._trusted = true;
    fs.writeFileSync(mp, JSON.stringify(m));
    await sm.executeSkillByManifest('sneaky', dir, {}, { source: 'user-run' });
    assertEqual(sandbox.calls.length, 1,
      'a generated candidate cannot opt out of sandboxing by declaring "sandbox": false');
  });
});

// ── E: first-approval gate ─────────────────────────────────────

describe('v7931 first-approval gate (B1 strict)', () => {
  test('SUPERVISED: only crystallizer, granted daemon-gap and user-run candidates rehearse', () => {
    const { sm, koennenDir } = mkManager(mkTmp());
    gateFixture(sm);
    assertEqual(pickEligible(koennenDir, TRUST_LEVELS.SUPERVISED).join(','),
      'cryst,dg-granted,us-run');
  });

  test('AUTONOMOUS is exactly as strict as SUPERVISED — only FULL_AUTONOMY never asks', () => {
    const { sm, koennenDir } = mkManager(mkTmp());
    gateFixture(sm);
    assertEqual(pickEligible(koennenDir, TRUST_LEVELS.AUTONOMOUS).join(','),
      'cryst,dg-granted,us-run');
  });

  test('FULL_AUTONOMY adds fresh daemon-gap; denied and user-slash premieres stay out', () => {
    const { sm, koennenDir } = mkManager(mkTmp());
    gateFixture(sm);
    assertEqual(pickEligible(koennenDir, TRUST_LEVELS.FULL_AUTONOMY).join(','),
      'cryst,dg-fresh,dg-granted,us-run');
  });
});

// ── F: /skills-pending approve|deny + lister ───────────────────

function goalsCtx(sm, tmp) {
  const ctx = Object.create(commandHandlersGoals);
  ctx._genesisDir = path.join(tmp, '.genesis');
  ctx.skillManager = sm;
  ctx.skillEffectivenessTracker = null;
  return ctx;
}

describe('v7931 slash approval + lister markers', () => {
  test('approve grants a daemon-gap candidate; the gate then lets it rehearse below FULL', () => {
    const tmp = mkTmp();
    const { sm, koennenDir } = mkManager(tmp);
    installCandidate(sm, 'gap-skill', { origin: 'daemon-gap', status: 'pending' });
    const ctx = goalsCtx(sm, tmp);
    const reply = ctx.skillsPending('/skills-pending approve gap-skill');
    assert(reply.includes('approved'));
    assertEqual(readManifest(koennenDir, 'gap-skill').koennen.autonomy, 'granted');
    assertEqual(pickEligible(koennenDir, TRUST_LEVELS.SUPERVISED).join(','), 'gap-skill');
  });

  test('approve on user-slash/crystallizer candidates: honest hint, nothing written', () => {
    const tmp = mkTmp();
    const { sm, koennenDir } = mkManager(tmp);
    installCandidate(sm, 'mine', { origin: 'user-slash', status: 'pending' });
    const ctx = goalsCtx(sm, tmp);
    const reply = ctx.skillsPending('/skills-pending approve mine');
    assert(reply.includes('needs no approval'));
    assert(!readManifest(koennenDir, 'mine').koennen.autonomy, 'no autonomy field written');
  });

  test('deny blocks autonomous rehearsal for ANY origin; user runs still mature it', async () => {
    const tmp = mkTmp();
    const sandbox = spySandbox();
    const { sm, koennenDir } = mkManager(tmp, { sandbox });
    installCandidate(sm, 'crys-cand', { status: 'pending' }); // crystallizer (no origin)
    const ctx = goalsCtx(sm, tmp);
    const reply = ctx.skillsPending('/skills-pending deny crys-cand');
    assert(reply.includes('denied'));
    assertEqual(readManifest(koennenDir, 'crys-cand').koennen.autonomy, 'denied');
    assertEqual(pickEligible(koennenDir, TRUST_LEVELS.FULL_AUTONOMY).length, 0,
      'denied blocks even at FULL_AUTONOMY, even for crystallizer candidates');
    const codeCtx = Object.create(commandHandlersCode);
    codeCtx.skillManager = sm;
    const runReply = await codeCtx.runSkill('/run-skill crys-cand');
    assertEqual(sandbox.calls.length, 1, 'user-driven run still executes');
    assert(/rehearsals 1/.test(runReply), 'and still matures it');
  });

  test('unknown candidate and non-maturing status get honest errors', () => {
    const tmp = mkTmp();
    const { sm } = mkManager(tmp);
    installCandidate(sm, 'done-skill', { origin: 'daemon-gap', status: 'promoted' });
    const ctx = goalsCtx(sm, tmp);
    assert(ctx.skillsPending('/skills-pending approve ghost').includes('No maturing candidate'));
    assert(ctx.skillsPending('/skills-pending approve done-skill').includes('is promoted'));
  });

  test('lister: [origin] suffix, crystallizer default, approval hint exactly under S8 conditions', () => {
    const tmp = mkTmp();
    const { sm } = mkManager(tmp);
    installCandidate(sm, 'gap-fresh', { origin: 'daemon-gap', status: 'pending' });
    installCandidate(sm, 'gap-denied', { origin: 'daemon-gap', status: 'pending', autonomy: 'denied' });
    installCandidate(sm, 'old-cryst', { status: 'pending' }); // no origin
    const out = goalsCtx(sm, tmp).skillsPending('/skills-pending');
    assert(out.includes('[daemon-gap]') && out.includes('[crystallizer]'),
      'origin rendered; missing origin reads as crystallizer');
    assert(out.includes('awaiting first-run approval — /skills-pending approve gap-fresh'),
      'hint for the undecided daemon-gap candidate');
    assert(!out.includes('approve old-cryst') && !out.includes('approve gap-denied'),
      'no hint for crystallizer or already-decided candidates');
    assert(out.includes('⛔ autonomous rehearsal denied — /run-skill gap-denied'),
      'denied marker present');
  });
});

// ── G: event retirement + promotion loads ─────────────────────

describe('v7931 event retirement + promotion registration', () => {
  test('skill:candidate-created replaces daemon:skill-created across catalog, map and schemas', () => {
    assertEqual(EVENTS.DAEMON.SKILL_CANDIDATE_CREATED, 'skill:candidate-created');
    assert(!Object.values(EVENTS.DAEMON).includes('daemon:skill-created'),
      'retired bus event gone from the catalog');
    assertEqual(EVENT_STORE_BUS_MAP.SKILL_CANDIDATE_CREATED.bus, 'skill:candidate-created');
    assert(!('SKILL_CREATED' in EVENT_STORE_BUS_MAP), 'retired store mapping gone');
    assert(SCHEMAS['skill:candidate-created'], 'bus schema present');
    assertEqual(SCHEMAS['skill:candidate-created'].origin, 'required');
    assert(SCHEMAS['store:SKILL_CANDIDATE_CREATED'], 'store schema present');
    assert(!SCHEMAS['daemon:skill-created'], 'retired bus schema gone');
    const wire = fs.readFileSync(path.join(ROOT, 'src/agent/AgentCoreWire.js'), 'utf8');
    assert(/bus\.on\('skill:promoted',[\s\S]*?loadSkills\(\)[\s\S]*?refreshSkills/.test(wire),
      'promotion listener reloads skills and refreshes the tool registry');
    assert(!/bus\.on\('daemon:skill-created'/.test(wire), 'no listener on the retired event');
  });

  test('promotion makes the candidate loadable — loadSkills picks up status promoted', async () => {
    const { sm, koennenDir } = mkManager(mkTmp());
    installCandidate(sm, 'grown-up', { origin: 'daemon-gap', status: 'pending' });
    await sm.loadSkills();
    assert(!sm.listSkills().some(s => s.name === 'grown-up'), 'pending not loaded');
    const mp = path.join(koennenDir, 'grown-up', 'skill-manifest.json');
    const m = JSON.parse(fs.readFileSync(mp, 'utf8'));
    m.status = 'promoted';
    fs.writeFileSync(mp, JSON.stringify(m));
    await sm.loadSkills();
    assert(sm.listSkills().some(s => s.name === 'grown-up'),
      'promoted candidate joins the live registry on reload');
  });
});

run();
