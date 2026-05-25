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
// v7.5.9 live-fix: filename-variant resolution for file-read tool. Shared
// helper from SelfModelSourceRead so the LLM's tool-call gets the same
// readme→README.md / ontogenesis→docs/ONTOGENESIS.md resolution that the
// internal _maybeReadSourceSync already gets.
const { _resolveFileWithVariants } = require('../foundation/SelfModelSourceRead');
// v7.9.11: Win console codepage handling for shell/git output decoding
const { decodeWinConsole } = require('../core/shell/WinConsoleEncoding');
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
    // v7.5.9 ZIP2 v3 (Bug 4): late-bound trust + settings so file-read /
    // file-list can use the 3-tier sandbox. Keep null when unwired —
    // _resolveProjectPath then falls back to default trust=1.
    this._trustLevelSystem = null;
    this._settings = null;
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

  /**
   * v7.9.4: Re-register all skill:* tools from SkillManager. Called by
   * SkillPromotionEvaluator after promotion so newly-loaded skills become
   * callable as tools without restart. Idempotent.
   */
  refreshSkills(skillManager) {
    if (!skillManager || typeof skillManager.listSkills !== 'function') return;
    const toRemove = [...this.tools.keys()].filter(n => n.startsWith('skill:'));
    for (const name of toRemove) this.tools.delete(name);
    let count = 0;
    try {
      for (const skill of skillManager.listSkills()) {
        this.register(`skill:${skill.name}`, {
          description: skill.description,
          input: skill.interface?.input || {},
          output: skill.interface?.output || {},
        }, (input) => skillManager.executeSkill(skill.name, input), 'skill');
        count++;
      }
    } catch (err) {
      _log.warn(`[TOOLS] refreshSkills failed: ${err.message}`);
    }
    _log.info(`[TOOLS] refreshSkills: ${toRemove.length} removed, ${count} registered`);
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
    let text = response;

    // Format 1: <tool_call>{...}</tool_call> (canonical)
    const tagRegex = /<tool_call>\s*(\{[\s\S]*?\})\s*<\/tool_call>/g;
    let match;
    while ((match = tagRegex.exec(response))) {
      try {
        const parsed = this._robustJsonParse(match[1]);
        if (parsed?.name) toolCalls.push({ name: parsed.name, input: parsed.input || {} });
      } catch (_err) { /* skip invalid */ }
    }
    text = text.replace(/<tool_call>[\s\S]*?<\/tool_call>/g, '');

    // v7.5.9 ZIP1 Phase 0.1: Format 2 — markdown-fence variant.
    // Some models emit ```tool_call ... ``` instead of XML tags.
    // Accept it and convert internally.
    const fenceRegex = /```tool_call\s*\n?([\s\S]*?)```/g;
    while ((match = fenceRegex.exec(response))) {
      try {
        const parsed = this._robustJsonParse(match[1].trim());
        if (parsed?.name) toolCalls.push({ name: parsed.name, input: parsed.input || {} });
      } catch (_err) { /* skip */ }
    }
    text = text.replace(/```tool_call\s*\n?[\s\S]*?```/g, '');

    // v7.5.9 ZIP1 Phase 0.1: Format 3 — bare JSON-fence with registered tool name.
    // Strict: object must have `name` field that matches a registered tool,
    // and `input` field. Anything else (e.g. JSON in a code example) is
    // ignored to prevent false-positives.
    if (toolCalls.length === 0) {
      const jsonFenceRegex = /```(?:json)?\s*\n?(\{[\s\S]*?\})\s*```/g;
      while ((match = jsonFenceRegex.exec(response))) {
        try {
          const parsed = this._robustJsonParse(match[1].trim());
          if (parsed?.name && typeof parsed.name === 'string'
              && this.tools.has(parsed.name)
              && 'input' in parsed) {
            toolCalls.push({ name: parsed.name, input: parsed.input || {} });
            text = text.replace(match[0], '');
          }
        } catch (_err) { /* skip */ }
      }
    }

    return { text: text.trim(), toolCalls };
  }

  /**
   * v7.5.9 ZIP1 Phase 0.2: Detect when LLM said it would use a tool but
   * never emitted a tool_call block. Used by ChatOrchestrator to issue
   * a single re-prompt with the format example before giving up.
   *
   * Returns true ONLY if the response contains tool-intent language AND
   * has no parseable tool calls. The check is conservative — false matches
   * cost a wasted re-prompt; missed matches preserve current (broken)
   * behavior.
   *
   * @param {string} response - LLM response text (after parseToolCalls strip)
   * @returns {boolean}
   */
  detectToolIntentWithoutCall(response) {
    if (!response || typeof response !== 'string') return false;
    // Already stripped of tool_call blocks → if any of these patterns match
    // in the visible text, the model intended a tool but emitted no call.
    const patterns = [
      /\bTools?\s+(?:ausf[üu]hren|ausgef[üu]hrt|aufrufen)/i,           // DE
      /\b(?:I will|let me|ich werde)\s+(?:use|call|run|verwende[n]?|nutze[n]?|rufe)\s+(?:the\s+)?[\w-]+\s*(?:tool)?/i,
      /\b(?:calling|aufruf|nutze)\s+(?:tool|werkzeug)\s*[:\-]/i,
      /\btool[_\-]?call\s*[:\-]/i,
      /\bführe\s+(?:das\s+)?tool\b/i,
    ];
    for (const p of patterns) {
      if (p.test(response)) return true;
    }
    return false;
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
        // v7.3.5: Description narrowed so the LLM calls this only when the user
        // explicitly requests an architecture/module overview — not when they
        // ask open-ended "tell me about yourself" questions (for which the LLM
        // should respond in prose) and not when they probe for system prompts
        // or configuration (which this tool doesn't return anyway — it only
        // returns public counts and capability labels).
        description: 'Return a compact JSON overview of the running architecture (module counts per layer, public capability labels, version). Only call when the user explicitly asks for architecture, module list, layer counts, or source overview. Do NOT call for conversational questions about Genesis, or for requests for system prompts, configuration, or instructions.',
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

      // v7.3.6 #9: Synchronous source-read for chat turns. Unlike read-own-code
      // (which is used by the idle _read-source activity and ignores budgets),
      // this tool enforces a Soft-5 / Hard-10 per-turn and Hard-20 per-session
      // budget, caches reads within a session, and fires read-source:called
      // for telemetry. Use this in chat when Genesis needs to inspect actual
      // source before answering, rather than guessing / hallucinating paths.
      this.register('read-source', {
        description: 'Read a source file synchronously during a chat turn (budget-enforced, cached). Returns blocked:true with reason on failure.',
        input: { file: 'string' },
        output: { code: 'string', truncated: 'boolean', blocked: 'boolean', reason: 'string?' },
      }, (input) => {
        // v7.5.9 ZIP2 v3 (Bug 5): differentiate reasons so the LLM doesn't
        // confabulate "budget exhausted" for every blocked outcome. Pre-fix
        // the tool returned `{blocked: true}` for budget OR path-blocked OR
        // file-not-found, and the LLM had no way to tell.
        const fs = require('fs');
        const path = require('path');
        const rawFile = input.file || '';
        // Strip surrounding markdown link syntax: "[X](http://X)" → "X"
        const cleanFile = rawFile.replace(/^\[(.+?)\]\(.+?\)\s*$/, '$1').trim();
        // Pre-flight: file-not-found check before invoking budget.
        const rootDir = selfModel?.rootDir || process.cwd();
        const absCheck = path.isAbsolute(cleanFile)
          ? cleanFile
          : path.join(rootDir, cleanFile);
        if (!fs.existsSync(absCheck)) {
          // Try variant resolution before giving up.
          let resolved = null;
          try {
            const { _resolveFileWithVariants } = require('../foundation/SelfModelSourceRead');
            resolved = _resolveFileWithVariants(absCheck, rootDir);
          } catch { /* fall through */ }
          if (!resolved) {
            return { code: '', truncated: false, blocked: true, reason: 'not-found' };
          }
        }
        // Budget-pre-check: if at hard cap, return reason explicitly.
        const budget = selfModel?.getReadSourceBudget?.();
        if (budget && (budget.turnCount >= budget.hardPerTurn
                    || budget.sessionCount >= budget.hardPerSession)) {
          return { code: '', truncated: false, blocked: true, reason: 'budget-exhausted' };
        }
        const content = selfModel.readSourceSync(cleanFile, { bus: this.bus });
        if (content === null) {
          // Read returned null AFTER budget pre-check — must be SafeGuard
          // path-blocked or post-resolve file-missing.
          return { code: '', truncated: false, blocked: true, reason: 'path-not-allowed-or-missing' };
        }
        const truncated = /\[\.\.\. truncated,/.test(content);
        return { code: content, truncated, blocked: false };
      }, 'builtin');
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
        // v7.9.11: read raw buffer on Win, decode with detected codepage.
        // Pre-fix `encoding: 'utf-8'` mistook cp850/cp1252 bytes for UTF-8
        // → U+FFFD replacement noise in DE-Win cmd.exe output ("f�r
        // Datentr�ger"). Linux/Mac unchanged.
        const { stdout } = await execFileAsync(shell, [shellFlag, cmd], {
          cwd, encoding: isWin ? 'buffer' : 'utf-8',
          timeout: TIMEOUTS.SANDBOX_EXEC, maxBuffer: 512 * 1024,
          windowsHide: true,
        });
        // Decode BEFORE slice — slicing a Buffer first could cut mid-multibyte
        const stdoutStr = isWin ? decodeWinConsole(stdout) : stdout;
        return { stdout: stdoutStr.slice(0, 10000), stderr: '', exitCode: 0 };
      } catch (err) {
        const isWin = process.platform === 'win32';
        const errStdout = isWin ? decodeWinConsole(err.stdout) : (err.stdout || '');
        const errStderr = isWin ? decodeWinConsole(err.stderr) : (err.stderr || err.message);
        return { stdout: errStdout.slice(0, 5000), stderr: errStderr.slice(0, 2000) || err.message, exitCode: err.status || 1 };
      }
    }, 'system');

    // ── v7.5.1 (K+L fix) + v7.5.9 ZIP2 v3 (Bug 4):
    // Project+user-home scope helper, shared by file-read and file-list.
    //
    // Pre-ZIP2-v3: this was project-only — file-list on the user's
    // Desktop was rejected even at trust level 2+. That broke "liste auf
    // was auf meinem desktop liegt" because file-list-tool answered
    // "outside project root", regardless of trust.
    //
    // Post-ZIP2-v3: scope is project for trust 0, project+user-home for
    // trust 1+. Always-blocked paths (system, secrets) stay blocked at
    // any trust. Mirrors ShellSafety.checkRootDirSandbox semantics so
    // file-list and shell.run agree on what's reachable.
    const Safety = require('../core/shell/ShellSafety');
    const _CRITICAL_PATH_PATTERNS_RAW = [
      // POSIX critical
      '/etc/', '/system/', '/usr/bin/', '/usr/sbin/', '/sbin/',
      '/proc/', '/sys/', '/dev/', '/boot/',
      // Cross-platform secret dirs
      '/.ssh/', '\\.ssh\\', '/.aws/', '\\.aws\\', '/.gnupg/', '\\.gnupg\\',
      // Win critical
      '\\windows\\', '\\appdata\\roaming\\',
    ];
    const _resolveProjectPath = (relOrAbs, intent = 'read') => {
      const projectRoot = path.resolve(rootDir);
      // v7.5.9 Linux-fix: expand leading "~" / "~/" to user home BEFORE
      // path.resolve. Pre-fix the LLM could call file-read({ path: "~/foo" })
      // and path.resolve would treat "~" as a literal directory under rootDir,
      // producing nonsense paths and "file does not exist" errors.
      let expanded = relOrAbs || '';
      if (typeof expanded === 'string' && (expanded === '~' || expanded.startsWith('~/') || expanded.startsWith('~\\'))) {
        const home = require('os').homedir();
        expanded = path.join(home, expanded.slice(2) || '');
      }
      const abs = path.resolve(rootDir, expanded);
      const inProject = abs === projectRoot || abs.startsWith(projectRoot + path.sep);
      // In-project secret-file blacklist. Match basename only — files like
      // src/config/env-helper.js or main.key-handler.js stay readable.
      const base = path.basename(abs);
      if (/^\.env(\..+)?$/i.test(base) || /\.(pem|key)$/i.test(base)) {
        return { ok: false, error: '[SAFEGUARD] Secret file blocked: ' + base };
      }
      // v7.5.9 ZIP2 v4 (Bug B): even if the resolved path lands in-project
      // (or in user-home), reject if the RAW input contains a critical
      // system pattern. Catches:
      //   "/etc/passwd"               — direct
      //   "../../../etc/passwd"       — traversal that lands somewhere
      //                                 user-home-accessible on Win
      //   "C:\\Windows\\System32\\.." — direct critical
      // Raw-string match is intentional (not resolved): the user's intent
      // was clearly to reference the system path, regardless of whether
      // the FS resolves it that way.
      // v7.5.9 ZIP2 v5 (Bug B-fix #2): match raw pattern as substring OR
      // at end-of-string. The previous version required the trailing slash
      // for substring match — '../../etc' (no trailing /) slipped through
      // because rawLower.includes('/etc/') was false. Now we also match
      // when the path ENDS with the pattern minus trailing slash.
      const rawLower = (relOrAbs || '').toLowerCase();
      for (const pat of _CRITICAL_PATH_PATTERNS_RAW) {
        const patNoSlash = pat.replace(/[\\/]$/, '');
        if (rawLower.includes(pat) || rawLower.endsWith(patNoSlash) || rawLower === patNoSlash) {
          return {
            ok: false,
            error: '[SAFEGUARD] Path contains a critical system pattern (' + pat + ') and is blocked.',
          };
        }
      }
      if (inProject) return { ok: true, abs };

      // Outside project — gate via 3-tier sandbox so file-list/file-read
      // can reach Desktop/Documents at trust 1+ (read) / trust 2+ (write).
      // Synthesize a shell-style command to reuse the same helpers.
      const fakeCmd = (intent === 'write' ? 'rm "' : 'ls "') + abs + '"';
      const trustLevel = (typeof this._trustLevelSystem?.getLevel === 'function')
        ? this._trustLevelSystem.getLevel()
        : 1;
      const sandboxCheck = Safety.checkRootDirSandbox(fakeCmd, rootDir, {
        platform: process.platform,
        trustLevel,
        settings: this._settings,
      });
      if (!sandboxCheck.ok) {
        return {
          ok: false,
          error: '[SAFEGUARD] ' + (sandboxCheck.reason || 'path blocked by sandbox'),
        };
      }
      return { ok: true, abs };
    };

    // File read (project scope only, with secret-file blacklist)
    this.register('file-read', {
      description: 'Read a file from the filesystem (project scope only). Files outside the project root and secret files (.env, .pem, .key) are blocked.',
      input: { path: 'string', maxBytes: 'number?' },
      output: { content: 'string', size: 'number', exists: 'boolean' },
    }, (input) => {
      const r = _resolveProjectPath(input.path);
      if (!r.ok) return { content: '', size: 0, exists: false, error: r.error };
      let filePath = r.abs;
      // v7.5.9 live-fix: filename-variant resolution. Pre-fix the LLM
      // could call file-read({ path: 'readme' }) and get exists:false,
      // even though README.md exists — because the literal lookup
      // fails. SelfModelSourceRead has _resolveFileWithVariants for
      // its own internal reads (v7.5.8), but tool-calls go through
      // here. Same five-step strategy:
      //   (1) common-extension append
      //   (2) case-insensitive exact
      //   (3) case-insensitive base any-extension
      //   (4) fuzzy Levenshtein ≤ 1 (single candidate only)
      //   (5) well-known docs/ retry for doc-like base-names
      if (!fs.existsSync(filePath)) {
        const resolved = _resolveFileWithVariants(filePath, rootDir);
        if (resolved) {
          // Re-run the project-scope check on the resolved path so a
          // Levenshtein hit can't escape the safeguard.
          const r2 = _resolveProjectPath(path.relative(rootDir, resolved));
          if (r2.ok) filePath = r2.abs;
          else return { content: '', size: 0, exists: false, error: r2.error };
        } else {
          return { content: '', size: 0, exists: false };
        }
      }
      const stat = fs.statSync(filePath);
      if (stat.isDirectory()) return { content: '', size: 0, exists: true, error: 'Path is a directory' };
      const maxBytes = input.maxBytes || 100000;
      const content = fs.readFileSync(filePath, 'utf-8').slice(0, maxBytes);
      return { content, size: stat.size, exists: true };
    }, 'system');

    // FIX v6.1.1: Open file in the Genesis editor panel
    // v7.5.1.x: migrated to _resolveProjectPath helper to close the
    // path-traversal gap that was already fixed in file-read / file-list.
    // Without this guard, open-in-editor({path:'/etc/passwd'}) would
    // resolve absolute, read 200KB and emit them onto the editor:open
    // channel — same bug class as the v7.5.1 file-read fix.
    this.register('open-in-editor', {
      description: 'Open a file in the Genesis code editor for viewing and editing (project scope only).',
      input: { path: 'string' },
      output: { opened: 'boolean' },
    }, (input) => {
      const r = _resolveProjectPath(input.path);
      if (!r.ok) return { opened: false, error: r.error };
      const filePath = r.abs;
      if (!fs.existsSync(filePath)) return { opened: false, error: 'File not found' };
      if (fs.statSync(filePath).isDirectory()) return { opened: false, error: 'Path is a directory' };
      const content = fs.readFileSync(filePath, 'utf-8').slice(0, 200000);
      const ext = path.extname(filePath).slice(1);
      const langMap = { js: 'javascript', ts: 'typescript', py: 'python', json: 'json', html: 'html', css: 'css', md: 'markdown' };
      this.bus.fire('editor:open', { content, language: langMap[ext] || 'plaintext', filename: input.path }, { source: 'ToolRegistry' });
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

    // File list (v7.5.1 fix: project scope only via shared helper)
    this.register('file-list', {
      description: 'List files in a directory (project scope only). Directories outside the project root are blocked.',
      input: { dir: 'string?', pattern: 'string?' },
      output: { files: 'array' },
    }, (input) => {
      const r = _resolveProjectPath(input.dir || '.');
      if (!r.ok) return { files: [], error: r.error };
      const dir = r.abs;
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

    // v7.9.5: shared preflight — saves users the raw `fatal: not a git repository`
    // surface when running Genesis from a ZIP install without git.
    const _gitAvailable = () => {
      try {
        const fs = require('fs');
        const path = require('path');
        return fs.existsSync(path.join(rootDir, '.git'));
      } catch { return false; }
    };

    // Git operations
    this.register('git-log', {
      description: 'Show recent git commits',
      input: { count: 'number?' },
      output: { commits: 'string' },
    // FIX v4.0.1: async execFileAsync with array args — no shell, no main-thread block
    }, async (input) => {
      if (!_gitAvailable()) return { commits: '(no git repository in this installation)' };
      try {
        const n = Math.min(input.count || 10, 50);
        const isWin = process.platform === 'win32';
        const { stdout } = await execFileAsync('git', ['log', '--oneline', `-${n}`], {
          cwd: rootDir, encoding: isWin ? 'buffer' : 'utf-8',
          timeout: TIMEOUTS.GIT_OP, windowsHide: true,
        });
        const stdoutStr = isWin ? decodeWinConsole(stdout) : stdout;
        return { commits: stdoutStr.trim() };
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
      if (!_gitAvailable()) return { diff: '(no git repository in this installation)' };
      try {
        const args = input.file ? ['diff', '--', input.file] : ['diff', '--stat'];
        const isWin = process.platform === 'win32';
        const { stdout } = await execFileAsync('git', args, {
          cwd: rootDir, encoding: isWin ? 'buffer' : 'utf-8',
          timeout: TIMEOUTS.GIT_OP, windowsHide: true,
        });
        const stdoutStr = isWin ? decodeWinConsole(stdout) : stdout;
        return { diff: (stdoutStr || '').slice(0, 10000) || '(no changes)' };
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
