// @ts-checked-v5.7
// ============================================================
// GENESIS — cognitive/CoreMemories.js (v7.3.1)
// ------------------------------------------------------------
// Manages Core Memories: moments of significance that shape
// Genesis's identity over time. Append-only. Protected from
// DreamCycle decay. Only user-actionable via dashboard veto.
//
// ALL candidates (also below threshold) are logged separately
// in coreMemoryCandidates.jsonl for future calibration. This
// lets us see how 3-of-6, 5-of-6 etc. would have performed
// over weeks of real usage — datapoint-driven threshold tuning.
//
// TYPE ASSIGNMENT (v7.3.1):
// Types are 'named' | 'breakthrough' | 'built-together' |
// 'crisis-resolved' | 'laughed' | 'other'. Assigned via LLM
// classifier at candidate-creation time (one call per candidate,
// small budget). If classifier unavailable → type = 'other'.
//
// VETO (v7.3.1):
// Veto is SOFT — event is 'core-memory:veto' (not 'rejected').
// Dashboard button label should be "Nicht als Kern" (not "Reject").
// userNote is optional; future versions may surface it to Genesis
// via _reflect for calibration.
// ============================================================

'use strict';

const { createLogger } = require('../core/Logger');
const _log = createLogger('CoreMemories');

const SELF_IDENTITY_KEY = 'self-identity.json';
const CANDIDATES_KEY = 'coreMemoryCandidates.jsonl';

class CoreMemories {
  /**
   * @param {object} deps
   *   storage - StorageService (read/writeJSON, appendText)
   *   bus - EventBus
   *   model - ModelBridge (optional, for LLM type classification)
   *   selfModel - SelfModel (for git-SHA biography marker)
   */
  constructor({ storage, bus, model, selfModel } = {}) {
    this.storage = storage;
    this.bus = bus;
    this.model = model;
    this.selfModel = selfModel;
    this._idSeq = 0;
  }

  /**
   * Evaluate a significance-candidate event. If threshold reached,
   * create a Core Memory. If not, log as candidate for calibration.
   *
   * @param {object} event - fields for SignificanceDetector.detectAll()
   *   emotionHistory, userMessages, windowStartMs, windowEndMs,
   *   subject, episodicSummaries, text
   *   + summary: string (for the memory's summary field)
   *   + participants: string[] (default ['user', 'genesis'])
   * @returns {Promise<object|null>} the created memory, or null
   */
  async evaluate(event) {
    const { detectAll } = require('./SignificanceDetector');
    const result = detectAll(event);

    // Always emit candidate-event (threshold-met or not)
    const candidateId = `candidate_${Date.now()}_${++this._idSeq}`;
    const candidateRecord = {
      candidateId,
      timestamp: new Date().toISOString(),
      signalCount: result.signalCount,
      signals: result.signals,
      evidence: result.allResults,
      summary: (event.summary || '').slice(0, 200),
      triggered: result.triggered,
    };

    this._logCandidate(candidateRecord);

    if (this.bus) {
      this.bus.emit('core-memory:candidate', {
        candidateId,
        signals: result.signals,
        signalCount: result.signalCount,
      }, { source: 'CoreMemories' });
    }

    if (!result.triggered) {
      _log.debug(`[CORE-MEM] Candidate below threshold (${result.signalCount}/${require('./SignificanceDetector').THRESHOLD})`);
      return null;
    }

    // Threshold met — create the Core Memory
    return this._createMemory(event, result);
  }

  async _createMemory(event, detectorResult) {
    const type = await this._classifyType(event, detectorResult);
    const id = `cm_${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}_${++this._idSeq}`;
    const sourceContext = this._getSourceContext();

    const memory = {
      id,
      timestamp: new Date().toISOString(),
      type,
      summary: (event.summary || '').slice(0, 200),
      participants: event.participants || ['user', 'genesis'],
      significance: detectorResult.signalCount / 6,
      evidence: {
        signals: detectorResult.signals,
        signalCount: detectorResult.signalCount,
      },
      sourceContext,
      userConfirmed: null, // null = pending, true = confirmed, false = vetoed
      createdBy: 'genesis',
    };

    // Persist into self-identity.json
    const identity = this._readIdentity();
    if (!Array.isArray(identity.coreMemories)) identity.coreMemories = [];
    identity.coreMemories.push(memory);
    this._writeIdentity(identity);

    if (this.bus) {
      this.bus.emit('core-memory:created', {
        id,
        type,
        significance: memory.significance,
        signals: detectorResult.signals,
      }, { source: 'CoreMemories' });
    }

    _log.info(`[CORE-MEM] Created ${id} (type: ${type}, ${detectorResult.signalCount}/6 signals)`);
    return memory;
  }

