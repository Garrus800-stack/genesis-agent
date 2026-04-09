// @ts-checked-v5.6
// ============================================================
// GENESIS AGENT — ToolRegistry.js (v2 — System Tools)
//
// UPGRADE: Added shell execution, file-read/write, and
// structured JSON output parsing for tool calls.
// ============================================================

const { execFile } = require('child_process');
const { TIMEOUTS } = require('../core/Constants');
const { promisify } = require('util');
const execFileAsync = promisify(execFile);
const fs = require('fs');
const path = require('path');

const { robustJsonParse } = require('../core/utils');
const { NullBus } = require('../core/EventBus');
const { createLogger } = require('../core/Logger');
const _log = createLogger('ToolRegistry');

class ToolRegistry {
  /** @param {{ bus?: *, lang?: * }} [config] */
  constructor({ bus, lang } = {}) {
    this.bus = bus || NullBus;
    this.lang = lang || null;
    this.tools = new Map();
    this.callHistory = [];
    this.historyLimit = 200;
    // v5.7.0 SA-P8: Dynamic tool synthesis (late-bound)
    this._toolSynthesis = null;
  }

  register(name, schema, handler, source = 'system') {
    if (this.tools.has(name)) _log.warn(`[TOOLS] Overwriting: ${name}`);
    this.tools.set(name, {
      name, schema, handler, source,
      stats: { calls: 0, errors: 0, avgDuration: 0, lastCall: null },
    });
    this.bus.fire('tools:registered', { name, source, schema }, { source: 'ToolRegistry' });
  }

  unregister(name) {
    const removed = this.tools.delete(name);
    if (removed) this.bus.fire('tools:unregistered', { name }, { source: 'ToolRegistry' });
    return removed;
  }

  hasTool(name) { return this.tools.has(name); }

  async execute(name, input = {}) {
    let tool = this.tools.get(name);
    // FIX v6.1.1: Fallback to skill: prefix (skills registered as "skill:name")
    if (!tool) tool = this.tools.get(`skill:${name}`);
    // v5.7.0 SA-P8: Auto-synthesize missing tools
    if (!tool && this._toolSynthesis) {
      try {
        const result = await this._toolSynthesis.synthesize(
          `A tool called "${name}" that ${name.replace(/-/g, ' ')}s. Infer inputs/outputs from the name.`,
          { name }
        );
        if (result.success) {
          tool = this.tools.get(name);
          _log.info(`[TOOLS] Auto-synthesized "${name}" on first call`);
        }
      } catch (err) { _log.debug(`[TOOLS] Auto-synthesis for "${name}" failed:`, err.message); }
    }
    if (!tool) throw new Error(`Tool not found: ${name}`);
    const startTime = Date.now();
    this.bus.fire('tools:calling', { name, input }, { source: 'ToolRegistry' });
    try {
      const result = await tool.handler(input);
      const duration = Date.now() - startTime;
      tool.stats.calls++;
      tool.stats.avgDuration = (tool.stats.avgDuration * (tool.stats.calls - 1) + duration) / tool.stats.calls;
      tool.stats.lastCall = new Date().toISOString();
      this._recordCall(name, input, result, duration, null);
      this.bus.fire('tools:result', { name, duration, success: true }, { source: 'ToolRegistry' });
      return result;
    } catch (err) {
      tool.stats.errors++;
      this._recordCall(name, input, null, Date.now() - startTime, err.message);
      this.bus.fire('tools:error', { name, error: err.message }, { source: 'ToolRegistry' });
      throw err;
    }
  }

  /**
   * Execute a single tool by name (alias for execute).
   * Used by NativeToolUse for native function calling.
   * FIX v3.5.0: Method was missing — NativeToolUse crashed on every tool call.
   */
  executeSingleTool(name, input = {}) {
    return this.execute(name, input);
  }

