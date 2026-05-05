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

    // v7.5.9 ZIP2 v3 (Bug 5 companion): some chat UIs auto-convert
    // filename mentions into markdown-link syntax — e.g. "ONTOGENESIS.md"
    // becomes "[ONTOGENESIS.md](http://ONTOGENESIS.md)". Strip those
    // before pattern-matching so the regex still sees the bare filename.
    const lowerStripped = lower.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1');

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
      return;
    }

    // v7.5.9 ZIP2 Phase 2: file-content patterns. The user names a file
    // explicitly ("fasse README zusammen", "lies ONTOGENESIS.md", "was
    // steht in package.json"). Resolve via _resolveFileWithVariants so
    // case/extension typos still hit. False-positive guard: pattern
    // requires a filename-capture group; if no name is captured, skip.
    const fileSummaryMatch = lowerStripped.match(
      /(?:f?ass(?:e|t)?|summ(?:arize|ar(?:y|isiere))|lies|read|zeig(?:e)?(?:\s+mir)?|show)\s+(?:mir\s+)?(?:die\s+|den\s+|das\s+|the\s+)?(?:datei\s+)?([\w][\w\s.-]*?\.(?:md|txt|json|js|ts|yaml|yml|toml|html|css))(?:\s|\b|$)/i
    ) || lowerStripped.match(
      /(?:f?ass(?:e|t)?|lies|summ\w*)\s+(?:mir\s+)?(?:die\s+|den\s+)?([a-z][a-z0-9_-]{2,40})\s+(?:zusammen|durch)/i
    ) || lowerStripped.match(
      /was\s+steht\s+in\s+(?:der\s+)?(?:datei\s+)?([\w][\w\s.-]*?(?:\.\w+)?)\b/i
    );
    if (fileSummaryMatch) {
      const requestedName = fileSummaryMatch[1].trim();
      // Resolve via SelfModelSourceRead's variant helper — this also walks
      // into docs/ for doc-like names (README, ONTOGENESIS, ARCHITECTURE).
      // The helper is exported from SelfModelSourceRead.js (v7.5.9).
      try {
        const { _resolveFileWithVariants } = require('../foundation/SelfModelSourceRead');
        const candidate = path.isAbsolute(requestedName)
          ? requestedName
          : path.join(rootDir, requestedName);
        const resolved = _resolveFileWithVariants(candidate, rootDir);
        if (resolved) {
          // Use the source-read tool path to honor budget + caching.
          if (this.selfModel?.readSourceSync) {
            const relPath = path.relative(rootDir, resolved);
            const content = this.selfModel.readSourceSync(relPath, { bus: this.bus });
            if (content) {
              this.promptBuilder.attachSourceContent({
                content,
                label: relPath,
              });
              this._lastSourceReadAttempted = true;
              return;
            }
          }
        }
        // No match found — leave a hint so the LLM doesn't confabulate.
        this.promptBuilder.attachSourceContent({
          content: `[Note: file "${requestedName}" not found in project. Available top-level files include README.md, CHANGELOG.md, AUDIT-BACKLOG.md, package.json. The docs/ directory contains ONTOGENESIS.md and others.]`,
          label: 'file-not-found',
        });
        this._lastSourceReadAttempted = true;
      } catch (err) {
        _log.debug('[CHAT] Phase 2 file-summary pattern failed:', err.message);
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
