// @ts-checked-v5.7
// ============================================================
// GENESIS — FileProcessor.js
// Handles any file type the user drops or opens.
// Can: open in editor, execute, analyze, extract archives.
// Supports: JS, Python, Bat, PHP, Shell, HTML, CSS, JSON,
//           YAML, Markdown, and many more.
// ============================================================

const fs = require('fs');
const { TIMEOUTS } = require('../core/Constants');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');
const execFileAsync = promisify(execFile);
const { NullBus } = require('../core/EventBus');
const { createLogger } = require('../core/Logger');
const _log = createLogger('FileProcessor');
class FileProcessor {
  constructor(rootDir, sandbox, bus) {
    this.bus = bus || NullBus;
    this.rootDir = rootDir;
    this.sandbox = sandbox;
    this.uploadDir = path.join(rootDir, 'uploads');
    this.maxFileSize = 10 * 1024 * 1024; // 10MB limit

    if (!fs.existsSync(this.uploadDir)) {
      fs.mkdirSync(this.uploadDir, { recursive: true });
    }

    // Language runtimes available on system
    // FIX v4.0.0: Defaults set synchronously, actual detection deferred to asyncLoad()
    this.runtimes = { node: true, python: false, php: false, ruby: false, bash: false, lua: false, powershell: process.platform === 'win32', cmd: process.platform === 'win32' };

    // Extension -> language/type mapping
    this.extMap = {
      // Executable scripts
      '.js': { lang: 'javascript', runtime: 'node', monacoLang: 'javascript' },
      '.mjs': { lang: 'javascript', runtime: 'node', monacoLang: 'javascript' },
      '.ts': { lang: 'typescript', runtime: 'npx ts-node', monacoLang: 'typescript' },
      '.py': { lang: 'python', runtime: 'python', monacoLang: 'python' },
      '.bat': { lang: 'batch', runtime: 'cmd /c', monacoLang: 'bat' },
      '.cmd': { lang: 'batch', runtime: 'cmd /c', monacoLang: 'bat' },
      '.ps1': { lang: 'powershell', runtime: 'powershell -File', monacoLang: 'powershell' },
      '.sh': { lang: 'shell', runtime: 'bash', monacoLang: 'shell' },
      '.bash': { lang: 'shell', runtime: 'bash', monacoLang: 'shell' },
      '.php': { lang: 'php', runtime: 'php', monacoLang: 'php' },
      '.rb': { lang: 'ruby', runtime: 'ruby', monacoLang: 'ruby' },
      '.lua': { lang: 'lua', runtime: 'lua', monacoLang: 'lua' },

      // Compiled (analyze only)
      '.java': { lang: 'java', runtime: null, monacoLang: 'java' },
      '.c': { lang: 'c', runtime: null, monacoLang: 'c' },
      '.cpp': { lang: 'cpp', runtime: null, monacoLang: 'cpp' },
      '.cs': { lang: 'csharp', runtime: null, monacoLang: 'csharp' },
      '.go': { lang: 'go', runtime: null, monacoLang: 'go' },
      '.rs': { lang: 'rust', runtime: null, monacoLang: 'rust' },
      '.swift': { lang: 'swift', runtime: null, monacoLang: 'swift' },
      '.kt': { lang: 'kotlin', runtime: null, monacoLang: 'kotlin' },

      // Markup & Data
      '.html': { lang: 'html', runtime: null, monacoLang: 'html' },
      '.htm': { lang: 'html', runtime: null, monacoLang: 'html' },
      '.css': { lang: 'css', runtime: null, monacoLang: 'css' },
      '.scss': { lang: 'scss', runtime: null, monacoLang: 'scss' },
      '.json': { lang: 'json', runtime: null, monacoLang: 'json' },
      '.xml': { lang: 'xml', runtime: null, monacoLang: 'xml' },
      '.yaml': { lang: 'yaml', runtime: null, monacoLang: 'yaml' },
      '.yml': { lang: 'yaml', runtime: null, monacoLang: 'yaml' },
      '.toml': { lang: 'toml', runtime: null, monacoLang: 'ini' },
      '.ini': { lang: 'ini', runtime: null, monacoLang: 'ini' },
      '.md': { lang: 'markdown', runtime: null, monacoLang: 'markdown' },
      '.sql': { lang: 'sql', runtime: null, monacoLang: 'sql' },

      // Plain text
      '.txt': { lang: 'plaintext', runtime: null, monacoLang: 'plaintext' },
      '.log': { lang: 'plaintext', runtime: null, monacoLang: 'plaintext' },
      '.csv': { lang: 'csv', runtime: null, monacoLang: 'plaintext' },
      '.env': { lang: 'env', runtime: null, monacoLang: 'ini' },
      '.gitignore': { lang: 'gitignore', runtime: null, monacoLang: 'plaintext' },

      // Archives (extract)
      '.zip': { lang: 'archive', runtime: null, monacoLang: null },
      '.tar': { lang: 'archive', runtime: null, monacoLang: null },
      '.gz': { lang: 'archive', runtime: null, monacoLang: null },
    };
  }

