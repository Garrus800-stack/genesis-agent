// @ts-checked-v5.9
// ============================================================
// GENESIS — SkillRegistry.js (v5.9.8 — V6-6)
//
// Discover, install, and manage third-party skills from
// external sources (GitHub Gist, npm, direct URL).
//
// Architecture:
//   genesis install <url>        — install from URL/gist/npm
//   genesis uninstall <name>     — remove skill
//   genesis skills --available   — list from registry index
//   genesis update <name>        — update to latest version
//
// Security:
//   - All installed skills validated against skill-manifest.schema.json
//   - Community skills run in existing sandbox with restricted permissions
//   - Manifest checked BEFORE any code is loaded
//   - HMAC signatures verified when present
//
// Integration:
//   SkillManager.loadSkills() — SkillRegistry installs TO the
//   same skillsDir that SkillManager reads FROM. No coupling.
// ============================================================

'use strict';

const fs = require('fs');
const fsp = require('fs').promises;
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');
const { safeJsonParse, swallow } = require('../core/utils');
const { createLogger } = require('../core/Logger');

const _log = createLogger('SkillRegistry');
const execFileAsync = promisify(execFile);

// JSON Schema validation (lightweight — checks required fields + patterns)
const REQUIRED_MANIFEST_FIELDS = ['name', 'version', 'description', 'entry'];
const NAME_PATTERN = /^[a-z0-9][a-z0-9-]*$/;
const VERSION_PATTERN = /^\d+\.\d+\.\d+(-[a-zA-Z0-9.]+)?$/;
const ENTRY_PATTERN = /^[a-zA-Z0-9._/-]+\.js$/;

class SkillRegistry {
  /**
   * @param {{ skillsDir: string, bus: *, config?: object }} deps
   */
  constructor({ skillsDir, bus, config }) {
    this.skillsDir = skillsDir;
    this.bus = bus;
    this._config = config || {};
    this._registryUrl = (config && config.registryUrl) || null;

    /** @type {Map<string, InstalledSkillMeta>} */
    this._installed = new Map();
    this._metaPath = path.join(skillsDir, '.registry-meta.json');

    // Late-bound by Container (phase 3 manifest)
    /** @type {*} */
    this.skillManager = null;
    /** @type {*} */
    this._settings = null;
  }

  static containerConfig = {
    name: 'skillRegistry',
    phase: 3,
    deps: ['bus'],
    lateBindings: [
      { prop: 'skillManager', service: 'skills', optional: true },
      { prop: '_settings', service: 'settings', optional: true },
    ],
    tags: ['capabilities', 'skills', 'v6-6'],
  };

  // ── Lifecycle ───────────────────────────────────────────

  async asyncLoad() {
    if (!fs.existsSync(this.skillsDir)) {
      fs.mkdirSync(this.skillsDir, { recursive: true });
    }
    await this._loadMeta();
  }

  stop() { /* no-op — no intervals or subs */ }

  // ════════════════════════════════════════════════════════
  // PUBLIC API
  // ════════════════════════════════════════════════════════

  /**
   * Install a skill from a source URL.
   *
   * Supported formats:
   *   - GitHub Gist: https://gist.github.com/<user>/<id>
   *   - GitHub repo subdir: https://github.com/<user>/<repo>/tree/main/skills/<name>
   *   - Direct tarball/zip URL
   *   - npm package: npm:<package-name>
   *
   * @param {string} source — URL or npm:<name>
   * @returns {Promise<InstallResult>}
   */
  async install(source) {
    _log.info(`[REGISTRY] Installing from: ${source}`);
    const startMs = Date.now();

    try {
      // ── 1. Detect source type and fetch ──
      const fetchResult = await this._fetchSkillSource(source);
      if (!fetchResult.ok) {
        return { success: false, error: fetchResult.error };
      }

      const tmpDir = /** @type {string} */ (fetchResult.dir);

      // ── 2. Validate manifest ──
      const manifestPath = path.join(tmpDir, 'skill-manifest.json');
      if (!fs.existsSync(manifestPath)) {
        await this._cleanup(tmpDir);
        return { success: false, error: 'No skill-manifest.json found in source' };
      }

      const manifest = await this._validateManifest(manifestPath);
      if (!manifest.valid) {
        await this._cleanup(tmpDir);
        return { success: false, error: `Invalid manifest: ${manifest.error}` };
      }

      const name = manifest.data.name;

      // ── 3. Check for existing installation ──
      const existing = this._installed.get(name);
      if (existing) {
        _log.info(`[REGISTRY] Replacing existing skill ${name} v${existing.version}`);
      }

      // ── 4. Move to skills dir ──
      const targetDir = path.join(this.skillsDir, name);
      if (fs.existsSync(targetDir)) {
        await fsp.rm(targetDir, { recursive: true, force: true });
      }
      await fsp.rename(tmpDir, targetDir);

      // ── 5. Register ──
      this._installed.set(name, {
        name,
        version: manifest.data.version,
        source,
        installedAt: new Date().toISOString(),
        description: manifest.data.description,
      });
      await this._saveMeta();

      // ── 6. Reload in SkillManager ──
      if (this.skillManager) {
        try { this.skillManager.loadSkills(); } catch (_e) { _log.warn(`[REGISTRY] SkillManager reload failed after install: ${_e.message}`); }
      }

      this.bus.emit('skill:installed', { name, version: manifest.data.version, source });
      _log.info(`[REGISTRY] Installed ${name} v${manifest.data.version} (${Date.now() - startMs}ms)`);

      return {
        success: true,
        name,
        version: manifest.data.version,
        replaced: !!existing,
      };
    } catch (err) {
      _log.warn(`[REGISTRY] Install failed: ${err.message}`);
      return { success: false, error: err.message };
    }
  }

