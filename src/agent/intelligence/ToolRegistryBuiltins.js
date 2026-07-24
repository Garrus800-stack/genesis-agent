// ============================================================
// GENESIS — src/agent/intelligence/ToolRegistryBuiltins.js
//
// v7.9.29 (hygiene): the built-in + system tool DEFINITIONS
// (registerBuiltins, registerSystemTools), extracted from ToolRegistry to
// keep it under the 700-LOC guard. Parser/execution stays in ToolRegistry.
// Methods copied onto ToolRegistry.prototype via the mixin. this.* only;
// no behaviour change. Module utilities mirrored from ToolRegistry.
// ============================================================

const { execFile } = require('child_process');
const { promisify } = require('util');
const execFileAsync = promisify(execFile);
const { TIMEOUTS } = require('../core/Constants');
const fs = require('fs');
const path = require('path');
const { _resolveFileWithVariants } = require('../foundation/SelfModelSourceRead');
const { decodeWinConsole } = require('../core/shell/WinConsoleEncoding');
const { adaptCommand } = require('../core/shell/ShellOSAdapter');
const { createLogger } = require('../core/Logger');
const _log = createLogger('ToolRegistry');

class _ToolRegistryBuiltinsHost {
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
        // v7.9.28: adapt the command for the host OS before running. The model
        // emits Unix commands (cat/ls/grep + forward-slash paths) by default;
        // on Windows cmd.exe those fail ("cat" is not a command), so the model
        // wrongly concludes files don't exist and loops. adaptCommand rewrites
        // cat→type, grep→findstr, /path→\path, etc., and is a no-op on Linux
        // and when real Unix tools are on PATH (Git for Windows). The raw
        // blocklist above already ran, so destructive commands are still caught.
        const runCmd = adaptCommand(cmd, process.platform);
        const shell = isWin ? (process.env.ComSpec || 'cmd.exe') : '/bin/sh'; // v7.9.37 pass 5 (T1)
        const shellFlag = isWin ? '/c' : '-c';
        // v7.9.11: read raw buffer on Win, decode with detected codepage.
        // Pre-fix `encoding: 'utf-8'` mistook cp850/cp1252 bytes for UTF-8
        // → U+FFFD replacement noise in DE-Win cmd.exe output ("f�r
        // Datentr�ger"). Linux/Mac unchanged.
        const { stdout } = await execFileAsync(shell, [shellFlag, runCmd], {
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
      if (!r.ok) {
        // v7.9.45 field: a small model reaching for the project reader with an
        // Archive-relative path gets pointed at the right hand instead of a
        // dead end.
        let _err = r.error;
        if (/^(inbox|projects)\//i.test(String(input && input.path || ''))) _err = _err + ' — Hinweis: Pfade wie inbox/… liegen im Genesis Archive; nutze read-archive-file.';
        return { content: '', size: 0, exists: false, error: _err };
      }
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
      // v7.9.37 (R2): provenance head — the chat brain must SEE that a real read
      // happened (field 11.07.: reads via the file-read tool carried no 📄 marker).
      return { content: `📄 ${require('path').basename(filePath)} gelesen (${String(content).split('\n').length} Zeilen) —\n${content}`, size: stat.size, exists: true };
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
      output: { ok: 'boolean', error: 'string?', warning: 'string?' },
    }, async (input) => {
      try {
        const filePath = path.resolve(rootDir, input.path);
        guard.validateWrite(filePath);
        const dir = path.dirname(filePath);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        // FIX v4.10.0: Async atomic write
        const { atomicWriteFile } = require('../core/utils');
        await atomicWriteFile(filePath, input.content, 'utf-8');
        // v7.9.44 r16: safety net — mirrors the v737 _syntaxNet (kept local so the
        // builtin layer does not reach into cognitive). Written ALWAYS; a broken
        // .js/.json is reported honestly via `warning`, never blocked — a
        // multi-step rewrite may be legitimately broken in between.
        try {
          if (/\.(js|mjs|cjs)$/i.test(filePath) && input.content.length <= 1024 * 1024) {
            new (require('vm').Script)(input.content, { filename: filePath });
          } else if (/\.json$/i.test(filePath) && input.content.length <= 1024 * 1024) {
            JSON.parse(input.content);
          }
        } catch (synErr) {
          return { ok: true, warning: 'Geschrieben, aber die Datei ist syntaktisch gebrochen: ' + String(synErr.message || synErr).split('\n')[0].slice(0, 200) };
        }
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
}

const toolRegistryBuiltinsMixin = {};
for (const name of Object.getOwnPropertyNames(_ToolRegistryBuiltinsHost.prototype)) {
  if (name !== 'constructor') toolRegistryBuiltinsMixin[name] = _ToolRegistryBuiltinsHost.prototype[name];
}

module.exports = { toolRegistryBuiltinsMixin };