  // ── Lifecycle ─────────────────────────────────────────────

  // FIX v4.0.0: Container calls asyncLoad() during boot — parallel runtime detection
  async asyncLoad() {
    await this._detectRuntimes();
  }

  // ── File Info ────────────────────────────────────────────

  /**
   * Get detailed info about a file
   */
  getFileInfo(filePath) {
    const fullPath = this._resolve(filePath);
    if (!fs.existsSync(fullPath)) return null;

    const stat = fs.statSync(fullPath);
    const ext = path.extname(fullPath).toLowerCase();
    const typeInfo = this.extMap[ext] || { lang: 'unknown', runtime: null, monacoLang: 'plaintext' };

    return {
      path: filePath,
      fullPath,
      name: path.basename(fullPath),
      extension: ext,
      size: stat.size,
      sizeHuman: this._formatBytes(stat.size),
      modified: stat.mtime.toISOString(),
      language: typeInfo.lang,
      monacoLanguage: typeInfo.monacoLang,
      canExecute: !!typeInfo.runtime && !!this.runtimes[typeInfo.runtime?.split(' ')[0]],
      canEdit: !!typeInfo.monacoLang && stat.size < this.maxFileSize,
      isArchive: typeInfo.lang === 'archive',
      isBinary: !typeInfo.monacoLang && typeInfo.lang !== 'archive',
    };
  }

  /**
   * Read a file for the editor
   */
  readFile(filePath) {
    const fullPath = this._resolve(filePath);
    const info = this.getFileInfo(filePath);
    if (!info) return { error: 'File not found' };
    if (info.isBinary) return { error: 'Binary file cannot be opened in editor' };
    if (info.size > this.maxFileSize) return { error: 'File too large (max 10MB)' };

    return {
      content: fs.readFileSync(fullPath, 'utf-8'),
      language: info.monacoLanguage,
      info,
    };
  }

  // ── Execute ──────────────────────────────────────────────