  /**
   * Get the schema/definition for a tool by name.
   * Used by NativeToolUse to build API-compatible tool schemas.
   * FIX v3.5.0: Method was missing — NativeToolUse couldn't build tool schemas.
   */
  getToolDefinition(name) {
    const tool = this.tools.get(name);
    return tool ? tool.schema : null;
  }

  listTools() {
    return [...this.tools.values()].map(t => ({
      name: t.name, description: t.schema.description,
      input: t.schema.input, output: t.schema.output,
      source: t.source, stats: { ...t.stats },
    }));
  }

  generateToolPrompt() {
    if (this.tools.size === 0) return '';
    const isDE = this.lang && this.lang.current === 'de';
    const noParams = isDE ? '(keine Parameter)' : '(no parameters)';
    const descLabel = isDE ? 'Beschreibung' : 'Description';

    const descriptions = [];
    for (const [name, tool] of this.tools) {
      const inputParams = tool.schema.input
        ? Object.entries(tool.schema.input).map(([k, v]) => `    ${k}: ${v}`).join('\n')
        : `    ${noParams}`;
      descriptions.push(`TOOL: ${name}\n  ${descLabel}: ${tool.schema.description}\n  Input:\n${inputParams}`);
    }

    const intro = isDE
      ? 'Du hast Zugang zu folgenden Tools. Um ein Tool zu benutzen, antworte mit:'
      : 'You have access to the following tools. To use a tool, respond with:';
    const header = isDE ? 'VERFUEGBARE TOOLS:' : 'AVAILABLE TOOLS:';

    return `${intro}
<tool_call>
{"name": "tool-name", "input": {"param": "value"}}
</tool_call>

${header}
${descriptions.join('\n\n')}`;
  }

  parseToolCalls(response) {
    const toolCalls = [];
    const regex = /<tool_call>\s*(\{[\s\S]*?\})\s*<\/tool_call>/g;
    let match;
    while ((match = regex.exec(response))) {
      try {
        const parsed = this._robustJsonParse(match[1]);
        if (parsed?.name) toolCalls.push({ name: parsed.name, input: parsed.input || {} });
      } catch (err) { /* skip invalid */ }
    }
    const text = response.replace(/<tool_call>[\s\S]*?<\/tool_call>/g, '').trim();
    return { text, toolCalls };
  }

  /** FIX v3.5.0: Delegates to shared utility (was duplicated in ModelBridge) */
  _robustJsonParse(str) {
    return robustJsonParse(str);
  }

  async executeToolCalls(toolCalls) {
    const results = [];
    for (const call of toolCalls) {
      try {
        const result = await this.execute(call.name, call.input);
        results.push({ name: call.name, success: true, result });
      } catch (err) {
        results.push({ name: call.name, success: false, error: err.message });
      }
    }
    return results;
  }

  // ── Built-in Tool Registration ────────────────────────────

