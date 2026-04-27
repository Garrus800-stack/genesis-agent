// @ts-checked-v5.8
// ============================================================
// GENESIS — ShellAgent.js
// Smart shell execution. NOT a dumb command runner.
//
// What makes this different from Open Interpreter:
// 1. PROJECT AWARENESS — scans directory, detects project type,
//    knows which commands make sense in context
// 2. LEARNING — every command feeds Memory + KnowledgeGraph
// 3. PLANNING — complex tasks decomposed by LLM into steps
// 4. TIERED SAFETY — observe < read < write < system
// 5. OS ADAPTATION — auto-detects Windows/Linux, translates
// ============================================================

const { exec, execFile, spawn } = require('child_process');
const { promisify } = require('util');
const execFileAsync = promisify(execFile);
// v7.4.6.fix #30: execAsync passes the command verbatim to the OS shell
// (no Node.js → cmd.exe quote-mangling). Used for the shellMeta/Windows
// branch where pipes, redirects, and embedded quotes must survive intact.
const execAsync = promisify(exec);
const fs = require('fs');
const path = require('path');
const { NullBus } = require('../core/EventBus');
const { SHELL: SHELL_LIMITS, TIMEOUTS, THRESHOLDS } = require('../core/Constants');
const { buildOsContext } = require('../core/EnvironmentContext');
const { safeJsonParse } = require('../core/utils');
const { createLogger } = require('../core/Logger');
const _log = createLogger('ShellAgent');
class ShellAgent {
  constructor({ lang, bus,  model, memory, knowledgeGraph, eventStore, sandbox, guard, rootDir}) {
    this.lang = lang || { t: (k) => k, detect: () => {}, current: 'en' };
    this.bus = bus || NullBus;
    this.model = model;
    this.memory = memory;
    this.kg = knowledgeGraph;
    this.eventStore = eventStore;
    this.sandbox = sandbox;
    this.guard = guard;
    this.rootDir = rootDir;

    this.isWindows = process.platform === 'win32';
    this.shell = this.isWindows ? 'cmd.exe' : '/bin/sh';
    this.shellFlag = this.isWindows ? '/c' : '-c';

    // FIX v4.0.0: Default to 'read' — autonomous operations must explicitly
    // escalate to 'write' via setPermissionLevel(). Prevents accidental
    // destructive operations during AgentLoop/IdleMind autonomous runs.
    this.permissionLevel = 'read';

    this.history = [];
    this.maxHistory = 200;

    // FIX v3.5.0: Hardened blocklist — covers alias/symlink/obfuscation bypasses
    // Each tier is tested against the FULL command after _adaptCommand().
    // 'observe' = NO shell access (matches everything → all commands blocked).
    // 'read' blocks destructive ops. 'write' allows them but blocks system-level.
    this.blockedPatterns = {
      observe: /./, // Intentional: observe tier has no shell access — blocks ALL commands
      read: /\b(rm|del|mv|move|cp|copy|mkdir|rmdir|chmod|chown|kill|shutdown|reboot|mkfs|dd\s+if|format|>\s)/i,
      write: new RegExp([
        // Direct system destruction
        /rm\s+-rf\s+\//.source,
        /mkfs/.source,
        /dd\s+if=\/dev/.source,
        /format\s+[a-z]:/.source,
        /shutdown/.source,
        /reboot/.source,
        /kill\s+-9\s+1\b/.source,
        />\s*\/dev/.source,
        // FIX v3.5.0: Bypass vectors via encoding/aliasing
        /\\x[0-9a-f]{2}/i.source,           // hex-encoded chars in commands
        /\$\(.*\b(rm|dd|mkfs|kill)\b/.source, // command substitution wrapping destructive ops
        /`.*\b(rm|dd|mkfs|kill)\b/.source,    // backtick command substitution
        /\|\s*(ba)?sh\b/.source,              // piping to shell (curl|sh, wget|bash)
        /\bsource\s/.source,                 // sourcing unknown scripts
        /\b\.\s+\//.source,                  // dot-sourcing (. /path/script)
        /\bpython\d?\s+-c\s/.source,         // python -c "arbitrary code"
        /\bnode\s+-e\s/.source,              // node -e "arbitrary code"
        /\bperl\s+-e\s/.source,              // perl -e "arbitrary code"
        /\bruby\s+-e\s/.source,              // ruby -e "arbitrary code"
        /\bcurl\s.*\|\s/.source,             // curl piped to anything
        /\bwget\s.*\|\s/.source,             // wget piped to anything
        /\bchmod\s+[0-7]*[67][0-7]{2}/.source, // chmod with setuid/setgid bits
        /\bcrontab\b/.source,                // crontab manipulation
        /\bsymlink|ln\s+-s/.source,          // symlink creation (can bypass SafeGuard paths)
        /\bmkfifo\b/.source,                 // named pipes (can be used for injection)
        /\biptables\b/.source,               // firewall manipulation
        /\bsystemctl\s+(stop|disable|mask)/.source, // service disruption
        /\bpkill\s/.source,                  // process kill by name
        /\bkillall\s/.source,                // mass process kill
      ].join('|'), 'i'),
      system: /\b(mkfs|dd\s+if=\/dev\/zero|format\s+[a-z]:.*\/[qy])\b/i,
    };

    this.projectSignatures = {
      node:    { files: ['package.json'], cmds: { install: 'npm install', test: 'npm test', start: 'npm start', build: 'npm run build' } },
      python:  { files: ['setup.py', 'pyproject.toml', 'requirements.txt'], cmds: { install: 'pip install -r requirements.txt', test: 'pytest', start: 'python main.py' } },
      rust:    { files: ['Cargo.toml'], cmds: { install: 'cargo build', test: 'cargo test', start: 'cargo run', build: 'cargo build --release' } },
      go:      { files: ['go.mod'], cmds: { install: 'go mod download', test: 'go test ./...', start: 'go run .', build: 'go build' } },
      dotnet:  { files: ['*.csproj', '*.sln'], cmds: { install: 'dotnet restore', test: 'dotnet test', start: 'dotnet run', build: 'dotnet build' } },
      java:    { files: ['pom.xml', 'build.gradle'], cmds: { install: 'mvn install', test: 'mvn test', build: 'mvn package' } },
      docker:  { files: ['Dockerfile', 'docker-compose.yml'], cmds: { build: 'docker build .', start: 'docker-compose up' } },
      make:    { files: ['Makefile'], cmds: { build: 'make', test: 'make test', clean: 'make clean' } },
    };

    this._projectCache = new Map();

    // v3.5.0: Per-tier rolling-window rate limiter
    // Prevents runaway autonomous loops from flooding the shell.
    this._shellCalls = {};  // { tier: [timestamp, ...] }
    for (const tier of Object.keys(SHELL_LIMITS.RATE_LIMITS)) {
      this._shellCalls[tier] = [];
    }
  }

  // ── CORE: Run a single command ────────────────────────────
  // FIX v4.0.0: Async-first with execFile array args (no shell parsing).
  // Eliminates shell injection vectors and unblocks main thread.

  async run(command, opts = {}) {
    const { cwd = this.rootDir, timeout = 30000, silent = false, tier = this.permissionLevel } = opts;

    // FIX v5.6.0 (L-4x): Sanitize before blocklist — null bytes/newlines could bypass regex
    const sanitized = this._sanitizeCommand(command);
    if (!sanitized.ok) {
      return { ok: false, stdout: '', stderr: `[SHELL] ${sanitized.error}`, exitCode: -1, duration: 0, blocked: true };
    }
    command = sanitized.command;

    // v7.4.6.fix #31: rootDir sandbox. Reject commands that contain
    // an absolute path pointing OUTSIDE rootDir. Most Windows
    // failures came from the SHELL fallback's LLM emitting `dir /s
    // C:\` or `where /r C:\` — these hit "Zugriff verweigert" on
    // system dirs (System Volume Information, $Recycle.Bin) and
    // produced confusing summaries. Refusing early gives the LLM a
    // clear sandbox-violation message on the next planning round.
    const sandboxCheck = this._checkRootDirSandbox(command);
    if (!sandboxCheck.ok) {
      const sbResult = {
        ok: false,
        stdout: '',
        stderr: `[SHELL] Sandbox: ${sandboxCheck.reason}`,
        exitCode: -1,
        duration: 0,
        blocked: true,
        sandboxBlock: true,
      };
      if (!silent) this.bus.emit('shell:blocked', { command, tier, reason: sandboxCheck.reason }, { source: 'ShellAgent' });
      return sbResult;
    }

    const blocked = this.blockedPatterns[tier];
    if (blocked && blocked.test(command)) {
      const result = { ok: false, stdout: '', stderr: this.lang.t('shell.blocked_tier', { tier, cmd: command }), exitCode: -1, duration: 0, blocked: true };
      if (!silent) this.bus.emit('shell:blocked', { command, tier }, { source: 'ShellAgent' });
      return result;
    }

    // v3.5.0: Per-tier rate limiting
    if (!this._checkShellRateLimit(tier)) {
      const limit = SHELL_LIMITS.RATE_LIMITS[tier] || 60;
      if (!silent) this.bus.emit('shell:rate-limited', { tier, count: limit, limit, windowMs: SHELL_LIMITS.RATE_WINDOW_MS }, { source: 'ShellAgent' });
      return { ok: false, stdout: '', stderr: `[SHELL] Rate limited — ${tier} tier: max ${limit} commands per ${Math.round(SHELL_LIMITS.RATE_WINDOW_MS / 60000)}min window exceeded.`, exitCode: -2, duration: 0, blocked: false, rateLimited: true };
    }

    const startTime = Date.now();
    // FIX v4.0.0: Use shell flag + array args via execFile instead of execSync.
    // execFile does NOT spawn a shell by default (no shell-metachar parsing).
    // For compound commands (pipes, redirects), we fall back to shell mode
    // but with the command as a single argument (not concatenated).
    const shellMeta = /[|;&`$(){}><]/.test(command);
    const execOpts = {
      cwd: path.resolve(cwd), encoding: 'utf-8', timeout,
      maxBuffer: 1024 * 1024, windowsHide: true,
    };

    // v7.4.5.fix #27b: apply OS adaptation BEFORE branching into
    // shell vs execFile. Previously, _adaptCommand was only called
    // inside _parseCommand (the non-Windows simple-command path),
    // so on Windows + shell mode the LLM's "ls" was passed verbatim
    // to cmd.exe which rejected it. Now even with shell mode we
    // first translate POSIX → Windows.
    const originalCommand = command;
    command = this._adaptCommand(command);

    try {
      let stdout;
      if (shellMeta || this.isWindows) {
        // v7.4.6.fix #30: switched from execFileAsync(this.shell, [flag, cmd])
        // to execAsync(cmd, {shell}). The execFile-with-shell trick made
        // Node.js build internal command lines that cmd.exe re-quoted
        // incorrectly — pipes + embedded quotes (e.g. `dir /b *.js | find
        // /V /C ":"`) were silently corrupted. exec is built for this
        // case: spawns the OS shell and passes the command verbatim,
        // so pipes/redirects/quoting all work the way the user/LLM wrote them.
        const shellExecOpts = {
          ...execOpts,
          shell: this.shell,
        };
        const { stdout: out } = await execAsync(command, shellExecOpts);
        stdout = out;
      } else {
        // Simple commands: parse into binary + args (no shell)
        const parts = this._parseCommand(command);
        const { stdout: out } = await execFileAsync(parts[0], parts.slice(1), execOpts);
        stdout = out;
      }

      const duration = Date.now() - startTime;
      const result = {
        ok: true,
        stdout: (stdout || '').slice(0, 20000),
        stderr: '',
        exitCode: 0,
        duration,
        blocked: false,
        // v7.4.6.fix #28b: surface adapted command so AgentLoopSteps and
        // the Verifier can show what actually ran on this OS, not the
        // raw POSIX command the LLM produced.
        adaptedCommand: command,
        originalCommand,
      };
      this._record(command, cwd, result);
      if (!silent) this.bus.emit('shell:executed', { command: command.slice(0, 100), exitCode: 0, duration }, { source: 'ShellAgent' });
      return result;
    } catch (err) {
      const duration = Date.now() - startTime;
      const result = {
        ok: false, stdout: (err.stdout || '').slice(0, 10000),
        stderr: (err.stderr || err.message).slice(0, 5000),
        exitCode: err.status || err.code || 1, duration, blocked: false, killed: !!err.killed,
        adaptedCommand: command,
        originalCommand,
      };
      this._record(command, cwd, result);
      if (!silent) this.bus.emit('shell:failed', { command: command.slice(0, 100), error: result.stderr.slice(0, 200) }, { source: 'ShellAgent' });
      return result;
    }
  }

  // ── Streaming execution for long-running ops ──────────────

  runStreaming(command, opts = {}) {
    const { cwd = this.rootDir, timeout = 120000, onLine, onDone, tier = this.permissionLevel } = opts;

    // FIX v5.6.0 (L-4x): Sanitize before blocklist
    const sanitized = this._sanitizeCommand(command);
    if (!sanitized.ok) {
      onDone?.({ ok: false, stderr: `[SHELL] ${sanitized.error}`, exitCode: -1, blocked: true });
      return null;
    }
    command = sanitized.command;

    const blocked = this.blockedPatterns[tier];
    if (blocked && blocked.test(command)) {
      onDone?.({ ok: false, stderr: 'Blocked', exitCode: -1, blocked: true });
      return null;
    }

    // FIX v4.10.0 (S-6): Rate limit streaming commands (same as run())
    if (!this._checkShellRateLimit(tier)) {
      const limit = SHELL_LIMITS.RATE_LIMITS[tier] || 60;
      onDone?.({ ok: false, stderr: `[SHELL] Rate limited — ${tier} tier exceeded.`, exitCode: -2, rateLimited: true });
      return null;
    }

    // FIX v4.10.0 (S-6): For simple commands without shell metacharacters,
    // use spawn with explicit binary+args (no shell parsing) — same pattern
    // as run(). Only fall back to shell mode for pipes/redirects.
    const adaptedCmd = this._adaptCommand(command);
    const shellMeta = /[|;&`$(){}><]/.test(adaptedCmd);
    let proc;

    if (shellMeta || this.isWindows) {
      proc = spawn(this.shell, [this.shellFlag, adaptedCmd], {
        cwd: path.resolve(cwd), stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true, timeout,
      });
    } else {
      const parts = this._parseCommand(adaptedCmd);
      proc = spawn(parts[0], parts.slice(1), {
        cwd: path.resolve(cwd), stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true, timeout,
      });
    }

    let stdout = '', stderr = '';
    proc.stdout.on('data', (chunk) => {
      const text = chunk.toString();
      stdout += text;
      text.split('\n').filter(l => l.trim()).forEach(line => onLine?.(line, 'stdout'));
    });
    proc.stderr.on('data', (chunk) => {
      const text = chunk.toString();
      stderr += text;
      text.split('\n').filter(l => l.trim()).forEach(line => onLine?.(line, 'stderr'));
    });
    proc.on('close', (exitCode) => {
      const result = { ok: exitCode === 0, stdout, stderr, exitCode, blocked: false };
      this._record(command, cwd, result);
      onDone?.(result);
    });
    return proc;
  }

  // ── SMART: Plan and execute multi-step tasks ──────────────

  /**
   * v7.4.6.fix: When chatStructured can't parse the LLM output as JSON,
   * try to recover individual commands from the raw text. Looks for:
   *   - code-fenced commands ```cmd...```
   *   - backticked commands `dir /b *.js`
   *   - lines starting with $ or > (shell-prompt style)
   *   - bullet/numbered lists where the bullet text is a command
   *
   * @param {string} text
   * @returns {Array<{cmd: string, description: string, critical: boolean, condition: null}>}
   */
  _salvageStepsFromText(text) {
    if (typeof text !== 'string' || !text.trim()) return [];
    const found = [];
    const seen = new Set();
    const push = (cmd, desc) => {
      const c = (cmd || '').trim().replace(/^\$\s*|^>\s*/, '');
      if (!c || seen.has(c)) return;
      seen.add(c);
      found.push({ cmd: c, description: (desc || c).slice(0, 120), critical: false, condition: null });
    };

    // 1. Fenced code blocks: ```...``` or ```bash ... ```
    const fenceRe = /```(?:\w+\n)?([\s\S]*?)```/g;
    let m;
    while ((m = fenceRe.exec(text))) {
      const block = m[1].trim();
      // Each non-empty, non-comment line is a candidate
      for (const line of block.split('\n')) {
        const t = line.trim();
        if (!t || t.startsWith('#') || t.startsWith('//')) continue;
        push(t);
      }
    }

    // 2. Backticked single commands: `dir /b *.js`
    if (found.length === 0) {
      const tickRe = /`([^`\n]{2,200})`/g;
      while ((m = tickRe.exec(text))) push(m[1]);
    }

    // 3. Shell-prompt lines: $ cmd  or  > cmd
    if (found.length === 0) {
      for (const line of text.split('\n')) {
        if (/^\s*[\$>]\s+\S/.test(line)) push(line.trim());
      }
    }

    // 4. Numbered/bulleted list items
    if (found.length === 0) {
      const listRe = /^[\s]*(?:[-*]|\d+[.)])\s+(.+)$/gm;
      while ((m = listRe.exec(text))) {
        const t = m[1].trim();
        // Only accept lines that LOOK like commands (start with a known binary)
        if (/^(?:dir|ls|cat|type|cd|pwd|echo|find|grep|findstr|where|which|wc|head|tail|node|npm|git|python|pip|cargo|make|docker|powershell|cmd)\b/i.test(t)) {
          push(t);
        }
      }
    }

    return found.slice(0, 10);
  }

  async plan(task, cwd = this.rootDir) {
    this.bus.emit('shell:planning', { task: task.slice(0, 100) }, { source: 'ShellAgent' });

    const project = await this.scanProject(cwd);
    const pastPatterns = this.memory?.recallPattern(task);
    const pastContext = pastPatterns
      ? `\nPREVIOUSLY SUCCESSFUL: For "${pastPatterns.trigger}", "${pastPatterns.action}" worked (${Math.round(pastPatterns.successRate * 100)}% success).`
      : '';

    // v7.4.8: shared anti-hallucination block from EnvironmentContext.
    // Previously only FormalPlanner had find /V /C correctness rules;
    // direct chat path got none. Single source of truth now.
    const { osContext, osName } = buildOsContext({
      rootDir: cwd,
      isWindows: this.isWindows,
    });

    const planPrompt = `You are a shell expert for ${osName}.
${osContext}
TASK: ${task}

PROJECT CONTEXT:
- Directory: ${cwd}
- Project type: ${project.type || 'unknown'}
- Available scripts: ${JSON.stringify(project.scripts || {})}
- Git status: ${project.gitStatus || 'unknown'}
- Existing files: ${(project.keyFiles || []).join(', ')}
${pastContext}

RULES:
- Only commands that work on ${osName}
- Each command must be independently executable
- Permission tier: "${this.permissionLevel}"

Respond ONLY with a JSON list:
[{"cmd": "command", "description": "what", "critical": false, "condition": null}]`;

    let steps;
    try {
      const raw = await this.model.chatStructured(planPrompt, [], 'code');
      // v7.4.6.fix: LLMs return planned steps in many shapes. We salvage
      // them all instead of bailing with "Konnte keinen Plan erstellen"
      // on the first non-array response.
      //   1. Direct array              [{cmd, ...}]
      //   2. Wrapped in {steps:[...]}  {steps: [...]}
      //   3. Wrapped in {plan:[...]}   {plan: [...]}
      //   4. Wrapped in {commands:[..]}{commands: [...]}
      //   5. Single step object        {cmd, description}
      //   6. _raw text fallback        {_raw: "...", _parseError: true}
      if (Array.isArray(raw)) {
        steps = raw;
      } else if (raw && Array.isArray(raw.steps)) {
        steps = raw.steps;
      } else if (raw && Array.isArray(raw.plan)) {
        steps = raw.plan;
      } else if (raw && Array.isArray(raw.commands)) {
        steps = raw.commands;
      } else if (raw && typeof raw.cmd === 'string') {
        steps = [raw];
      } else if (raw && raw._raw && typeof raw._raw === 'string') {
        // Salvage from raw text — extract code-fenced or backtick commands
        steps = this._salvageStepsFromText(raw._raw);
      } else {
        steps = null;
      }
      if (!steps || !Array.isArray(steps) || steps.length === 0) {
        // v7.4.6.fix: include the raw response in the summary so the user
        // can see WHY it failed instead of a bare "Konnte keinen Plan
        // erstellen". Truncated to 300 chars to keep chat readable.
        const rawHint = (() => {
          try {
            if (raw && raw._raw) return String(raw._raw).slice(0, 300);
            return JSON.stringify(raw).slice(0, 300);
          } catch (_e) { return '<unparseable>'; }
        })();
        return {
          plan: [],
          results: [],
          summary: `${this.lang.t('agent.plan_failed')}\n\nLLM-Antwort hatte kein erkennbares Plan-Schema. Auszug:\n\`\`\`\n${rawHint}\n\`\`\``,
        };
      }
    } catch (err) {
      return { plan: [], results: [], summary: this.lang.t('shell.plan_error', { message: err.message }) };
    }

    /** @type {Array<*>} */
    const results = [];
    let allOk = true;

    for (let i = 0; i < steps.length; i++) {
      const step = steps[i];
      if (!step?.cmd) continue;

      if (step.condition && !allOk) {
        results.push({ step: i + 1, cmd: step.cmd, skipped: true, reason: this.lang.t('shell.step_skipped') });
        continue;
      }

      this.bus.emit('shell:step', { step: i + 1, total: steps.length, cmd: step.cmd.slice(0, 80) }, { source: 'ShellAgent' });
      const result = await this.run(step.cmd, { cwd, timeout: TIMEOUTS.TIMEOUT_MS });
      results.push({ step: i + 1, cmd: step.cmd, description: step.description, ...result });
      if (!result.ok && step.critical) allOk = false;
    }

    const successRate = results.filter(r => r.ok).length / Math.max(results.length, 1);
    this.memory?.learnPattern(task, steps.map(s => s.cmd).join(' && '), successRate > 0.7);

    if (this.kg) {
      const taskNode = this.kg.addNode('task', task.slice(0, 80), { successRate, steps: steps.length });
      const projNode = this.kg.addNode('project', path.basename(cwd), { type: project.type });
      this.kg.connect(taskNode, 'executed_in', projNode);
    }

    this.eventStore?.append('SHELL_PLAN_EXECUTED', {
      task: task.slice(0, 200), steps: steps.length,
      succeeded: results.filter(r => r.ok).length,
      failed: results.filter(r => !r.ok && !r.skipped).length,
    }, 'ShellAgent');

    this.bus.fire('shell:plan-complete', { task: task.slice(0, 100), success: allOk }, { source: 'ShellAgent' });
    return { plan: steps, results, summary: this._buildSummary(task, results) };
  }

  // ── PROJECT SCANNER ───────────────────────────────────────

  async scanProject(dir) {
    const resolved = path.resolve(dir);
    const cached = this._projectCache.get(resolved);
    if (cached && Date.now() - cached.timestamp < THRESHOLDS.SHELL_SCAN_CACHE_MS) return cached.scan;

    /** @type {{ type: string|null, scripts: Record<string,string>, keyFiles: string[], gitStatus: string|null, dependencies: string[], size: number, language: string|null }} */
    const scan = { type: null, scripts: {}, keyFiles: [], gitStatus: null, dependencies: [], size: 0, language: null };

    let entries;
    try { entries = fs.readdirSync(resolved); } catch (err) { _log.debug('[SHELL] readdirSync failed:', err.message); return scan; }

    for (const [type, sig] of Object.entries(this.projectSignatures)) {
      for (const pattern of sig.files) {
        if (pattern.includes('*')) {
          // FIX v4.12.3 (S-02/Q-07): Proper glob-to-regex — escape metacharacters
          // before replacing *, and use 'g' flag to replace all occurrences.
          const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
          const regex = new RegExp(`^${escaped}$`);
          if (entries.some(e => regex.test(e))) { scan.type = type; scan.scripts = { ...sig.cmds }; break; }
        } else if (entries.includes(pattern)) {
          scan.type = type; scan.scripts = { ...sig.cmds }; break;
        }
      }
      if (scan.type) break;
    }

    if (scan.type === 'node') {
      try {
        const pkg = safeJsonParse(fs.readFileSync(path.join(resolved, 'package.json'), 'utf-8'), {}, 'ShellAgent');
        if (pkg.scripts) {
          for (const [name] of Object.entries(pkg.scripts)) {
            scan.scripts[name] = `npm run ${name}`;
          }
        }
        scan.dependencies = Object.keys(pkg.dependencies || {});
        scan.language = 'javascript';
      } catch (err) { _log.debug('[SHELL] package.json parse failed:', err.message); }
    }

    const keyPatterns = /^(README|LICENSE|Makefile|Dockerfile|docker-compose|\.env|\.gitignore|tsconfig|webpack|vite|rollup)/i;
    scan.keyFiles = entries.filter(e => keyPatterns.test(e) || /\.(md|toml|cfg|ini)$/i.test(e)).slice(0, 20);

    try {
      const { stdout: status } = await execFileAsync('git', ['status', '--porcelain'], { cwd: resolved, encoding: 'utf-8', timeout: TIMEOUTS.QUICK_CHECK, windowsHide: true });
      const { stdout: branchOut } = await execFileAsync('git', ['branch', '--show-current'], { cwd: resolved, encoding: 'utf-8', timeout: TIMEOUTS.QUICK_CHECK, windowsHide: true });
      const branch = branchOut.trim();
      const changes = status.trim().split('\n').filter(l => l.trim()).length;
      scan.gitStatus = `${branch} (${changes === 0 ? 'clean' : changes + ' changes'})`;
    } catch (err) { _log.debug('[SHELL] git status unavailable:', err.message); scan.gitStatus = 'no git'; }

    try {
      if (this.isWindows) {
        const { stdout: countOut } = await execFileAsync('powershell', ['-NoProfile', '-Command',
          `(Get-ChildItem -LiteralPath '${resolved.replace(/'/g, "''")}' -Recurse -File | Where-Object { $_.FullName -notmatch 'node_modules|.git' }).Count`
        ], { cwd: resolved, encoding: 'utf-8', timeout: TIMEOUTS.GIT_OP, windowsHide: true });
        scan.size = parseInt(countOut.trim()) || 0;
      } else {
        const { stdout: countOut } = await execFileAsync('find', ['.', '-type', 'f', '-not', '-path', '*/node_modules/*', '-not', '-path', '*/.git/*'], { cwd: resolved, encoding: 'utf-8', timeout: TIMEOUTS.GIT_OP, windowsHide: true });
        scan.size = countOut.trim().split('\n').filter(l => l).length;
      }
    } catch (err) { _log.debug('[SHELL] Working dir detection failed:', err.message); }

    this._projectCache.set(resolved, { scan, timestamp: Date.now() });

    if (this.kg && scan.type) {
      this.kg.addNode('project', path.basename(resolved), {
        type: scan.type, language: scan.language, path: resolved, files: scan.size,
      });
    }

    return scan;
  }

  // ── WORKSPACE ─────────────────────────────────────────────

  async openWorkspace(dir) {
    const scan = await this.scanProject(dir);
    const lines = [
      `**Project:** ${path.basename(dir)}`,
      `**Type:** ${scan.type || 'unknown'}`,
      `**Language:** ${scan.language || 'unknown'}`,
      `**Files:** ${scan.size}`,
      `**Git:** ${scan.gitStatus || 'none'}`,
    ];
    if (Object.keys(scan.scripts).length > 0) {
      lines.push('', '**Available commands:**');
      for (const [name, cmd] of Object.entries(scan.scripts)) {
        lines.push(`- \`${name}\`: \`${cmd}\``);
      }
    }
    if (scan.dependencies.length > 0) {
      lines.push('', `**Dependencies:** ${scan.dependencies.slice(0, 15).join(', ')}${scan.dependencies.length > 15 ? ` (+${scan.dependencies.length - 15})` : ''}`);
    }
    return { scan, description: lines.join('\n') };
  }

  // ── SMART COMMANDS ────────────────────────────────────────

  async runTests(cwd = this.rootDir) {
    const project = await this.scanProject(cwd);
    const testCmd = project.scripts?.test;
    if (!testCmd) return { ok: false, stderr: this.lang.t('agent.no_test_cmd'), exitCode: -1 };
    return this.run(testCmd, { cwd, timeout: TIMEOUTS.TEST_INSTALL });
  }

  async installDeps(cwd = this.rootDir) {
    const project = await this.scanProject(cwd);
    const installCmd = project.scripts?.install;
    if (!installCmd) return { ok: false, stderr: this.lang.t('agent.no_install_cmd'), exitCode: -1 };
    return this.run(installCmd, { cwd, timeout: TIMEOUTS.TEST_INSTALL });
  }

  search(pattern, cwd = this.rootDir, opts = {}) {
    const { filePattern = '*', maxResults = 50 } = opts;
    // FIX v3.5.4: Escape pattern/filePattern to prevent shell injection
    // from LLM-generated search queries.
    const safePattern = pattern.replace(/['"\\$`!;|&()<>]/g, '');
    const safeFilePattern = filePattern.replace(/['"\\$`!;|&()<>]/g, '');
    const cmd = this.isWindows
      ? `findstr /s /n /i "${safePattern}" ${safeFilePattern}`
      : `grep -rn --include="${safeFilePattern}" -F -- "${safePattern}" . 2>/dev/null | head -${parseInt(maxResults) || 50}`;
    return this.run(cmd, { cwd, timeout: TIMEOUTS.SANDBOX_EXEC });
  }

  findTodos(cwd = this.rootDir) {
    return this.search('TODO\\|FIXME\\|HACK\\|XXX', cwd, { filePattern: '*.js' });
  }

  diskUsage(dir = this.rootDir) {
    // FIX v3.5.4: Sanitize dir path to prevent shell injection
    const safeDir = dir.replace(/['"\\$`!;|&()<>]/g, '');
    const cmd = this.isWindows
      ? `powershell -NoProfile -Command "(Get-ChildItem -LiteralPath '${safeDir.replace(/'/g, "''")}' -Recurse | Measure-Object -Sum Length).Sum / 1MB"`
      : `du -sh -- "${safeDir}" 2>/dev/null | cut -f1`;
    return this.run(cmd, { timeout: TIMEOUTS.COMMAND_EXEC });
  }

  // ── PERMISSION MANAGEMENT ─────────────────────────────────

  setPermissionLevel(level) {
    if (!['observe', 'read', 'write', 'system'].includes(level)) {
      throw new Error(this.lang.t('shell.permission_unknown', { level }));
    }
    const old = this.permissionLevel;
    this.permissionLevel = level;
    this.bus.emit('shell:permission-changed', { from: old, to: level }, { source: 'ShellAgent' });
    return { ok: true, level };
  }

  getPermissionLevel() { return this.permissionLevel; }

  // ── HISTORY & LEARNING ────────────────────────────────────

  getHistory(limit = 20) { return this.history.slice(-limit); }

  recallSuccessful(taskDescription) {
    return this.memory?.recallPattern(taskDescription) || null;
  }

  getStats() {
    const total = this.history.length;
    const ok = this.history.filter(h => h.exitCode === 0).length;
    return {
      total, succeeded: ok, failed: total - ok,
      successRate: total > 0 ? Math.round((ok / total) * 100) : 0,
      permissionLevel: this.permissionLevel,
      os: this.isWindows ? 'Windows' : 'Linux/Mac',
      cachedProjects: this._projectCache.size,
    };
  }

  // ── PRIVATE ───────────────────────────────────────────────

  /**
   * v3.5.0: Per-tier rolling-window rate limiter.
   * Returns true if command is allowed, false if rate-limited.
   */
  _checkShellRateLimit(tier) {
    const limit = SHELL_LIMITS.RATE_LIMITS[tier];
    if (!limit) return true; // Unknown tier — allow
    if (!this._shellCalls[tier]) this._shellCalls[tier] = [];
    const now = Date.now();
    const windowStart = now - SHELL_LIMITS.RATE_WINDOW_MS;
    this._shellCalls[tier] = this._shellCalls[tier].filter(ts => ts > windowStart);
    if (this._shellCalls[tier].length >= limit) return false;
    this._shellCalls[tier].push(now);
    return true;
  }

  /**
   * FIX v5.6.0 (L-4x): Sanitize command input before any processing.
   * Blocks null bytes, newlines, and excessive length that could bypass
   * blocklist regex or exploit shell parsing.
   * @param {string} command
   * @returns {{ ok: boolean, command?: string, error?: string }}
   */
  _sanitizeCommand(command) {
    if (typeof command !== 'string') return { ok: false, error: 'Command must be a string' };
    if (command.length > THRESHOLDS.SHELL_COMMAND_MAX_CHARS) return { ok: false, error: `Command exceeds ${THRESHOLDS.SHELL_COMMAND_MAX_CHARS / 1024}KB limit` };
    // Null bytes can truncate strings in C-based shell parsers
    if (command.includes('\0')) return { ok: false, error: 'Null byte in command' };
    // Newlines can inject additional commands in shell mode
    const cleaned = command.replace(/[\r\n]+/g, ' ').trim();
    if (!cleaned) return { ok: false, error: 'Empty command' };
    // FIX v6.0.3 (L-4): NFKC normalization — converts Unicode confusables
    // (fullwidth ｒｍ → rm, homoglyphs, etc.) so blocklist regex can match.
    // Without this, `ｒｍ -rf /` bypasses the \brm\b pattern.
    const normalized = cleaned.normalize('NFKC');
    return { ok: true, command: normalized };
  }

  /**
   * v7.4.6.fix #31: Reject commands that contain absolute paths pointing
   * OUTSIDE rootDir. Catches the LLM-fallback failure mode where the
   * planner emitted `dir /s C:\`, `where /r C:\`, `type C:\Users\...`,
   * etc. — commands that escaped Genesis's working directory and hit
   * Windows access-denied on system folders.
   *
   * Lenient on purpose: only rejects commands that contain a clear
   * absolute path token outside rootDir. Relative paths and absolute
   * paths inside rootDir always pass.
   *
   * @param {string} command
   * @returns {{ok: boolean, reason?: string}}
   */
  _checkRootDirSandbox(command) {
    if (!this.rootDir) return { ok: true };
    const root = path.resolve(this.rootDir).toLowerCase();
    // Find absolute path tokens. Windows: drive-letter form (C:\, D:\, ...).
    // POSIX: leading slash followed by a known root directory name. We
    // restrict to common roots so flags like "/b", "/s", "/q" don't get
    // mistaken for paths. Absolute paths in shell commands almost always
    // start with one of these top-level dirs.
    const winAbs = command.match(/\b([A-Za-z]):[\\/](?:[^\s"';|&<>]*)/g) || [];
    const posixAbs = !this.isWindows
      ? (command.match(/(?:^|\s)(\/(?:home|usr|var|etc|opt|tmp|root|mnt|srv|bin|sbin|lib|proc|sys|run|boot)\/[^\s"';|&<>]*)/g) || [])
          .map(s => s.trim())
      : [];
    const candidates = [...winAbs, ...posixAbs];
    for (const raw of candidates) {
      const abs = path.resolve(raw).toLowerCase();
      if (!abs.startsWith(root)) {
        return {
          ok: false,
          reason: `path "${raw}" is outside rootDir (${this.rootDir}). Use relative paths or absolute paths inside the working directory.`,
        };
      }
    }
    // Also reject the common "dir /s C:\" / "where /r C:\" patterns even
    // if drive root matches rootDir's drive — recursing from C:\ is too
    // broad and inevitably hits access-denied.
    if (/\bdir\s+\/s\s+[A-Za-z]:[\\/]?\s*$/i.test(command)
        || /\bwhere\s+\/r\s+[A-Za-z]:[\\/]?\s/i.test(command)) {
      return {
        ok: false,
        reason: 'recursive scan from a drive root (dir /s C:\\, where /r C:\\) is not allowed. Scope the path to the working directory.',
      };
    }
    return { ok: true };
  }

  _adaptCommand(cmd) {
    if (!this.isWindows) return cmd;
    // v7.4.5.fix #27c: expanded POSIX → Windows mapping. Previously
    // only 8 commands were translated; the LLM commonly generates
    // grep/find/wc/touch/echo idioms that all failed silently.
    // We translate the common shapes so Genesis can actually carry
    // out diverse tasks on Windows, not just file listing.
    let out = cmd;
    // Simple program-name swaps (start of command only)
    out = out
      .replace(/^ls\b/, 'dir')
      .replace(/^cat\s/, 'type ')
      .replace(/^rm\s+-rf\s/, 'rmdir /s /q ')
      .replace(/^rm\s/, 'del ')
      .replace(/^cp\s+-r\s/, 'xcopy /e /i ')
      .replace(/^cp\s/, 'copy ')
      .replace(/^mv\s/, 'move ')
      .replace(/^mkdir\s+-p\s/, 'mkdir ')
      .replace(/^which\s/, 'where ')
      .replace(/^touch\s/, 'type nul > ')
      .replace(/^pwd\b/, 'cd')
      .replace(/^clear$/, 'cls')
      .replace(/^echo\s+\$([A-Z_][A-Z0-9_]*)\b/, 'echo %$1%');
    // v7.4.6.fix #29: quote-safe counting. The pattern `find /C /V ""`
    // (count lines NOT matching empty) gets mangled when passed through
    // Node.js → cmd.exe — the doubled empty quotes get re-escaped and
    // `find` ends up reading file `"\"` → "Zugriff verweigert".
    // Replacement: `find /V /C ":"` (count lines NOT containing colon).
    // Filenames on Windows cannot contain ':' (reserved drive separator),
    // so this counts all lines correctly with no quoting hazard.
    // Common pipe idioms: "ls | wc -l" → "dir /b | find /V /C \":\""
    out = out.replace(/\|\s*wc\s+-l\s*$/, '| find /V /C ":"');
    // Auto-translate the broken pattern if the LLM emits it directly
    out = out.replace(/find\s+\/[Cc]\s+\/[Vv]\s+""/g, 'find /V /C ":"');
    out = out.replace(/find\s+\/[Vv]\s+\/[Cc]\s+""/g, 'find /V /C ":"');
    // v7.4.6.fix #29b: LLMs hallucinate other broken find-counter forms too.
    // Real-world failures observed:
    //   `find /c "*"`           — Windows find treats * as literal, not glob
    //   `find /c "."`           — counts lines containing literal dot
    //   `find /v ""`            — missing /c, just inverts (lists everything)
    //   `find /count ...`       — /count is not a flag at all
    //   `findstr /c:"*"`        — different tool, same hallucination
    // All these get rewritten to `find /V /C ":"` which actually counts lines.
    out = out.replace(/\bfind\s+\/[Cc]\s+"[*.]"/g, 'find /V /C ":"');
    out = out.replace(/\bfind\s+\/[Cc]\s+"\s*"/g, 'find /V /C ":"');
    out = out.replace(/\bfind\s+\/[Vv]\s+""\s*$/, 'find /V /C ":"');
    out = out.replace(/\bfind\s+\/count\b[^|&;<>]*$/i, 'find /V /C ":"');
    out = out.replace(/\bfindstr\s+\/c:"[*.]"/g, 'find /V /C ":"');
    // grep — basic mapping to findstr (not 1:1 but covers common cases)
    out = out.replace(/\bgrep\s+(-[A-Za-z]+\s+)?/g, 'findstr ');
    // /dev/null → NUL
    out = out.replace(/\/dev\/null/g, 'NUL');
    return out;
  }

  /**
   * FIX v4.0.0: Parse a simple command into [binary, ...args] for execFile.
   * Handles quoted arguments. For complex commands (pipes, redirects),
   * the caller falls back to shell mode.
   */
  _parseCommand(command) {
    const adapted = this._adaptCommand(command);
    const parts = [];
    let current = '';
    let inSingle = false, inDouble = false;
    for (const ch of adapted) {
      if (ch === "'" && !inDouble) { inSingle = !inSingle; continue; }
      if (ch === '"' && !inSingle) { inDouble = !inDouble; continue; }
      if (ch === ' ' && !inSingle && !inDouble) {
        if (current) { parts.push(current); current = ''; }
        continue;
      }
      current += ch;
    }
    if (current) parts.push(current);
    return parts.length > 0 ? parts : [adapted];
  }

  _record(command, cwd, result) {
    this.history.push({
      cmd: command.slice(0, 200), cwd: path.basename(cwd),
      exitCode: result.exitCode, duration: result.duration || 0,
      snippet: (result.stdout || result.stderr || '').slice(0, 100),
      timestamp: new Date().toISOString(),
    });
    if (this.history.length > this.maxHistory) this.history.shift();
  }

  _buildSummary(task, results) {
    const ok = results.filter(r => r.ok).length;
    const fail = results.filter(r => !r.ok && !r.skipped).length;
    const skip = results.filter(r => r.skipped).length;
    const lines = [`**Shell-Plan: "${task}"**`, ''];
    for (const r of results) {
      const icon = r.skipped ? '⏭' : r.ok ? '✅' : '❌';
      const detail = r.skipped ? r.reason : (r.ok ? '' : `: ${r.stderr?.split('\n')[0]?.slice(0, 80) || 'error'}`);
      lines.push(`${icon} \`${r.cmd}\`${detail ? ' — ' + detail : ''}`);
    }
    lines.push('', `**Result:** ${ok} succeeded, ${fail} failed${skip > 0 ? `, ${skip} skipped` : ''}`);
    return lines.join('\n');
  }
}

module.exports = { ShellAgent };
