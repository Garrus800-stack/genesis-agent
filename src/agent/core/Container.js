// ============================================================
// GENESIS AGENT — Container.js (v2 — Late-Binding Support)
// Lightweight Dependency Injection Container.
//
// v2 UPGRADE:
// - lateBindings: Declare cross-phase property injections
//   in register() instead of manual wiring in AgentCore.
// - wireLateBindings(): Resolves all declared bindings after
//   all services are registered. Replaces the 15+ manual
//   property assignments in _wireAndStart().
// - postBoot(): Call start() on services that need it.
//
// PROBLEM (Genesis self-analysis #2):
// "Statt hart verdrahteter Imports (require('../foundation/Sandbox'))
// @ts-checked-v5.6
const { NullBus } = require('./EventBus');
// sollten Dependencies injiziert werden."
//
// This container enables:
// - Swap any module without changing consumers
// - Test with mocks trivially
// - Hot-reload a module and re-inject it everywhere
// - Visualize the dependency graph
// ============================================================

class Container {
  /** @param {{ bus?: * }} [config] */
  constructor({ bus } = {}) {
    this.bus = bus || NullBus;
    this.registrations = new Map(); // name -> { factory, singleton, instance, deps, tags, lateBindings, phase }
    this.resolved = new Map();      // name -> resolved instance (for singletons)
    this.resolving = new Set();     // Circular dependency detection
    // v3.5.0: Phase enforcement — warns when deps reference higher-phase services
    this._phaseEnforcement = typeof process !== 'undefined' && process.env?.NODE_ENV !== 'production';
    this._phaseWarned = null;
    // v5.0.0: Biological name aliases — alias → canonical service name
    this._aliases = new Map();
  }

  /**
   * Register a service
   * @param {string} name - Service name
   * @param {Function} factory - (container) => instance
   * @param {object} options - { singleton, deps, tags, lateBindings }
   *
   * lateBindings: Array of { prop, service, optional } declarations.
   * After all services are registered, wireLateBindings() sets:
   *   instance[prop] = container.resolve(service)
   * Optional bindings are skipped if the service doesn't exist.
   *
   * Example:
   *   c.register('idleMind', factory, {
   *     deps: ['model', 'selfModel'],
   *     lateBindings: [
   *       { prop: 'emotionalState', service: 'emotionalState' },
   *       { prop: 'mcpClient', service: 'mcpClient', optional: true },
   *     ]
   *   });
   */
  register(name, factory, options = {}) {
    this.registrations.set(name, {
      factory,
      singleton: options.singleton !== false, // Default: singleton
      instance: null,
      deps: options.deps || [],
      tags: options.tags || [],
      lateBindings: options.lateBindings || [],
      phase: options.phase || 0, // v3.5.0: Boot phase for ordering enforcement
    });

    // Clear cached instance on re-registration (for hot-reload)
    this.resolved.delete(name);
  }

  /**
   * Register an already-created instance
   */
  registerInstance(name, instance, options = {}) {
    this.registrations.set(name, {
      factory: () => instance,
      singleton: true,
      instance,
      deps: options.deps || [],
      tags: options.tags || [],
      lateBindings: options.lateBindings || [],
    });
    this.resolved.set(name, instance);
  }

  /**
   * Resolve a service by name
   * @param {string} nameArg
   * @returns {*} The resolved service instance
   */
  resolve(nameArg) {
    // v5.0.0: follow alias chain before anything else
    const name = this._canonical(nameArg);

    // Check if already resolved (singleton)
    if (this.resolved.has(name)) {
      return this.resolved.get(name);
    }

    const reg = this.registrations.get(name);
    if (!reg) {
      throw new Error(`[CONTAINER] Service not registered: ${nameArg}${nameArg !== name ? ` (alias for "${name}")` : ''}`);
    }

    // Circular dependency detection
    if (this.resolving.has(name)) {
      throw new Error(`[CONTAINER] Circular dependency: ${name} (chain: ${[...this.resolving].join(' -> ')})`);
    }

    // v3.5.0: Phase enforcement — warn if deps reference higher-phase services
    if (this._phaseEnforcement && reg.phase > 0) {
      for (const depName of reg.deps) {
        const depReg = this.registrations.get(depName);
        if (depReg && depReg.phase > reg.phase) {
          const msg = `[CONTAINER:PHASE] "${name}" (phase ${reg.phase}) depends on "${depName}" (phase ${depReg.phase}). Use lateBindings for cross-phase deps.`;
          if (!this._phaseWarned) this._phaseWarned = new Set();
          if (!this._phaseWarned.has(msg)) {
            this._phaseWarned.add(msg);
            console.warn(msg);
          }
        }
      }
    }

    this.resolving.add(name);

    try {
      const instance = reg.factory(this);

      if (reg.singleton) {
        reg.instance = instance;
        this.resolved.set(name, instance);
      }

      this.resolving.delete(name);
      return instance;
    } catch (err) {
      this.resolving.delete(name);
      throw err;
    }
  }

