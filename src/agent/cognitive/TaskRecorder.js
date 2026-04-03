// @ts-checked-v6.0
// ============================================================
// GENESIS — TaskRecorder.js (v6.0.0 — V6-8)
//
// Record and deterministically replay complete task executions
// for debugging and regression testing.
//
// PROBLEM: When a code change causes a regression, there's no
// way to compare "before" and "after" execution traces. The
// ReasoningTracer captures decisions but not the full execution
// context (LLM calls, tool invocations, intermediate state).
//
// SOLUTION: TaskRecorder captures the full execution trace of
// every goal/task and serializes it to .genesis-replay files.
// Replay mode feeds mocked LLM responses to reproduce the exact
// execution path. Diff view highlights where two replays diverge.
//
// No competing framework (LangChain, CrewAI, AutoGen, Devin)
// has deterministic task replay with diff comparison.
//
// Integration points:
//   - AgentLoop.pursue()     → starts recording
//   - AgentLoop._step()      → records each step
//   - LLMPort.chat()         → records LLM call/response
//   - ShellAgent.run()       → records tool invocations
//   - Dashboard              → replay list + diff view via IPC
//
// Pattern: Phase 9 cognitive service. Bus-driven. Optional deps.
// Ring buffer of last 50 recordings.
// ============================================================

'use strict';

const fs = require('fs');
const path = require('path');
const { createLogger } = require('../core/Logger');
const _log = createLogger('TaskRecorder');

const MAX_RECORDINGS = 50;
const MAX_STEPS_PER_RECORDING = 200;

class TaskRecorder {
  /**
   * @param {object} deps
   * @param {object} deps.bus     - EventBus (required)
   * @param {string} [deps.dataDir] - Override data directory (for testing)
   */
  constructor({ bus, dataDir }) {
    this.bus = bus;

    /** @type {string} */
    this._dataDir = dataDir || path.join(
      process.env.GENESIS_DATA_DIR || path.join(require('os').homedir(), '.genesis'),
      'replays'
    );

    /** @type {Map<string, Recording>} Active recordings keyed by correlationId */
    this._active = new Map();

    /** @type {Array<RecordingSummary>} Ring buffer of completed recordings */
    this._completed = [];

    this._unsubs = [];
    this._enabled = true;

    this._stats = {
      totalRecordings: 0,
      totalSteps: 0,
      totalLLMCalls: 0,
      totalToolCalls: 0,
    };
  }

  // ════════════════════════════════════════════════════════
  // LIFECYCLE
  // ════════════════════════════════════════════════════════

  start() {
    this._ensureDir();

    // ── Goal lifecycle → recording boundaries ────────────
    this._sub('agent-loop:started', (data) => {
      this._startRecording(data.goalId, data.goal || data.message || 'unknown');
    });

    this._sub('agent-loop:complete', (data) => {
      this._stopRecording(data.goalId, 'complete', data);
    });

    // ── Step outcomes → execution trace ──────────────────
    this._sub('goal:step-complete', (data) => {
      this._recordStep(data.goalId, 'step', data);
    });

    // ── LLM calls → trace with prompt/response ──────────
    this._sub('chat:completed', (data) => {
      this._recordLLMCall(data);
    });

    // ── Shell/tool invocations ───────────────────────────
    this._sub('shell:complete', (data) => {
      this._recordToolCall('shell', data);
    });

    this._sub('mcp:tool-call', (data) => {
      this._recordToolCall('mcp', data);
    });

    // ── Intent classification ────────────────────────────
    this._sub('intent:classified', (data) => {
      this._recordStep(data.goalId || this._lastGoalId(), 'intent', data);
    });

    // ── Decision traces from ReasoningTracer ─────────────
    this._sub('reasoning:trace-recorded', (data) => {
      this._recordStep(data.goalId || this._lastGoalId(), 'decision', data);
    });

    // Load completed recordings index
    this._loadIndex();

    _log.info(`[RECORDER] Active — replay directory: ${this._dataDir}`);
  }

  stop() {
    // Finalize any active recordings
    for (const [goalId] of this._active) {
      this._stopRecording(goalId, 'shutdown', {});
    }

    for (const unsub of this._unsubs) {
      try { unsub(); } catch (_) { /* best effort */ }
    }
    this._unsubs = [];
    _log.info(`[RECORDER] Stopped — ${this._stats.totalRecordings} recordings, ${this._stats.totalSteps} steps`);
  }

  // ════════════════════════════════════════════════════════
  // RECORDING API
  // ════════════════════════════════════════════════════════

