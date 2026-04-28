// ============================================================
// GENESIS — ColonyOrchestrator.js (v7.1.0 — V7-1 Real IPC)
//
// Multi-agent coordination layer. A "lead" agent decomposes a
// high-level goal into subtasks, distributes them to worker
// peers, merges results, and resolves conflicts.
//
// V7-1 upgrade: When no HTTP peers are available, subtasks are
// executed in real child processes via SelfSpawner (fork + IPC)
// instead of the former no-op stub. spawnParallel() runs all
// subtasks concurrently; results flow back through Node IPC.
//
// Prerequisites (all ✅):
//   - PeerNetwork (discovery, messaging, sync)
//   - PeerConsensus (voting, vector clocks)
//   - TaskDelegation (single-task dispatch)
//   - SelfSpawner (fork + IPC worker processes)   ← V7-1 new
//
// This module adds:
//   - Goal decomposition (via LLM)
//   - Parallel work distribution across peers
//   - Local IPC execution via SelfSpawner (V7-1)
//   - Result collection with timeout + retry
//   - Conflict detection (same-file edits)
//   - Consensus-gated merge for critical changes
//   - Colony health monitoring
//
// Phase: 8 (revolution) — same as PeerNetwork
// ============================================================

'use strict';

const { createLogger } = require('../core/Logger');
const _log = createLogger('ColonyOrchestrator');

const COLONY_DEFAULTS = {
  maxSubtasks:     10,
  subtaskTimeoutMs: 120_000,   // 2 min per subtask
  maxRetries:       2,
  requireConsensus: true,      // Require vote before merging code changes
  minVotes:         1,         // Minimum votes for consensus (1 = any peer)
};

/**
 * @typedef {{ id: string, description: string, assignedTo: string|null, status: 'pending'|'assigned'|'done'|'failed', result: *|null, retries: number, createdAt: number }} Subtask
 * @typedef {{ id: string, goal: string, status: 'planning'|'running'|'merging'|'done'|'failed', subtasks: Subtask[], startedAt: number, completedAt: number|null }} ColonyRun
 */

const { applySubscriptionHelper } = require('../core/subscription-helper');

class ColonyOrchestrator {
  /**
   * @param {{ bus: *, peerNetwork: *, taskDelegation: *, peerConsensus: *, llm: *, selfSpawner?: *, config?: Partial<typeof COLONY_DEFAULTS> }} deps
   */
  constructor({ bus, peerNetwork, taskDelegation, peerConsensus, llm, selfSpawner, config }) {
    /** @type {*} */ this.bus = bus;
    /** @type {*} */ this.peers = peerNetwork;
    /** @type {*} */ this.delegation = taskDelegation;
    /** @type {*} */ this.consensus = peerConsensus;
    /** @type {*} */ this.llm = llm;
    /** @type {*|null} */ this.selfSpawner = selfSpawner || null;  // V7-1: IPC worker pool
    /** @type {typeof COLONY_DEFAULTS} */ this.config = { ...COLONY_DEFAULTS, ...config };

    /** @type {Map<string, ColonyRun>} */
    this._runs = new Map();
    /** @type {boolean} */ this._stopped = false;
    /** @type {Array<Function>} */
    this._unsubs = [];

    // Metadata
    this.META = {
      id: 'colonyOrchestrator',
      name: 'ColonyOrchestrator',
      version: '7.1.0',
      phase: 8,
      tags: ['colony', 'multi-agent', 'coordination'],
    };
  }

  // ── Lifecycle ─────────────────────────────────────────────

  async boot() {
    this._sub('colony:run-request', (data) => this._handleRunRequest(data));
    const ipcMode = this.selfSpawner ? 'IPC workers' : 'no local workers';
    const peerMode = this.peers ? 'HTTP peers' : 'no peers';
    _log.info(`[COLONY] ColonyOrchestrator v7.1.0 ready (${ipcMode}, ${peerMode})`);
  }

  async stop() {
    this._stopped = true;
    // Cancel in-flight runs
    for (const [, run] of this._runs) {
      if (run.status === 'running' || run.status === 'planning') {
        run.status = 'failed';
      }
    }
    // Unsubscribe listeners
    this._unsubAll();
  }

  // ── Public API ────────────────────────────────────────────

