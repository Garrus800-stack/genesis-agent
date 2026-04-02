// @ts-checked-v5.7
// ============================================================
// GENESIS — ModuleRegistry.js (v3.5.0 — Weakness Fix A)
//
// PROBLEM: AgentCore manually imports 40+ modules, registers
// each in the Container, and wires late-bindings by hand.
// One forgotten line = silent feature death.
//
// SOLUTION: Each module declares its own registration config
// as a static property. ModuleRegistry auto-discovers, sorts
// by boot phase, registers in Container, and wires late-bindings
// — all from a single manifest scan.
//
// Benefits:
// - New modules only need to export containerConfig
// - Late-bindings are declarative, not procedural
// - Boot phases are validated (no forward refs)
// - Missing deps surface as clear errors, not silent nulls
// ============================================================

const { createLogger } = require('../core/Logger');
const _log = createLogger('ModuleRegistry');
class ModuleRegistry {
  constructor(container, bus) {
    this.container = container;
    this.bus = bus;
    this.manifest = new Map(); // name -> { module, config }
    this.lateBindings = [];    // { target, property, source }
  }

  /**
   * Register a module with its containerConfig.
   * Can be called manually or via auto-discovery.
   *
   * @param {string} name - Service name in Container
   * @param {Function} ModuleClass - The class to register
   * @param {object} config - Registration config
   * @param {number} config.phase - Boot phase (1-6)
   * @param {string[]} config.deps - Container dependencies
   * @param {string[]} config.tags - Tags for getTagged()
   * @param {object[]} config.lateBindings - [{ target: 'promptBuilder', property: 'emotionalState' }]
   * @param {Function} config.factory - (container) => instance (overrides default new ModuleClass())
   */
  /** @param {string} name @param {Function} ModuleClass @param {any} [config] */
  register(name, ModuleClass, config = {}) {
    this.manifest.set(name, {
      module: ModuleClass,
      config: {
        phase: config.phase || 4,
        deps: config.deps || [],
        tags: config.tags || [],
        lateBindings: config.lateBindings || [],
        factory: config.factory || null,
        singleton: config.singleton !== false,
        optional: config.optional || false,
      },
    });

    // Collect late bindings
    for (const lb of config.lateBindings || []) {
      this.lateBindings.push({
        target: lb.target,
        property: lb.property,
        source: name,
      });
    }
  }

  /**
   * Register a module that exports a static containerConfig.
   * Usage: registry.registerSelf(EmotionalState);
   */
  registerSelf(ModuleClass) {
    const cfg = ModuleClass.containerConfig;
    if (!cfg || !cfg.name) {
      throw new Error(`[REGISTRY] ${ModuleClass.name} has no static containerConfig`);
    }
    this.register(cfg.name, ModuleClass, cfg);
  }

  /**
   * Boot all registered modules in phase order.
   * Returns results array with status per module.
   */
  async bootAll() {
    // Sort by phase, then alphabetically within phase
    const sorted = [...this.manifest.entries()]
      .sort((a, b) => {
        const phaseDiff = a[1].config.phase - b[1].config.phase;
        return phaseDiff !== 0 ? phaseDiff : a[0].localeCompare(b[0]);
      });

    const results = [];
    let currentPhase = 0;

    for (const [name, { module: ModuleClass, config }] of sorted) {
      if (config.phase !== currentPhase) {
        currentPhase = config.phase;
        _log.info(`  [${currentPhase}] Phase ${currentPhase} modules...`);
      }

      try {
        // Register in container
        if (config.factory) {
          this.container.register(name, config.factory, {
            singleton: config.singleton,
            deps: config.deps,
            tags: config.tags,
          });
        } else {
          this.container.register(name, (c) => {
            // Auto-inject deps
            const depInstances = {};
            for (const dep of config.deps) {
              if (c.has(dep)) {
                depInstances[dep] = c.resolve(dep);
              } else if (!config.optional) {
                throw new Error(`Missing required dep: ${dep}`);
              }
            }
            return new ModuleClass(depInstances);
          }, {
            singleton: config.singleton,
            deps: config.deps,
            tags: config.tags,
          });
        }

        // Eagerly resolve if singleton
        if (config.singleton) {
          this.container.resolve(name);
        }

        results.push({ name, phase: config.phase, status: 'ok' });
      } catch (err) {
        if (config.optional) {
          results.push({ name, phase: config.phase, status: 'skipped', error: err.message });
          _log.debug(`  [${currentPhase}] ${name}: skipped (${err.message})`);
        } else {
          results.push({ name, phase: config.phase, status: 'error', error: err.message });
          _log.error(`  [${currentPhase}] ${name}: FAILED (${err.message})`);
          throw err; // Fatal for non-optional modules
        }
      }
    }

    return results;
  }

