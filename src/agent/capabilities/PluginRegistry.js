// @ts-checked-v5.7
// ============================================================
// GENESIS — PluginRegistry.js (v3.8.0)
//
// Standardized plugin system for Skills and MCP Recipes.
// Replaces ad-hoc skill installation with a unified registry
// that supports versioning, dependency checking, permissions,
// and rollback.
//
// Plugin types:
//   skill     — Executable module with input/output interface
//   recipe    — MCP tool chain (sequence of tool calls)
//   extension — Agent capability extension (hooks into EventBus)
//
// Manifest format: see types/core.d.ts PluginManifest
//
// Directory layout:
//   .genesis/plugins/
//     plugin-name/
//       plugin-manifest.json
//       index.js (or entry from manifest)
//
// Usage:
//   const registry = new PluginRegistry({ ... });
//   await registry.install(manifest, code);
//   const result = await registry.execute('plugin-name', input);
// ============================================================

const fs = require('fs');
const path = require('path');
const { NullBus } = require('../core/EventBus');
const { safeJsonParse, atomicWriteFileSync } = require('../core/utils');
// FIX v5.1.0 (DI-1): CodeSafety injected via constructor or falls back to
// direct import for standalone/test usage.
const { createLogger } = require('../core/Logger');
const _log = createLogger('PluginRegistry');

class PluginRegistry {
  constructor({ bus, sandbox, toolRegistry, storage, pluginsDir, guard, codeSafety }) {
    this.bus = bus || NullBus;
    this.sandbox = sandbox;
    this.tools = toolRegistry;
    this.storage = storage || null;
    this.pluginsDir = pluginsDir;
    this.guard = guard || null;
    // v5.2.0: codeSafety is injected via Container (phase3 manifest).
    // v7.0.5: Removed fromScanner() fallback — uses inline null-safety instead
    // of triggering cross-layer require() in CodeSafetyPort.
    if (codeSafety) {
      this._codeSafety = codeSafety;
    } else {
      this._codeSafety = { scanCode: () => ({ safe: true, blocked: [], warnings: [], scanMethod: 'none' }), available: false };
    }
    this.plugins = new Map(); // name → { manifest, loaded, stats }

    if (!fs.existsSync(pluginsDir)) {
      fs.mkdirSync(pluginsDir, { recursive: true });
    }
  }

  // ── Lifecycle ─────────────────────────────────────────

