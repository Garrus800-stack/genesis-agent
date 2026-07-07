// ============================================================
// TEST — v7.9.33 Wandel-Register (AP-2)
//
// Contracts for the change witness: journal durability, the six line
// forms, batch pins on BOTH KG prune paths (cap and stale), the S11
// durability staging, the two guardrail source pins (never prompt,
// never identity summary), and the complete /changes slash triangle
// routed through classifyAsync (v7.9.30 slash discipline).
// Plan: ap2-wandel-register-plan-v6.md (S1–S9, S11).
// ============================================================

const { describe, test, run } = require('../harness');
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');

// ── Test doubles ────────────────────────────────────────────

function makeBus() {
  const h = {};
  return {
    h,
    on(evt, fn) { (h[evt] = h[evt] || []).push(fn); return () => {}; },
    fire(evt, data) { for (const fn of h[evt] || []) fn(data); },
  };
}

/** Real-disk storage spy: appends land in a tmp dir (durability contract)
 *  and every call records its effective fsync flag (S11 contract). */
function makeStorage() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'g33-reg-'));
  const calls = [];
  return {
    dir, calls,
    appendText(filename, text, opts) {
      calls.push({ filename, fsync: !(opts && opts.fsync === false) });
      fs.appendFileSync(path.join(dir, filename), text, 'utf-8');
    },
    readText(filename, fallback = '') {
      try { return fs.readFileSync(path.join(dir, filename), 'utf-8'); }
      catch (_e) { return fallback; }
    },
    cleanup() { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_e) { /* */ } },
  };
}

function makeRegister() {
  const { ChangeRegister } = require(path.join(ROOT, 'src/agent/cognitive/ChangeRegister'));
  const bus = makeBus();
  const storage = makeStorage();
  const reg = new ChangeRegister({ bus, storage, clock: { now: () => 1751791000000 } });
  reg.start();
  return { bus, storage, reg };
}

function lastLine(storage) {
  const raw = storage.readText('change-register.jsonl');
  const lines = raw.split('\n').filter(Boolean);
  return JSON.parse(lines[lines.length - 1]);
}

// ── S1: durability ──────────────────────────────────────────

describe('v7.9.33 S1 — journal durability', () => {
  test('a line is parsed back from disk before the handler returns', () => {
    const { bus, storage, reg } = makeRegister();
    bus.fire('core-memory:released', { id: 'cm_x', reason: 'review', label: 'a moment' });
    const raw = fs.readFileSync(path.join(storage.dir, 'change-register.jsonl'), 'utf-8');
    const line = JSON.parse(raw.trim());
    assert.strictEqual(line.kind, 'core-memory-released');
    assert(/^\d{4}-\d{2}-\d{2}T/.test(line.ts), 'ISO timestamp expected');
    reg.stop(); storage.cleanup();
  });
});

// ── S1/S4/F: the six line forms ─────────────────────────────

