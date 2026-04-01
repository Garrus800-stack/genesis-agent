// @ts-checked-v5.8
// ============================================================
// GENESIS — McpServerToolBridge.js (v5.8.0)
//
// Bridges Genesis internal services to MCP Server tools.
// Registers VerificationEngine, CodeAnalyzer, ProjectIntelligence,
// and ArchitectureReflection as callable MCP tools with proper
// JSON Schema inputSchemas.
//
// Pattern: Late-bound service references via Container.
//          Null-safe — gracefully skips unavailable services.
// ============================================================

const { NullBus } = require('../core/EventBus');
const { createLogger } = require('../core/Logger');
const _log = createLogger('McpToolBridge');

/**
 * @typedef {{ name: string, description: string, inputSchema: object, handler: (args: object) => Promise<*> }} BridgeToolDef
 */

class McpServerToolBridge {
  /**
   * @param {{
   *   bus?: *,
   *   mcpClient?: *,
   *   mcpServer?: *,
   *   verificationEngine?: *,
   *   codeAnalyzer?: *,
   *   projectIntelligence?: *,
   *   architectureReflection?: *,
   *   codeSafetyScanner?: *,
   *   knowledgeGraph?: *,
   *   lessonsStore?: *,
   * }} deps
   */
  constructor(deps = {}) {
    this.bus = deps.bus || NullBus;
    /** @type {*} — set via late binding from mcpClient */
    this._mcpClient = deps.mcpClient || null;
    /** @type {*} */ this._mcpServer = deps.mcpServer || null;
    /** @type {*} */ this._verification = deps.verificationEngine || null;
    /** @type {*} */ this._codeAnalyzer = deps.codeAnalyzer || null;
    /** @type {*} */ this._projectIntel = deps.projectIntelligence || null;
    /** @type {*} */ this._archReflection = deps.architectureReflection || null;
    /** @type {*} */ this._codeSafety = deps.codeSafetyScanner || null;
    /** @type {*} */ this._knowledgeGraph = deps.knowledgeGraph || null;
    /** @type {*} */ this._lessonsStore = deps.lessonsStore || null;
    /** @type {string[]} */ this._registered = [];
    /** @type {string[]} */ this._registeredResources = [];
  }

  // ── Lifecycle ─────────────────────────────────────────────

  async start() {
    // Resolve McpServer from McpClient (late-bound)
    if (!this._mcpServer && this._mcpClient) {
      this._mcpServer = this._mcpClient.mcpServer || null;
    }

    if (!this._mcpServer) {
      _log.debug('[BRIDGE] No McpServer available — skipping tool registration');
      return;
    }

    this._registerAll();
    this._registerResources();
    _log.info(`[BRIDGE] Registered ${this._registered.length} tools, ${this._registeredResources.length} resources`);
    this.bus.fire('mcp:bridge-started', {
      tools: [...this._registered],
      resources: [...this._registeredResources],
    }, { source: 'McpToolBridge' });
  }

  async stop() {
    if (!this._mcpServer) return;
    for (const name of this._registered) {
      this._mcpServer.unregisterBridgeTool(name);
    }
    for (const uri of this._registeredResources) {
      this._mcpServer.unregisterResource(uri);
    }
    this._registered = [];
    this._registeredResources = [];
  }

  // ── Tool Definitions ──────────────────────────────────────

  _registerAll() {
    const tools = [
      this._defVerifyCode(),
      this._defVerifySyntax(),
      this._defCodeSafetyScan(),
      this._defProjectProfile(),
      this._defProjectSuggestions(),
      this._defArchitectureQuery(),
      this._defArchitectureSnapshot(),
    ];

    for (const def of tools) {
      if (!def) continue; // Service not available
      this._mcpServer.registerBridgeTool(def.name, def);
      this._registered.push(def.name);
    }
  }

  // ── genesis.verify-code ───────────────────────────────────

