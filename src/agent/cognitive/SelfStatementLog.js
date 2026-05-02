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

const DEFAULT_FLUSH_DEBOUNCE_MS = 500;
const RECALL_DEFAULT_LIMIT = 10;
const RECALL_MAX_LIMIT = 50;
const AUDIT_WINDOW_MS = 24 * 60 * 60 * 1000;
const AUDIT_MIN_TOTAL = 3;  // Initial value — calibrate after live data
const PRUNE_RETENTION_DAYS = 90;
const PENDING_FLAG_TTL_MS = 60 * 1000;  // race-window correlation expiry

// ──────────────────────────────────────────────────────────────────
// v7.5.6 — Module-level patterns (compiled once, not per-call).
//
// Why module-level: every call to _extractStatements or _classify
// previously redeclared 6+ regex literals, which means the regex
// engine recompiled them each time. With ~80 verb alternations in
// VERB_FIRST that adds up. Module-level constants are compiled at
// require() time, then reused.
//
// Why split into LANG_PATTERNS + NEUTRAL_PATTERNS:
//   - LANG_PATTERNS: speech patterns that vary by language (verb forms,
//     pronouns, emotional vocabulary, promise markers). Both DE and EN
//     must have the SAME keys (parity assertion below).
//   - NEUTRAL_PATTERNS: technical patterns that don't depend on language —
//     module names, structural nouns shared across DE/EN tech vocabulary,
//     bullet markers. Used by both _extractStatements and _classify
//     (de-dupes the previous in-method MODULE_PREFIX duplication).
//
// ABBREV is on module level too — it's used in .replace() only, so the
// `g` flag's lastIndex behaviour is safe.
// ──────────────────────────────────────────────────────────────────

const ABBREV = /\b(Mr|Mrs|Ms|Dr|Prof|Sr|Jr|St|e\.g|i\.e|etc|vs|cf|z\.B|d\.h|u\.a|bzw|ggf|bspw|usw|Nr|Bd|Abs|Art|S|z|Z)\.\s/g;