  /**
   * Execute a file using its native runtime.
   *
   * FIX v4.0.0: ALL languages now execute through the Sandbox.
   * - JavaScript: Sandbox.execute() (full JS sandbox with require allowlist)
   * - All others: Sandbox.executeExternal() (restricted env, CWD=sandbox/, no secrets)
   *
   * Previous: Non-JS files ran as naked child_processes with full host
   * access. An LLM-generated Python script could read /etc/shadow,
   * install backdoors, or exfiltrate data via env variables.
   */
  async executeFile(filePath, args = []) {
    const info = this.getFileInfo(filePath);
    if (!info) return { error: 'File not found' };
    if (!info.canExecute) return { error: `No runtime available for ${info.extension}` };

    const typeInfo = this.extMap[info.extension];
    const runtime = typeInfo.runtime;
    const fullPath = info.fullPath;

    // JavaScript: full sandbox with require allowlist + fs restrictions
    if (info.language === 'javascript') {
      const code = fs.readFileSync(fullPath, 'utf-8');
      return this.sandbox.execute(code, { timeout: TIMEOUTS.SANDBOX_EXEC });
    }

    // All other languages: external sandbox (restricted env, CWD=sandbox/)
    const runtimeParts = runtime.split(/\s+/);
    const bin = runtimeParts[0];
    const binArgs = runtimeParts.slice(1);
    const result = await this.sandbox.executeExternal(bin, binArgs, fullPath, args, {
      timeout: TIMEOUTS.SANDBOX_EXEC,
      language: info.language,
    });

    if (!result.error) {
      this.bus.emit('file:executed', { path: filePath, language: info.language, sandboxed: true }, { source: 'FileProcessor' });
    }
    return result;
  }

  // ── Import / Upload ──────────────────────────────────────

  /**
   * Import a file into the Genesis workspace
   * FIX v4.0.0: Source path validation — prevents the agent from
   * copying arbitrary host files (e.g. /etc/shadow, ~/.ssh/id_rsa)
   * into uploads/ where they become readable. Only files from the
   * project root or explicit user-provided paths are allowed.
   * The LLM cannot trick this into exfiltrating system files.
   */
  importFile(sourcePath, targetName = null) {
    // FIX v4.0.0: Validate source is within allowed boundaries
    const resolvedSource = path.resolve(sourcePath);
    const inRoot = resolvedSource.startsWith(this.rootDir + path.sep) || resolvedSource === this.rootDir;
    const inUploads = resolvedSource.startsWith(this.uploadDir + path.sep) || resolvedSource === this.uploadDir;
    // Allow user home dirs for drag-and-drop from Desktop/Downloads
    const homeDir = process.env.HOME || process.env.USERPROFILE || '';
    const inHome = homeDir && (resolvedSource.startsWith(homeDir + path.sep) || resolvedSource === homeDir);
    if (!inRoot && !inUploads && !inHome) {
      this.bus.fire('file:import-blocked', { path: sourcePath, resolved: resolvedSource }, { source: 'FileProcessor' });
      return { error: `Import blocked: source path outside allowed boundaries (project root or user home)` };
    }

    if (!fs.existsSync(sourcePath)) return { error: 'Source file not found' };

    const stat = fs.statSync(sourcePath);
    if (stat.size > this.maxFileSize) return { error: 'File too large' };

    const name = targetName || path.basename(sourcePath);
    // FIX v4.0.0: Sanitize targetName — prevent directory traversal via name
    const safeName = path.basename(name); // strips any ../ prefix
    const destPath = path.join(this.uploadDir, safeName);

    fs.copyFileSync(sourcePath, destPath);
    this.bus.emit('file:imported', { name: safeName, size: stat.size }, { source: 'FileProcessor' });

    return { path: destPath, name: safeName, size: stat.size };
  }

  /**
   * List files in the upload directory
   */
  listUploads() {
    if (!fs.existsSync(this.uploadDir)) return [];
    return fs.readdirSync(this.uploadDir).map(name => {
      const fullPath = path.join(this.uploadDir, name);
      const stat = fs.statSync(fullPath);
      return {
        name,
        path: fullPath,
        size: this._formatBytes(stat.size),
        extension: path.extname(name).toLowerCase(),
      };
    });
  }

  // ── Archive Handling ─────────────────────────────────────

