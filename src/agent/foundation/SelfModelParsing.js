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

// v7.9.23: lazy acorn loader (npm, then kernel-vendored fallback) for AST-based require
// extraction — same dual-path pattern as CodeSafetyScanner / VerificationEngine.
let _acornMod = null;
let _acornTried = false;
function _getAcorn() {
  if (_acornTried) return _acornMod;
  _acornTried = true;
  try { _acornMod = require('acorn'); return _acornMod; } catch (_e) { /* try vendored copy */ }
  try { _acornMod = require(path.resolve(__dirname, '../../kernel/vendor/acorn.js')); } catch (_e2) { _acornMod = null; }
  return _acornMod;
}

// v7.9.23: recursive AST walk collecting require('<string literal>') call targets. Comments are not
// in the AST and template *text* (quasis) is not a CallExpression, so both are ignored automatically;
// a require inside a ${...} interpolation is real code and is kept.
function _collectRequires(root, out) {
  const stack = [root];
  while (stack.length) {
    const node = stack.pop();
    if (!node || typeof node !== 'object') continue;
    if (node.type === 'CallExpression' && node.callee && node.callee.name === 'require'
        && Array.isArray(node.arguments) && node.arguments.length === 1) {
      const arg = node.arguments[0];
      if (arg && arg.type === 'Literal' && typeof arg.value === 'string') out.push(arg.value);
    }
    for (const key in node) {
      if (key === 'type' || key === 'start' || key === 'end' || key === 'loc' || key === 'range') continue;
      const val = node[key];
      if (!val || typeof val !== 'object') continue;
      if (Array.isArray(val)) { for (const c of val) if (c && typeof c === 'object') stack.push(c); }
      else stack.push(val);
    }
  }
}

// v7.9.23: regex fallback — the previous line-by-line scan, used only when acorn is unavailable or
// the source does not parse. Same false-positive profile as before (no regression).
function _regexExtractRequires(code, out) {
  const codeNoBlock = code.replace(/\/\*[\s\S]*?\*\//g, '');
  for (const rawLine of codeNoBlock.split('\n')) {
    const codePart = rawLine.replace(/('(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"|`(?:[^`\\]|\\.)*`)|\/\/.*$/g, (m, s) => s || '');
    const detect = codePart
      .replace(/'(?:[^'\\]|\\.)*'/g, "''")
      .replace(/"(?:[^"\\]|\\.)*"/g, '""')
      .replace(/`(?:[^`\\]|\\.)*`/g, '``');
    if (/\brequire\s*\(/.test(detect)) {
      for (const m of codePart.matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)) out.push(m[1]);
    }
  }
}

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

    // v7.9.23: prefer the acorn AST so a require() that only appears as *text* inside a multi-line
    // template literal (e.g. the fenced require('./Foo') in ASTDiff's prompt string) is no longer
    // miscounted as a real dependency — that false positive inflated the coupling count and produced
    // a spurious daemon-health flag every cycle. The walk keeps requires inside ${...} interpolations
    // (real code, e.g. CoreMemories loading ./SignificanceDetector) and drops template text. Comments
    // are not in the AST. On no-acorn or a parse failure, fall back to the previous regex scan.
    const _acorn = _getAcorn();
    let _astOk = false;
    if (_acorn) {
      try {
        const _ast = _acorn.parse(code, { ecmaVersion: 'latest', allowReturnOutsideFunction: true, allowHashBang: true });
        _collectRequires(_ast, info.requires);
        _astOk = true;
      } catch (_e) { _astOk = false; }
    }
    if (!_astOk) _regexExtractRequires(code, info.requires);

    // Extract exports
    const expMatch = code.match(/module\.exports\s*=\s*{([^}]+)}/);
    if (expMatch) {
      info.exports = expMatch[1].split(',').map(s => s.trim()).filter(Boolean);
    }

    return info;
  },
};

module.exports = { selfModelParsing };
