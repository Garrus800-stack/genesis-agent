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

const { execFile, spawn } = require('child_process');
const { promisify } = require('util');
const execFileAsync = promisify(execFile);
const fs = require('fs');
const path = require('path');
const { NullBus } = require('../core/EventBus');
const { SHELL: SHELL_LIMITS, TIMEOUTS } = require('../core/Constants');
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

    try {
      let stdout;
      if (shellMeta || this.isWindows) {
        // Commands with shell metacharacters or Windows: use shell
        // but via execFile (not exec) with explicit shell + flag
        const { stdout: out } = await execFileAsync(
          this.shell, [this.shellFlag, command], execOpts
        );
        stdout = out;
      } else {
        // Simple commands: parse into binary + args (no shell)
        const parts = this._parseCommand(command);
        const { stdout: out } = await execFileAsync(parts[0], parts.slice(1), execOpts);
        stdout = out;
      }

      const duration = Date.now() - startTime;
      const result = { ok: true, stdout: (stdout || '').slice(0, 20000), stderr: '', exitCode: 0, duration, blocked: false };
      this._record(command, cwd, result);
      if (!silent) this.bus.emit('shell:executed', { command: command.slice(0, 100), exitCode: 0, duration }, { source: 'ShellAgent' });
      return result;
    } catch (err) {
      const duration = Date.now() - startTime;
      const result = {
        ok: false, stdout: (err.stdout || '').slice(0, 10000),
        stderr: (err.stderr || err.message).slice(0, 5000),
        exitCode: err.status || err.code || 1, duration, blocked: false, killed: !!err.killed,
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

  async plan(task, cwd = this.rootDir) {
    this.bus.emit('shell:planning', { task: task.slice(0, 100) }, { source: 'ShellAgent' });

    const project = await this.scanProject(cwd);
    const pastPatterns = this.memory?.recallPattern(task);
    const pastContext = pastPatterns
      ? `\nPREVIOUSLY SUCCESSFUL: For "${pastPatterns.trigger}", "${pastPatterns.action}" worked (${Math.round(pastPatterns.successRate * 100)}% success).`
      : '';

    const planPrompt = `You are a shell expert for ${this.isWindows ? 'Windows (PowerShell/CMD)' : 'Linux (Bash)'}.

TASK: ${task}

PROJECT CONTEXT:
- Directory: ${cwd}
- Project type: ${project.type || 'unknown'}
- Available scripts: ${JSON.stringify(project.scripts || {})}
- Git status: ${project.gitStatus || 'unknown'}
- Existing files: ${(project.keyFiles || []).join(', ')}
${pastContext}

RULES:
- Only commands that work on ${this.isWindows ? 'Windows' : 'Linux'}
- Each command must be independently executable
- Permission tier: "${this.permissionLevel}"

Respond ONLY with a JSON list:
[{"cmd": "command", "description": "what", "critical": false, "condition": null}]`;

    let steps;
    try {
      const raw = await this.model.chatStructured(planPrompt, [], 'code');
      steps = Array.isArray(raw) ? raw : (raw?.steps || raw?._raw ? null : [raw]);
      if (!steps || !Array.isArray(steps)) {
        return { plan: [], results: [], summary: this.lang.t('agent.plan_failed') };
      }
    } catch (err) {
      return { plan: [], results: [], summary: this.lang.t('shell.plan_error', { message: err.message }) };
    }

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
      const result = this.run(step.cmd, { cwd, timeout: TIMEOUTS.TIMEOUT_MS });
      results.push({ step: i + 1, cmd: step.cmd, description: step.description, ...result });
      // @ts-ignore — TS strict
      if (!result.ok && step.critical) allOk = false;
    }

    // @ts-ignore — TS strict
    const successRate = results.filter(r => r.ok).length / Math.max(results.length, 1);
    this.memory?.learnPattern(task, steps.map(s => s.cmd).join(' && '), successRate > 0.7);

    if (this.kg) {
      const taskNode = this.kg.addNode('task', task.slice(0, 80), { successRate, steps: steps.length });
      const projNode = this.kg.addNode('project', path.basename(cwd), { type: project.type });
      this.kg.connect(taskNode, 'executed_in', projNode);
    }

    this.eventStore?.append('SHELL_PLAN_EXECUTED', {
      task: task.slice(0, 200), steps: steps.length,
      // @ts-ignore — TS strict
      succeeded: results.filter(r => r.ok).length,
      // @ts-ignore — TS strict
      failed: results.filter(r => !r.ok && !r.skipped).length,
    }, 'ShellAgent');

    this.bus.fire('shell:plan-complete', { task: task.slice(0, 100), success: allOk }, { source: 'ShellAgent' });
    return { plan: steps, results, summary: this._buildSummary(task, results) };
  }

  // ── PROJECT SCANNER ───────────────────────────────────────

  async scanProject(dir) {
    const resolved = path.resolve(dir);
    const cached = this._projectCache.get(resolved);
    if (cached && Date.now() - cached.timestamp < 30000) return cached.scan;

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
          // @ts-ignore — TS strict
          if (entries.some(e => regex.test(e))) { scan.type = type; scan.scripts = { ...sig.cmds }; break; }
        } else if (entries.includes(pattern)) {
          // @ts-ignore — TS strict
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
        // @ts-ignore — TS strict
        scan.dependencies = Object.keys(pkg.dependencies || {});
        // @ts-ignore — TS strict
        scan.language = 'javascript';
      } catch (err) { _log.debug('[SHELL] package.json parse failed:', err.message); }
    }

    const keyPatterns = /^(README|LICENSE|Makefile|Dockerfile|docker-compose|\.env|\.gitignore|tsconfig|webpack|vite|rollup)/i;
    // @ts-ignore — TS strict
    scan.keyFiles = entries.filter(e => keyPatterns.test(e) || /\.(md|toml|cfg|ini)$/i.test(e)).slice(0, 20);

    try {
      const { stdout: status } = await execFileAsync('git', ['status', '--porcelain'], { cwd: resolved, encoding: 'utf-8', timeout: TIMEOUTS.QUICK_CHECK, windowsHide: true });
      const { stdout: branchOut } = await execFileAsync('git', ['branch', '--show-current'], { cwd: resolved, encoding: 'utf-8', timeout: TIMEOUTS.QUICK_CHECK, windowsHide: true });
      const branch = branchOut.trim();
      const changes = status.trim().split('\n').filter(l => l.trim()).length;
      // @ts-ignore — TS strict
      scan.gitStatus = `${branch} (${changes === 0 ? 'clean' : changes + ' changes'})`;
    // @ts-ignore — TS strict
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
    if (command.length > 8192) return { ok: false, error: 'Command exceeds 8KB limit' };
    // Null bytes can truncate strings in C-based shell parsers
    if (command.includes('\0')) return { ok: false, error: 'Null byte in command' };
    // Newlines can inject additional commands in shell mode
    const cleaned = command.replace(/[\r\n]+/g, ' ').trim();
    if (!cleaned) return { ok: false, error: 'Empty command' };
    return { ok: true, command: cleaned };
  }

  _adaptCommand(cmd) {
    if (!this.isWindows) return cmd;
    return cmd
      .replace(/^ls\b/, 'dir')
      .replace(/^cat\s/, 'type ')
      .replace(/^rm\s/, 'del ')
      .replace(/^cp\s/, 'copy ')
      .replace(/^mv\s/, 'move ')
      .replace(/^mkdir -p\s/, 'mkdir ')
      .replace(/^which\s/, 'where ')
      .replace(/^clear$/, 'cls');
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
