// @ts-checked-v5.7
// ============================================================
// GENESIS — McpClient.js (v3 — Split Architecture)
//
// v3.5.0 REFACTOR: McpClient is now the orchestrator only.
// Transport layer → McpTransport.js (McpServerConnection)
// Server hosting  → McpServer.js (Genesis as MCP server)
//
// This file handles: boot, tool routing, code mode, schema
// validation, pattern detection, recipes, skill candidates,
// server management, and idle exploration.
// ============================================================

const fs = require('fs');
const path = require('path');
const { McpServerConnection } = require('./McpTransport');
const { McpCodeExecDelegate } = require('./McpCodeExec');
const { McpServer } = require('./McpServer');
const { NullBus } = require('../core/EventBus');
const { safeJsonParse, atomicWriteFileSync } = require('../core/utils');
const { createLogger } = require('../core/Logger');
const _log = createLogger('McpClient');


// ════════════════════════════════════════════════════════════
// ADAPTIVE MCP CLIENT (The Brain)
// ════════════════════════════════════════════════════════════

class McpClient {
  constructor({ bus, settings, toolRegistry, sandbox, knowledgeGraph, eventStore, storageDir, storage }) {
    this.bus = bus || NullBus;
    this.settings = settings;
    this.tools = toolRegistry;
    this.sandbox = sandbox;
    this.kg = knowledgeGraph;
    this.eventStore = eventStore;
    this.storageDir = storageDir;
    this.storage = storage || null;

    /** @type {Map<string, McpServerConnection>} */
    this.servers = new Map();

    // Pattern tracker for Auto-Skill learning
    this._chainWindow = [];

    // v2: Rolling hash for O(1) pattern detection
    this._patternCounts = new Map(); // "server:tool→server:tool" → count
    this._maxPatternCounts = 500;

    // Recipes
    this._recipePath = path.join(storageDir, 'mcp-recipes.json');
    this._recipes = this._loadRecipes();

    // v2: Tool schema cache for validation
    this._schemaCache = new Map(); // "server:tool" → inputSchema

    // v3.5.0: Delegated server hosting
    this._mcpServer = null;

    // v5.2.0: Code execution delegate — extracted to McpCodeExec.js.
    // Bridge interface decouples delegate from McpClient internals.
    this._codeExec = new McpCodeExecDelegate({
      getConnection: (name) => this.servers.get(name),
      validateArgs: (s, t, a) => this._validateArgs(s, t, a),
      formatResult: (r) => this._formatResult(r),
      trackCall: (s, t, a) => this._trackCall(s, t, a),
      sandbox: this.sandbox,
      timeout: this.sandbox?.timeout || 10000,
    });
  }

  // ════════════════════════════════════════════════════════
  // BOOT
  // ════════════════════════════════════════════════════════

  async boot() {
    const configs = this.settings.get('mcp.servers') || [];
    if (configs.length === 0) {
      _log.info('[MCP] No servers configured');
      this._registerMetaTools();
      return;
    }

    _log.info(`[MCP] Booting ${configs.length} server(s)...`);

    // Parallel boot with individual error handling
    const results = await Promise.allSettled(
      configs
        .filter(c => c.url && c.name)
        .map(config => this.addServer(config, false))
    );

    const succeeded = results.filter(r => r.status === 'fulfilled').length;
    const failed = results.filter(r => r.status === 'rejected').length;
    if (failed > 0) _log.warn(`[MCP] ${failed}/${configs.length} server(s) failed to boot`);

    this._registerMetaTools();

    // v5.9.0: Auto-start Genesis as MCP server if configured
    await this._autoStartServer();
  }

  /** @private */
  async _autoStartServer() {
    const serve = this.settings.get('mcp.serve');
    if (!serve || serve.enabled !== true) return;
    try {
      const port = await this.startServer(serve.port || 3580);
      _log.info(`[MCP] Genesis MCP server auto-started on port ${port}`);
    } catch (err) {
      _log.warn('[MCP] Auto-start server failed:', err.message);
    }
  }

  // ════════════════════════════════════════════════════════
  // TOOL SCHEMA VALIDATION
  // ════════════════════════════════════════════════════════

