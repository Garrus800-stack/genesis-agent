// Test: v6.1.0 Coverage Push Part 2 — Data Layer
// Targets: EventStore, ConversationMemory

const { describe, test, assert, assertEqual, run } = require('../harness');
const path = require('path');
const fs = require('fs');
const os = require('os');

function tmpDir() {
  const d = path.join(os.tmpdir(), `genesis-test-${Date.now()}-${Math.random().toString(36).slice(2,8)}`);
  fs.mkdirSync(d, { recursive: true });
  return d;
}

function mockBus() {
  const handlers = {};
  return {
    on(evt, fn) { (handlers[evt] = handlers[evt] || []).push(fn); return () => {}; },
    emit(evt, data, meta) { (handlers[evt] || []).forEach(fn => fn(data, meta)); },
    fire(evt, data, meta) { this.emit(evt, data, meta); },
    off() {},
  };
}

// ── EventStore ──────────────────────────────────────────────

describe('EventStore — append and query', () => {
  const { EventStore } = require('../../src/agent/foundation/EventStore');

  test('constructor initializes with genesis hash', () => {
    const dir = tmpDir();
    const es = new EventStore(dir, mockBus());
    assertEqual(es.eventCount, 0);
    assertEqual(es.lastHash, '0000000000000000');
  });

  test('append creates hash-chained event', () => {
    const dir = tmpDir();
    const es = new EventStore(dir, mockBus());
    const evt = es.append('TEST_EVENT', { value: 42 }, 'test-module');
    assert(evt !== null, 'event should be created');
    assertEqual(evt.type, 'TEST_EVENT');
    assertEqual(evt.payload.value, 42);
    assertEqual(evt.source, 'test-module');
    assert(evt.hash && evt.hash !== '0000000000000000', 'should have computed hash');
    assertEqual(es.eventCount, 1);
  });

  test('append chains hashes', () => {
    const dir = tmpDir();
    const es = new EventStore(dir, mockBus());
    const e1 = es.append('E1', {});
    const e2 = es.append('E2', {});
    assert(e1.hash !== e2.hash, 'hashes should differ');
    assertEqual(e2.prevHash, e1.hash);
  });

  test('query by type', async () => {
    const dir = tmpDir();
    const es = new EventStore(dir, mockBus());
    es.append('ALPHA', { n: 1 });
    es.append('BETA', { n: 2 });
    es.append('ALPHA', { n: 3 });
    await es.flushPending();
    const results = es.query({ type: 'ALPHA' });
    assertEqual(results.length, 2);
    assert(results.every(r => r.type === 'ALPHA'), 'should only return ALPHA');
  });

  test('query with limit', async () => {
    const dir = tmpDir();
    const es = new EventStore(dir, mockBus());
    for (let i = 0; i < 10; i++) es.append('X', { i });
    await es.flushPending();
    const results = es.query({ type: 'X', limit: 3 });
    assertEqual(results.length, 3);
  });

  test('query by source', async () => {
    const dir = tmpDir();
    const es = new EventStore(dir, mockBus());
    es.append('EVT', {}, 'module-a');
    es.append('EVT', {}, 'module-b');
    await es.flushPending();
    const results = es.query({ source: 'module-a' });
    assertEqual(results.length, 1);
    assertEqual(results[0].source, 'module-a');
  });

  test('getStats returns counts', async () => {
    const dir = tmpDir();
    const es = new EventStore(dir, mockBus());
    es.append('A', {}); es.append('B', {}); es.append('A', {});
    await es.flushPending();
    const stats = es.getStats();
    assertEqual(stats.eventCount, 3);
    assert(typeof stats.logSize === 'string', 'logSize should be a string');
  });

  test('verifyIntegrity on valid chain', async () => {
    const dir = tmpDir();
    const es = new EventStore(dir, mockBus());
    es.append('E1', {}); es.append('E2', {}); es.append('E3', {});
    await es.flushPending();
    const result = es.verifyIntegrity();
    assert(result.ok === true, 'chain should be ok');
    assertEqual(result.totalEvents, 3);
    assertEqual(result.violations.length, 0);
  });

  test('registerProjection + getProjection', () => {
    const dir = tmpDir();
    const es = new EventStore(dir, mockBus());
    es.registerProjection('counter', (state, event) => {
      return { ...state, count: (state.count || 0) + 1 };
    }, { count: 0 });
    es.append('INC', {});
    es.append('INC', {});
    const proj = es.getProjection('counter');
    assertEqual(proj.count, 2);
  });

  test('flushPending completes without error', async () => {
    const dir = tmpDir();
    const es = new EventStore(dir, mockBus());
    es.append('FLUSH_TEST', { data: 'test' });
    await es.flushPending();
    // Verify file written
    const content = fs.readFileSync(es.logFile, 'utf-8');
    assert(content.includes('FLUSH_TEST'), 'event should be flushed to file');
  });
});