describe('v7.9.33 — six sources, one correct line each', () => {
  test('kg-pruned (cap default) with capped example identities', () => {
    const { bus, storage, reg } = makeRegister();
    bus.fire('knowledge:nodes-pruned', {
      count: 1, remaining: 99,
      examples: [{ id: 'n1', label: 'x'.repeat(200), type: 'concept' }],
    });
    const l = lastLine(storage);
    assert.strictEqual(l.kind, 'kg-pruned');
    assert.strictEqual(l.cause, 'cap');
    assert.strictEqual(l.count, 1);
    assert.strictEqual(l.remaining, 99);
    assert.strictEqual(l.examples[0].label.length, 80);
    assert.strictEqual(l.examples[0].type, 'concept');
    reg.stop(); storage.cleanup();
  });

  test('schema-pruned passes name strings through untouched', () => {
    const { bus, storage, reg } = makeRegister();
    bus.fire('schema:pruned', { removed: 2, remaining: 48, examples: ['alpha', 'beta'] });
    const l = lastLine(storage);
    assert.strictEqual(l.kind, 'schema-pruned');
    assert.strictEqual(l.removed, 2);
    assert.deepStrictEqual(l.examples, ['alpha', 'beta']);
    reg.stop(); storage.cleanup();
  });

  test('core-memory-released carries id, reason, label', () => {
    const { bus, storage, reg } = makeRegister();
    bus.fire('core-memory:released', { id: 'cm_1', reason: 'pin-review', label: 'ein Moment' });
    const l = lastLine(storage);
    assert.strictEqual(l.kind, 'core-memory-released');
    assert.strictEqual(l.id, 'cm_1');
    assert.strictEqual(l.reason, 'pin-review');
    assert.strictEqual(l.label, 'ein Moment');
    reg.stop(); storage.cleanup();
  });

  test('memory-self-released; missing summary → label null', () => {
    const { bus, storage, reg } = makeRegister();
    bus.fire('memory:self-released', { episodeId: 'ep_7' });
    const l = lastLine(storage);
    assert.strictEqual(l.kind, 'memory-self-released');
    assert.strictEqual(l.episodeId, 'ep_7');
    assert.strictEqual(l.label, null);
    reg.stop(); storage.cleanup();
  });

  test('memory-consolidated maps fromLayer/toLayer to from/to', () => {
    const { bus, storage, reg } = makeRegister();
    bus.fire('memory:consolidated', { episodeId: 'ep9', fromLayer: 1, toLayer: 2, sizeReduction: 0.4, label: 'Tag am Meer' });
    const l = lastLine(storage);
    assert.strictEqual(l.kind, 'memory-consolidated');
    assert.strictEqual(l.from, 1);
    assert.strictEqual(l.to, 2);
    assert.strictEqual(l.sizeReduction, 0.4);
    reg.stop(); storage.cleanup();
  });

  test('UnifiedMemory topic promotion is deliberately NOT journalised', () => {
    const { bus, storage, reg } = makeRegister();
    bus.fire('memory:consolidated', { promotedCount: 3, topics: ['topic:a', 'topic:b', 'topic:c'] });
    const raw = storage.readText('change-register.jsonl');
    assert.strictEqual(raw, '', 'promotion (gain) must not create a change-loss line');
    bus.fire('memory:consolidated', { episodeId: 'ep1', fromLayer: 0, toLayer: 1, label: 'x' });
    assert.strictEqual(lastLine(storage).kind, 'memory-consolidated');
    reg.stop(); storage.cleanup();
  });

  test('fitness line derives baseline self | peer | null', () => {
    const { bus, storage, reg } = makeRegister();
    bus.fire('fitness:evaluated', { score: 0.71, selfBaselineUsed: true, belowMedian: false, archivalRecommended: false });
    assert.strictEqual(lastLine(storage).baseline, 'self');
    bus.fire('fitness:evaluated', { score: 0.55, selfBaselineUsed: false, peerMedian: 0.6, belowMedian: true, archivalRecommended: false });
    let l = lastLine(storage);
    assert.strictEqual(l.baseline, 'peer');
    assert.strictEqual(l.belowMedian, true);
    bus.fire('fitness:evaluated', { score: 0.5 });
    l = lastLine(storage);
    assert.strictEqual(l.baseline, null);
    assert.strictEqual(l.archival, false);
    reg.stop(); storage.cleanup();
  });
});

// ── S2′: both prune paths, behavioral ───────────────────────

