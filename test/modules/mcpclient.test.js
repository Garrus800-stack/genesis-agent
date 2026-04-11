// ============================================================
// Test: McpClient — schema validation, pattern detection
// ============================================================
let passed = 0, failed = 0;
const failures = [];

// v3.5.2: Fixed — queue-based async-safe test runner
const _testQueue = [];
function test(name, fn) { _testQueue.push({ name, fn }); }
function assert(c, m) { if (!c) throw new Error(m || 'Assertion failed'); }

const { McpClient } = require('../../src/agent/capabilities/McpClient');

console.log('\n  🔌 McpClient Validation & Patterns');

function createMockClient() {
  const mockBus = { emit() {}, on() {}, off() {} };
  return new McpClient({
    bus: mockBus,
    settings: { get: () => [], set: () => {} },
    toolRegistry: {
      register: () => {},
      listTools: () => [],
      execute: async () => ({}),
    },
    sandbox: null,
    knowledgeGraph: {
      addNode: () => 'id',
      connect: () => 'edge',
      search: () => [],
    },
    eventStore: {
      append: () => {},
      query: () => [],
    },
    storageDir: require('path').join(require('os').tmpdir(), 'genesis-test'),
  });
}

// ── Schema Validation ───────────────────────────────────

test('_validateArgs passes with no schema', () => {
  const client = createMockClient();
  // No schema cached = skip validation
  const result = client._validateArgs('server', 'tool', { foo: 'bar' });
  assert(result.valid, 'Should pass without schema');
});

test('_validateArgs passes with valid args', () => {
  const client = createMockClient();
  client._schemaCache.set('s:t', {
    properties: { name: { type: 'string' }, count: { type: 'number' } },
    required: ['name'],
  });
  const result = client._validateArgs('s', 't', { name: 'test', count: 42 });
  assert(result.valid, 'Should pass with valid args');
});

test('_validateArgs fails on missing required field', () => {
  const client = createMockClient();
  client._schemaCache.set('s:t', {
    properties: { name: { type: 'string' } },
    required: ['name'],
  });
  const result = client._validateArgs('s', 't', {});
  assert(!result.valid, 'Should fail');
  assert(result.errors[0].includes('name'), `Error should mention field name: ${result.errors[0]}`);
});

test('_validateArgs fails on wrong type', () => {
  const client = createMockClient();
  client._schemaCache.set('s:t', {
    properties: { count: { type: 'number' } },
    required: [],
  });
  const result = client._validateArgs('s', 't', { count: 'not-a-number' });
  assert(!result.valid, 'Should fail');
  assert(result.errors[0].includes('number'), `Error should mention expected type`);
});

test('_validateArgs accepts extra fields not in schema', () => {
  const client = createMockClient();
  client._schemaCache.set('s:t', {
    properties: { name: { type: 'string' } },
    required: [],
  });
  const result = client._validateArgs('s', 't', { name: 'test', extra: true });
  assert(result.valid, 'Extra fields should be OK');
});

test('_validateArgs checks string type', () => {
  const client = createMockClient();
  client._schemaCache.set('s:t', {
    properties: { val: { type: 'string' } },
    required: [],
  });
  assert(client._validateArgs('s', 't', { val: 'ok' }).valid);
  assert(!client._validateArgs('s', 't', { val: 123 }).valid);
});

test('_validateArgs checks boolean type', () => {
  const client = createMockClient();
  client._schemaCache.set('s:t', {
    properties: { flag: { type: 'boolean' } },
    required: [],
  });
  assert(client._validateArgs('s', 't', { flag: true }).valid);
  assert(!client._validateArgs('s', 't', { flag: 'yes' }).valid);
});

// ── Pattern Detection ───────────────────────────────────

test('_updatePatternCounts detects pair patterns', () => {
  const client = createMockClient();
  // Simulate 3x the same pair
  for (let i = 0; i < 3; i++) {
    client._chainWindow.push({ server: 'gh', tool: 'list', ts: Date.now() });
    client._chainWindow.push({ server: 'gh', tool: 'get', ts: Date.now() });
    client._updatePatternCounts();
  }
  const pattern = 'gh:list→gh:get';
  assert(client._patternCounts.has(pattern), `Pattern "${pattern}" should be detected`);
  assert(client._patternCounts.get(pattern) >= 3, 'Count should be >= 3');
});

test('_updatePatternCounts tracks triple patterns', () => {
  const client = createMockClient();
  for (let i = 0; i < 4; i++) {
    client._chainWindow.push({ server: 'a', tool: 'x', ts: Date.now() });
    client._chainWindow.push({ server: 'a', tool: 'y', ts: Date.now() });
    client._chainWindow.push({ server: 'a', tool: 'z', ts: Date.now() });
    client._updatePatternCounts();
  }
  assert(client._patternCounts.has('a:x→a:y→a:z'), 'Triple pattern should be tracked');
});