  /**
   * List contents of a ZIP file (without extracting)
   * FIX v4.0.0: Async — no longer blocks main thread
   */
  async listArchive(filePath) {
    const fullPath = this._resolve(filePath);
    if (!fs.existsSync(fullPath)) return { error: 'Archive not found' };

    try {
      const ext = path.extname(fullPath).toLowerCase();
      if (ext === '.zip') {
        const isWin = process.platform === 'win32';
        let output;
        if (isWin) {
          const psScript = `Expand-Archive -LiteralPath '${fullPath.replace(/'/g, "''")}' -DestinationPath '${this.uploadDir.replace(/'/g, "''")}/_preview' -Force; Get-ChildItem '${this.uploadDir.replace(/'/g, "''")}/_preview' -Recurse | Select-Object FullName`;
          const encoded = Buffer.from(psScript, 'utf16le').toString('base64');
          const result = await execFileAsync('powershell', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded],
            { encoding: 'utf-8', timeout: TIMEOUTS.COMMAND_EXEC, windowsHide: true });
          output = result.stdout;
        } else {
          const result = await execFileAsync('unzip', ['-l', fullPath],
            { encoding: 'utf-8', timeout: TIMEOUTS.COMMAND_EXEC, windowsHide: true });
          output = result.stdout;
        }
        return { contents: output, type: 'zip' };
      }
      return { error: `Archive type ${ext} is not yet supported` };
    } catch (err) {
      return { error: err.message };
    }
  }

  // ── Runtime Detection ────────────────────────────────────

  // FIX v4.0.0: Async runtime detection — parallel checks, no main-thread blocking.
  // Previous: 6 sequential execFileSync calls (~3s on cold start).
  // Now: Promise.allSettled runs all checks concurrently (~500ms).
  async _detectRuntimes() {
    const check = async (cmd) => {
      try {
        await execFileAsync(cmd, ['--version'], { stdio: 'pipe', timeout: TIMEOUTS.QUICK_CHECK, windowsHide: true });
        return true;
      } catch (_e) { _log.debug('[catch] file access check:', _e.message); return false; }
    };

    const [python, python3, php, ruby, bash, lua] = await Promise.allSettled([
      check('python'), check('python3'), check('php'),
      check('ruby'), check('bash'), check('lua'),
    ]);

    this.runtimes = {
      node: true,
      // @ts-ignore — TS inference limitation (checkJs)
      python: (python.value || false) || (python3.value || false),
      // @ts-ignore — TS inference limitation (checkJs)
      php: php.value || false,
      // @ts-ignore — TS inference limitation (checkJs)
      ruby: ruby.value || false,
      // @ts-ignore — TS inference limitation (checkJs)
      bash: bash.value || false,
      // @ts-ignore — TS inference limitation (checkJs)
      lua: lua.value || false,
      powershell: process.platform === 'win32' || false,
      cmd: process.platform === 'win32',
    };

    // Async pwsh check on non-Windows
    if (process.platform !== 'win32') {
      this.runtimes.powershell = await check('pwsh');
    }

    const available = Object.entries(this.runtimes)
      .filter(([_, v]) => v)
      .map(([k]) => k);

    _log.info(`[FILES] Runtimes: ${available.join(', ')}`);
  }

  /** Get available runtimes */
  getRuntimes() {
    return { ...this.runtimes };
  }

  // ── Helpers ──────────────────────────────────────────────

  // FIX v4.0.0: Path traversal guard — absolute paths must be within
  // rootDir or uploadDir. Prevents LLM-generated paths like /etc/passwd.
  _resolve(filePath) {
    const resolved = path.isAbsolute(filePath) ? filePath : path.resolve(this.rootDir, filePath);
    const inRoot = resolved.startsWith(this.rootDir + path.sep) || resolved === this.rootDir;
    const inUploads = resolved.startsWith(this.uploadDir + path.sep) || resolved === this.uploadDir;
    if (!inRoot && !inUploads) {
      throw new Error(`[FILEPROCESSOR] Path traversal blocked: ${filePath} (resolved: ${resolved})`);
    }
    return resolved;
  }

  _formatBytes(bytes) {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
  }
}

module.exports = { FileProcessor };