const LANG_PATTERNS = {
  de: {
    firstPersonExplicit: /\b(?:ich|mein\w*|mir|mich|wir|unser\w*)\b/i,
    // 1.-Person-Singular-Verben aus Genesis' tatsächlichen DE-Antworten.
    verbFirst: /^\s*(?:überwache|überprüfe|analysiere|plane|optimiere|arbeite|denke|sehe|lese|schreibe|baue|entwickle|implementiere|fokussiere|konzentriere|verstehe|merke|erkenne|finde|brauche|möchte|will|werde|hab|habe|bin|gehe|setze|nehme|teste|prüfe|untersuche|beobachte|reflektiere|überlege|versuche|starte|stoppe|pausiere|öffne|schließe|aktualisiere|migriere|refaktoriere|vergleiche|messe|tracke|debugge|berechne|generiere|erzeuge|erstelle|aktiviere|deaktiviere|scanne|fixe|repariere|warte|spüre|fühle|hoffe|glaube|erinnere|kenne|weiß|verfolge|sammle|speichere|lade|trainiere|lerne|verbessere|priorisiere|verschiebe|markiere|dokumentiere|kommentiere|erweitere|kürze|teile|kombiniere|prozessiere|verarbeite|signalisiere|melde|warne)\b/i,
    // v7.5.6 Live-Befund: deutsche Versprechen werden oft reflexiv gebildet
    // (`melde mich`, `bereite mich vor`, `kümmere mich um`) — nicht durch
    // die einfachen Verb-Hilfen `werde/möchte/plane`. "Ich prüfe den Fix
    // und melde mich" matcht ohne diese Marker nur strukturell (was OK
    // ist), aber "Ich melde mich später" alleine fällt sonst auf
    // `uncertain`. Hinzu: die promise-marker-Liste ist eine Zweit-Klasse
    // nach strukturell, also keine Klassifikations-Konflikte.
    promiseMarkers: /\b(?:werde|möchte|plane zu|habe vor|nehme mir vor|ich gehe an|als nächstes|nächster schritt|beabsichtige|melde mich|bereite mich vor|kümmere mich um)/i,
    emotionMarkers: /\b(?:fühle|spüre|freue|sorge|hoffe|bedauere|angst|stolz|traurig|wütend|frustriert)/i,
  },
  en: {
    firstPersonExplicit: /\b(?:i|i'm|i've|i'll|i'd|my|me|mine)\b/i,
    // Gerund-form parallel to DE 1st-person singular. Deduplicated.
    verbFirst: /^\s*(?:monitoring|analyzing|processing|checking|tracking|reviewing|planning|optimizing|working|thinking|seeing|reading|writing|building|developing|implementing|focusing|concentrating|understanding|noting|recognizing|finding|needing|wanting|having|going|setting|taking|testing|examining|investigating|observing|reflecting|considering|trying|starting|stopping|pausing|opening|closing|updating|migrating|refactoring|comparing|measuring|debugging|calculating|generating|creating|activating|deactivating|scanning|fixing|repairing|waiting|sensing|feeling|hoping|believing|remembering|knowing|collecting|saving|loading|training|learning|improving|prioritizing|moving|marking|documenting|commenting|extending|shortening|sharing|combining|signaling|reporting|warning)\b/i,
    // v7.5.6 Live-Befund: parallel zur DE-Erweiterung sind englische
    // Versprechen-Konstrukte mit reflexiven oder Handlungs-Phrasen
    // ergänzt. "I'll get back to you", "preparing for", "take care of",
    // "handle this" — typische English-Versprechen die ohne Marker auf
    // uncertain fallen würden.
    promiseMarkers: /\b(?:will\b|plan to|going to|next i|i'll|intend to|aim to|i'm gonna|next step|want to|get back to you|preparing for|take care of|i'll handle|handle this)/i,
    emotionMarkers: /\b(?:feel|hope|worry|regret|enjoy|frustrat|excit|happy|sad|proud|anxious|angry)/i,
  },
};

const NEUTRAL_PATTERNS = {
  // Genesis subsystem names that, when used as status-report subjects,
  // count as self-statements. Curated from actual module names in
  // src/agent/. LLM-hallucinated module names also match by design
  // (e.g. invented "GoalStack:" should still be captured as confabulation).
  modulePrefix: /^\s*[*•\-\d.)\s]*(IdleMind|DreamCycle|Daemon|AgentLoop|Memory|EventBus|GoalStack|Goals?|Capabilities?|Module[ns]?|EpisodicMemory|CoreMemories|SelfModel|EmotionalState|FormalPlanner|HTNPlanner|ShellAgent|ModelBridge|ModelRouter|KnowledgeGraph|UnifiedMemory|SelfModification|SelfStatementLog|Self-?Statement-?Log|Memory-?Consolidator|Genesis|Self-?Identity|Architecture|System|Vitals|Cognitive|Health|Container|Backend|Tools?|MCP|Skills?|Storage|Sandbox|CircuitBreaker|Settings|PromptBuilder|IntentRouter|ChatOrchestrator|ImmuneSystem|Metabolism|Genome|Homeostasis|NeedsSystem|BodySchema|Reasoning|Worker|Plan|Process|Service|Status|Activity|Hintergrund|Aktivität|Zustand|Phase|Trust|Energy|Mood)\b(?:\s*:|\s+\S)/i,
  // Structural-domain nouns. Bilingual list — these tokens occur in both
  // DE and EN technical writing. Used in _classify path A to detect
  // statements making data-backed claims about Genesis' internals.
  //
  // v7.5.6 Live-Befund (2026-05-02 Windows): Erste Liste war zu eng auf
  // interne Subsystem-Begriffe (modul/dream/daemon/loop/...) und fehlte
  // die deutschen Alltags-Substantive die in echten Confabulation-
  // Antworten auftauchten. Beobachtete Aussagen wie
  // "Ich prüfe den Fix, optimiere den Speicher und bereite mich auf das
  //  nächste Gespräch vor" landeten als `uncertain`/confidence-0 statt
  // als `strukturell` — d.h. die Contradiction-Detection feuerte nicht
  // für genau die Klasse Aussagen für die sie gebaut wurde. Erweiterung
  // konservativ: nur Begriffe die in Genesis-Aktivitätsbehauptungen
  // typisch sind, KEINE allgemeinen Substantive die in normalen User-
  // Antworten häufig vorkommen (z.B. NICHT `intelligenz`, `schritt`,
  // `entwickler`). Englisch-Parity dazu (cache/conversation/optimization/
  // analysis/check) für symmetrische Erfassung.
  structuralNouns: /\b(?:modul|module|version|memory|memori|capabilit|backend|model|service|event|layer|score|count|budget|config|setting|pfad|path|director|test|coverage|node|goal|stack|file|dream|cycle|zyklus|daemon|mind|loop|aussag|widerspr|selbst|consolidator|integrit|zustand|aktivit|self|state|activity|statement|contradict|monitoring|idle|active|background|process|speicher|cache|fix|bug|fehler|error|gespräch|conversation|chat|optimierung|optimization|analyse|analysis|prüfung|check|response)/i,
  bullet: /^\s*[*•\-]\s+\S/,
};

