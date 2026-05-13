// @ts-checked-v5.7
// ============================================================
// GENESIS — SelfSpawner.js (Phase 12 — Self-Spawning Workers)
//
// PROBLEM: Genesis is single-threaded. When AgentLoop runs a
// complex goal, the UI blocks. When IdleMind thinks, chat waits.
//
// SOLUTION: Spawn focused Node.js worker processes for sub-tasks.
// Each worker gets a minimal context (goal, relevant code/memory)
// and runs independently. Results flow back via IPC.
//
// NOT a full Genesis instance — a lightweight worker with:
//   - ModelBridge (LLM access)
//   - Sandbox (code execution)
//   - Focused context (only what the sub-task needs)
//   - Time limit
//
// Integration:
//   AgentLoop DELEGATE step → SelfSpawner.spawn(subGoal)
//   TaskDelegation → can delegate to self via SelfSpawner
//   FormalPlanner → can plan PARALLEL steps that run concurrently
// ============================================================

const { fork } = require('child_process');
const path = require('path');
const { NullBus } = require('../core/EventBus');

const WORKER_SCRIPT = path.join(__dirname, '_self-worker.js');

class SelfSpawner {
  constructor({ bus, storage, eventStore, rootDir, config }) {
    this.bus = bus || NullBus;
    this.storage = storage || null;
    this.eventStore = eventStore || null;
    this.model = null; // lateBinding
    this.rootDir = rootDir;

    const cfg = config || {};
    this._maxWorkers = cfg.maxWorkers || 3;
    this._defaultTimeoutMs = cfg.timeoutMs || 5 * 60 * 1000;
    this._memoryLimitMB = cfg.memoryLimitMB || 256;

    // ── Active Workers ───────────────────────────────────
    this._workers = new Map(); // taskId → { process, task, startedAt }
    this._taskCounter = 0;

    // ── Stats ────────────────────────────────────────────
    this._stats = {
      spawned: 0,
      completed: 0,
      failed: 0,
      timedOut: 0,
    };
  }

  /** v7.7.9 Phase 1c: public read-only accessor for the worker concurrency
   *  ceiling. ColonyOrchestrator (and any other consumer) reads this to
   *  align its decompose-cap with the real worker pool size. */
  get maxWorkers() { return this._maxWorkers; }

  // ════════════════════════════════════════════════════════
  // PUBLIC API
  // ════════════════════════════════════════════════════════

  /**
   * Spawn a worker for a sub-task.
   *
   * @param {object} task - { description, type, context, timeoutMs }
   * @returns {Promise<object>}
   */
  async spawn(task) {
    if (this._workers.size >= this._maxWorkers) {
      return { success: false, error: `Max workers (${this._maxWorkers}) reached. Wait for completion.` };
    }

    const taskId = `worker_${++this._taskCounter}_${Date.now()}`;
    const timeoutMs = task.timeoutMs || this._defaultTimeoutMs;

    this._stats.spawned++;

    this.bus.fire('spawner:starting', {
      taskId,
      description: task.description?.slice(0, 100),
    }, { source: 'SelfSpawner' });

    return new Promise((resolve) => {
      const startedAt = Date.now();

      // Build worker payload
      const payload = {
        taskId,
        description: task.description,
        type: task.type || 'generic',
        context: task.context || {},
        rootDir: this.rootDir,
        modelConfig: this.model ? {
          activeModel: this.model.activeModel,
          activeBackend: this.model.activeBackend,
          ollamaUrl: this.model._ollamaUrl || 'http://127.0.0.1:11434',
        } : null,
      };

      let resolved = false;
      const done = (result) => {
        if (resolved) return;
        resolved = true;
        this._workers.delete(taskId);
        result.durationMs = Date.now() - startedAt;
        resolve(result);
      };

      try {
        // FIX v4.10.0 (S-2): Minimal env — do NOT leak API keys, secrets, or tokens.
        // Previous: { ...process.env } passed everything including GITHUB_TOKEN,
        // Anthropic/OpenAI API keys, and any other secrets. Workers execute
        // LLM-generated sub-tasks and must not have access to credentials.
        // Same safeEnv pattern as Sandbox.execute() and Sandbox.executeExternal().
        /** @type {Record<string, any>} */
        const safeEnv = {
          PATH: process.env.PATH,
          HOME: process.env.HOME,
          USERPROFILE: process.env.USERPROFILE,
          TEMP: process.env.TEMP || process.env.TMPDIR || '/tmp',
          TMPDIR: process.env.TMPDIR || process.env.TEMP || '/tmp',
          LANG: process.env.LANG || 'en_US.UTF-8',
          NODE_ENV: process.env.NODE_ENV || 'production',
          GENESIS_WORKER: '1',
          // FIX v4.10.0 (H-3): Required since Electron 30 — without this flag,
          // fork() spawns an Electron renderer instead of a Node.js process.
          ELECTRON_RUN_AS_NODE: '1',
        };

        const worker = fork(WORKER_SCRIPT, [], {
          env: safeEnv,
          stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
          execArgv: [`--max-old-space-size=${this._memoryLimitMB}`],
        });

        this._workers.set(taskId, { process: worker, task, startedAt });

        // Timeout
        const timer = setTimeout(() => {
          this._stats.timedOut++;
          worker.kill('SIGTERM');
          done({ success: false, error: `Worker timed out after ${timeoutMs}ms` });
        }, timeoutMs);

        // IPC messages from worker
        worker.on('message', async (msg) => {
          if (msg.type === 'result') {
            clearTimeout(timer);
            this._stats.completed++;
            this.bus.fire('spawner:completed', { taskId, success: msg.success }, { source: 'SelfSpawner' });
            done({ success: msg.success, result: msg.result, error: msg.error });
          } else if (msg.type === 'progress') {
            this.bus.fire('spawner:progress', { taskId, ...msg.data }, { source: 'SelfSpawner' });
          } else if (msg.type === 'llm-request') {
            // v7.5.7-fix Phase 2: worker delegates LLM call to parent so it
            // goes through ModelBridge (semaphore, cache, keep_alive).
            // Best-effort — if model isn't available, send error back.
            const requestId = msg.requestId;
            try {
              if (!this.model || typeof this.model.chat !== 'function') {
                worker.send({ type: 'llm-response', requestId, error: 'Parent has no model' });
                return;
              }
              const messages = [{ role: 'user', content: msg.userPrompt || '' }];
              const text = await this.model.chat(msg.systemPrompt || '', messages, msg.taskType || 'analysis');
              worker.send({ type: 'llm-response', requestId, text });
            } catch (err) {
              try { worker.send({ type: 'llm-response', requestId, error: err.message || String(err) }); }
              catch (_e) { /* worker may be dead — swallow */ }
            }
          }
        });

        worker.on('error', (err) => {
          clearTimeout(timer);
          this._stats.failed++;
          done({ success: false, error: `Worker error: ${err.message}` });
        });

        worker.on('exit', (code) => {
          clearTimeout(timer);
          if (!resolved) {
            this._stats.failed++;
            done({ success: false, error: `Worker exited with code ${code}` });
          }
        });

        // Send task
        worker.send({ type: 'task', payload });

      } catch (err) {
        this._stats.failed++;
        done({ success: false, error: `Spawn failed: ${err.message}` });
      }
    });
  }

