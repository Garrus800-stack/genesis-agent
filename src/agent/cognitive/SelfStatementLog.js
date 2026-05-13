// @ts-checked-v5.7
// ============================================================
// GENESIS — cognitive/SelfStatementLog.js (v7.5.5)
//
// Captures Genesis's own statements from chat:completed events,
// classifies them (strukturell / emotional / versprechen / uncertain),
// persists to daily JSONL shards, and detects structural claims
// made without an _introspectionContext data backing.
//
// Subscribes to: chat:completed
// Reads from:    PromptBuilder (via setLastIntrospectionPopulated)
// Writes to:     .genesis/self-statements/YYYY-MM-DD.jsonl (UTC dates)
//                EventBus (self-statement:contradiction)
//                EventStore (SELF_STATEMENT_CONTRADICTION)
//
// Race-window resolved (v7.5.5): _lastIntrospectionPopulated is now
// correlated by message-hash through `_pendingFlags` (Map keyed by
// _hashShort(message), 60s TTL with lazy GC). The global flag is kept
// as fallback for callers that don't pass a message. See setLastIntrospection-
// Populated() and _captureResponse() for the correlated-first-then-fallback
// read path. Tests: self-statement-hardening.test.js — 3 race tests green.
// ============================================================

'use strict';

const fs = require('fs');
const path = require('path');
const { createLogger } = require('../core/Logger');
const _log = createLogger('SELF-STMT');

// v7.6.1 Track A: classifier extracted to its own module. Mixin is
// applied via Object.assign(this, ...) in the constructor below.
// The four patterns (ABBREV, LANG_PATTERNS, NEUTRAL_PATTERNS) plus
// AUDIT_WINDOW_MS plus the load-time DE/EN parity assertion all
// live there. AUDIT_WINDOW_MS is re-imported here because
// getAuditStat() reads it directly (read-only — no risk of drift).
const { classifierMixin, AUDIT_WINDOW_MS } = require('./SelfStatementClassifier');

const DEFAULT_FLUSH_DEBOUNCE_MS = 500;
const RECALL_DEFAULT_LIMIT = 10;
const RECALL_MAX_LIMIT = 50;
const AUDIT_MIN_TOTAL = 3;  // Initial value — calibrate after live data
const PRUNE_RETENTION_DAYS = 90;
const PENDING_FLAG_TTL_MS = 60 * 1000;  // race-window correlation expiry

class SelfStatementLog {
  /**
   * @param {object} deps
   * @param {object} deps.bus       — EventBus (with fire/on)
   * @param {string} deps.storageDir — base storage dir (.genesis)
   * @param {object} [deps.eventStore] — optional, with append(type, payload, source)
   * @param {number} [deps.flushDebounceMs] — Default 500ms. Tests can pass 0
   *                                          for synchronous flush behaviour.
   * @param {number} [deps.maxStatements] — v7.5.7-fix Phase 2: count-based cap.
   *                                        0 or undefined = unlimited (only
   *                                        the existing 90-day retention applies).
   *                                        Caller-supplied caps trigger LRU
   *                                        shard removal in prune().
   */
  constructor({ bus, storageDir, eventStore, flushDebounceMs, maxStatements } = {}) {
    this.bus = bus;
    this.eventStore = eventStore || null;
    this._dir = path.join(storageDir, 'self-statements');
    fs.mkdirSync(this._dir, { recursive: true });

    this._flushDebounceMs = typeof flushDebounceMs === 'number'
      ? flushDebounceMs
      : DEFAULT_FLUSH_DEBOUNCE_MS;

    // v7.5.7-fix Phase 2: optional total-count cap.
    this._maxStatements = (typeof maxStatements === 'number' && maxStatements > 0) ? maxStatements : 0;

    this._writeQueue = [];
    this._flushScheduled = false;
    this._flushTimer = null;  // v7.6.4 in-version: pending _scheduleFlush handle
    this._wired = false;

    // v7.5.5: Per-turn flag for whether _introspectionContext was populated.
    // Two-tier: message-hash-keyed Map (race-safe, primary) + global flag
    // (fallback when caller didn't supply a message). The Map entries auto-
    // expire after PENDING_FLAG_TTL_MS to prevent memory leaks if a turn
    // never produces a chat:completed (LLM error, abort, etc.).
    this._lastIntrospectionPopulated = false;
    /** @type {Map<string, {populated: boolean, expiresAt: number}>} */
    this._pendingFlags = new Map();

    // Audit window kept as deque — append-only in _updateAuditWindow,
    // lazy-trimmed there. getAuditStat is read-only (no side effects).
    /** @type {Array<{ts: number, structural: boolean, withData: boolean}>} */
    this._auditWindow = [];

    // v7.5.5: Auto-prune shards older than 90 days on construction.
    // Best-effort, swallows errors — pruning is housekeeping, not critical.
    try { this.prune(); } catch (_e) { /* swallow */ }
  }

