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

  // ════════════════════════════════════════════════════════
  // PUBLIC API
  // ════════════════════════════════════════════════════════

  /**
   * Spawn a worker for a sub-task.
   *
   * @param {object} task — { description, type, context, timeoutMs }
   * @returns {Promise<object>}
   */
  async spawn(task) {
    if (this._workers.size >= this._maxWorkers) {
      return { success: false, error: `Max workers (${this._maxWorkers}) reached. Wait for completion.` };
    }

    const taskId = `worker_${++this._taskCounter}_${Date.now()}`;
    const timeoutMs = task.timeoutMs || this._defaultTimeoutMs;

    this._stats.spawned++;

    this.bus.emit('spawner:starting', {
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
        worker.on('message', (msg) => {
          if (msg.type === 'result') {
            clearTimeout(timer);
            this._stats.completed++;
            this.bus.emit('spawner:completed', { taskId, success: msg.success }, { source: 'SelfSpawner' });
            done({ success: msg.success, result: msg.result, error: msg.error });
          } else if (msg.type === 'progress') {
            this.bus.emit('spawner:progress', { taskId, ...msg.data }, { source: 'SelfSpawner' });
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
   * Spawn multiple workers in parallel and collect results.
   * @param {Array} tasks — [{ description, type, context }]
   * @returns {Promise<Array>} results
   */
  async spawnParallel(tasks) {
    const promises = tasks.map(task => this.spawn(task));
    return Promise.allSettled(promises)
      .then(results =>
        results.map(r => r.status === 'fulfilled' ? r.value : { success: false, error: r.reason?.message })
      )
      .catch(err => {
        this.bus.emit('spawner:error', { error: err.message }, { source: 'SelfSpawner' });
        return tasks.map(() => ({ success: false, error: err.message }));
      });
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
