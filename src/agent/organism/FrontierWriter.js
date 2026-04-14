// @ts-checked-v5.8
// ============================================================
// GENESIS — FrontierWriter.js (v7.1.6 — Persistent Self)
//
// Generic frontier node writer. Replaces the need for separate
// modules per frontier type. One class, multiple configurations.
//
// Used by:
//   - UNFINISHED_WORK (Phase 8, decay 0.7, max 5)
//   - HIGH_SUSPICION  (Phase 9, decay 0.6, max 8, with merge)
//   - LESSON_APPLIED  (Phase 9, decay 0.6, max 5)
//
// NOT used by EmotionalFrontier — that module stays separate
// because it has Boot Emotion Restore logic (dimension shifts)
// that doesn't fit this generic pattern.
//
// Architecture:
//   extractFn(context) → props | null    — what to write
//   mergeFn(existing, incoming) → merged — optional merge logic
//   FrontierWriter.write()               — enforce limits, write
//   FrontierWriter.getRecent()           — cached query
//   FrontierWriter.buildPromptContext()   — for PromptBuilder
//   FrontierWriter.getDashboardLine()     — for OrganismRenderers
//
// Design principles:
//   - Additive: callers guard with if (this._xxxFrontier)
//   - Deterministic: zero LLM calls
//   - Configurable: all parameters tuneable via Settings
//   - Consistent: same API as EmotionalFrontier (write, getRecent,
//     buildPromptContext, getDashboardLine, getReport)
// ============================================================

'use strict';

const { NullBus } = require('../core/EventBus');
const { createLogger } = require('../core/Logger');

class FrontierWriter {
  /**
   * @param {object} config
   * @param {string} config.name            — Service name (e.g. 'unfinishedWork')
   * @param {string} config.edgeType        — KG edge relation (e.g. 'UNFINISHED_WORK')
   * @param {number} [config.decayFactor]   — Per-boot decay (default 0.6)
   * @param {number} [config.maxImprints]   — Max frontier nodes (default 5)
   * @param {number} [config.pruneThreshold]— Remove edges below this weight (default 0.05)
   * @param {number} [config.cacheTtlMs]    — getRecent() cache TTL (default 5 min)
   * @param {Function} config.extractFn     — (context) => props | null
   * @param {Function} [config.mergeFn]     — (existingProps, incomingProps) => mergedProps | null
   * @param {object} deps
   * @param {*} deps.bus
   * @param {*} deps.knowledgeGraph
   * @param {*} deps.storage
   */
  constructor(config, deps) {
    // Config
    this._name = config.name;
    this._edgeType = config.edgeType;
    this._decayFactor = config.decayFactor ?? 0.6;
    this._maxImprints = config.maxImprints ?? 5;
    this._pruneThreshold = config.pruneThreshold ?? 0.05;
    this._cacheTtlMs = config.cacheTtlMs ?? 5 * 60 * 1000;
    this._extractFn = config.extractFn;
    this._mergeFn = config.mergeFn || null;

    // Dependencies
    this.bus = deps.bus || NullBus;
    this._kg = deps.knowledgeGraph;
    this._storage = deps.storage || null;

    // Logger — named per instance
    this._log = createLogger(`FrontierWriter:${this._name}`);

    // Cache
    this._cache = null;
    this._cacheTs = 0;

    // Stats
    this._stats = {
      written: 0,
      merged: 0,
      evicted: 0,
      skipped: 0,
    };
  }

  // ════════════════════════════════════════════════════════
  // WRITE
  // ════════════════════════════════════════════════════════

  /**
   * Extract data from context and write a frontier node.
   *
   * @param {string} sessionId — Current session identifier
   * @param {object} context   — Passed to extractFn
   * @returns {object|null}    — Written properties or null if skipped
   */
  write(sessionId, context) {
    if (!this._kg) return null;

    // Extract
    let props;
    try {
      props = this._extractFn(context);
    } catch (err) {
      this._log.debug(`[${this._name}] extractFn error:`, err.message);
      return null;
    }

    if (!props) {
      this._stats.skipped++;
      return null;
    }

    // Add metadata
    props.session_id = sessionId;
    props.created = Date.now();

    // Try merge if mergeFn defined
    if (this._mergeFn) {
      const merged = this._tryMerge(props);
      if (merged) {
        this._stats.merged++;
        this._invalidateCache();
        return merged;
      }
    }

    // Enforce max imprints
    this._enforceMaxImprints();

    // Write to frontier
    const label = `${this._name}-${sessionId}`;
    try {
      this._kg.connectToFrontier(
        this._edgeType, label, 1.0,
        this._name, props
      );
      this._stats.written++;
      this._invalidateCache();

      this._log.info(`[${this._name}] Written: ${label}`);
      this.bus.emit(`frontier:${this._name}:written`, {
        sessionId, edgeType: this._edgeType,
      }, { source: `FrontierWriter:${this._name}` });

      return props;
    } catch (err) {
      this._log.debug(`[${this._name}] Write failed:`, err.message);
      return null;
    }
  }