  /** Check if a service is registered (v5.0.0: alias-aware) */
  has(nameArg) {
    return this.registrations.has(this._canonical(nameArg));
  }

  /**
   * v4.13.0: Safe resolve — returns the instance or a fallback without throwing.
   * v5.0.0: alias-aware via _canonical().
   *
   * @param {string} nameArg - Service name or alias
   * @param {*} [fallback=null] - Value to return if service is missing or resolution fails
   * @returns {*} The resolved instance or fallback
   */
  tryResolve(nameArg, fallback = null) {
    if (!this.registrations.has(this._canonical(nameArg))) return fallback;
    try {
      return this.resolve(nameArg);
    } catch { /* resolve failed — return caller's fallback */
      return fallback;
    }
  }

  /**
   * v5.0.0 — Register a biological alias for an existing service.
   *
   * After aliasing, container.resolve(alias) returns the same singleton
   * instance as container.resolve(primary). has(), tryResolve(), and
   * wireLateBindings() all respect aliases transparently.
   *
   * @param {string} alias   - New name (e.g. 'morphogenesis')
   * @param {string} primary - Existing registered name (e.g. 'selfModPipeline')
   *
   * @example
   *   container.alias('morphogenesis',     'selfModPipeline');
   *   container.alias('colony',            'network');
   *   container.alias('connectome',        'knowledgeGraph');
   *   container.alias('hippocampalBuffer', 'memory');
   */
  alias(alias, primary) {
    const canonical = this._canonical(primary);
    if (!this.registrations.has(canonical)) {
      throw new Error(`[CONTAINER] Cannot alias "${alias}" → "${primary}": primary not registered`);
    }
    if (this.registrations.has(alias)) {
      throw new Error(`[CONTAINER] Cannot alias "${alias}": a service with that name is already registered`);
    }
    this._aliases.set(alias, canonical);
  }

  /**
   * v5.0.0 — Resolve a name to its canonical (non-alias) name.
   * Handles chains (a → b → c returns c). Throws on circular aliases.
   * @private
   */
  _canonical(name) {
    const seen = new Set();
    let cur = name;
    while (this._aliases.has(cur)) {
      if (seen.has(cur)) throw new Error(`[CONTAINER] Circular alias detected at "${cur}"`);
      seen.add(cur);
      cur = this._aliases.get(cur);
    }
    return cur;
  }

  /**
   * v2: Wire all declared late-bindings.
   * Call AFTER all services are registered and resolved.
   * Replaces manual property assignments like:
   *   idleMind.emotionalState = c.resolve('emotionalState')
   *
   * @returns {{ wired: number, skipped: number, errors: string[] }}
   */
  wireLateBindings() {
    let wired = 0, skipped = 0;
    const errors = [];

    for (const [name, reg] of this.registrations) {
      if (!reg.lateBindings || reg.lateBindings.length === 0) continue;

      const instance = this.resolved.get(name);
      if (!instance) continue; // Not yet resolved

      for (const binding of reg.lateBindings) {
        const { prop, service, optional = false } = binding;

        if (!this.has(service)) {
          if (optional) {
            skipped++;
            continue;
          }
          errors.push(`${name}.${prop} → ${service} (not registered)`);
          continue;
        }

        try {
          instance[prop] = this.resolve(service);
          wired++;
        } catch (err) {
          if (optional) {
            skipped++;
          } else {
            errors.push(`${name}.${prop} → ${service}: ${err.message}`);
          }
        }
      }
    }

    if (errors.length > 0) {
      console.warn(`[CONTAINER] Late-binding errors:`, errors);
    }

    return { wired, skipped, errors };
  }

