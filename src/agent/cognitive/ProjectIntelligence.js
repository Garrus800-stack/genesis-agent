// @ts-checked-v5.7
// ============================================================
// GENESIS — ProjectIntelligence.js (v5.7.0)
//
// Deep understanding of the project Genesis is working on.
// Instead of treating every file as isolated text, Genesis
// builds a structural model: dependencies, patterns, debt,
// hotspots, conventions.
//
// This feeds into:
//   - PromptBuilder: "This project uses Express + TypeScript,
//     prefers async/await, has 40% test coverage, and the
//     heaviest coupling is in src/api/routes.js"
//   - FormalPlanner: preconditions based on project state
//   - IdleMind: proactive suggestions ("3 files have no tests")
//   - SelfModPipeline: aware of project conventions
//
// Triggers:
//   - Boot (initial scan)
//   - After AgentLoop goal completion (incremental update)
//   - Manual via 'project-scan' command
//
// NOT a replacement for SelfModel (which maps Genesis itself).
// ProjectIntelligence maps the USER's project.
// ============================================================

'use strict';

const fs = require('fs');
const path = require('path');
const { NullBus } = require('../core/EventBus');
const { TIMEOUTS } = require('../core/Constants');
const { createLogger } = require('../core/Logger');

const _log = createLogger('ProjectIntel');

// File extensions by category
const CATEGORIES = {
  code: new Set(['.js', '.ts', '.jsx', '.tsx', '.py', '.rb', '.go', '.rs', '.java', '.c', '.cpp', '.cs', '.php', '.swift', '.kt']),
  test: new Set(['.test.js', '.spec.js', '.test.ts', '.spec.ts', '_test.py', '_test.go', '.test.rb']),
  config: new Set(['.json', '.yaml', '.yml', '.toml', '.ini', '.env']),
  doc: new Set(['.md', '.txt', '.rst', '.adoc']),
  style: new Set(['.css', '.scss', '.less', '.sass']),
  markup: new Set(['.html', '.htm', '.xml', '.svg']),
};

class ProjectIntelligence {

  static containerConfig = {
    name: 'projectIntelligence',
    phase: 9,
    deps: ['storage'],
    tags: ['cognitive', 'project', 'analysis'],
    lateBindings: [
      { prop: 'selfModel', service: 'selfModel', optional: true },
    ],
  };

  /**
   * @param {{ bus?: object, storage: object, config?: object }} opts
   */
  constructor({ bus, storage, config }) {
    this.bus = bus || NullBus;
    this.storage = storage;
    this.selfModel = null;

    /** @type {object|null} */
    this._profile = null;
    this._lastScanTs = 0;
    this._scanCount = 0;
    this._rootDir = null;
    this._staleMs = (config?.staleMs) || 300_000; // 5 min
  }

  // ═══════════════════════════════════════════════════════════
  // LIFECYCLE
  // ═══════════════════════════════════════════════════════════

  start() {
    this._rootDir = this.selfModel?.rootDir || null;
    if (this._rootDir) {
      this._scan();
    }
    _log.info(`[PROJECT] Active — rootDir: ${this._rootDir || 'unknown'}`);
  }

  stop() {}
  async asyncLoad() {}

  // ═══════════════════════════════════════════════════════════
  // SCANNING
  // ═══════════════════════════════════════════════════════════

  /**
   * Full project scan. Builds the structural profile.
   * @returns {object} The project profile
   */
  _scan() {
    if (!this._rootDir || !fs.existsSync(this._rootDir)) {
      this._profile = { error: 'No project directory' };
      return this._profile;
    }

    const t0 = Date.now();
    const files = this._collectFiles(this._rootDir);

    this._profile = {
      scannedAt: Date.now(),
      root: this._rootDir,
      ...this._analyzeStructure(files),
      ...this._analyzeStack(files),
      ...this._analyzeQuality(files),
      ...this._analyzeConventions(files),
      hotspots: this._findHotspots(files),
    };

    this._lastScanTs = Date.now();
    this._scanCount++;
    _log.info(`[PROJECT] Scan #${this._scanCount} in ${Date.now() - t0}ms — ${files.length} files`);

    return this._profile;
  }

  /** Ensure profile is fresh */
  _ensureFresh() {
    if (!this._profile || Date.now() - this._lastScanTs > this._staleMs) {
      this._scan();
    }
  }

  // ═══════════════════════════════════════════════════════════
  // FILE COLLECTION
  // ═══════════════════════════════════════════════════════════