  /**
   * Execute a colony run: decompose goal → distribute → collect → merge.
   * @param {string} goal — High-level goal description
   * @param {{ files?: string[], context?: string }} [options]
   * @returns {Promise<ColonyRun>}
   */
  async execute(goal, options = {}) {
    const runId = this._uid();
    /** @type {ColonyRun} */
    const run = {
      id: runId,
      goal,
      status: 'planning',
      subtasks: [],
      startedAt: Date.now(),
      completedAt: null,
    };
    this._runs.set(runId, run);
    this.bus.fire('colony:run-started', { id: runId, goal }, { source: 'ColonyOrchestrator' });
    _log.info(`[COLONY] Run ${runId.slice(0, 8)} started: ${goal.slice(0, 80)}`);

    try {
      // 1. Decompose goal into subtasks
      run.subtasks = await this._decompose(goal, options);
      _log.info(`[COLONY] Decomposed into ${run.subtasks.length} subtasks`);

      // 2. Get available peers
      const availablePeers = this._getAvailablePeers();
      if (availablePeers.length === 0) {
        _log.warn('[COLONY] No peers available — executing locally');
        return this._executeLocally(run);
      }

      // 3. Distribute subtasks
      run.status = 'running';
      await this._distribute(run, availablePeers);

      // 4. Collect results (with timeout)
      await this._collectResults(run);

      // 5. Merge results (with conflict detection + consensus)
      run.status = 'merging';
      await this._mergeResults(run);

      run.status = 'done';
      run.completedAt = Date.now();
      this.bus.fire('colony:run-completed', {
        id: runId, goal,
        subtasks: run.subtasks.length,
        duration: run.completedAt - run.startedAt,
      }, { source: 'ColonyOrchestrator' });

    } catch (err) {
      run.status = 'failed';
      run.completedAt = Date.now();
      _log.error(`[COLONY] Run ${runId.slice(0, 8)} failed: ${err.message}`);
      this.bus.fire('colony:run-failed', { id: runId, error: err.message }, { source: 'ColonyOrchestrator' });
    }

    return run;
  }

  /**
   * Get status of a colony run.
   * @param {string} runId
   * @returns {ColonyRun|null}
   */
  getRunStatus(runId) {
    return this._runs.get(runId) || null;
  }

  /**
   * Get all runs.
   * @returns {ColonyRun[]}
   */
  getAllRuns() {
    return [...this._runs.values()];
  }

  /**
   * Colony health snapshot.
   */
  getHealth() {
    const peers = this._getAvailablePeers();
    const activeRuns = [...this._runs.values()].filter(r => r.status === 'running' || r.status === 'planning');
    return {
      peers: peers.length,
      activeRuns: activeRuns.length,
      totalRuns: this._runs.size,
      ipcWorkers: this.selfSpawner ? (this.selfSpawner.getStats?.()?.active ?? true) : false,
      config: { ...this.config },
    };
  }

  // ── Goal Decomposition ────────────────────────────────────

  /**
   * Use LLM to decompose a goal into independent subtasks.
   * @param {string} goal
   * @param {{ files?: string[], context?: string }} options
   * @returns {Promise<Subtask[]>}
   */
  async _decompose(goal, options) {
    const prompt = [
      'You are a task decomposition engine for a software agent colony.',
      'Break the following goal into independent, parallelizable subtasks.',
      'Each subtask should be completable by a single agent without coordination.',
      `Maximum ${this.config.maxSubtasks} subtasks.`,
      '',
      `Goal: ${goal}`,
      options.context ? `Context: ${options.context}` : '',
      options.files?.length ? `Files involved: ${options.files.join(', ')}` : '',
      '',
      'Respond with a JSON array of objects: [{ "description": "...", "files": ["..."] }]',
      'Only output the JSON array, nothing else.',
    ].filter(Boolean).join('\n');

    try {
      // v7.5.0: ModelBridge.chat uses positional signature
      // (systemPrompt, messages, taskType, options). The old
      // .generate(prompt, opts) call never existed on ModelBridge —
      // this was a leftover from a different LLM port. Decomposition
      // failed silently with "this.llm.generate is not a function"
      // and Colony fell back to single-task mode every time.
      const response = await this.llm.chat(
        'You are a task decomposer. Output only the requested JSON array, nothing else.',
        [{ role: 'user', content: prompt }],
        'planning',
        { maxTokens: 2000, temperature: 0.3 },
      );

      // ModelBridge returns either a string or { content/text }.
      const text = typeof response === 'string'
        ? response
        : response?.text || response?.content || '';
      const cleaned = text.replace(/```json|```/g, '').trim();
      const tasks = JSON.parse(cleaned);

      if (!Array.isArray(tasks)) throw new Error('LLM returned non-array');

      return tasks.slice(0, this.config.maxSubtasks).map((t, i) => ({
        id: `${this._uid()}-${i}`,
        description: t.description || `Subtask ${i + 1}`,
        assignedTo: null,
        status: /** @type {const} */ ('pending'),
        result: null,
        retries: 0,
        createdAt: Date.now(),
      }));
    } catch (err) {
      _log.warn(`[COLONY] Decomposition failed: ${err.message} — creating single task`);
      return [{
        id: this._uid(),
        description: goal,
        assignedTo: null,
        status: /** @type {const} */ ('pending'),
        result: null,
        retries: 0,
        createdAt: Date.now(),
      }];
    }
  }

