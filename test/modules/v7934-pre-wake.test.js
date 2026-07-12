// ============================================================
// TEST — v7.9.34 Pre-Wake-Continuity (E1)
//
// Contracts for the WakeUpRoutine's mirror: the continuity anchor
// written inside the awaited session:ending emit — durability before
// the emit returns, shape and caps, the time-box with template
// fallback, one-anchor-per-shutdown, honest failure semantics, the
// wake-side fourth context source with freshness, and the guardrail
// plus teardown-order source pins.
// Plan: e1-pre-wake-plan-v2.md (decisions G1=b, G2=a, G3 confirmed).
// ============================================================

const { describe, test, run } = require('../harness');
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const { PreSleep, ANCHOR_FILE } = require(path.join(ROOT, 'src/agent/cognitive/PreSleep'));

// ── Doubles ─────────────────────────────────────────────────

function makeBus() {
  const h = {};
  return {
    h,
    on(evt, fn) { (h[evt] = h[evt] || []).push(fn); return () => {}; },
    async emit(evt, data) { for (const fn of h[evt] || []) await fn(data); },
  };
}

/** Disk-backed storage double: writeJSON lands synchronously on real
 *  disk (so the durability contract observes the file after the awaited
 *  emit), readJSON/readText mirror it. Call log proves the atomic API
 *  (writeJSON) is the only write path used for the anchor. */
function makeStorage() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'g34-ps-'));
  const calls = [];
  return {
    dir, calls,
    writeJSON(f, obj) { calls.push(['writeJSON', f]); fs.writeFileSync(path.join(dir, f), JSON.stringify(obj)); },
    appendText(f, t) { calls.push(['appendText', f]); fs.appendFileSync(path.join(dir, f), t); },
    readJSON(f, d = null) { try { return JSON.parse(fs.readFileSync(path.join(dir, f), 'utf-8')); } catch (_e) { return d; } },
    readText(f, d = '') { try { return fs.readFileSync(path.join(dir, f), 'utf-8'); } catch (_e) { return d; } },
    cleanup() { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_e) { /* */ } },
  };
}

function makePS(opts = {}) {
  const bus = makeBus();
  const storage = makeStorage();
  const ps = new PreSleep({ bus, storage, clock: opts.clock || Date, model: opts.model || null,
    timeboxMs: opts.timeboxMs, llmFloorMs: opts.llmFloorMs });
  if (opts.goals) ps.goalStack = { getActiveGoals: () => opts.goals };
  if (opts.mood) ps.emotionalState = { getMood: () => opts.mood };
  ps.language = opts.language || { current: 'de' };
  ps.start();
  return { bus, storage, ps };
}

// ── S1/S2: durability, shape, caps ──────────────────────────

describe('v7.9.34 E1 — anchor durability and shape', () => {
  test('anchor is on disk, parsed, before the awaited emit returns', async () => {
    const { bus, storage, ps } = makePS({ goals: [{ title: 'AP-3 vorbereiten' }] });
    await bus.emit('session:ending', { sessionId: 's1', durationMs: 754000, messageCount: 42 });
    const a = JSON.parse(fs.readFileSync(path.join(storage.dir, ANCHOR_FILE), 'utf-8'));
    assert.strictEqual(a.sessionId, 's1');
    assert.strictEqual(a.shutdownClean, true);
    assert.strictEqual(a.durationMs, 754000);
    assert(/^\d{4}-\d{2}-\d{2}T/.test(a.ts));
    ps.stop(); storage.cleanup();
  });

  test('shape carries snapshot with caps: goal titles ≤80, thought ≤200, top ≤3', async () => {
    const longTitle = 'X'.repeat(300);
    const model = { chat: async () => 'Y'.repeat(500) };
    const { bus, storage, ps } = makePS({ model, goals: [1, 2, 3, 4, 5].map(i => ({ title: longTitle + i })), mood: 'ruhig' });
    await bus.emit('session:ending', { durationMs: 60000 });
    const a = storage.readJSON(ANCHOR_FILE);
    assert.strictEqual(a.snapshot.openGoals.count, 5);
    assert.strictEqual(a.snapshot.openGoals.top.length, 3);
    assert.strictEqual(a.snapshot.openGoals.top[0].length, 80);
    assert.strictEqual(a.snapshot.mood, 'ruhig');
    assert.strictEqual(a.lastThought.length, 200);
    assert.strictEqual(a.thoughtSource, 'llm');
    ps.stop(); storage.cleanup();
  });

  test('the anchor uses the atomic write API exclusively', async () => {
    const { bus, storage, ps } = makePS({});
    await bus.emit('session:ending', { durationMs: 1000 });
    const writes = storage.calls.filter(c => c[1] === ANCHOR_FILE);
    assert(writes.length >= 1);
    assert(writes.every(c => c[0] === 'writeJSON'), 'anchor writes must go through writeJSON (atomic + fsync)');
    ps.stop(); storage.cleanup();
  });
});