  /**
   * Recursively collect files, skipping node_modules/.git/dist
   * @param {string} dir
   * @returns {Array<{path: string, rel: string, ext: string, size: number, lines: number}>}
   */
  _collectFiles(dir) {
    const SKIP = new Set(['node_modules', '.git', 'dist', 'build', 'coverage', '.next', '__pycache__', 'vendor', '.venv', 'venv']);
    const files = [];
    const MAX_FILES = 5000;

    const walk = (d, base) => {
      if (files.length >= MAX_FILES) return;
      let entries;
      try { entries = fs.readdirSync(d, { withFileTypes: true }); }
      catch { return; }

      for (const e of entries) {
        if (files.length >= MAX_FILES) return;
        if (e.name.startsWith('.') && e.name !== '.env') continue;
        if (SKIP.has(e.name)) continue;

        const full = path.join(d, e.name);
        const rel = path.join(base, e.name);

        if (e.isDirectory()) {
          walk(full, rel);
        } else if (e.isFile()) {
          const ext = path.extname(e.name).toLowerCase();
          try {
            const stat = fs.statSync(full);
            if (stat.size > 1_000_000) continue; // Skip >1MB
            let lines = 0;
            if (CATEGORIES.code.has(ext) || CATEGORIES.test.has(ext)) {
              const content = fs.readFileSync(full, 'utf8');
              lines = content.split('\n').length;
            }
            files.push({ path: full, rel: rel.replace(/\\/g, '/'), ext, size: stat.size, lines });
          } catch { /* skip unreadable */ }
        }
      }
    };

    walk(dir, '');
    return files;
  }

  // ═══════════════════════════════════════════════════════════
  // ANALYSIS PASSES
  // ═══════════════════════════════════════════════════════════

  /** Structural overview: file counts, LOC, directory depth */
  _analyzeStructure(files) {
    const byCategory = {};
    let totalLOC = 0;
    const dirs = new Set();

    for (const f of files) {
      const cat = this._categorize(f.ext, f.rel);
      byCategory[cat] = (byCategory[cat] || 0) + 1;
      totalLOC += f.lines;
      dirs.add(path.dirname(f.rel));
    }

    return {
      fileCount: files.length,
      totalLOC,
      directoryCount: dirs.size,
      byCategory,
    };
  }

  /** Tech stack detection from package.json, config files, imports */
  _analyzeStack(files) {
    /** @type {{ language: string, framework: string|null, testFramework: string|null, buildTool: string|null, packageManager: string|null, typescript: boolean, dependencies: number, devDependencies: number }} */
    const stack = {
      language: 'unknown',
      framework: null,
      testFramework: null,
      buildTool: null,
      packageManager: null,
      typescript: false,
      dependencies: 0,
      devDependencies: 0,
    };

    // v5.8.0: Table-driven detection (was if-else chains, CC=35 → ~12)
    const FRAMEWORK_MAP = [
      ['next', 'Next.js'], ['nuxt', 'Nuxt'], ['react', 'React'], ['vue', 'Vue'],
      ['@angular/core', 'Angular'], ['express', 'Express'], ['fastify', 'Fastify'],
      ['electron', 'Electron'], ['svelte', 'Svelte'],
    ];
    const TEST_MAP = [
      ['jest', 'Jest'], ['vitest', 'Vitest'], ['mocha', 'Mocha'],
    ];
    const BUILD_MAP = [
      ['vite', 'Vite'], ['webpack', 'Webpack'], ['esbuild', 'esbuild'],
      ['rollup', 'Rollup'], ['turbo', 'Turborepo'],
    ];
    const LANG_MAP = {
      '.js': 'JavaScript', '.ts': 'TypeScript', '.tsx': 'TypeScript',
      '.py': 'Python', '.go': 'Go', '.rs': 'Rust', '.rb': 'Ruby',
      '.java': 'Java', '.cs': 'C#', '.php': 'PHP',
    };
    const PKG_LOCK_MAP = [
      ['yarn.lock', 'yarn'], ['pnpm-lock.yaml', 'pnpm'],
    ];

    const pkgFile = files.find(f => f.rel === 'package.json');
    if (pkgFile) {
      try {
        const pkg = JSON.parse(fs.readFileSync(pkgFile.path, 'utf8'));
        const allDeps = { ...pkg.dependencies, ...pkg.devDependencies };
        stack.dependencies = Object.keys(pkg.dependencies || {}).length;
        stack.devDependencies = Object.keys(pkg.devDependencies || {}).length;

        stack.packageManager = 'npm';
        for (const [lock, mgr] of PKG_LOCK_MAP) {
          if (fs.existsSync(path.join(this._rootDir, lock))) { stack.packageManager = mgr; break; }
        }

        for (const [dep, name] of FRAMEWORK_MAP) { if (allDeps[dep]) { stack.framework = name; break; } }
        for (const [dep, name] of TEST_MAP) { if (allDeps[dep]) { stack.testFramework = name; break; } }
        if (!stack.testFramework && (pkg.scripts?.test?.includes('node --test') || pkg.scripts?.test?.includes('node test'))) {
          stack.testFramework = 'node:test';
        }
        for (const [dep, name] of BUILD_MAP) { if (allDeps[dep]) { stack.buildTool = name; break; } }

        stack.typescript = !!allDeps['typescript'];
      } catch { /* malformed package.json */ }
    }

    // Language from file extension counts
    const extCounts = {};
    for (const f of files) {
      if (CATEGORIES.code.has(f.ext)) {
        extCounts[f.ext] = (extCounts[f.ext] || 0) + 1;
      }
    }
    const topExt = Object.entries(extCounts).sort((a, b) => b[1] - a[1])[0];
    if (topExt) stack.language = LANG_MAP[topExt[0]] || topExt[0];

    // Python override
    if (files.some(f => f.rel === 'requirements.txt' || f.rel === 'pyproject.toml')) {
      stack.language = 'Python';
      stack.packageManager = files.some(f => f.rel === 'poetry.lock') ? 'Poetry'
        : files.some(f => f.rel === 'Pipfile') ? 'Pipenv' : 'pip';
    }

    return { stack };
  }