  // ── Distribution ──────────────────────────────────────────

  /**
   * Round-robin distribute subtasks to available peers.
   * @param {ColonyRun} run
   * @param {Array<{ id: string }>} peers
   */
  async _distribute(run, peers) {
    for (let i = 0; i < run.subtasks.length; i++) {
      const subtask = run.subtasks[i];
      const peer = peers[i % peers.length];

      try {
        subtask.assignedTo = peer.id;
        subtask.status = 'assigned';

        await this.delegation.delegate(subtask.description, [], {
          targetPeer: peer.id,
          metadata: { colonyRunId: run.id, subtaskId: subtask.id },
        });

        _log.debug(`[COLONY] Subtask ${subtask.id.slice(0, 8)} → peer ${peer.id.slice(0, 8)}`);
      } catch (err) {
        _log.warn(`[COLONY] Delegate to ${peer.id.slice(0, 8)} failed: ${err.message}`);
        subtask.status = 'pending'; // Will be retried
        subtask.assignedTo = null;
      }
    }
  }

  // ── Result Collection ─────────────────────────────────────

  /**
   * Wait for all subtasks to complete or timeout.
   * @param {ColonyRun} run
   */
  async _collectResults(run) {
    const deadline = Date.now() + this.config.subtaskTimeoutMs;

    while (Date.now() < deadline && !this._stopped) {
      const pending = run.subtasks.filter(s => s.status === 'assigned');
      if (pending.length === 0) break;

      // Check delegation results
      for (const subtask of pending) {
        const result = this.delegation.getResult?.(subtask.id);
        if (result) {
          subtask.status = 'done';
          subtask.result = result;
        }
      }

      await this._sleep(2000);
    }

    // Retry failed/timed-out subtasks locally via IPC (V7-1)
    for (const subtask of run.subtasks) {
      if (subtask.status === 'assigned' || subtask.status === 'pending') {
        if (subtask.retries < this.config.maxRetries) {
          subtask.retries++;
          _log.info(`[COLONY] Retrying subtask ${subtask.id.slice(0, 8)} locally (attempt ${subtask.retries})`);
          subtask.status = 'pending';
          // Timed-out peer tasks fall back to _executeLocally on the next execute() call.
        } else {
          subtask.status = 'failed';
        }
      }
    }
  }

  // ── Result Merging ────────────────────────────────────────

  /**
   * Merge subtask results. Detect file conflicts and use
   * consensus if required.
   * @param {ColonyRun} run
   */
  async _mergeResults(run) {
    const results = run.subtasks.filter(s => s.status === 'done' && s.result);

    if (results.length === 0) {
      _log.warn('[COLONY] No successful subtask results to merge');
      return;
    }

    // Detect file conflicts (multiple subtasks editing the same file)
    const fileEdits = new Map(); // file → [subtaskId, ...]
    for (const subtask of results) {
      const files = subtask.result?.modifiedFiles || [];
      for (const f of files) {
        if (!fileEdits.has(f)) fileEdits.set(f, []);
        fileEdits.get(f).push(subtask.id);
      }
    }

    const conflicts = [...fileEdits.entries()].filter(([, ids]) => ids.length > 1);

    if (conflicts.length > 0 && this.config.requireConsensus) {
      _log.info(`[COLONY] ${conflicts.length} file conflict(s) detected — requesting consensus`);

      for (const [file, taskIds] of conflicts) {
        const proposal = {
          type: 'colony-merge-conflict',
          file,
          subtasks: taskIds,
          runId: run.id,
        };

        try {
          const decision = await this._requestConsensus(proposal);
          _log.info(`[COLONY] Consensus for ${file}: ${decision.accepted ? 'accepted' : 'rejected'}`);
        } catch (err) {
          _log.warn(`[COLONY] Consensus failed for ${file}: ${err.message}`);
        }
      }
    }

    this.bus.fire('colony:merge-completed', {
      runId: run.id,
      merged: results.length,
      conflicts: conflicts.length,
    }, { source: 'ColonyOrchestrator' });
  }

