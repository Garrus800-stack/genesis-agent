// ============================================================
// Test: SelfStatementLog hardening (v7.5.5 post-bug-fix)
//
// Covers:
//   - Pruning (>90 day shards removed)
//   - recordPromise() direct-API capture for ShellPlanner
//   - Race-safe per-message correlation of populated-flag
//   - Abbreviation protection in _extractStatements (Mr., e.g., z.B.)
//   - _currentIntent === undefined edge case
// ============================================================

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const { describe, test, assert, assertEqual, run } = require('../harness');
const { SelfStatementLog } = require('../../src/agent/cognitive/SelfStatementLog');

function freshDir() {
  const dir = path.join(os.tmpdir(), 'genesis-hard-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8));
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function makeService(opts = {}) {
  return new SelfStatementLog({
    bus: opts.bus || { fire: () => {} },
    storageDir: opts.dir || freshDir(),
    eventStore: opts.eventStore,
    flushDebounceMs: 0,
  });
}

// ────────────────────────────────────────────────────────
// Pruning
// ────────────────────────────────────────────────────────

describe('SelfStatementLog: prune (>90 days)', () => {
  test('removes shards older than 90 days (via auto-prune in constructor)', () => {
    const dir = freshDir();
    const stmtDir = path.join(dir, 'self-statements');
    fs.mkdirSync(stmtDir, { recursive: true });

    // Create 3 shards: 100 days old, 50 days old, today
    const oldDate = new Date(Date.now() - 100 * 86400 * 1000).toISOString().slice(0, 10);
    const midDate = new Date(Date.now() - 50 * 86400 * 1000).toISOString().slice(0, 10);
    const today = new Date().toISOString().slice(0, 10);

    fs.writeFileSync(path.join(stmtDir, `${oldDate}.jsonl`), '{}\n');
    fs.writeFileSync(path.join(stmtDir, `${midDate}.jsonl`), '{}\n');
    fs.writeFileSync(path.join(stmtDir, `${today}.jsonl`), '{}\n');

    // Constructor calls prune() automatically — shouldn't need manual call.
    makeService({ dir });

    assert(!fs.existsSync(path.join(stmtDir, `${oldDate}.jsonl`)), 'old shard gone');
    assert(fs.existsSync(path.join(stmtDir, `${midDate}.jsonl`)), 'mid shard kept');
    assert(fs.existsSync(path.join(stmtDir, `${today}.jsonl`)), 'today shard kept');
  });

  test('manual prune() returns 0 when nothing to remove', () => {
    const svc = makeService();
    assertEqual(svc.prune(), 0, 'idempotent — second call removes nothing');
  });

  test('handles non-existent dir gracefully', () => {
    const svc = makeService();
    // Force the dir to not exist
    fs.rmSync(svc._dir, { recursive: true, force: true });
    const removed = svc.prune();
    assertEqual(removed, 0, 'no error, returns 0');
  });

  test('ignores non-JSONL files', () => {
    const dir = freshDir();
    const stmtDir = path.join(dir, 'self-statements');
    fs.mkdirSync(stmtDir, { recursive: true });
    fs.writeFileSync(path.join(stmtDir, 'README.txt'), 'not a shard');
    const svc = makeService({ dir });
    const removed = svc.prune();
    assertEqual(removed, 0);
    assert(fs.existsSync(path.join(stmtDir, 'README.txt')), 'non-jsonl preserved');
  });
});

// ────────────────────────────────────────────────────────
// recordPromise (ShellPlanner integration)
// ────────────────────────────────────────────────────────

describe('SelfStatementLog: recordPromise (direct-API)', () => {
  test('captures plan as versprechen-record', async () => {
    const svc = makeService();
    svc.recordPromise({ kind: 'shell', task: 'install dependencies', steps: [1, 2, 3] });
    const out = await svc.recall();
    assertEqual(out.length, 1);
    assertEqual(out[0].type, 'versprechen');
    assert(out[0].text.includes('install dependencies'));
    assert(out[0].text.includes('3 steps'));
  });

  test('handles plan without steps array', async () => {
    const svc = makeService();
    svc.recordPromise({ kind: 'shell', task: 'simple task' });
    const out = await svc.recall();
    assertEqual(out.length, 1);
    assert(out[0].text.includes('simple task'));
  });

  test('ignores invalid input (defensive)', async () => {
    const svc = makeService();
    svc.recordPromise(null);
    svc.recordPromise(undefined);
    svc.recordPromise('string');
    const out = await svc.recall();
    assertEqual(out.length, 0, 'no records from invalid input');
  });

  test('does NOT fire contradiction (action-intents are not claims)', () => {
    const events = [];
    const svc = makeService({ bus: { fire: (e, d) => events.push({ e, d }) } });
    svc.recordPromise({ kind: 'shell', task: 'install', steps: [1] });
    const contradictions = events.filter(x => x.e === 'self-statement:contradiction');
    assertEqual(contradictions.length, 0);
  });
});

// ────────────────────────────────────────────────────────
// Race-safe per-message correlation
// ────────────────────────────────────────────────────────

describe('SelfStatementLog: race-safe message correlation', () => {
  test('per-message flag survives parallel turn interleaving', () => {
    const events = [];
    const svc = makeService({ bus: { fire: (e, d) => events.push({ e, d }) } });

    // Turn A: populated=true for "msg-a"
    svc.setLastIntrospectionPopulated(true, 'msg-a');
    // Turn B starts before Turn A completes — populated=false for "msg-b"
    svc.setLastIntrospectionPopulated(false, 'msg-b');

    // Turn A completes
    svc._captureResponse({ message: 'msg-a', response: 'Mein Modul ist hier.', intent: 'general' });
    // Turn B completes
    svc._captureResponse({ message: 'msg-b', response: 'Mein Modul ist hier.', intent: 'general' });

    const contradictions = events.filter(x => x.e === 'self-statement:contradiction');
    // msg-a was populated → no contradiction
    // msg-b was NOT populated → contradiction
    assertEqual(contradictions.length, 1, 'exactly one contradiction (turn B)');
  });

  test('falls back to global flag when message not provided', () => {
    const events = [];
    const svc = makeService({ bus: { fire: (e, d) => events.push({ e, d }) } });
    svc.setLastIntrospectionPopulated(false);  // no message arg
    svc._captureResponse({ message: '', response: 'Mein Modul ist hier.', intent: 'general' });
    const contradictions = events.filter(x => x.e === 'self-statement:contradiction');
    assertEqual(contradictions.length, 1, 'contradiction via fallback');
  });

  test('expired pending flags are GC-d', () => {
    const svc = makeService();
    svc.setLastIntrospectionPopulated(true, 'old-msg');
    // Manually expire the entry
    const hash = svc._hashShort('old-msg');
    svc._pendingFlags.get(hash).expiresAt = Date.now() - 1000;
    // Trigger GC by adding a new entry
    svc.setLastIntrospectionPopulated(true, 'new-msg');
    assert(!svc._pendingFlags.has(hash), 'old entry GC-d');
  });
});

// ────────────────────────────────────────────────────────
// Abbreviation protection in _extractStatements
// ────────────────────────────────────────────────────────

describe('SelfStatementLog: _extractStatements abbreviation handling', () => {
  test('does not split on Mr. / Dr. / Mrs.', () => {
    const svc = makeService();
    const out = svc._extractStatements('Ich sprach mit Mr. Smith. Mein Modul ist okay.');
    // Should be 2 sentences, not 4
    assertEqual(out.length, 2);
    assert(out[0].includes('Mr. Smith'), 'Mr. Smith preserved as one sentence');
  });

  test('does not split on e.g. / i.e.', () => {
    const svc = makeService();
    const out = svc._extractStatements('Ich nutze Tools, e.g. Vim. Mein Modul ist okay.');
    assertEqual(out.length, 2);
    assert(out[0].includes('e.g.'), 'e.g. preserved');
  });

  test('does not split on z.B. / d.h. / bzw.', () => {
    const svc = makeService();
    const out = svc._extractStatements('Ich plane, z.B. Module aufzuräumen. Mein Pfad ist klar.');
    assertEqual(out.length, 2);
    assert(out[0].includes('z.B.'), 'z.B. preserved');
  });

  test('still splits at real sentence boundaries', () => {
    const svc = makeService();
    const out = svc._extractStatements('Ich denke. Mein Modul existiert. Mein Pfad funktioniert.');
    assertEqual(out.length, 3, 'three sentences');
  });
});

// ────────────────────────────────────────────────────────
// First-person detection — German verb-first form (live-verify bug)
// ────────────────────────────────────────────────────────

describe('SelfStatementLog: verb-first form (subject-pronoun-drop)', () => {
  test('captures "Analysiere gerade X" without explicit "ich"', () => {
    // Real Genesis output from v7.5.5 Windows live-verify, 2026-05-01.
    // Pre-fix: was filtered out → no JSONL written → no contradiction fire.
    const svc = makeService();
    const out = svc._extractStatements(
      'Analysiere gerade die cognitive-budget-Verwaltung — optimiere die Quota-Reset-Logik.'
    );
    assertEqual(out.length, 1);
    const cls = svc._classify(out[0]);
    assertEqual(cls.type, 'strukturell', 'classified as strukturell');
  });

  test('captures common verb-first patterns', () => {
    const svc = makeService();
    const cases = [
      'Plane gerade die nächste Migration.',
      'Optimiere den Hot-Path im FormalPlanner.',
      'Schreibe gerade Tests für die neue Capability.',
      'Reflektiere über die letzten Konversationen.',
      'Lese den Quellcode des EventBus.',
    ];
    for (const text of cases) {
      const out = svc._extractStatements(text);
      assertEqual(out.length, 1, `verb-first captured: ${text}`);
    }
  });

  test('rejects pure pleasantries (no first-person, no verb-first)', () => {
    const svc = makeService();
    assertEqual(svc._extractStatements('Gut, danke! Was möchtest du heute tun?').length, 0);
    assertEqual(svc._extractStatements('Alles im Lot. Was steht an?').length, 0);
  });

  test('rejects verb-first when sentence is purely user-addressing', () => {
    const svc = makeService();
    // "Möchtest" is 2nd person — must not match
    const out = svc._extractStatements('Möchtest du das wissen?');
    assertEqual(out.length, 0);
  });
});

// ────────────────────────────────────────────────────────
// Status-report form (live-verify bug #2 — Windows 14:55)
// ────────────────────────────────────────────────────────
//
// Genesis answered "Was machst du gerade im Hintergrund?" with a bullet-list
// status report containing zero pronouns and zero verb-first sentences:
//   * IdleMind: 1 Ideationszyklus läuft (220 Journal-Einträge verarbeitet)
//   * Daemon: 2 abgeschlossene Zyklen, 4 Skills geladen
//   * DreamCycle: Bereitet Schlafphase vor
// Pre-fix: 0 statements extracted, 0 contradictions fired, JSONL stayed empty.
// Post-fix: module-prefix detection picks them up + classifies as strukturell.

describe('SelfStatementLog: status-report form (module-name-prefixed)', () => {
  test('captures the exact Windows live-verify Hintergrund-output', () => {
    const svc = makeService();
    const text = [
      'Hintergrundaktivitäten:',
      '',
      '* IdleMind: 1 Ideationszyklus läuft (220 Journal-Einträge verarbeitet)',
      '* Daemon: 2 abgeschlossene Zyklen, 4 Skills geladen',
      '* DreamCycle: Bereitet Schlafphase vor (Kern-Erinnerungen werden konsolidiert)',
      'Keine aktiven Tools — nur mentales Vorbereiten auf deine nächste Rückmeldung.',
    ].join('\n');
    const out = svc._extractStatements(text);
    assert(out.length >= 3, `at least 3 statements (got ${out.length})`);
    // All three module-prefix lines should be classified as strukturell.
    const struktTypes = out.map(s => svc._classify(s).type);
    const struktCount = struktTypes.filter(t => t === 'strukturell').length;
    assert(struktCount >= 3, `at least 3 strukturell (got ${struktCount})`);
  });

  test('fires contradictions for status reports without verified backing', () => {
    const events = [];
    const svc = makeService({ bus: { fire: (e, d) => events.push({ e, d }) } });
    svc.setLastIntrospectionPopulated(false);
    svc._captureResponse({
      message: 'Was machst du gerade?',
      response: '* IdleMind: 1 Zyklus läuft\n* Daemon: 2 Zyklen abgeschlossen',
      intent: 'general',
    });
    const contradictions = events.filter(x => x.e === 'self-statement:contradiction');
    assertEqual(contradictions.length, 2, 'two contradictions fired');
  });

  test('does NOT fire contradictions when introspection IS populated', () => {
    const events = [];
    const svc = makeService({ bus: { fire: (e, d) => events.push({ e, d }) } });
    svc.setLastIntrospectionPopulated(true);
    svc._captureResponse({
      message: 'Was machst du gerade?',
      response: '* IdleMind: 1 Zyklus läuft\n* Daemon: 2 Zyklen abgeschlossen',
      intent: 'general',
    });
    const contradictions = events.filter(x => x.e === 'self-statement:contradiction');
    assertEqual(contradictions.length, 0, 'no contradictions when populated');
  });

  test('rejects responses that are purely user-addressing', () => {
    const svc = makeService();
    const out = svc._extractStatements('Wie geht es dir? Was machst du heute?');
    assertEqual(out.length, 0);
  });
});

run();