test('getSkillCandidates returns patterns with count >= 3', () => {
  const client = createMockClient();
  client._recipes['a:x→a:y'] = { chain: [], count: 3, firstSeen: Date.now(), suggested: false };
  client._recipes['b:x→b:y'] = { chain: [], count: 2, firstSeen: Date.now(), suggested: false };
  client._recipes['c:x→c:y'] = { chain: [], count: 5, firstSeen: Date.now(), suggested: true };

  const candidates = client.getSkillCandidates();
  assert(candidates.length === 1, `Expected 1 candidate, got ${candidates.length}`);
  assert(candidates[0].pattern === 'a:x→a:y');
});

test('markPatternSuggested marks recipe', () => {
  const client = createMockClient();
  client._recipes['a:x→a:y'] = { chain: [], count: 3, firstSeen: Date.now(), suggested: false };
  client.markPatternSuggested('a:x→a:y');
  assert(client._recipes['a:x→a:y'].suggested === true);
  assert(client.getSkillCandidates().length === 0, 'Should not appear in candidates anymore');
});

// ── Keyword Extraction ──────────────────────────────────

test('_extractKeywords filters stop words and short words', () => {
  const client = createMockClient();
  const kw = client._extractKeywords('The quick brown fox searches for files in the database');
  assert(!kw.includes('the'));
  assert(!kw.includes('for'));
  assert(!kw.includes('in'));
  assert(kw.includes('quick') || kw.includes('brown') || kw.includes('searches'));
});

test('_extractKeywords filters German stop words', () => {
  const client = createMockClient();
  const kw = client._extractKeywords('eine Datei wird nach dieser Datenbank gespeichert');
  assert(!kw.includes('eine'), 'Should filter "eine"');
  assert(!kw.includes('nach'), 'Should filter "nach"');
  assert(kw.includes('datei') || kw.includes('datenbank') || kw.includes('gespeichert'),
    'Should keep content words');
});

test('_extractKeywords caps at 8 keywords', () => {
  const client = createMockClient();
  const kw = client._extractKeywords('alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo lima');
  assert(kw.length <= 8, `Expected <= 8 keywords, got ${kw.length}`);
});

test('_extractKeywords returns empty for null/empty', () => {
  const client = createMockClient();
  assert(client._extractKeywords(null).length === 0);
  assert(client._extractKeywords('').length === 0);
});

// ── Status ──────────────────────────────────────────────

test('getStatus returns correct structure', () => {
  const client = createMockClient();
  const status = client.getStatus();
  assert(typeof status.serverCount === 'number');
  assert(typeof status.connectedCount === 'number');
  assert(typeof status.degradedCount === 'number');
  assert(Array.isArray(status.metaTools));
  assert(typeof status.recipes === 'number');
  assert(typeof status.patternCounts === 'number');
});

// ── findRelevantTools ────────────────────────────────────

test('findRelevantTools returns [] when kg is null', () => {
  const client = createMockClient();
  client.kg = null;
  const result = client.findRelevantTools('search query');
  assert(Array.isArray(result) && result.length === 0);
});

test('findRelevantTools filters only mcp-tool nodes from kg', () => {
  const client = createMockClient();
  client.kg = {
    search: () => [
      { type: 'mcp-tool', label: 'do-thing', properties: { server: 'srv', description: 'does thing' } },
      { type: 'node', label: 'other' },
    ],
  };
  const result = client.findRelevantTools('thing');
  assert(result.length === 1 && result[0].name === 'do-thing');
});

// ── _trackCall ───────────────────────────────────────────

test('_trackCall appends to chain window', () => {
  const client = createMockClient();
  client._trackCall('srv', 'tool-a', { x: 1 });
  assert(client._chainWindow.length === 1);
  assert(client._chainWindow[0].tool === 'tool-a');
});

test('_trackCall trims chain window to 20', () => {
  const client = createMockClient();
  for (let i = 0; i < 25; i++) client._trackCall('srv', `t${i}`, {});
  assert(client._chainWindow.length === 20, `Expected 20 got ${client._chainWindow.length}`);
});

// ── _allTools ────────────────────────────────────────────

test('_allTools returns empty array when no servers', () => {
  const client = createMockClient();
  const tools = client._allTools();
  assert(Array.isArray(tools) && tools.length === 0);
});

test('_allTools aggregates tools from multiple servers', () => {
  const client = createMockClient();
  const fakeConn = { tools: [{ name: 'a' }, { name: 'b' }] };
  client.servers.set('fake', fakeConn);
  const tools = client._allTools();
  assert(tools.length === 2);
});

// ── _formatResult ────────────────────────────────────────

test('_formatResult handles missing content', () => {
  const client = createMockClient();
  const r = client._formatResult({ data: 42 });
  assert(r.result !== undefined);
});

test('_formatResult extracts text blocks', () => {
  const client = createMockClient();
  const r = client._formatResult({
    content: [{ type: 'text', text: 'hello' }, { type: 'text', text: ' world' }],
  });
  assert(r.text === 'hello\n world', `Got: ${r.text}`);
});

