// @ts-checked-v7.8.4
// ============================================================
// GENESIS — CleanupVerifier.js (v7.8.4)
//
// Pre-deletion audit capability. Before a file is deleted —
// either by Genesis himself in an autonomous cleanup or by a
// user-issued /cleanup-check command — this verifier scans the
// repository to flag risks that should be reviewed first.
//
// Finding kinds emitted:
//   - 'importers'             — other files that require/import this one
//   - 'identical-siblings'    — files with identical content elsewhere
//   - 'sibling-name-matches'  — files with the same basename in other dirs
//   - 'entrypoint-pattern'    — looks like an entry point (index/main/preload)
//
// Safe deletion requires: no importers, no entrypoint-pattern.
// Identical siblings and sibling-name-matches are informational —
// they may indicate legitimate parallel implementations (CJS+ESM,
// platform-specific files) and need human judgment.
//
// Caveat (documented in CLEANUP-PROTOCOL.md): dynamic require/import
// patterns like `require(varName)` or `import(expr)` are NOT detected.
// The verifier is an advisor; the final decision stays with Genesis
// or the user.
// ============================================================

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { createLogger } = require('../core/Logger');
const _log = createLogger('CleanupVerifier');

// Files that look like entry points — deleting one of these is
// almost certainly unsafe even if no static importer is found.
const ENTRYPOINT_NAMES = new Set([
  'index.js', 'main.js', 'preload.js', 'preload.mjs',
  'package.json', 'cli.js', 'demo.js',
]);

// Extensions we bother scanning for import references.
const SCANNED_EXTENSIONS = new Set(['.js', '.mjs', '.cjs', '.ts', '.json']);

// Directories we never recurse into (cheap allowlist).
const SKIP_DIRS = new Set([
  'node_modules', '.git', 'dist', 'coverage', '.genesis',
  '.nyc_output', 'release', 'tmp',
]);

class CleanupVerifier {
  /**
   * @param {object} deps
   * @param {string} deps.rootDir - project root
   * @param {object} [deps.bus] - EventBus for telemetry; optional
   */
  constructor({ rootDir, bus } = {}) {
    if (!rootDir) throw new Error('CleanupVerifier requires rootDir');
    this._rootDir = rootDir;
    this._bus = bus || null;
  }

  /**
   * Run the full audit on a target file.
   *
   * @param {string} relPath - path relative to rootDir
   * @returns {Promise<{safe: boolean, findings: Array, target: string}>}
   */
  async verify(relPath) {
    if (typeof relPath !== 'string' || !relPath.trim()) {
      throw new Error('verify() requires a non-empty relative path');
    }
    const target = relPath.replace(/^[/\\]+/, '');
    const fullPath = path.join(this._rootDir, target);

    if (!fs.existsSync(fullPath)) {
      return {
        safe: false,
        target,
        findings: [{ kind: 'not-found', message: `target file does not exist: ${target}` }],
      };
    }

    const stat = fs.statSync(fullPath);
    if (stat.isDirectory()) {
      return {
        safe: false,
        target,
        findings: [{ kind: 'is-directory', message: `target is a directory, not a file: ${target}` }],
      };
    }

    const findings = [];

    // 1. Entrypoint pattern
    const basename = path.basename(target);
    if (ENTRYPOINT_NAMES.has(basename)) {
      findings.push({
        kind: 'entrypoint-pattern',
        message: `basename "${basename}" matches a known entry-point pattern`,
      });
    }

    // 2. Importer scan
    const importers = this._findImporters(target);
    if (importers.length > 0) {
      findings.push({
        kind: 'importers',
        count: importers.length,
        refs: importers.slice(0, 25), // cap for sanity
        message: `${importers.length} file(s) statically import this`,
      });
    }

    // 3. Identical-content siblings (hash compare)
    const ownHash = this._hashFile(fullPath);
    const identical = this._findIdenticalFiles(target, ownHash);
    if (identical.length > 0) {
      findings.push({
        kind: 'identical-siblings',
        count: identical.length,
        paths: identical,
        message: `${identical.length} file(s) elsewhere have byte-identical content`,
      });
    }

    // 4. Same-basename siblings (heuristic — flags possible duplicates)
    const nameMatches = this._findNameMatches(target, basename);
    if (nameMatches.length > 0) {
      findings.push({
        kind: 'sibling-name-matches',
        count: nameMatches.length,
        paths: nameMatches,
        message: `${nameMatches.length} file(s) share the basename "${basename}" in other directories`,
      });
    }

    const safe = !findings.some(
      (f) => f.kind === 'importers' || f.kind === 'entrypoint-pattern'
    );

    if (this._bus) {
      try {
        this._bus.fire('cleanup-verifier:scan-complete', {
          target,
          safe,
          findingKinds: findings.map((f) => f.kind),
          findingCount: findings.length,
        }, { source: 'CleanupVerifier' });
      } catch (_e) { /* telemetry must not throw */ }
    }

    return { safe, target, findings };
  }