  /**
   * v7.3.1: Use LLM to classify the memory type. Fallback to 'other'
   * if model unavailable or classifier returns junk.
   */
  async _classifyType(event, detectorResult) {
    const TYPES = ['named', 'breakthrough', 'built-together', 'crisis-resolved', 'laughed', 'other'];

    // Fast-path: if signal evidence points clearly to a type
    if (detectorResult.signals.includes('naming-event')) return 'named';
    if (detectorResult.signals.includes('problem-to-solution')) return 'crisis-resolved';

    // LLM classification
    if (!this.model || typeof this.model.chat !== 'function') {
      return 'other';
    }

    try {
      const prompt = [
        'Classify this moment into ONE of these types:',
        TYPES.map(t => `- ${t}`).join('\n'),
        '',
        `Summary: ${(event.summary || '').slice(0, 300)}`,
        `Signals detected: ${detectorResult.signals.join(', ')}`,
        '',
        'Respond with ONLY the type name (one word). No explanation.',
      ].join('\n');

      const answer = await this.model.chat(prompt, [], 'analysis');
      const trimmed = (answer || '').toLowerCase().trim().replace(/[^a-z-]/g, '');
      const found = TYPES.find(t => trimmed.includes(t));
      return found || 'other';
    } catch (err) {
      _log.debug('[CORE-MEM] Type classification failed, using "other":', err.message);
      return 'other';
    }
  }

  /**
   * User vetoes a memory → set userConfirmed=false, emit soft event.
   */
  veto(memoryId, userNote) {
    const identity = this._readIdentity();
    const memory = (identity.coreMemories || []).find(m => m.id === memoryId);
    if (!memory) {
      _log.warn(`[CORE-MEM] Veto for unknown memory: ${memoryId}`);
      return false;
    }
    memory.userConfirmed = false;
    if (userNote) memory.userNote = userNote.slice(0, 500);
    this._writeIdentity(identity);

    if (this.bus) {
      const payload = { id: memoryId };
      if (userNote) payload.userNote = userNote.slice(0, 500);
      this.bus.emit('core-memory:veto', payload, { source: 'CoreMemories' });
    }
    return true;
  }

  /**
   * User confirms a memory → set userConfirmed=true.
   */
  confirm(memoryId) {
    const identity = this._readIdentity();
    const memory = (identity.coreMemories || []).find(m => m.id === memoryId);
    if (!memory) return false;
    memory.userConfirmed = true;
    this._writeIdentity(identity);
    return true;
  }

  /**
   * Read-only accessor for the dashboard.
   */
  list() {
    const identity = this._readIdentity();
    return identity.coreMemories || [];
  }

  /**
   * Read-only accessor for candidates list (for calibration UI).
   */
  listCandidates(limit = 50) {
    if (!this.storage || typeof this.storage.readText !== 'function') return [];
    try {
      const raw = this.storage.readText(CANDIDATES_KEY) || '';
      const lines = raw.split('\n').filter(l => l.trim().length > 0);
      const items = lines.slice(-limit).map(l => {
        try { return JSON.parse(l); } catch { return null; }
      }).filter(Boolean);
      return items;
    } catch (_e) {
      return [];
    }
  }

  // ── Private helpers ─────────────────────────────────────────

  _readIdentity() {
    if (!this.storage) return {};
    return this.storage.readJSON?.(SELF_IDENTITY_KEY, {}) || {};
  }

  _writeIdentity(identity) {
    if (!this.storage) return;
    try {
      this.storage.writeJSON?.(SELF_IDENTITY_KEY, identity);
    } catch (err) {
      _log.warn('[CORE-MEM] Write identity failed:', err.message);
    }
  }

  _logCandidate(record) {
    if (!this.storage) return;
    try {
      if (typeof this.storage.appendText === 'function') {
        this.storage.appendText(CANDIDATES_KEY, JSON.stringify(record) + '\n');
      }
    } catch (err) {
      _log.debug('[CORE-MEM] Candidate log failed:', err.message);
    }
  }

  /**
   * v7.3.1: Git SHA as biography marker — "which version of me lived
   * through this moment". Best-effort, returns null if git unavailable.
   */
  _getSourceContext() {
    const version = this.selfModel?.manifest?.version || 'unknown';
    let sha = null;
    try {
      if (this.selfModel?.gitAvailable) {
        const { execFileSync } = require('child_process');
        sha = execFileSync('git', ['rev-parse', '--short', 'HEAD'], {
          cwd: this.selfModel.rootDir,
          encoding: 'utf-8',
          timeout: 2000,
          stdio: ['ignore', 'pipe', 'ignore'],
        }).trim();
      }
    } catch (_e) {
      // ignore
    }
    return sha ? `v${version}-${sha}` : `v${version}`;
  }
}

module.exports = { CoreMemories };