  _cacheSchemas(conn) {
    for (const tool of conn.tools) {
      this._schemaCache.set(`${conn.name}:${tool.name}`, tool.inputSchema);
    }
  }

  _validateArgs(server, tool, args) {
    const schema = this._schemaCache.get(`${server}:${tool}`);
    if (!schema?.properties) return { valid: true }; // No schema = skip validation

    const errors = [];
    const required = new Set(schema.required || []);

    // Check required fields
    for (const field of required) {
      if (args[field] === undefined || args[field] === null) {
        errors.push(`Missing required field: ${field}`);
      }
    }

    // Check types (basic validation)
    for (const [key, value] of Object.entries(args)) {
      const propSchema = schema.properties[key];
      if (!propSchema) continue; // Extra fields are OK

      if (propSchema.type === 'string' && typeof value !== 'string') {
        errors.push(`${key}: expected string, got ${typeof value}`);
      }
      if (propSchema.type === 'number' && typeof value !== 'number') {
        errors.push(`${key}: expected number, got ${typeof value}`);
      }
      if (propSchema.type === 'boolean' && typeof value !== 'boolean') {
        errors.push(`${key}: expected boolean, got ${typeof value}`);
      }
    }

    return errors.length > 0
      ? { valid: false, errors }
      : { valid: true };
  }

  // ════════════════════════════════════════════════════════
  // CODE MODE — 3 Meta-Tools
  // ════════════════════════════════════════════════════════

  _registerMetaTools() {
    // ── mcp-search: Tool discovery ─────────────────────────
    this.tools.register('mcp-search', {
      description: 'Search available MCP tools across all connected servers. Returns tool names, descriptions, and parameter info. Use this to discover tools before calling them.',
      input: { query: 'string' },
      output: { tools: 'array' },
    }, (input) => {
      const query = (input.query || '').toLowerCase();
      const allTools = this._allTools();

      if (!query) return { tools: allTools.map(t => ({ name: t.name, server: t.server, description: t.description })) };

      const scored = allTools.map(t => {
        const haystack = `${t.name} ${t.description}`.toLowerCase();
        let score = 0;
        for (const word of query.split(/\s+/)) {
          if (haystack.includes(word)) score += 1;
          if (t.name.toLowerCase().includes(word)) score += 2;
        }
        return { ...t, score };
      }).filter(t => t.score > 0).sort((a, b) => b.score - a.score);

      // Also check KnowledgeGraph for semantic matches
      const kgResults = this.findRelevantTools(query, 5);

      // Merge and deduplicate
      const merged = new Map();
      for (const t of [...scored.slice(0, 10), ...kgResults]) {
        const key = `${t.server}:${t.name}`;
        if (!merged.has(key)) {
          merged.set(key, {
            name: t.name, server: t.server,
            description: t.description,
            input: t.inputSchema?.properties ? Object.keys(t.inputSchema.properties) : (t.input || []),
          });
        }
      }

      return { tools: [...merged.values()] };
    }, 'mcp');

    // ── mcp-call: Single tool call (with schema validation) ─
    this.tools.register('mcp-call', {
      description: 'Call a single MCP tool. Provide server name and tool name. Use mcp-search first to discover available tools.',
      input: { server: 'string', tool: 'string', args: 'object?' },
      output: { result: 'object' },
    }, async (input) => {
      const conn = this.servers.get(input.server);
      if (!conn) throw new Error(`Unknown server: ${input.server}. Available: ${[...this.servers.keys()].join(', ')}`);
      if (conn.status !== 'ready' && conn.status !== 'degraded') {
        throw new Error(`Server ${input.server} not available (${conn.status})`);
      }

      const args = input.args || {};

      // Schema validation
      const validation = this._validateArgs(input.server, input.tool, args);
      if (!validation.valid) {
        throw new Error(`Invalid arguments for ${input.tool}: ${validation.errors?.join(', ') || 'unknown'}`);
      }

      const result = await conn.callTool(input.tool, args);
      this._trackCall(input.server, input.tool, args);
      return this._formatResult(result);
    }, 'mcp');

    // ── mcp-code: Code Mode — robust AST-aware execution ───
    if (this.sandbox) {
      this.tools.register('mcp-code', {
        description:
          'Execute JavaScript that chains multiple MCP calls. The code runs in a sandbox. ' +
          'Available: `await mcp(server, tool, args)` to call any MCP tool. ' +
          'Return the final result. Example:\n' +
          '  const repos = await mcp("github", "list-repos", {user: "garrus"});\n' +
          '  const details = await mcp("github", "get-repo", {repo: repos[0].name});\n' +
          '  return { repos: repos.length, latest: details };',
        input: { code: 'string' },
        output: { result: 'object' },
      }, async (input) => {
        return this._executeCodeMode(input.code);
      }, 'mcp');
    }

    _log.info('[MCP] Meta-tools registered: mcp-search, mcp-call' + (this.sandbox ? ', mcp-code' : ''));
  }

