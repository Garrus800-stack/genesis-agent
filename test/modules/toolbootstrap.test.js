// ============================================================
// Test: ToolBootstrap — tool registration with mock container
// ============================================================
let passed = 0, failed = 0;
const failures = [];

// v3.5.2: Fixed — queue-based async-safe test runner
const _testQueue = [];
function test(name, fn) { _testQueue.push({ name, fn }); }
function assert(c, m) { if (!c) throw new Error(m || 'Assertion failed'); }

const { ToolBootstrap } = require('../../src/agent/capabilities/ToolBootstrap');

console.log('\n  🔧 ToolBootstrap');

// ── Mock container ──────────────────────────────────────

function createMockContainer(opts = {}) {
  const registeredTools = new Map();
  const services = new Map();

  const mockTools = {
    register(name, schema, handler, category) {
      registeredTools.set(name, { schema, handler, category });
    },
    listTools: () => [...registeredTools.entries()].map(([name, t]) => ({ name, ...t.schema })),
  };

  services.set('tools', mockTools);
  services.set('lang', { t: (k) => k, detect: () => {}, current: 'en' });
  services.set('fileProcessor', { getFileInfo: () => ({}), executeFile: () => '' });
  services.set('knowledgeGraph', { search: () => [], connect: () => 'edge1' });
  // FIX v5.1.0: ToolBootstrap now resolves memoryFacade instead of knowledgeGraph directly.
  services.set('memoryFacade', {
    knowledgeSearch: (q, limit) => services.get('knowledgeGraph').search(q, limit),
    knowledgeConnect: (from, rel, to) => services.get('knowledgeGraph').connect(from, rel, to),
  });
  services.set('eventStore', { query: () => [] });
  services.set('webFetcher', { fetchText: () => ({}), npmSearch: () => ({}), ping: () => ({}) });
  services.set('lang', { t: (k) => k, detect: () => {}, current: 'en' });

  if (opts.withUnifiedMemory) {
    services.set('unifiedMemory', { recall: async () => [] });
  }
  if (opts.withShellAgent) {
    services.set('shellAgent', { execute: async () => 'done' });
  }

  return {
    resolve: (name) => {
      if (!services.has(name)) throw new Error(`Service not found: ${name}`);
      return services.get(name);
    },
    has: (name) => services.has(name),
    _registeredTools: registeredTools,
  };
}

// ── Core tool registration ──────────────────────────────

test('registers all core tools (file, knowledge, events, web)', () => {
  const container = createMockContainer();
  ToolBootstrap.register(container);
  const tools = container._registeredTools;

  assert(tools.has('file-info'), 'Missing file-info');
  assert(tools.has('execute-file'), 'Missing execute-file');
  assert(tools.has('knowledge-search'), 'Missing knowledge-search');
  assert(tools.has('knowledge-connect'), 'Missing knowledge-connect');
  assert(tools.has('event-query'), 'Missing event-query');
  assert(tools.has('web-fetch'), 'Missing web-fetch');
  assert(tools.has('npm-search'), 'Missing npm-search');
  assert(tools.has('web-ping'), 'Missing web-ping');
});

test('core tools have correct categories', () => {
  const container = createMockContainer();
  ToolBootstrap.register(container);
  const tools = container._registeredTools;

  for (const name of ['file-info', 'execute-file', 'knowledge-search', 'knowledge-connect', 'event-query', 'web-fetch', 'npm-search', 'web-ping']) {
    assert(tools.get(name).category === 'builtin', `${name} should be category builtin`);
  }
});

test('registers exactly 8 core tools without optional services', () => {
  const container = createMockContainer();
  ToolBootstrap.register(container);
  assert(container._registeredTools.size === 8, `Expected 8 tools, got ${container._registeredTools.size}`);
});

// ── Conditional tools ───────────────────────────────────