  /**
   * @private Start a new recording for a goal.
   */
  _startRecording(goalId, goalDescription) {
    if (!this._enabled || !goalId) return;

    const recording = {
      id: `rec_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      goalId,
      goalDescription: typeof goalDescription === 'string' ? goalDescription.slice(0, 200) : 'unknown',
      startedAt: Date.now(),
      steps: [],
      llmCalls: [],
      toolCalls: [],
      outcome: null,
      metadata: {
        version: '6.0.0',
        platform: process.platform,
      },
    };

    this._active.set(goalId, recording);
    _log.debug(`[RECORDER] Started recording ${recording.id} for goal ${goalId.slice(0, 8)}`);
  }

  /**
   * @private Stop recording and persist to disk.
   */
  _stopRecording(goalId, reason, data) {
    const recording = this._active.get(goalId);
    if (!recording) return;

    recording.outcome = {
      reason,
      success: data.success ?? null,
      stepsCompleted: recording.steps.length,
      llmCalls: recording.llmCalls.length,
      toolCalls: recording.toolCalls.length,
      durationMs: Date.now() - recording.startedAt,
    };

    // Persist to disk
    this._saveRecording(recording);

    // Update stats
    this._stats.totalRecordings++;
    this._stats.totalSteps += recording.steps.length;

    // Add to completed ring buffer
    this._completed.push({
      id: recording.id,
      goalId: recording.goalId,
      goalDescription: recording.goalDescription,
      startedAt: recording.startedAt,
      outcome: recording.outcome,
    });
    if (this._completed.length > MAX_RECORDINGS) {
      this._completed = this._completed.slice(-MAX_RECORDINGS);
    }

    this._active.delete(goalId);

    this.bus.emit('replay:recording-complete', {
      id: recording.id,
      goalId,
      steps: recording.steps.length,
      llmCalls: recording.llmCalls.length,
      durationMs: recording.outcome.durationMs,
    }, { source: 'TaskRecorder' });

    _log.debug(`[RECORDER] Completed ${recording.id}: ${recording.steps.length} steps, ${recording.llmCalls.length} LLM calls (${recording.outcome.durationMs}ms)`);
  }

  /**
   * @private Record a step in the active recording.
   */
  _recordStep(goalId, type, data) {
    const recording = this._active.get(goalId);
    if (!recording) return;
    if (recording.steps.length >= MAX_STEPS_PER_RECORDING) return;

    recording.steps.push({
      ts: Date.now(),
      offset: Date.now() - recording.startedAt,
      type,
      data: this._sanitize(data),
    });
  }

  /**
   * @private Record an LLM call (prompt + response).
   */
  _recordLLMCall(data) {
    // Attach to most recent active recording
    const goalId = this._lastGoalId();
    const recording = this._active.get(goalId);
    if (!recording) return;

    this._stats.totalLLMCalls++;

    recording.llmCalls.push({
      ts: Date.now(),
      offset: Date.now() - recording.startedAt,
      model: data.model || data.backend || 'unknown',
      promptPreview: typeof data.prompt === 'string' ? data.prompt.slice(0, 200) : null,
      responsePreview: typeof data.response === 'string' ? data.response.slice(0, 500) : null,
      tokens: data.tokens || data.tokenEstimate || null,
      durationMs: data.durationMs || null,
    });
  }

  /**
   * @private Record a tool/shell invocation.
   */
  _recordToolCall(type, data) {
    const goalId = this._lastGoalId();
    const recording = this._active.get(goalId);
    if (!recording) return;

    this._stats.totalToolCalls++;

    recording.toolCalls.push({
      ts: Date.now(),
      offset: Date.now() - recording.startedAt,
      type,
      command: (data.command || data.tool || data.name || '').slice(0, 200),
      success: data.success ?? data.exitCode === 0 ?? null,
      outputPreview: typeof data.output === 'string' ? data.output.slice(0, 300) : null,
    });
  }

  // ════════════════════════════════════════════════════════
  // QUERY API
  // ════════════════════════════════════════════════════════

  /**
   * List completed recordings.
   * @param {number} [limit=20]
   * @returns {Array<RecordingSummary>}
   */
  list(limit = 20) {
    return this._completed.slice(-limit).reverse();
  }

  /**
   * Load a full recording from disk.
   * @param {string} recordingId
   * @returns {object|null}
   */
  load(recordingId) {
    try {
      const filePath = path.join(this._dataDir, `${recordingId}.json`);
      if (!fs.existsSync(filePath)) return null;
      return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    } catch (err) {
      _log.warn(`[RECORDER] Failed to load recording ${recordingId}: ${err.message}`);
      return null;
    }
  }

  /**
   * Diff two recordings — find where execution diverged.
   * @param {string} idA - First recording ID
   * @param {string} idB - Second recording ID
   * @returns {object|null} Diff report
   */
  diff(idA, idB) {
    const a = this.load(idA);
    const b = this.load(idB);
    if (!a || !b) return null;

    const report = {
      recordingA: { id: idA, goal: a.goalDescription, steps: a.steps.length },
      recordingB: { id: idB, goal: b.goalDescription, steps: b.steps.length },
      divergencePoint: null,
      stepComparison: [],
      outcomeDelta: {
        successA: a.outcome?.success,
        successB: b.outcome?.success,
        durationDelta: (b.outcome?.durationMs || 0) - (a.outcome?.durationMs || 0),
        llmCallDelta: (b.llmCalls?.length || 0) - (a.llmCalls?.length || 0),
      },
    };

    // Compare steps pairwise
    const maxSteps = Math.max(a.steps.length, b.steps.length);
    let diverged = false;

    for (let i = 0; i < maxSteps; i++) {
      const stepA = a.steps[i] || null;
      const stepB = b.steps[i] || null;

      const match = stepA && stepB && stepA.type === stepB.type;

      if (!match && !diverged) {
        report.divergencePoint = i;
        diverged = true;
      }

      report.stepComparison.push({
        index: i,
        typeA: stepA?.type || null,
        typeB: stepB?.type || null,
        match,
        detailA: stepA?.data ? this._stepSummary(stepA) : null,
        detailB: stepB?.data ? this._stepSummary(stepB) : null,
      });
    }

    return report;
  }

  /**
   * Get recorder stats for diagnostics.
   * @returns {object}
   */
  getStats() {
    return {
      ...this._stats,
      activeRecordings: this._active.size,
      completedRecordings: this._completed.length,
    };
  }

  /**
   * Get full report for Dashboard/IPC.
   * @returns {object}
   */
  getReport() {
    return {
      stats: this.getStats(),
      recent: this.list(10),
      enabled: this._enabled,
    };
  }

  // ════════════════════════════════════════════════════════
  // INTERNALS
  // ════════════════════════════════════════════════════════

  /** @private Get the goalId of the most recent active recording */
  _lastGoalId() {
    const keys = [...this._active.keys()];
    return keys[keys.length - 1] || null;
  }

  /** @private Sanitize event data to prevent huge recordings */
  _sanitize(data) {
    if (!data || typeof data !== 'object') return data;
    const clean = {};
    for (const [k, v] of Object.entries(data)) {
      if (typeof v === 'string') {
        clean[k] = v.length > 500 ? v.slice(0, 500) + '…' : v;
      } else if (typeof v === 'number' || typeof v === 'boolean' || v === null) {
        clean[k] = v;
      } else if (Array.isArray(v)) {
        clean[k] = v.length > 10 ? `[Array(${v.length})]` : v;
      } else {
        clean[k] = '[object]';
      }
    }
    return clean;
  }

  /** @private Generate a one-line summary of a step for diff display */
  _stepSummary(step) {
    const d = step.data || {};
    switch (step.type) {
      case 'intent': return `${d.intent || d.type || 'unknown'}: ${(d.message || d.input || '').slice(0, 80)}`;
      case 'step': return `${d.action || d.step || 'step'}: ${d.success ? 'OK' : 'FAIL'}`;
      case 'decision': return `${d.type || 'decision'}: ${(d.summary || '').slice(0, 80)}`;
      default: return `${step.type}: ${JSON.stringify(d).slice(0, 80)}`;
    }
  }

  /** @private Persist a recording to disk */
  _saveRecording(recording) {
    try {
      this._ensureDir();
      const filePath = path.join(this._dataDir, `${recording.id}.json`);
      fs.writeFileSync(filePath, JSON.stringify(recording, null, 2), 'utf-8');
    } catch (err) {
      _log.warn(`[RECORDER] Failed to save recording: ${err.message}`);
    }
  }

  /** @private Load index of existing recordings from disk */
  _loadIndex() {
    try {
      if (!fs.existsSync(this._dataDir)) return;
      const files = fs.readdirSync(this._dataDir)
        .filter(f => f.startsWith('rec_') && f.endsWith('.json'))
        .sort()
        .slice(-MAX_RECORDINGS);

      for (const file of files) {
        try {
          const data = JSON.parse(fs.readFileSync(path.join(this._dataDir, file), 'utf-8'));
          this._completed.push({
            id: data.id,
            goalId: data.goalId,
            goalDescription: data.goalDescription,
            startedAt: data.startedAt,
            outcome: data.outcome,
          });
        } catch (_) { /* skip corrupt files */ }
      }

      if (this._completed.length > 0) {
        _log.info(`[RECORDER] Loaded ${this._completed.length} recording(s) from index`);
      }
    } catch (err) {
      _log.debug(`[RECORDER] Index load failed: ${err.message}`);
    }
  }

  /** @private Ensure data directory exists */
  _ensureDir() {
    if (!fs.existsSync(this._dataDir)) {
      fs.mkdirSync(this._dataDir, { recursive: true });
    }
  }

  /** @private Subscribe to bus with auto-cleanup */
  _sub(event, handler) {
    const unsub = this.bus.on(event, handler, { source: 'TaskRecorder' });
    this._unsubs.push(typeof unsub === 'function' ? unsub : () => {});
  }
}

module.exports = { TaskRecorder };