  /**
   * v5.2.0: Code execution delegated to McpCodeExec.js.
   * Bridge interface provides: getConnection, validateArgs, formatResult, trackCall.
   * Preserves all 3 execution modes: worker isolation → sandbox → legacy regex.
   */
  async _executeCodeMode(userCode) {
    return this._codeExec.execute(userCode);
  }

  // ════════════════════════════════════════════════════════
  // KNOWLEDGE GRAPH INTEGRATION
  // ════════════════════════════════════════════════════════

  _indexInKnowledgeGraph(conn) {
    if (!this.kg) return;

    const serverNodeId = this.kg.addNode('mcp-server', conn.name, {
      url: conn.url, transport: conn.transport,
      serverName: conn.serverInfo?.name,
      serverVersion: conn.serverInfo?.version,
    });

    for (const tool of conn.tools) {
      const toolNodeId = this.kg.addNode('mcp-tool', `${conn.name}:${tool.name}`, {
        description: tool.description,
        inputSchema: tool.inputSchema,
        server: conn.name,
      });
      this.kg.connect(serverNodeId, 'provides', toolNodeId);

      // Extract keywords from description for semantic search
      const keywords = this._extractKeywords(tool.description);
      for (const kw of keywords) {
        const kwId = this.kg.addNode('concept', kw, {});
        this.kg.connect(toolNodeId, 'relates-to', kwId);
      }
    }
  }

  _extractKeywords(text) {
    if (!text) return [];
    const stop = new Set([
      'the', 'a', 'an', 'is', 'are', 'was', 'be', 'been', 'have', 'has',
      'had', 'do', 'does', 'did', 'will', 'would', 'could', 'should',
      'may', 'might', 'must', 'to', 'of', 'in', 'for', 'on', 'with',
      'at', 'by', 'from', 'or', 'and', 'not', 'this', 'that', 'it',
      'der', 'die', 'das', 'ein', 'eine', 'und', 'oder', 'ist', 'sind',
      'fuer', 'mit', 'von', 'auf', 'aus', 'bei', 'nach',
    ]);
    return text.toLowerCase()
      .replace(/[^a-z0-9äöüß\s]/g, '')
      .split(/\s+/)
      .filter(w => w.length > 3 && !stop.has(w))
      .slice(0, 8);
  }

  findRelevantTools(query, limit = 5) {
    if (!this.kg) return [];
    const results = this.kg.search(query, limit * 2);
    return results
      .filter(r => r.type === 'mcp-tool')
      .slice(0, limit)
      .map(r => ({
        name: r.label, server: r.properties?.server,
        description: r.properties?.description,
      }));
  }

  // ════════════════════════════════════════════════════════
  // AUTO-SKILL LEARNING (v2: O(1) pattern detection)
  // ════════════════════════════════════════════════════════

  _trackCall(server, tool, args) {
    const entry = { server, tool, ts: Date.now() };
    this._chainWindow.push(entry);
    if (this._chainWindow.length > 20) this._chainWindow.shift();

    this.eventStore?.append('MCP_TOOL_CALL', {
      server, tool, argKeys: args ? Object.keys(args) : [],
    }, 'McpClient');

    // v2: O(1) pattern tracking via rolling pairs/triples
    this._updatePatternCounts();
  }