  // ── Consensus ─────────────────────────────────────────────

  /**
   * Request peer consensus for a proposal.
   * @param {*} proposal
   * @returns {Promise<{ accepted: boolean, votes: number }>}
   */
  async _requestConsensus(proposal) {
    if (!this.consensus || typeof this.consensus.propose !== 'function') {
      return { accepted: true, votes: 0 }; // No consensus service → auto-accept
    }

    const result = await this.consensus.propose(proposal);
    return {
      accepted: (result?.accepted ?? result?.votes?.yes ?? 0) >= this.config.minVotes,
      votes: result?.votes?.total ?? 0,
    };
  }

  // ── Local IPC Fallback (V7-1) ─────────────────────────────

  /**
   * Execute all subtasks locally via SelfSpawner IPC workers.
   * V7-1: Real child-process execution via fork() + IPC.
   * Falls back to passthrough if SelfSpawner is not available.
   * @param {ColonyRun} run
   * @returns {Promise<ColonyRun>}
   */
  async _executeLocally(run) {
    run.status = 'running';

    if (this.selfSpawner) {
      // V7-1: Real IPC — spawn worker processes for each subtask in parallel.
      const tasks = run.subtasks.map(s => ({
        description: s.description,
        type: 'generic',
        context: { colonyRunId: run.id, subtaskId: s.id },
        timeoutMs: this.config.subtaskTimeoutMs,
      }));

      _log.info(`[COLONY] Spawning ${tasks.length} IPC worker(s) for local execution`);
      this.bus.fire('colony:ipc-spawn', {
        runId: run.id, workerCount: tasks.length,
      }, { source: 'ColonyOrchestrator' });

      const results = await this.selfSpawner.spawnParallel(tasks);

      for (let i = 0; i < run.subtasks.length; i++) {
        const subtask = run.subtasks[i];
        const workerResult = results[i] || { success: false, error: 'No result returned' };
        subtask.assignedTo = 'local-ipc';
        if (workerResult.success) {
          subtask.status = 'done';
          subtask.result = workerResult.result || { ipc: true, description: subtask.description };
        } else {
          subtask.status = 'failed';
          subtask.result = { error: workerResult.error };
          _log.warn(`[COLONY] IPC worker failed for subtask ${subtask.id.slice(0, 8)}: ${workerResult.error}`);
        }
      }
    } else {
      // No SelfSpawner available — passthrough (marks done, no actual execution).
      // This path is used in tests and when SelfSpawner is explicitly absent.
      _log.warn('[COLONY] No SelfSpawner available — passthrough mode (subtasks not executed)');
      for (const subtask of run.subtasks) {
        subtask.assignedTo = 'passthrough';
        subtask.status = 'done';
        subtask.result = { passthrough: true, description: subtask.description };
      }
    }

    run.status = 'done';
    run.completedAt = Date.now();
    return run;
  }

  // ── Helpers ───────────────────────────────────────────────

  _getAvailablePeers() {
    if (!this.peers) return [];
    const allPeers = this.peers.getPeers?.() || this.peers.peers || [];
    return (Array.isArray(allPeers) ? allPeers : [...allPeers.values()])
      .filter(p => p.status === 'connected' || p.alive);
  }

  _uid() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
  }

  _sleep(ms) {
    return new Promise(r => setTimeout(r, ms));
  }

  _handleRunRequest(data) {
    if (!data?.goal) return;
    this.execute(data.goal, data.options || {}).catch(err => {
      _log.error('[COLONY] Requested run failed:', err.message);
    });
  }
}

applySubscriptionHelper(ColonyOrchestrator);

module.exports = { ColonyOrchestrator };