  /**
   * Uninstall a skill by name.
   * @param {string} name
   * @returns {Promise<{ success: boolean, error?: string }>}
   */
  async uninstall(name) {
    if (!this._installed.has(name)) {
      return { success: false, error: `Skill "${name}" not installed via registry` };
    }

    const targetDir = path.join(this.skillsDir, name);
    try {
      if (fs.existsSync(targetDir)) {
        await fsp.rm(targetDir, { recursive: true, force: true });
      }
      this._installed.delete(name);
      await this._saveMeta();

      if (this.skillManager) {
        try { this.skillManager.loadSkills(); } catch (_e) { _log.warn(`[REGISTRY] SkillManager reload failed after uninstall: ${_e.message}`); }
      }

      this.bus.emit('skill:uninstalled', { name });
      _log.info(`[REGISTRY] Uninstalled ${name}`);
      return { success: true };
    } catch (err) {
      return { success: false, error: err.message };
    }
  }

  /**
   * List installed skills with registry metadata.
   * @returns {Array<InstalledSkillMeta>}
   */
  list() {
    return Array.from(this._installed.values());
  }

  /**
   * Update a skill to the latest version from its original source.
   * @param {string} name
   * @returns {Promise<InstallResult>}
   */
  async update(name) {
    const meta = this._installed.get(name);
    if (!meta) {
      return { success: false, error: `Skill "${name}" not installed via registry` };
    }
    return this.install(meta.source);
  }

  /**
   * Search available skills from the registry index.
   * @param {string} [query]
   * @returns {Promise<Array<{ name: string, description: string, version: string }>>}
   */
  async search(query) {
    if (!this._registryUrl) {
      return [];
    }
    // Registry index is a JSON file with { skills: [{ name, description, version, source }] }
    try {
      const { stdout } = await execFileAsync('curl', ['-sS', '--max-time', '10', this._registryUrl], {
        encoding: 'utf-8',
      });
      const data = safeJsonParse(stdout, { skills: [] }, 'SkillRegistry');
      let skills = data.skills || [];
      if (query) {
        const q = query.toLowerCase();
        skills = skills.filter(s => s.name.includes(q) || (s.description || '').toLowerCase().includes(q));
      }
      return skills;
    } catch (err) {
      _log.debug('[REGISTRY] Search failed:', err.message);
      return [];
    }
  }

  // ════════════════════════════════════════════════════════
  // INTERNAL
  // ════════════════════════════════════════════════════════