  registerBuiltins({ sandbox, selfModel, skills, memory, reflector }) {
    // Sandbox execution
    if (sandbox) {
      this.register('execute-code', {
        description: 'Fuehrt JavaScript-Code in einer sicheren Sandbox aus',
        input: { code: 'string' },
        output: { output: 'string', error: 'string|null', duration: 'number' },
      }, (input) => sandbox.execute(input.code), 'builtin');

      this.register('syntax-check', {
        description: 'Check JavaScript code for syntax errors',
        input: { code: 'string' },
        output: { valid: 'boolean', error: 'string|null' },
      }, (input) => sandbox.syntaxCheck(input.code), 'builtin');
    }

    // Self-Model introspection
    if (selfModel) {
      this.register('self-inspect', {
        description: 'Shows a compact overview of own architecture',
        input: {},
        output: { identity: 'string', capabilities: 'array', stats: 'object' },
      }, () => {
        const modules = selfModel.getModuleSummary();
        const caps = selfModel.getCapabilities();
        const model = selfModel.getFullModel();
        return {
          identity: `Genesis v${model.version || '4.10.0'}`,
          capabilities: caps,
          moduleCount: modules.length,
          fileCount: Object.keys(model.files || {}).length,
          bootPhases: 12,
          // Only include top-level architecture categories, not individual modules
          architecture: {
            core: modules.filter(m => m.file.includes('/core/')).length,
            foundation: modules.filter(m => m.file.includes('/foundation/')).length,
            intelligence: modules.filter(m => m.file.includes('/intelligence/')).length,
            capabilities: modules.filter(m => m.file.includes('/capabilities/')).length,
            planning: modules.filter(m => m.file.includes('/planning/')).length,
            cognitive: modules.filter(m => m.file.includes('/cognitive/')).length,
            organism: modules.filter(m => m.file.includes('/organism/')).length,
            revolution: modules.filter(m => m.file.includes('/revolution/')).length,
            hexagonal: modules.filter(m => m.file.includes('/hexagonal/')).length,
            autonomy: modules.filter(m => m.file.includes('/autonomy/')).length,
            ui: modules.filter(m => m.file.includes('/ui/')).length,
          },
        };
      }, 'builtin');

      this.register('read-own-code', {
        description: 'Read the source code of an own module file',
        input: { file: 'string' },
        output: { code: 'string' },
      }, (input) => ({ code: selfModel.readModule(input.file) || `Not found: ${input.file}` }), 'builtin');
    }

    // Memory
    if (memory) {
      this.register('recall-memory', {
        description: 'Recall past conversations and facts from memory',
        input: { query: 'string' },
        output: { episodes: 'array', facts: 'array' },
      }, (input) => ({
        episodes: memory.recallEpisodes(input.query, 3),
        facts: memory.searchFacts(input.query),
      }), 'builtin');

      this.register('learn-fact', {
        description: 'Store a learned fact in long-term memory',
        input: { key: 'string', value: 'string', confidence: 'number' },
        output: { stored: 'boolean' },
      }, (input) => ({ stored: memory.learnFact(input.key, input.value, input.confidence || 0.8, 'agent') }), 'builtin');
    }

    // Skills as tools
    if (skills) {
      for (const skill of skills.listSkills()) {
        this.register(`skill:${skill.name}`, {
          description: skill.description,
          input: skill.interface?.input || {},
          output: skill.interface?.output || {},
        }, (input) => skills.executeSkill(skill.name, input), 'skill');
      }
    }

    // Health
    if (reflector) {
      this.register('diagnose', {
        description: 'Self-diagnosis: check all modules for errors',
        input: {},
        output: { issues: 'array', scannedModules: 'number' },
      }, () => reflector.diagnose(), 'builtin');
    }

    _log.info(`[TOOLS] ${this.tools.size} tools registered`);
  }

  // ── NEW: System Tools (Shell, Filesystem) ─────────────────

