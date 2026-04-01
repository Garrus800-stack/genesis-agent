// ============================================================
// TEST: ConversationSearch — TF-IDF Search + Content Extraction
// ============================================================

const { describe, test, assert, assertEqual, run } = require('../harness');
const { ConversationSearchDelegate } = require('../../src/agent/foundation/ConversationSearch');

// ── Helpers ──────────────────────────────────────────────────

function makeEpisodes(texts) {
  return texts.map((t, i) => ({
    summary: t,
    topics: [],
    lastExchange: [],
    timestamp: new Date(Date.now() - (texts.length - i) * 3600000).toISOString(),
  }));
}

// ── Tokenize ─────────────────────────────────────────────────

describe('ConversationSearch — Tokenize', () => {
  test('lowercases and splits', () => {
    const s = new ConversationSearchDelegate();
    const tokens = s.tokenize('Hello World Test');
    assert(tokens.includes('hello'), 'Should lowercase');
    assert(tokens.includes('world'), 'Should split');
    assert(tokens.includes('test'), 'Should include test');
  });

  test('removes short words', () => {
    const s = new ConversationSearchDelegate();
    const tokens = s.tokenize('I am a big dog');
    assert(!tokens.includes('am'), 'Should filter <=2 chars');
    assert(tokens.includes('big'), 'Should keep 3+ chars');
    assert(tokens.includes('dog'), 'Should keep 3+ chars');
  });

  test('strips punctuation', () => {
    const s = new ConversationSearchDelegate();
    const tokens = s.tokenize('Hello, world! Test?');
    assert(tokens.includes('hello'), 'Should strip comma');
    assert(tokens.includes('world'), 'Should strip excl');
  });

  test('handles German umlauts', () => {
    const s = new ConversationSearchDelegate();
    const tokens = s.tokenize('Größe Überprüfung Ärger');
    assert(tokens.some(t => t.includes('öß')), 'Should preserve umlauts');
  });
});

// ── TF-IDF Index ─────────────────────────────────────────────

describe('ConversationSearch — TF-IDF', () => {
  test('rebuild creates index', () => {
    const s = new ConversationSearchDelegate();
    const eps = makeEpisodes(['code refactoring module', 'test debugging error']);
    s.rebuild(eps);
    assert(s._docVectors.length === 2, 'Should have 2 doc vectors');
    assert(s._idfCache.size > 0, 'Should have IDF entries');
  });

  test('recallTfIdf returns matching episodes', () => {
    const s = new ConversationSearchDelegate();
    const eps = makeEpisodes(['javascript code refactoring', 'python machine learning', 'javascript testing debug']);
    s.rebuild(eps);
    const results = s.recallTfIdf('javascript code', eps, 5);
    assert(results.length > 0, 'Should find matches');
    assert(results[0].summary.includes('javascript'), 'Best match should contain query term');
  });

  test('recallTfIdf returns empty for no match with old episodes', () => {
    const s = new ConversationSearchDelegate();
    const eps = [{
      summary: 'alpha beta gamma',
      topics: [], lastExchange: [],
      timestamp: new Date(Date.now() - 90 * 24 * 3600000).toISOString(), // 90 days old → recency ≈ 0
    }];
    s.rebuild(eps);
    const results = s.recallTfIdf('zzzzunknownterm', eps, 5);
    assertEqual(results.length, 0);
  });

  test('recallTfIdf respects limit', () => {
    const s = new ConversationSearchDelegate();
    const eps = makeEpisodes(['code module alpha', 'code module beta', 'code module gamma']);
    s.rebuild(eps);
    const results = s.recallTfIdf('code module', eps, 2);
    assert(results.length <= 2, 'Should respect limit');
  });

  test('cosineSimilarity identical vectors = 1', () => {
    const s = new ConversationSearchDelegate();
    const v = new Map([['test', 1], ['code', 2]]);
    const sim = s.cosineSimilarity(v, v);
    assert(Math.abs(sim - 1.0) < 0.001, `Expected ~1.0, got ${sim}`);
  });

  test('cosineSimilarity orthogonal vectors = 0', () => {
    const s = new ConversationSearchDelegate();
    const a = new Map([['alpha', 1]]);
    const b = new Map([['beta', 1]]);
    assertEqual(s.cosineSimilarity(a, b), 0);
  });

  test('cosineSimilarity empty vector = 0', () => {
    const s = new ConversationSearchDelegate();
    assertEqual(s.cosineSimilarity(new Map(), new Map([['a', 1]])), 0);
  });
});

