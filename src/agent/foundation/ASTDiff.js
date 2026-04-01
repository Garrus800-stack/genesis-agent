// @ts-checked-v5.6
// ============================================================
// GENESIS — ASTDiff.js
// Precise code modification using lightweight AST parsing.
//
// Instead of: "rewrite the entire file"
// Now: "change function X, add parameter Y, remove line Z"
//
// Benefits:
// - LLM generates less code = fewer errors on small models
// - Precise rollback (undo one change, not entire file)
// - Explainable: "I changed foo() to accept a timeout param"
// ============================================================

const { NullBus } = require('../core/EventBus');

class ASTDiff {
  /** @param {{ bus?: import('../core/EventBus').EventBus }} [opts] */
  constructor({ bus } = {}) {
    this.bus = bus || NullBus;
    // Supported diff operations
    this.operations = ['replace-function', 'add-function', 'remove-function',
      'replace-line', 'insert-after', 'insert-before', 'delete-lines',
      'rename', 'add-parameter', 'wrap-try-catch', 'add-import'];
  }

  /**
   * Apply a structured diff to source code
   * @param {string} source - Original source code
   * @param {Array<object>} diffs - Array of diff operations
   * @returns {{ code: string, applied: number, errors: string[] }}
   */
  apply(source, diffs) {
    let code = source;
    let applied = 0;
    const errors = [];

    for (const diff of diffs) {
      try {
        const result = this._applyOne(code, diff);
        if (result !== null) {
          code = result;
          applied++;
        } else {
          errors.push(`${diff.op}: target not found`);
        }
      } catch (err) {
        errors.push(`${diff.op}: ${err.message}`);
      }
    }

    return { code, applied, errors };
  }

  /**
   * Generate a diff prompt for the LLM
   * Instead of "rewrite the file", ask for structured changes
   */
  buildDiffPrompt(targetFile, code, changeDescription) {
    return `You are Genesis. Describe the change as structured diff operations.

FILE: ${targetFile}

CODE (excerpt):
\`\`\`javascript
${code.slice(0, 2500)}
\`\`\`

DESIRED CHANGE: ${changeDescription}

Respond with ONE or more operations in this format:

OP: replace-function
TARGET: functionName
CODE:
\`\`\`
new function code
\`\`\`

OP: add-function
AFTER: existingFunction
CODE:
\`\`\`
function newFunction() { ... }
\`\`\`

OP: insert-after
LINE: "exact text of the line"
CODE:
\`\`\`
new line(s)
\`\`\`

OP: add-import
CODE:
\`\`\`
const { Foo } = require('./Foo');
\`\`\`

OP: rename
OLD: oldName
NEW: newName

Use the MINIMAL number of operations. Change ONLY what is necessary.`;
  }

  /**
   * Parse diff operations from LLM response
   */
  parseDiffs(response) {
    const diffs = [];
    const opRegex = /OP:\s*(\S+)\n([\s\S]*?)(?=\nOP:|\n*$)/g;
    let match;

    while ((match = opRegex.exec(response))) {
      const op = match[1].trim().toLowerCase();
      const body = match[2].trim();
      const diff = { op };

      // Extract TARGET
      const targetMatch = body.match(/TARGET:\s*(.+)/);
      if (targetMatch) diff.target = targetMatch[1].trim();

      // Extract AFTER
      const afterMatch = body.match(/AFTER:\s*(.+)/);
      if (afterMatch) diff.after = afterMatch[1].trim();

      // Extract LINE
      const lineMatch = body.match(/LINE:\s*"([^"]+)"/);
      if (lineMatch) diff.line = lineMatch[1];

      // Extract OLD/NEW for rename
      const oldMatch = body.match(/OLD:\s*(\S+)/);
      const newMatch = body.match(/NEW:\s*(\S+)/);
      if (oldMatch) diff.old = oldMatch[1];
      if (newMatch) diff.new = newMatch[1];

      // Extract CODE block
      const codeMatch = body.match(/```(?:\w*)\n([\s\S]*?)```/);
      if (codeMatch) diff.code = codeMatch[1].trim();

      diffs.push(diff);
    }