  registerSystemTools(rootDir, guard) {
    // Shell execution (restricted)
    this.register('shell', {
      description: 'Execute a shell command (read operations: ls, cat, find, git, node, npm, etc.)',
      input: { command: 'string', cwd: 'string?' },
      output: { stdout: 'string', stderr: 'string', exitCode: 'number' },
    // FIX v4.0.1: async execFile — no longer blocks main thread.
    // Shell tool intentionally uses shell: true (user requests shell commands),
    // but now async so it doesn't freeze the UI.
    }, async (input) => {
      const cmd = input.command || '';
      // FIX v3.5.0: Hardened blocklist — catches split flags, find -delete, chmod, wget|bash etc.
      const blocked = /\b(rm\s+(-\w+\s+)*-\w*[rf]|mkfs|dd\s+if|format\s+|del\s+\/|shutdown|reboot|kill\s+-9|>\s*\/|curl.*\|.*(?:sh|bash)|wget.*\|.*(?:sh|bash)|find\s+.*-(?:delete|exec\s+rm)|chmod\s+[0-7]{3,4}\s+\/|chown\s+.*\/|mv\s+.*\s+\/(?:dev|proc|sys|boot)|truncate|shred|wipefs|fdisk|parted|crontab\s+-r|iptables\s+-F|systemctl\s+(?:stop|disable)|net\s+stop)\b/i;
      if (blocked.test(cmd)) {
        return { stdout: '', stderr: '[SAFEGUARD] Command blocked: potentially destructive', exitCode: 1 };
      }
      try {
        const cwd = input.cwd ? path.resolve(rootDir, input.cwd) : rootDir;
        const isWin = process.platform === 'win32';
        const shell = isWin ? 'cmd.exe' : '/bin/sh';
        const shellFlag = isWin ? '/c' : '-c';
        const { stdout } = await execFileAsync(shell, [shellFlag, cmd], {
          cwd, encoding: 'utf-8', timeout: TIMEOUTS.SANDBOX_EXEC, maxBuffer: 512 * 1024,
          windowsHide: true,
        });
        return { stdout: stdout.slice(0, 10000), stderr: '', exitCode: 0 };
      } catch (err) {
        return { stdout: err.stdout?.slice(0, 5000) || '', stderr: err.stderr?.slice(0, 2000) || err.message, exitCode: err.status || 1 };
      }
    }, 'system');

    // File read (restricted to project root + user-specified paths, blocks sensitive dirs)
    this.register('file-read', {
      description: 'Read a file from the filesystem (text, project scope or non-sensitive paths only)',
      input: { path: 'string', maxBytes: 'number?' },
      output: { content: 'string', size: 'number', exists: 'boolean' },
    }, (input) => {
      const filePath = path.resolve(rootDir, input.path);
      // Block sensitive directories — but always allow reads within rootDir (project scope)
      // FIX v5.1.0: On Windows, os.tmpdir() is under AppData\Local\Temp which
      // the old regex blocked. rootDir paths are always safe — they ARE the project.
      const inProject = filePath.startsWith(path.resolve(rootDir) + path.sep) || filePath === path.resolve(rootDir);
      if (!inProject) {
        const blocked = /[/\\](?:\.ssh|\.gnupg|\.aws|\.config|\.env|\.git[/\\]|node_modules[/\\]\.cache|AppData[/\\]|\.mozilla|\.chrome)/i;
        if (blocked.test(filePath)) {
          return { content: '', size: 0, exists: false, error: '[SAFEGUARD] Read access to sensitive path blocked' };
        }
      }
      if (!fs.existsSync(filePath)) return { content: '', size: 0, exists: false };
      const stat = fs.statSync(filePath);
      if (stat.isDirectory()) return { content: '', size: 0, exists: true, error: 'Path is a directory' };
      const maxBytes = input.maxBytes || 100000;
      const content = fs.readFileSync(filePath, 'utf-8').slice(0, maxBytes);
      return { content, size: stat.size, exists: true };
    }, 'system');

    // FIX v6.1.1: Open file in the Genesis editor panel
    this.register('open-in-editor', {
      description: 'Open a file in the Genesis code editor for viewing and editing',
      input: { path: 'string' },
      output: { opened: 'boolean' },
    }, (input) => {
      const filePath = path.resolve(rootDir, input.path);
      if (!fs.existsSync(filePath)) return { opened: false, error: 'File not found' };
      if (fs.statSync(filePath).isDirectory()) return { opened: false, error: 'Path is a directory' };
      const content = fs.readFileSync(filePath, 'utf-8').slice(0, 200000);
      const ext = path.extname(filePath).slice(1);
      const langMap = { js: 'javascript', ts: 'typescript', py: 'python', json: 'json', html: 'html', css: 'css', md: 'markdown' };
      this.bus.emit('editor:open', { content, language: langMap[ext] || 'plaintext', filename: input.path }, { source: 'ToolRegistry' });
      return { opened: true, filename: input.path };
    }, 'system');

    // File write (only in project or designated dirs)
    this.register('file-write', {
      description: 'Write content to a file (project scope only)',
      input: { path: 'string', content: 'string' },
      output: { ok: 'boolean', error: 'string?' },
    }, async (input) => {
      try {
        const filePath = path.resolve(rootDir, input.path);
        guard.validateWrite(filePath);
        const dir = path.dirname(filePath);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        // FIX v4.10.0: Async atomic write
        const { atomicWriteFile } = require('../core/utils');
        await atomicWriteFile(filePath, input.content, 'utf-8');
        return { ok: true };
      } catch (err) {
        return { ok: false, error: err.message };
      }
    }, 'system');

    // File list
    this.register('file-list', {
      description: 'List files in a directory',
      input: { dir: 'string?', pattern: 'string?' },
      output: { files: 'array' },
    }, (input) => {
      const dir = path.resolve(rootDir, input.dir || '.');
      if (!fs.existsSync(dir)) return { files: [] };
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      const files = entries.map(e => ({
        name: e.name, isDir: e.isDirectory(),
        size: e.isFile() ? fs.statSync(path.join(dir, e.name)).size : 0,
      }));
      if (input.pattern) {
        // FIX v4.12.3 (S-02): Validate and limit user-supplied regex to prevent ReDoS.
        if (typeof input.pattern !== 'string' || input.pattern.length > 200) {
          return { files: [], error: 'Pattern too long or invalid (max 200 chars)' };
        }
        try {
          const regex = new RegExp(input.pattern, 'i');
          return { files: files.filter(f => regex.test(f.name)) };
        } catch (regexErr) {
          return { files: [], error: `Invalid regex pattern: ${regexErr.message}` };
        }
      }
      return { files };
    }, 'system');

    // Git operations
    this.register('git-log', {
      description: 'Show recent git commits',
      input: { count: 'number?' },
      output: { commits: 'string' },
    // FIX v4.0.1: async execFileAsync with array args — no shell, no main-thread block
    }, async (input) => {
      try {
        const n = Math.min(input.count || 10, 50);
        const { stdout } = await execFileAsync('git', ['log', '--oneline', `-${n}`], { cwd: rootDir, encoding: 'utf-8', timeout: TIMEOUTS.GIT_OP, windowsHide: true });
        return { commits: stdout.trim() };
      } catch (err) {
        return { commits: 'Git not available: ' + err.message };
      }
    }, 'system');

    this.register('git-diff', {
      description: 'Show current changes (git diff)',
      input: { file: 'string?' },
      output: { diff: 'string' },
    // FIX v4.0.1: async execFileAsync with array args — no shell injection via file paths
    }, async (input) => {
      try {
        const args = input.file ? ['diff', '--', input.file] : ['diff', '--stat'];
        const { stdout } = await execFileAsync('git', args, { cwd: rootDir, encoding: 'utf-8', timeout: TIMEOUTS.GIT_OP, windowsHide: true });
        return { diff: (stdout || '').slice(0, 10000) || '(no changes)' };
      } catch (err) {
        return { diff: 'Git not available: ' + err.message };
      }
    }, 'system');

    _log.info(`[TOOLS] System tools registered (shell, file-read, file-write, file-list, git-log, git-diff)`);
  }

  getHistory(limit = 50) { return this.callHistory.slice(-limit); }

  getStats() {
    const stats = {};
    for (const [name, tool] of this.tools) stats[name] = { ...tool.stats };
    return stats;
  }

  _recordCall(name, input, result, duration, error) {
    this.callHistory.push({
      name, input: JSON.stringify(input).slice(0, 200),
      result: result ? JSON.stringify(result).slice(0, 200) : null,
      error, duration, timestamp: new Date().toISOString(),
    });
    if (this.callHistory.length > this.historyLimit) this.callHistory = this.callHistory.slice(-this.historyLimit);
  }
}

module.exports = { ToolRegistry };