  /**
   * Wire all declared late-bindings.
   * Call after bootAll() when all services exist.
   */
  wireLateBindings() {
    const warnings = [];

    for (const { target, property, source } of this.lateBindings) {
      if (!this.container.has(target)) {
        warnings.push(`Late-bind target '${target}' not found (from ${source}.${property})`);
        continue;
      }
      if (!this.container.has(source)) {
        warnings.push(`Late-bind source '${source}' not found (for ${target}.${property})`);
        continue;
      }

      const targetInstance = this.container.resolve(target);
      const sourceInstance = this.container.resolve(source);
      targetInstance[property] = sourceInstance;
    }

    if (warnings.length > 0) {
      _log.warn('[REGISTRY] Late-binding warnings:', warnings.join('; '));
    }

    return warnings;
  }

  /**
   * Get a diagnostic view of all registered modules.
   */
  getManifest() {
    const result = {};
    for (const [name, { config }] of this.manifest) {
      result[name] = {
        phase: config.phase,
        deps: config.deps,
        tags: config.tags,
        lateBindings: config.lateBindings.map(lb => `${lb.target}.${lb.property}`),
        optional: config.optional,
      };
    }
    return result;
  }

  /**
   * Auto-discover modules with static containerConfig in a directory.
   * Scans all .js files, imports them, checks for containerConfig.
   * Only registers modules that declare the config — legacy modules are skipped.
   *
   * @param {string} directory - Absolute path to scan
   * @returns {string[]} Names of discovered modules
   */
  scanDirectory(directory) {
    const fs = require('fs');
    const path = require('path');
    const discovered = [];

    if (!fs.existsSync(directory)) return discovered;

    const files = fs.readdirSync(directory).filter(f => f.endsWith('.js'));

    for (const file of files) {
      try {
        const mod = require(path.join(directory, file));

        // Check each exported class for containerConfig
        for (const [exportName, ExportedClass] of Object.entries(mod)) {
          if (typeof ExportedClass === 'function' && ExportedClass.containerConfig) {
            this.registerSelf(ExportedClass);
            discovered.push(ExportedClass.containerConfig.name);
          }
        }
      } catch (err) {
        _log.debug(`[REGISTRY] Skip ${file}: ${err.message}`);
      }
    }

    return discovered;
  }

  /**
   * Hybrid boot: Register auto-discovered modules alongside
   * manually-registered ones. Respects phase ordering across both.
   *
   * Usage in AgentCore:
   *   // Phase 1-6: Legacy manual registration (existing code)
   *   // Phase 7+: Auto-discovered modules
   *   const discovered = registry.scanDirectory(agentDir);
   *   await registry.bootAll();
   *   registry.wireLateBindings();
   */

  /**
   * Validate the manifest: check for missing deps, circular refs,
   * and phase ordering violations.
   * @returns {string[]} List of issues (empty if clean)
   */
  validate() {
    const issues = [];
    const allNames = new Set(this.manifest.keys());

    for (const [name, { config }] of this.manifest) {
      // Check deps exist
      for (const dep of config.deps) {
        if (!allNames.has(dep) && !this.container.has(dep)) {
          if (!config.optional) {
            issues.push(`${name}: missing required dep '${dep}'`);
          }
        }
      }

      // Check late-binding targets
      for (const lb of config.lateBindings) {
        if (!allNames.has(lb.target) && !this.container.has(lb.target)) {
          issues.push(`${name}: late-bind target '${lb.target}' not registered`);
        }
      }

      // Check for phase ordering: deps should have lower or equal phase
      for (const dep of config.deps) {
        const depEntry = this.manifest.get(dep);
        if (depEntry && depEntry.config.phase > config.phase) {
          issues.push(`${name} (phase ${config.phase}): depends on '${dep}' (phase ${depEntry.config.phase}) — phase ordering violation`);
        }
      }
    }

    return issues;
  }
}

module.exports = { ModuleRegistry };
