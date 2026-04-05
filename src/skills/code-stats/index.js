// ============================================================
// SKILL: code-stats (v5.9.3)
// Analyzes project code metrics: LOC, file counts by extension,
// complexity indicators, dependency count.
// Sandbox-safe: pure fs module, no shell.
// ============================================================

const fs = require('fs');
const path = require('path');

class CodeStatsSkill {
  constructor() {
    this.name = 'code-stats';
  }

  /**
   * @param {{ cwd?: string, maxDepth?: number }} input
   */
  async execute(input) {
    const cwd = input?.cwd || process.cwd();
    const maxDepth = input?.maxDepth || 10;

    const SKIP = new Set(['node_modules', '.git', 'dist', 'sandbox', '.genesis', '.fitness-history', 'uploads']);
    const stats = {
      totalFiles: 0,
      totalLOC: 0,
      blankLines: 0,
      commentLines: 0,
      byExtension: {},
      largestFiles: [],
      directories: 0,
    };

    const fileSizes = [];

    const walk = (dir, depth) => {
      if (depth > maxDepth) return;
      let entries;
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }

      for (const entry of entries) {
        if (SKIP.has(entry.name) || entry.name.startsWith('.')) continue;
        const full = path.join(dir, entry.name);

        if (entry.isDirectory()) {
          stats.directories++;
          walk(full, depth + 1);
          continue;
        }

        stats.totalFiles++;
        const ext = path.extname(entry.name) || '(no ext)';
        if (!stats.byExtension[ext]) stats.byExtension[ext] = { files: 0, loc: 0 };
        stats.byExtension[ext].files++;

        // Count lines for text files
        if (this._isText(ext)) {
          try {
            const content = fs.readFileSync(full, 'utf-8');
            const lines = content.split('\n');
            const loc = lines.length;
            stats.totalLOC += loc;
            stats.byExtension[ext].loc += loc;

            for (const line of lines) {
              const trimmed = line.trim();
              if (trimmed === '') stats.blankLines++;
              else if (trimmed.startsWith('//') || trimmed.startsWith('#') || trimmed.startsWith('*')) stats.commentLines++;
            }

            const rel = path.relative(cwd, full).replace(/\\/g, '/');
            fileSizes.push({ file: rel, loc, bytes: Buffer.byteLength(content) });
          } catch { /* binary or unreadable */ }
        }
      }
    };

    walk(cwd, 0);

    // Top 10 largest files
    fileSizes.sort((a, b) => b.loc - a.loc);
    stats.largestFiles = fileSizes.slice(0, 10).map(f => ({
      file: f.file,
      loc: f.loc,
      size: this._fmt(f.bytes),
    }));

    // Sort extensions by LOC descending
    const sorted = Object.entries(stats.byExtension)
      .sort((a, b) => b[1].loc - a[1].loc);
    stats.byExtension = Object.fromEntries(sorted);

    stats.codeLOC = stats.totalLOC - stats.blankLines - stats.commentLines;

    // Package.json deps
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(cwd, 'package.json'), 'utf-8'));
      stats.dependencies = Object.keys(pkg.dependencies || {}).length;
      stats.devDependencies = Object.keys(pkg.devDependencies || {}).length;
    } catch { /* no package.json */ }

    return stats;
  }

  _isText(ext) {
    return ['.js', '.mjs', '.ts', '.jsx', '.tsx', '.json', '.md', '.txt',
      '.html', '.css', '.yml', '.yaml', '.svg', '.sh', '.bat', '.d.ts',
      '.conf', '.env', '.toml', '.xml'].includes(ext);
  }

  _fmt(bytes) {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
  }

  async test() {
    try {
      const r = await this.execute({});
      const ok = r.totalFiles > 0 && r.totalLOC > 0;
      return { passed: !!ok, detail: ok ? `${r.totalFiles} files, ${r.totalLOC} LOC, ${r.directories} dirs` : 'empty project' };
    } catch (err) {
      return { passed: false, detail: err.message };
    }
  }
}

module.exports = { CodeStatsSkill };
