// @ts-checked-v5.7
// ============================================================
// GENESIS — cognitive/SelfStatementClassifier.js (v7.6.1)
//
// Statement-classification mixin extracted from SelfStatementLog.js
// in v7.6.1 Track A. Holds:
//   - language-specific and neutral regex pattern bundles
//   - the 24h audit-window constant
//   - module-load-time DE/EN parity assertion
//   - six methods that operate on `this` of SelfStatementLog:
//       _extractStatements, _classify, _checkActivityClaim,
//       _fireContradiction, _fireActivityHint, _updateAuditWindow
//
// Why split: SelfStatementLog.js was 790 LOC, mixing storage/lifecycle
// (constructor, prune, recall, flush, recordPromise) with statement
// analysis (regex patterns, classification, event emission). The two
// concerns share state via `this`, but the regex compilation and
// classification logic is conceptually a self-contained subsystem.
// Splitting drops the lifecycle file under 700 LOC.
//
// Coupling note: classifierMixin methods read/write `this._writeQueue`,
// `this._auditWindow`, `this.bus`, `this.eventStore`, `this.goalStack`.
// They are mixed into SelfStatementLog.prototype via Object.assign
// (see SelfStatementLog constructor), so `this` inside these methods
// is the SelfStatementLog instance — no architectural decoupling,
// just file-size separation. Tests against SelfStatementLog continue
// to cover all six methods through the public _captureResponse path.
// ============================================================

'use strict';

const { createLogger } = require('../core/Logger');
const _log = createLogger('SELF-STMT-CLS');

// 24-hour rolling window for the contradiction-rate audit.
// Exported so SelfStatementLog.getAuditStat() can use the same value.
const AUDIT_WINDOW_MS = 24 * 60 * 60 * 1000;

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
    // v7.5.7 — Aktivitäts-Marker: 1.-Person-Singular im Präsens-Indikativ,
    // beschreibt was Genesis GERADE TUT (nicht plant, nicht tat). Verben
    // sind eine Untermenge von verbFirst — beschränkt auf Tätigkeits-
    // Verben (kein hab/bin/weiß/kenne/möchte). Optional time-adverb
    // verstärkt das Signal aber ist nicht required.
    //
    // Live-Befund: Genesis sagt häufig "Ich beschäftige mich mit X" oder
    // "Ich analysiere gerade Y" gegen leeren goalStack — eine Activity-
    // Behauptung ohne Backing. Pattern matched diese Form, NICHT
    // Versprechen ("Ich werde X"), NICHT Vergangenheit ("Ich habe X
    // geprüft"). Parität-relevant: muss zu en.activityMarkers passen.
    activityMarkers: /\b(?:ich\s+(?:beschäftige|arbeite|analysiere|prüfe|überprüfe|untersuche|optimiere|erforsche|denke\s+(?:gerade\s+)?nach|bearbeite|verarbeite|verfolge|fokussiere|konzentriere|implementiere|refaktoriere|debugge|profiliere|teste|messe))\b/i,
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
    // v7.5.7 — Activity markers: 1st-person present-progressive describing
    // what Genesis is DOING NOW (not planning, not did). Parallel to
    // de.activityMarkers — must keep parity. EN form: "I'm working on…",
    // "I am analyzing…", "Currently I'm investigating…". Excludes
    // future-marker ("I will…"), past ("I worked on…"), and stative
    // verbs ("I have…", "I know…"). Captures gerund + auxiliary.
    activityMarkers: /\b(?:i'?m\s+(?:working|analyzing|examining|checking|investigating|exploring|reviewing|optimizing|processing|tracking|focusing|implementing|refactoring|debugging|profiling|testing|measuring|currently\s+\w+ing)|i\s+am\s+(?:working|analyzing|examining|checking|investigating|exploring|reviewing|optimizing|processing|tracking|focusing|implementing|refactoring|debugging|profiling|testing|measuring))\b/i,
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
    throw new Error(`SelfStatementClassifier LANG_PATTERNS keys mismatch: de=[${deKeys}], en=[${enKeys}]`);
  }
}

