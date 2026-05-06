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
const { safeJsonParse } = require('../core/utils');
const { createLogger } = require('../core/Logger');
// v7.5.4: extracted helpers
const Safety = require('../core/shell/ShellSafety');
const OSAdapter = require('./shell/ShellOSAdapter');
const { ShellPlanner } = require('./shell/ShellPlanner');
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

    // v7.5.4: shell binary, flag, platform info from OSAdapter
    const shellInfo = OSAdapter.resolveShell();
    this.shell = shellInfo.shell;
    this.shellFlag = shellInfo.shellFlag;
    this.isWindows = shellInfo.isWindows;        // backward-compat field
    this.platform = shellInfo.platform;          // v7.5.4 new

    // FIX v4.0.0: Default to 'read' — autonomous operations must explicitly
    // escalate to 'write' via setPermissionLevel(). Prevents accidental
    // destructive operations during AgentLoop/IdleMind autonomous runs.
    this.permissionLevel = 'read';

    // v7.5.9 ZIP2 Phase 1: late-bound trustLevelSystem + settings for the
    // 3-tier sandbox (project / user-home / permissive). These remain null
    // when ShellAgent is constructed early (Phase 2 of boot); the manifest
    // wires them in Phase 8 via lateBindings.
    /** @type {*} */ this.trustLevelSystem = null;
    /** @type {*} */ this.settings = null;

    this.history = [];
    this.maxHistory = 200;

    // v7.5.4: blockedPatterns sourced from ShellSafety. Frozen object;
    // backward-compat field (8 test assertions read instance.blockedPatterns).
    this.blockedPatterns = Safety.BLOCKED_PATTERNS;

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

    // v7.5.4: rate-limit state via ShellSafety.buildRateLimitState
    this._shellCalls = Safety.buildRateLimitState(Object.keys(SHELL_LIMITS.RATE_LIMITS));

    // v7.5.4: dedicated planner for LLM-based shell-step generation.
    // Plan-erzeugung lives there; this orchestrator handles execution.
    this._planner = new ShellPlanner({ model, memory, lang, bus });

    // v7.5.5: late-binding setter for selfStatementLog. Phase-3 ShellAgent
    // is built before phase-9 SelfStatementLog exists, so the planner
    // can't take it via constructor. Container.wireLateBindings sets
    // `this.selfStatementLog`; the setter propagates the value onto the
    // already-constructed _planner so ShellPlanner.recordPromise(...)
    // captures shell-task plans as `versprechen`-class self-statements.
    let _ssl = null;
    Object.defineProperty(this, 'selfStatementLog', {
      get() { return _ssl; },
      set(v) { _ssl = v; if (this._planner) this._planner.selfStatementLog = v; },
      configurable: true,
      enumerable: true,
    });
  }

  // ── CORE: Run a single command ────────────────────────────
  // FIX v4.0.0: Async-first with execFile array args (no shell parsing).
  // Eliminates shell injection vectors and unblocks main thread.

  /**
   * v7.5.4: shared pre-execution pipeline used by run() and runStreaming().
   * Order: sanitize → sandbox → blocked-pattern → rate-limit.
   *
   * Returns { ok: true, command: sanitizedCmd, tier } on success,
   * or { ok: false, result } where result is the ready-to-return error object.
   *
   * @param {string} command
   * @param {object} opts
   * @returns {{ok: true, command: string, tier: string} | {ok: false, result: object}}
   */
  _validateAndPrepare(command, opts) {
    const { silent = false, tier = this.permissionLevel } = opts;

    // Sanitize before everything — null bytes/newlines could bypass regex
    const sanitized = Safety.sanitizeCommand(command, { maxChars: THRESHOLDS.SHELL_COMMAND_MAX_CHARS });
    if (!sanitized.ok) {
      return { ok: false, result: { ok: false, stdout: '', stderr: `[SHELL] ${sanitized.error}`, exitCode: -1, duration: 0, blocked: true } };
    }
    command = sanitized.command;

    // rootDir sandbox: reject absolute paths outside rootDir, recursive scans
    // v7.5.9 ZIP2 Phase 1: pass trustLevel + settings so the 3-tier sandbox
    // can decide if user-home / Desktop access is allowed.
    const _trustLevel = this.trustLevelSystem?.getLevel?.() ?? undefined;
    const sandboxCheck = Safety.checkRootDirSandbox(command, this.rootDir, {
      platform: this.platform,
      trustLevel: _trustLevel,
      settings: this.settings,
    });
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
      return { ok: false, result: sbResult };
    }

    // Blocked-pattern check per tier
    const blockedCheck = Safety.checkBlockedPattern(command, tier, this.blockedPatterns);
    if (!blockedCheck.ok) {
      const result = { ok: false, stdout: '', stderr: this.lang.t('shell.blocked_tier', { tier, cmd: command }), exitCode: -1, duration: 0, blocked: true };
      if (!silent) this.bus.emit('shell:blocked', { command, tier }, { source: 'ShellAgent' });
      return { ok: false, result };
    }

    // Rate-limit per tier (rolling window)
    const rateCheck = Safety.checkRateLimit(this._shellCalls, tier, SHELL_LIMITS.RATE_LIMITS, SHELL_LIMITS.RATE_WINDOW_MS);
    if (!rateCheck.ok) {
      const limit = rateCheck.limit;
      if (!silent) this.bus.emit('shell:rate-limited', { tier, count: limit, limit, windowMs: SHELL_LIMITS.RATE_WINDOW_MS }, { source: 'ShellAgent' });
      return { ok: false, result: { ok: false, stdout: '', stderr: `[SHELL] Rate limited — ${tier} tier: max ${limit} commands per ${Math.round(SHELL_LIMITS.RATE_WINDOW_MS / 60000)}min window exceeded.`, exitCode: -2, duration: 0, blocked: false, rateLimited: true } };
    }

    return { ok: true, command, tier };
  }

  async run(command, opts = {}) {
    const { cwd = this.rootDir, timeout = 30000, silent = false } = opts;

    const prep = this._validateAndPrepare(command, opts);
    if (!prep.ok) return prep.result;
    command = prep.command;

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
    command = OSAdapter.adaptCommand(command, this.platform);

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
        const parts = OSAdapter.parseCommand(command, this.platform);
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
    const { cwd = this.rootDir, timeout = 120000, onLine, onDone } = opts;

    // v7.5.4: shared pipeline. Aligns runStreaming with run() —
    // adds sandbox-check (was missing pre-v7.5.4), bus.emit telemetry
    // for blocked + rate-limited (was silent pre-v7.5.4), and stderr
    // formats matching run().
    const prep = this._validateAndPrepare(command, opts);
    if (!prep.ok) {
      onDone?.(prep.result);
      return null;
    }
    command = prep.command;

    // FIX v4.10.0 (S-6): For simple commands without shell metacharacters,
    // use spawn with explicit binary+args (no shell parsing) — same pattern
    // as run(). Only fall back to shell mode for pipes/redirects.
    const adaptedCmd = OSAdapter.adaptCommand(command, this.platform);
    const shellMeta = /[|;&`$(){}><]/.test(adaptedCmd);
    let proc;

    if (shellMeta || this.isWindows) {
      proc = spawn(this.shell, [this.shellFlag, adaptedCmd], {
        cwd: path.resolve(cwd), stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true, timeout,
      });
    } else {
      const parts = OSAdapter.parseCommand(adaptedCmd, this.platform);
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
  // v7.5.4: _salvageStepsFromText moved to ShellPlanner; plan() below
  // delegates plan generation to it and runs the resulting steps.

  async plan(task, cwd = this.rootDir) {
    // v7.5.4: Plan generation delegated to ShellPlanner.
    // shell:planning event is now emitted by the planner (source: 'ShellPlanner').
    // ShellAgent retains step execution + bookkeeping (KG, eventStore) below.
    const project = await this.scanProject(cwd);
    const planResult = await this._planner.generate(task, {
      project,
      cwd,
      isWindows: this.isWindows,
      permissionLevel: this.permissionLevel,
    });

    if (!planResult.steps) {
      return { plan: [], results: [], summary: planResult.error };
    }

    const steps = planResult.steps;

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
  // v7.5.4: _sanitizeCommand, _checkRootDirSandbox, _checkShellRateLimit
  // moved to ShellSafety. _adaptCommand and _parseCommand moved to
  // ShellOSAdapter. ShellAgent calls them via Safety.* and OSAdapter.*.
  //
  // Backwards-compat thin wrappers below preserve the v7.5.3 method
  // signatures for existing tests (v746-fix, run-tests harness, etc.)
  // and any other internal callers that grew out of fix-history.
  // They forward to the new helpers.

  _sanitizeCommand(command) {
    return Safety.sanitizeCommand(command, { maxChars: THRESHOLDS.SHELL_COMMAND_MAX_CHARS });
  }

  _checkRootDirSandbox(command) {
    // v7.5.9 ZIP2 Phase 1: pass trust+settings for tier-aware sandbox.
    const _trustLevel = this.trustLevelSystem?.getLevel?.() ?? undefined;
    return Safety.checkRootDirSandbox(command, this.rootDir, {
      platform: this.platform,
      trustLevel: _trustLevel,
      settings: this.settings,
    });
  }

  _checkShellRateLimit(tier) {
    const r = Safety.checkRateLimit(this._shellCalls, tier, SHELL_LIMITS.RATE_LIMITS, SHELL_LIMITS.RATE_WINDOW_MS);
    return r.ok;  // v7.5.3 returned plain boolean
  }

  _adaptCommand(cmd) {
    // Honor a runtime override of isWindows (legacy tests in v746-fix
    // toggle this directly to test both branches without spawning).
    const platform = this.isWindows ? 'win32' : (this.platform === 'win32' ? 'linux' : this.platform);
    return OSAdapter.adaptCommand(cmd, platform);
  }

  _parseCommand(command) {
    const platform = this.isWindows ? 'win32' : (this.platform === 'win32' ? 'linux' : this.platform);
    return OSAdapter.parseCommand(command, platform);
  }

  _salvageStepsFromText(text) {
    // Use a transient Planner instance so this works even on prototype-only
    // bound objects (Object.create(ShellAgent.prototype)) that some tests use.
    const planner = this._planner || new ShellPlanner({ model: null });
    return planner._salvageStepsFromText(text);
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