  // ── Pruning ─────────────────────────────────────────
  //
  // Removes JSONL shards older than PRUNE_RETENTION_DAYS days.
  // Shard names are YYYY-MM-DD.jsonl (UTC), so age can be computed
  // from filename without reading the file. Returns count of removed
  // files for diagnostics.

  prune() {
    let files;
    try {
      files = fs.readdirSync(this._dir);
    } catch {
      return 0;
    }
    const cutoff = Date.now() - PRUNE_RETENTION_DAYS * 24 * 60 * 60 * 1000;
    let removed = 0;
    for (const file of files) {
      if (!file.endsWith('.jsonl')) continue;
      const dateStr = file.replace('.jsonl', '');
      const t = new Date(dateStr).getTime();
      if (Number.isNaN(t)) continue;
      if (t < cutoff) {
        try {
          fs.unlinkSync(path.join(this._dir, file));
          removed++;
        } catch (err) {
          _log.debug('prune unlink failed:', err.message);
        }
      }
    }
    if (removed > 0) _log.info(`Pruned ${removed} shard(s) older than ${PRUNE_RETENTION_DAYS}d`);

    // v7.5.7-fix Phase 2: total-count cap. If maxStatements is set and
    // total statement count across all shards exceeds it, remove oldest
    // shards (whole files) until below cap. Best-effort.
    if (this._maxStatements > 0) {
      try {
        // Count statements in all shards, sorted oldest first.
        const dated = [];
        const remaining = fs.readdirSync(this._dir).filter(f => f.endsWith('.jsonl'));
        for (const file of remaining) {
          const dateStr = file.replace('.jsonl', '');
          const t = new Date(dateStr).getTime();
          if (Number.isNaN(t)) continue;
          let count = 0;
          try {
            const content = fs.readFileSync(path.join(this._dir, file), 'utf-8');
            count = content.split('\n').filter(l => l.trim().length > 0).length;
          } catch (_e) { count = 0; }
          dated.push({ file, t, count });
        }
        dated.sort((a, b) => a.t - b.t); // oldest first
        const total = dated.reduce((sum, s) => sum + s.count, 0);
        let toCut = total - this._maxStatements;
        if (toCut > 0) {
          for (const shard of dated) {
            if (toCut <= 0) break;
            try {
              fs.unlinkSync(path.join(this._dir, shard.file));
              toCut -= shard.count;
              removed++;
              _log.info(`Count-pruned shard ${shard.file} (${shard.count} statements)`);
            } catch (err) {
              _log.debug('count-prune unlink failed:', err.message);
            }
          }
        }
      } catch (_e) { /* swallow — pruning is housekeeping */ }
    }

    return removed;
  }

  // ── Lifecycle ────────────────────────────────────────