test('_formatResult extracts resource blocks', () => {
  const client = createMockClient();
  const r = client._formatResult({
    content: [{ type: 'resource', resource: { uri: 'file://x' } }],
  });
  assert(Array.isArray(r.resources) && r.resources[0].uri === 'file://x');
});

test('_formatResult propagates isError flag', () => {
  const client = createMockClient();
  const r = client._formatResult({ content: [], isError: true });
  assert(r.isError === true);
});

// ── _saveConfig / _removeConfig ──────────────────────────

test('_saveConfig adds server to settings', () => {
  const stored = [];
  const bus = { emit() {}, on() {}, off() {} };
  const client = new (require('../../src/agent/capabilities/McpClient').McpClient)({
    bus,
    settings: {
      get: (k) => k === 'mcp.servers' ? stored : [],
      set: (k, v) => { if (k === 'mcp.servers') stored.splice(0, stored.length, ...v); },
    },
    toolRegistry: { register: () => {}, listTools: () => [], execute: async () => ({}) },
    sandbox: null,
    knowledgeGraph: { addNode: () => 'id', connect: () => 'e', search: () => [] },
    eventStore: { append: () => {}, query: () => [] },
    storageDir: require('os').tmpdir(),
  });
  client._saveConfig({ name: 'my-server', url: 'http://localhost:9000' });
  assert(stored.length === 1 && stored[0].name === 'my-server');
});

test('_removeConfig removes server from settings', () => {
  const stored = [{ name: 'keep' }, { name: 'remove' }];
  const bus = { emit() {}, on() {}, off() {} };
  const client = new (require('../../src/agent/capabilities/McpClient').McpClient)({
    bus,
    settings: {
      get: (k) => k === 'mcp.servers' ? stored : [],
      set: (k, v) => { if (k === 'mcp.servers') stored.splice(0, stored.length, ...v); },
    },
    toolRegistry: { register: () => {}, listTools: () => [], execute: async () => ({}) },
    sandbox: null,
    knowledgeGraph: { addNode: () => 'id', connect: () => 'e', search: () => [] },
    eventStore: { append: () => {}, query: () => [] },
    storageDir: require('os').tmpdir(),
  });
  client._removeConfig('remove');
  assert(stored.length === 1 && stored[0].name === 'keep');
});

// ── removeServer ─────────────────────────────────────────

test('removeServer returns false for unknown server', () => {
  const client = createMockClient();
  const result = client.removeServer('nonexistent');
  assert(result === false);
});

test('removeServer disconnects and removes known server', () => {
  const client = createMockClient();
  let disconnected = false;
  client.servers.set('s1', {
    disconnect() { disconnected = true; },
    tools: [],
  });
  const result = client.removeServer('s1');
  assert(result === true);
  assert(disconnected, 'should have called disconnect()');
  assert(!client.servers.has('s1'));
});

test('removeServer cleans schema cache for server', () => {
  const client = createMockClient();
  client._schemaCache.set('s1:tool-a', { properties: {} });
  client._schemaCache.set('other:tool-b', { properties: {} });
  client.servers.set('s1', { disconnect() {}, tools: [] });
  client.removeServer('s1');
  assert(!client._schemaCache.has('s1:tool-a'), 'should remove s1 schemas');
  assert(client._schemaCache.has('other:tool-b'), 'should keep other schemas');
});

// ── shutdown ─────────────────────────────────────────────

test('shutdown clears servers and schema cache', async () => {
  const client = createMockClient();
  let disc = false;
  client.servers.set('srv', { disconnect() { disc = true; }, tools: [] });
  client._schemaCache.set('srv:t', {});
  await client.shutdown();
  assert(disc, 'disconnect should be called');
  assert(client.servers.size === 0);
  assert(client._schemaCache.size === 0);
});

// ── addServer (error path) ───────────────────────────────

test('addServer throws when name missing', async () => {
  const client = createMockClient();
  let threw = false;
  try { await client.addServer({ url: 'http://x' }); }
  catch (e) { threw = true; assert(e.message.includes('name')); }
  assert(threw, 'should throw on missing name');
});

test('addServer throws when url missing', async () => {
  const client = createMockClient();
  let threw = false;
  try { await client.addServer({ name: 'x' }); }
  catch (e) { threw = true; assert(e.message.includes('url')); }
  assert(threw, 'should throw on missing url');
});

// ── getExplorationContext ─────────────────────────────────

test('getExplorationContext returns object with servers and recipes', () => {
  const client = createMockClient();
  const ctx = client.getExplorationContext();
  assert(typeof ctx === 'object');
  assert(Array.isArray(ctx.servers));
  assert(Array.isArray(ctx.recipes));
  assert(Array.isArray(ctx.skillCandidates));
});

// ── Report ──────────────────────────────────────────────

// v3.5.2: Async-safe runner — properly awaits all tests
(async () => {
  for (const t of _testQueue) {
    try {
      const r = t.fn(); if (r && r.then) await r;
      passed++; console.log(`    ✅ ${t.name}`);
    } catch (err) {
      failed++; console.log(`    ❌ ${t.name}: ${err.message}`);
    }
  }
  console.log(`\n    ${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
})();
