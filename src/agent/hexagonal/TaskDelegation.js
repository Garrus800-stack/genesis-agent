// @ts-checked-v5.7
// ============================================================
// GENESIS — TaskDelegation.js (v3.5.0 — Multi-Agent Collaboration)
//
// Enables AgentLoop to delegate sub-goals to peer agents
// discovered via PeerNetwork. Implements:
//
// 1. Capability Matching — finds peers whose skills match a task
// 2. Task Submission — sends tasks via HTTP to peers
// 3. Result Collection — polls/receives results from peers
// 4. DELEGATE step type — integrates into AgentLoop's ReAct loop
//
// Protocol:
//   POST /task/submit    { taskId, description, requiredSkills, deadline }
//     → { accepted: bool, estimatedMs }
//   GET  /task/status?id=  → { status: 'pending'|'running'|'done'|'failed', result? }
//   POST /task/cancel    { taskId }
//
// Architecture:
//   AgentLoop → TaskDelegation.delegate(subGoal)
//     → findMatchingPeer(requiredCapabilities)
//     → submitTask(peer, task)
//     → pollResult() until done
//     → return result to AgentLoop
// ============================================================

const http = require('http');
const { TIMEOUTS } = require('../core/Constants');
const { NullBus } = require('../core/EventBus');
// FIX v4.10.0 (L-3): Use safeJsonParse for network-sourced JSON
const { safeJsonParse } = require('../core/utils');

class TaskDelegation {
  // NOTE: containerConfig is informational only — registered via phase manifest.
  static containerConfig = {
    name: 'taskDelegation',
    phase: 5,
    deps: ['bus', 'eventStore'],
    tags: ['collaboration', 'autonomy'],
  };

  /** @param {{ bus?: object, network?: object, goalStack?: object, eventStore?: object, lang?: object }} [opts] */
  constructor({ bus, network, goalStack, eventStore, lang } = {}) {
    this.bus = bus || NullBus;
    this.network = network || null;  // PeerNetwork — set via late binding
    this.goalStack = goalStack || null;
    this.eventStore = eventStore || null;
    this.lang = lang || { t: k => k };

    // ── Active Delegations ─────────────────────────────
    this._activeTasks = new Map(); // taskId -> { peerId, status, submittedAt, result }
    this._taskCounter = 0;

    // ── Configuration ──────────────────────────────────
    this._pollIntervalMs = 3000;
    this._maxPollAttempts = 100;  // 100 × 3s = 5 min max wait
    this._taskTimeoutMs = 5 * 60 * 1000;

    // ── Received Tasks (when WE are the delegatee) ─────
    this._receivedTasks = new Map(); // taskId -> { description, status, result }
    this._taskHandler = null;        // Set by AgentLoop
  }

  // ════════════════════════════════════════════════════════
  // OUTBOUND: DELEGATE TO PEERS
  // ════════════════════════════════════════════════════════