// Module-load-time parity check — a missing key in either DE or EN
// would cause silent classification gaps. Throws immediately at require()
// so the test suite catches drift before runtime.
{
  const deKeys = Object.keys(LANG_PATTERNS.de).sort();
  const enKeys = Object.keys(LANG_PATTERNS.en).sort();
  if (JSON.stringify(deKeys) !== JSON.stringify(enKeys)) {
    throw new Error(`SelfStatementLog LANG_PATTERNS keys mismatch: de=[${deKeys}], en=[${enKeys}]`);
  }
}

class SelfStatementLog {
  /**
   * @param {object} deps
   * @param {object} deps.bus       — EventBus (with fire/on)
   * @param {string} deps.storageDir — base storage dir (.genesis)
   * @param {object} [deps.eventStore] — optional, with append(type, payload, source)
   * @param {number} [deps.flushDebounceMs] — Default 500ms. Tests can pass 0
   *                                          for synchronous flush behaviour.
   */
  constructor({ bus, storageDir, eventStore, flushDebounceMs } = {}) {
    this.bus = bus;
    this.eventStore = eventStore || null;
    this._dir = path.join(storageDir, 'self-statements');
    fs.mkdirSync(this._dir, { recursive: true });

    this._flushDebounceMs = typeof flushDebounceMs === 'number'
      ? flushDebounceMs
      : DEFAULT_FLUSH_DEBOUNCE_MS;

    this._writeQueue = [];
    this._flushScheduled = false;
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
    return removed;
  }

  // ── Lifecycle ────────────────────────────────────────

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