  /**
   * Spawn multiple workers in parallel with a real worker-pool semantics.
   *
   * Earlier versions called spawn() for every task simultaneously, which
   * caused tasks beyond _maxWorkers to fail-fast with "Max workers reached"
   * errors instead of being queued. The result was 7 redundant warnings per
   * 10-task colony run on a max-3-workers setup, with 7 subtasks lost.
   *
   * v7.7.9 Phase 1c: real pool. Up to _maxWorkers run at once, the rest
   * queue FIFO. When a worker completes, the next queued task starts.
   * No task is rejected; the result array preserves input order so callers
   * can map results 1:1 to their original tasks.
   *
   * @param {Array} tasks - [{ description, type, context, timeoutMs }]
   * @returns {Promise<Array>} results in input-order — each is { success, result?, error? }
   */
  async spawnParallel(tasks) {
    if (!Array.isArray(tasks) || tasks.length === 0) return [];

    const results = new Array(tasks.length);
    let nextIndex = 0;
    const inFlight = new Set();

    // Worker-pool helper: pick the next task off the queue and run it,
    // recursively starting another when this one finishes.
    const runOne = async () => {
      // eslint-disable-next-line no-constant-condition
      while (true) {
        const myIndex = nextIndex++;
        if (myIndex >= tasks.length) return; // queue drained
        try {
          const r = await this.spawn(tasks[myIndex]);
          results[myIndex] = r;
        } catch (err) {
          results[myIndex] = { success: false, error: err?.message || String(err) };
        }
      }
    };

    // Start at most _maxWorkers concurrent workers.
    const concurrency = Math.min(this._maxWorkers, tasks.length);
    for (let i = 0; i < concurrency; i++) {
      const p = runOne();
      inFlight.add(p);
      p.finally(() => inFlight.delete(p));
    }

    // Wait for all worker-runners to drain the queue.
    await Promise.all(Array.from(inFlight));

    return results;
  }

  /**
   * Kill a specific worker.
   */
  kill(taskId) {
    const worker = this._workers.get(taskId);
    if (worker?.process) {
      worker.process.kill('SIGTERM');
      this._workers.delete(taskId);
      return true;
    }
    return false;
  }

  /**
   * Kill all workers.
   */
  killAll() {
    for (const [taskId, worker] of this._workers) {
      worker.process.kill('SIGTERM');
    }
    this._workers.clear();
  }

  getActiveWorkers() {
    return [...this._workers.entries()].map(([id, w]) => ({
      taskId: id,
      description: w.task.description?.slice(0, 100),
      runningMs: Date.now() - w.startedAt,
    }));
  }

  getStats() {
    return { ...this._stats, activeWorkers: this._workers.size };
  }

  shutdown() {
    this.killAll();
  }
}

module.exports = { SelfSpawner };