// ── Content Extraction ───────────────────────────────────────

describe('ConversationSearch — Content Extraction', () => {
  test('autoSummarize extracts first user message', () => {
    const s = new ConversationSearchDelegate();
    const conv = [
      { role: 'user', content: 'Fix the bug in parser module please' },
      { role: 'assistant', content: 'I will look into it' },
    ];
    const summary = s.autoSummarize(conv);
    assert(summary.includes('Fix the bug'), 'Should extract first user message');
  });

  test('autoSummarize returns fallback for empty', () => {
    const s = new ConversationSearchDelegate();
    const summary = s.autoSummarize([]);
    assertEqual(summary, 'Leere Konversation');
  });

  test('autoSummarize caps at 200 chars', () => {
    const s = new ConversationSearchDelegate();
    const long = 'x'.repeat(500);
    const summary = s.autoSummarize([{ role: 'user', content: long }]);
    assert(summary.length <= 200, 'Should cap at 200');
  });

  test('extractTopics finds tech terms', () => {
    const s = new ConversationSearchDelegate();
    const conv = [
      { role: 'user', content: 'Check the code in that modul' },
      { role: 'assistant', content: 'Running test suite now' },
    ];
    const topics = s.extractTopics(conv);
    assert(topics.includes('code'), 'Should find code');
    assert(topics.includes('modul'), 'Should find modul');
    assert(topics.includes('test'), 'Should find test');
  });

  test('extractIntents detects modify intent', () => {
    const s = new ConversationSearchDelegate();
    const conv = [{ role: 'user', content: 'Ändere die Konfiguration' }];
    const intents = s.extractIntents(conv);
    assert(intents.includes('modify'), 'Should detect modify');
  });

  test('extractIntents detects repair intent', () => {
    const s = new ConversationSearchDelegate();
    const conv = [{ role: 'user', content: 'Repariere den Bug' }];
    const intents = s.extractIntents(conv);
    assert(intents.includes('repair'), 'Should detect repair');
  });

  test('extractIntents detects inspect intent', () => {
    const s = new ConversationSearchDelegate();
    const conv = [{ role: 'user', content: 'Zeig mir die Struktur' }];
    const intents = s.extractIntents(conv);
    assert(intents.includes('inspect'), 'Should detect inspect');
  });

  test('extractIntents ignores assistant messages', () => {
    const s = new ConversationSearchDelegate();
    const conv = [{ role: 'assistant', content: 'Ich werde die Datei ändern' }];
    const intents = s.extractIntents(conv);
    assertEqual(intents.length, 0);
  });
});

// ── Embedding Fallback ───────────────────────────────────────

describe('ConversationSearch — Embedding Fallback', () => {
  test('recallAsync falls back to TF-IDF without embeddings', async () => {
    const s = new ConversationSearchDelegate();
    const eps = makeEpisodes(['javascript code', 'python data']);
    s.rebuild(eps);
    const results = await s.recallAsync('javascript', eps, 5);
    assert(results.length > 0, 'Should fallback to TF-IDF');
  });

  test('setEmbeddingService stores reference', () => {
    const s = new ConversationSearchDelegate();
    const mock = { isAvailable: () => true };
    s.setEmbeddingService(mock);
    assertEqual(s._embeddings, mock);
  });
});

run();