  /** @returns {BridgeToolDef | null} */
  _defVerifyCode() {
    if (!this._verification) return null;
    const ve = this._verification;
    return {
      name: 'genesis.verify-code',
      description: 'Verify JavaScript/Node.js code for syntax errors, bad imports, and risky patterns. Returns pass/fail with detailed check results.',
      inputSchema: {
        type: 'object',
        properties: {
          code: { type: 'string', description: 'JavaScript source code to verify' },
          targetFile: { type: 'string', description: 'Optional target filename for import resolution context' },
        },
        required: ['code'],
      },
      handler: async (args) => {
        const verifier = ve.codeVerifier || ve;
        if (typeof verifier.verify !== 'function') {
          return { error: 'CodeVerifier not available' };
        }
        return verifier.verify(args.code, { targetFile: args.targetFile });
      },
    };
  }

  // ── genesis.verify-syntax ─────────────────────────────────

  /** @returns {BridgeToolDef | null} */
  _defVerifySyntax() {
    if (!this._verification) return null;
    const ve = this._verification;
    return {
      name: 'genesis.verify-syntax',
      description: 'Quick syntax check via AST parse. Lighter than full verify-code.',
      inputSchema: {
        type: 'object',
        properties: {
          code: { type: 'string', description: 'JavaScript source code to check' },
        },
        required: ['code'],
      },
      handler: async (args) => {
        const verifier = ve.codeVerifier || ve;
        if (typeof verifier.checkSyntax !== 'function') {
          return { error: 'Syntax checker not available' };
        }
        return verifier.checkSyntax(args.code);
      },
    };
  }

  // ── genesis.code-safety-scan ──────────────────────────────

  /** @returns {BridgeToolDef | null} */
  _defCodeSafetyScan() {
    if (!this._codeSafety) return null;
    const scanner = this._codeSafety;
    return {
      name: 'genesis.code-safety-scan',
      description: 'Scan code for safety violations: filesystem writes, network access, process spawning, eval, and other dangerous patterns.',
      inputSchema: {
        type: 'object',
        properties: {
          code: { type: 'string', description: 'JavaScript source code to scan' },
        },
        required: ['code'],
      },
      handler: async (args) => {
        if (typeof scanner.scan === 'function') return scanner.scan(args.code);
        if (typeof scanner.check === 'function') return scanner.check(args.code);
        return { error: 'CodeSafetyScanner has no scan/check method' };
      },
    };
  }

  // ── genesis.project-profile ───────────────────────────────

  /** @returns {BridgeToolDef | null} */
  _defProjectProfile() {
    if (!this._projectIntel) return null;
    const pi = this._projectIntel;
    return {
      name: 'genesis.project-profile',
      description: 'Get structural profile of the current project: tech stack, coding conventions, quality indicators, coupling hotspots.',
      inputSchema: {
        type: 'object',
        properties: {},
      },
      handler: async () => {
        if (typeof pi.getProfile === 'function') return pi.getProfile();
        return { error: 'ProjectIntelligence.getProfile not available' };
      },
    };
  }

  // ── genesis.project-suggestions ───────────────────────────

  /** @returns {BridgeToolDef | null} */
  _defProjectSuggestions() {
    if (!this._projectIntel) return null;
    const pi = this._projectIntel;
    return {
      name: 'genesis.project-suggestions',
      description: 'Get improvement suggestions for the current project based on structural analysis.',
      inputSchema: {
        type: 'object',
        properties: {},
      },
      handler: async () => {
        if (typeof pi.getSuggestions === 'function') return pi.getSuggestions();
        return { error: 'ProjectIntelligence.getSuggestions not available' };
      },
    };
  }

  // ── genesis.architecture-query ────────────────────────────

