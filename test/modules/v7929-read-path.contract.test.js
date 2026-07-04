// ============================================================
// GENESIS — test/modules/v7929-read-path.contract.test.js
//
// v7.9.29 (Teil B): a request to read a NAMED file now reaches the
// deterministic read-file handler in both languages — "lies X.md",
// "schau/schaue dir X.md an", "zeig mir X.md", "read X.md",
// "show me X.json" — so it no longer falls through to a model that
// writes a shell command that never runs. Scoped to a filename WITH
// an extension, so a bare "schau dir das an" (no file) stays general.
//
// Decision #5: a question about whether Genesis has ALREADY read a
// file ("did you read X", "have you read X", "hattest du X gelesen")
// is a memory question, NOT a read action — it stays on the general
// path so Genesis answers honestly instead of silently reading and
// implying "yes". Both the intent (via lookbehind) and the source-read
// guard enforce this.
// ============================================================

const { describe, test, assert, assertEqual, run } = require('../harness');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const { IntentRouter } = require(path.join(ROOT, 'src/agent/intelligence/IntentRouter'));

const router = new IntentRouter({});
const cls = (m) => router.classifyAsync(m).then((r) => r.type);

describe('v7.9.29 read-path — named-file reads route to read-file', () => {
  test('German read verbs on a named file → read-file', async () => {
    assertEqual(await cls('lies ONTOGENESIS.md'), 'read-file');
    assertEqual(await cls('schau dir ONTOGENESIS.md an'), 'read-file');
    assertEqual(await cls('schaue dir ONTOGENESIS.md an'), 'read-file');
    assertEqual(await cls('zeig mir ONTOGENESIS.md'), 'read-file');
  });

  test('English read verbs on a named file → read-file', async () => {
    assertEqual(await cls('read ARCHITECTURE.md'), 'read-file');
    assertEqual(await cls('show me config.json'), 'read-file');
    assertEqual(await cls('can you read notes.txt'), 'read-file');
  });

  test('no file target → NOT read-file (stays general, no over-match)', async () => {
    assert((await cls('schau dir das an')) !== 'read-file', 'schau dir das an');
    assert((await cls('zeig mir das')) !== 'read-file', 'zeig mir das');
  });

  test('other file intents are unchanged', async () => {
    assertEqual(await cls('fasse ONTOGENESIS.md zusammen'), 'summarize-file');
    assert((await cls('erstelle eine datei test.md')) !== 'read-file', 'create stays create');
  });

  test('decision #5: "did/have you read X" is a memory question, not a read action', async () => {
    assert((await cls('did you read ARCHITECTURE.md?')) !== 'read-file', 'did you read');
    assert((await cls('have you read config.json')) !== 'read-file', 'have you read');
    assert((await cls('hattest du ONTOGENESIS.md gelesen?')) !== 'read-file', 'hattest du gelesen');
  });
});

describe('v7.9.29 read-path — source-read guard blocks silent past-read', () => {
  // The guard regex must fire on past-tense read questions (so the source-read
  // never silently attaches the file) and pass genuine read requests through.
  const guard = /\b(?:did|have)\s+you\b[\s\S]{0,40}?\bread\b|\b(?:hattest|hast)\s+du\b[\s\S]{0,60}?\b(?:gelesen|angesehen|angeschaut)\b/i;

  test('past-tense read questions are guarded', () => {
    assert(guard.test('did you read ARCHITECTURE.md?'), 'did you read');
    assert(guard.test('have you read it'), 'have you read');
    assert(guard.test('hattest du das gelesen?'), 'hattest du gelesen');
  });

  test('genuine read requests are not guarded', () => {
    assert(!guard.test('read ARCHITECTURE.md'), 'read imperative');
    assert(!guard.test('lies ONTOGENESIS.md'), 'lies imperative');
    assert(!guard.test('can you read notes.txt'), 'can you read');
  });

  test('the guard regex is present in ChatOrchestratorSourceRead', () => {
    const fs = require('fs');
    const src = fs.readFileSync(path.join(ROOT, 'src/agent/hexagonal/ChatOrchestratorSourceRead.js'), 'utf8');
    assert(/\(\?:did\|have\)\\s\+you/.test(src) || /did\|have/.test(src), 'guard present');
  });
});

run();