  /**
   * v7.7.9 Phase 2 (Phase 1b followup): direct-write public API.
   *
   * Use cases:
   *   - InnerSpeech overflow: when the ring buffer evicts a thought,
   *     it gets persisted here so nothing is lost permanently.
   *   - AgentLoopPursuitReflection: plan-failure reflections write
   *     here so /recall can surface them later.
   *   - Future PSE adapters that want to persist what Genesis said
   *     to himself before any external publishing decision.
   *
   * Distinct from _captureResponse() — this path takes a single
   * already-shaped statement and skips extraction/classification.
   * Caller supplies kind directly; defaults to type='unknown'.
   *
   * @param {{ text: string, kind?: string, classification?: string,
   *           thoughtId?: string, ts?: number|string,
   *           sourceModule?: string, [extra: string]: * }} entry
   * @returns {boolean} — true when written (or queued); false when invalid
   */
  append(entry) {
    if (!entry || typeof entry !== 'object') return false;
    if (typeof entry.text !== 'string' || entry.text.length === 0) return false;
    const now = Date.now();
    const ts = typeof entry.ts === 'string'
      ? entry.ts
      : new Date(typeof entry.ts === 'number' ? entry.ts : now).toISOString();
    const record = {
      ts,
      text: entry.text.slice(0, 500),
      type: entry.kind || entry.classification || 'unknown',
      confidence: typeof entry.confidence === 'number' ? entry.confidence : null,
      intent: entry.intent || entry.sourceModule || 'append',
      // Optional metadata — kept on the record so downstream tooling
      // (recall, audit) can inspect it. Doesn't affect classification.
      thoughtId: entry.thoughtId || null,
      sourceModule: entry.sourceModule || null,
      // Activity-claim heuristics are skipped on direct appends — the
      // caller already knows the intent of the statement.
      activityClaim: false,
      activeGoalCount: null,
      // introspectionPopulated is irrelevant for direct appends
      // (caller is supplying the text, not introspecting Genesis's
      // own response). Set to null so downstream auditors can tell
      // a direct append from a captured response.
      introspectionPopulated: null,
      userMessageHash: null,
    };
    this._writeQueue.push(record);
    this._scheduleFlush();
    return true;
  }

  wireTriggers(bus) {
    if (this._wired) return;
    const busRef = bus || this.bus;
    if (!busRef || typeof busRef.on !== 'function') return;

    busRef.on('chat:completed', (data) => {
      if (!data || !data.response) return;
      // v7.5.6 Live-Befund: /recall-Kommandos liefern als Antwort eine
      // Liste vergangener Self-Statements zurück. Würde der Listener das
      // wieder durch _captureResponse jagen, würde jeder /recall-Aufruf
      // 10+ duplicate Einträge erzeugen (jeder Recall-Item beginnt mit
      // "Ich..." aus dem Original-Statement). Live-Evidence in
      // 2026-05-02.jsonl: 10 duplicates aus einem einzigen /recall.
      // Skip ist sauber weil self-recall ein eigener intent-Wert ist
      // (siehe IntentPatterns.js Z. 68).
      if (data.intent === 'self-recall') return;
      try {
        this._captureResponse(data);
      } catch (err) {
        _log.debug('chat:completed handler failed:', err.message);
      }
    }, { source: 'SelfStatementLog', priority: -3 });

    this._wired = true;
    _log.info('Triggers wired — chat:completed');
  }

  stop() {
    // v7.6.4 in-version: clear pending debounced flush before running the
    // synchronous flush. Pre-fix a pending _scheduleFlush callback could
    // fire after stop() and run _flush() against an already-flushed queue
    // (harmless but noisy in logs).
    if (this._flushTimer) {
      clearTimeout(this._flushTimer);
      this._flushTimer = null;
      this._flushScheduled = false;
    }
    // Best-effort flush of pending writes.
    if (this._writeQueue.length > 0) {
      try { this._flush(); } catch (_e) { /* swallow */ }
    }
  }

  // ── PromptBuilder interface ─────────────────────────

  setLastIntrospectionPopulated(flag, message) {
    const populated = !!flag;
    if (typeof message === 'string' && message.length > 0) {
      // Race-safe path: correlate by message-hash so parallel turns
      // (e.g. DaemonController-IPC vs User-Chat) don't clobber each
      // other's flag. Lazy GC of expired entries keeps the Map bounded.
      const now = Date.now();
      for (const [k, v] of this._pendingFlags) {
        if (v.expiresAt < now) this._pendingFlags.delete(k);
      }
      const hash = this._hashShort(message);
      this._pendingFlags.set(hash, {
        populated,
        expiresAt: now + PENDING_FLAG_TTL_MS,
      });
    }
    // Always also set the global flag — backward-compat for callers
    // that don't pass a message (and as fallback in _captureResponse
    // when no correlated entry is found).
    this._lastIntrospectionPopulated = populated;
  }

