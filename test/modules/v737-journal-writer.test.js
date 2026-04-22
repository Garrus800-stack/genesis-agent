// ============================================================
// v7.3.7 #4a — JournalWriter
//
// Verified:
//   - Three visibilities (private/shared/public) with correct files
//   - Monthly rotation by ISO-YM via injected clock
//   - public.jsonl never rotates
//   - Index tracks file → entry count, totalEntries
//   - readLast(n) returns most recent N entries
//   - Crash robustness: corrupt _index.json triggers rebuild
//   - Empty/invalid content is no-op
//   - bus emits journal:written with correct payload
// ============================================================

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { JournalWriter } = require('../../src/agent/memory/JournalWriter');

function makeFakeClock(startMs = Date.UTC(2026, 3, 21)) {  // 2026-04-21
  let t = startMs;
  return {
    now: () => t,
    advance: (ms) => { t += ms; },
    set: (ms) => { t = ms; },
  };
}

function makeMockBus() {
  const events = [];
  return {
    emit: (name, payload) => { events.push({ name, payload }); },
    events,
  };
}

let tempDir;
let bus;
let clock;
let jw;

describe('v7.3.7 #4a — JournalWriter', () => {

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'genesis-journal-test-'));
    bus = makeMockBus();
    clock = makeFakeClock();
    jw = new JournalWriter({ bus, storageDir: tempDir, clock });
  });

  afterEach(() => {
    try { jw.stop(); } catch {}
    try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch {}
  });

  // ── Construction & dirs ───────────────────────────────────

  it('creates journal/ subdirectory in storageDir', () => {
    assert.ok(fs.existsSync(path.join(tempDir, 'journal')));
  });

  it('throws without storageDir', () => {
    assert.throws(() => new JournalWriter({ bus }));
  });

  // ── write basics ──────────────────────────────────────────

  it('write() returns the persisted record', () => {
    const r = jw.write({ visibility: 'shared', source: 'genesis', content: 'hello' });
    assert.ok(r);
    assert.strictEqual(r.visibility, 'shared');
    assert.strictEqual(r.source, 'genesis');
    assert.strictEqual(r.content, 'hello');
    assert.deepStrictEqual(r.tags, []);
    assert.deepStrictEqual(r.meta, {});
    assert.ok(r.ts);
  });

  it('write() returns null for empty content', () => {
    assert.strictEqual(jw.write({ content: '' }), null);
    assert.strictEqual(jw.write({ content: null }), null);
    assert.strictEqual(jw.write({}), null);
  });

  it('write() is no-op (returns null) for non-string content', () => {
    assert.strictEqual(jw.write({ content: 123 }), null);
    assert.strictEqual(jw.write({ content: { a: 1 } }), null);
  });

  // ── visibility files ──────────────────────────────────────

  it('private writes go to private-YYYY-MM.jsonl', () => {
    jw.write({ visibility: 'private', content: 'secret' });
    assert.ok(fs.existsSync(path.join(tempDir, 'journal', 'private-2026-04.jsonl')));
    assert.ok(!fs.existsSync(path.join(tempDir, 'journal', 'shared-2026-04.jsonl')));
  });

  it('shared writes go to shared-YYYY-MM.jsonl', () => {
    jw.write({ visibility: 'shared', content: 'with garrus' });
    assert.ok(fs.existsSync(path.join(tempDir, 'journal', 'shared-2026-04.jsonl')));
  });

  it('public writes go to public.jsonl (no date)', () => {
    jw.write({ visibility: 'public', content: 'docs' });
    assert.ok(fs.existsSync(path.join(tempDir, 'journal', 'public.jsonl')));
  });

  it('invalid visibility falls back to shared', () => {
    jw.write({ visibility: 'broadcast', content: 'oops' });
    assert.ok(fs.existsSync(path.join(tempDir, 'journal', 'shared-2026-04.jsonl')));
  });

  // ── monthly rotation ──────────────────────────────────────

  it('rotates to new file when month changes', () => {
    jw.write({ visibility: 'shared', content: 'april' });
    clock.set(Date.UTC(2026, 4, 5));  // 2026-05-05
    jw.write({ visibility: 'shared', content: 'may' });

    assert.ok(fs.existsSync(path.join(tempDir, 'journal', 'shared-2026-04.jsonl')));
    assert.ok(fs.existsSync(path.join(tempDir, 'journal', 'shared-2026-05.jsonl')));
  });

  it('public.jsonl does NOT rotate across months', () => {
    jw.write({ visibility: 'public', content: 'first' });
    clock.set(Date.UTC(2026, 5, 1));  // 2026-06-01
    jw.write({ visibility: 'public', content: 'second' });

    const files = fs.readdirSync(path.join(tempDir, 'journal'))
      .filter(f => f.startsWith('public'));
    assert.strictEqual(files.length, 1);
    assert.strictEqual(files[0], 'public.jsonl');
  });

  // ── readLast ──────────────────────────────────────────────

  it('readLast returns empty array if no entries', () => {
    assert.deepStrictEqual(jw.readLast('shared', 5), []);
  });

  it('readLast returns up to N most recent entries', () => {
    for (let i = 1; i <= 10; i++) {
      jw.write({ visibility: 'shared', content: `entry-${i}` });
    }
    const last3 = jw.readLast('shared', 3);
    assert.strictEqual(last3.length, 3);
    assert.strictEqual(last3[0].content, 'entry-8');
    assert.strictEqual(last3[2].content, 'entry-10');
  });

  it('readLast skips corrupt JSONL lines', () => {
    jw.write({ visibility: 'shared', content: 'good-1' });
    // Inject a corrupt line manually
    fs.appendFileSync(path.join(tempDir, 'journal', 'shared-2026-04.jsonl'), 'NOT JSON\n');
    jw.write({ visibility: 'shared', content: 'good-2' });

    const all = jw.readLast('shared', 10);
    assert.strictEqual(all.length, 2);
    assert.strictEqual(all[0].content, 'good-1');
    assert.strictEqual(all[1].content, 'good-2');
  });

  // ── index tracking ────────────────────────────────────────

  it('updates _index.json with file counts and totalEntries', () => {
    jw.write({ visibility: 'shared', content: 'a' });
    jw.write({ visibility: 'shared', content: 'b' });
    jw.write({ visibility: 'private', content: 'c' });

    const idx = JSON.parse(fs.readFileSync(path.join(tempDir, 'journal', '_index.json'), 'utf8'));
    assert.strictEqual(idx.totalEntries, 3);
    assert.strictEqual(idx.files['shared-2026-04.jsonl'], 2);
    assert.strictEqual(idx.files['private-2026-04.jsonl'], 1);
  });

  it('rebuilds _index.json from scratch when corrupt', () => {
    fs.writeFileSync(path.join(tempDir, 'journal', '_index.json'), '{NOT JSON');
    // New instance reads corrupt file
    const jw2 = new JournalWriter({ bus, storageDir: tempDir, clock });
    jw2.write({ visibility: 'shared', content: 'recovery' });
    const rep = jw2.getReport();
    assert.strictEqual(rep.totalEntries, 1);
    jw2.stop();
  });

  // ── bus emit ──────────────────────────────────────────────

  it('emits journal:written with correct payload on each write', () => {
    jw.write({ visibility: 'shared', source: 'dreamcycle', content: 'dream-report', tags: ['dream-report'] });
    const ev = bus.events.find(e => e.name === 'journal:written');
    assert.ok(ev);
    assert.strictEqual(ev.payload.visibility, 'shared');
    assert.strictEqual(ev.payload.source, 'dreamcycle');
    assert.strictEqual(ev.payload.byteLength, 'dream-report'.length);
    assert.deepStrictEqual(ev.payload.tags, ['dream-report']);
  });

  // ── diagnostics ───────────────────────────────────────────

  it('getReport returns dir, totalEntries, files', () => {
    jw.write({ visibility: 'shared', content: 'x' });
    const r = jw.getReport();
    assert.ok(r.dir.includes('journal'));
    assert.strictEqual(r.totalEntries, 1);
    assert.ok(r.files['shared-2026-04.jsonl']);
  });

});
