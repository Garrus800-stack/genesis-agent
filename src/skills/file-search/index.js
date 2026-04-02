// ============================================================
// SKILL: file-search (v5.9.3)
// Searches project files by name pattern and/or content grep.
// Sandbox-safe: pure fs module, no shell.
// ============================================================

const fs = require('fs');
const path = require('path');

class FileSearchSkill {
  constructor() {
    this.name = 'file-search';
  }

  /**
   * @param {{ cwd?: string, pattern?: string, content?: string, ext?: string, maxResults?: number, maxDepth?: number }} input
   */
  async execute(input) {
    const cwd = input?.cwd || process.cwd();
    const pattern = input?.pattern ? new RegExp(input.pattern, 'i') : null;
    const content = input?.content || null;
    const ext = input?.ext || null;
    const maxResults = input?.maxResults || 25;
    const maxDepth = input?.maxDepth || 10;

    const SKIP = new Set(['node_modules', '.git', 'dist', 'sandbox', '.genesis', '.fitness-history', 'uploads']);
    const matches = [];

    const walk = (dir, depth) => {
      if (depth > maxDepth || matches.length >= maxResults) return;
      let entries;
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }

      for (const entry of entries) {
        if (matches.length >= maxResults) break;
        if (SKIP.has(entry.name) || entry.name.startsWith('.')) continue;

        const full = path.join(dir, entry.name);
        const rel = path.relative(cwd, full).replace(/\\/g, '/');

        if (entry.isDirectory()) {
          walk(full, depth + 1);
          continue;
        }

        // Extension filter
        if (ext && !entry.name.endsWith(ext)) continue;

        // Name pattern filter
        if (pattern && !pattern.test(entry.name)) continue;

        // Content grep
        if (content) {
          try {
            const text = fs.readFileSync(full, 'utf-8');
            const lines = text.split('\n');
            const contentMatches = [];
            const contentRe = new RegExp(content, 'i');
            for (let i = 0; i < lines.length; i++) {
              if (contentRe.test(lines[i])) {
                contentMatches.push({ line: i + 1, text: lines[i].trim().slice(0, 120) });
                if (contentMatches.length >= 5) break;
              }
            }
            if (contentMatches.length > 0) {
              matches.push({ file: rel, size: this._fmtSize(full), hits: contentMatches });
            }
          } catch { /* binary or unreadable */ }
          continue;
        }

        // Name-only match
        try {
          const stat = fs.statSync(full);
          matches.push({ file: rel, size: this._fmtSize(full, stat) });
        } catch {
          matches.push({ file: rel, size: '?' });
        }
      }
    };

    walk(cwd, 0);

    return {
      cwd,
      query: { pattern: input?.pattern, content, ext },
      resultCount: matches.length,
      truncated: matches.length >= maxResults,
      results: matches,
    };
  }

  _fmtSize(filePath, stat) {
    try {
      const s = stat || fs.statSync(filePath);
      if (s.size < 1024) return s.size + ' B';
      if (s.size < 1024 * 1024) return (s.size / 1024).toFixed(1) + ' KB';
      return (s.size / (1024 * 1024)).toFixed(1) + ' MB';
    } catch { return '?'; }
  }

  async test() {
    try {
      const r = await this.execute({ ext: '.json', maxResults: 5 });
      return { passed: r.resultCount > 0, detail: `Found ${r.resultCount} .json files` };
    } catch (err) {
      return { passed: false, detail: err.message };
    }
  }
}

module.exports = { FileSearchSkill };
