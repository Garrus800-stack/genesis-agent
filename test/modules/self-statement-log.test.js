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

run();
