// @ts-checked-v5.7
// ============================================================
// GENESIS — McpCodeExec.js (v5.2.0 — Delegate Extraction)
//
// Extracted from McpClient.js to reduce God-class (31→27 methods).
//
// PROBLEM: McpClient had 4 code execution methods with complex
// internal logic (Worker RPC bridge, Sandbox fallback, regex
// legacy) that bloated the class. But they access McpClient
// internals (servers Map, schema cache, pattern tracker).
//
// SOLUTION: Bridge interface. The delegate receives a minimal
// contract object instead of the full McpClient reference:
//   { getConnection, validateArgs, formatResult, trackCall }
//
// This decouples the code execution engine from McpClient's
// internal structure. McpClient can refactor its server map,
// schema cache, or pattern tracker without touching the delegate.
//
// Pattern: Same principle as AgentLoopSteps/AgentLoopPlanner —
// composition with explicit contract boundaries.
// ============================================================

const path = require('path');
const { Worker } = require('worker_threads');
const { createLogger } = require('../core/Logger');
const _log = createLogger('McpCodeExec');

class McpCodeExecDelegate {
  /**
   * @param {object} bridge - Minimal interface to McpClient
   * @param {function(string): object|null} bridge.getConnection - (serverName) → connection or null
   * @param {function(string, string, object): {valid:boolean, errors?:string[]}} bridge.validateArgs
   * @param {function(object): object} bridge.formatResult
   * @param {function(string, string, object): void} bridge.trackCall
   * @param {object|null} bridge.sandbox - Sandbox instance for fallback execution
   * @param {number} [bridge.timeout] - Execution timeout in ms (default: 10000)
   */
  constructor(bridge) {
    this._bridge = bridge;
  }

  // ════════════════════════════════════════════════════════
  // PUBLIC: Single entry point
  // ════════════════════════════════════════════════════════

  /**
   * Execute user code with MCP tool access.
   * Tries: worker isolation → sandbox → legacy regex.
   */
  async execute(userCode) {
    try {
      return await this._isolated(userCode);
    } catch (isolationErr) {
      _log.warn('[MCP:CODE] Worker isolation failed, falling back to sandbox:', isolationErr.message);
      return this._sandbox(userCode);
    }
  }

  // ════════════════════════════════════════════════════════
  // WORKER ISOLATION (primary)
  // ════════════════════════════════════════════════════════

  /**
   * Process-isolated execution via worker_thread.
   * Worker has no require/process/fs access.
   * mcp() calls are bridged via postMessage RPC.
   */
  async _isolated(userCode) {
    const bridge = this._bridge;
    const mcpCallLog = [];
    const timeout = bridge.timeout || 10000;

    return new Promise((resolve, reject) => {
      const workerPath = path.resolve(__dirname, 'McpWorker.js');

      const worker = new Worker(workerPath, {
        workerData: { code: userCode, timeout },
        resourceLimits: {
          maxOldGenerationSizeMb: 64,
          maxYoungGenerationSizeMb: 16,
          codeRangeSizeMb: 8,
        },
      });

      const killTimer = setTimeout(() => {
        worker.terminate();
        resolve({
          output: null,
          error: `[MCP] Code execution timeout (${timeout}ms) — worker terminated`,
          mcpCalls: mcpCallLog.length,
          callLog: mcpCallLog,
          duration: timeout,
          mode: 'worker-timeout',
        });
      }, timeout + 2000);

      // Handle mcp() RPC calls from worker
      worker.on('message', async (msg) => {
        if (msg.type === 'mcp-call') {
          try {
            const conn = bridge.getConnection(msg.server);
            if (!conn || (conn.status !== 'ready' && conn.status !== 'degraded')) {
              worker.postMessage({ type: 'mcp-result', id: msg.id, error: `MCP server "${msg.server}" not available` });
              return;
            }

            const validation = bridge.validateArgs(msg.server, msg.tool, msg.args);
            if (!validation.valid) {
              worker.postMessage({ type: 'mcp-result', id: msg.id, error: `Invalid args for ${msg.tool}: ${validation.errors?.join(', ') || 'unknown'}` });
              return;
            }

            const start = Date.now();
            const result = await conn.callTool(msg.tool, msg.args);
            const formatted = bridge.formatResult(result);

            mcpCallLog.push({ server: msg.server, tool: msg.tool, args: Object.keys(msg.args || {}), duration: Date.now() - start });
            bridge.trackCall(msg.server, msg.tool, msg.args);

            worker.postMessage({ type: 'mcp-result', id: msg.id, result: formatted });
          } catch (err) {
            worker.postMessage({ type: 'mcp-result', id: msg.id, error: err.message });
          }
        }

        if (msg.type === 'complete') {
          clearTimeout(killTimer);
          worker.terminate();
          resolve({
            output: msg.output || '',
            error: msg.error || null,
            mcpCalls: mcpCallLog.length,
            callLog: mcpCallLog,
            duration: msg.duration,
            mode: 'worker-isolated',
          });
        }
      });

      worker.on('error', (err) => {
        clearTimeout(killTimer);
        resolve({
          output: null,
          error: `[MCP] Worker error: ${err.message}`,
          mcpCalls: mcpCallLog.length,
          callLog: mcpCallLog,
          mode: 'worker-error',
        });
      });

      worker.on('exit', (code) => {
        clearTimeout(killTimer);
        if (code !== 0 && code !== null) {
          resolve({
            output: null,
            error: `[MCP] Worker exited with code ${code}`,
            mcpCalls: mcpCallLog.length,
            callLog: mcpCallLog,
            mode: 'worker-crash',
          });
        }
      });
    });
  }

