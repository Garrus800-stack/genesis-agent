// ============================================================
// GENESIS — ChatOrchestratorSourceRead.js (v7.3.9)
//
// Extracted from ChatOrchestrator.js to keep the main file under
// the 700-LOC threshold. Contains the v7.3.8 synchronous source-
// read methods:
//   - _maybeReadSourceSync — main entry, called from handleChat
//   - _rootDir              — project root resolution
//   - _readSourceCached     — mtime-based cache wrapper
//   - _readChangelogLatestSection — CHANGELOG section extraction
//   - _readPackageVersion   — package.json version field
//
// Same pattern as ChatOrchestratorHelpers.js — prototype
// delegation from the bottom of ChatOrchestrator.js. External
// API unchanged.
// ============================================================

const fs = require('fs');
const path = require('path');
const { createLogger } = require('../core/Logger');
const _log = createLogger('ChatOrchestrator');

const sourceRead = {

  /**
   * v7.3.8: If the user query matches one of the known source-file
   * patterns, read the file synchronously and attach its content to
   * the prompt. This gives the LLM actual ground-truth instead of
   * relying on a hint it might ignore.
   *
   * Runs BEFORE _generalChat. Sets this._lastSourceReadAttempted for
   * chat:llm-failure payload observability.
   *
   * Sources are cached in-memory with mtime-based invalidation.
   *
   * @param {string} message
   * @param {object} intent
   */
  _maybeReadSourceSync(message, intent) {
    // Clear previous turn's state
    if (this.promptBuilder?.clearSourceContent) {
      this.promptBuilder.clearSourceContent();
    }
    this._lastSourceReadAttempted = false;

    if (!this.promptBuilder?.attachSourceContent) return;
    if (intent.type !== 'general') return;
    if (typeof message !== 'string') return;

    const lower = message.toLowerCase();
    const rootDir = this._rootDir();

    // Pattern 1: "was hat sich geändert" / "was ist neu" → CHANGELOG.md
    if (/was\s+(hat\s+sich|ist\s+neu|gibt.*neu)/.test(lower)) {
      const section = this._readChangelogLatestSection(path.join(rootDir, 'CHANGELOG.md'));
      if (section) {
        this.promptBuilder.attachSourceContent({
          content: section,
          label: 'CHANGELOG.md (neuester Versions-Abschnitt)',
        });
        this._lastSourceReadAttempted = true;
      }
      return;
    }

    // Pattern 2: "welche version" → package.json version field
    if (/welche?\s+version|aktuelle\s+version/.test(lower)) {
      const version = this._readPackageVersion(path.join(rootDir, 'package.json'));
      if (version) {
        this.promptBuilder.attachSourceContent({
          content: `"version": "${version}"`,
          label: 'package.json',
        });
        this._lastSourceReadAttempted = true;
      }
    }
  },

  /**
   * Compute the project root directory. Prefers explicit storageDir,
   * falls back to cwd.
   */
  _rootDir() {
    if (this._cachedRootDir) return this._cachedRootDir;
    // storageDir points to .genesis/, root is one level up
    const candidate = this.storage?.baseDir
      ? path.dirname(this.storage.baseDir)
      : process.cwd();
    this._cachedRootDir = candidate;
    return candidate;
  },

  /**
   * Read a file with mtime-based caching. Returns string or null on any error.
   */
  _readSourceCached(filePath) {
    if (!this._sourceReadCache) this._sourceReadCache = new Map();
    try {
      const stat = fs.statSync(filePath);
      const cached = this._sourceReadCache.get(filePath);
      if (cached && cached.mtimeMs === stat.mtimeMs) {
        return cached.content;
      }
      const content = fs.readFileSync(filePath, 'utf8');
      this._sourceReadCache.set(filePath, { content, mtimeMs: stat.mtimeMs });
      return content;
    } catch (e) {
      _log.debug('[CHAT] Source read failed:', filePath, '—', e.message);
      return null;
    }
  },

  /**
   * Extract the latest version section from CHANGELOG.md: from the first
   * ## [x.y.z] header to the second (exclusive). If only one header
   * exists, extract to end of file.
   *
   * Truncates to 6000 chars if longer, with a hint about further content.
   */
  _readChangelogLatestSection(filePath) {
    const full = this._readSourceCached(filePath);
    if (!full) return null;

    // Match headers like ## [7.3.8] or ## [7.3.8] — "title"
    const headerRegex = /^## \[/gm;
    const headers = [];
    let match;
    while ((match = headerRegex.exec(full)) !== null) {
      headers.push(match.index);
      if (headers.length >= 2) break;
    }

    if (headers.length === 0) return null;  // no version headers found
    const start = headers[0];
    const end = headers[1] !== undefined ? headers[1] : full.length;
    let section = full.slice(start, end).trim();

    const MAX_LENGTH = 6000;
    if (section.length > MAX_LENGTH) {
      section = section.slice(0, MAX_LENGTH)
        + '\n\n[Gekürzt — ganze Datei ist CHANGELOG.md, weitere Abschnitte am Ende.]';
    }
    return section;
  },

  /**
   * Extract the version field from package.json. Returns the version
   * string or null on any error (including JSON parse failure).
   */
  _readPackageVersion(filePath) {
    const full = this._readSourceCached(filePath);
    if (!full) return null;
    try {
      const pkg = JSON.parse(full);
      return typeof pkg.version === 'string' ? pkg.version : null;
    } catch (e) {
      _log.debug('[CHAT] package.json parse failed:', e.message);
      return null;
    }
  }

};

module.exports = { sourceRead };