// ── ConversationMemory ──────────────────────────────────────

describe('ConversationMemory — episodes, facts, patterns', () => {
  const { ConversationMemory } = require('../../src/agent/foundation/ConversationMemory');

  test('constructor initializes empty db', () => {
    const dir = tmpDir();
    const cm = new ConversationMemory(dir, mockBus());
    assert(Array.isArray(cm.db.episodic), 'episodic should be array');
    assert(typeof cm.db.semantic === 'object', 'semantic should be object');
    assert(Array.isArray(cm.db.procedural), 'procedural should be array');
  });

  test('addEpisode stores conversation', () => {
    const dir = tmpDir();
    const cm = new ConversationMemory(dir, mockBus());
    cm.addEpisode([{ role: 'user', content: 'Hello' }], 'greeting exchange');
    assertEqual(cm.db.episodic.length, 1);
    assertEqual(cm.db.episodic[0].summary, 'greeting exchange');
  });

  test('learnFact stores and recallFact retrieves', () => {
    const dir = tmpDir();
    const cm = new ConversationMemory(dir, mockBus());
    cm.learnFact('username', 'Garrus', 0.9, 'test');
    const fact = cm.recallFact('username');
    assertEqual(fact.value, 'Garrus');
    assertEqual(fact.confidence, 0.9);
  });

  test('searchFacts finds matching facts', () => {
    const dir = tmpDir();
    const cm = new ConversationMemory(dir, mockBus());
    cm.learnFact('language', 'German', 0.8);
    cm.learnFact('editor', 'VSCode', 0.7);
    cm.learnFact('lang-pref', 'Deutsch', 0.9);
    const results = cm.searchFacts('lang');
    assert(results.length >= 2, `should find lang-related facts, got ${results.length}`);
  });

  test('learnPattern and recallPattern', () => {
    const dir = tmpDir();
    const cm = new ConversationMemory(dir, mockBus());
    cm.learnPattern('npm-install-fail', 'run npm cache clean', true);
    cm.learnPattern('npm-install-fail', 'run npm cache clean', true);
    const pattern = cm.recallPattern('npm-install-fail');
    assert(pattern !== null, 'pattern should be found');
    assertEqual(pattern.action, 'run npm cache clean');
    assert(pattern.successRate > 0, 'should have positive success rate');
  });

  test('getStats returns summary', () => {
    const dir = tmpDir();
    const cm = new ConversationMemory(dir, mockBus());
    cm.addEpisode([{ role: 'user', content: 'test' }], 'test');
    cm.learnFact('key', 'val');
    const stats = cm.getStats();
    assertEqual(stats.episodes, 1);
    assertEqual(stats.facts, 1);
  });

  test('buildContext returns formatted context string', () => {
    const dir = tmpDir();
    const cm = new ConversationMemory(dir, mockBus());
    cm.learnFact('name', 'Genesis', 0.95);
    cm.addEpisode([{ role: 'user', content: 'How are you?' }], 'casual conversation');
    const ctx = cm.buildContext('tell me about yourself');
    assert(typeof ctx === 'string', 'context should be a string');
  });

  test('getFactContext returns formatted facts', () => {
    const dir = tmpDir();
    const cm = new ConversationMemory(dir, mockBus());
    cm.learnFact('project', 'Genesis Agent', 0.99);
    const ctx = cm.getFactContext(5);
    assert(typeof ctx === 'string', 'fact context should be a string');
    assert(ctx.includes('Genesis Agent'), 'should contain the fact value');
  });

  test('getUserName returns null when not set', () => {
    const dir = tmpDir();
    const cm = new ConversationMemory(dir, mockBus());
    assert(cm.getUserName() === null || cm.getUserName() === undefined, 'should be null/undefined');
  });

  test('getSemantic returns default when key missing', () => {
    const dir = tmpDir();
    const cm = new ConversationMemory(dir, mockBus());
    assertEqual(cm.getSemantic('missing', 'fallback'), 'fallback');
  });
});

run();
