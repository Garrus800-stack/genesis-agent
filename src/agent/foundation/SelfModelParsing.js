// ============================================================
// GENESIS — SelfModelParsing.js (v7.4.1)
//
// Extracted from SelfModel.js to keep the main file under the
// 700-LOC threshold. Contains filesystem scanning and module
// parsing methods:
//   - _scanDirAsync  — async directory walker (boot-time)
//   - _scanDir       — sync directory walker (legacy compat)
//   - _parseModule   — extract classes, functions, requires, exports
//
// Same pattern as PromptBuilderSections → PromptBuilderSectionsExtra:
// prototype delegation from the bottom of SelfModel.js.
// External API unchanged.
// ============================================================

'use strict';

const path = require('path');
const fs = require('fs');
const fsp = require('fs').promises;
const crypto = require('crypto');
const { createLogger } = require('../core/Logger');
const _log = createLogger('SelfModel');

// v7.9.21: directory names the self-model scan never descends into. The
// named dirs are skipped at any depth. 'snapshots' is handled separately
// (root-scoped, below): it is SnapshotManager's habitat copy of the source
// tree (SnapshotManager.SNAPSHOT_DIR), not modelled source — descending it
// modelled every source module twice.
const _SCAN_SKIP_DIRS = new Set(['node_modules', 'sandbox', 'dist', 'vendor', '.genesis-backups']);

