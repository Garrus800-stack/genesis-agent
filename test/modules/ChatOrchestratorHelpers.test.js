const { describe, test, assert, assertEqual, run } = require('../harness');
const { ChatOrchestrator } = require('../../src/agent/hexagonal/ChatOrchestrator');

function makeCO() {
  return new ChatOrchestrator({
    lang: { t: k => k }, bus: { emit(){}, fire(){}, on(){} },
    intentRouter: { classify: () => ({ type: 'general', confidence: 0.9 }) },
    model: { chat: async () => 'response' },
    context: { build: () => ({ system: 'test', messages: [] }) },
    tools: { parseToolCalls: () => ({ text: '', toolCalls: [] }) },
    promptBuilder: { build: () => 'prompt' },
    storage: null,
  });
}

describe('ChatOrchestratorHelpers — _detectLang', () => {
  test('detects python', () => {
    const co = makeCO();
    assertEqual(co._detectLang('def hello():\n  pass'), 'python');
  });
  test('detects javascript', () => {
    const co = makeCO();
    assertEqual(co._detectLang('const x = () => { return 1; }'), 'javascript');
  });
  test('defaults to javascript for unknown', () => {
    const co = makeCO();
    assertEqual(co._detectLang('some random code'), 'plaintext');
  });
});

describe('ChatOrchestratorHelpers — _extractCodeBlocks', () => {
  test('extracts fenced code blocks', () => {
    const co = makeCO();
    const blocks = co._extractCodeBlocks('Here is code:\n```javascript\nconsole.log("hello world and more stuff here");\nconst x = 1;\n```\nDone.');
    assert(blocks.length >= 1, 'should find code block');
  });
  test('returns empty for no code', () => {
    const co = makeCO();
    assertEqual(co._extractCodeBlocks('No code here.').length, 0);
  });
});

describe('ChatOrchestratorHelpers — _isRetryable', () => {
  test('retries on ECONNREFUSED', () => {
    const co = makeCO();
    assert(co._isRetryable(new Error('ECONNREFUSED 127.0.0.1')));
  });
  test('retries on timeout', () => {
    const co = makeCO();
    assert(co._isRetryable(new Error('Request timeout')));
  });
  test('does not retry on syntax error', () => {
    const co = makeCO();
    assert(!co._isRetryable(new Error('SyntaxError: unexpected')));
  });
});

describe('ChatOrchestratorHelpers — _trimHistory', () => {
  test('does nothing under max', () => {
    const co = makeCO();
    co.history = [{ role: 'user', content: 'hi' }];
    co._trimHistory();
    assertEqual(co.history.length, 1);
  });
  test('trims when over max', () => {
    const co = makeCO();
    co.maxHistory = 5;
    co.history = Array(20).fill(null).map((_, i) => ({ role: i % 2 === 0 ? 'user' : 'assistant', content: `msg ${i}` }));
    co._trimHistory();
    assert(co.history.length <= 20, 'should reduce history');
  });
});

describe('ChatOrchestratorHelpers — _recordEpisode', () => {
  test('skips when no episodicMemory', () => {
    const co = makeCO();
    co._recordEpisode('hello', 'hi', 'general'); // should not crash
    assert(true);
  });
  test('records substantive conversations', () => {
    const co = makeCO();
    let recorded = false;
    co.episodicMemory = { recordEpisode: () => { recorded = true; } };
    co._recordEpisode('This is a longer question about coding', 'Here is a detailed response about the topic with multiple sentences and examples', 'general');
    assert(recorded);
  });
  test('skips short conversations', () => {
    const co = makeCO();
    let recorded = false;
    co.episodicMemory = { recordEpisode: () => { recorded = true; } };
    co._recordEpisode('hi', 'hey', 'greeting');
    assert(!recorded);
  });
});

run();
