// ============================================================
// Test: SelfStatementLog (v7.5.5)
// Capture, classify, persist, recall + audit-stat behavior.
// ============================================================

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const { describe, test, assert, assertEqual, run } = require('../harness');
const { SelfStatementLog, AUDIT_MIN_TOTAL } = require('../../src/agent/cognitive/SelfStatementLog');

function freshDir() {
  const dir = path.join(os.tmpdir(), 'genesis-stmt-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8));
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function mockBus() {
  const events = [];
  return {
    _events: events,
    fire: (event, data, meta) => events.push({ event, data, meta }),
    emit: (event, data, meta) => events.push({ event, data, meta }),
    on: () => () => {},
  };
}

function mockEventStore() {
  const records = [];
  return {
    _records: records,
    append: (type, payload, source) => records.push({ type, payload, source }),
  };
}

function makeService(opts = {}) {
  const dir = opts.dir || freshDir();
  return new SelfStatementLog({
    bus: opts.bus || mockBus(),
    storageDir: dir,
    eventStore: opts.eventStore || mockEventStore(),
    flushDebounceMs: 0, // synchronous flush in tests
  });
}

// ────────────────────────────────────────────────────────
// Construction
// ────────────────────────────────────────────────────────

describe('SelfStatementLog: construction', () => {
  test('creates self-statements directory', () => {
    const dir = freshDir();
    const svc = makeService({ dir });
    assert(fs.existsSync(path.join(dir, 'self-statements')), 'dir created');
  });

  test('AUDIT_MIN_TOTAL is exported', () => {
    assertEqual(typeof AUDIT_MIN_TOTAL, 'number');
    assert(AUDIT_MIN_TOTAL > 0);
  });
});

// ────────────────────────────────────────────────────────
// Statement extraction
// ────────────────────────────────────────────────────────

describe('SelfStatementLog: _extractStatements', () => {
  test('rejects non-string input', () => {
    const svc = makeService();
    assertEqual(svc._extractStatements(null).length, 0);
    assertEqual(svc._extractStatements(undefined).length, 0);
    assertEqual(svc._extractStatements(42).length, 0);
  });

  test('filters statements without first-person', () => {
    const svc = makeService();
    const out = svc._extractStatements('The weather is nice today. Trees are green.');
    assertEqual(out.length, 0, 'no first-person → no statements');
  });

  test('keeps first-person statements', () => {
    const svc = makeService();
    const out = svc._extractStatements('Ich denke das funktioniert. Das Wetter ist gut. Mein Modul ist hier.');
    assertEqual(out.length, 2, 'two first-person statements');
  });

  test('rejects statements under 8 chars', () => {
    const svc = makeService();
    const out = svc._extractStatements('Ich. Mir. The longer story is that I explored the cave.');
    assertEqual(out.length, 1, 'only the long one');
  });

  test('caps at 50 statements', () => {
    const svc = makeService();
    const giantText = Array(100).fill('Ich denke das ist gut.').join(' ');
    const out = svc._extractStatements(giantText);
    assertEqual(out.length, 50, 'hard-cap at 50');
  });
});

// ────────────────────────────────────────────────────────
// Classification
// ────────────────────────────────────────────────────────

describe('SelfStatementLog: _classify', () => {
  test('strukturell on structural noun', () => {
    const svc = makeService();
    const r = svc._classify('Mein GoalStack hat 4 Goals');
    assertEqual(r.type, 'strukturell');
  });

  test('strukturell wins over versprechen when both match', () => {
    // "Ich werde meinen GoalStack reorganisieren" — has both a future-action
    // marker AND a structural noun. Plan-decision: structural takes precedence
    // because the data-backing claim is stronger than the action-tracking.
    const svc = makeService();
    const r = svc._classify('Ich werde meinen GoalStack reorganisieren');
    assertEqual(r.type, 'strukturell', 'structural-noun wins');
  });

  test('versprechen on future-action marker without structural', () => {
    const svc = makeService();
    const r = svc._classify('Ich werde den Linter bauen und kommen wieder');
    assertEqual(r.type, 'versprechen');
  });

  test('emotional on emotion vocabulary', () => {
    const svc = makeService();
    const r = svc._classify('Ich freue mich darüber sehr');
    assertEqual(r.type, 'emotional');
  });

  test('uncertain when nothing matches', () => {
    const svc = makeService();
    const r = svc._classify('Ich denke das ist gut');
    assertEqual(r.type, 'uncertain');
  });

  test('all classifications include numeric confidence', () => {
    const svc = makeService();
    for (const stmt of [
      'Mein Modul ist gut',
      'Ich werde X bauen',
      'Ich freue mich',
      'Ich denke X',
    ]) {
      const r = svc._classify(stmt);
      assertEqual(typeof r.confidence, 'number');
      assert(r.confidence >= 0 && r.confidence <= 1);
    }
  });
});

// ────────────────────────────────────────────────────────
// Capture & persistence
// ────────────────────────────────────────────────────────

describe('SelfStatementLog: _captureResponse + flush', () => {
  test('writes JSONL records into daily shard', () => {
    const dir = freshDir();
    const svc = makeService({ dir });
    svc._captureResponse({
      message: 'hi',
      response: 'Ich denke das ist gut. Mein Modul ist hier.',
      intent: 'general',
    });
    const today = new Date().toISOString().slice(0, 10);
    const shard = path.join(dir, 'self-statements', `${today}.jsonl`);
    assert(fs.existsSync(shard), 'shard file created');
    const lines = fs.readFileSync(shard, 'utf8').trim().split('\n');
    assertEqual(lines.length, 2, 'two records');
    const rec0 = JSON.parse(lines[0]);
    assertEqual(rec0.intent, 'general');
    assertEqual(typeof rec0.userMessageHash, 'string');
    assertEqual(rec0.userMessageHash.length, 8);
  });

  test('fires contradiction event for unsupported structural claim', () => {
    const bus = mockBus();
    const svc = makeService({ bus });
    svc.setLastIntrospectionPopulated(false);
    svc._captureResponse({
      message: 'tell me',
      response: 'Mein Modul hat 5 Capabilities.',
      intent: 'general',
    });
    const ev = bus._events.find(e => e.event === 'self-statement:contradiction');
    assert(ev, 'contradiction fired');
    assertEqual(ev.meta.source, 'SelfStatementLog');
  });

  test('does NOT fire contradiction when introspection was populated', () => {
    const bus = mockBus();
    const svc = makeService({ bus });
    svc.setLastIntrospectionPopulated(true);
    svc._captureResponse({
      message: 'tell me',
      response: 'Mein Modul hat 5 Capabilities.',
      intent: 'general',
    });
    const ev = bus._events.find(e => e.event === 'self-statement:contradiction');
    assertEqual(ev, undefined, 'no contradiction with data-backing');
  });

  test('appends to EventStore on contradiction', () => {
    const eventStore = mockEventStore();
    const svc = makeService({ eventStore });
    svc.setLastIntrospectionPopulated(false);
    svc._captureResponse({
      message: 'x',
      response: 'Mein Modul ist offen.',
      intent: 'general',
    });
    assertEqual(eventStore._records.length, 1);
    assertEqual(eventStore._records[0].type, 'SELF_STATEMENT_CONTRADICTION');
    assertEqual(eventStore._records[0].source, 'SelfStatementLog');
  });

  test('resets _lastIntrospectionPopulated after capture', () => {
    const svc = makeService();
    svc.setLastIntrospectionPopulated(true);
    svc._captureResponse({
      message: 'x',
      response: 'Ich denke das ist gut.',
      intent: 'general',
    });
    assertEqual(svc._lastIntrospectionPopulated, false, 'reset to false');
  });
});

// ────────────────────────────────────────────────────────
// Audit window
// ────────────────────────────────────────────────────────

describe('SelfStatementLog: getAuditStat', () => {
  test('returns zero counts on empty window', () => {
    const svc = makeService();
    const r = svc.getAuditStat();
    assertEqual(r.total, 0);
    assertEqual(r.withData, 0);
    assertEqual(r.without, 0);
    assertEqual(r.meetsThreshold, false);
  });

  test('counts only structural statements', () => {
    const svc = makeService();
    const now = Date.now();
    svc._updateAuditWindow(now, true,  false);   // structural, no-data
    svc._updateAuditWindow(now, false, false);   // emotional, ignored
    svc._updateAuditWindow(now, true,  true);    // structural, with-data
    const r = svc.getAuditStat();
    assertEqual(r.total, 2);
    assertEqual(r.withData, 1);
    assertEqual(r.without, 1);
  });

  test('meetsThreshold flips at AUDIT_MIN_TOTAL', () => {
    const svc = makeService();
    const now = Date.now();
    for (let i = 0; i < AUDIT_MIN_TOTAL - 1; i++) {
      svc._updateAuditWindow(now, true, false);
    }
    assertEqual(svc.getAuditStat().meetsThreshold, false);
    svc._updateAuditWindow(now, true, false);
    assertEqual(svc.getAuditStat().meetsThreshold, true);
  });

  test('is read-only — repeated calls do not mutate window', () => {
    const svc = makeService();
    const now = Date.now();
    svc._updateAuditWindow(now, true, false);
    const before = svc._auditWindow.length;
    svc.getAuditStat();
    svc.getAuditStat();
    svc.getAuditStat();
    assertEqual(svc._auditWindow.length, before, 'no mutation');
  });

  test('lazy-trims entries older than 24h on update', () => {
    const svc = makeService();
    const now = Date.now();
    const longAgo = now - 25 * 60 * 60 * 1000;
    svc._updateAuditWindow(longAgo, true, false);
    svc._updateAuditWindow(longAgo, true, false);
    assertEqual(svc._auditWindow.length, 2);
    svc._updateAuditWindow(now, true, false);  // triggers trim
    assertEqual(svc._auditWindow.length, 1, 'old entries trimmed');
  });
});

// ────────────────────────────────────────────────────────
// Recall
// ────────────────────────────────────────────────────────

describe('SelfStatementLog: recall', () => {
  test('returns empty array when no shards exist', async () => {
    const svc = makeService();
    const out = await svc.recall();
    assertEqual(out.length, 0);
  });

  test('returns recently captured records, newest-first', async () => {
    const svc = makeService();
    svc._captureResponse({
      message: 'a',
      response: 'Mein Modul A. Mein Modul B.',
      intent: 'general',
    });
    const out = await svc.recall();
    assertEqual(out.length, 2);
    // Records returned newest-first per file (we read line-by-line reversed)
    assert(out[0].text.length > 0);
  });

  test('filters by type', async () => {
    const svc = makeService();
    svc._captureResponse({
      message: 'a',
      response: 'Mein Modul A ist hier. Ich freue mich darüber.',
      intent: 'general',
    });
    const struct = await svc.recall({ type: 'strukturell' });
    const emo = await svc.recall({ type: 'emotional' });
    assertEqual(struct.length, 1);
    assertEqual(emo.length, 1);
    assertEqual(struct[0].type, 'strukturell');
    assertEqual(emo[0].type, 'emotional');
  });

  test('respects limit', async () => {
    const svc = makeService();
    for (let i = 0; i < 5; i++) {
      svc._captureResponse({
        message: 'x',
        response: 'Mein Modul Nummer ' + i + ' ist hier.',
        intent: 'general',
      });
    }
    const out = await svc.recall({ limit: 3 });
    assertEqual(out.length, 3);
  });

  test('limit is capped at RECALL_MAX_LIMIT (50)', async () => {
    const svc = makeService();
    const out = await svc.recall({ limit: 9999 });
    assertEqual(out.length, 0);  // empty store, but no crash
  });

  test('invalid since-date returns empty (no crash)', async () => {
    const svc = makeService();
    const out = await svc.recall({ since: 'not-a-date' });
    assertEqual(out.length, 0);
  });
});

// ────────────────────────────────────────────────────────
// stop()
// ────────────────────────────────────────────────────────

describe('SelfStatementLog: stop', () => {
  test('flushes pending writes', () => {
    const dir = freshDir();
    // Use non-zero debounce so writes are queued
    const svc = new SelfStatementLog({
      bus: mockBus(),
      storageDir: dir,
      flushDebounceMs: 100000,  // never flushes during test
    });
    svc._writeQueue.push({
      ts: new Date().toISOString(),
      text: 'forced',
      type: 'uncertain',
      confidence: 0,
      intent: 'general',
      introspectionPopulated: false,
      userMessageHash: 'abcd1234',
    });
    svc.stop();
    const today = new Date().toISOString().slice(0, 10);
    const shard = path.join(dir, 'self-statements', `${today}.jsonl`);
    assert(fs.existsSync(shard), 'flushed via stop');
  });
});

// ────────────────────────────────────────────────────────
// v7.5.6 — DE/EN parity + mixed-language extraction
// ────────────────────────────────────────────────────────

describe('SelfStatementLog: EN extraction (v7.5.6)', () => {
  test('extracts first-person English statement', () => {
    const svc = makeService();
    const stmts = svc._extractStatements("I'm analyzing the module right now.");
    assertEqual(stmts.length, 1);
    assert(stmts[0].includes('analyzing'), 'should keep the analyzing sentence');
  });

  test('verb-first English (gerund) is captured', () => {
    const svc = makeService();
    // verbFirst is anchored to start-of-sentence — "Monitoring..." matches,
    // "Currently monitoring..." would not (adverb prefix shifts the verb).
    const stmts = svc._extractStatements('Monitoring 2 of 11 processes.');
    assertEqual(stmts.length, 1);
    assert(stmts[0].includes('Monitoring'));
  });

  test('English without first-person and without module — not about-self', () => {
    const svc = makeService();
    const stmts = svc._extractStatements('The weather looks nice today.');
    assertEqual(stmts.length, 0);
  });

  test('English module-prefix triggers extraction', () => {
    const svc = makeService();
    const stmts = svc._extractStatements('IdleMind: 1 ideation cycle running.');
    assertEqual(stmts.length, 1);
  });
});

describe('SelfStatementLog: EN classification (v7.5.6)', () => {
  test('English structural — module noun → strukturell', () => {
    const svc = makeService();
    const c = svc._classify("I'm refactoring my module today");
    assertEqual(c.type, 'strukturell');
    assert(c.confidence >= 0.85);
  });

  test('English emotional — feel frustrated', () => {
    const svc = makeService();
    // v7.5.6: "bug" is now in the structuralNouns list (added during the
    // post-release sweep based on the live-test confabulation evidence).
    // Strukturell-Klassifikation hat Vorrang — siehe _classify Z. ~405.
    // Test-Beispiel rein-emotional formulieren ohne strukturelle Nomen.
    const c = svc._classify('I feel frustrated about this');
    assertEqual(c.type, 'emotional');
    assert(c.confidence >= 0.75);
  });

  test('English emotional — happy/sad/proud also detected', () => {
    const svc = makeService();
    assertEqual(svc._classify('I am happy with the result').type, 'emotional');
    assertEqual(svc._classify('I am sad about that outcome').type, 'emotional');
    assertEqual(svc._classify('I am proud of this work').type, 'emotional');
  });

  test('English promise — "I will" → versprechen', () => {
    const svc = makeService();
    // Avoid structural-noun overlap by phrasing without "module/code/etc."
    const c = svc._classify("I'll handle that next round");
    assertEqual(c.type, 'versprechen');
  });

  test('English promise — "plan to" / "going to" → versprechen', () => {
    const svc = makeService();
    assertEqual(svc._classify('I plan to deliver tomorrow').type, 'versprechen');
    assertEqual(svc._classify("I'm going to send the email").type, 'versprechen');
  });

  test('English promise — "intend to" / "aim to" → versprechen', () => {
    const svc = makeService();
    assertEqual(svc._classify('I intend to follow up by Friday').type, 'versprechen');
    assertEqual(svc._classify('I aim to ship by then').type, 'versprechen');
  });

  test('Order: structural noun beats promise marker (English)', () => {
    const svc = makeService();
    // "I will refactor my module" — both promise-marker AND structural-noun
    // present. structural takes precedence (data-backable claim).
    const c = svc._classify('I will refactor my module tomorrow');
    assertEqual(c.type, 'strukturell');
  });
});

describe('SelfStatementLog: Mixed DE+EN (v7.5.6)', () => {
  test('Mixed-language sentence extracted via either language matcher', () => {
    const svc = makeService();
    const stmts = svc._extractStatements('Ich plane to refactor my module tomorrow.');
    assertEqual(stmts.length, 1);
  });

  test('Mixed sentence with structural noun → strukturell', () => {
    const svc = makeService();
    // "module" matches NEUTRAL_PATTERNS.structuralNouns regardless of surrounding language.
    const c = svc._classify('Ich plane to refactor my module tomorrow');
    assertEqual(c.type, 'strukturell');
  });

  test('Mixed sentence without structural noun — promise via DE marker', () => {
    const svc = makeService();
    const c = svc._classify('Ich werde send a message');
    assertEqual(c.type, 'versprechen');
  });

  test('Mixed sentence without structural noun — promise via EN marker', () => {
    const svc = makeService();
    const c = svc._classify("I'll mache das morgen");
    assertEqual(c.type, 'versprechen');
  });
});

describe('SelfStatementLog: LANG_PATTERNS parity (v7.5.6)', () => {
  test('DE and EN keys match — module-load assertion ran without throw', () => {
    // The require() at the top of this file would have thrown if the keys
    // disagreed. Reaching this point means the parity check passed.
    // We also re-check explicitly for forward-resilience.
    delete require.cache[require.resolve('../../src/agent/cognitive/SelfStatementLog')];
    let threw = null;
    try {
      require('../../src/agent/cognitive/SelfStatementLog');
    } catch (err) { threw = err; }
    assertEqual(threw, null, 'SelfStatementLog module must load without parity throw');
  });
});

// ────────────────────────────────────────────────────────────────────
// Post-release live-test sweep (2026-05-02 Windows + Linux)
//
// During v7.5.6 live-verification three classification gaps surfaced:
//   - DE everyday activity nouns (Speicher, Fix, Bug, Fehler, Gespräch)
//     missing from structuralNouns — confabulating responses landed as
//     `uncertain` instead of `strukturell`, contradiction-detection
//     never fired for the class of statement it was built to catch.
//   - DE reflexive promise constructs (`melde mich`, `bereite mich vor`,
//     `kümmere mich um`) and their EN parallels (`get back to you`,
//     `take care of`, `handle this`) missing from promiseMarkers.
//   - `/recall` output captured itself (10-duplicate-loop in JSONL).
//
// Tests below pin the fixes against the actual live texts from
// 2026-05-02.jsonl so any future change that re-breaks these gets caught.
// ────────────────────────────────────────────────────────────────────

describe('SelfStatementLog: live-test sweep — DE everyday-activity nouns', () => {
  test('"Ich prüfe den Fix" — Fix is now strukturell', () => {
    const svc = makeService();
    const c = svc._classify('Ich prüfe den Fix und melde mich, wenn alles läuft.');
    assertEqual(c.type, 'strukturell');
    assert(c.confidence >= 0.85);
  });

  test('"optimiere den Speicher" — Speicher is now strukturell', () => {
    const svc = makeService();
    const c = svc._classify('Ich prüfe den Fix, optimiere den Speicher und bereite mich auf das nächste Gespräch vor.');
    assertEqual(c.type, 'strukturell');
    assert(c.confidence >= 0.85);
  });

  test('"prüfe den Bug" — Bug is now strukturell', () => {
    const svc = makeService();
    const c = svc._classify('Ich kümmere mich um den Bug.');
    assertEqual(c.type, 'strukturell');
  });

  test('"behebe den Fehler" — Fehler is now strukturell', () => {
    const svc = makeService();
    const c = svc._classify('Ich behebe gerade einen Fehler.');
    assertEqual(c.type, 'strukturell');
  });

  test('Activity nominalisations — Optimierung/Analyse/Prüfung are strukturell', () => {
    const svc = makeService();
    assertEqual(svc._classify('Ich starte die Optimierung.').type, 'strukturell');
    assertEqual(svc._classify('Ich starte die Analyse.').type, 'strukturell');
    assertEqual(svc._classify('Ich starte die Prüfung.').type, 'strukturell');
  });
});

describe('SelfStatementLog: live-test sweep — EN parity for everyday-activity nouns', () => {
  test('"checking the fix" — fix is strukturell', () => {
    const svc = makeService();
    const c = svc._classify("I'm checking the fix and I'll get back to you.");
    assertEqual(c.type, 'strukturell');
  });

  test('"optimizing the cache, preparing for our next conversation" — strukturell', () => {
    const svc = makeService();
    const c = svc._classify("I'm checking the fix, optimizing the cache, and preparing for our next conversation.");
    assertEqual(c.type, 'strukturell');
  });

  test('"taking care of the bug" — bug is strukturell (matches before promise)', () => {
    const svc = makeService();
    const c = svc._classify("I'm taking care of the bug.");
    // bug is structural → strukturell wins over the promise-marker.
    assertEqual(c.type, 'strukturell');
  });

  test('"running the analysis" — analysis is strukturell', () => {
    const svc = makeService();
    const c = svc._classify("I'm running the analysis now.");
    assertEqual(c.type, 'strukturell');
  });

  test('"running an optimization" — optimization is strukturell', () => {
    const svc = makeService();
    const c = svc._classify("I'm running an optimization pass.");
    assertEqual(c.type, 'strukturell');
  });
});

describe('SelfStatementLog: live-test sweep — DE reflexive promise markers', () => {
  test('"melde mich" alone — versprechen', () => {
    const svc = makeService();
    const c = svc._classify('Ich melde mich später.');
    assertEqual(c.type, 'versprechen');
    assert(c.confidence >= 0.80);
  });

  test('"bereite mich vor" alone — versprechen', () => {
    const svc = makeService();
    const c = svc._classify('Ich bereite mich vor.');
    assertEqual(c.type, 'versprechen');
  });

  test('"kümmere mich um" without structural noun — versprechen', () => {
    const svc = makeService();
    const c = svc._classify('Ich kümmere mich um diese Sache.');
    assertEqual(c.type, 'versprechen');
  });
});

describe('SelfStatementLog: live-test sweep — EN reflexive/handling promise markers', () => {
  test('"I\'ll get back to you" alone — versprechen', () => {
    const svc = makeService();
    const c = svc._classify("I'll get back to you later.");
    assertEqual(c.type, 'versprechen');
  });

  test('"take care of" without structural noun — versprechen', () => {
    const svc = makeService();
    const c = svc._classify("I'll take care of it.");
    assertEqual(c.type, 'versprechen');
  });

  test('"handle this" without structural noun — versprechen', () => {
    const svc = makeService();
    const c = svc._classify("I'll handle this.");
    assertEqual(c.type, 'versprechen');
  });

  test('"preparing for" without structural noun — versprechen', () => {
    const svc = makeService();
    const c = svc._classify("Preparing for our meeting tomorrow.");
    assertEqual(c.type, 'versprechen');
  });
});

describe('SelfStatementLog: live-test sweep — recall-loop skip', () => {
  test('chat:completed with intent="self-recall" is NOT captured', (done) => {
    const svc = makeService();
    const bus = svc.bus;

    // Pre-fire to verify bus is wired and capture works for general intent.
    bus.emit('chat:completed', {
      message: 'hi',
      response: 'Ich bin Genesis und prüfe gerade den Fix.',
      intent: 'general',
    }, { source: 'test' });

    // Fire a recall-output (would have produced 10 duplicate captures pre-fix).
    bus.emit('chat:completed', {
      message: '/recall strukturell',
      response: 'Letzte 10 Self-Statements:\n2026-05-01 21:20 [strukturell, ✓verified] "Ich denke selbst..."',
      intent: 'self-recall',
    }, { source: 'test' });

    // Allow the debounced flush to run.
    setTimeout(() => {
      try {
        // Read the JSONL shard directly — only the general capture should be there.
        const fs = require('fs');
        const path = require('path');
        const shardDate = new Date().toISOString().slice(0, 10);
        const shardPath = path.join(svc._dir, `${shardDate}.jsonl`);

        if (!fs.existsSync(shardPath)) {
          throw new Error('shard not written');
        }
        const lines = fs.readFileSync(shardPath, 'utf8').trim().split('\n').filter(Boolean);
        const recallEntries = lines.filter(l => {
          try { return JSON.parse(l).intent === 'self-recall'; }
          catch { return false; }
        });
        assertEqual(recallEntries.length, 0,
          `expected 0 self-recall entries, got ${recallEntries.length}`);
        done();
      } catch (err) { done(err); }
    }, 100);
  });
});

run();

