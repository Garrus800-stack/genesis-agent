// @ts-checked-v5.7
// ============================================================
// GENESIS — ToolBootstrap.js
//
// Extracted from AgentCore: all extra tool registrations that
// don't belong in the thin shell. AgentCore calls
// ToolBootstrap.register(container) during Phase 3.
//
// This keeps AgentCore focused on boot/wire/bridge and
// makes tool registration testable in isolation.
// ============================================================

class ToolBootstrap {
  /**
   * Register all extra tools (file, knowledge, events, web, unified recall)
   * @param {object} container - DI container
   */
  static register(container) {
    const tools = container.resolve('tools');
    const lang = container.resolve('lang');
    const fp = container.resolve('fileProcessor');
    // FIX v5.1.0 (A-2): Route through MemoryFacade instead of direct knowledgeGraph.
    // Eliminates the "Memory Silo Bypass" flagged by the fitness check.
    // ToolBootstrap.register() is called post-phase-5 so memoryFacade is always available.
    const memFacade = container.resolve('memoryFacade');
    const es = container.resolve('eventStore');
    const web = container.resolve('webFetcher');

    // ── File Tools ──────────────────────────────────────

    tools.register('file-info', {
      description: lang.t('tool.file_info'),
      input: { path: 'string' },
      output: { info: 'object' },
    }, (input) => fp.getFileInfo(input.path), 'builtin');

    tools.register('execute-file', {
      description: lang.t('tool.execute_file'),
      input: { path: 'string' },
      output: { output: 'string' },
    }, (input) => fp.executeFile(input.path), 'builtin');

    // ── Knowledge Graph Tools ───────────────────────────
    // FIX v5.1.0 (A-2): Uses MemoryFacade pass-through.

    tools.register('knowledge-search', {
      description: lang.t('tool.knowledge_search'),
      input: { query: 'string' },
      output: { results: 'array' },
    }, (input) => ({
      results: memFacade.knowledgeSearch(input.query, 5),
    }), 'builtin');

    tools.register('knowledge-connect', {
      description: lang.t('tool.knowledge_connect'),
      input: { from: 'string', relation: 'string', to: 'string' },
      output: { edgeId: 'string' },
    }, (input) => ({
      edgeId: memFacade.knowledgeConnect(input.from, input.relation, input.to),
    }), 'builtin');

    // ── Event Store Tools ───────────────────────────────

    tools.register('event-query', {
      description: lang.t('tool.event_query'),
      input: { type: 'string' },
      output: { events: 'array' },
    }, (input) => ({ events: es.query({ type: input.type, limit: 10 }) }), 'builtin');

    // ── Web Tools ───────────────────────────────────────

    tools.register('web-fetch', {
      description: lang.t('tool.web_fetch'),
      input: { url: 'string' },
      output: { ok: 'boolean', body: 'string' },
    }, (input) => web.fetchText(input.url), 'builtin');

    tools.register('npm-search', {
      description: lang.t('tool.npm_search'),
      input: { query: 'string' },
      output: { packages: 'array' },
    }, (input) => web.npmSearch(input.query), 'builtin');

    tools.register('web-ping', {
      description: lang.t('tool.web_ping'),
      input: { url: 'string' },
      output: { reachable: 'boolean' },
    }, (input) => web.ping(input.url), 'builtin');

    // ── Unified Recall (v2.6) ───────────────────────────

    if (container.has('unifiedMemory')) {
      const unifiedMem = container.resolve('unifiedMemory');
      tools.register('unified-recall', {
        description: lang.t('tool.knowledge_search') + ' (unified: episodic + semantic + knowledge graph)',
        input: { query: 'string' },
        output: { results: 'array' },
      }, async (input) => ({ results: await unifiedMem.recall(input.query, { limit: 5 }) }), 'builtin');
    }

    // ── Shell Agent Tool ────────────────────────────────

    if (container.has('shellAgent')) {
      const shell = container.resolve('shellAgent');
      tools.register('shell-task', {
        description: lang.t('tool.shell_task'),
        input: { task: 'string', cwd: 'string?' },
        output: { summary: 'string' },
      }, async (input) => {
        const result = await shell.plan(input.task, input.cwd || undefined);
        return { summary: result.summary || 'No output' };
      }, 'shell');

      tools.register('shell-run', {
        description: lang.t('tool.shell_task') + ' (single command)',
        input: { command: 'string', cwd: 'string?' },
        output: { stdout: 'string', stderr: 'string', exitCode: 'number' },
      }, (input) => {
        const result = shell.run(input.command, { cwd: input.cwd });
        return { stdout: result.stdout || '', stderr: result.stderr || '', exitCode: result.exitCode || 0 };
      }, 'shell');
    }
  }
}

module.exports = { ToolBootstrap };