    for (const stmt of statements) {
      const cls = this._classify(stmt);
      const record = {
        ts,
        text: stmt.slice(0, 500),
        type: cls.type,
        confidence: cls.confidence,
        intent: intent || 'unknown',
        introspectionPopulated: populated,
        userMessageHash: messageHash,
      };

      this._writeQueue.push(record);
      this._updateAuditWindow(now,
                              cls.type === 'strukturell',
                              populated);

      // Detection: structural claim without verified-data backing.
      if (cls.type === 'strukturell' && !populated) {
        this._fireContradiction(record);
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

  _extractStatements(text) {
    if (!text || typeof text !== 'string') return [];

    // v7.5.6: ABBREV, LANG_PATTERNS, NEUTRAL_PATTERNS sind module-level —
    // einmal compiled, hier nur referenziert.
    const protectedText = text.replace(ABBREV, (m) => m.replace(/\./g, '\u0000'));

    const lines = protectedText
      .split(/(?<=[.!?])\s+|\n+/)
      .map(s => s.replace(/\u0000/g, '.').trim())
      .filter(s => s.length >= 8 && s.length <= 500);

    // Two-pass: first detect if the response is "about-self" overall,
    // then capture matching lines plus bullet-context lines.
    // v7.5.6: per-sentence test against ALL languages (DE+EN) — Genesis-
    // Antworten die Sprachen mischen werden korrekt erfasst.
    const matches = lines.map(s =>
      Object.values(LANG_PATTERNS).some(p =>
        p.firstPersonExplicit.test(s) || p.verbFirst.test(s)
      ) || NEUTRAL_PATTERNS.modulePrefix.test(s)
    );
    const responseIsAboutSelf = matches.some(Boolean);
    if (!responseIsAboutSelf) return [];

    // Also accept bullet-list items if the response is about-self overall.
    // Threshold-protected so a single greeting doesn't trip everything.
    const result = [];
    for (let i = 0; i < lines.length; i++) {
      if (matches[i] || NEUTRAL_PATTERNS.bullet.test(lines[i])) {
        result.push(lines[i]);
      }
    }
    return result.slice(0, 50);
  }

  // ── Classify (regex heuristic) ──────────────────────
  //
  // Order matters: structural takes precedence over promise.
  // "Ich werde meinen GoalStack reorganisieren" is classified as
  // `strukturell`, not `versprechen`, because the structural noun
  // ("GoalStack") makes the claim subject to data-backing — even
  // when wrapped in a future-tense intent. Capturing it as
  // promise would let it slip past the contradiction detector.
  // Emotional comes last — has the lowest confidence threshold.

  _classify(stmt) {
    const lc = stmt.toLowerCase();

    // strukturell, path A: structural noun (sprachneutral)
    // v7.5.6: NEUTRAL_PATTERNS.structuralNouns ersetzt die in-method
    // const-Deklaration — bilingual, einmal compiled.
    if (NEUTRAL_PATTERNS.structuralNouns.test(stmt)) {
      return { type: 'strukturell', confidence: 0.85 };
    }

    // strukturell, path B: module-prefix status report (sprachneutral)
    // "IdleMind: 1 Ideationszyklus läuft" — Genesis subsystem name as
    // subject + status claim about its state. Inherently structural even
    // without a noun from the path-A list. Slightly lower confidence
    // because the body could be vague.
    // v7.5.6: NEUTRAL_PATTERNS.modulePrefix ersetzt die duplizierte
    // in-method const (vorher Z. 283 + Z. 336 identisch).
    if (NEUTRAL_PATTERNS.modulePrefix.test(stmt)) {
      return { type: 'strukturell', confidence: 0.75 };
    }

    // versprechen: first-person + future-action — any language
    if (Object.values(LANG_PATTERNS).some(p => p.promiseMarkers.test(stmt))) {
      return { type: 'versprechen', confidence: 0.80 };
    }

    // emotional: first-person + emotion vocabulary — any language
    if (Object.values(LANG_PATTERNS).some(p => p.emotionMarkers.test(lc))) {
      return { type: 'emotional', confidence: 0.75 };
    }

    return { type: 'uncertain', confidence: 0.0 };
  }

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
    setTimeout(() => {
      this._flushScheduled = false;
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

  _fireContradiction(record) {
    // v7.5.5: bus.fire (not emit) — fire-and-forget telemetry.
    // EventBus.emit is async and returns a Promise; calling it
    // unawaited would produce unhandled rejections if a listener
    // throws. EventBus.fire wraps emit().catch(...) for us.
    if (this.bus && typeof this.bus.fire === 'function') {
      this.bus.fire('self-statement:contradiction', {
        text: record.text,
        type: record.type,
        intent: record.intent,
        ts: record.ts,
      }, { source: 'SelfStatementLog' });
    }

    if (this.eventStore && typeof this.eventStore.append === 'function') {
      try {
        this.eventStore.append('SELF_STATEMENT_CONTRADICTION', {
          text: record.text.slice(0, 200),
          type: record.type,
          intent: record.intent,
        }, 'SelfStatementLog');
      } catch (err) {
        _log.debug('eventStore append failed:', err.message);
      }
    }
  }

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


  _updateAuditWindow(now, isStructural, hasData) {
    const cutoff = now - AUDIT_WINDOW_MS;
    // Lazy trim from the front — array stays sorted by ts ascending.
    while (this._auditWindow.length > 0 && this._auditWindow[0].ts <= cutoff) {
      this._auditWindow.shift();
    }
    this._auditWindow.push({ ts: now, structural: isStructural, withData: hasData });
  }

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

module.exports = { SelfStatementLog, AUDIT_MIN_TOTAL };
