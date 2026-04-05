// ============================================================
// GENESIS — test/modules/webfetcher.test.js (v3.8.0)
// Tests for WebFetcher: URL validation, domain blocking,
// rate limiting, HTML stripping, stats (no network needed)
// ============================================================

const { describe, test, assert, assertEqual, run } = require('../harness');
const { WebFetcher } = require('../../src/agent/foundation/WebFetcher');

describe('WebFetcher — Constructor & Defaults', () => {
  test('initializes with expected defaults', () => {
    const wf = new WebFetcher();
    assertEqual(wf.maxSize, 512 * 1024);
    assertEqual(wf.timeoutMs, 10000);
    assertEqual(wf.maxRedirects, 3);
    assertEqual(wf.maxRequestsPerMinute, 10);
    assertEqual(wf.requestCount, 0);
  });

  test('has blocked domains list', () => {
    const wf = new WebFetcher();
    assert(wf.blockedDomains.length > 0, 'should have blocked domains');
    assert(wf.blockedDomains.includes('localhost'), 'should block localhost');
    assert(wf.blockedDomains.includes('127.0.0.1'), 'should block loopback');
  });

  test('has trusted domains list', () => {
    const wf = new WebFetcher();
    assert(wf.trustedDomains.length > 0, 'should have trusted domains');
    assert(wf.trustedDomains.includes('github.com'), 'should trust github');
    assert(wf.trustedDomains.includes('npmjs.com'), 'should trust npm');
  });
});

describe('WebFetcher — URL Validation', () => {
  test('rejects invalid URL', async () => {
    const wf = new WebFetcher();
    const result = await wf.fetch('not-a-url');
    assertEqual(result.ok, false);
    assertEqual(result.status, 0);
    assert(result.error.includes('URL') || result.error.includes('Ungueltig'), result.error);
  });

  test('rejects ftp protocol', async () => {
    const wf = new WebFetcher();
    const result = await wf.fetch('ftp://files.example.com/data');
    assertEqual(result.ok, false);
    assert(result.error.includes('HTTP') || result.error.includes('erlaubt'), result.error);
  });

  test('rejects file protocol', async () => {
    const wf = new WebFetcher();
    const result = await wf.fetch('file:///etc/passwd');
    assertEqual(result.ok, false);
  });
});

describe('WebFetcher — Domain Blocking (SSRF Protection)', () => {
  test('blocks localhost', async () => {
    const wf = new WebFetcher();
    const result = await wf.fetch('http://localhost:8080/api');
    assertEqual(result.ok, false);
    assertEqual(result.status, 403);
    assert(result.error.includes('blockiert') || result.error.includes('blocked'), result.error);
  });

  test('blocks 127.0.0.1', async () => {
    const wf = new WebFetcher();
    const result = await wf.fetch('http://127.0.0.1:11434/api/tags');
    assertEqual(result.ok, false);
    assertEqual(result.status, 403);
  });

  test('blocks private network 192.168.*', async () => {
    const wf = new WebFetcher();
    const result = await wf.fetch('http://192.168.1.1/admin');
    assertEqual(result.ok, false);
    assertEqual(result.status, 403);
  });

  test('blocks private network 10.*', async () => {
    const wf = new WebFetcher();
    const result = await wf.fetch('http://10.0.0.1/internal');
    assertEqual(result.ok, false);
    assertEqual(result.status, 403);
  });

  test('blocks private network 172.16.*', async () => {
    const wf = new WebFetcher();
    const result = await wf.fetch('http://172.16.0.1/api');
    assertEqual(result.ok, false);
    assertEqual(result.status, 403);
  });

  test('blocks 0.0.0.0', async () => {
    const wf = new WebFetcher();
    const result = await wf.fetch('http://0.0.0.0:3000/');
    assertEqual(result.ok, false);
    assertEqual(result.status, 403);
  });
});

describe('WebFetcher — Rate Limiting', () => {
  test('allows requests within limit', () => {
    const wf = new WebFetcher();
    // Fresh fetcher, no prior requests
    assert(wf._checkRateLimit(), 'first request should pass');
    assert(wf._checkRateLimit(), 'second request should pass');
  });

  test('blocks requests beyond limit', () => {
    const wf = new WebFetcher();
    wf.maxRequestsPerMinute = 3;
    assert(wf._checkRateLimit(), 'req 1');
    assert(wf._checkRateLimit(), 'req 2');
    assert(wf._checkRateLimit(), 'req 3');
    assert(!wf._checkRateLimit(), 'req 4 should be blocked');
  });

  test('rate limit returns 429 on fetch', async () => {
    const wf = new WebFetcher();
    wf.maxRequestsPerMinute = 0; // Block all
    const result = await wf.fetch('https://example.com');
    assertEqual(result.ok, false);
    assertEqual(result.status, 429);
    assert(result.error.includes('Rate limit') || result.error.includes('rate'), result.error);
  });

  test('old requests are cleaned up', () => {
    const wf = new WebFetcher();
    wf.maxRequestsPerMinute = 2;
    // Simulate requests from 2 minutes ago
    wf.requestTimes = [Date.now() - 120000, Date.now() - 120000];
    assert(wf._checkRateLimit(), 'old requests should not count');
  });
});

describe('WebFetcher — HTML Stripping', () => {
  test('strips basic HTML tags', () => {
    const wf = new WebFetcher();
    const result = wf._stripHtml('<p>Hello <b>World</b></p>');
    assert(result.includes('Hello'), 'should preserve text');
    assert(result.includes('World'), 'should preserve text');
    assert(!result.includes('<p>'), 'should remove tags');
    assert(!result.includes('<b>'), 'should remove tags');
  });

  test('strips script tags and content', () => {
    const wf = new WebFetcher();
    const result = wf._stripHtml('<p>Safe</p><script>alert("xss")</script><p>Content</p>');
    assert(!result.includes('alert'), 'should remove script content');
    assert(result.includes('Safe'), 'should keep text');
    assert(result.includes('Content'), 'should keep text');
  });

  test('strips style tags and content', () => {
    const wf = new WebFetcher();
    const result = wf._stripHtml('<style>body { color: red; }</style><p>Text</p>');
    assert(!result.includes('color'), 'should remove style content');
    assert(result.includes('Text'));
  });

  test('strips nav, header, footer', () => {
    const wf = new WebFetcher();
    const result = wf._stripHtml('<nav>Menu</nav><main>Content</main><footer>Footer</footer>');
    assert(!result.includes('Menu'), 'should remove nav');
    assert(result.includes('Content'), 'should keep main content');
    assert(!result.includes('Footer'), 'should remove footer');
  });

  test('decodes HTML entities', () => {
    const wf = new WebFetcher();
    const result = wf._stripHtml('&amp; &lt; &gt; &quot; &nbsp;');
    assert(result.includes('&'), 'should decode &amp;');
    assert(result.includes('<'), 'should decode &lt;');
    assert(result.includes('>'), 'should decode &gt;');
    assert(result.includes('"'), 'should decode &quot;');
  });

  test('collapses whitespace', () => {
    const wf = new WebFetcher();
    const result = wf._stripHtml('<p>  Hello   World  </p>');
    assert(!result.includes('   '), 'should collapse extra spaces');
  });
});

describe('WebFetcher — Stats', () => {
  test('getStats returns expected shape', () => {
    const wf = new WebFetcher();
    const stats = wf.getStats();
    assert('totalRequests' in stats, 'should have totalRequests');
    assert('recentRequests' in stats, 'should have recentRequests');
    assertEqual(stats.totalRequests, 0);
    assertEqual(stats.recentRequests, 0);
  });
});

run();