const selfModelParsing = {

  // FIX v3.8.0: Async directory scan — replaces sync _scanDir().
  // Uses fs.promises to avoid blocking the main thread during boot.
  // On a 100+ module project, sync scan blocked for ~50-80ms.
  async _scanDirAsync(dir, relativeBase) {
    let entries;
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch (err) {
      _log.debug('[catch] _scanDirAsync readdir:', err.message);
      return;
    }

    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      if (_SCAN_SKIP_DIRS.has(entry.name)) continue;
      // v7.9.21: root-scoped skip of SnapshotManager's habitat copy
      // (<rootDir>/snapshots/, SnapshotManager.SNAPSHOT_DIR). It mirrors the
      // whole source tree, so descending it modelled every module twice. A
      // nested dir named 'snapshots' stays (relativeBase === '' only at root).
      if (relativeBase === '' && entry.name === 'snapshots') continue;

      const fullPath = path.join(dir, entry.name);
      const relativePath = path.join(relativeBase, entry.name);

      if (entry.isDirectory()) {
        await this._scanDirAsync(fullPath, relativePath);
      } else if (entry.name.endsWith('.js') || entry.name.endsWith('.mjs')) {
        try {
          const content = await fsp.readFile(fullPath, 'utf-8');
          const lines = content.split('\n').length;

          // Hash for integrity checks
          const hash = crypto.createHash('sha256').update(content).digest('hex').slice(0, 16);

          this.manifest.files[relativePath] = {
            lines,
            hash,
            protected: this.guard?.isProtected(fullPath) || false,
          };

          // Parse module structure
          this.manifest.modules[relativePath] = this._parseModule(content, relativePath);
        } catch (err) {
          _log.debug('[catch] scan file', relativePath, ':', err.message);
        }
      }
    }
  },

  _scanDir(dir, relativeBase) {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (err) {
      _log.debug('[catch] _scanDir readdir:', err.message);
      return;
    }

    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      if (_SCAN_SKIP_DIRS.has(entry.name)) continue;
      // v7.9.21: root-scoped skip of SnapshotManager's habitat copy
      // (<rootDir>/snapshots/, SnapshotManager.SNAPSHOT_DIR). It mirrors the
      // whole source tree, so descending it modelled every module twice. A
      // nested dir named 'snapshots' stays (relativeBase === '' only at root).
      if (relativeBase === '' && entry.name === 'snapshots') continue;

      const fullPath = path.join(dir, entry.name);
      const relativePath = path.join(relativeBase, entry.name);

      if (entry.isDirectory()) {
        this._scanDir(fullPath, relativePath);
      } else if (entry.name.endsWith('.js') || entry.name.endsWith('.mjs')) {
        try {
          const content = fs.readFileSync(fullPath, 'utf-8');
          const lines = content.split('\n').length;
          const hash = crypto.createHash('sha256').update(content).digest('hex').slice(0, 16);

          this.manifest.files[relativePath] = {
            lines,
            hash,
            protected: this.guard?.isProtected(fullPath) || false,
          };

          this.manifest.modules[relativePath] = this._parseModule(content, relativePath);
        } catch (err) {
          _log.debug('[catch] scan file', relativePath, ':', err.message);
        }
      }
    }
  },

  _parseModule(code, filePath) {
    const info = {
      file: filePath,
      /** @type {string[]} */ classes: [],
      /** @type {string[]} */ functions: [],
      /** @type {string[]} */ exports: [],
      /** @type {string[]} */ requires: [],
      description: '',
    };

    // Extract header comment as description
    const headerMatch = code.match(/^\/\/[^\n]*\n(?:\/\/[^\n]*\n)*/);
    if (headerMatch) {
      info.description = headerMatch[0]
        .split('\n')
        .map(l => l.replace(/^\/\/\s*/, '').replace(/=+/g, '').trim())
        .filter(l => l && !l.startsWith('GENESIS'))
        .join(' ')
        .trim();
    }

    // Extract class names
    // v7.3.3 fix: Strip strings and comments first so class names inside a
    // string literal or comment (e.g. acorn's "class enum extends super") are
    // not mistaken for real class declarations.
    const JS_RESERVED_AND_NOISE = new Set([
      'enum', 'extends', 'super', 'static', 'const', 'let', 'var',
      'function', 'return', 'if', 'else', 'for', 'while', 'do', 'switch',
      'case', 'break', 'continue', 'default', 'typeof', 'instanceof',
      'new', 'delete', 'void', 'yield', 'async', 'await', 'true', 'false',
      'null', 'undefined', 'this', 'try', 'catch', 'finally', 'throw',
      'import', 'export', 'from', 'as', 'of', 'in',
      'method', 'field', 'getters', 'identifiers', 'escape', 'declaration',
      'definition', 'double', 'size', 'names', 'name', 'may', 'matching',
      'rolling', 'found', 'foo', 'bar', 'baz', 'to', 'for', 'into',
      'skillname', 'mycomponent', '_unsafe_html', 'genesiselement',
    ]);
    let codeStripped = code.replace(/\/\*[\s\S]*?\*\//g, '');
    codeStripped = codeStripped.split('\n').map((line) => {
      return line
        .replace(/\/\/[^\n]*$/, '')
        .replace(/'(?:[^'\\]|\\.)*'/g, "''")
        .replace(/"(?:[^"\\]|\\.)*"/g, '""');
    }).join('\n');
    const classMatches = codeStripped.matchAll(/\bclass\s+([A-Z]\w*)/g);
    for (const m of classMatches) {
      const name = m[1];
      if (!JS_RESERVED_AND_NOISE.has(name.toLowerCase()) && /^[A-Z]/.test(name)) {
        info.classes.push(name);
      }
    }

    // Extract function names (top-level and method-like)
    const fnMatches = code.matchAll(/(?:async\s+)?(\w+)\s*\([^)]*\)\s*{/g);
    for (const m of fnMatches) {
      if (!['if', 'for', 'while', 'switch', 'catch'].includes(m[1])) {
        info.functions.push(m[1]);
      }
    }

    // Extract requires — ignore those inside comments and string literals.
    // v7.9.21: a require(...) inside a comment was previously captured (the
    // detection blanked strings but never comments, and the capture ran on the
    // raw line), so a commented-out require produced a false missing-dependency
    // and inflated the coupling count. Strip block comments from the whole
    // source, then strip each line's line-comment while keeping strings intact
    // (a "//" inside 'http://x' must not truncate the line). Detect on a
    // string-blanked copy so a require( inside a string is still ignored;
    // capture on the comment-stripped, string-intact line.
    const codeNoBlock = code.replace(/\/\*[\s\S]*?\*\//g, '');
    for (const rawLine of codeNoBlock.split('\n')) {
      const codePart = rawLine.replace(/('(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"|`(?:[^`\\]|\\.)*`)|\/\/.*$/g, (m, s) => s || '');
      const detect = codePart
        .replace(/'(?:[^'\\]|\\.)*'/g, "''")
        .replace(/"(?:[^"\\]|\\.)*"/g, '""')
        .replace(/`(?:[^`\\]|\\.)*`/g, '``');
      if (/\brequire\s*\(/.test(detect)) {
        for (const m of codePart.matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)) info.requires.push(m[1]);
      }
    }

    // Extract exports
    const expMatch = code.match(/module\.exports\s*=\s*{([^}]+)}/);
    if (expMatch) {
      info.exports = expMatch[1].split(',').map(s => s.trim()).filter(Boolean);
    }

    return info;
  },
};

module.exports = { selfModelParsing };