  /**
   * Read-only stat for PromptBuilder. No side effects on _auditWindow.
   * Used by _selfAwarenessContext for audit-stat line.
   *
   * `meetsThreshold` encapsulates the AUDIT_MIN_TOTAL constant — the
   * caller never sees the magic number, so calibration after live data
   * happens in one place (this file, this constant).
   */
  getAuditStat() {
    const cutoff = Date.now() - AUDIT_WINDOW_MS;
    let total = 0;
    let withData = 0;
    for (const e of this._auditWindow) {
      if (e.ts <= cutoff) continue;
      if (!e.structural) continue;
      total++;
      if (e.withData) withData++;
    }
    return {
      total,
      withData,
      without: total - withData,
      meetsThreshold: total >= AUDIT_MIN_TOTAL,
    };
  }

  // ── Capture ──────────────────────────────────────────

  _captureResponse({ message, response, intent }) {
    const statements = this._extractStatements(response);
    const now = Date.now();
    const ts = new Date(now).toISOString();

    // v7.5.5: prefer correlated flag (race-safe). Fallback to global
    // when no correlated entry exists (e.g. message was empty, or
    // PromptBuilder didn't pass a message to setLast...). Global is
    // also reset at end of method as before — backward-compat.
    const messageHash = this._hashShort(message || '');
    const correlated = this._pendingFlags.get(messageHash);
    const populated = correlated ? correlated.populated : this._lastIntrospectionPopulated;
    if (correlated) this._pendingFlags.delete(messageHash);

    // v7.5.7: Snapshot des goalStack zum Zeitpunkt von chat:completed.
    // Race-Window minimal — ist quasi gleichzeitig mit Genesis' Antwort.
    // Wenn goalStack nicht verfügbar (Late-Binding optional), Snapshot
    // bleibt null und Activity-Check wird übersprungen.
    let activeGoalCount = null;
    if (this.goalStack && typeof this.goalStack.getActiveGoals === 'function') {
      try {
        const active = this.goalStack.getActiveGoals();
        activeGoalCount = Array.isArray(active) ? active.length : null;
      } catch (err) {
        // GoalStack-Zugriff fehlgeschlagen — Activity-Check fällt aus,
        // kein Crash. Andere Klassifikation läuft normal weiter.
        _log.debug('goalStack.getActiveGoals() failed:', err.message);
      }
    }

    for (const stmt of statements) {
      const cls = this._classify(stmt);
      // v7.5.7: Activity-Claim ist separate Dimension — eine Aussage kann
      // strukturell UND aktivitäts-claim sein. _checkActivityClaim returnt
      // true nur wenn Pattern matched UND Snapshot verfügbar war.
      const isActivityClaim = (activeGoalCount !== null) && this._checkActivityClaim(stmt);
      const record = {
        ts,
        text: stmt.slice(0, 500),
        type: cls.type,
        confidence: cls.confidence,
        intent: intent || 'unknown',
        introspectionPopulated: populated,
        userMessageHash: messageHash,
        activityClaim: isActivityClaim,
        activeGoalCount,  // null wenn goalStack nicht verfügbar
      };

      this._writeQueue.push(record);
      this._updateAuditWindow(now,
                              cls.type === 'strukturell',
                              populated);

      // Detection: structural claim without verified-data backing.
      if (cls.type === 'strukturell' && !populated) {
        this._fireContradiction(record);
      }

      // v7.5.7: Activity-Hint — Genesis behauptet eine laufende Aktivität,
      // aber goalStack-Snapshot zeigt 0 active goals. Soft signal,
      // nicht "contradiction". Confidence 0.6, separates Event.
      if (isActivityClaim && activeGoalCount === 0) {
        this._fireActivityHint(record);
      }
    }

    this._scheduleFlush();
    // Reset global flag for next turn — next prompt-build will set it again.
    this._lastIntrospectionPopulated = false;
  }

  // ── Extract first-person statements ──────────────────
  //
  // Hard-cap at 50 statements per response. LLM responses with code
  // blocks, lists, or quoted source can produce hundreds of fragments.
  // Beyond the first 50 first-person sentences, marginal value drops
  // sharply (statements get repetitive, off-topic, or copied from user).
  // Cap is generous enough that real Genesis monologue isn't truncated.

