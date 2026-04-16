// @ts-checked-v5.7
// ============================================================
// GENESIS — ArchitectureReflection.js (v5.7.0 — SA-P3)
//
// ⚠️  COMPLEXITY WATCH (v7.0.1): 58 methods. Split into ArchGraph,
//     ArchMetrics, ArchAdvisor when this exceeds 70 methods.
//
// Genesis's self-model as a live KnowledgeGraph. Instead of a
// flat file scan (SelfModel) this builds a queryable graph of
// services, events, dependencies, layers, and their connections.
//
// Answers questions like:
//   "What depends on EventBus?"
//   "What events does IdleMind emit?"
//   "Show the dependency chain from AgentLoop to CognitiveWorkspace"
//   "Which services have cross-phase late-bindings?"
//
// Architecture:
//   Container.registrations  → service nodes + dependency edges
//   EventBus.listeners       → event listener edges
//   Source scan (emit/fire)   → event emitter edges
//   SelfModel.manifest       → file/module nodes
//
// The graph is rebuilt on-demand (not continuously) and cached.
// Typically rebuilt at boot and after self-modification.
//
// Design: Pure read-only observer. No side effects. No state
// mutation. Safe to query from any context (PromptBuilder,
// Dashboard, IdleMind, etc.)
// ============================================================

'use strict';

const fs = require('fs');
const path = require('path');
const { NullBus } = require('../core/EventBus');
const { createLogger } = require('../core/Logger');

const _log = createLogger('ArchReflect');

// ── Layer → Phase mapping ──────────────────────────────────
const LAYER_PHASES = {
  core:          0,
  foundation:    1,
  intelligence:  2,
  capabilities:  3,
  planning:      4,
  hexagonal:     5,
  autonomy:      6,
  organism:      7,
  revolution:    8,
  cognitive:     9,
  // v7.6.0: consciousness (phase 13) removed — replaced by AwarenessPort in phase 1
};

class ArchitectureReflection {
  /**
   * @param {{ bus?: object, selfModel: object, config?: object }} opts
   */
  constructor({ bus, selfModel, config }) {
    this.bus = bus || NullBus;
    this.selfModel = selfModel;

    // Late-bound
    this.knowledgeGraph = null;

    /** @type {object|null} */
    this._container = null;  // Set via setContainer()

    // ── Graph data ──────────────────────────────────────
    /** @type {Map<string, object>} */
    this._services = new Map();   // name → { phase, deps, lateBindings, tags, layer, file }
    /** @type {Map<string, object>} */
    this._events = new Map();     // eventName → { emitters: Set, listeners: Set }
    /** @type {Map<string, object>} */
    this._layers = new Map();     // layerName → { phase, services: Set }
    /** @type {Array<object>} */
    this._couplings = [];         // cross-phase connections

    this._lastBuildTs = 0;
    this._buildCount = 0;
    this._staleThresholdMs = (config?.staleThresholdMs) || 300_000;
  }

  // ═══════════════════════════════════════════════════════════
  // LIFECYCLE
  // ═══════════════════════════════════════════════════════════

  start() {
    this._rebuild();
    _log.info(`[ARCH] Active — ${this._services.size} services, ${this._events.size} events, ${this._layers.size} layers`);
  }

  stop() {}
  async asyncLoad() {}

  /** Called by AgentCore after Container is fully wired */
  setContainer(container) {
    this._container = container;
  }

  // ═══════════════════════════════════════════════════════════
  // GRAPH BUILDING
  // ═══════════════════════════════════════════════════════════

  /**
   * Rebuild the architecture graph from all sources.
   * Called at boot and after self-modification events.
   */
  _rebuild() {
    const t0 = Date.now();
    this._services.clear();
    this._events.clear();
    this._layers.clear();
    this._couplings = [];

    this._indexServices();
    this._indexEvents();
    this._indexLayers();
    this._computeCouplings();

    this._lastBuildTs = Date.now();
    this._buildCount++;
    _log.info(`[ARCH] Graph built in ${Date.now() - t0}ms (build #${this._buildCount})`);
  }

  /** Rebuild if data is stale */
  _ensureFresh() {
    if (Date.now() - this._lastBuildTs > this._staleThresholdMs) {
      this._rebuild();
    }
  }

  /** Index all services from Container registrations */
  _indexServices() {
    if (!this._container?.registrations) return;

    for (const [name, reg] of this._container.registrations) {
      const layer = this._detectLayer(name, reg);
      this._services.set(name, {
        name,
        phase: reg.phase || 0,
        deps: reg.deps || [],
        lateBindings: (reg.lateBindings || []).map(lb => ({
          prop: lb.prop,
          service: lb.service,
          optional: !!lb.optional,
        })),
        tags: reg.tags || [],
        layer,
        singleton: reg.singleton !== false,
      });
    }
  }

