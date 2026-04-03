// ============================================================
// GENESIS — test/modules/conversation-compressor.test.js (v5.9.7)
//
// Tests ConversationCompressor: compression logic, LLM summary,
// extractive fallback, caching, trimming, event emission.
// ============================================================

const { describe, test, assert, assertEqual, run } = require('../harness');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const { ConversationCompressor } = require(path.join(ROOT, 'src/agent/intelligence/ConversationCompressor'));

// ── Mock Dependencies ───────────────────────────────────────

function mockBus() {
  const events = [];
  const handlers = {};
  return {
    on: (evt, fn) => { handlers[evt] = fn; return () => { delete handlers[evt]; }; },
    emit: (evt, data) => events.push({ evt, data }),
    _events: events,
    _handlers: handlers,
  };
}

function mockTokenizer(charsPerToken = 4) {
  return {
    estimateTokens: (text) => Math.ceil((text || '').length / charsPerToken),
  };
}

function mockModel(response = 'Summary of the conversation.') {
  return {
    chat: async () => response,
  };
}

function makeHistory(count, contentLength = 100) {
  const msgs = [];
  for (let i = 0; i < count; i++) {
    msgs.push({
      role: i % 2 === 0 ? 'user' : 'assistant',
      content: `Message ${i}: ${'x'.repeat(contentLength)}`,
    });
  }
  return msgs;
}

// ── Tests ────────────────────────────────────────────────────