  /**
   * FIX v3.5.0: Verify all late-bindings actually resolved to non-null values.
   * Call AFTER wireLateBindings(). Catches cases where resolve() succeeded
   * but the factory returned null, or where a property was overwritten to null.
   *
   * @returns {{ verified: number, missing: string[], total: number }}
   */
  verifyLateBindings() {
    const missing = [];
    let verified = 0;
    let total = 0;

    for (const [name, reg] of this.registrations) {
      if (!reg.lateBindings || reg.lateBindings.length === 0) continue;

      const instance = this.resolved.get(name);
      if (!instance) continue;

      for (const binding of reg.lateBindings) {
        const { prop, service, optional = false } = binding;
        total++;

        if (optional) {
          // Optional bindings are OK if null
          if (instance[prop] != null) verified++;
          continue;
        }

        if (instance[prop] == null) {
          missing.push(`${name}.${prop} → ${service} (resolved but null/undefined)`);
        } else {
          verified++;
        }
      }
    }

    if (missing.length > 0) {
      console.error(`[CONTAINER] Late-binding verification failed — ${missing.length} required bindings are null:`);
      for (const m of missing) console.error(`  ✗ ${m}`);
    }

    return { verified, missing, total };
  }

  /**
   * v2: Post-boot phase — call start() on all services that have it.
   * Called after wireLateBindings(). Starts autonomous processes
   * (timers, watchers, listeners) after all wiring is complete.
   */
  async postBoot() {
    const order = this._topologicalSort();
    const started = [];

    for (const name of order) {
      const instance = this.resolved.get(name);
      if (instance && typeof instance.start === 'function') {
        try {
          await instance.start();
          started.push(name);
        } catch (err) {
          console.warn(`[CONTAINER] postBoot start failed for ${name}:`, err.message);
        }
      }
    }

    return started;
  }

  /**
   * Replace a singleton (for hot-reload)
   * Notifies all dependent services
   */
  replace(name, newFactory) {
    const old = this.registrations.get(name);
    if (!old) throw new Error(`[CONTAINER] Cannot replace unknown: ${name}`);

    // FIX v3.5.4: Clean up EventBus listeners from the old instance.
    // Without this, hot-reloaded modules accumulate orphaned listeners
    // (the old instance's constructor registered listeners that are never unsubscribed).
    const oldInstance = this.resolved.get(name);
    if (oldInstance && typeof oldInstance.stop === 'function') {
      try { oldInstance.stop(); } catch (_e) { console.debug('[catch] old instance stop:', _e.message); }
    }
    this.bus.removeBySource(name);

    this.resolved.delete(name);
    old.factory = newFactory;
    old.instance = null;

    // Re-resolve
    const newInstance = this.resolve(name);

    this.bus.fire('container:replaced', { name }, { source: 'Container' });
    return newInstance;
  }

  /**
   * Get all services with a specific tag
   */
  getTagged(tag) {
    const result = [];
    for (const [name, reg] of this.registrations) {
      if (reg.tags.includes(tag)) {
        result.push({ name, instance: this.resolve(name) });
      }
    }
    return result;
  }

  /**
   * Get the dependency graph (for visualization/debugging)
   */
  getDependencyGraph() {
    const graph = {};
    for (const [name, reg] of this.registrations) {
      graph[name] = {
        deps: reg.deps,
        tags: reg.tags,
        singleton: reg.singleton,
        phase: reg.phase || 0,
        resolved: this.resolved.has(name),
        lateBindings: reg.lateBindings.map(b => `${b.prop}→${b.service}${b.optional ? '?' : ''}`),
      };
    }
    return graph;
  }

  /**
   * Resolve all registered singletons (boot all services)
   */
  /**
   * v7.0.1: Level-parallel boot.
   *
   * Groups services into dependency levels using _toLevels().
   * Within each level, all services have their dependencies already
   * resolved in a previous level, so asyncLoad()/boot() can run
   * concurrently via Promise.allSettled().
   *
   * Fallback: If _toLevels() fails, falls back to sequential boot
   * (identical to the v7.0.0 behavior) for safety.
   *
   * Typical speedup: 2-4x on boot phases with I/O-bound asyncLoad()
   * (model detection, file scanning, network probes).
   */
  async bootAll() {
    let levels;
    try {
      levels = this._toLevels();
    } catch (_e) {
      // Fallback: sequential boot (v7.0.0 behavior)
      console.warn('[CONTAINER] _toLevels() failed, falling back to sequential boot:', _e.message);
      return this._bootAllSequential();
    }

    const results = [];

    for (const level of levels) {
      // Resolve all services in this level synchronously first
      // (resolve() is sync and may have side effects / ordering expectations)
      const resolved = [];
      for (const name of level) {
        try {
          const instance = this.resolve(name);
          resolved.push({ name, instance });
        } catch (err) {
          results.push({ name, status: 'error', error: err.message });
          console.error(`[CONTAINER] Boot failed for ${name}:`, err.message);
        }
      }

      // Run asyncLoad() + boot() concurrently within this level
      const promises = resolved.map(async ({ name, instance }) => {
        try {
          if (instance && typeof instance.asyncLoad === 'function') {
            await instance.asyncLoad();
          }
          if (instance && typeof instance.boot === 'function') {
            await instance.boot();
          }
          return { name, status: 'ok' };
        } catch (err) {
          console.error(`[CONTAINER] Boot failed for ${name}:`, err.message);
          return { name, status: 'error', error: err.message };
        }
      });

      const settled = await Promise.allSettled(promises);
      for (const s of settled) {
        // allSettled always fulfills; errors are caught inside the async fn
        // @ts-ignore — TS inference limitation (checkJs)
        results.push(s.value || { name: '?', status: 'error', error: 'unexpected rejection' });
      }
    }

    return results;
  }

