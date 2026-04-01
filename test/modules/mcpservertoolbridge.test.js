// ============================================================
// TEST — McpServerToolBridge.js (v5.8.0)
// ============================================================

const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');
const { McpServerToolBridge } = require('../../src/agent/capabilities/McpServerToolBridge');
const { EventBus } = require('../../src/agent/core/EventBus');

// ── Mock McpServer ──────────────────────────────────────────

function mockMcpServer() {
  const tools = new Map();
  const resources = new Map();
  return {
    _tools: tools,
    _resources: resources,
    registerBridgeTool(name, def) { tools.set(name, def); },
    unregisterBridgeTool(name) { return tools.delete(name); },
    registerResource(uri, def) { resources.set(uri, def); },
    unregisterResource(uri) { return resources.delete(uri); },
    _initialized: false,
    notifyToolsChanged() {},
  };
}

// ── Mock VerificationEngine ─────────────────────────────────

function mockVerificationEngine() {
  return {
    codeVerifier: {
      verify(code) {
        if (!code || !code.trim()) return { status: 'fail', reason: 'Empty code', checks: [] };
        return { status: 'pass', reason: 'Code verified', checks: [{ name: 'syntax', passed: true }] };
      },
      checkSyntax(code) {
        try { new Function(code); return { passed: true }; } catch (e) { return { passed: false, error: e.message }; }
      },
    },
  };
}

// ── Mock CodeSafetyScanner ──────────────────────────────────

function mockCodeSafety() {
  return {
    scan(code) {
      const violations = [];
      if (code.includes('eval(')) violations.push({ rule: 'no-eval', severity: 'high' });
      if (code.includes('fs.writeFile')) violations.push({ rule: 'no-fs-write', severity: 'medium' });
      return { safe: violations.length === 0, violations };
    },
  };
}

// ── Mock ProjectIntelligence ────────────────────────────────

function mockProjectIntelligence() {
  return {
    getProfile() {
      return { language: 'javascript', framework: 'electron', testFramework: 'node:test', files: 217 };
    },
    getSuggestions() {
      return [{ type: 'quality', suggestion: 'Reduce cyclomatic complexity in AgentLoop' }];
    },
  };
}

// ── Mock ArchitectureReflection ─────────────────────────────

function mockArchReflection() {
  return {
    query(text) {
      if (text.includes('phase map')) return { type: 'phaseMap', phases: { 1: ['storage'] } };
      return { type: 'summary', services: 111, events: 318 };
    },
    getSnapshot() {
      return { services: 111, events: 318, layers: 13, couplings: 1 };
    },
  };
}

// ── Mock KnowledgeGraph ──────────────────────────────────

function mockKnowledgeGraph() {
  return {
    getStats() { return { nodes: 42, edges: 78, nodeTypes: { concept: 20, entity: 22 } }; },
    getNodesByType(type) {
      return [{ id: '1', label: 'EventBus', type }, { id: '2', label: 'Container', type }];
    },
  };
}

// ── Mock LessonsStore ───────────────────────────────────

function mockLessonsStore() {
  return {
    getAll() { return [{ category: 'code', evidence: { confidence: 0.9 }, lesson: 'Use async/await' }]; },
    getStats() { return { totalLessons: 1, byCategory: { code: 1 }, avgConfidence: 0.9 }; },
  };
}

// ── Tests ───────────────────────────────────────────────────

