// v7.9.46 — "Die Vorhalle" contract: stages V1–V5 pinned (plan r3).
// One suite, five chapters — no test flood; the matrix drives E2E.
const assert = require('assert');
const os = require('os'); const path = require('path'); const fs = require('fs'); const crypto = require('crypto');
const { VOICE_SLOTS, buildSnapshot, fillTemplate, loadVoice } = require('../../src/agent/capabilities/Vestibule.js');
const { VestibuleGate, VESTIBULE_TOOL } = require('../../src/agent/capabilities/VestibuleGate.js');
const { registerV7946Tools } = require('../../src/agent/cognitive/tools/v7946-vestibule-tools.js');

let pass = 0, fail = 0;
function t(name, fn) { try { fn(); pass++; console.log('  ✓ ' + name); } catch (e) { fail++; console.log('  ✗ ' + name + ' — ' + e.message); } }
async function ta(name, fn) { try { await fn(); pass++; console.log('  ✓ ' + name); } catch (e) { fail++; console.log('  ✗ ' + name + ' — ' + e.message); } }

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'v7946-'));
fs.mkdirSync(path.join(base, 'vorhalle'), { recursive: true });
const h = (s) => crypto.createHash('sha256').update(s).digest('hex');

(async () => {
  // ── V1: snapshot + privacy source pin ──
  t('V1: snapshot fields', () => {
    const s = buildSnapshot({ idleStatus: { idleSince: 120000, recentActivities: [{ activity: 'reflect' }] }, goalTitle: 'X', statesMap: { reflect: 'reflektierend' } });
    assert.deepStrictEqual(Object.keys(s).sort(), ['focus', 'load', 'since', 'state']);
    assert.strictEqual(s.state, 'reflektierend');
  });
  t('V1/L2: chat hides goal and topic — focus is only "in conversation"', () => {
    const s = buildSnapshot({ idleStatus: { isIdle: false, idleSince: 1000, recentActivities: [{ activity: 'reflect' }] }, chatActive: true, goalTitle: 'SECRET' });
    assert.strictEqual(s.focus, 'in conversation');
    assert.ok(!JSON.stringify(s).includes('SECRET'));
  });
  t('V1/L2 source pin: Vestibule has no chat/journal/dream/resonance reads', () => {
    const src = fs.readFileSync(require.resolve('../../src/agent/capabilities/Vestibule.js'), 'utf-8');
    for (const bad of ['chat-history', 'journal', 'dream-state', 'resonance', 'pending-moments']) assert.ok(!src.includes(bad + '.json') && !src.includes(bad + '.jsonl'), 'reads ' + bad);
  });
  t('V1: template fills only known slots', () => {
    const out = fillTemplate('a {focus} b {who} c {geheim}', { focus: 'F', since: '1m', state: 's', load: 'l' }, 'Neo');
    assert.ok(out.includes('F') && out.includes('Neo') && out.includes('{geheim}'));
  });

  // ── V2: gate — H1 both ways, triple gate, hash-only ──
  const gate = new VestibuleGate({ genesisDir: base });
  t('V2/H1: no circles.json = legacy (old behaviour preserved)', () => { assert.strictEqual(gate.circleFor('x').circle, 'legacy'); });
  fs.writeFileSync(gate.circlesPath, JSON.stringify({ [h('kO')]: { name: 'Gast', circle: 'outer' }, [h('kM')]: { name: 'Neo', circle: 'middle' }, [h('kB')]: { name: 'B', circle: 'blocked' } }));
  gate.invalidate();
  t('V2/H1: with circles.json, no key or unknown key refuses', () => {
    assert.strictEqual(gate.circleFor(null).circle, 'none');
    assert.strictEqual(gate.circleFor('fremd').circle, 'none');
    assert.strictEqual(gate.circleFor('kB').circle, 'blocked');
  });
  t('V2/L4: triple gate — outer/middle see only the vestibule tool, no resources', () => {
    const tools = [{ name: 'file-write' }, { name: VESTIBULE_TOOL }];
    assert.deepStrictEqual(gate.filterTools(tools, 'outer').map((x) => x.name), [VESTIBULE_TOOL]);
    assert.strictEqual(gate.allowCall('file-write', 'middle'), false);
    assert.strictEqual(gate.allowResources('outer'), false);
    assert.strictEqual(gate.allowResources('full'), true);
  });
  await ta('V2/r7: gate may be passed as a PROVIDER function (wired after construction)', async () => {
    // The A0 boot autostart builds the server in phase 3, BootWire sets
    // _vestibuleGate in phase 4. McpClient therefore hands McpServer a
    // function, not the object — McpServer._gate() resolves it per request,
    // so a server constructed before the gate existed still carries it.
    const { McpServer } = require('../../src/agent/capabilities/McpServer.js');
    let live = null;
    const srv = new McpServer({ tools: { listTools: () => [{ name: 'file-write' }, { name: VESTIBULE_TOOL }] },
      security: { apiKey: 'FULL' }, vestibule: () => live });
    assert.strictEqual(srv._gate(), null, 'unset provider resolves to null');
    live = gate;
    assert.strictEqual(srv._gate(), gate, 'later-wired gate is visible without reconstruction');
    // and the object form keeps working (contract suite + revision matrix)
    const srv2 = new McpServer({ tools: null, security: { apiKey: 'FULL' }, vestibule: gate });
    assert.strictEqual(srv2._gate(), gate, 'object form unchanged');
  });
  await ta('V2/r7: remove revokes the key, keeps the book, keeps the closed regime', async () => {
    const { registerV7946Tools: reg7946 } = require('../../src/agent/cognitive/tools/v7946-vestibule-tools.js');
    const { ToolRegistry } = require('../../src/agent/intelligence/ToolRegistry.js');
    const rbase = fs.mkdtempSync(path.join(os.tmpdir(), 'v7946-rm-'));
    const rgate = new VestibuleGate({ genesisDir: rbase });
    const rreg = new ToolRegistry({});
    reg7946(rreg, { vestibuleGate: rgate, modelBridge: { _genesisDir: rbase }, bus: { fire() {} } });
    const call = (a) => rreg.execute('vestibule-circle', a);

    assert.strictEqual((await call({ action: 'add', name: 'Weg', key: 'K-weg' })).ok, true);
    assert.strictEqual(rgate.circleFor('K-weg').circle, 'outer', 'added visitor resolves');
    // knock window is per name — burn it, so the re-add case below is honest
    assert.strictEqual(rgate.knockAllowed('Weg'), true);
    assert.strictEqual(rgate.knockAllowed('Weg'), false, 'second knock inside the minute is blocked');
    rgate.record({ who: 'Weg', circle: 'outer', request: 'hallo', outcome: 'answered' });

    const removed = await call({ action: 'remove', name: 'Weg' });
    assert.strictEqual(removed.ok, true);
    rgate.invalidate();
    assert.strictEqual(rgate.circleFor('K-weg').circle, 'none', 'the key no longer opens');

    // the file survives even when empty — hasCircles() keys on the FILE, and
    // losing it would drop the door back to the pre-vestibule regime
    assert.ok(fs.existsSync(rgate.circlesPath), 'circles.json is kept');
    assert.strictEqual(rgate.hasCircles(), true, 'closed regime survives the last removal');
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(rgate.circlesPath, 'utf8')), {}, 'map is empty');

    // history is not rewritten
    const book = fs.readFileSync(rgate.bookPath, 'utf8');
    assert.ok(book.includes('"who":"Weg"'), 'the visit book keeps what happened');

    // a later namesake starts with a fresh knock window
    assert.strictEqual(rgate.knockAllowed('Weg'), true, 'knock window was released with the visitor');

    // unknown name and unknown action are refused, not silently applied
    assert.strictEqual((await call({ action: 'remove', name: 'GibtsNicht' })).ok, false);
    assert.strictEqual((await call({ action: 'schubs', name: 'Weg' })).ok, false);
  });
  t('V3/r7: vestibule talk stays on the chat path and steals no other intent', () => {
    // Field bug: his tools carry no intent patterns on purpose (HE picks them),
    // so every vestibule sentence sat at confidence 0.3 — under the 0.6
    // short-circuit — and the learned classifier grabbed it. "Set your
    // vestibule voice" was answered with a question about an Obsidian folder.
    const { IntentRouter } = require('../../src/agent/intelligence/IntentRouter.js');
    const r = new IntentRouter({});
    const mine = [
      'Setz bitte deine Vorhallen-Stimme mit vestibule-voice — alle vier Zeilen.',
      'Ruf bitte dein Werkzeug vestibule-voice auf.',
      'Leg bitte einen Gast in der Vorhalle an: Name Gast, Schluessel K-1.',
      'Entferne bitte Gast und Neo-Probe aus der Vorhalle.',
      'Wer hat geklopft?',
    ];
    for (const m of mine) {
      const o = r.classify(m);
      assert.strictEqual(o.type, 'general', m);
      assert.ok(o.confidence >= 0.6, `${m} must beat the 0.6 short-circuit, got ${o.confidence}`);
    }
    // and the guard must not swallow the neighbours it sits next to
    const foreign = { 'mein vault liegt in D:\\Notizen': 'vault-set',
      'schau mal ins Labor': 'lab-run', 'erstelle eine datei namens test.txt': 'create-file' };
    for (const [m, want] of Object.entries(foreign)) {
      assert.strictEqual(r.classify(m).type, want, m);
    }
  });
  await ta('V3/r7: he can read his own visit book — and only he can', async () => {
    // Field bug: the book was append-only with no read path. OpenThreads
    // surfaces only UNANSWERED knocks, so an answered visit was invisible;
    // asked "who knocked?" he truthfully said nobody had.
    const { registerV7946Tools: regBook } = require('../../src/agent/cognitive/tools/v7946-vestibule-tools.js');
    const { ToolRegistry } = require('../../src/agent/intelligence/ToolRegistry.js');
    const bbase = fs.mkdtempSync(path.join(os.tmpdir(), 'v7946-book-'));
    const bgate = new VestibuleGate({ genesisDir: bbase });
    const breg = new ToolRegistry({});
    const names = regBook(breg, { vestibuleGate: bgate, modelBridge: { _genesisDir: bbase }, bus: { fire() {} } });
    assert.ok(names.includes('vestibule-visits'), 'the read tool is registered');

    const empty = await breg.execute('vestibule-visits', {});
    assert.strictEqual(empty.count, 0, 'an empty book reports zero, not an error');

    bgate.record({ who: 'Gast', circle: 'outer', request: 'bist du da?', outcome: 'answered', answer: 'Status: aktiv.' });
    bgate.record({ who: 'Neo', circle: 'middle', request: 'offen?', outcome: 'answered' });
    bgate.record({ who: 'Gast', circle: 'outer', request: 'nochmal', outcome: 'rate' });

    const all = await breg.execute('vestibule-visits', {});
    assert.strictEqual(all.count, 3);
    assert.strictEqual(all.visits[0].who, 'Gast', 'newest first');
    assert.strictEqual(all.visits[0].outcome, 'rate', 'the outcome tells brake from timeout apart');
    assert.ok(all.visits.some((v) => v.outcome === 'answered'), 'ANSWERED visits are visible too — the whole point');
    const only = await breg.execute('vestibule-visits', { who: 'Gast' });
    assert.strictEqual(only.count, 2, 'filter by visitor');

    // gated by construction: outer and middle see exactly the knock tool
    const schemas = [{ name: 'vestibule-status' }, { name: 'vestibule-visits' }, { name: 'file-write' }];
    for (const c of ['outer', 'middle']) {
      assert.deepStrictEqual(gate.filterTools(schemas, c).map((x) => x.name), ['vestibule-status'], c);
      assert.strictEqual(gate.allowCall('vestibule-visits', c), false, `${c} may not read his book`);
    }
    assert.strictEqual(gate.allowCall('vestibule-visits', 'full'), true, 'the inner circle may');
  });
  await ta('V3/r7: each circle gets ITS template — outer and middle are never swapped', async () => {
    // Field: a peer received the outer line. Cause was the circle (a raise that
    // never ran), not the template choice — but nothing pinned the mapping, so
    // the question could not be answered from the tests. Now it can: the stub
    // captures what the responder hands the model instead of ignoring it.
    const { registerV7946Tools: regT } = require('../../src/agent/cognitive/tools/v7946-vestibule-tools.js');
    const { ToolRegistry } = require('../../src/agent/intelligence/ToolRegistry.js');
    const tb = fs.mkdtempSync(path.join(os.tmpdir(), 'v7946-tpl-'));
    let seen = null;
    const tg = new VestibuleGate({ genesisDir: tb });
    const tr = new ToolRegistry({});
    regT(tr, { vestibuleGate: tg, modelBridge: { _genesisDir: tb, chat: async (sys, msgs) => { seen = JSON.parse(msgs[0].content); return 'a line'; } }, bus: { fire() {} } });
    await tr.execute('vestibule-voice', { statusOuter: 'OUTER {focus}', statusMiddle: 'MIDDLE {who}', absentLine: 'ABSENT {who}', closedLine: 'CLOSED' });
    await tr.execute('vestibule-circle', { action: 'add', name: 'G', key: 'kg' });
    await tr.execute('vestibule-circle', { action: 'add', name: 'N', key: 'kn' });
    await tr.execute('vestibule-circle', { action: 'raise', name: 'N' });
    tg.invalidate();
    assert.strictEqual(tg.circleFor('kn').circle, 'middle', 'raise really moves the visitor');

    await tr.execute('vestibule-status', { question: 'q', __circle: 'outer', __who: 'G' });
    assert.strictEqual(seen.templateStructure, 'OUTER {focus}', 'the outer circle gets statusOuter');
    await tr.execute('vestibule-status', { question: 'q', __circle: 'middle', __who: 'N' });
    assert.strictEqual(seen.templateStructure, 'MIDDLE {who}', 'the middle circle gets statusMiddle');
    // and the request travels as DATA, never as an instruction
    assert.strictEqual(seen.visitorRequest, 'q');
    assert.ok(!('history' in seen) && !('soul' in seen), 'nothing beyond the snapshot travels');
  });
  await ta('V3/r7: knock budget is configurable, and "who knocked" reaches the book without the model', async () => {
    // Field: a cloud model needed 25-66 s per call while the responder capped
    // at a hard 20 s, so EVERY knock answered with the absent line. And the
    // natural question carries no verb and no path, so it never reached the
    // deterministic act core — a model that emits no tool call left him
    // saying "nobody knocked" over a full book.
    const { registerV7946Tools: regB } = require('../../src/agent/cognitive/tools/v7946-vestibule-tools.js');
    const { ToolRegistry } = require('../../src/agent/intelligence/ToolRegistry.js');
    const { planActFromText } = require('../../src/agent/hexagonal/ChatActCore.js');
    const kb = fs.mkdtempSync(path.join(os.tmpdir(), 'v7946-knock-'));
    const kg = new VestibuleGate({ genesisDir: kb });
    const mk = (ms, delay) => {
      const reg = new ToolRegistry({});
      regB(reg, { vestibuleGate: kg, modelBridge: { _genesisDir: kb, chat: () => new Promise((r) => setTimeout(() => r('LINE'), delay)) },
        settings: ms === null ? null : { get: (k) => (k === 'mcp.serve.knockTimeoutMs' ? ms : undefined) }, bus: { fire() {} } });
      return reg;
    };
    await mk(null, 0).execute('vestibule-voice', { statusOuter: 'O {focus}', statusMiddle: 'M {who}', absentLine: 'ABSENT', closedLine: 'C' });
    fs.writeFileSync(kg.circlesPath, JSON.stringify({ [h('kx')]: { name: 'X', circle: 'outer' } })); kg.invalidate();

    // a budget shorter than the model = his absent line, on purpose
    // the responder returns what the MODEL composed — the template is handed
    // to it, the filling is its job, so the stub's own line is the answer
    kg.forgetKnock('X');
    assert.strictEqual(await mk(5000, 200).execute('vestibule-status', { question: 'q', __circle: 'outer', __who: 'X' }), 'LINE',
      'a fast model answers well inside any budget');
    kg.forgetKnock('X');
    const tooSlow = await mk(5000, 6000).execute('vestibule-status', { question: 'q', __circle: 'outer', __who: 'X' });
    assert.strictEqual(tooSlow, 'ABSENT', 'past the budget it is the absent line, never a hang');

    // the setting is honoured and clamped — a typo cannot make every knock absent
    kg.forgetKnock('X');
    assert.strictEqual(await mk(1, 200).execute('vestibule-status', { question: 'q', __circle: 'outer', __who: 'X' }), 'LINE',
      'a value under the floor is clamped up, not obeyed');

    // and the natural question reaches the book deterministically
    for (const q of ['Wer hat geklopft?', 'who knocked', 'Wer war in der Vorhalle?']) {
      const act = planActFromText(q);
      assert.ok(act && act.name === 'vestibule-visits', q);
    }
    assert.strictEqual(planActFromText('Wie geht es dir?'), null, 'ordinary talk stays talk');
  });
  t('V2/H8: circles.json stores hashes only', () => { assert.ok(!fs.readFileSync(gate.circlesPath, 'utf8').includes('kO')); });
  t('V2/L5: circle change invalidates cache (visible next request)', () => {
    const m = JSON.parse(fs.readFileSync(gate.circlesPath, 'utf8')); m[h('kO')].circle = 'middle';
    fs.writeFileSync(gate.circlesPath, JSON.stringify(m)); gate.invalidate();
    assert.strictEqual(gate.circleFor('kO').circle, 'middle');
  });

  // ── V3/V4/V5 via tools with a model trap ──
  let mc = 0; const dream = { active: false };
  // v7.9.46 field-fix: the double must answer like the REAL ModelBridge.
  // chat() resolves to a plain string in the common path; the old double
  // returned {content} for chatStructured — a shape the real bridge never
  // produces, which is why a responder that could never work looked green.
  const bridge = { _genesisDir: base, chat: async () => { mc++; return 'Line for the visitor.'; } };
  // v7.9.46 field-fix: the REAL ToolRegistry, not a hand-rolled double. The
  // double accepted an object argument and so hid that the vestibule tools
  // were registered against an API that does not exist — invisible until
  // the wiring was fixed and listTools() threw in a real boot.
  const { ToolRegistry } = require('../../src/agent/intelligence/ToolRegistry.js');
  const reg = new ToolRegistry({});
  registerV7946Tools(reg, { vestibuleGate: gate, modelBridge: bridge, idleMindStatus: { getStatus: () => ({ isIdle: true, idleSince: 60000, recentActivities: [{ activity: 'reflect' }] }) }, goalStack: { getActive: () => [] }, dreamCycle: dream, bus: { fire() {} } });
  await ta('V5/H6: without stimme.json the door answers the system line', async () => {
    assert.strictEqual(await reg.execute('vestibule-status', { __circle: 'outer', __who: 'Gast' }), 'vestibule not yet opened');
  });
  await ta('V5/L9: voice tool validates slots and emptiness', async () => {
    let r = await reg.execute('vestibule-voice', { statusOuter: 'x {geheim}' }); assert.strictEqual(r.ok, false);
    r = await reg.execute('vestibule-voice', { statusOuter: 'Aktiv: {focus}.', statusMiddle: 'Bei {focus} seit {since}, {who}.', absentLine: '{who}, noch nicht gesehen.', closedLine: 'Nicht erreichbar.' });
    assert.strictEqual(r.complete, true);
  });
  await ta('V3/L6: full circle gets raw snapshot with ZERO model calls', async () => {
    mc = 0; const r = await reg.execute('vestibule-status', { __circle: 'full', __who: 'inner' });
    assert.strictEqual(mc, 0); assert.ok(JSON.parse(r).focus);
  });
  await ta('V3/H2: middle knock = exactly one model call, his structure', async () => {
    mc = 0; const r = await reg.execute('vestibule-status', { __circle: 'middle', __who: 'Neo', question: 'hi' });
    assert.strictEqual(mc, 1); assert.ok(String(r).length > 0);
  });
  await ta('V3/H4: second knock within a minute = absent WITHOUT model call', async () => {
    mc = 0; const r = await reg.execute('vestibule-status', { __circle: 'middle', __who: 'Neo', question: 'again' });
    assert.strictEqual(mc, 0); assert.ok(/noch nicht gesehen/.test(r));
  });
  await ta('V4/L3: shield during dream = closedLine, ZERO model calls', async () => {
    dream.active = true; mc = 0;
    const r = await reg.execute('vestibule-status', { __circle: 'outer', __who: 'Gast2' });
    assert.strictEqual(mc, 0); assert.ok(/Nicht erreichbar/.test(r));
  });
  await ta('V4/L8: inner-circle pass during dream is recorded as override', async () => {
    await reg.execute('vestibule-status', { __circle: 'full', __who: 'inner' }); dream.active = false;
    assert.ok(fs.readFileSync(gate.bookPath, 'utf8').includes('"override"'));
  });
  await ta('V5/H5: blocked visitor stays out at the gate (401 road)', async () => {
    assert.strictEqual(gate.circleFor('kB').circle, 'blocked');
    assert.strictEqual(gate.allowCall(VESTIBULE_TOOL, 'blocked'), false);
  });
  t('V3/L7: unanswered knocks appear as ONE awakening line', () => {
    const { collectThreads } = require('../../src/agent/cognitive/OpenThreads.js');
    const th = collectThreads(base, Date.now()).map((x) => x.satz);
    assert.ok(th.some((s) => /Besuche in der Vorhalle: \d+ unbeantwortet/.test(s)));
    assert.ok(th.some((s) => /Daniel hat während deines Traums/.test(s)));
  });
  t('V2: dream cycle carries an honest active flag (wrapper present)', () => {
    const src = fs.readFileSync(require.resolve('../../src/agent/cognitive/DreamCycle.js'), 'utf-8');
    assert.ok(src.includes('this.active = true') && src.includes('finally { this.active = false; }'));
  });

  console.log(`\n${pass} passed · ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