  /**
   * Delegate a sub-goal to a peer agent.
   * This is the main entry point for AgentLoop's DELEGATE step.
   *
   * @param {string} description - Natural language task description
   * @param {string[]} requiredSkills - Skills the peer needs
   * @param {object} options - { deadline, preferredPeer, parentGoalId }
   * @returns {Promise<object>} { success, peerId, taskId, result, error }
   */
  async delegate(description, requiredSkills = [], options = {}) {
    if (!this.network) {
      return { success: false, error: 'PeerNetwork not available' };
    }

    // Step 1: Find a capable peer
    const peer = options.preferredPeer
      ? this._getPeer(options.preferredPeer)
      : await this._findMatchingPeer(requiredSkills);

    if (!peer) {
      return {
        success: false,
        error: `Kein Peer mit Skills [${requiredSkills.join(', ')}] gefunden`,
      };
    }

    // Step 2: Submit the task
    const taskId = `task_${Date.now()}_${++this._taskCounter}`;
    const submission = await this._submitTask(peer, {
      taskId,
      description,
      requiredSkills,
      deadline: options.deadline || Date.now() + this._taskTimeoutMs,
      parentGoalId: options.parentGoalId || null,
      senderIdentity: this._getOwnIdentity(),
    });

    if (!submission.accepted) {
      this.bus.fire('delegation:rejected', {
        taskId, peerId: peer.id, reason: submission.reason,
      }, { source: 'TaskDelegation' });
      return { success: false, error: `Peer ${peer.id} rejected: ${submission.reason}` };
    }

    // Step 3: Track the task
    this._activeTasks.set(taskId, {
      peerId: peer.id,
      description,
      status: 'submitted',
      submittedAt: Date.now(),
      estimatedMs: submission.estimatedMs || this._taskTimeoutMs,
      result: null,
    });

    this.bus.fire('delegation:submitted', {
      taskId, peerId: peer.id, description,
      estimatedMs: submission.estimatedMs,
    }, { source: 'TaskDelegation' });

    // Step 4: Wait for result (polling)
    try {
      const result = await this._pollForResult(peer, taskId);
      this._activeTasks.get(taskId).status = 'completed';
      this._activeTasks.get(taskId).result = result;

      this.bus.fire('delegation:completed', {
        taskId, peerId: peer.id, success: true,
      }, { source: 'TaskDelegation' });

      if (this.eventStore) {
        this.eventStore.append('TASK_DELEGATED', {
          taskId, peerId: peer.id, success: true,
          durationMs: Date.now() - this._activeTasks.get(taskId).submittedAt,
        }, 'TaskDelegation');
      }

      return { success: true, peerId: peer.id, taskId, result };

    } catch (err) {
      this._activeTasks.get(taskId).status = 'failed';

      this.bus.fire('delegation:failed', {
        taskId, peerId: peer.id, error: err.message,
      }, { source: 'TaskDelegation' });

      return { success: false, peerId: peer.id, taskId, error: err.message };
    }
  }

  // ── Peer Matching ───────────────────────────────────────

  _findMatchingPeer(requiredSkills) {
    if (!this.network || !this.network.peers) return null;

    const candidates = [];

    for (const [peerId, peer] of this.network.peers) {
      if (!peer.health?.isHealthy) continue;

      // Check skill overlap
      const peerSkills = peer.skills || [];
      const matchCount = requiredSkills.filter(s =>
        peerSkills.some(ps => ps.toLowerCase().includes(s.toLowerCase()))
      ).length;

      if (matchCount > 0 || requiredSkills.length === 0) {
        candidates.push({
          id: peerId,
          peer,
          matchScore: requiredSkills.length > 0
            ? matchCount / requiredSkills.length
            : 0.5,
          latency: peer.health?.getAverageLatency?.() || 999,
        });
      }
    }

    // Sort: best match first, then lowest latency
    candidates.sort((a, b) => {
      if (b.matchScore !== a.matchScore) return b.matchScore - a.matchScore;
      return a.latency - b.latency;
    });

    return candidates[0]?.peer || null;
  }

  _getPeer(peerId) {
    return this.network?.peers?.get(peerId) || null;
  }

  _getOwnIdentity() {
    try {
      return this.network?.selfModel?.getFullModel()?.identity || 'unknown';
    } catch (_e) { console.debug('[catch] return this.network.selfModel.:', _e.message); return 'unknown'; }
  }

  // ── Task Submission ─────────────────────────────────────

  async _submitTask(peer, task) {
    try {
      const response = await this._httpPost(
        `http://${peer.host}:${peer.port}/task/submit`,
        task
      );
      return response;
    } catch (err) {
      return { accepted: false, reason: `Network error: ${err.message}` };
    }
  }

  // ── Result Polling ──────────────────────────────────────

