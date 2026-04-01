// ============================================================
// GENESIS — WorkerPool.js
// Actor-model thread pool. Heavy operations run in worker
// threads so the main thread stays responsive.
//
// Each worker is an "actor" that receives messages and
// responds asynchronously. No shared state, no locks.
// ============================================================

const { Worker } = require('worker_threads');
const path = require('path');
const os = require('os');
const { NullBus } = require('../core/EventBus');
const { createLogger } = require('../core/Logger');
const _log = createLogger('WorkerPool');
class WorkerPool {
  constructor(options = {}, bus) {
    this.bus = bus || NullBus;
    this.maxWorkers = options.maxWorkers || Math.max(2, os.cpus().length - 1);
    this.workers = new Map();    // id -> { worker, busy, taskCount }
    this.taskQueue = [];          // Pending tasks
    this.taskResults = new Map(); // taskId -> { resolve, reject, timeout }
    this.nextTaskId = 0;
    this.nextWorkerId = 0;
  }

  /**
   * Execute a task in a worker thread
   * @param {string} taskType - What to do: 'analyze-code', 'syntax-check', 'execute', 'process-file'
   * @param {object} data - Task payload
   * @param {number} timeoutMs - Max time before killing (default 30s)
   * @returns {Promise<*>} Task result
   */
  async run(taskType, data, timeoutMs = 30000) {
    return new Promise((resolve, reject) => {
      const taskId = this.nextTaskId++;
      const task = { taskId, taskType, data, resolve, reject, timeoutMs };

      // Try to find a free worker
      const freeWorker = this._getFreeWorker();
      if (freeWorker) {
        this._dispatch(freeWorker, task);
      } else if (this.workers.size < this.maxWorkers) {
        // Spawn a new worker
        const worker = this._spawnWorker();
        this._dispatch(worker, task);
      } else {
        // All workers busy — queue it
        this.taskQueue.push(task);
      }
    });
  }

  /**
   * Run code analysis in a worker (non-blocking)
   */
  async analyzeCode(code, language = 'javascript') {
    return this.run('analyze-code', { code, language });
  }

  /**
   * Run syntax check in a worker (non-blocking)
   */
  async syntaxCheck(code) {
    return this.run('syntax-check', { code }, 5000);
  }

  /**
   * Process a file (parse, analyze, extract info)
   */
  async processFile(filePath, action = 'analyze') {
    return this.run('process-file', { filePath, action });
  }

  // ── Internal ─────────────────────────────────────────────

  _spawnWorker() {
    const workerId = this.nextWorkerId++;
    const workerPath = path.join(__dirname, 'GenericWorker.js');

    const worker = new Worker(workerPath, {
      workerData: { workerId },
    });

    const entry = { worker, busy: false, taskCount: 0, id: workerId };
    this.workers.set(workerId, entry);

    worker.on('message', (msg) => this._handleWorkerMessage(workerId, msg));
    worker.on('error', (err) => this._handleWorkerError(workerId, err));
    worker.on('exit', (code) => this._handleWorkerExit(workerId, code));

    this.bus.emit('worker:spawned', { workerId, total: this.workers.size }, { source: 'WorkerPool' });
    return entry;
  }

  _dispatch(workerEntry, task) {
    workerEntry.busy = true;
    workerEntry.taskCount++;

    // Set timeout
    const timer = setTimeout(() => {
      const pending = this.taskResults.get(task.taskId);
      if (pending) {
        pending.reject(new Error(`Worker timeout nach ${task.timeoutMs}ms`));
        this.taskResults.delete(task.taskId);
        // Kill and respawn the stuck worker
        workerEntry.worker.terminate();
      }
    }, task.timeoutMs);

    this.taskResults.set(task.taskId, {
      resolve: task.resolve,
      reject: task.reject,
      timer,
      workerId: workerEntry.id,
    });

    workerEntry.worker.postMessage({
      taskId: task.taskId,
      taskType: task.taskType,
      data: task.data,
    });
  }

  _handleWorkerMessage(workerId, msg) {
    const entry = this.workers.get(workerId);
    if (entry) entry.busy = false;

    const pending = this.taskResults.get(msg.taskId);
    if (pending) {
      clearTimeout(pending.timer);
      this.taskResults.delete(msg.taskId);

      if (msg.error) {
        pending.reject(new Error(msg.error));
      } else {
        pending.resolve(msg.result);
      }
    }

    // Process queued tasks
    if (this.taskQueue.length > 0 && entry && !entry.busy) {
      const nextTask = this.taskQueue.shift();
      this._dispatch(entry, nextTask);
    }
  }

  _handleWorkerError(workerId, err) {
    _log.error(`[WORKER:${workerId}] Error:`, err.message);
    // v4.12.5-fix: Emit worker:error (HealthMonitor listens for this)
    this.bus.emit('worker:error', {
      workerId, error: err.message, remaining: this.workers.size - 1,
    }, { source: 'WorkerPool' });
    // Reject all pending tasks for this worker
    for (const [taskId, pending] of this.taskResults) {
      if (pending.workerId === workerId) {
        clearTimeout(pending.timer);
        pending.reject(err);
        this.taskResults.delete(taskId);
      }
    }
    this.workers.delete(workerId);
  }

  _handleWorkerExit(workerId, code) {
    this.workers.delete(workerId);
    if (code !== 0) {
      _log.warn(`[WORKER:${workerId}] Exited with code ${code}`);
    }
  }

  _getFreeWorker() {
    for (const [_, entry] of this.workers) {
      if (!entry.busy) return entry;
    }
    return null;
  }

  /** Get pool status */
  getStatus() {
    return {
      workers: this.workers.size,
      maxWorkers: this.maxWorkers,
      busy: Array.from(this.workers.values()).filter(w => w.busy).length,
      queued: this.taskQueue.length,
      totalTasks: this.nextTaskId,
    };
  }

  /** Shut down all workers */
  shutdown() {
    for (const [id, entry] of this.workers) {
      entry.worker.terminate();
    }
    this.workers.clear();
    this.taskQueue = [];

    for (const [_, pending] of this.taskResults) {
      clearTimeout(pending.timer);
      pending.reject(new Error('Pool shutdown'));
    }
    this.taskResults.clear();
    return Promise.resolve(); // v5.7.0: sync but returns thenable for callers using .catch()
  }
}

module.exports = { WorkerPool };