  /** Quality indicators: test coverage, TODO count, large files */
  _analyzeQuality(files) {
    const codeFiles = files.filter(f => CATEGORIES.code.has(f.ext) && !this._isTest(f.rel));
    const testFiles = files.filter(f => this._isTest(f.rel));

    // Simple test coverage estimate: files with matching test files
    const testedFiles = new Set();
    for (const tf of testFiles) {
      const base = path.basename(tf.rel).replace(/\.(test|spec)\.(js|ts|tsx|jsx)$/, '');
      for (const cf of codeFiles) {
        if (path.basename(cf.rel, cf.ext) === base) {
          testedFiles.add(cf.rel);
        }
      }
    }

    // Count TODOs/FIXMEs in code files
    let todoCount = 0;
    let fixmeCount = 0;
    const largeFiles = [];

    for (const f of codeFiles) {
      if (f.lines > 300) largeFiles.push({ file: f.rel, lines: f.lines });
      try {
        const content = fs.readFileSync(f.path, 'utf8');
        todoCount += (content.match(/\bTODO\b/g) || []).length;
        fixmeCount += (content.match(/\bFIXME\b/g) || []).length;
      } catch { /* skip */ }
    }

    return {
      quality: {
        codeFiles: codeFiles.length,
        testFiles: testFiles.length,
        testCoverageEstimate: codeFiles.length > 0
          ? Math.round((testedFiles.size / codeFiles.length) * 100) : 0,
        todoCount,
        fixmeCount,
        largeFiles: largeFiles.sort((a, b) => b.lines - a.lines).slice(0, 10),
      },
    };
  }

  /** Detect coding conventions: naming, structure patterns */
  _analyzeConventions(files) {
    const conventions = {
      namingStyle: 'unknown', // camelCase, snake_case, kebab-case
      moduleSystem: 'unknown', // commonjs, esm, mixed
      indentation: 'unknown', // 2-space, 4-space, tabs
      srcLayout: 'flat', // flat, src/, app/, lib/
    };

    // Detect src layout
    const topDirs = new Set(files.map(f => f.rel.split('/')[0]).filter(d => !d.includes('.')));
    if (topDirs.has('src')) conventions.srcLayout = 'src/';
    else if (topDirs.has('app')) conventions.srcLayout = 'app/';
    else if (topDirs.has('lib')) conventions.srcLayout = 'lib/';

    // Sample first 10 code files for conventions
    const codeFiles = files.filter(f => CATEGORIES.code.has(f.ext)).slice(0, 10);
    let esmCount = 0, cjsCount = 0, twoSpace = 0, fourSpace = 0;
    const namePatterns = { camel: 0, snake: 0, kebab: 0 };

    for (const f of codeFiles) {
      try {
        const content = fs.readFileSync(f.path, 'utf8');
        if (content.includes('import ') || content.includes('export ')) esmCount++;
        if (content.includes('require(') || content.includes('module.exports')) cjsCount++;

        // Indentation
        const lines = content.split('\n').filter(l => l.startsWith('  ') || l.startsWith('\t'));
        if (lines.length > 0) {
          const firstIndent = lines[0].match(/^(\s+)/)?.[1];
          if (firstIndent === '  ') twoSpace++;
          else if (firstIndent === '    ') fourSpace++;
        }

        // File naming
        const base = path.basename(f.rel, f.ext);
        if (/^[a-z][a-zA-Z]+$/.test(base)) namePatterns.camel++;
        else if (/^[a-z_]+$/.test(base)) namePatterns.snake++;
        else if (/^[a-z-]+$/.test(base)) namePatterns.kebab++;
      } catch { /* skip */ }
    }

    conventions.moduleSystem = esmCount > cjsCount ? 'esm' : cjsCount > esmCount ? 'commonjs' : 'mixed';
    conventions.indentation = twoSpace > fourSpace ? '2-space' : '4-space';
    const topName = Object.entries(namePatterns).sort((a, b) => b[1] - a[1])[0];
    if (topName && topName[1] > 0) conventions.namingStyle = topName[0];

    return { conventions };
  }