// ── S4: time-box and sentence sources ───────────────────────

describe('v7.9.34 E1 — sentence: LLM within budget, template beyond it', () => {
  test('slow model → template within the box, thoughtSource honest', async () => {
    const slow = { chat: () => new Promise(res => setTimeout(() => res('zu spät'), 2000)) };
    const { bus, storage, ps } = makePS({ model: slow, timeboxMs: 900, llmFloorMs: 300 });
    const t0 = Date.now();
    await bus.emit('session:ending', { durationMs: 120000 });
    const dt = Date.now() - t0;
    const a = storage.readJSON(ANCHOR_FILE);
    assert.strictEqual(a.thoughtSource, 'template');
    assert(dt < 1500, `handler stayed inside its box (${dt}ms)`);
    assert(a.lastThought.startsWith('Ich höre auf'), 'German default template');
    ps.stop(); storage.cleanup();
  });

  test('model-free run is deterministic and bilingual switch works', async () => {
    const { bus, storage, ps } = makePS({ goals: [{ title: 'Zyklus committen' }], language: { current: 'en' } });
    await bus.emit('session:ending', { durationMs: 120000 });
    const a = storage.readJSON(ANCHOR_FILE);
    assert.strictEqual(a.thoughtSource, 'template');
    assert(a.lastThought.startsWith('Stopping after a 2-minute session'), a.lastThought);
    assert(a.lastThought.includes('1 goal open'));
    ps.stop(); storage.cleanup();
  });
});

// ── S1: guard, overwrite, failure semantics ─────────────────

describe('v7.9.34 E1 — one anchor per shutdown, overwrite across processes, never-throws', () => {
  test('second emit in the same process is ignored; a new process overwrites', async () => {
    const { bus, storage, ps } = makePS({});
    await bus.emit('session:ending', { sessionId: 'a', durationMs: 1 });
    await bus.emit('session:ending', { sessionId: 'b', durationMs: 1 });
    assert.strictEqual(storage.readJSON(ANCHOR_FILE).sessionId, 'a', 'guard holds');
    const bus2 = makeBus();
    const ps2 = new PreSleep({ bus: bus2, storage, clock: Date });
    ps2.language = { current: 'de' }; ps2.start();
    await bus2.emit('session:ending', { sessionId: 'c', durationMs: 1 });
    assert.strictEqual(storage.readJSON(ANCHOR_FILE).sessionId, 'c', 'next shutdown replaces');
    ps.stop(); ps2.stop(); storage.cleanup();
  });

  test('storage failure: handler returns silently, previous anchor untouched', async () => {
    const { bus, storage, ps } = makePS({});
    await bus.emit('session:ending', { sessionId: 'keep', durationMs: 1 });
    const failing = new PreSleep({
      bus, storage: {
        writeJSON: () => { throw new Error('disk full'); },
        readJSON: storage.readJSON.bind(storage), readText: () => '',
      }, clock: Date,
    });
    failing._anchoredThisProcess = false; failing.language = { current: 'de' };
    await failing._onSessionEnding({ sessionId: 'lost', durationMs: 1 });
    assert.strictEqual(storage.readJSON(ANCHOR_FILE).sessionId, 'keep');
    ps.stop(); storage.cleanup();
  });
});

// ── S5: the wake side ───────────────────────────────────────

