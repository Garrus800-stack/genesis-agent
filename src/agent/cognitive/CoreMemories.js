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
   *   emotionalState - EmotionalState (v7.3.2: for emotion history in triggers)
   *   conversationMemory - ConversationMemory (v7.3.2: for novelty check)
   *   knowledgeGraph - KnowledgeGraph (v7.3.2: for subject extraction, optional)
   */
  constructor({ storage, bus, model, selfModel, emotionalState, conversationMemory, knowledgeGraph } = {}) {
    this.storage = storage;
    this.bus = bus;
    this.model = model;
    this.selfModel = selfModel;
    this.emotionalState = emotionalState || null;
    this.conversationMemory = conversationMemory || null;
    this.knowledgeGraph = knowledgeGraph || null;
    this._idSeq = 0;

    // v7.3.2: User-message sliding window for userBeteiligung signal.
    // Holds { ts, text } entries from the last USER_MSG_WINDOW_MS.
    this._userMessageBuffer = [];
    this._USER_MSG_WINDOW_MS = 30 * 60 * 1000;
    this._USER_MSG_MAX = 50;

    // v7.3.2: Git-SHA cache — resolved once at boot, invalidated on hot-reload
    this._cachedSourceContext = null;
    this._wired = false;
  }

  /**
   * v7.3.2: Wire event listeners. Called by AgentCoreWire after late-bindings.
   * Idempotent — safe to call multiple times.
   */
  wireTriggers(bus) {
    if (this._wired) return;
    const busRef = bus || this.bus;
    if (!busRef || typeof busRef.on !== 'function') return;

    // Trigger: evaluate after every completed chat turn
    busRef.on('chat:completed', async (data) => {
      if (!data?.message || !data?.response) return;
      try {
        const event = this._assembleEvent(data.message, data.response);
        await this.evaluate(event);
      } catch (err) {
        _log.debug('[CORE-MEM] chat:completed handler failed:', err.message);
      }
    }, { source: 'CoreMemories', priority: -2 });

    // Trigger: maintain user-message sliding window
    busRef.on('user:message', (data) => {
      const now = Date.now();
      // Prune old entries first
      const cutoff = now - this._USER_MSG_WINDOW_MS;
      this._userMessageBuffer = this._userMessageBuffer.filter(m => m.ts > cutoff);
      // Append new; we don't have text here (only length), so we log length as proxy
      this._userMessageBuffer.push({ ts: now, length: data?.length || 0 });
      // Cap buffer size
      if (this._userMessageBuffer.length > this._USER_MSG_MAX) {
        this._userMessageBuffer = this._userMessageBuffer.slice(-this._USER_MSG_MAX);
      }
    }, { source: 'CoreMemories' });

    // Trigger: invalidate Git-SHA cache on hot reload
    busRef.on('hot-reload:success', () => {
      this._cachedSourceContext = null;
    }, { source: 'CoreMemories' });

    // Resolve Git-SHA once at wire time
    this._cachedSourceContext = this._computeSourceContext();

    this._wired = true;
    _log.info('[CORE-MEM] Triggers wired — chat:completed, user:message, hot-reload');
  }

  /**
   * v7.3.2: Assemble a SignificanceDetector event from live system state.
   * Synchronous reads of already-loaded data; no async cost.
   */
  _assembleEvent(userMessage, response) {
    const now = Date.now();
    const windowMs = 30 * 60 * 1000;

    // Signal 1: emotion history (via adapter)
    const emotionHistory = this.emotionalState?.getHistoryForSignificance?.(windowMs) || [];

    // Signal 2: user messages in window (from internal buffer)
    const userMessages = this._userMessageBuffer.slice();
    const windowStartMs = now - windowMs;
    const windowEndMs = now;

    // Signal 3: novelty — compare against past episodic summaries
    const episodicSummaries = [];
    try {
      if (this.conversationMemory?.db?.episodic) {
        const recentEpisodes = this.conversationMemory.db.episodic.slice(-50);
        for (const ep of recentEpisodes) {
          if (ep?.summary) episodicSummaries.push(ep.summary);
        }
      }
    } catch (_e) { /* tolerate missing conversationMemory */ }

    // Subject: best-effort extraction for novelty — use first proper noun
    // or longest word as rough stand-in. A full NER would be overkill for v7.3.2.
    const subject = _extractSubject(userMessage + ' ' + response);

    // Summary: short combined form
    const summary = [
      userMessage.slice(0, 100),
      response.slice(0, 150),
    ].join(' | ');

    return {
      emotionHistory, now,
      userMessages, windowStartMs, windowEndMs,
      subject, episodicSummaries,
      text: userMessage, // naming/explicit-flag signals scan user text
      summary,
    };
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

    if (!result.triggered && !event._bypassThreshold) {
      _log.debug(`[CORE-MEM] Candidate below threshold (${result.signalCount}/${require('./SignificanceDetector').THRESHOLD})`);
      return null;
    }

    // Threshold met (or test-bypass) — create the Core Memory
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
    // v7.3.2: 'laughed' is no longer a classifier target. User-only via markAsSignificant(type: 'laughed').
    const TYPES = ['named', 'breakthrough', 'built-together', 'crisis-resolved', 'other'];
    const signals = detectorResult.signals;
    const userInvolved = signals.includes('user-beteiligung');
    const novel = signals.includes('novelty');
    const solved = signals.includes('problem-to-solution');

    // Fast-paths — deterministic, no LLM call
    // Order matters: most specific first.

    // 1. Naming is always 'named' — strongest identity signal
    if (signals.includes('naming-event')) return 'named';

    // 2. v7.3.2: NEW — agentivity-based separator between built-together and breakthrough
    //    If user was involved AND there was a problem-solution arc: it was
    //    co-creation, not Genesis alone.
    if (userInvolved && solved) return 'built-together';

    // 3. v7.3.2: NEW — autonomous novelty arc = breakthrough
    //    Novel solution + problem solved + NO user involvement = Genesis did it.
    if (novel && solved && !userInvolved) return 'breakthrough';

    // 4. Problem-to-solution alone (no user, no novelty) = routine crisis resolution
    if (solved && !userInvolved && !novel) return 'crisis-resolved';

    // LLM classification for ambiguous cases
    if (!this.model || typeof this.model.chat !== 'function') {
      return 'other';
    }

    try {
      const prompt = [
        'Classify this moment into ONE type. Apply priority rules top-to-bottom:',
        '',
        '1. named — The user gave a specific name or identity marker.',
        '2. crisis-resolved — A critical failure/error that is now fixed.',
        '3. built-together — High-iteration back-and-forth where the solution emerged from BOTH parties.',
        '4. breakthrough — I found a novel solution to a hard problem with minimal user help.',
        '5. other — Default if signals are weak or ambiguous.',
        '',
        'Negation rules (apply strictly):',
        '- If user-beteiligung is in signals: NOT breakthrough.',
        '- If novelty is NOT in signals: NOT breakthrough.',
        '- If the solution was already in the user prompt: NOT breakthrough — probably other.',
        '- If problem-to-solution AND user-beteiligung: built-together, NOT crisis-resolved.',
        '',
        `Signals detected: ${signals.join(', ') || '(none)'}`,
        `Summary: ${(event.summary || '').slice(0, 300)}`,
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
   * v7.3.2: User-initiated memory creation. Bypasses the signal-threshold
   * entirely — when the user explicitly says "this matters", we trust them.
   * Memory is marked createdBy:'user' and userConfirmed:true immediately.
   *
   * @param {object} opts
   *   summary: string (required)
   *   type: string (optional, default 'other')
   *   userNote: string (optional)
   * @returns {Promise<object>} the created memory
   */
  async markAsSignificant({ summary, type = 'other', userNote }) {
    if (!summary || typeof summary !== 'string' || summary.trim().length === 0) {
      throw new Error('markAsSignificant requires a non-empty summary');
    }

    const id = `cm_${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}_u${++this._idSeq}`;
    const memory = {
      id,
      timestamp: new Date().toISOString(),
      type,
      summary: summary.slice(0, 500),
      participants: ['user', 'genesis'],
      significance: 1.0, // user-defined = full significance
      evidence: { signals: ['user-marked'], signalCount: 1, source: 'user-mark' },
      sourceContext: this._getSourceContext(),
      userConfirmed: true,
      createdBy: 'user',
      userNote: userNote || null,
    };

    const identity = this._readIdentity();
    if (!Array.isArray(identity.coreMemories)) identity.coreMemories = [];
    identity.coreMemories.push(memory);
    this._writeIdentity(identity);

    if (this.bus) {
      this.bus.emit('core-memory:created', {
        id, type, significance: 1.0, signals: ['user-marked'],
      }, { source: 'CoreMemories' });
      this.bus.emit('core-memory:user-marked', {
        id, type,
      }, { source: 'CoreMemories' });
    }

    _log.info(`[CORE-MEM] User-marked ${id} (type: ${type})`);
    return memory;
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
   * v7.3.2: Filtered accessor. Returns only memories NOT vetoed.
   * Consumers that build identity/narrative should use this (not list()).
   * Consumers for calibration/veto-UI should use list() directly.
   */
  listActiveMemories() {
    return this.list().filter(m => m.userConfirmed !== false);
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
   * through this moment". v7.3.2: Cached at wire time, invalidated on
   * hot-reload. This method is the cached accessor.
   */
  _getSourceContext() {
    if (this._cachedSourceContext !== null) return this._cachedSourceContext;
    // Lazy fallback for contexts where wireTriggers wasn't called (tests etc.)
    return this._computeSourceContext();
  }

  /**
   * Actual computation — calls out to git. Expensive. Only call via cache
   * or at wire time.
   */
  _computeSourceContext() {
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

// ── Helpers ──────────────────────────────────────────────────

/**
 * Extract a rough "subject" for the novelty check. Prefers capitalized
 * words (likely proper nouns) over common words. Returns null if nothing
 * meaningful. German umlauts preserved.
 */
function _extractSubject(text) {
  if (!text || typeof text !== 'string') return null;
  // Find capitalized words of length >= 3 (likely names/concepts)
  const proper = text.match(/\b[A-ZÄÖÜ][a-zäöüß]{2,}\b/g);
  if (proper && proper.length > 0) {
    // Return longest proper noun — most likely to be meaningful
    return proper.sort((a, b) => b.length - a.length)[0];
  }
  // Fallback: longest word >= 5 chars that isn't a stop-word
  const words = text.match(/\b\p{L}{5,}\b/gu) || [];
  const stopWords = new Set(['aber', 'wenn', 'nicht', 'sehr', 'deine', 'meine', 'seine', 'about', 'after', 'their', 'there', 'which', 'would']);
  const candidates = words.filter(w => !stopWords.has(w.toLowerCase()));
  if (candidates.length === 0) return null;
  return candidates.sort((a, b) => b.length - a.length)[0];
}

module.exports = { CoreMemories };
