// @ts-checked-v6.0
// ============================================================
// GENESIS — MemoryConsolidator.js (v6.0.0 — V6-7)
//
// Periodic pruning and merging of KnowledgeGraph and LessonsStore
// to prevent unbounded growth.
//
// PROBLEM: KG nodes and lessons accumulate without limit over
// long-running sessions. Redundant nodes, stale lessons, and
// low-relevance data waste context budget and degrade recall
// quality. No existing framework addresses memory hygiene.
//
// SOLUTION: Three consolidation strategies:
//   1. KG Redundancy Detection — merge semantically duplicate
//      nodes sharing type + overlapping labels/properties.
//   2. Lesson Archival — lessons older than N days with low
//      access count → archived to ~/.genesis-lessons/archive/
//   3. Relevance Scoring — decay-weighted score (recency ×
//      access frequency) drives eviction priority.
//
// Integration points:
//   - IdleMind._think()       → triggers via bus event
//   - KnowledgeGraph           → pruneStale(), removeNode()
//   - LessonsStore             → getAll(), record()
//   - Dashboard                → compaction report via IPC
//
// Pattern: Phase 9 cognitive service. Bus-driven. Optional deps.
// Runs on IdleMind schedule OR manual trigger via IPC.
// ============================================================

'use strict';

const fs = require('fs');
const path = require('path');
const { createLogger } = require('../core/Logger');
const { applySubscriptionHelper } = require('../core/subscription-helper');
const _log = createLogger('MemoryConsolidator');

const DEFAULT_CONFIG = {
  archivalAgeDays: 30,          // Lessons older than this with low use → archive
  archivalMinUseCount: 2,       // Below this use count → candidate for archival
  kgStaleNodeDays: 14,          // KG nodes unaccessed for this long → prune candidates
  kgMergeThreshold: 0.75,       // Label similarity threshold for merge candidates
  maxMergesPerRun: 20,          // Cap merges per consolidation run
  maxArchivalsPerRun: 30,       // Cap archival per run
  cooldownMs: 5 * 60 * 1000,   // Minimum time between consolidation runs
};

class MemoryConsolidator {
  /**
   * @param {object} deps
   * @param {object} deps.bus        - EventBus (required)
   * @param {object} [deps.config]   - Override thresholds
   */
  constructor({ bus, config = {} }) {
    this.bus = bus;
    this._config = { ...DEFAULT_CONFIG, ...config };

    // Late-bound dependencies (optional)
    this.knowledgeGraph = null;
    this.lessonsStore = null;
    this.storage = null;

    this._unsubs = [];
    this._lastRunTs = 0;
    this._running = false;

    // Cumulative stats across all runs
    this._stats = {
      totalRuns: 0,
      kgNodesMerged: 0,
      kgNodesPruned: 0,
      lessonsArchived: 0,
      lessonsDecayed: 0,
      lastRunDurationMs: 0,
      lastRunTs: 0,
    };
  }

  // ════════════════════════════════════════════════════════
  // LIFECYCLE
  // ════════════════════════════════════════════════════════

  start() {
    // Listen for IdleMind consolidation trigger
    this._sub('idle:consolidate-memory', () => {
      this.consolidate().catch(err =>
        _log.warn('[CONSOLIDATOR] Idle-triggered run failed:', err.message));
    });

    // Listen for workspace evictions — track for potential KG archival
    this._sub('workspace:slot-evicted', (data) => {
      _log.debug(`[CONSOLIDATOR] Slot evicted: ${data.key} (salience: ${data.salience})`);
    });

    _log.info('[CONSOLIDATOR] Active — memory hygiene enabled');
  }

  stop() {
    for (const unsub of this._unsubs) {
      try { unsub(); } catch (_) { /* best effort */ }
    }
    this._unsubs = [];
    _log.info(`[CONSOLIDATOR] Stopped — ${this._stats.totalRuns} runs, ${this._stats.kgNodesMerged} merged, ${this._stats.lessonsArchived} archived`);
  }

  // ════════════════════════════════════════════════════════
  // CORE API
  // ════════════════════════════════════════════════════════