  // ── helpers ────────────────────────────────────────────

  /** Find files that statically import the target via require()/import. */
  _findImporters(targetRel) {
    const basename = path.basename(targetRel, path.extname(targetRel));
    const importers = [];
    // Build regexes that match relative require/import of this file.
    // We accept: require('./foo'), require('../bar/foo'), require('./foo.js')
    // and the import-from equivalents.
    const escapedBase = basename.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const requirePattern = new RegExp(
      `(?:require\\s*\\(\\s*|from\\s+|import\\s*\\(\\s*)['"]([./\\\\][^'"\\n]*${escapedBase})(?:\\.[a-zA-Z]+)?['"]`,
      'g'
    );

    const targetFullPath = path.resolve(this._rootDir, targetRel);

    this._walk(this._rootDir, (filePath) => {
      // Don't count the target referencing itself
      if (path.resolve(filePath) === targetFullPath) return;
      // Only scan source files
      if (!SCANNED_EXTENSIONS.has(path.extname(filePath))) return;

      let content;
      try {
        content = fs.readFileSync(filePath, 'utf-8');
      } catch (_e) { return; }

      requirePattern.lastIndex = 0;
      let m;
      while ((m = requirePattern.exec(content)) !== null) {
        // Resolve the relative path from the importer's directory and
        // see if it points at our target. We compare resolved absolute
        // paths with optional extensions.
        const importerDir = path.dirname(filePath);
        const referencedRaw = m[1];
        const candidates = [
          referencedRaw,
          `${referencedRaw}.js`,
          `${referencedRaw}.mjs`,
          `${referencedRaw}.cjs`,
          `${referencedRaw}.json`,
          path.join(referencedRaw, 'index.js'),
        ];
        for (const candidate of candidates) {
          try {
            const resolved = path.resolve(importerDir, candidate);
            if (resolved === targetFullPath) {
              importers.push(path.relative(this._rootDir, filePath));
              break;
            }
          } catch (_e) { /* path.resolve can throw on weird input */ }
        }
      }
    });

    return [...new Set(importers)].sort();
  }

  _findIdenticalFiles(targetRel, targetHash) {
    if (!targetHash) return [];
    const matches = [];
    const targetFullPath = path.resolve(this._rootDir, targetRel);

    this._walk(this._rootDir, (filePath) => {
      if (path.resolve(filePath) === targetFullPath) return;
      if (!SCANNED_EXTENSIONS.has(path.extname(filePath))) return;
      const h = this._hashFile(filePath);
      if (h === targetHash) {
        matches.push(path.relative(this._rootDir, filePath));
      }
    });
    return matches.sort();
  }

  _findNameMatches(targetRel, basename) {
    const matches = [];
    const targetFullPath = path.resolve(this._rootDir, targetRel);
    this._walk(this._rootDir, (filePath) => {
      if (path.resolve(filePath) === targetFullPath) return;
      if (path.basename(filePath) !== basename) return;
      matches.push(path.relative(this._rootDir, filePath));
    });
    return matches.sort();
  }

  _hashFile(fullPath) {
    try {
      const data = fs.readFileSync(fullPath);
      return crypto.createHash('sha256').update(data).digest('hex');
    } catch (_e) {
      return null;
    }
  }

  _walk(dir, visitor) {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (_e) { return; }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name) || entry.name.startsWith('.')) continue;
        this._walk(path.join(dir, entry.name), visitor);
      } else if (entry.isFile()) {
        visitor(path.join(dir, entry.name));
      }
    }
  }
}

module.exports = { CleanupVerifier, ENTRYPOINT_NAMES };