  /** Find coupling hotspots: most-imported files */
  _findHotspots(files) {
    const importCounts = new Map();
    const codeFiles = files.filter(f => CATEGORIES.code.has(f.ext));

    for (const f of codeFiles) {
      try {
        const content = fs.readFileSync(f.path, 'utf8');
        const imports = content.match(/require\(['"]([^'"]+)['"]\)|from ['"]([^'"]+)['"]/g) || [];
        for (const imp of imports) {
          const mod = imp.match(/['"]([^'"]+)['"]/)?.[1];
          if (mod && mod.startsWith('.')) {
            const resolved = path.normalize(path.join(path.dirname(f.rel), mod)).replace(/\\/g, '/');
            importCounts.set(resolved, (importCounts.get(resolved) || 0) + 1);
          }
        }
      } catch { /* skip */ }
    }

    return [...importCounts.entries()]
      .filter(([, c]) => c >= 3)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([file, count]) => ({ file, importedBy: count }));
  }

  // ═══════════════════════════════════════════════════════════
  // HELPERS
  // ═══════════════════════════════════════════════════════════

  _categorize(ext, rel) {
    if (this._isTest(rel)) return 'test';
    for (const [cat, exts] of Object.entries(CATEGORIES)) {
      if (exts.has(ext)) return cat;
    }
    return 'other';
  }

  _isTest(rel) {
    return /\.(test|spec)\.(js|ts|tsx|jsx)$/.test(rel)
      || /tests?\//.test(rel)
      || /_test\.(py|go|rb)$/.test(rel)
      || /\.stories\.(js|ts|tsx)$/.test(rel);
  }

  // ═══════════════════════════════════════════════════════════
  // PUBLIC API
  // ═══════════════════════════════════════════════════════════

  /** Get the full project profile */
  getProfile() {
    this._ensureFresh();
    return this._profile;
  }

  /** Rebuild the profile (force rescan) */
  rescan() {
    return this._scan();
  }

  /**
   * Build prompt context — compressed project overview for PromptBuilder.
   * @returns {string}
   */
  buildPromptContext() {
    this._ensureFresh();
    if (!this._profile || this._profile.error) return '';

    const p = this._profile;
    const parts = [`PROJECT: ${p.stack?.language || 'unknown'}`];

    if (p.stack?.framework) parts[0] += ` + ${p.stack.framework}`;
    parts[0] += `, ${p.fileCount} files, ${p.totalLOC} LOC.`;

    if (p.stack?.testFramework) parts.push(`Tests: ${p.stack.testFramework}, ~${p.quality?.testCoverageEstimate}% file coverage.`);
    if (p.conventions) {
      parts.push(`Conventions: ${p.conventions.moduleSystem}, ${p.conventions.indentation}, ${p.conventions.namingStyle} naming, ${p.conventions.srcLayout} layout.`);
    }
    if (p.quality?.todoCount > 0) parts.push(`Debt: ${p.quality.todoCount} TODOs, ${p.quality.fixmeCount} FIXMEs.`);
    if (p.hotspots?.length > 0) {
      parts.push(`Hotspots: ${p.hotspots.slice(0, 3).map(h => h.file.split('/').pop()).join(', ')}.`);
    }

    return parts.join(' ');
  }

  /**
   * Get improvement suggestions for IdleMind proactive insights.
   * @returns {Array<string>}
   */
  getSuggestions() {
    this._ensureFresh();
    if (!this._profile || this._profile.error) return [];

    const suggestions = [];
    const q = this._profile.quality;

    if (q?.testCoverageEstimate < 50) {
      suggestions.push(`Test coverage is ~${q.testCoverageEstimate}% — consider adding tests for untested files.`);
    }
    if (q?.todoCount > 10) {
      suggestions.push(`Found ${q.todoCount} TODOs in code — some may be stale and worth resolving.`);
    }
    if (q?.largeFiles?.length > 0) {
      const top = q.largeFiles[0];
      suggestions.push(`${top.file} has ${top.lines} lines — consider splitting into smaller modules.`);
    }

    return suggestions;
  }
}

module.exports = { ProjectIntelligence };