describe('v7.9.33 S2′ — batch pins on both KG prune paths', () => {
  test('GraphStore.pruneNodes returns { count, examples ≤ 20 } — one object for 30 removals', () => {
    const { GraphStore } = require(path.join(ROOT, 'src/agent/foundation/GraphStore'));
    const g = new GraphStore();
    for (let i = 0; i < 40; i++) g.addNode('concept', `node-${i}`);
    const r = g.pruneNodes(10);
    assert.strictEqual(r.count, 30);
    assert.strictEqual(r.examples.length, 20);
    assert(r.examples[0].id && typeof r.examples[0].label === 'string');
    assert.strictEqual(g.nodes.size, 10);
  });

  test('KG.pruneStale fires ONE nodes-pruned event, cause stale, with examples', () => {
    const { KnowledgeGraph } = require(path.join(ROOT, 'src/agent/foundation/KnowledgeGraph'));
    const fired = [];
    const bus = { on: () => () => {}, fire: (e, d) => fired.push({ e, d }) };
    const kg = new KnowledgeGraph({ bus, storage: null, settings: { get: (_k, dflt) => dflt } });
    for (let i = 0; i < 30; i++) kg.graph.addNode('concept', `stale-${i}`);
    const old = Date.now() - 10 * 24 * 3600 * 1000;
    for (const [, node] of kg.graph.nodes) { node.created = old; node.accessCount = 0; }
    const removed = kg.pruneStale(7);
    assert.strictEqual(removed, 30, 'numeric return contract kept');
    const evs = fired.filter(f => f.e === 'knowledge:nodes-pruned');
    assert.strictEqual(evs.length, 1, 'exactly ONE event for the whole sweep');
    assert.strictEqual(evs[0].d.cause, 'stale');
    assert.strictEqual(evs[0].d.count, 30);
    assert.strictEqual(evs[0].d.examples.length, 20);
    assert.strictEqual(evs[0].d.remaining, 0);
  });

  test('source pin: the cap call site destructures and tags cause cap', () => {
    const src = fs.readFileSync(path.join(ROOT, 'src/agent/foundation/KnowledgeGraph.js'), 'utf8');
    assert(/const \{ count: pruned, examples \} = this\.graph\.pruneNodes/.test(src));
    assert(/cause: 'cap'/.test(src));
  });
});

// ── S11: durability staging via storage spy ─────────────────