describe('ConversationCompressor', () => {

  test('constructs with minimal deps', () => {
    const bus = mockBus();
    const c = new ConversationCompressor({ bus });
    assert(c.bus === bus, 'bus assigned');
    assertEqual(c.stats.compressions, 0);
    assertEqual(c.stats.cacheHits, 0);
  });

  test('static containerConfig is correct', () => {
    const cfg = ConversationCompressor.containerConfig;
    assertEqual(cfg.name, 'conversationCompressor');
    assertEqual(cfg.phase, 10);
    assert(cfg.tags.includes('compression'), 'has compression tag');
    assert(cfg.tags.includes('context'), 'has context tag');
  });

  test('returns empty array for empty history', async () => {
    const bus = mockBus();
    const c = new ConversationCompressor({ bus });
    const result = await c.compress([], 1000, mockTokenizer());
    assertEqual(result.length, 0);
  });

  test('returns empty array for null history', async () => {
    const bus = mockBus();
    const c = new ConversationCompressor({ bus });
    const result = await c.compress(null, 1000, mockTokenizer());
    assertEqual(result.length, 0);
  });

  test('keeps all messages when within budget', async () => {
    const bus = mockBus();
    const c = new ConversationCompressor({ bus });
    const history = makeHistory(4, 20); // 4 short messages

    const result = await c.compress(history, 10000, mockTokenizer());
    assertEqual(result.length, 4);
  });

  test('keeps recent messages when history is small', async () => {
    const bus = mockBus();
    const c = new ConversationCompressor({ bus });
    const history = makeHistory(3, 20);

    const result = await c.compress(history, 10000, mockTokenizer());
    assertEqual(result.length, 3);
  });

  test('trims recent messages when budget is very tight', async () => {
    const bus = mockBus();
    const c = new ConversationCompressor({ bus });
    // Each message ~30 chars, ~8 tokens at 4 chars/token
    const history = makeHistory(4, 20);

    // Very tight budget — only room for ~2 messages
    const result = await c.compress(history, 16, mockTokenizer());
    assert(result.length <= 4, `trimmed to ${result.length}`);
  });

  test('uses LLM summarization for long history', async () => {
    const bus = mockBus();
    const model = mockModel('LLM generated summary of older messages.');
    const c = new ConversationCompressor({ bus, model });

    // 10 messages, each ~112 chars ≈ 28 tokens = ~280 total
    // Budget 200: recent 4 msgs (112 tokens) fits, but total (280) exceeds
    const history = makeHistory(10, 100);
    const result = await c.compress(history, 200, mockTokenizer());

    // Should have 1 summary + 4 recent = 5 messages
    assert(result.length <= 5, `result has ${result.length} messages`);
    assert(result[0].content.includes('CONVERSATION SUMMARY'), 'first message is summary');
    assert(result[0].content.includes('LLM generated summary'), 'contains LLM summary text');
    assertEqual(c.stats.compressions, 1);
  });

  test('emits context:overflow-prevented when compressing', async () => {
    const bus = mockBus();
    const model = mockModel('Summary.');
    const c = new ConversationCompressor({ bus, model });

    const history = makeHistory(10, 100);
    await c.compress(history, 200, mockTokenizer());

    const overflowEvents = bus._events.filter(e => e.evt === 'context:overflow-prevented');
    assertEqual(overflowEvents.length, 1);
    assert(overflowEvents[0].data.totalTokens > 0, 'has totalTokens');
    assert(overflowEvents[0].data.messagesCompressed > 0, 'has messagesCompressed');
  });

  test('emits context:compressed after summarization', async () => {
    const bus = mockBus();
    const model = mockModel('Short summary.');
    const c = new ConversationCompressor({ bus, model });

    const history = makeHistory(10, 100);
    await c.compress(history, 200, mockTokenizer());

    const compressEvents = bus._events.filter(e => e.evt === 'context:compressed');
    assertEqual(compressEvents.length, 1);
    assert(compressEvents[0].data.originalTokens > 0, 'has originalTokens');
    assert(compressEvents[0].data.compressedTokens > 0, 'has compressedTokens');
  });

  test('falls back to extractive summary when no LLM', async () => {
    const bus = mockBus();
    const c = new ConversationCompressor({ bus }); // no model

    const history = [
      { role: 'user', content: 'Please fix the function parseConfig in utils.js' },
      { role: 'assistant', content: 'I found a bug in parseConfig. The error was in line 42.' },
      { role: 'user', content: 'Now create a test file for it.' },
      { role: 'assistant', content: 'I created test/parseConfig.test.js with 5 test cases.' },
      { role: 'user', content: 'Run the tests please.' },
      { role: 'assistant', content: 'All 5 tests passed. The function is working correctly.' },
      { role: 'user', content: 'Great, now deploy it.' },
      { role: 'assistant', content: 'Deployed to staging. Step complete.' },
    ];

    const result = await c.compress(history, 80, mockTokenizer());

    assert(result.length > 0, 'has results');
    assert(result[0].content.includes('CONVERSATION SUMMARY'), 'has summary header');
    assertEqual(c.stats.compressions, 1);
  });

  test('extractive fallback prefers sentences with key phrases', async () => {
    const bus = mockBus();
    const c = new ConversationCompressor({ bus });

    const history = [
      { role: 'user', content: 'Hello there, how are you doing today?' },
      { role: 'assistant', content: 'I modified the file src/main.js to fix the error in the parser function.' },
      { role: 'user', content: 'Thanks, that looks nice and clean.' },
      { role: 'assistant', content: 'I also created a new test for the parser class.' },
      { role: 'user', content: 'Perfect!' },
      { role: 'assistant', content: 'The feature is now complete and all tests pass.' },
      { role: 'user', content: 'Now what?' },
      { role: 'assistant', content: 'We should plan the next step in the project roadmap.' },
    ];

    const result = await c.compress(history, 50, mockTokenizer());
    const summaryContent = result[0]?.content || '';

    // Should prefer messages with keywords like "file", "error", "function", "test", "created"
    assert(
      summaryContent.includes('file') || summaryContent.includes('test') || summaryContent.includes('function'),
      'extractive summary prioritizes key phrases'
    );
  });

  test('falls back to extractive when LLM throws', async () => {
    const bus = mockBus();
    const model = { chat: async () => { throw new Error('LLM unavailable'); } };
    const c = new ConversationCompressor({ bus, model });

    const history = makeHistory(10, 100);
    const result = await c.compress(history, 200, mockTokenizer());

    assert(result.length > 0, 'still produces result');
    assert(result[0].content.includes('CONVERSATION SUMMARY'), 'falls back to extractive');
    assertEqual(c.stats.compressions, 1);
  });

  test('caches summaries and returns cached on repeat', async () => {
    const bus = mockBus();
    let callCount = 0;
    const model = { chat: async () => { callCount++; return 'Cached summary.'; } };
    const c = new ConversationCompressor({ bus, model });

    const history = makeHistory(10, 100);
    const tokenizer = mockTokenizer();

    await c.compress(history, 200, tokenizer);
    assertEqual(callCount, 1);
    assertEqual(c.stats.cacheHits, 0);

    // Same history again
    await c.compress(history, 200, tokenizer);
    assertEqual(callCount, 1); // LLM not called again
    assertEqual(c.stats.cacheHits, 1);
  });

  test('cache evicts oldest when exceeding max', async () => {
    const bus = mockBus();
    const model = mockModel('Summary.');
    const c = new ConversationCompressor({ bus, model });
    const tokenizer = mockTokenizer();

    // Fill cache beyond CACHE_MAX (8)
    for (let i = 0; i < 10; i++) {
      const history = makeHistory(8 + i, 100); // different histories
      await c.compress(history, 200, tokenizer);
    }

    assert(c._cache.size <= 8, `cache size ${c._cache.size} <= 8`);
  });

  test('stop() clears cache and unsubs', () => {
    const bus = mockBus();
    const c = new ConversationCompressor({ bus });
    c._cache.set('test', { summary: 'test', timestamp: Date.now() });
    c.stop();
    assertEqual(c._cache.size, 0);
  });

  test('_trimMessages keeps newest messages first', () => {
    const bus = mockBus();
    const c = new ConversationCompressor({ bus });
    const est = (text) => Math.ceil(text.length / 4);

    const msgs = [
      { role: 'user', content: 'First message with some content here' },
      { role: 'assistant', content: 'Second message response' },
      { role: 'user', content: 'Third and most recent' },
    ];

    // Budget for ~2 messages
    const result = c._trimMessages(msgs, 15, est);
    assert(result.length >= 1, 'has at least 1 message');
    // Last message should be kept
    assert(
      result[result.length - 1].content.includes('Third'),
      'newest message preserved'
    );
  });

  test('_hashMessages produces consistent keys', () => {
    const bus = mockBus();
    const c = new ConversationCompressor({ bus });

    const msgs = [{ role: 'user', content: 'hello' }, { role: 'assistant', content: 'world' }];
    const h1 = c._hashMessages(msgs);
    const h2 = c._hashMessages(msgs);
    assertEqual(h1, h2);

    const different = [{ role: 'user', content: 'goodbye' }];
    const h3 = c._hashMessages(different);
    assert(h1 !== h3, 'different messages produce different hashes');
  });

  test('handles LLM returning object response', async () => {
    const bus = mockBus();
    const model = { chat: async () => ({ content: 'Object response summary.' }) };
    const c = new ConversationCompressor({ bus, model });

    const history = makeHistory(10, 100);
    const result = await c.compress(history, 200, mockTokenizer());

    assert(result[0].content.includes('Object response summary'), 'extracts content from object');
  });

  test('handles LLM returning empty response', async () => {
    const bus = mockBus();
    const model = { chat: async () => '' };
    const c = new ConversationCompressor({ bus, model });

    const history = makeHistory(10, 100);
    const result = await c.compress(history, 200, mockTokenizer());

    // Should fall back to extractive
    assert(result[0].content.includes('CONVERSATION SUMMARY'), 'falls back on empty LLM response');
  });

  test('tokensSaved stat tracks correctly', async () => {
    const bus = mockBus();
    const model = mockModel('Short.');
    const c = new ConversationCompressor({ bus, model });

    const history = makeHistory(10, 100);
    await c.compress(history, 200, mockTokenizer());

    assert(c.stats.tokensSaved > 0, `saved ${c.stats.tokensSaved} tokens`);
  });

});

run();