  async _pollForResult(peer, taskId) {
    for (let attempt = 0; attempt < this._maxPollAttempts; attempt++) {
      await new Promise(r => setTimeout(r, this._pollIntervalMs));

      // Check if task was cancelled
      const task = this._activeTasks.get(taskId);
      if (!task || task.status === 'cancelled') {
        throw new Error('Task was cancelled');
      }

      // Check timeout
      if (Date.now() - task.submittedAt > this._taskTimeoutMs) {
        await this._cancelRemoteTask(peer, taskId);
        throw new Error('Task timeout exceeded');
      }

      try {
        const status = await this._httpGet(
          `http://${peer.host}:${peer.port}/task/status?id=${encodeURIComponent(taskId)}`
        );

        if (status.status === 'done') {
          return status.result;
        }

        if (status.status === 'failed') {
          throw new Error(status.error || 'Peer reported failure');
        }

        // Update local tracking
        task.status = status.status;

      } catch (err) {
        // Network error during poll — retry
        if (attempt === this._maxPollAttempts - 1) {
          throw new Error(`Polling failed after ${attempt + 1} attempts: ${err.message}`);
        }
      }
    }

    throw new Error('Max poll attempts reached');
  }

  async _cancelRemoteTask(peer, taskId) {
    try {
      await this._httpPost(`http://${peer.host}:${peer.port}/task/cancel`, { taskId });
    } catch (_e) { console.debug('[catch] subtask cleanup:', _e.message); }
  }

  // ════════════════════════════════════════════════════════
  // INBOUND: RECEIVE DELEGATED TASKS
  // ════════════════════════════════════════════════════════

  /**
   * Handle an incoming task from a peer.
   * Called by PeerNetwork when it receives POST /task/submit.
   * Returns acceptance/rejection immediately, executes async.
   */
  receiveTask(task) {
    const { taskId, description, requiredSkills, deadline } = task;

    // Check if we can handle this
    if (this._receivedTasks.size >= 3) {
      return { accepted: false, reason: 'Task queue full (max 3 concurrent delegations)' };
    }

    if (deadline && Date.now() > deadline) {
      return { accepted: false, reason: 'Deadline already expired' };
    }

    // Accept the task
    this._receivedTasks.set(taskId, {
      description,
      requiredSkills,
      status: 'pending',
      receivedAt: Date.now(),
      result: null,
      error: null,
    });

    // Execute asynchronously
    this._executeReceivedTask(taskId, description).catch(err => {
      const t = this._receivedTasks.get(taskId);
      if (t) {
        t.status = 'failed';
        t.error = err.message;
      }
    });

    this.bus.fire('delegation:received', { taskId, description }, { source: 'TaskDelegation' });

    return { accepted: true, estimatedMs: 30000 };
  }

  /**
   * Get status of a received task.
   * Called by PeerNetwork when it receives GET /task/status.
   */
  getTaskStatus(taskId) {
    const task = this._receivedTasks.get(taskId);
    if (!task) return { status: 'unknown', error: 'Task not found' };

    return {
      status: task.status,
      result: task.result,
      error: task.error,
    };
  }

  /**
   * Execute a received task using our own AgentLoop or GoalStack.
   */
  async _executeReceivedTask(taskId, description) {
    const task = this._receivedTasks.get(taskId);
    if (!task) return;

    task.status = 'running';

    try {
      if (this._taskHandler) {
        // Use the registered handler (typically AgentLoop)
        const result = await this._taskHandler(description);
        task.status = 'done';
        task.result = result;
      } else if (this.goalStack) {
        // Fallback: create a sub-goal
        const goal = await this.goalStack.addGoal(description, 'peer-delegation', 'medium');
        task.status = 'done';
        task.result = { goalId: goal.id, status: 'goal-created' };
      } else {
        task.status = 'failed';
        task.error = 'Kein Task-Handler verfuegbar';
      }
    } catch (err) {
      task.status = 'failed';
      task.error = err.message;
    }
  }

  /**
   * Register a handler for executing received tasks.
   * @param {Function} handler - async (description) => result
   */
  setTaskHandler(handler) {
    this._taskHandler = handler;
  }