  // ════════════════════════════════════════════════════════
  // MERGE
  // ════════════════════════════════════════════════════════

  /**
   * Attempt to merge incoming props with an existing frontier node.
   * Only called when mergeFn is defined.
   *
   * @param {object} incoming — New properties to potentially merge
   * @returns {object|null}   — Merged properties, or null if no merge candidate
   */
  _tryMerge(incoming) {
    const edges = this._getActiveEdges();
    if (edges.length === 0) return null;

    // Check each existing node for merge compatibility
    for (const edge of edges) {
      const node = this._kg.getNode(edge.target);
      if (!node || !node.properties) continue;

      const merged = this._mergeFn(node.properties, incoming);
      if (merged) {
        // Update existing node via KG API if available, else direct mutation
        if (typeof this._kg.updateFrontierNode === 'function') {
          this._kg.updateFrontierNode(node, merged, edge);
        } else {
          Object.assign(node.properties, merged);
          node.properties.last_merged = Date.now();
          node.accessed = Date.now();
          edge.weight = Math.min((edge.weight || 0.5) + 0.2, 1.0);
          if (typeof this._kg._save === 'function') this._kg._save();
        }

        this._log.debug(`[${this._name}] Merged into: ${node.label}`);
        this.bus.emit(`frontier:${this._name}:merged`, {
          nodeLabel: node.label, edgeType: this._edgeType,
        }, { source: `FrontierWriter:${this._name}` });

        return merged;
      }
    }
    return null;
  }

  // ════════════════════════════════════════════════════════
  // IMPRINT MANAGEMENT
  // ════════════════════════════════════════════════════════

  /**
   * Enforce maximum imprint count. Evicts weakest-first.
   */
  _enforceMaxImprints() {
    const edges = this._getActiveEdges();
    if (edges.length < this._maxImprints) return;

    // Sort by weight ascending — weakest first
    edges.sort((a, b) => (a.weight || 0) - (b.weight || 0));

    // Remove weakest until under limit (+1 for the incoming one)
    const toRemove = edges.length - this._maxImprints + 1;
    for (let i = 0; i < toRemove; i++) {
      const edge = edges[i];
      const target = this._kg.getNode(edge.target);
      if (target) {
        this._kg.disconnectFromFrontier(target.label);
        this._stats.evicted++;
        this._log.debug(`[${this._name}] Evicted: ${target.label} (weight: ${(edge.weight || 0).toFixed(3)})`);
      }
    }
  }

  // ════════════════════════════════════════════════════════
  // QUERY API
  // ════════════════════════════════════════════════════════

  /**
   * Get the N most recent frontier nodes of this type.
   * Cached for _cacheTtlMs to avoid repeated KG traversals.
   * Cache always fetches CACHE_PREFETCH nodes to avoid misses
   * when callers vary count between calls.
   *
   * @param {number} count — Max nodes to return (default 3)
   * @returns {Array<object>} — Node properties + weight + label
   */
  getRecent(count = 3) {
    if (this._cache && (Date.now() - this._cacheTs) < this._cacheTtlMs) {
      return this._cache.slice(0, count);
    }

    const edges = this._getActiveEdges();
    if (edges.length === 0) {
      this._cache = [];
      this._cacheTs = Date.now();
      return [];
    }

    // Sort by weight descending (most relevant first)
    edges.sort((a, b) => (b.weight || 0) - (a.weight || 0));

    // Prefetch more than requested to serve varying count values from cache
    const CACHE_PREFETCH = 5;
    const result = [];
    for (const edge of edges.slice(0, Math.max(count, CACHE_PREFETCH))) {
      const node = this._kg.getNode(edge.target);
      if (node && node.properties) {
        result.push({
          ...node.properties,
          weight: edge.weight || 0,
          nodeId: node.id,
          label: node.label,
        });
      }
    }

    this._cache = result;
    this._cacheTs = Date.now();
    return result.slice(0, count);
  }

  // ════════════════════════════════════════════════════════
  // PROMPT BUILDER
  // ════════════════════════════════════════════════════════

  /**
   * Build a prompt context string for PromptBuilder.
   *
   * @param {number} maxChars — Budget for this section (default 400)
   * @returns {string} — Formatted section or empty string
   */
  buildPromptContext(maxChars = 400) {
    const items = this.getRecent(3);
    if (items.length === 0) return '';

    const header = this._promptHeader();
    const parts = [header];
    let len = header.length;

    for (const item of items) {
      const line = this._promptLine(item);
      if (len + line.length + 1 > maxChars) break;
      parts.push(line);
      len += line.length + 1;
    }

    return parts.join('\n');
  }