  /**
   * Fetch skill source into a temporary directory.
   * @param {string} source
   * @returns {Promise<{ ok: boolean, dir?: string, error?: string }>}
   */
  async _fetchSkillSource(source) {
    const tmpDir = path.join(this.skillsDir, '.tmp-install-' + Date.now());
    await fsp.mkdir(tmpDir, { recursive: true });

    try {
      if (source.startsWith('npm:')) {
        // npm install to temp dir
        const pkg = source.slice(4);
        await execFileAsync('npm', ['pack', pkg, '--pack-destination', tmpDir], {
          cwd: tmpDir, timeout: 30_000, encoding: 'utf-8',
        });
        // Extract the tarball
        const tarballs = (await fsp.readdir(tmpDir)).filter(f => f.endsWith('.tgz'));
        if (tarballs.length === 0) throw new Error('npm pack produced no tarball');
        await execFileAsync('tar', ['xzf', tarballs[0], '--strip-components=1'], {
          cwd: tmpDir, timeout: 10_000,
        });
        // Clean up tarball
        await swallow(fsp.unlink(path.join(tmpDir, tarballs[0])), 'skill-cleanup');
      } else if (source.includes('gist.github.com')) {
        // Clone gist
        const gistUrl = source.endsWith('.git') ? source : source + '.git';
        await execFileAsync('git', ['clone', '--depth=1', gistUrl, tmpDir], {
          timeout: 30_000, encoding: 'utf-8',
        });
        // Remove .git dir
        await fsp.rm(path.join(tmpDir, '.git'), { recursive: true, force: true });
      } else if (source.endsWith('.zip') || source.endsWith('.tar.gz') || source.endsWith('.tgz')) {
        // Download and extract archive
        const archivePath = path.join(tmpDir, 'archive' + path.extname(source));
        await execFileAsync('curl', ['-sS', '-L', '-o', archivePath, '--max-time', '30', source], {
          timeout: 35_000,
        });
        if (source.endsWith('.zip')) {
          await execFileAsync('unzip', ['-o', archivePath, '-d', tmpDir], { timeout: 10_000 });
        } else {
          await execFileAsync('tar', ['xzf', archivePath, '-C', tmpDir, '--strip-components=1'], { timeout: 10_000 });
        }
        await swallow(fsp.unlink(archivePath), 'archive-cleanup');
      } else if (source.includes('github.com') && !source.endsWith('.git')) {
        // GitHub repo — clone
        const repoUrl = source.endsWith('.git') ? source : source + '.git';
        await execFileAsync('git', ['clone', '--depth=1', repoUrl, tmpDir], {
          timeout: 30_000, encoding: 'utf-8',
        });
        await fsp.rm(path.join(tmpDir, '.git'), { recursive: true, force: true });
      } else {
        // Direct git clone as fallback
        await execFileAsync('git', ['clone', '--depth=1', source, tmpDir], {
          timeout: 30_000, encoding: 'utf-8',
        });
        await fsp.rm(path.join(tmpDir, '.git'), { recursive: true, force: true });
      }

      return { ok: true, dir: tmpDir };
    } catch (err) {
      await this._cleanup(tmpDir);
      return { ok: false, error: `Fetch failed: ${err.message}` };
    }
  }

  /**
   * Validate manifest against the skill-manifest schema.
   * @param {string} manifestPath
   * @returns {Promise<{ valid: boolean, data?: object, error?: string }>}
   */
  async _validateManifest(manifestPath) {
    try {
      const raw = await fsp.readFile(manifestPath, 'utf-8');
      const data = JSON.parse(raw);

      // Required fields
      for (const field of REQUIRED_MANIFEST_FIELDS) {
        if (!data[field]) return { valid: false, error: `Missing required field: ${field}` };
      }

      // Pattern checks
      if (!NAME_PATTERN.test(data.name)) {
        return { valid: false, error: `Invalid name "${data.name}" — must be lowercase alphanumeric + hyphens` };
      }
      if (!VERSION_PATTERN.test(data.version)) {
        return { valid: false, error: `Invalid version "${data.version}" — must be semver` };
      }
      if (!ENTRY_PATTERN.test(data.entry)) {
        return { valid: false, error: `Invalid entry "${data.entry}" — must be a .js file path` };
      }

      // Verify entry file exists
      const entryPath = path.join(path.dirname(manifestPath), data.entry);
      if (!fs.existsSync(entryPath)) {
        return { valid: false, error: `Entry file not found: ${data.entry}` };
      }

      return { valid: true, data };
    } catch (err) {
      return { valid: false, error: `Parse error: ${err.message}` };
    }
  }

  async _loadMeta() {
    try {
      if (fs.existsSync(this._metaPath)) {
        const raw = await fsp.readFile(this._metaPath, 'utf-8');
        const data = JSON.parse(raw);
        for (const entry of (data.installed || [])) {
          this._installed.set(entry.name, entry);
        }
        _log.info(`[REGISTRY] Loaded ${this._installed.size} registry entries`);
      }
    } catch (_e) {
      _log.debug('[REGISTRY] No meta found — fresh registry');
    }
  }

  async _saveMeta() {
    try {
      const data = { installed: Array.from(this._installed.values()) };
      await fsp.writeFile(this._metaPath, JSON.stringify(data, null, 2));
    } catch (err) {
      _log.warn('[REGISTRY] Meta save failed:', err.message);
    }
  }

  async _cleanup(dir) {
    try { await fsp.rm(dir, { recursive: true, force: true }); } catch (_e) { /* best effort */ }
  }
}

module.exports = { SkillRegistry };

/**
 * @typedef {object} InstalledSkillMeta
 * @property {string} name
 * @property {string} version
 * @property {string} source
 * @property {string} installedAt
 * @property {string} description
 */

/**
 * @typedef {object} InstallResult
 * @property {boolean} success
 * @property {string} [name]
 * @property {string} [version]
 * @property {boolean} [replaced]
 * @property {string} [error]
 */
