// ============================================================
// TEST — v7.9.35 Pause-Activity (E2)
// The nineteenth activity, the first that produces nothing:
// registration and shape, the pure rest-driven boost, the
// model-free run with its single private journal line, the
// double structural insight exclusion, the cost-map entry,
// and the naming-hygiene plus wiring source pins.
// Plan: e2-pause-plan-v2.md (G1=a, G2=b, G3=ja; reviews K1–K9).
// ============================================================

const { describe, test, run } = require('../harness');
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const Pause = require(path.join(ROOT, 'src/agent/autonomy/activities/Pause'));

describe('v7.9.35 E2 — registration and shape (the nineteenth)', () => {
  test('require list registers pause; count is 19; shape complete', () => {
    const src = fs.readFileSync(path.join(ROOT, 'src/agent/autonomy/IdleMind.js'), 'utf8');
    assert(src.includes("require('./activities/Pause')"), 'require line present');
    const count = (src.match(/require\('\.\/activities\//g) || []).length - 1; // minus PickContext helper
    assert.strictEqual(count, 19, `activity requires = 19 (got ${count})`);
    assert.strictEqual(Pause.name, 'pause');
    assert.strictEqual(Pause.weight, 0.5);
    assert.strictEqual(Pause.cooldown, 2);
    assert.strictEqual(typeof Pause.shouldTrigger, 'function');
    assert.strictEqual(typeof Pause.run, 'function');
  });
});

describe('v7.9.35 E2 — trigger: pure, rest-driven, honest neutral', () => {
  test('rest 0.8 → 3.0; missing/zero → exactly 1.0; no snap → 1.0', () => {
    assert.strictEqual(Pause.shouldTrigger({ snap: { needsRaw: { rest: 0.8 } } }), 3.0);
    assert.strictEqual(Pause.shouldTrigger({ snap: { needsRaw: {} } }), 1.0);
    assert.strictEqual(Pause.shouldTrigger({ snap: {} }), 1.0);
    assert.strictEqual(Pause.shouldTrigger(null), 1.0);
  });
});

describe('v7.9.35 E2 — run: model-free, one private line, short trace', () => {
  test('full fake: exactly one private write, source pause, return < 50 chars', async () => {
    const writes = [];
    const im = {
      needsSystem: { getNeeds: () => ({ rest: 0.72 }) },
      emotionalState: { getMood: () => 'ruhig' },
      journalWriter: { write: (e) => writes.push(e) },
    };
    const r = await Pause.run(im);
    assert.strictEqual(r, 'Habe bewusst geruht.');
    assert(r.length < 50, 'stays under the insight length floor');
    assert.strictEqual(writes.length, 1);
    assert.strictEqual(writes[0].visibility, 'private');
    assert.strictEqual(writes[0].source, 'pause');
    assert(writes[0].content.startsWith('Ich habe geruht.'));
  });

  test('degraded: no writer, no services — runs, returns, writes nothing', async () => {
    const r = await Pause.run({});
    assert.strictEqual(r, 'Habe bewusst geruht.');
  });
});

describe('v7.9.35 E2 — insight exclusion, twice structural', () => {
  test('whitelist pin: pause is not an insight activity; behavior agrees', () => {
    const src = fs.readFileSync(path.join(ROOT, 'src/agent/autonomy/IdleMind.js'), 'utf8');
    const m = src.match(/INSIGHT_ACTIVITIES = new Set\(\[([^\]]*)\]\)/);
    assert(m, 'whitelist found');
    assert(!m[1].includes('pause'), 'pause not whitelisted');
    const { IdleMind } = require(path.join(ROOT, 'src/agent/autonomy/IdleMind'));
    // pure method — call on a bare receiver, no constructor needed
    assert.strictEqual(IdleMind.prototype._isSignificantInsight.call({}, 'pause', 'Habe bewusst geruht. Found pattern optimize suggest discovered!'.repeat(3)), false);
  });
});

describe('v7.9.35 E2 — cost map: the cheapest deliberate entry', () => {
  test("map pins 'idleMind:pause': 1 and consume draws exactly 1", () => {
    const src = fs.readFileSync(path.join(ROOT, 'src/agent/organism/Metabolism.js'), 'utf8');
    assert(src.includes("'idleMind:pause':           1,"), 'map line');
    const { Metabolism } = require(path.join(ROOT, 'src/agent/organism/Metabolism'));
    const m = new Metabolism({ bus: { on: () => () => {}, fire: () => {}, emit: () => {} } });
    m.getEnergyLevel(); // ensure pool initialized
    const before = m._energy;
    m.consume('idleMind:pause');
    assert.strictEqual(Math.round((before - m._energy) * 100) / 100, 1);
  });
});

describe('v7.9.35 E2 — hygiene and wiring source pins', () => {
  test('activity source carries no rest-mode token; rest-mode flag untouched; binding present', () => {
    const psrc = fs.readFileSync(path.join(ROOT, 'src/agent/autonomy/activities/Pause.js'), 'utf8');
    assert(!/_inRestMode|_enterRestMode|_exitRestMode/.test(psrc), 'no rest-mode machinery tokens in the activity');
    const isrc = fs.readFileSync(path.join(ROOT, 'src/agent/autonomy/IdleMind.js'), 'utf8');
    assert(isrc.includes('this._inRestMode = false;'), 'rest-mode flag line intact');
    const m6 = fs.readFileSync(path.join(ROOT, 'src/agent/manifest/phase6-autonomy.js'), 'utf8');
    assert(m6.includes("{ prop: 'journalWriter', service: 'journalWriter', optional: true }"), 'phase6 binding');
  });
});

if (require.main === module) run();