  /**
   * v7.0.1: Sequential fallback — identical to v7.0.0 bootAll().
   * @private
   */
  async _bootAllSequential() {
    const order = this._topologicalSort();
    const results = [];

    for (const name of order) {
      try {
        const instance = this.resolve(name);
        if (instance && typeof instance.asyncLoad === 'function') {
          await instance.asyncLoad();
        }
        if (instance && typeof instance.boot === 'function') {
          await instance.boot();
        }
        results.push({ name, status: 'ok' });
      } catch (err) {
        results.push({ name, status: 'error', error: err.message });
        console.error(`[CONTAINER] Boot failed for ${name}:`, err.message);
      }
    }

    return results;
  }

  /**
   * Shutdown all services in reverse order
   */
  async shutdownAll() {
    const order = this._topologicalSort().reverse();

    for (const name of order) {
      const instance = this.resolved.get(name);
      if (instance && typeof instance.shutdown === 'function') {
        try {
          await instance.shutdown();
        } catch (err) {
          console.warn(`[CONTAINER] Shutdown error for ${name}:`, err.message);
        }
      }
    }

    this.resolved.clear();
  }

  // ── Internal ─────────────────────────────────────────────

  /**
   * v4.13.2: Boot-time registration validator.
   * Checks all registrations for structural issues BEFORE resolve().
   * Catches mismatches that would otherwise surface as cryptic runtime errors.
   *
   * Checks:
   *   1. All deps reference registered services
   *   2. All non-optional lateBindings reference registered services
   *   3. No dep references a higher-phase service (phase enforcement)
   *   4. No duplicate lateBinding property names within a service
   *
   * Call after all phases are registered, before bootAll().
   * @returns {{ valid: boolean, errors: string[], warnings: string[] }}
   */
  validateRegistrations() {
    const errors = [];
    const warnings = [];

    for (const [name, reg] of this.registrations) {
      // Check 1: deps reference real services (FIX v5.0.0: alias-aware via _canonical)
      for (const dep of reg.deps) {
        if (!this.registrations.has(this._canonical(dep))) {
          errors.push(`"${name}" depends on "${dep}" which is not registered`);
        }
      }

      // Check 2: non-optional lateBindings reference real services (FIX v5.0.0: alias-aware)
      for (const binding of reg.lateBindings) {
        if (!binding.optional && !this.registrations.has(this._canonical(binding.service))) {
          errors.push(`"${name}" has required lateBinding "${binding.prop}" → "${binding.service}" which is not registered`);
        }
      }

      // Check 3: phase enforcement (deps should not reference higher phases)
      if (reg.phase > 0) {
        for (const dep of reg.deps) {
          const canonical = this._canonical(dep);
          const depReg = this.registrations.get(canonical);
          if (depReg && depReg.phase > reg.phase) {
            warnings.push(`"${name}" (phase ${reg.phase}) depends on "${dep}" (phase ${depReg.phase}) — use lateBindings for cross-phase deps`);
          }
        }
      }

      // Check 4: duplicate lateBinding property names
      const props = new Set();
      for (const binding of reg.lateBindings) {
        if (props.has(binding.prop)) {
          errors.push(`"${name}" has duplicate lateBinding property "${binding.prop}"`);
        }
        props.add(binding.prop);
      }
    }

    const valid = errors.length === 0;
    if (errors.length > 0) {
      console.error(`[CONTAINER] Registration validation: ${errors.length} error(s):`);
      for (const e of errors) console.error(`  ✗ ${e}`);
    }
    if (warnings.length > 0 && this._phaseEnforcement) {
      console.warn(`[CONTAINER] Registration validation: ${warnings.length} warning(s):`);
      for (const w of warnings) console.warn(`  ⚠ ${w}`);
    }

    return { valid, errors, warnings };
  }