describe('v7.9.33 S11 — differentiated witness hardness', () => {
  test('cap line skips fsync; stale and every deliberate kind keep it', () => {
    const { bus, storage, reg } = makeRegister();
    bus.fire('knowledge:nodes-pruned', { count: 1, remaining: 9, examples: [] });               // cap
    bus.fire('knowledge:nodes-pruned', { count: 3, remaining: 6, cause: 'stale', examples: [] });
    bus.fire('schema:pruned', { removed: 1, remaining: 5, examples: [] });
    bus.fire('memory:self-released', { episodeId: 'e1', label: null });
    bus.fire('fitness:evaluated', { score: 0.5 });
    const flags = storage.calls.map(c => c.fsync);
    assert.deepStrictEqual(flags, [false, true, true, true, true]);
    reg.stop(); storage.cleanup();
  });

  test('StorageService.appendText stays backward compatible (default fsync path)', () => {
    const src = fs.readFileSync(path.join(ROOT, 'src/agent/foundation/StorageService.js'), 'utf8');
    assert(/appendText\(filename, text, \{ fsync = true \} = \{\}\)/.test(src));
    assert(/if \(fsync\) \{/.test(src));
  });
});

// ── S6: guardrails ──────────────────────────────────────────

describe('v7.9.33 S6 — register never reaches prompt or identity summary', () => {
  test('no PromptBuilder file references the register', () => {
    const dir = path.join(ROOT, 'src/agent/intelligence');
    const files = fs.readdirSync(dir).filter(f => f.startsWith('PromptBuilder') && f.endsWith('.js'));
    assert(files.length >= 3, 'PromptBuilder set expected');
    for (const f of files) {
      const src = fs.readFileSync(path.join(dir, f), 'utf8');
      assert(!src.includes('ChangeRegister'), f + ' must not reference ChangeRegister');
      assert(!src.includes('change-register'), f + ' must not read the journal');
    }
  });

  test('SelfNarrative (getIdentitySummary chain) stays untouched', () => {
    const src = fs.readFileSync(path.join(ROOT, 'src/agent/cognitive/SelfNarrative.js'), 'utf8');
    assert(!src.includes('ChangeRegister'));
    assert(!src.includes('change-register'));
  });
});

// ── S7: the /changes slash triangle ─────────────────────────

describe('v7.9.33 S7 — /changes routed, registered, honest', () => {
  test('classifyAsync: /changes → changes; bare word does NOT route (slash discipline)', async () => {
    const { IntentRouter } = require(path.join(ROOT, 'src/agent/intelligence/IntentRouter'));
    const router = new IntentRouter();
    const hit = await router.classifyAsync('/changes 5');
    assert.strictEqual(hit.type, 'changes');
    const miss = await router.classifyAsync('changes since yesterday');
    assert.notStrictEqual(miss.type, 'changes');
  });

  test('slash-commands registry carries the changes entry (triangle point 3)', () => {
    const { SLASH_COMMANDS } = require(path.join(ROOT, 'src/agent/intelligence/slash-commands'));
    const list = Array.isArray(SLASH_COMMANDS) ? SLASH_COMMANDS
      : (SLASH_COMMANDS && SLASH_COMMANDS.commands) || [];
    const entry = list.find(c => c && c.name === 'changes');
    assert(entry, 'registry entry missing');
    assert.strictEqual(entry.sinceVersion, 'v7.9.33');
  });

  test('handler: empty journal answers honestly (EN)', async () => {
    const { commandHandlersMemory } = require(path.join(ROOT, 'src/agent/hexagonal/CommandHandlersMemory'));
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'g33-cmd-'));
    const fake = { _genesisDir: dir, lang: { current: 'en' } };
    const out = await commandHandlersMemory.changes.call(fake, '/changes');
    assert(out.includes('No change entries yet'));
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('handler: parses N, caps at 100, groups by kind', async () => {
    const { commandHandlersMemory } = require(path.join(ROOT, 'src/agent/hexagonal/CommandHandlersMemory'));
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'g33-cmd-'));
    const file = path.join(dir, 'change-register.jsonl');
    const rows = [];
    for (let i = 0; i < 30; i++) rows.push(JSON.stringify({ ts: '2026-07-06T10:00:00.000Z', kind: 'kg-pruned', cause: 'stale', count: 1, remaining: 9, examples: [{ id: 'n' + i, label: 'Knoten ' + i, type: 'concept' }] }));
    rows.push(JSON.stringify({ ts: '2026-07-06T11:00:00.000Z', kind: 'fitness', score: 0.7123, baseline: 'self', belowMedian: false, archival: false }));
    fs.writeFileSync(file, rows.join('\n') + '\n');
    const fake = { _genesisDir: dir, lang: { current: 'en' } };
    const out5 = await commandHandlersMemory.changes.call(fake, '/changes 5');
    assert(out5.includes('last 5 entries'));
    const out999 = await commandHandlersMemory.changes.call(fake, '/changes 999');
    assert(out999.includes('last 31 entries'), 'cap at 100 keeps all 31 here');
    assert(out999.includes('kg-pruned (30)'));
    assert(out999.includes('fitness (1)'));
    assert(out999.includes('score 0.712'));
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('readTail returns the last N parsed lines, defensive on partials', () => {
    const { bus, storage, reg } = makeRegister();
    for (let i = 0; i < 5; i++) bus.fire('memory:self-released', { episodeId: 'e' + i, label: 'L' + i });
    fs.appendFileSync(path.join(storage.dir, 'change-register.jsonl'), '{"broken', 'utf-8');
    const tail = reg.readTail(3);
    assert.strictEqual(tail.length, 3);
    assert.strictEqual(tail[2].episodeId, 'e4');
    reg.stop(); storage.cleanup();
  });
});

if (require.main === module) run();