  /**
   * Load all installed plugins from disk.
   * Called during boot (via asyncLoad or manually).
   */
  async asyncLoad() {
    if (!fs.existsSync(this.pluginsDir)) return;

    for (const entry of fs.readdirSync(this.pluginsDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;

      const manifestPath = path.join(this.pluginsDir, entry.name, 'plugin-manifest.json');
      if (!fs.existsSync(manifestPath)) continue;

      const manifest = safeJsonParse(fs.readFileSync(manifestPath, 'utf-8'), null, 'PluginRegistry');
      if (manifest) {
        try { this._registerPlugin(manifest, entry.name); }
        catch (err) { _log.warn(`[PLUGIN] Failed to load ${entry.name}:`, err.message); }
      }
    }

    _log.info(`[PLUGIN] Loaded ${this.plugins.size} plugins`);
  }

  // ── Install / Uninstall ───────────────────────────────

  /**
   * Install a plugin from manifest + code.
   *
   * @param {object} manifest - Plugin manifest (name, version, type, entry, etc.)
   * @param {string} code - Plugin source code
   * @returns {Promise<{ ok: boolean, error?: string }>}
   */
  async install(manifest, code) {
    // Validate manifest
    const validation = this._validateManifest(manifest);
    if (!validation.ok) {
      return { ok: false, error: `Invalid manifest: ${validation.errors.join(', ')}` };
    }

    const name = manifest.name;
    const pluginDir = path.join(this.pluginsDir, name);

    // Check dependencies
    if (manifest.dependencies) {
      const missing = manifest.dependencies.filter(dep => !this.plugins.has(dep));
      if (missing.length > 0) {
        return { ok: false, error: `Missing dependencies: ${missing.join(', ')}` };
      }
    }

    // Test in sandbox (skills only — recipes are declarative)
    if (manifest.type === 'skill' && this.sandbox) {
      try {
        const testResult = await this.sandbox.testPatch(`plugins/${name}/index.js`, code);
        if (!testResult.success) {
          return { ok: false, error: `Sandbox test failed: ${testResult.error}` };
        }
      } catch (err) {
        return { ok: false, error: `Sandbox test error: ${err.message}` };
      }
    }

    // FIX v4.0.0: AST-based safety scan — catches eval(), process.exit(),
    // kernel imports etc. that sandbox testPatch alone cannot detect
    // (testPatch only checks syntax + require, not runtime behavior).
    if (manifest.type === 'skill' || manifest.type === 'extension') {
      const safety = this._codeSafety.scanCode(code, `plugins/${name}/${manifest.entry || 'index.js'}`);
      if (!safety.safe) {
        this.bus.fire('code:safety-blocked', { plugin: name, issues: safety.blocked }, { source: 'PluginRegistry' });
        return { ok: false, error: `Code safety block: ${safety.blocked.map(b => b.description).join(', ')}` };
      }
      if (safety.warnings.length > 0) {
        _log.warn(`[PLUGIN] Safety warnings for ${name}:`, safety.warnings.map(w => w.description).join(', '));
      }
    }

    // Write to disk
    // FIX v4.10.0 (Audit P1-03a): Path traversal protection + SafeGuard validation.
    // manifest.entry could be '../../src/agent/core/Container.js' — strip to basename.
    const safeEntry = path.basename(manifest.entry || 'index.js');
    const manifestPath = path.join(pluginDir, 'plugin-manifest.json');
    const codePath = path.join(pluginDir, safeEntry);

    // Verify both paths resolve inside pluginsDir
    const pluginsDirResolved = path.resolve(this.pluginsDir);
    if (!path.resolve(manifestPath).startsWith(pluginsDirResolved + path.sep)) {
      return { ok: false, error: `Path traversal blocked: manifest → ${manifestPath}` };
    }
    if (!path.resolve(codePath).startsWith(pluginsDirResolved + path.sep)) {
      return { ok: false, error: `Path traversal blocked: code → ${codePath}` };
    }

    // SafeGuard validation (blocks kernel, critical files, node_modules, .git)
    if (this.guard) {
      try {
        this.guard.validateWrite(manifestPath);
        this.guard.validateWrite(codePath);
      } catch (err) {
        return { ok: false, error: `SafeGuard blocked: ${err.message}` };
      }
    }

    if (!fs.existsSync(pluginDir)) fs.mkdirSync(pluginDir, { recursive: true });
    // FIX v5.1.0 (N-3): Atomic writes — prevents half-written plugin files on crash.
    atomicWriteFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf-8');
    atomicWriteFileSync(codePath, code, 'utf-8');

    // Register
    this._registerPlugin(manifest, name);

    // Emit event
    this.bus.fire('plugin:installed', { name, type: manifest.type, version: manifest.version }, { source: 'PluginRegistry' });

    return { ok: true };
  }

  /**
   * Uninstall a plugin.
   * @param {string} name
   * @returns {boolean}
   */
  uninstall(name) {
    const plugin = this.plugins.get(name);
    if (!plugin) return false;

    // Check reverse dependencies
    for (const [otherName, other] of this.plugins) {
      if (otherName === name) continue;
      if (other.manifest.dependencies?.includes(name)) {
        _log.warn(`[PLUGIN] Cannot uninstall "${name}" — "${otherName}" depends on it`);
        return false;
      }
    }

    // Remove tool registration
    if (this.tools?.hasTool(`plugin:${name}`)) {
      this.tools.unregister(`plugin:${name}`);
    }

    // Remove from disk
    const pluginDir = path.join(this.pluginsDir, name);
    if (fs.existsSync(pluginDir)) {
      fs.rmSync(pluginDir, { recursive: true, force: true });
    }

    this.plugins.delete(name);
    this.bus.fire('plugin:uninstalled', { name }, { source: 'PluginRegistry' });
    return true;
  }

  // ── Execute ───────────────────────────────────────────

  /**
   * Execute a plugin by name.
   * @param {string} name
   * @param {object} input
   * @returns {Promise<any>}
   */
  async execute(name, input = {}) {
    const plugin = this.plugins.get(name);
    if (!plugin) throw new Error(`Plugin not found: ${name}`);

    const startTime = Date.now();
    plugin.stats.calls++;

    try {
      let result;

      if (plugin.manifest.type === 'skill') {
        result = await this._executeSkill(plugin, input);
      } else if (plugin.manifest.type === 'recipe') {
        result = await this._executeRecipe(plugin, input);
      } else if (plugin.manifest.type === 'extension') {
        result = await this._executeExtension(plugin, input);
      } else {
        throw new Error(`Unknown plugin type: ${plugin.manifest.type}`);
      }

      plugin.stats.lastCall = Date.now();
      plugin.stats.avgDuration = (plugin.stats.avgDuration * (plugin.stats.calls - 1) + (Date.now() - startTime)) / plugin.stats.calls;
      return result;
    } catch (err) {
      plugin.stats.errors++;
      throw err;
    }
  }

  // ── Query ─────────────────────────────────────────────

  /** List all installed plugins */
  list() {
    return [...this.plugins.values()].map(p => ({
      ...p.manifest,
      stats: { ...p.stats },
    }));
  }

  /** Check if a plugin is installed */
  has(name) { return this.plugins.has(name); }

  /** Get stats for all plugins */
  getStats() {
    const stats = {};
    for (const [name, plugin] of this.plugins) {
      stats[name] = { ...plugin.stats, type: plugin.manifest.type };
    }
    return stats;
  }

  // ── Internal ──────────────────────────────────────────

  _validateManifest(manifest) {
    const errors = [];
    if (!manifest.name || typeof manifest.name !== 'string') errors.push('name is required');
    if (!manifest.version) errors.push('version is required');
    if (!['skill', 'recipe', 'extension'].includes(manifest.type)) errors.push('type must be skill|recipe|extension');
    if (!manifest.description) errors.push('description is required');
    if (manifest.type === 'skill' && !manifest.entry) errors.push('entry is required for skills');

    // Name validation: alphanumeric + hyphens only
    if (manifest.name && !/^[a-z0-9][a-z0-9-]*$/.test(manifest.name)) {
      errors.push('name must be lowercase alphanumeric with hyphens');
    }

    // Permission validation
    const validPermissions = ['sandbox', 'filesystem', 'network', 'shell', 'self-modify'];
    if (manifest.permissions) {
      const invalid = manifest.permissions.filter(p => !validPermissions.includes(p));
      if (invalid.length > 0) errors.push(`unknown permissions: ${invalid.join(', ')}`);
    }

    return { ok: errors.length === 0, errors };
  }

  _registerPlugin(manifest, dirName) {
    this.plugins.set(manifest.name, {
      manifest,
      dirName,
      loaded: true,
      stats: { calls: 0, errors: 0, avgDuration: 0, lastCall: null },
    });

    // Register as tool (for skill and recipe types)
    if ((manifest.type === 'skill' || manifest.type === 'recipe') && this.tools) {
      const toolName = `plugin:${manifest.name}`;
      if (!this.tools.hasTool(toolName)) {
        this.tools.register(toolName, {
          description: manifest.description,
          input: manifest.interface?.input || {},
          output: manifest.interface?.output || {},
        }, (input) => this.execute(manifest.name, input), 'plugin');
      }
    }
  }

  async _executeSkill(plugin, input) {
    const entryPath = path.join(this.pluginsDir, plugin.dirName, plugin.manifest.entry || 'index.js');
    if (!fs.existsSync(entryPath)) throw new Error(`Plugin entry not found: ${entryPath}`);

    const code = fs.readFileSync(entryPath, 'utf-8');
    const execCode = `
      ${code}
      const _PluginClass = Object.values(module.exports || {}).find(v => typeof v === 'function');
      if (_PluginClass) {
        const instance = new _PluginClass();
        const result = await instance.execute(${JSON.stringify(input)});
        _log.info(JSON.stringify(result));
      } else {
        throw new Error('No exported class found in plugin');
      }
    `;
    return this.sandbox.execute(execCode, { allowRequire: false });
  }

  async _executeRecipe(plugin, input) {
    // Recipes are JSON sequences of tool calls
    const recipePath = path.join(this.pluginsDir, plugin.dirName, plugin.manifest.entry || 'recipe.json');
    if (!fs.existsSync(recipePath)) throw new Error(`Recipe not found: ${recipePath}`);

    let recipe = safeJsonParse(fs.readFileSync(recipePath, 'utf-8'), null, 'PluginRegistry');
    if (!recipe) throw new Error(`Invalid recipe JSON in ${recipePath}`);
    const results = [];

    for (const step of recipe.steps || []) {
      // Replace {{input.field}} placeholders
      const resolvedInput = {};
      for (const [k, v] of Object.entries(step.input || {})) {
        resolvedInput[k] = typeof v === 'string' ? v.replace(/\{\{(\w+(?:\.\w+)*)\}\}/g, (_, path) => {
          const parts = path.split('.');
          let val = { ...input, _results: results };
          for (const p of parts) val = val?.[p];
          return val !== undefined ? String(val) : '';
        }) : v;
      }

      const result = await this.tools.execute(step.tool, resolvedInput);
      results.push({ tool: step.tool, result });
    }

    return { steps: results, success: true };
  }

  async _executeExtension(plugin, input) {
    // Extensions hook into the EventBus — just load and call
    return this._executeSkill(plugin, input);
  }
}

module.exports = { PluginRegistry };