  /** Index events: scan source files for emit/fire calls + bus listeners */
  _indexEvents() {
    // 1. Scan source files for emit/fire patterns
    const rootDir = this.selfModel?.rootDir;
    if (rootDir) {
      const agentDir = path.join(rootDir, 'src', 'agent');
      if (fs.existsSync(agentDir)) {
        this._scanEmitters(agentDir);
      }
    }

    // 2. Index live listeners from EventBus
    if (this.bus?.listeners) {
      for (const [event, listeners] of this.bus.listeners) {
        if (!this._events.has(event)) {
          this._events.set(event, { emitters: new Set(), listeners: new Set() });
        }
        const entry = this._events.get(event);
        for (const l of listeners) {
          if (l.source) entry.listeners.add(l.source);
        }
      }
    }
  }

  /** Scan .js files for bus.emit/bus.fire patterns */
  _scanEmitters(dir) {
    const emitRe = /\.(?:emit|fire)\(\s*'([^']+)'/g;
    const sourceRe = /source:\s*'([^']+)'/;

    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === 'vendor') continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        this._scanEmitters(full);
        continue;
      }
      if (!entry.name.endsWith('.js') || entry.name.endsWith('.test.js')) continue;

      const code = fs.readFileSync(full, 'utf8');
      const basename = entry.name.replace('.js', '');
      let m;

      while ((m = emitRe.exec(code))) {
        const event = m[1];
        if (!this._events.has(event)) {
          this._events.set(event, { emitters: new Set(), listeners: new Set() });
        }
        // Try to find source in nearby text
        const ctx = code.slice(Math.max(0, m.index - 10), m.index + m[0].length + 80);
        const srcMatch = sourceRe.exec(ctx);
        this._events.get(event).emitters.add(srcMatch ? srcMatch[1] : basename);
      }
    }
  }

  /** Group services by layer */
  _indexLayers() {
    for (const [name, svc] of this._services) {
      const layer = svc.layer || 'unknown';
      if (!this._layers.has(layer)) {
        this._layers.set(layer, { phase: LAYER_PHASES[layer] ?? -1, services: new Set() });
      }
      this._layers.get(layer).services.add(name);
    }
  }

  /** Find cross-phase couplings (deps or lateBindings crossing layer boundaries) */
  _computeCouplings() {
    for (const [name, svc] of this._services) {
      // Direct deps
      for (const dep of svc.deps) {
        const depSvc = this._services.get(dep);
        if (depSvc && depSvc.phase > svc.phase) {
          this._couplings.push({
            type: 'upward-dep',
            from: name,
            to: dep,
            fromPhase: svc.phase,
            toPhase: depSvc.phase,
          });
        }
      }
      // Late-bindings
      for (const lb of svc.lateBindings) {
        const targetSvc = this._services.get(lb.service);
        if (targetSvc) {
          this._couplings.push({
            type: lb.optional ? 'late-optional' : 'late-required',
            from: name,
            to: lb.service,
            fromPhase: svc.phase,
            toPhase: targetSvc.phase,
            prop: lb.prop,
          });
        }
      }
    }
  }

  /** Detect layer from service name, tags, or container config */
  _detectLayer(name, reg) {
    // From tags
    for (const tag of (reg.tags || [])) {
      if (LAYER_PHASES[tag] !== undefined) return tag;
    }
    // From phase number
    for (const [layer, phase] of Object.entries(LAYER_PHASES)) {
      if (reg.phase === phase) return layer;
    }
    return 'unknown';
  }

  // ═══════════════════════════════════════════════════════════
  // QUERY API
  // ═══════════════════════════════════════════════════════════

  /**
   * Get detailed info about a service.
   * @param {string} name - Service name
   * @returns {object|null}
   */
  getServiceInfo(name) {
    this._ensureFresh();
    const svc = this._services.get(name);
    if (!svc) return null;

    // Enrich with event participation
    const emits = [];
    const listensTo = [];
    for (const [event, info] of this._events) {
      if (info.emitters.has(name) || info.emitters.has(_classify(name))) emits.push(event);
      if (info.listeners.has(name) || info.listeners.has(_classify(name))) listensTo.push(event);
    }

    // Find dependents (who depends on this service)
    const dependents = [];
    for (const [svcName, s] of this._services) {
      if (s.deps.includes(name)) dependents.push(svcName);
      if (s.lateBindings.some(lb => lb.service === name)) dependents.push(svcName);
    }

    return { ...svc, emits, listensTo, dependents };
  }

  /**
   * Get the event flow: who emits and who listens.
   * @param {string} eventName
   * @returns {object|null}
   */
  getEventFlow(eventName) {
    this._ensureFresh();
    const info = this._events.get(eventName);
    if (!info) return null;
    return {
      event: eventName,
      emitters: [...info.emitters],
      listeners: [...info.listeners],
    };
  }

  /**
   * Get all services grouped by phase.
   * @returns {object} { 0: [...], 1: [...], ... }
   */
  getPhaseMap() {
    this._ensureFresh();
    const map = {};
    for (const [name, svc] of this._services) {
      const p = svc.phase;
      if (!map[p]) map[p] = [];
      map[p].push(name);
    }
    return map;
  }

  /**
   * Get all services grouped by layer.
   * @returns {object}
   */
  getLayerMap() {
    this._ensureFresh();
    const map = {};
    for (const [layer, info] of this._layers) {
      map[layer] = [...info.services];
    }
    return map;
  }

  /**
   * Find the dependency chain between two services (BFS).
   * @param {string} from
   * @param {string} to
   * @returns {string[]|null} Path or null if not connected
   */
  getDependencyChain(from, to) {
    this._ensureFresh();
    if (!this._services.has(from) || !this._services.has(to)) return null;

    // BFS through deps + lateBindings
    const visited = new Set();
    const queue = [[from]];
    visited.add(from);

    while (queue.length > 0) {
      const chain = queue.shift();
      if (!chain) break;
      const current = chain[chain.length - 1];
      if (current === to) return chain;

      const svc = this._services.get(current);
      if (!svc) continue;

      const neighbors = [
        ...svc.deps,
        ...svc.lateBindings.map(lb => lb.service),
      ];

      for (const next of neighbors) {
        if (!visited.has(next)) {
          visited.add(next);
          queue.push([...chain, next]);
        }
      }
    }
    return null;
  }

  /**
   * Get all cross-phase couplings.
   * @returns {Array<object>}
   */
  getCouplings() {
    this._ensureFresh();
    return [...this._couplings];
  }

  /**
   * Natural language architecture query.
   * Matches keywords to the appropriate API call.
   * @param {string} text
   * @returns {object}
   */
  query(text) {
    this._ensureFresh();
    const lower = text.toLowerCase();

    // "what depends on X" / "was hängt von X ab"
    const depMatch = lower.match(/(?:depends?\s+on|hängt.*ab.*von|dependents?\s+of)\s+(\w+)/i);
    if (depMatch) {
      const info = this.getServiceInfo(depMatch[1]);
      return info ? { type: 'dependents', service: depMatch[1], dependents: info.dependents, deps: info.deps } : { type: 'not-found', service: depMatch[1] };
    }

    // "what events does X emit" / "welche Events sendet X"
    const emitMatch = lower.match(/(?:events?.*(?:emit|send|fire|sendet)|(?:emit|send|fire|sendet).*events?)\s+(\w+)/i)
      || lower.match(/(\w+)\s+(?:emit|send|fire|sendet)/i);
    if (emitMatch) {
      const info = this.getServiceInfo(emitMatch[1]);
      return info ? { type: 'events', service: emitMatch[1], emits: info.emits, listensTo: info.listensTo } : { type: 'not-found', service: emitMatch[1] };
    }

    // "event flow X" / "who listens to X"
    const flowMatch = lower.match(/(?:event\s+flow|flow\s+of|listens?\s+to|who.*(?:emit|listen))\s+([a-z0-9:_-]+)/i);
    if (flowMatch) {
      const flow = this.getEventFlow(flowMatch[1]);
      return flow || { type: 'not-found', event: flowMatch[1] };
    }

    // "chain from X to Y" / "path from X to Y"
    const chainMatch = lower.match(/(?:chain|path|route)\s+(?:from\s+)?(\w+)\s+(?:to|→|->)\s+(\w+)/i);
    if (chainMatch) {
      const chain = this.getDependencyChain(chainMatch[1], chainMatch[2]);
      return { type: 'chain', from: chainMatch[1], to: chainMatch[2], path: chain };
    }

    // "phase map" / "layer map"
    if (/phase\s*map|phasen/i.test(lower)) return { type: 'phaseMap', ...this.getPhaseMap() };
    if (/layer\s*map|schicht/i.test(lower)) return { type: 'layerMap', ...this.getLayerMap() };
    if (/coupling|kopplung/i.test(lower)) return { type: 'couplings', couplings: this.getCouplings() };

    // "info X" / "service X" — fallback: look up a service
    const wordMatch = lower.match(/(?:info|service|dienst)\s+(\w+)/i);
    if (wordMatch) {
      const info = this.getServiceInfo(wordMatch[1]);
      return info || { type: 'not-found', service: wordMatch[1] };
    }

    return { type: 'summary', ...this.getSnapshot() };
  }

  /**
   * Full architecture snapshot — used for prompt context and Dashboard.
   * @returns {object}
   */
  getSnapshot() {
    this._ensureFresh();
    return {
      services: this._services.size,
      events: this._events.size,
      layers: this._layers.size,
      couplings: this._couplings.length,
      upwardDeps: this._couplings.filter(c => c.type === 'upward-dep').length,
      lateBindings: this._couplings.filter(c => c.type.startsWith('late-')).length,
      buildCount: this._buildCount,
      lastBuildTs: this._lastBuildTs,
      layerSummary: Object.fromEntries(
        [...this._layers.entries()].map(([name, info]) => [name, info.services.size])
      ),
    };
  }

  /**
   * Full graph data for interactive architecture visualization.
   * Returns nodes (services, events) and edges (deps, listeners, couplings)
   * structured for force-directed or hierarchical graph rendering.
   *
   * v5.9.2: Added for Dashboard Phase 2 — interactive architecture graph.
   * @returns {{ nodes: Array<object>, edges: Array<object>, layers: Array<object> }}
   */
  getGraphData() {
    this._ensureFresh();

    const nodes = [];
    const edges = [];

    // Service nodes
    for (const [name, info] of this._services) {
      nodes.push({
        id: `svc:${name}`, type: 'service', name,
        layer: info.layer || 'unknown', phase: info.phase ?? -1,
        tags: info.tags || [], file: info.file || null,
      });

      // Dependency edges
      if (info.deps) {
        for (const dep of info.deps) {
          edges.push({ from: `svc:${name}`, to: `svc:${dep}`, type: 'depends-on' });
        }
      }

      // Late-binding edges
      if (info.lateBindings) {
        for (const lb of info.lateBindings) {
          const target = typeof lb === 'string' ? lb : lb.service;
          if (target) {
            edges.push({
              from: `svc:${name}`, to: `svc:${target}`, type: 'late-binding',
              optional: typeof lb === 'object' ? !!lb.optional : false,
            });
          }
        }
      }
    }

    // Event nodes + listener/emitter edges
    for (const [evtName, info] of this._events) {
      nodes.push({ id: `evt:${evtName}`, type: 'event', name: evtName });

      if (info.emitters) {
        for (const em of info.emitters) {
          edges.push({ from: `svc:${em}`, to: `evt:${evtName}`, type: 'emits' });
        }
      }
      if (info.listeners) {
        for (const ln of info.listeners) {
          edges.push({ from: `evt:${evtName}`, to: `svc:${ln}`, type: 'listens' });
        }
      }
    }

    // Coupling edges (cross-phase)
    for (const c of this._couplings) {
      edges.push({ from: `svc:${c.from}`, to: `svc:${c.to}`, type: c.type, detail: c.detail || null });
    }

    // Layer metadata
    const layers = [];
    for (const [name, info] of [...this._layers.entries()].sort((a, b) => a[1].phase - b[1].phase)) {
      layers.push({
        name, phase: info.phase,
        services: [...(info.services || [])],
      });
    }

    return { nodes, edges, layers };
  }

  /**
   * Build prompt context for PromptBuilder.
   * Gives the LLM a compressed view of the architecture.
   * @returns {string}
   */
  buildPromptContext() {
    this._ensureFresh();
    if (this._services.size === 0) return '';

    const parts = [
      `ARCHITECTURE: ${this._services.size} services across ${this._layers.size} layers.`,
    ];

    // Layer summary
    const layerParts = [];
    for (const [layer, info] of [...this._layers.entries()].sort((a, b) => a[1].phase - b[1].phase)) {
      layerParts.push(`${layer}(${info.services.size})`);
    }
    parts.push(`Layers: ${layerParts.join(', ')}.`);

    // Couplings
    const upward = this._couplings.filter(c => c.type === 'upward-dep');
    if (upward.length > 0) {
      parts.push(`WARNING: ${upward.length} upward dependency coupling(s): ${upward.map(c => `${c.from}→${c.to}`).join(', ')}.`);
    }

    return parts.join(' ');
  }
}

// ── Helpers ─────────────────────────────────────────────────

/** Classify a file/module name to its probable service name */
function _classify(name) {
  // PascalCase → camelCase
  return name.charAt(0).toLowerCase() + name.slice(1);
}

module.exports = { ArchitectureReflection };
