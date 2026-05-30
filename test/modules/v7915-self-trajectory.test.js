#!/usr/bin/env node
// ============================================================
// GENESIS — test/modules/v7915-self-trajectory.test.js
//
// v7.9.15 (SelfTrajectory: schema + write side). Covers the new
// service, the /trajectory handler, and the wiring triad:
//
//   1. Wiring triad — trajectory present in slash-commands,
//      IntentPatterns, and registered as a handler (the three
//      places validate-intent-wiring --strict cross-checks).
//   2. Schema & persistence — empty read, commit roundtrip,
//      cycle_id format + increment, author, schema_version
//      hard-fail.
//   3. normalizeFieldName — umlaut fold, case, english alias.
//   4. Draft lifecycle & commit guard — stub fields, empty /
//      stub / first-entry-note refusals, second-entry leniency,
//      editing_history.
//   5. Handler routing & multi-line set parser — first-colon
//      split with internal colon + newline, no-silent-regenerate.
//   6. Offline both paths — stub (no model) vs parsed model JSON.
//   7. late_notes byte-stability — untouched entries keep their
//      exact bytes across an append.
//   8. refuse token — a deliberate "refuse" value commits.
//
// Offline by construction: no model is ever called (stub path, or
// a mock modelBridge). Storage is a real StorageService rooted at
// a throwaway temp dir.
// ============================================================

'use strict';

const { describe, test, assert, assertEqual, assertDeepEqual, assertThrows, run } =
  require('../harness');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const { StorageService } = require(path.join(ROOT, 'src/agent/foundation/StorageService'));
const ST = require(path.join(ROOT, 'src/agent/cognitive/SelfTrajectory'));
const {
  SelfTrajectory, SCHEMA_VERSION, FIELD_NAMES, STUB_SENTINEL, REFUSE_TOKEN,
  JOURNAL_FILE, normalizeFieldName,
} = ST;
const { commandHandlersTrajectory } =
  require(path.join(ROOT, 'src/agent/hexagonal/CommandHandlersTrajectory'));

// ── fixtures ────────────────────────────────────────────────

function freshDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'st-test-'));
}

const FAKE_GENOME = { getTraits: () => ({
  curiosity: 0.6, caution: 0.5, verbosity: 0.5, riskTolerance: 0.3,
  socialDrive: 0.5, consolidation: 0.6, selfAwareness: 0.5,
}) };
const FAKE_LESSONS = { getAll: () => ([
  { insight: 'A', useCount: 9 }, { insight: 'B', useCount: 3 },
  { insight: 'C', useCount: 15 }, { insight: 'D', useCount: 1 }, { insight: 'E', useCount: 7 },
]) };
const FAKE_CSM = { buildPromptContext: () => 'Capability floor: CODE 70%. Weakness: RUN_TESTS.' };

function freshST({ model = null } = {}) {
  const dir = freshDir();
  const storage = new StorageService(dir);
  const st = new SelfTrajectory({
    storage, genome: FAKE_GENOME, cognitiveSelfModel: FAKE_CSM, lessonsStore: FAKE_LESSONS,
  });
  if (model) st.modelBridge = model;
  return { st, dir, storage };
}

function handlerFor(st) {
  return Object.assign({ selfTrajectory: st }, commandHandlersTrajectory);
}

// Commit a complete entry (helper for tests that need existing entries).
async function commitEntry(st, suffix) {
  await st.generateDraft();
  for (const k of FIELD_NAMES) st.setDraftField(k, `${suffix}-${k}`);
  st.setDraftNote('genesis', `${suffix}-gn`);
  st.setDraftNote('garrus', `${suffix}-hn`);
  return st.commit();
}

// ── 1. wiring triad ─────────────────────────────────────────