  _updatePatternCounts() {
    const w = this._chainWindow;
    if (w.length < 2) return;

    // Track pairs (length 2) and triples (length 3)
    for (const seqLen of [2, 3]) {
      if (w.length < seqLen) continue;
      const recent = w.slice(-seqLen);
      const pattern = recent.map(c => `${c.server}:${c.tool}`).join('→');

      const count = (this._patternCounts.get(pattern) || 0) + 1;
      this._patternCounts.set(pattern, count);

      // Evict lowest-count entries if map exceeds cap
      if (this._patternCounts.size > this._maxPatternCounts) {
        let minKey = null, minVal = Infinity;
        for (const [k, v] of this._patternCounts) {
          if (v < minVal) { minVal = v; minKey = k; }
        }
        if (minKey) this._patternCounts.delete(minKey);
      }

      if (count >= 3 && !this._recipes[pattern]) {
        this._recipes[pattern] = {
          chain: recent.map(c => ({ server: c.server, tool: c.tool })),
          count, firstSeen: Date.now(), suggested: false,
        };
        this._saveRecipes();

        this.bus.emit('mcp:pattern-detected', { pattern, count, chain: recent }, { source: 'McpClient' });
        _log.info(`[MCP] Pattern detected (${count}x): ${pattern}`);
      } else if (count > (this._recipes[pattern]?.count || 0)) {
        // Update count in existing recipe
        if (this._recipes[pattern]) this._recipes[pattern].count = count;
      }
    }
  }

  getSkillCandidates() {
    return Object.entries(this._recipes)
      .filter(([, r]) => r.count >= 3 && !r.suggested)
      .map(([pattern, r]) => ({ pattern, chain: r.chain, count: r.count }));
  }

  markPatternSuggested(pattern) {
    if (this._recipes[pattern]) {
      this._recipes[pattern].suggested = true;
      this._saveRecipes();
    }
  }

  // ════════════════════════════════════════════════════════
  // IDLE EXPLORATION
  // ════════════════════════════════════════════════════════

  getExplorationContext() {
    const servers = [];
    for (const [name, conn] of this.servers) {
      if (conn.status !== 'ready') continue;
      servers.push({
        name, info: conn.serverInfo,
        tools: conn.tools.map(t => ({
          name: t.name, description: t.description,
          params: t.inputSchema?.properties ? Object.keys(t.inputSchema.properties) : [],
        })),
        health: conn.getStatus().health,
      });
    }
    return {
      servers,
      recipes: Object.entries(this._recipes).map(([p, r]) => ({ pattern: p, count: r.count })),
      skillCandidates: this.getSkillCandidates(),
    };
  }

  // ════════════════════════════════════════════════════════
  // GENESIS AS MCP SERVER (delegated to McpServer.js)
  // ════════════════════════════════════════════════════════

  async startServer(port = 0) {
    if (!this._mcpServer) {
      const serve = this.settings.get('mcp.serve') || {};
      this._mcpServer = new McpServer({
        tools: this.tools, bus: this.bus,
        security: {
          apiKey:          serve.apiKey || null,
          rateLimitPerMin: serve.rateLimit || 120,
          corsOrigins:     serve.corsOrigins || ['http://127.0.0.1', 'http://localhost'],
          bodyMaxBytes:    serve.bodyMaxBytes || 1e6,
        },
      });
    }
    return this._mcpServer.start(port);
  }

  /** @returns {*} The underlying McpServer instance (for McpServerToolBridge) */
  get mcpServer() {
    if (!this._mcpServer) {
      const serve = this.settings.get('mcp.serve') || {};
      this._mcpServer = new McpServer({
        tools: this.tools, bus: this.bus,
        security: {
          apiKey:          serve.apiKey || null,
          rateLimitPerMin: serve.rateLimit || 120,
          corsOrigins:     serve.corsOrigins || ['http://127.0.0.1', 'http://localhost'],
          bodyMaxBytes:    serve.bodyMaxBytes || 1e6,
        },
      });
    }
    return this._mcpServer;
  }

  // ════════════════════════════════════════════════════════
  // SERVER MANAGEMENT
  // ════════════════════════════════════════════════════════

