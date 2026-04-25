// ============================================================
// GENESIS — ContainerDiagnostics.js (v7.4.3 "Aufräumen II")
//
// Extracted from Container.js as part of the v7.4.3 cleanup pass.
// Holds the four diagnostic / boot-planning methods that account
// for ~240 LOC and are only called at boot or from health
// inspectors — never on the hot path:
//
//   - getDependencyGraph    (visualization / health endpoint)
//   - validateRegistrations (boot-time structural checker)
//   - _topologicalSort      (legacy boot order)
//   - _toLevels             (level-parallel boot, v7.0.1)
//
// Prototype-Delegation from the bottom of Container.js via
// Object.assign. Same pattern as SelfModelParsing (v7.4.1) and
// CommandHandlersCode (v7.4.2). External API unchanged — every
// caller (AgentCore, AgentCoreBoot, AgentCoreHealth, HealthServer,
// internal bootAll) keeps working through the prototype chain.
// ============================================================

'use strict';

const containerDiagnostics = {

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
  },

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
  },

  /**
   * Topological sort of dependencies (boot order)
   *
   * FIX v4.0.0: Phase-aware topological sort.
   * Primary sort: boot phase (lower phases first).
   * Secondary sort: dependency order within each phase.
   * Prevents timing issues where a phase-8 service boots before
   * a phase-2 service that it implicitly depends on.
   */
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
  },

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
  },
};

module.exports = { containerDiagnostics };