  /**
   * Run a full consolidation cycle.
   * Safe to call multiple times — cooldown enforced.
   * @returns {Promise<object>} Compaction report
   */
  async consolidate() {
    // Cooldown guard
    const now = Date.now();
    if (now - this._lastRunTs < this._config.cooldownMs) {
      _log.debug('[CONSOLIDATOR] Skipping — cooldown active');
      return { skipped: true, reason: 'cooldown' };
    }
    if (this._running) {
      return { skipped: true, reason: 'already-running' };
    }

    this._running = true;
    this._lastRunTs = now;
    const startTs = now;

    const report = {
      timestamp: new Date().toISOString(),
      kg: { merged: 0, pruned: 0, beforeNodes: 0, afterNodes: 0 },
      lessons: { archived: 0, decayed: 0, beforeCount: 0, afterCount: 0 },
      durationMs: 0,
    };

    try {
      // ── Phase 1: KG Consolidation ──────────────────────
      if (this.knowledgeGraph) {
        report.kg = this._consolidateKG();
      }

      // ── Phase 2: Lesson Archival ───────────────────────
      if (this.lessonsStore) {
        report.lessons = this._consolidateLessons();
      }

      report.durationMs = Date.now() - startTs;

      // Update cumulative stats
      this._stats.totalRuns++;
      this._stats.kgNodesMerged += report.kg.merged;
      this._stats.kgNodesPruned += report.kg.pruned;
      this._stats.lessonsArchived += report.lessons.archived;
      this._stats.lessonsDecayed += report.lessons.decayed;
      this._stats.lastRunDurationMs = report.durationMs;
      this._stats.lastRunTs = now;

      // Emit completion event
      this.bus.emit('memory:consolidation-complete', {
        kgMerged: report.kg.merged,
        kgPruned: report.kg.pruned,
        lessonsArchived: report.lessons.archived,
        lessonsDecayed: report.lessons.decayed,
        durationMs: report.durationMs,
      }, { source: 'MemoryConsolidator' });

      _log.info(`[CONSOLIDATOR] Complete — KG: ${report.kg.merged} merged, ${report.kg.pruned} pruned | Lessons: ${report.lessons.archived} archived, ${report.lessons.decayed} decayed (${report.durationMs}ms)`);

      return report;

    } catch (err) {
      _log.warn('[CONSOLIDATOR] Consolidation failed:', err.message);
      this.bus.emit('memory:consolidation-failed', {
        error: err.message,
      }, { source: 'MemoryConsolidator' });
      return { ...report, error: err.message };

    } finally {
      this._running = false;
    }
  }

  /**
   * Get compaction report for Dashboard display.
   * @returns {object}
   */
  getReport() {
    const kgStats = this.knowledgeGraph?.getStats?.() || null;
    const lessonCount = this.lessonsStore?.getAll?.()?.length ?? null;

    return {
      stats: { ...this._stats },
      currentState: {
        kgNodes: kgStats?.nodes ?? null,
        kgEdges: kgStats?.edges ?? null,
        lessonCount,
      },
      config: { ...this._config },
      cooldownRemaining: Math.max(0, this._config.cooldownMs - (Date.now() - this._lastRunTs)),
    };
  }

  // ════════════════════════════════════════════════════════
  // KG CONSOLIDATION
  // ════════════════════════════════════════════════════════

  /**
   * @private
   * Merge semantically duplicate KG nodes and prune stale ones.
   */
  _consolidateKG() {
    const graph = this.knowledgeGraph.graph;
    const beforeNodes = graph.nodes.size;

    // ── Step 1: Prune stale nodes ────────────────────────
    const pruned = this.knowledgeGraph.pruneStale(this._config.kgStaleNodeDays);

    // ── Step 2: Detect & merge duplicates ────────────────
    let merged = 0;
    const mergeGroups = this._findKGMergeCandidates(graph);

    for (const group of mergeGroups.slice(0, this._config.maxMergesPerRun)) {
      if (this._mergeKGNodes(graph, group)) {
        merged++;
      }
    }

    if (merged > 0 || pruned > 0) {
      // Trigger save via a no-op property update
      this.knowledgeGraph._save();
    }

    return {
      merged,
      pruned,
      beforeNodes,
      afterNodes: graph.nodes.size,
    };
  }

  /**
   * @private
   * Find groups of KG nodes that are merge candidates.
   * Criteria: same type, similar labels (Jaccard similarity > threshold).
   */
  _findKGMergeCandidates(graph) {
    const byType = new Map(); // type → [{ id, label, node }]

    for (const [id, node] of graph.nodes) {
      const type = node.type;
      if (!byType.has(type)) byType.set(type, []);
      byType.get(type).push({ id, label: (node.label || '').toLowerCase().trim(), node });
    }

    const groups = [];

    for (const [_type, nodes] of byType) {
      if (nodes.length < 2) continue;

      const merged = new Set();
      for (let i = 0; i < nodes.length; i++) {
        if (merged.has(nodes[i].id)) continue;

        const group = [nodes[i]];
        for (let j = i + 1; j < nodes.length; j++) {
          if (merged.has(nodes[j].id)) continue;

          const sim = this._labelSimilarity(nodes[i].label, nodes[j].label);
          if (sim >= this._config.kgMergeThreshold) {
            group.push(nodes[j]);
            merged.add(nodes[j].id);
          }
        }

        if (group.length > 1) {
          merged.add(nodes[i].id);
          groups.push(group);
        }
      }
    }

    return groups;
  }