  async addServer(config, persist = true) {
    const { name, url } = config;
    if (!name || !url) throw new Error('MCP server needs name and url');
    if (this.servers.has(name)) { const srv = this.servers.get(name); if (srv) srv.disconnect(); }

    const conn = new McpServerConnection(config, this.bus);
    this.servers.set(name, conn);
    if (persist) this._saveConfig(config);

    if (conn.enabled) {
      try {
        await conn.connect();
        await conn.discoverTools();
        this._cacheSchemas(conn);
        this._indexInKnowledgeGraph(conn);
        _log.info(`[MCP] ${name}: ${conn.tools.length} tools indexed`);
      } catch (err) {
        _log.warn(`[MCP] Failed: ${name}: ${err.message}`);
      }
    }

    return conn.getStatus();
  }

  removeServer(name) {
    const conn = this.servers.get(name);
    if (!conn) return false;
    conn.disconnect();
    this.servers.delete(name);
    this._removeConfig(name);
    // Clean schema cache
    for (const key of this._schemaCache.keys()) {
      if (key.startsWith(`${name}:`)) this._schemaCache.delete(key);
    }
    this.bus.emit('mcp:server-removed', { name }, { source: 'McpClient' });
    return true;
  }

  async reconnect(name) {
    const conn = this.servers.get(name);
    if (!conn) throw new Error(`Unknown: ${name}`);
    conn.disconnect();
    await conn.connect();
    await conn.discoverTools();
    this._cacheSchemas(conn);
    this._indexInKnowledgeGraph(conn);
    return conn.getStatus();
  }

  // ════════════════════════════════════════════════════════
  // HELPERS
  // ════════════════════════════════════════════════════════

  _allTools() {
    const all = [];
    for (const [, conn] of this.servers) {
      for (const t of conn.tools) all.push(t);
    }
    return all;
  }

  _formatResult(result) {
    if (!result?.content) return { result };
    const texts = [], resources = [];
    for (const block of result.content) {
      if (block.type === 'text') texts.push(block.text);
      else if (block.type === 'resource') resources.push({ uri: block.resource?.uri });
    }
    return { text: texts.join('\n'), resources: resources.length ? resources : undefined, isError: result.isError || false };
  }

  _saveConfig(config) {
    const servers = this.settings.get('mcp.servers') || [];
    const i = servers.findIndex(s => s.name === config.name);
    if (i >= 0) servers[i] = config; else servers.push(config);
    this.settings.set('mcp.servers', servers);
  }

  _removeConfig(name) {
    this.settings.set('mcp.servers', (this.settings.get('mcp.servers') || []).filter(s => s.name !== name));
  }

  _loadRecipes() {
    try {
      if (this.storage) return this.storage.readJSON('mcp-recipes.json', {});
      if (fs.existsSync(this._recipePath)) return safeJsonParse(fs.readFileSync(this._recipePath, 'utf-8'), [], 'McpClient');
    } catch (err) { _log.debug('[MCP] Save state error:', err.message); }
    return {};
  }

  _saveRecipes() {
    try {
      if (this.storage) { this.storage.writeJSONDebounced('mcp-recipes.json', this._recipes); return; }
      // FIX v5.1.0 (N-3): Atomic write fallback when StorageService unavailable.
      atomicWriteFileSync(this._recipePath, JSON.stringify(this._recipes, null, 2), 'utf-8');
    } catch (err) { _log.debug('[MCP] Load state error:', err.message); }
  }

  getStatus() {
    const serverList = [...this.servers.values()].map(s => s.getStatus());
    return {
      serverCount: this.servers.size,
      connectedCount: serverList.filter(s => s.status === 'ready').length,
      degradedCount: serverList.filter(s => s.status === 'degraded').length,
      totalTools: this._allTools().length,
      metaTools: ['mcp-search', 'mcp-call', this.sandbox ? 'mcp-code' : null].filter(Boolean),
      recipes: Object.keys(this._recipes).length,
      patternCounts: this._patternCounts.size,
      skillCandidates: this.getSkillCandidates().length,
      serving: this._mcpServer?.port || null,
      servers: serverList,
    };
  }

  async shutdown() {
    for (const [, conn] of this.servers) conn.disconnect();
    this.servers.clear();
    this._schemaCache.clear();
    this._patternCounts.clear();
    if (this._mcpServer) { await this._mcpServer.shutdown(); this._mcpServer = null; }
    this._saveRecipes();
    _log.info('[MCP] Shutdown complete');
  }
}

module.exports = { McpClient, McpServerConnection };