    return diffs;
  }

  /**
   * Generate a human-readable description of what changed
   */
  describe(diffs) {
    return diffs.map(d => {
      switch (d.op) {
        case 'replace-function': return `Function "${d.target}" replaced`;
        case 'add-function': return `New function added after "${d.after}"`;
        case 'remove-function': return `Function "${d.target}" removed`;
        case 'insert-after': return `Code inserted after "${d.line?.slice(0, 40)}"`;
        case 'insert-before': return `Code inserted before "${d.line?.slice(0, 40)}"`;
        case 'rename': return `"${d.old}" renamed to "${d.new}"`;
        case 'add-import': return `Import added`;
        case 'delete-lines': return `Lines deleted`;
        default: return `${d.op} applied`;
      }
    }).join('\n');
  }

  // ── Single Operation Implementations ─────────────────────

  _applyOne(code, diff) {
    switch (diff.op) {
      case 'replace-function': return this._replaceFunction(code, diff.target, diff.code);
      case 'add-function':     return this._addFunction(code, diff.after, diff.code);
      case 'remove-function':  return this._removeFunction(code, diff.target);
      case 'insert-after':     return this._insertAfter(code, diff.line, diff.code);
      case 'insert-before':    return this._insertBefore(code, diff.line, diff.code);
      case 'delete-lines':     return this._deleteLines(code, diff.line, diff.count || 1);
      case 'rename':           return this._rename(code, diff.old, diff.new);
      case 'add-import':       return this._addImport(code, diff.code);
      default:                 return null;
    }
  }

  _replaceFunction(code, funcName, newCode) {
    // Find function boundaries
    const boundary = this._findFunctionBoundary(code, funcName);
    if (!boundary) return null;

    const before = code.slice(0, boundary.start);
    const after = code.slice(boundary.end);
    return before + newCode + after;
  }

  _addFunction(code, afterFunc, newCode) {
    if (!afterFunc) {
      // Add at end of file (before module.exports if present)
      const exportsMatch = code.match(/\nmodule\.exports/);
      if (exportsMatch) {
        const pos = code.indexOf(exportsMatch[0]);
        return code.slice(0, pos) + '\n' + newCode + '\n' + code.slice(pos);
      }
      return code + '\n\n' + newCode;
    }

    const boundary = this._findFunctionBoundary(code, afterFunc);
    if (!boundary) return null;

    const before = code.slice(0, boundary.end);
    const after = code.slice(boundary.end);
    return before + '\n\n' + newCode + after;
  }

  _removeFunction(code, funcName) {
    const boundary = this._findFunctionBoundary(code, funcName);
    if (!boundary) return null;

    // Remove function and any blank lines around it
    let start = boundary.start;
    let end = boundary.end;
    while (start > 0 && code[start - 1] === '\n') start--;
    while (end < code.length && code[end] === '\n') end++;

    return code.slice(0, start) + '\n' + code.slice(end);
  }

  _insertAfter(code, lineText, newCode) {
    const idx = code.indexOf(lineText);
    if (idx === -1) return null;
    const lineEnd = code.indexOf('\n', idx + lineText.length);
    if (lineEnd === -1) return code + '\n' + newCode;
    return code.slice(0, lineEnd + 1) + newCode + '\n' + code.slice(lineEnd + 1);
  }

  _insertBefore(code, lineText, newCode) {
    const idx = code.indexOf(lineText);
    if (idx === -1) return null;
    // Find start of this line
    let lineStart = idx;
    while (lineStart > 0 && code[lineStart - 1] !== '\n') lineStart--;
    return code.slice(0, lineStart) + newCode + '\n' + code.slice(lineStart);
  }

  _deleteLines(code, lineText, count) {
    const lines = code.split('\n');
    const idx = lines.findIndex(l => l.includes(lineText));
    if (idx === -1) return null;
    lines.splice(idx, count);
    return lines.join('\n');
  }

  _rename(code, oldName, newName) {
    if (!oldName || !newName) return null;
    // Word-boundary rename to avoid partial matches
    const regex = new RegExp('\\b' + oldName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b', 'g');
    const result = code.replace(regex, newName);
    return result !== code ? result : null;
  }

  _addImport(code, importLine) {
    if (!importLine) return null;
    const lines = code.split('\n');

    // Find last require/import line
    let lastImport = -1;
    for (let i = 0; i < lines.length; i++) {
      if (/^(?:const|let|var|import)\s+.*(?:require|from)\b/.test(lines[i])) lastImport = i;
    }

    if (lastImport >= 0) {
      lines.splice(lastImport + 1, 0, importLine);
    } else {
      // No imports found — add at top (after any comments)
      let insertAt = 0;
      while (insertAt < lines.length && /^\/\/|^\/\*|^\s*$/.test(lines[insertAt])) insertAt++;
      lines.splice(insertAt, 0, importLine, '');
    }

    return lines.join('\n');
  }

  // ── Function Boundary Detection ──────────────────────────

  _findFunctionBoundary(code, funcName) {
    // FIX v4.12.3 (S-02): Escape funcName before regex interpolation to prevent ReDoS.
    // Previously, LLM-supplied function names with regex metacharacters could cause
    // catastrophic backtracking or RegExp syntax errors.
    const esc = funcName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    // Match: function name(, async name(, name: function, name = function, name = (, name: (
    const patterns = [
      new RegExp(`(?:async\\s+)?function\\s+${esc}\\s*\\(`),
      new RegExp(`(?:async\\s+)?${esc}\\s*\\([^)]*\\)\\s*\\{`),
      new RegExp(`${esc}\\s*(?:=|:)\\s*(?:async\\s+)?(?:function|\\([^)]*\\)\\s*=>)\\s*\\{`),
    ];

    let start = -1;
    for (const pattern of patterns) {
      const match = code.match(pattern);
      if (match) {
        start = match.index;
        break;
      }
    }

    if (start === -1) return null;

    // Find the opening { and match to closing }
    let bracePos = code.indexOf('{', start);
    if (bracePos === -1) return null;

    let depth = 0;
    let end = bracePos;
    for (let i = bracePos; i < code.length; i++) {
      if (code[i] === '{') depth++;
      if (code[i] === '}') {
        depth--;
        if (depth === 0) {
          end = i + 1;
          break;
        }
      }
    }

    return { start, end };
  }
}

module.exports = { ASTDiff };