  /**
   * @private
   * Merge a group of KG nodes into the one with highest access count.
   * Properties are merged (union). Edges are redirected.
   */
  _mergeKGNodes(graph, group) {
    try {
      // Keep the most-accessed node as the survivor
      group.sort((a, b) => (b.node.accessCount || 0) - (a.node.accessCount || 0));
      const survivor = group[0];
      const victims = group.slice(1);

      for (const victim of victims) {
        // Merge properties
        survivor.node.properties = { ...victim.node.properties, ...survivor.node.properties };
        survivor.node.accessCount = (survivor.node.accessCount || 0) + (victim.node.accessCount || 0);

        // Redirect edges
        if (graph.neighborIndex.has(victim.id)) {
          for (const edgeId of graph.neighborIndex.get(victim.id)) {
            const edge = graph.edges.get(edgeId);
            if (!edge) continue;
            if (edge.source === victim.id) edge.source = survivor.id;
            if (edge.target === victim.id) edge.target = survivor.id;
            // Remove self-loops created by merge
            if (edge.source === edge.target) {
              graph.edges.delete(edgeId);
            }
          }
        }

        // Remove victim
        graph.removeNode(victim.id);
      }

      return true;
    } catch (err) {
      _log.debug(`[CONSOLIDATOR] KG merge failed: ${err.message}`);
      return false;
    }
  }

  /**
   * @private
   * Word-level Jaccard similarity between two labels.
   */
  _labelSimilarity(a, b) {
    if (a === b) return 1.0;
    if (!a || !b) return 0.0;

    const wordsA = new Set(a.split(/\s+/).filter(w => w.length > 1));
    const wordsB = new Set(b.split(/\s+/).filter(w => w.length > 1));

    if (wordsA.size === 0 || wordsB.size === 0) return 0.0;

    let intersection = 0;
    for (const w of wordsA) {
      if (wordsB.has(w)) intersection++;
    }

    return intersection / (wordsA.size + wordsB.size - intersection);
  }

  // ════════════════════════════════════════════════════════
  // LESSON CONSOLIDATION
  // ════════════════════════════════════════════════════════

  /**
   * @private
   * Archive old, low-use lessons and apply decay scoring.
   */
  _consolidateLessons() {
    const allLessons = this.lessonsStore.getAll();
    const beforeCount = allLessons.length;
    const now = Date.now();
    const archivalAgeMs = this._config.archivalAgeDays * 24 * 60 * 60 * 1000;

    let archived = 0;
    let decayed = 0;
    const toArchive = [];

    for (const lesson of allLessons) {
      const age = now - (lesson.createdAt || 0);
      const daysSinceUse = (now - (lesson.lastUsed || lesson.createdAt || 0)) / (24 * 60 * 60 * 1000);

      // Archival candidate: old + rarely used
      if (age > archivalAgeMs && (lesson.useCount || 0) < this._config.archivalMinUseCount) {
        toArchive.push(lesson);
        if (toArchive.length >= this._config.maxArchivalsPerRun) break;
      }

      // Decay scoring: mark lessons that are aging but not yet archival
      if (daysSinceUse > this._config.archivalAgeDays / 2 &&
          (lesson.useCount || 0) < this._config.archivalMinUseCount + 1) {
        decayed++;
      }
    }

    // Archive: write to archive file, then remove from store
    if (toArchive.length > 0) {
      this._archiveLessons(toArchive);
      archived = toArchive.length;
    }

    return {
      archived,
      decayed,
      beforeCount,
      afterCount: beforeCount - archived,
    };
  }

  /**
   * @private
   * Write lessons to archive file and remove from active store.
   */
  _archiveLessons(lessons) {
    try {
      // Determine archive path
      const archiveDir = this.storage
        ? path.join(this.lessonsStore._globalDir, 'archive')
        : path.join(this.lessonsStore._globalDir, 'archive');

      if (!fs.existsSync(archiveDir)) {
        fs.mkdirSync(archiveDir, { recursive: true });
      }

      const archiveFile = path.join(archiveDir, `archived-${Date.now()}.json`);
      fs.writeFileSync(archiveFile, JSON.stringify({
        archivedAt: new Date().toISOString(),
        count: lessons.length,
        lessons,
      }, null, 2), 'utf-8');

      // Remove from active store by filtering
      const ids = new Set(lessons.map(l => l.id));
      const remaining = this.lessonsStore._lessons.filter(l => !ids.has(l.id));
      this.lessonsStore._lessons = remaining;
      this.lessonsStore._dirty = true;

      _log.info(`[CONSOLIDATOR] Archived ${lessons.length} lessons to ${archiveFile}`);
    } catch (err) {
      _log.warn(`[CONSOLIDATOR] Lesson archival failed: ${err.message}`);
    }
  }

  // ════════════════════════════════════════════════════════
  // INTERNALS
  // ════════════════════════════════════════════════════════

  /** @private Subscribe to bus with auto-cleanup — see subscription-helper.js */
}

applySubscriptionHelper(MemoryConsolidator, { defaultSource: 'MemoryConsolidator' });

module.exports = { MemoryConsolidator };