describe('McpServerToolBridge', () => {
  let bridge;
  let mcpServer;
  let bus;

  before(async () => {
    bus = new EventBus();
    mcpServer = mockMcpServer();
    bridge = new McpServerToolBridge({
      bus,
      mcpServer,
      verificationEngine: mockVerificationEngine(),
      codeSafetyScanner: mockCodeSafety(),
      projectIntelligence: mockProjectIntelligence(),
      architectureReflection: mockArchReflection(),
      knowledgeGraph: mockKnowledgeGraph(),
      lessonsStore: mockLessonsStore(),
    });
    await bridge.start();
  });

  // ── Registration ────────────────────────────────────────

  describe('registration', () => {
    it('registers 7 bridge tools', () => {
      assert.equal(bridge.registeredTools.length, 7);
    });

    it('all expected tools present', () => {
      const names = bridge.registeredTools;
      assert.ok(names.includes('genesis.verify-code'));
      assert.ok(names.includes('genesis.verify-syntax'));
      assert.ok(names.includes('genesis.code-safety-scan'));
      assert.ok(names.includes('genesis.project-profile'));
      assert.ok(names.includes('genesis.project-suggestions'));
      assert.ok(names.includes('genesis.architecture-query'));
      assert.ok(names.includes('genesis.architecture-snapshot'));
    });

    it('tools have proper inputSchema', () => {
      for (const [, def] of mcpServer._tools) {
        assert.ok(def.inputSchema, 'Missing inputSchema');
        assert.equal(def.inputSchema.type, 'object');
      }
    });

    it('tools have descriptions', () => {
      for (const [name, def] of mcpServer._tools) {
        assert.ok(def.description, `${name} missing description`);
        assert.ok(def.description.length > 10, `${name} description too short`);
      }
    });
  });

  // ── genesis.verify-code ─────────────────────────────────

  describe('genesis.verify-code', () => {
    it('verifies valid code', async () => {
      const handler = mcpServer._tools.get('genesis.verify-code').handler;
      const result = await handler({ code: 'const x = 1;' });
      assert.equal(result.status, 'pass');
    });

    it('fails on empty code', async () => {
      const handler = mcpServer._tools.get('genesis.verify-code').handler;
      const result = await handler({ code: '' });
      assert.equal(result.status, 'fail');
    });
  });

  // ── genesis.verify-syntax ───────────────────────────────

  describe('genesis.verify-syntax', () => {
    it('passes valid syntax', async () => {
      const handler = mcpServer._tools.get('genesis.verify-syntax').handler;
      const result = await handler({ code: 'function f() { return 1; }' });
      assert.equal(result.passed, true);
    });

    it('fails invalid syntax', async () => {
      const handler = mcpServer._tools.get('genesis.verify-syntax').handler;
      const result = await handler({ code: 'function { broken' });
      assert.equal(result.passed, false);
    });
  });

  // ── genesis.code-safety-scan ────────────────────────────

  describe('genesis.code-safety-scan', () => {
    it('safe code passes', async () => {
      const handler = mcpServer._tools.get('genesis.code-safety-scan').handler;
      const result = await handler({ code: 'const x = 1 + 2;' });
      assert.equal(result.safe, true);
      assert.equal(result.violations.length, 0);
    });

    it('detects eval', async () => {
      const handler = mcpServer._tools.get('genesis.code-safety-scan').handler;
      const result = await handler({ code: 'eval("danger")' });
      assert.equal(result.safe, false);
      assert.ok(result.violations.some(v => v.rule === 'no-eval'));
    });
  });

  // ── genesis.project-profile ─────────────────────────────

  describe('genesis.project-profile', () => {
    it('returns project profile', async () => {
      const handler = mcpServer._tools.get('genesis.project-profile').handler;
      const result = await handler({});
      assert.equal(result.language, 'javascript');
      assert.equal(result.framework, 'electron');
    });
  });

  // ── genesis.project-suggestions ─────────────────────────

  describe('genesis.project-suggestions', () => {
    it('returns suggestions array', async () => {
      const handler = mcpServer._tools.get('genesis.project-suggestions').handler;
      const result = await handler({});
      assert.ok(Array.isArray(result));
      assert.ok(result.length > 0);
    });
  });

  // ── genesis.architecture-query ──────────────────────────

  describe('genesis.architecture-query', () => {
    it('handles phase map query', async () => {
      const handler = mcpServer._tools.get('genesis.architecture-query').handler;
      const result = await handler({ query: 'phase map' });
      assert.equal(result.type, 'phaseMap');
    });

    it('handles general query', async () => {
      const handler = mcpServer._tools.get('genesis.architecture-query').handler;
      const result = await handler({ query: 'how many services' });
      assert.equal(result.type, 'summary');
      assert.equal(result.services, 111);
    });
  });

  // ── genesis.architecture-snapshot ───────────────────────

  describe('genesis.architecture-snapshot', () => {
    it('returns full snapshot', async () => {
      const handler = mcpServer._tools.get('genesis.architecture-snapshot').handler;
      const result = await handler({});
      assert.equal(result.services, 111);
      assert.equal(result.events, 318);
      assert.equal(result.layers, 13);
    });
  });

  // ── Null safety ─────────────────────────────────────────

  describe('null safety', () => {
    it('skips tools when services are null', async () => {
      const nullBridge = new McpServerToolBridge({
        bus,
        mcpServer: mockMcpServer(),
      });
      await nullBridge.start();
      assert.equal(nullBridge.registeredTools.length, 0);
    });
  });

  // ── Resources ────────────────────────────────────────────

  describe('resources', () => {
    it('registers 4 resources', () => {
      assert.equal(bridge.registeredResources.length, 4);
    });

    it('knowledge graph stats resource exists', () => {
      assert.ok(bridge.registeredResources.includes('genesis://knowledge-graph/stats'));
    });

    it('knowledge graph nodes resource exists', () => {
      assert.ok(bridge.registeredResources.includes('genesis://knowledge-graph/nodes'));
    });

    it('lessons stats resource exists', () => {
      assert.ok(bridge.registeredResources.includes('genesis://lessons/stats'));
    });

    it('lessons all resource exists', () => {
      assert.ok(bridge.registeredResources.includes('genesis://lessons/all'));
    });

    it('KG stats handler returns data', async () => {
      const handler = mcpServer._resources.get('genesis://knowledge-graph/stats').handler;
      const result = await handler();
      assert.equal(result.nodes, 42);
      assert.equal(result.edges, 78);
    });

    it('KG nodes handler returns limited nodes', async () => {
      const handler = mcpServer._resources.get('genesis://knowledge-graph/nodes').handler;
      const result = await handler();
      assert.equal(result.totalNodes, 42);
      assert.ok(result.nodes.length > 0);
    });

    it('lessons all handler returns lessons', async () => {
      const handler = mcpServer._resources.get('genesis://lessons/all').handler;
      const result = await handler();
      assert.equal(result.count, 1);
      assert.equal(result.lessons[0].category, 'code');
    });

    it('lessons stats handler returns stats', async () => {
      const handler = mcpServer._resources.get('genesis://lessons/stats').handler;
      const result = await handler();
      assert.equal(result.totalLessons, 1);
      assert.equal(result.avgConfidence, 0.9);
    });

    it('no resources when services are null', async () => {
      const ms = mockMcpServer();
      const b = new McpServerToolBridge({ bus, mcpServer: ms });
      await b.start();
      assert.equal(b.registeredResources.length, 0);
    });
  });

  // ── Stop ────────────────────────────────────────────────

  describe('stop', () => {
    it('unregisters all tools and resources on stop', async () => {
      const ms = mockMcpServer();
      const b = new McpServerToolBridge({
        bus, mcpServer: ms,
        verificationEngine: mockVerificationEngine(),
        knowledgeGraph: mockKnowledgeGraph(),
      });
      await b.start();
      assert.ok(ms._tools.size > 0);
      assert.ok(ms._resources.size > 0);
      await b.stop();
      assert.equal(ms._tools.size, 0);
      assert.equal(ms._resources.size, 0);
      assert.equal(b.registeredTools.length, 0);
      assert.equal(b.registeredResources.length, 0);
    });
  });
});