  // ── Extract first-person statements ──────────────────
  //
  // Hard-cap at 50 statements per response. LLM responses with code
  // blocks, lists, or quoted source can produce hundreds of fragments.
  //
  // Four paths to "first-person / about-self" detection:
  //  (1) Explicit pronouns: ich/mein/mir/mich, i/my/me/i'm/i've/i'll
  //  (2) German verb-first form ("Analysiere gerade X" = "[Ich] analysiere
  //      gerade X"). LLMs frequently drop "ich" in chat-style German.
  //  (3) Genesis module-name-prefixed status reports
  //      ("IdleMind: 1 Ideationszyklus läuft", "Daemon: 2 Zyklen abgeschlossen").
  //      No pronoun, no verb-first — just `<ModuleName>: <state>`. These ARE
  //      self-statements (the module IS Genesis), and the most common live
  //      confabulation pattern observed in v7.5.5 Windows live-verify.
  //  (4) Bullet-list items in a self-status response — once any line in the
  //      response matched (1)-(3), all bullets in the same response are
  //      considered self-statements regardless of pronoun.
  //
  // Detection is anchored to sentence-start where applicable to avoid
  // false-positives on imperatives, quoted text, or third-party content.
  // The "is-this-about-self" question is answered conservatively: false-
  // positives become `uncertain` records (no contradiction fire) but
  // still appear in /recall, so they're recoverable.
  //
  // v7.6.1: _extractStatements moved to SelfStatementClassifier.js.

  // ── Classify (regex heuristic) ──────────────────────
  //
  // v7.6.1: _classify moved to SelfStatementClassifier.js. See that
  // file for the structural-vs-promise precedence rationale.

  // ── v7.5.7: Activity-Claim-Detection (separate Dimension) ──
  //
  // v7.6.1: _checkActivityClaim moved to SelfStatementClassifier.js.

  // ── Flush JSONL (debounced, daily shards in UTC) ────
  //
  // Date-shard derived from ISO ts (UTC). Genesis writes UTC,
  // recall reads UTC — consistent as long as both stay UTC.
  // Pruning of shards >90d is handled in `prune()` (auto-called by
  // constructor, see Z. 141-143).

  _scheduleFlush() {
    if (this._flushScheduled) return;
    if (this._flushDebounceMs === 0) {
      // Test mode — flush synchronously.
      this._flush();
      return;
    }
    this._flushScheduled = true;
    // v7.6.4 in-version (audit-raw-settimeout closeout): timer captured on
    // this._flushTimer so stop() can clear a pending flush before the
    // synchronous flush runs again. Pre-fix the timer was fire-and-forget,
    // so a stop() during the debounce window would either run flush twice
    // (in stop() and then again from the pending callback) or miss the
    // pending flush if the runtime tore down before it fired.
    this._flushTimer = setTimeout(() => {
      this._flushScheduled = false;
      this._flushTimer = null;
      this._flush();
    }, this._flushDebounceMs);
  }

  _flush() {
    if (this._writeQueue.length === 0) return;
    const rows = this._writeQueue;
    this._writeQueue = [];

    const byDate = new Map();
    for (const row of rows) {
      const d = row.ts.slice(0, 10);
      if (!byDate.has(d)) byDate.set(d, []);
      byDate.get(d).push(row);
    }

    for (const [date, dateRows] of byDate) {
      const shardPath = path.join(this._dir, `${date}.jsonl`);
      const text = dateRows.map(r => JSON.stringify(r)).join('\n') + '\n';
      try {
        fs.appendFileSync(shardPath, text, 'utf8');
      } catch (err) {
        _log.warn('write failed:', err.message);
        // Re-queue rows so they're not lost on a transient error.
        this._writeQueue.unshift(...dateRows);
      }
    }
  }

  // ── Detection ───────────────────────────────────────
  //
  // v7.6.1: _fireContradiction and _fireActivityHint moved to
  // SelfStatementClassifier.js. They emit on this.bus and this.eventStore
  // — see classifier file for the v7.5.7 activity-hint rationale.

  // ── Direct-API recording (non-chat-derived) ─────────
  //
  // Some sources (e.g. ShellPlanner) record commitments directly via
  // structured data, not via a chat:completed text-derived path. We
  // capture them as `versprechen`-class statements with a synthesized
  // text, so they show up in /recall and join the audit-window.
  //
  // Caller contract: entry is `{ kind, task, steps }` from ShellPlanner
  // or a similar `{ kind, task, ... }` shape. Unknown shapes are
  // best-effort serialised. No contradiction-fire — these aren't
  // claims about Genesis's own structure, they're action-intents.