  /** @returns {BridgeToolDef | null} */
  _defArchitectureQuery() {
    if (!this._archReflection) return null;
    const ar = this._archReflection;
    return {
      name: 'genesis.architecture-query',
      description: 'Query Genesis architecture with natural language. Supports: "what depends on X", "event flow X", "chain from X to Y", "phase map", "layer map", "couplings", "info X".',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Natural language architecture query' },
        },
        required: ['query'],
      },
      handler: async (args) => {
        if (typeof ar.query === 'function') return ar.query(args.query);
        return { error: 'ArchitectureReflection.query not available' };
      },
    };
  }

  // ── genesis.architecture-snapshot ─────────────────────────

  /** @returns {BridgeToolDef | null} */
  _defArchitectureSnapshot() {
    if (!this._archReflection) return null;
    const ar = this._archReflection;
    return {
      name: 'genesis.architecture-snapshot',
      description: 'Get full architecture snapshot: all services, events, layers, phases, and cross-phase couplings.',
      inputSchema: {
        type: 'object',
        properties: {},
      },
      handler: async () => {
        if (typeof ar.getSnapshot === 'function') return ar.getSnapshot();
        return { error: 'ArchitectureReflection.getSnapshot not available' };
      },
    };
  }

  // ── Resource Registration ────────────────────────────────

  _registerResources() {
    const resources = [
      this._resKnowledgeGraphStats(),
      this._resKnowledgeGraphNodes(),
      this._resLessonsAll(),
      this._resLessonsStats(),
    ];

    for (const def of resources) {
      if (!def) continue;
      this._mcpServer.registerResource(def.uri, def);
      this._registeredResources.push(def.uri);
    }
  }

  /** @returns {{ uri: string, name: string, description: string, handler: () => Promise<*> } | null} */
  _resKnowledgeGraphStats() {
    if (!this._knowledgeGraph) return null;
    const kg = this._knowledgeGraph;
    return {
      uri: 'genesis://knowledge-graph/stats',
      name: 'Knowledge Graph Stats',
      description: 'Node/edge counts, types, and embedding stats from the semantic knowledge graph.',
      handler: async () => kg.getStats(),
    };
  }

  /** @returns {{ uri: string, name: string, description: string, handler: () => Promise<*> } | null} */
  _resKnowledgeGraphNodes() {
    if (!this._knowledgeGraph) return null;
    const kg = this._knowledgeGraph;
    return {
      uri: 'genesis://knowledge-graph/nodes',
      name: 'Knowledge Graph Nodes',
      description: 'All concept nodes with types and relation counts (max 200).',
      handler: async () => {
        const stats = kg.getStats();
        const types = stats.nodeTypes || {};
        const nodes = [];
        for (const type of Object.keys(types)) {
          const batch = kg.getNodesByType(type) || [];
          for (const n of batch) {
            nodes.push({ id: n.id, label: n.label, type: n.type });
            if (nodes.length >= 200) break;
          }
          if (nodes.length >= 200) break;
        }
        return { totalNodes: stats.nodes || 0, returned: nodes.length, nodes };
      },
    };
  }

  /** @returns {{ uri: string, name: string, description: string, handler: () => Promise<*> } | null} */
  _resLessonsAll() {
    if (!this._lessonsStore) return null;
    const ls = this._lessonsStore;
    return {
      uri: 'genesis://lessons/all',
      name: 'All Lessons',
      description: 'All cross-project lessons with categories, confidence, and evidence.',
      handler: async () => {
        const lessons = ls.getAll();
        return { count: lessons.length, lessons: lessons.slice(0, 100) };
      },
    };
  }

  /** @returns {{ uri: string, name: string, description: string, handler: () => Promise<*> } | null} */
  _resLessonsStats() {
    if (!this._lessonsStore) return null;
    const ls = this._lessonsStore;
    return {
      uri: 'genesis://lessons/stats',
      name: 'Lessons Stats',
      description: 'Lesson counts by category and source, average confidence.',
      handler: async () => ls.getStats(),
    };
  }

  // ── Accessors ─────────────────────────────────────────────

  get registeredTools() { return [...this._registered]; }
  get registeredResources() { return [...this._registeredResources]; }
}

module.exports = { McpServerToolBridge };