  // ════════════════════════════════════════════════════════
  // PEER NETWORK ENDPOINT HANDLERS
  // (Wire these into PeerNetwork._handlePeerRequest)
  // ════════════════════════════════════════════════════════

  /**
   * Returns HTTP handlers for PeerNetwork to mount.
   * Usage in PeerNetwork:
   *   const handlers = taskDelegation.getEndpointHandlers();
   *   // In _handlePeerRequest switch:
   *   case '/task/submit': handlers.submit(req, res); break;
   *   case '/task/status': handlers.status(req, res); break;
   *   case '/task/cancel': handlers.cancel(req, res); break;
   */
  getEndpointHandlers() {
    return {
      submit: (req, res) => {
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', () => {
          try {
            const task = safeJsonParse(body, null, 'TaskDelegation:submit');
            if (!task) { res.statusCode = 400; res.end(JSON.stringify({ error: 'Invalid JSON' })); return; }
            const result = this.receiveTask(task);
            res.end(JSON.stringify(result));
          } catch (err) {
            res.statusCode = 400;
            res.end(JSON.stringify({ error: err.message }));
          }
        });
      },

      status: (req, res) => {
        const url = new URL(req.url, 'http://localhost');
        const taskId = url.searchParams.get('id');
        if (!taskId) {
          res.statusCode = 400;
          res.end(JSON.stringify({ error: 'Missing ?id=' }));
          return;
        }
        res.end(JSON.stringify(this.getTaskStatus(taskId)));
      },

      cancel: (req, res) => {
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', () => {
          try {
            const parsed = safeJsonParse(body, null, 'TaskDelegation:cancel');
            if (!parsed) { res.statusCode = 400; res.end(JSON.stringify({ error: 'Invalid JSON' })); return; }
            const { taskId } = parsed;
            const task = this._receivedTasks.get(taskId);
            if (task) {
              task.status = 'cancelled';
              res.end(JSON.stringify({ cancelled: true }));
            } else {
              res.statusCode = 404;
              res.end(JSON.stringify({ error: 'Task not found' }));
            }
          } catch (err) {
            res.statusCode = 400;
            res.end(JSON.stringify({ error: err.message }));
          }
        });
      },
    };
  }

  // ════════════════════════════════════════════════════════
  // STATUS
  // ════════════════════════════════════════════════════════

  getStatus() {
    return {
      activeDelegations: this._activeTasks.size,
      receivedTasks: this._receivedTasks.size,
      delegations: [...this._activeTasks.entries()].map(([id, t]) => ({
        taskId: id, peerId: t.peerId, status: t.status,
        age: Date.now() - t.submittedAt,
      })),
      received: [...this._receivedTasks.entries()].map(([id, t]) => ({
        taskId: id, status: t.status,
      })),
    };
  }

  // ── HTTP Helpers ────────────────────────────────────────

  _httpGet(urlStr) {
    return new Promise((resolve, reject) => {
      http.get(urlStr, { timeout: TIMEOUTS.COMMAND_EXEC }, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          try { resolve(JSON.parse(data)); }
          catch (_e) { console.debug('[catch] JSON parse:', _e.message); reject(new Error('Ungueltige Antwort')); }
        });
      }).on('error', reject).on('timeout', function() { this.destroy(); reject(new Error('Timeout')); });
    });
  }

  _httpPost(urlStr, body) {
    return new Promise((resolve, reject) => {
      const url = new URL(urlStr);
      const postData = JSON.stringify(body);
      const req = http.request({
        hostname: url.hostname, port: url.port, path: url.pathname,
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(postData) },
        timeout: TIMEOUTS.COMMAND_EXEC,
      }, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          try { resolve(JSON.parse(data)); }
          catch (_e) { console.debug('[catch] JSON parse:', _e.message); reject(new Error('Ungueltige Antwort')); }
        });
      });
      req.on('error', reject);
      req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
      req.write(postData);
      req.end();
    });
  }
}

module.exports = { TaskDelegation };