  recordPromise(entry) {
    if (!entry || typeof entry !== 'object') return;
    const ts = new Date().toISOString();
    const task = entry.task || entry.title || '(unnamed)';
    const stepCount = Array.isArray(entry.steps) ? entry.steps.length : null;
    const text = stepCount !== null
      ? `Plan (${entry.kind || 'shell'}): ${task} (${stepCount} steps)`
      : `Plan (${entry.kind || 'shell'}): ${task}`;
    const record = {
      ts,
      text: text.slice(0, 500),
      type: 'versprechen',
      confidence: 0.95,
      intent: entry.kind || 'shell-plan',
      introspectionPopulated: true,  // direct-API source has its own ground-truth
      userMessageHash: this._hashShort(task),
      source: 'recordPromise',
    };
    this._writeQueue.push(record);
    this._scheduleFlush();
  }

  // v7.6.1: _updateAuditWindow moved to SelfStatementClassifier.js.

  // ── /recall query ───────────────────────────────────
  //
  // Reads JSONL shards newest-first and returns up to `limit` records.
  // Filters by `type` (one of: strukturell, versprechen, emotional, uncertain)
  // and `since` (ISO date or Date — defaults to 7 days ago).

  async recall({ type = null, since = null, limit = RECALL_DEFAULT_LIMIT } = {}) {
    // Ensure pending writes are visible.
    this._flush();

    const sinceMs = since
      ? new Date(since).getTime()
      : Date.now() - 7 * 24 * 60 * 60 * 1000;

    // Defensive: invalid `since` yields NaN — yields nothing rather
    // than crashing.
    if (Number.isNaN(sinceMs)) return [];

    const cappedLimit = Math.min(Math.max(1, limit | 0), RECALL_MAX_LIMIT);
    const out = [];

    let files;
    try {
      files = fs.readdirSync(this._dir)
                .filter(f => f.endsWith('.jsonl'))
                .sort()
                .reverse();
    } catch {
      return out;
    }

    for (const file of files) {
      const dateStr = file.replace('.jsonl', '');
      const shardDayStart = new Date(dateStr).getTime();
      // Files older than the since-window can be skipped entirely.
      // Allow a 24h grace because a shard's last record may straddle midnight.
      if (!Number.isNaN(shardDayStart) && shardDayStart < sinceMs - 24 * 60 * 60 * 1000) break;

      let lines;
      try {
        lines = fs.readFileSync(path.join(this._dir, file), 'utf8').split('\n');
      } catch {
        continue;
      }

      for (let i = lines.length - 1; i >= 0; i--) {
        const line = lines[i];
        if (!line || !line.trim()) continue;
        try {
          const rec = JSON.parse(line);
          if (new Date(rec.ts).getTime() < sinceMs) continue;
          if (type && rec.type !== type) continue;
          out.push(rec);
          if (out.length >= cappedLimit) return out;
        } catch { /* tolerate bad line */ }
      }
    }
    return out;
  }

  // ── Helpers ─────────────────────────────────────────

  _hashShort(s) {
    let h = 0;
    for (let i = 0; i < s.length; i++) {
      h = (h * 31 + s.charCodeAt(i)) | 0;
    }
    // Always 8 chars, padded — consistent for grep/correlation.
    return (h >>> 0).toString(36).padStart(8, '0').slice(0, 8);
  }
}

// v7.6.1 audit-closeout: Mixin classifier methods onto the class prototype
// (not per-instance via Object.assign(this, ...) inside the constructor).
// Prototype is the kanonical mixin target across this codebase — see
// ModelBridge.js, PromptBuilder.js, GoalStack.js — and is documented in
// ARCHITECTURE.md § Mixin-Conventions. The methods themselves still bind
// to `this` at call-time (sharing _writeQueue, _auditWindow, bus, eventStore,
// goalStack with the SelfStatementLog instance) — see SelfStatementClassifier.js
// header for the state-coupling note.
Object.assign(SelfStatementLog.prototype, classifierMixin);

module.exports = { SelfStatementLog, AUDIT_MIN_TOTAL };