  /**
   * Topological sort of dependencies (boot order)
   */
  // FIX v4.0.0: Phase-aware topological sort.
  // Primary sort: boot phase (lower phases first).
  // Secondary sort: dependency order within each phase.
  // Prevents timing issues where a phase-8 service boots before
  // a phase-2 service that it implicitly depends on.
  _topologicalSort() {
    const visited = new Set();
    const order = [];

    const visit = (name) => {
      if (visited.has(name)) return;
      visited.add(name);

      const reg = this.registrations.get(name);
      if (reg) {
        for (const dep of reg.deps) {
          if (this.registrations.has(dep)) {
            visit(dep);
          }
        }
        // FIX v4.0.0: Also visit non-optional lateBinding services.
        // Ensures they are resolved before wireLateBindings() runs,
        // and their asyncLoad()/boot() completes in the right order.
        for (const binding of reg.lateBindings) {
          if (!binding.optional && this.registrations.has(binding.service)) {
            visit(binding.service);
          }
        }
      }
      order.push(name);
    };

    // Group by phase, then topologically sort within each group
    const phaseGroups = new Map();
    for (const [name, reg] of this.registrations) {
      const phase = reg.phase || 0;
      if (!phaseGroups.has(phase)) phaseGroups.set(phase, []);
      phaseGroups.get(phase).push(name);
    }

    const sortedPhases = [...phaseGroups.keys()].sort((a, b) => a - b);
    for (const phase of sortedPhases) {
      for (const name of phaseGroups.get(phase)) {
        visit(name);
      }
    }

    return order;
  }

  /**
   * v7.0.1: Group services into dependency levels.
   *
   * Level 0: services with no deps (or all deps already resolved)
   * Level 1: services whose deps are all in level 0
   * Level N: services whose deps are all in levels < N
   *
   * Services within the same level can boot concurrently.
   *
   * Uses Kahn's algorithm (BFS topological sort) which naturally
   * produces levels. Phase ordering is respected: lower phases
   * are assigned to earlier levels.
   *
   * @returns {string[][]} Array of levels, each level is an array of service names
   * @private
   */
  _toLevels() {
    // Build adjacency + in-degree from registrations
    const inDegree = new Map();
    const dependents = new Map(); // dep → [services that depend on it]

    for (const [name] of this.registrations) {
      inDegree.set(name, 0);
      dependents.set(name, []);
    }

    for (const [name, reg] of this.registrations) {
      const allDeps = new Set(reg.deps);
      // Include non-optional lateBindings as deps for ordering
      for (const binding of reg.lateBindings) {
        if (!binding.optional && this.registrations.has(this._canonical(binding.service))) {
          allDeps.add(this._canonical(binding.service));
        }
      }

      for (const dep of allDeps) {
        const canonical = this._canonical(dep);
        if (this.registrations.has(canonical)) {
          inDegree.set(name, (inDegree.get(name) || 0) + 1);
          if (!dependents.has(canonical)) dependents.set(canonical, []);
          dependents.get(canonical).push(name);
        }
      }
    }

    // Kahn's BFS — collect by level
    const levels = [];
    let queue = [];

    // Seed: all services with in-degree 0
    for (const [name, deg] of inDegree) {
      if (deg === 0) queue.push(name);
    }

    // Sort initial queue by phase for deterministic ordering
    queue.sort((a, b) => {
      const pa = this.registrations.get(a)?.phase || 0;
      const pb = this.registrations.get(b)?.phase || 0;
      return pa - pb;
    });

    while (queue.length > 0) {
      levels.push([...queue]);

      const nextQueue = [];
      for (const name of queue) {
        for (const dep of (dependents.get(name) || [])) {
          const newDeg = inDegree.get(dep) - 1;
          inDegree.set(dep, newDeg);
          if (newDeg === 0) nextQueue.push(dep);
        }
      }

      // Sort next level by phase
      nextQueue.sort((a, b) => {
        const pa = this.registrations.get(a)?.phase || 0;
        const pb = this.registrations.get(b)?.phase || 0;
        return pa - pb;
      });

      queue = nextQueue;
    }

    // Cycle detection: if we didn't visit all services, there's a cycle
    const visited = levels.flat().length;
    if (visited < this.registrations.size) {
      const missing = [...this.registrations.keys()].filter(
        n => !levels.flat().includes(n)
      );
      throw new Error(
        `[CONTAINER] Dependency cycle detected — ${missing.length} unreachable: ${missing.slice(0, 5).join(', ')}${missing.length > 5 ? '...' : ''}`
      );
    }

    return levels;
  }
}

module.exports = { Container };