  // ════════════════════════════════════════════════════════
  // SANDBOX FALLBACK
  // ════════════════════════════════════════════════════════

  async _sandbox(userCode) {
    const bridge = this._bridge;
    if (!bridge.sandbox) {
      return { output: null, error: '[MCP] No sandbox available for code execution', mcpCalls: 0 };
    }

    const mcpCallLog = [];

    const mcpFunction = async (server, tool, args = {}) => {
      const conn = bridge.getConnection(server);
      if (!conn || (conn.status !== 'ready' && conn.status !== 'degraded')) {
        throw new Error(`MCP server "${server}" not available`);
      }

      const validation = bridge.validateArgs(server, tool, args);
      if (!validation.valid) {
        throw new Error(`Invalid args for ${tool}: ${validation.errors?.join(', ') || 'unknown'}`);
      }

      const start = Date.now();
      const result = await conn.callTool(tool, args);
      const formatted = bridge.formatResult(result);

      mcpCallLog.push({ server, tool, args: Object.keys(args), duration: Date.now() - start });
      bridge.trackCall(server, tool, args);

      return formatted;
    };

    const wrappedCode = `
      (async (mcp) => {
        ${userCode}
      })
    `;

    try {
      const sandboxResult = await bridge.sandbox.executeWithContext(wrappedCode, {
        mcp: mcpFunction,
      }, { trusted: true });

      return {
        output: sandboxResult.output || '',
        error: sandboxResult.error || null,
        mcpCalls: mcpCallLog.length,
        callLog: mcpCallLog,
        duration: sandboxResult.duration,
      };
    } catch (err) {
      if (err.message?.includes('executeWithContext')) {
        return this._legacy(userCode);
      }
      return { output: null, error: err.message, mcpCalls: mcpCallLog.length, callLog: mcpCallLog };
    }
  }

  // ════════════════════════════════════════════════════════
  // LEGACY REGEX FALLBACK
  // ════════════════════════════════════════════════════════

  async _legacy(userCode) {
    const bridge = this._bridge;
    if (!bridge.sandbox) {
      return { output: null, error: '[MCP] No sandbox for legacy execution', mcpCalls: 0 };
    }

    const calls = [];
    const callPattern = /await\s+mcp\(\s*["']([^"']+)["']\s*,\s*["']([^"']+)["']\s*(?:,\s*(\{[^}]*\}))?\s*\)/g;
    let match;
    while ((match = callPattern.exec(userCode)) !== null) {
      calls.push({
        server: match[1], tool: match[2],
        argsStr: match[3] || '{}',
        fullMatch: match[0], index: match.index,
      });
    }

    if (calls.length === 0) {
      const result = await bridge.sandbox.execute(userCode);
      return { output: result.output, error: result.error, duration: result.duration, mcpCalls: 0 };
    }

    const results = [];
    for (const c of calls) {
      const conn = bridge.getConnection(c.server);
      if (!conn || (conn.status !== 'ready' && conn.status !== 'degraded')) {
        results.push({ error: `Server ${c.server} not available` });
        continue;
      }
      try {
        let args = {};
        try { args = JSON.parse(c.argsStr); } catch (_e) { _log.debug('[MCP] Args parse fallback:', _e.message); }
        const result = await conn.callTool(c.tool, args);
        results.push(bridge.formatResult(result));
        bridge.trackCall(c.server, c.tool, args);
      } catch (err) {
        results.push({ error: err.message });
      }
    }

    let injectedCode = userCode;
    for (let i = calls.length - 1; i >= 0; i--) {
      const replacement = JSON.stringify(results[i]);
      injectedCode =
        injectedCode.substring(0, calls[i].index) +
        replacement +
        injectedCode.substring(calls[i].index + calls[i].fullMatch.length);
    }

    const wrappedCode = `(async () => { ${injectedCode} })()`;
    try {
      const sandboxResult = await bridge.sandbox.execute(wrappedCode);
      return {
        output: sandboxResult.output || '',
        error: sandboxResult.error || null,
        mcpCalls: calls.length,
        duration: sandboxResult.duration,
      };
    } catch (err) {
      return { output: JSON.stringify(results), error: err.message, mcpCalls: calls.length };
    }
  }
}

module.exports = { McpCodeExecDelegate };