// ──────────────────────────────────────────────────────────────────
// Mixin object — all methods bind to SelfStatementLog instance via
// Object.assign(this, classifierMixin) in the constructor.
// ──────────────────────────────────────────────────────────────────

const classifierMixin = {

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
  },

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
  },

  // ── v7.5.7: Activity-Claim-Detection (separate Dimension) ──
  //
  // Returnt true, wenn die Aussage eine 1.-Person-Singular-Aktivitäts-
  // Behauptung im Präsens-Indikativ ist (z.B. "Ich beschäftige mich mit X",
  // "I'm working on Y"). NICHT: Versprechen ("Ich werde…"), Vergangenheit
  // ("Ich habe geprüft"), Stative ("I know", "Ich weiß").
  //
  // Aufgerufen aus _captureResponse als zweite Dimension neben _classify.
  // Eine Aussage kann strukturell-true UND activity-true sein.
  //
  // Pattern-Quelle: LANG_PATTERNS.{de,en}.activityMarkers — Parität wird
  // von der module-load-time assertion garantiert.

  _checkActivityClaim(stmt) {
    return Object.values(LANG_PATTERNS).some(p => p.activityMarkers.test(stmt));
  },

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
  },

  // ── v7.5.7: Activity-Hint (soft signal, not contradiction) ──
  //
  // Fired when Genesis claims an ongoing activity (1st-person present-
  // progressive, e.g. "Ich beschäftige mich mit X") but goalStack snapshot
  // at chat-completed shows zero active goals. NOT a hard contradiction
  // because:
  //  - User-directed conversation responses ("Ich prüfe das gerade…")
  //    are legitimate filler, not claims about Genesis' background work.
  //  - Race-window between Genesis composing the response and the snapshot
  //    is small but nonzero — a goal could close between speech and check.
  //  - Activity claims are softer than structural claims: they describe
  //    process, not state. Confidence 0.6 reflects this.
  //
  // Event consumers (HealthMonitor, Dashboard, audit tools) can flag
  // patterns over time — not single instances.

  _fireActivityHint(record) {
    if (this.bus && typeof this.bus.fire === 'function') {
      this.bus.fire('self-statement:activity-hint', {
        text: record.text,
        intent: record.intent,
        activeGoalCount: record.activeGoalCount,
        ts: record.ts,
      }, { source: 'SelfStatementLog' });
    }

    if (this.eventStore && typeof this.eventStore.append === 'function') {
      try {
        this.eventStore.append('SELF_STATEMENT_ACTIVITY_HINT', {
          text: record.text.slice(0, 200),
          intent: record.intent,
          activeGoalCount: record.activeGoalCount,
        }, 'SelfStatementLog');
      } catch (err) {
        _log.debug('eventStore append failed:', err.message);
      }
    }
  },

  // ── Audit-Window Update ─────────────────────────────
  //
  // Lazy-trims the rolling 24h window of structural claims (with/without
  // data backing) so getAuditStat() can produce contradiction-rate
  // numbers without scanning the entire write history.

  _updateAuditWindow(now, isStructural, hasData) {
    const cutoff = now - AUDIT_WINDOW_MS;
    // Lazy trim from the front — array stays sorted by ts ascending.
    while (this._auditWindow.length > 0 && this._auditWindow[0].ts <= cutoff) {
      this._auditWindow.shift();
    }
    this._auditWindow.push({ ts: now, structural: isStructural, withData: hasData });
  },

};

module.exports = {
  classifierMixin,
  AUDIT_WINDOW_MS,
  // Re-exported for tests that want to inspect the patterns directly.
  ABBREV,
  LANG_PATTERNS,
  NEUTRAL_PATTERNS,
};