test('registers unified-recall when unifiedMemory is available', () => {
  const container = createMockContainer({ withUnifiedMemory: true });
  ToolBootstrap.register(container);
  assert(container._registeredTools.has('unified-recall'), 'Missing unified-recall');
  assert(container._registeredTools.size === 9, `Expected 9 tools, got ${container._registeredTools.size}`);
});

test('skips unified-recall when unifiedMemory is absent', () => {
  const container = createMockContainer();
  ToolBootstrap.register(container);
  assert(!container._registeredTools.has('unified-recall'), 'Should not have unified-recall');
});

test('registers shell-task when shellAgent is available', () => {
  const container = createMockContainer({ withShellAgent: true });
  ToolBootstrap.register(container);
  assert(container._registeredTools.has('shell-task'), 'Missing shell-task');
  assert(container._registeredTools.get('shell-task').category === 'shell', 'shell-task category should be shell');
});

test('skips shell-task when shellAgent is absent', () => {
  const container = createMockContainer();
  ToolBootstrap.register(container);
  assert(!container._registeredTools.has('shell-task'), 'Should not have shell-task');
});

test('registers all tools when all services available', () => {
  const container = createMockContainer({ withUnifiedMemory: true, withShellAgent: true });
  ToolBootstrap.register(container);
  assert(container._registeredTools.size === 11, `Expected 11 tools, got ${container._registeredTools.size}`);
});

// ── Handler execution ───────────────────────────────────

test('knowledge-search handler calls knowledgeGraph.search via memoryFacade', () => {
  let searchCalled = false;
  const container = createMockContainer();
  // Override the mock
  const services = new Map();
  services.set('tools', {
    register(name, schema, handler, cat) {
      if (name === 'knowledge-search') {
        container._ksHandler = handler;
      }
      container._registeredTools.set(name, { schema, handler, category: cat });
    },
  });
  services.set('fileProcessor', { getFileInfo: () => ({}), executeFile: () => '' });
  const mockKg = { search: (q, n) => { searchCalled = true; return [{ label: 'test' }]; }, connect: () => 'e1' };
  services.set('knowledgeGraph', mockKg);
  // FIX v5.1.0: ToolBootstrap now resolves memoryFacade instead of knowledgeGraph
  services.set('memoryFacade', {
    knowledgeSearch: (q, limit) => mockKg.search(q, limit),
    knowledgeConnect: (from, rel, to) => mockKg.connect(from, rel, to),
  });
  services.set('eventStore', { query: () => [] });
  services.set('webFetcher', { fetchText: () => ({}), npmSearch: () => ({}), ping: () => ({}) });
  services.set('lang', { t: (k) => k, detect: () => {}, current: 'en' });
  const c2 = { resolve: (n) => services.get(n), has: (n) => services.has(n), _registeredTools: container._registeredTools };
  ToolBootstrap.register(c2);

  const result = container._ksHandler({ query: 'test' });
  assert(searchCalled, 'knowledgeGraph.search should have been called via memoryFacade');
  assert(Array.isArray(result.results), 'Should return results array');
});

test('web-ping handler delegates to webFetcher.ping', () => {
  let pinged = false;
  const container = createMockContainer();
  const services = new Map();
  services.set('tools', {
    register(name, schema, handler, cat) {
      if (name === 'web-ping') container._pingHandler = handler;
      container._registeredTools.set(name, { schema, handler, category: cat });
    },
  });
  services.set('fileProcessor', { getFileInfo: () => ({}), executeFile: () => '' });
  services.set('knowledgeGraph', { search: () => [], connect: () => 'e1' });
  services.set('eventStore', { query: () => [] });
  services.set('webFetcher', { fetchText: () => ({}), npmSearch: () => ({}), ping: (url) => { pinged = true; return { reachable: true }; } });
  services.set('lang', { t: (k) => k, detect: () => {}, current: 'en' });
  const c2 = { resolve: (n) => services.get(n), has: (n) => services.has(n), _registeredTools: container._registeredTools };
  ToolBootstrap.register(c2);

  const result = container._pingHandler({ url: 'http://example.com' });
  assert(pinged, 'webFetcher.ping should have been called');
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