  /**
   * Prompt header — overridable per config, sensible default.
   * @returns {string}
   */
  _promptHeader() {
    const HEADERS = {
      unfinishedWork: 'UNFINISHED WORK (from recent sessions):',
      suspicion: 'WATCH OUT (surprising patterns observed):',
      lessonTracking: 'RECENTLY APPLIED LESSONS:',
    };
    return HEADERS[this._name] || `${this._edgeType} (frontier):`;
  }

  /**
   * Format a single item for the prompt.
   * @param {object} item — Node properties + weight
   * @returns {string}
   */
  _promptLine(item) {
    const age = this._formatAge(item.created);
    const weight = Math.round((item.weight || 0) * 100);
    const detail = item.description
      || item.dominant_category
      || item.categories?.join(', ')
      || item.session_id
      || 'unknown';
    return `  - ${detail.slice(0, 100)} (${age}, ${weight}% strength)`;
  }

  // ════════════════════════════════════════════════════════
  // DASHBOARD
  // ════════════════════════════════════════════════════════

  /**
   * One-liner for the dashboard Organism panel.
   * @returns {string|null}
   */
  getDashboardLine() {
    const items = this.getRecent(1);
    if (items.length === 0) return null;

    const item = items[0];
    const age = this._formatAge(item.created);
    const weight = Math.round((item.weight || 0) * 100);
    const detail = item.description?.slice(0, 60)
      || item.dominant_category
      || item.categories?.[0]
      || '?';
    return `${this._edgeType}: ${detail} (${age}, ${weight}%)`;
  }

  // ════════════════════════════════════════════════════════
  // EVENT BUFFERING
  // ════════════════════════════════════════════════════════

  /**
   * v7.1.6: Enable event-buffered mode. Collects events over a session
   * and writes at a trigger event. Replaces closure-based buffers in
   * manifests — buffer lifecycle is now owned by the writer instance.
   *
   * @param {string} collectEvent  — Event to buffer (e.g. 'surprise:novel-event')
   * @param {string} triggerEvent  — Event that triggers write (e.g. 'session:ending')
   * @param {string} contextKey    — Key to wrap buffer under (e.g. 'novelEvents')
   * @param {number} [maxSize=200] — Max buffer size (oldest evicted on overflow)
   */
  enableEventBuffer(collectEvent, triggerEvent, contextKey, maxSize = 200) {
    this._eventBuffer = [];
    this._bufferContextKey = contextKey;
    this._bufferMaxSize = maxSize;

    this.bus.on(collectEvent, (data) => {
      if (this._eventBuffer.length >= this._bufferMaxSize) this._eventBuffer.shift();
      this._eventBuffer.push(data);
    }, { source: `FrontierWriter:${this._name}`, key: `${this._name}-buffer` });

    this.bus.on(triggerEvent, (data) => {
      if (this._eventBuffer.length > 0) {
        this.write(data?.sessionId || 'unknown', { [contextKey]: [...this._eventBuffer] });
        this._eventBuffer.length = 0;
      }
    }, { source: `FrontierWriter:${this._name}`, key: `${this._name}-flush` });
  }

  /**
   * Current buffer size (for diagnostics).
   * @returns {number}
   */
  get bufferSize() {
    return this._eventBuffer ? this._eventBuffer.length : 0;
  }

  // ════════════════════════════════════════════════════════
  // DIAGNOSTICS
  // ════════════════════════════════════════════════════════

  /**
   * Report for AgentCoreHealth.
   */
  getReport() {
    return {
      name: this._name,
      edgeType: this._edgeType,
      config: {
        decayFactor: this._decayFactor,
        maxImprints: this._maxImprints,
        pruneThreshold: this._pruneThreshold,
      },
      stats: { ...this._stats },
      activeNodes: this._getActiveEdges().length,
      bufferSize: this.bufferSize,
      latest: this.getRecent(1)[0] || null,
      dashboardLine: this.getDashboardLine(),
    };
  }

  // ════════════════════════════════════════════════════════
  // INTERNAL HELPERS
  // ════════════════════════════════════════════════════════

  /**
   * Get all active edges of this type from the frontier.
   */
  _getActiveEdges() {
    if (!this._kg || !this._kg.graph || !this._kg.graph.edges) return [];

    const frontier = this._kg.graph.findNode('frontier');
    if (!frontier) return [];

    const result = [];
    for (const [, edge] of this._kg.graph.edges) {
      if (edge.source === frontier.id && edge.relation === this._edgeType) {
        result.push(edge);
      }
    }
    return result;
  }

  _invalidateCache() {
    this._cache = null;
  }

  _formatAge(created) {
    if (!created) return 'unknown age';
    const ageMs = Date.now() - created;
    const hours = Math.round(ageMs / (1000 * 60 * 60));
    if (hours < 1) return 'this session';
    if (hours < 24) return `${hours}h ago`;
    const days = Math.round(hours / 24);
    return `${days} day${days > 1 ? 's' : ''} ago`;
  }
}

module.exports = { FrontierWriter };