describe('v7.9.34 E1 — wake reads the anchor as fourth context source', () => {
  const { WakeUpRoutine } = require(path.join(ROOT, 'src/agent/cognitive/WakeUpRoutine'));
  const mkWake = (anchorResult) => {
    const w = new WakeUpRoutine({ bus: { on: () => {}, emit: () => {}, fire: () => {} } });
    let written = null;
    w.journalWriter = { write: (e) => { written = e; } };
    if (anchorResult !== undefined) w.preSleep = { readAnchor: () => anchorResult };
    return { w, get written() { return written; } };
  };

  test('fresh anchor: ctx carries it and the stub speaks it', async () => {
    const h = mkWake({ anchor: { lastThought: 'Ich höre auf, während das Register wächst.' }, fresh: true });
    const ctx = await h.w._collectContext();
    assert(ctx.lastPreSleep && ctx.lastPreSleep.fresh === true);
    const out = h.w._writeStub(ctx, 'test');
    assert(out.includes('Vor dem Schlaf: „Ich höre auf, während das Register wächst.“'));
  });

  test('no anchor: field is null and the stub keeps its existing shape', async () => {
    const h = mkWake(null);
    const ctx = await h.w._collectContext();
    assert.strictEqual(ctx.lastPreSleep, null);
    const out = h.w._writeStub(ctx, 'test');
    assert(out.startsWith('Wach geworden.'));
    assert(!out.includes('Schlaf'), 'no sleep line without an anchor');
  });

  test('stale anchor is named honestly, not quoted', async () => {
    const h = mkWake({ anchor: { lastThought: 'alt' }, fresh: false });
    const out = h.w._writeStub(await h.w._collectContext(), 'test');
    assert(out.includes('Mein letzter bewusster Schlaf liegt länger zurück.'));
    assert(!out.includes('„alt“'));
  });

  test('readAnchor freshness window: 8 days old reads stale', async () => {
    let now = 1751791000000;
    const { bus, storage, ps } = makePS({ clock: { now: () => now } });
    await bus.emit('session:ending', { durationMs: 1 });
    assert.strictEqual(ps.readAnchor().fresh, true);
    now += 8 * 24 * 3600 * 1000;
    assert.strictEqual(ps.readAnchor().fresh, false);
    ps.stop(); storage.cleanup();
  });
});

// ── S6/guardrails: source pins ──────────────────────────────

describe('v7.9.34 E1 — guardrails and teardown order (source pins)', () => {
  test('anchor never reaches PromptBuilder or the identity summary', () => {
    const dir = path.join(ROOT, 'src/agent/intelligence');
    const files = fs.readdirSync(dir).filter(f => f.startsWith('PromptBuilder') && f.endsWith('.js'));
    assert(files.length >= 3);
    for (const f of files) {
      const src = fs.readFileSync(path.join(dir, f), 'utf8');
      assert(!src.includes('PreSleep'), f);
      assert(!src.includes('continuity-anchor'), f);
    }
    const sn = fs.readFileSync(path.join(ROOT, 'src/agent/cognitive/SelfNarrative.js'), 'utf8');
    assert(!sn.includes('PreSleep') && !sn.includes('continuity-anchor'));
  });

  test('order pin: session:ending emit precedes TO_STOP; lock release stays last-documented', () => {
    const src = fs.readFileSync(path.join(ROOT, 'src/agent/AgentCoreHealth.js'), 'utf8');
    const emitIdx = src.indexOf("safeAsync('sessionEnding'");
    const stopIdx = src.indexOf('const TO_STOP = [');
    assert(emitIdx > 0 && stopIdx > emitIdx, 'emit before teardown');
    assert(src.includes("'preSleep', // v7.9.34"), 'preSleep in TO_STOP');
    assert(src.includes('release the single-instance lock'), 'lock-release doc line intact');
    const m = fs.readFileSync(path.join(ROOT, 'src/agent/manifest/phase9-cognitive-b.js'), 'utf8');
    assert(m.indexOf("['preSleep'") < m.indexOf("['wakeUpRoutine'"), 'wake stays registered last');
  });
});

if (require.main === module) run();