describe('v7.9.15 — wiring triad', () => {
  const slash = fs.readFileSync(path.join(ROOT, 'src/agent/intelligence/slash-commands.js'), 'utf8');
  const patterns = fs.readFileSync(path.join(ROOT, 'src/agent/intelligence/IntentPatterns.js'), 'utf8');
  const handlers = fs.readFileSync(path.join(ROOT, 'src/agent/hexagonal/CommandHandlers.js'), 'utf8');

  test('slash-commands registers trajectory (+ trajektorie alias)', () => {
    assert(/name:\s*'trajectory'/.test(slash), 'trajectory in SLASH_COMMANDS');
    assert(/'trajektorie'/.test(slash), 'trajektorie alias present');
  });
  test('IntentPatterns defines a trajectory intent', () => {
    assert(/'trajectory'/.test(patterns), 'trajectory intent key present');
    assert(/\\\/\(\?:trajectory\|trajektorie\)/.test(patterns), 'slash-anchored pattern present');
  });
  test('CommandHandlers registers + mixes in trajectory', () => {
    assert(/registerHandler\('trajectory'/.test(handlers), 'handler registered');
    assert(/commandHandlersTrajectory/.test(handlers), 'mixin merged');
  });
});

// ── 2. schema & persistence ─────────────────────────────────

describe('v7.9.15 — schema & persistence', () => {
  test('empty journal reads as []', () => {
    const { st } = freshST();
    assertDeepEqual(st.readEntries(), [], 'no file -> []');
    assertEqual(st.isFirstEntry(), true, 'isFirstEntry true');
  });

  test('commit roundtrip: shape, cycle_id, author, schema_version', async () => {
    const { st } = freshST();
    const r = await commitEntry(st, 'x');
    assert(r.ok, 'commit ok');
    const e = r.entry;
    assertEqual(e.schema_version, SCHEMA_VERSION, 'schema_version stamped');
    assert(/^\d{4}-\d{2}-\d{2}\.cycle\.1$/.test(e.cycle_id), 'cycle_id format');
    assertEqual(e.event_count, null, 'event_count null (no engine yet)');
    assertEqual(e.first_entry, true, 'first entry flagged');
    assertDeepEqual(e.author, ['genesis', 'garrus'], 'author both (garrus noted)');
    assertEqual(st.readEntries().length, 1, 'one entry persisted');
    assertEqual(st.latestEntry().cycle_id, e.cycle_id, 'latestEntry matches');
    assertEqual(st.readEntry(e.cycle_id).fields.traits, 'x-traits', 'readEntry by id');
  });

  test('cycle_id increments across entries', async () => {
    const { st } = freshST();
    const a = await commitEntry(st, 'a');
    const b = await commitEntry(st, 'b');
    assert(/\.cycle\.1$/.test(a.entry.cycle_id), 'first n=1');
    assert(/\.cycle\.2$/.test(b.entry.cycle_id), 'second n=2');
    assertEqual(b.entry.first_entry, false, 'second not first');
  });

  test('schema_version mismatch hard-fails the read', async () => {
    const { st, dir } = freshST();
    await commitEntry(st, 'x');
    fs.appendFileSync(path.join(dir, JOURNAL_FILE),
      JSON.stringify({ cycle_id: 'z.cycle.99', schema_version: 2 }) + '\n');
    assertThrows(() => st.readEntries(), 'unsupported schema_version must throw');
  });
});

// ── 3. normalizeFieldName ───────────────────────────────────

describe('v7.9.15 — normalizeFieldName', () => {
  test('umlaut folding', () => assertEqual(normalizeFieldName('schwäche'), 'schwaeche'));
  test('case-insensitive', () => assertEqual(normalizeFieldName('Wachstum'), 'wachstum'));
  test('english alias growth', () => assertEqual(normalizeFieldName('growth'), 'wachstum'));
  test('english alias relationship', () => assertEqual(normalizeFieldName('relationship'), 'beziehung'));
  test('canonical passes through', () => assertEqual(normalizeFieldName('value'), 'value'));
  test('unknown -> null', () => assertEqual(normalizeFieldName('nope'), null));
});

// ── 4. draft lifecycle & commit guard ───────────────────────

describe('v7.9.15 — draft lifecycle & commit guard', () => {
  test('stub draft: six sentinel fields, empty genesis_note', async () => {
    const { st } = freshST(); // no model
    await st.generateDraft();
    const d = st.readDraft();
    assert(d && d._draft === true, 'draft persisted');
    for (const k of FIELD_NAMES) assertEqual(d.fields[k], STUB_SENTINEL, `field ${k} is sentinel`);
    assertEqual(d.genesis_note, '', 'genesis_note empty in stub');
  });

  test('commit refuses unwritten stub fields', async () => {
    const { st } = freshST();
    await st.generateDraft();
    const r = st.commit();
    assertEqual(r.ok, false, 'blocked');
    assertEqual(r.error, 'stub-field', 'reason stub-field');
  });

  test('commit refuses an empty field', async () => {
    const { st } = freshST();
    await st.generateDraft();
    for (const k of FIELD_NAMES) st.setDraftField(k, 'v');
    st.setDraftField('emotion', '   '); // whitespace = empty
    const r = st.commit();
    assertEqual(r.error, 'empty-field', 'reason empty-field');
    assertEqual(r.detail, 'emotion', 'names the empty field');
  });

  test('first entry requires both notes', async () => {
    const { st } = freshST();
    await st.generateDraft();
    for (const k of FIELD_NAMES) st.setDraftField(k, 'v');
    let r = st.commit();
    assertDeepEqual([r.error, r.detail], ['first-entry-note', 'genesis_note'], 'needs genesis_note');
    st.setDraftNote('genesis', 'g');
    r = st.commit();
    assertDeepEqual([r.error, r.detail], ['first-entry-note', 'garrus_note'], 'needs garrus_note');
    st.setDraftNote('garrus', 'h');
    assert(st.commit().ok, 'commits once both notes present');
  });

  test('second entry does not require notes', async () => {
    const { st } = freshST();
    await commitEntry(st, 'first');
    await st.generateDraft();
    for (const k of FIELD_NAMES) st.setDraftField(k, 'v');
    // no notes set this time
    const r = st.commit();
    assert(r.ok, 'second entry commits without notes');
  });

  test('setDraftField records editing_history', async () => {
    const { st } = freshST();
    await st.generateDraft();
    st.setDraftField('value', 'first');
    st.setDraftField('value', 'second'); // both diffs kept
    const d = st.readDraft();
    const valueEdits = d.editing_history.filter(e => e.field === 'value');
    assertEqual(valueEdits.length, 2, 'both edits of value retained');
    assertEqual(valueEdits[1].from, 'first', 'second edit remembers prior value');
    assertEqual(valueEdits[1].to, 'second', 'second edit new value');
  });

  test('draft deleted after commit', async () => {
    const { st } = freshST();
    await commitEntry(st, 'x');
    assertEqual(st.hasDraft(), false, 'no draft after commit');
  });
});

// ── 5. handler routing & multi-line set parser ──────────────

describe('v7.9.15 — handler routing & set parser', () => {
  test('multi-line value with internal colon is preserved end-to-end', async () => {
    const { st } = freshST();
    const h = handlerFor(st);
    await h.trajectory('/trajectory new'); // stub draft
    await h.trajectory('/trajectory new set wachstum: Ich habe gelernt:\nGeduld zahlt sich aus.\nMehrzeilig.');
    assertEqual(st.readDraft().fields.wachstum,
      'Ich habe gelernt:\nGeduld zahlt sich aus.\nMehrzeilig.',
      'newlines + internal colon kept');
  });

  test('note routing: genesis/garrus with colon in text', async () => {
    const { st } = freshST();
    const h = handlerFor(st);
    await h.trajectory('/trajectory new');
    await h.trajectory('/trajectory new note garrus: a note: with a colon');
    assertEqual(st.readDraft().garrus_note, 'a note: with a colon', 'garrus note kept verbatim');
  });

  test('no-silent-regenerate over an existing draft', async () => {
    const { st } = freshST();
    const h = handlerFor(st);
    await h.trajectory('/trajectory new');
    st.setDraftField('value', 'work-in-progress');
    const out = await h.trajectory('/trajectory new'); // second bare new
    assert(/already in progress/.test(out), 'reports existing draft');
    assertEqual(st.readDraft().fields.value, 'work-in-progress', 'work not overwritten');
  });

  test('unknown field is rejected with the valid list', async () => {
    const { st } = freshST();
    const h = handlerFor(st);
    await h.trajectory('/trajectory new');
    const out = await h.trajectory('/trajectory new set bogus: x');
    assert(/Unknown field/.test(out), 'rejects unknown field');
  });

  test('bare /trajectory creates a draft; unknown subcommand is reported', async () => {
    const { st } = freshST();
    const h = handlerFor(st);
    assert(/draft created/i.test(await h.trajectory('/trajectory')), 'bare -> new (draft)');
    assert(/Unknown subcommand/.test(await h.trajectory('/trajectory bogus')), 'unknown -> reported');
  });

  test('graceful when the service is unavailable', async () => {
    const h = Object.assign({ selfTrajectory: null }, commandHandlersTrajectory);
    assertEqual(await h.trajectory('/trajectory show'), 'SelfTrajectory not available.');
  });
});

// ── 6. offline: both generation paths ───────────────────────

describe('v7.9.15 — offline generation paths', () => {
  test('stub path produces sentinel fields (no model)', async () => {
    const { st } = freshST();
    await st.generateDraft();
    assertEqual(st.readDraft().fields.traits, STUB_SENTINEL, 'sentinel without model');
  });

  test('model path parses a fenced JSON object', async () => {
    const model = { chat: async () =>
      '```json\n{"traits":"t","wachstum":"w","schwaeche":"s","beziehung":"b","emotion":"e","value":"v","genesis_note":"gn"}\n```' };
    const { st } = freshST({ model });
    await st.generateDraft();
    const d = st.readDraft();
    assertEqual(d.fields.traits, 't', 'parsed traits');
    assertEqual(d.genesis_note, 'gn', 'parsed note');
    assert(d.fields.value !== STUB_SENTINEL, 'not a stub when model present');
  });

  test('unparseable model output degrades to empty (editable) fields, not a crash', async () => {
    const model = { chat: async () => 'sorry, I could not produce JSON today' };
    const { st } = freshST({ model });
    await st.generateDraft();
    const d = st.readDraft();
    for (const k of FIELD_NAMES) assertEqual(d.fields[k], '', `field ${k} empty after parse miss`);
  });
});

// ── 7. late_notes byte-stability ────────────────────────────

describe('v7.9.15 — late_notes byte-stability', () => {
  test('appending a late note leaves untouched entries byte-identical', async () => {
    const { st, dir } = freshST();
    const first = await commitEntry(st, 'one');
    await commitEntry(st, 'two');
    const file = path.join(dir, JOURNAL_FILE);

    const before = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
    const r = st.addLateNote(first.entry.cycle_id, 'garrus', 'a later thought');
    assert(r.ok, 'late note ok');
    const after = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);

    assertEqual(after[1], before[1], 'second (untouched) entry is byte-identical');
    assert(after[0] !== before[0], 'first (modified) entry line changed');
    assertEqual(st.readEntry(first.entry.cycle_id).late_notes.length, 1, 'note recorded on target');
  });

  test('late note on a missing cycle_id is reported, not written', async () => {
    const { st } = freshST();
    await commitEntry(st, 'x');
    const r = st.addLateNote('does-not-exist', 'garrus', 'x');
    assertEqual(r.ok, false, 'rejected');
    assertEqual(r.error, 'cycle-not-found', 'reason given');
  });
});

// ── 8. refuse token ─────────────────────────────────────────

describe('v7.9.15 — refuse token', () => {
  test('a "refuse" field value is a valid commit', async () => {
    const { st } = freshST();
    await st.generateDraft();
    for (const k of FIELD_NAMES) st.setDraftField(k, 'v');
    st.setDraftField('value', REFUSE_TOKEN); // declined on purpose
    st.setDraftNote('genesis', 'g');
    st.setDraftNote('garrus', 'h');
    const r = st.commit();
    assert(r.ok, 'refuse commits (not empty, not stub)');
    assertEqual(st.latestEntry().fields.value, REFUSE_TOKEN, 'refuse preserved in journal');
  });
});

if (require.main === module) run();
