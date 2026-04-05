// @ts-checked-v5.6
// ============================================================
// GENESIS — IntentRouter.js (v2 — Hybrid: Regex + Fuzzy + LLM)
//
// UPGRADE: Pure regex was brittle. Now: regex (fast) → fuzzy
// keyword matching → LLM classification (when no confident match).
// ============================================================

const { NullBus } = require('../core/EventBus');
const { createLogger } = require('../core/Logger');
const _log = createLogger('IntentRouter');

// FIX v5.1.0 (N-5): Declarative intent definitions.
// Previously 157 lines of imperative register() calls (CC=124).
// Now a data table iterated by _registerDefaults() — CC≈3, same behavior.
// Each entry: [name, patterns, priority, keywords]
/** @type {Array<[string, RegExp[], number, string[]]>} */
const INTENT_DEFINITIONS = [
  ['self-inspect', [
    /zeig.*dein.*(code|quell|struktur|module)/i, /woraus bestehst/i,
    /architektur/i, /self.?model/i,
    /was kannst du/i, /stell dich vor/i,
    /was bist du/i, /wer bist du/i, /beschreib dich/i,
    /erza.*(?:von|ueber) dir/i,
    /(?:liste|zeig|nenn).*(?:deine? )?(?:module|skills?|tools?|faehigkeit)/i,
    /what (?:can you|are you)/i, /tell me about yourself/i, /describe yourself/i,
    /(?:show|list|display).*(?:modules?|capabilities|skills?|tools?)/i,
  ], 20, ['struktur', 'aufbau', 'module', 'quellcode', 'architektur', 'bestehen']],

  // Self-reflect: QUESTIONS about what Genesis would improve/change/need
  // Must be ABOVE self-modify to catch questions before they match imperative patterns
  ['self-reflect', [
    /was (?:wuerdest|würdest|solltest|koenntest|könntest) du.*(verbess|optimier|aender|anders|hinzufueg|hinzufüg)/i,
    /was (?:fehlt|brauchst|benoetigst|benötigst) (?:dir|du)/i,
    /was (?:wuerdest|würdest) du.*(machen|tun|ändern)/i,
    /(?:was|welche).*(?:schwaeche|schwäche|luecke|lücke|mangel|problem)/i,
    /(?:beurteile|bewerte|analysiere|reflektiere).*(?:dich|deinen? code)/i,
    /(?:hast du|gibt es).*(?:ideen?|vorschlae?ge?|vorschläge)/i,
    /(?:where|what).*(?:improve|missing|lacking|weakness|optimize|add)/i,
    /what would you.*(change|improve|add|do different)/i,
    /(?:siehst du|findest du).*(?:verbess|optimier|problem|schwach)/i,
  ], 22, ['verbessern', 'optimieren', 'fehlen', 'brauchen', 'schwaeche', 'mangel', 'hinzufuegen', 'bewerten', 'beurteilen', 'reflektieren']],

  ['self-modify', [
    // IMPERATIVES only: "optimier dich", "verbessere X", "ändere Y"
    /(?:aender|modifiz|verbess|optimier).*(?:dich|dein|deinen?)\b/i,
    /(?:aender|modifiz|verbess|optimier)\s+(?:das|die|den|dein)/i,
    /(?:improve|change|modify|upgrade|refactor)\s+(?:your|the|this)/i,
  ], 20, ['aendern', 'modifizieren', 'upgrade', 'refactor']],

  ['self-repair', [
    /repari/i, /fix.*dich/i, /diagnos/i, /fehler.*beheb/i,
  ], 20, ['reparieren', 'fixen', 'diagnose', 'fehler', 'beheben', 'kaputt', 'broken']],

  // Circuit breaker reset — must be above create-skill
  ['self-repair-reset', [
    /self-repair-reset/i, /circuit.*reset/i, /unfreeze/i, /selfmod.*reset/i,
    /self.*mod.*wieder/i, /entsperr.*modif/i,
  ], 25, ['reset', 'unfreeze', 'circuit', 'entsperren', 'selfmod']],

  ['create-skill', [
    /skill.*erstell/i, /erstell.*skill/i, /neuen? skill/i, /create.*skill/i, /build.*skill/i,
    /(?:neue|add|hinzufueg).*(?:faehigkeit|capability|erweiterung|plugin)/i,
  ], 15, ['skill', 'faehigkeit', 'plugin', 'erweiterung']],

  ['clone', [
    /klon/i, /clone/i, /replizi/i, /neuen.*agent/i,
  ], 15, ['klon', 'klonen', 'clone', 'kopie', 'replizieren']],

  ['analyze-code', [
    /analys.*code/i, /code.*review/i, /pruef.*code/i,
  ], 12, ['analyse', 'analysieren', 'review', 'pruefen', 'bewerten']],

  // v5.9.1: Run/execute/use an installed skill — must be ABOVE execute-code
  ['run-skill', [
    /(?:run|execute|use|start|starte?|fuehr).*skill/i,
    /skill.*(?:run|execute|use|starten?|ausfuehr)/i,
    /(?:nutze?|verwende?).*skill/i,
    /(?:run|execute|use)\s+(?:the\s+)?[\w-]+-skill\b/i,
    // v5.9.1: Match "run <name>" where name is a single hyphenated word (no flags/paths)
    /^(?:run|execute|use)\s+(?:the\s+)?[a-z][\w-]+$/i,
  ], 16, ['skill', 'ausfuehren', 'nutzen', 'verwenden', 'starten']],

  ['execute-code', [
    /^```/, /fuehre? aus/i, /execute.*code/i,
  ], 12, ['ausfuehren', 'execute', 'run']],

  ['execute-file', [
    /fuehr.*datei/i, /execute.*file/i, /starte? .*\.\w{2,4}\b/i,
  ], 12, ['datei', 'starten', 'script']],

  ['peer', [
    /peer/i, /andere.*agent/i, /netzwerk/i,
    /peer.*(?:scan|such|discover|trust|vertrau|import|compare|vergleich|skill)/i,
    /(?:trust|vertrau).*peer/i,
    /(?:importiere?|hole?).*skill.*(?:von|from)/i,
    /(?:compare|vergleich).*(?:mit|with).*peer/i,
  ], 14, ['peer', 'netzwerk', 'verbinden', 'trust', 'vertrauen', 'import', 'importieren',
           'scan', 'suchen', 'entdecken', 'compare', 'vergleichen', 'skill', 'agent']],

  ['daemon', [
    /daemon/i, /hintergrund/i, /autonom/i,
  ], 10, ['daemon', 'hintergrund', 'autonom']],

  ['trust-control', [
    /trust.?level/i, /vertrauens?.?stufe/i,
    /(?:set|change|ändere?|setze?).*trust/i,
    /(?:autonomie|autonomy).*(?:freigeb|enabl|erlaub|gewähr|grant)/i,
    /(?:freigabe|genehmig).*(?:selbst|self|autonom)/i,
    /trust.*(?:assisted|autonomous|full|sandbox)/i,
  ], 12, ['trust', 'vertrauen', 'stufe', 'level', 'autonomie', 'freigabe', 'genehmigung']],

  ['open-path', [
    /(?:oeffne|öffne|open)\s+(?:den\s+)?(?:ordner|folder|verzeichnis|dir|pfad|path|datei|file)\s*/i,
    /(?:oeffne|öffne|open)\s+["']?[A-Za-z]:\\/i,
    /(?:oeffne|öffne|open)\s+["']?[~/]\S+/i,
    /(?:zeig|show)\s+(?:mir\s+)?(?:den\s+)?(?:ordner|folder|inhalt|content)/i,
  ], 15, ['öffnen', 'oeffnen', 'ordner', 'folder', 'verzeichnis', 'datei', 'pfad', 'explorer']],

  ['mcp', [
    /\bmcp\b/i, /mcp.?server/i, /mcp.?status/i, /mcp.?tool/i,
    /mcp.*(?:connect|verbind|hinzufueg|add)/i,
    /mcp.*(?:disconnect|trenn|entfern|remove)/i,
    /mcp.*(?:reconnect|neu.*verbind)/i,
    /mcp.*(?:serve|bereitstell|anbieten)/i,
    /genesis.*(?:als|as).*server/i,
    /externe?.*tools?.*(?:verbind|connect)/i,
    /tool.?server.*(?:verbind|connect|add)/i,
  ], 14, ['mcp', 'server', 'tool', 'connect', 'verbinden', 'extern', 'protocol']],

  ['journal', [
    /journal/i, /tagebuch/i, /gedanken/i, /was hast du gedacht/i,
  ], 10, ['journal', 'tagebuch', 'gedanken', 'notizen']],

  ['plans', [
    /vorhaben/i, /was willst du/i, /ideen/i,
  ], 10, ['vorhaben', 'plan', 'ideen']],

  ['goals', [
    /ziel/i, /goal/i, /setze.*ziel/i, /was arbeitest du/i, /woran arbeitest/i, /fortschritt/i,
  ], 12, ['ziel', 'goal', 'fortschritt', 'aufgabe']],

  ['settings', [
    /einstellung/i, /settings/i, /api.?key/i, /konfigur/i, /config/i,
  ], 12, ['einstellung', 'settings', 'konfiguration', 'api', 'key']],

  ['web-lookup', [
    /(?:schau|such|pruef|check).*(?:web|online|internet|npm|doku|docs)/i,
    /(?:look|search|check|fetch).*(?:web|online|npm|docs)/i,
    /(?:ist|does).*(?:erreichbar|reachable|online)/i,
    /npm.*(?:paket|package|suche|search)/i,
  ], 12, ['web', 'online', 'suchen', 'npm', 'dokumentation']],

  ['undo', [
    /rueckg/i, /undo/i, /rollback/i, /revert/i, /letzte.*aenderung.*rueck/i,
  ], 15, ['rueckgaengig', 'undo', 'rollback', 'zurueck', 'revert', 'wiederherstellen']],

  // Shell task (multi-step planned execution)
  ['shell-task', [
    /^(?:npm|node|git|yarn|pnpm|pip|cargo|make)\s+/i,
    /install(?:iere?)?\s+(?:die\s+)?(?:deps|dependencies|abhaengigkeiten|pakete?)/i,
    /(?:fuehr|start|lauf).*(?:test|build|lint|script)/i,
    /erstell.*(?:projekt|ordner|verzeichnis|datei)/i,
    /(?:init|setup|scaffold|bootstrap).*(?:projekt|app)/i,
    /(?:richte|setz).*(?:ein|auf)\b/i,
    /(?:richte|setup|einrichten|installiere|baue|build|deploy|teste?)\s+(?:das|dieses|das\s+)?\s*(?:projekt|repo|repository|app|anwendung)/i,
    /(?:fuehr|starte?|run)\s+(?:die\s+)?tests?\s+(?:aus|durch)/i,
    /pip\s+install/i,
    /cargo\s+(?:build|test|run)/i,
    /docker\s+(?:build|compose|run)/i,
  ], 14, ['installieren', 'npm', 'git', 'node', 'projekt', 'erstellen', 'setup',
           'build', 'test', 'deploy', 'starten', 'terminal', 'befehle', 'ausfuehren',
           'einrichten', 'bauen', 'testen', 'pip', 'cargo']],

  // Shell run (single command execution)
  ['shell-run', [
    /^[$>]\s*.+/,
    /(?:fuehr|execute|run)\s+(?:den\s+)?(?:befehl|kommando|command)/i,
    /^(?:git|node|python|pip|npx|yarn|pnpm|cargo|go|dotnet|java|javac)\s+\w+/i,
    /^(?:ls|dir|cat|type|find|grep|wc|head|tail|echo|pwd|cd|mkdir)\b/i,
    /\|\s*(?:grep|wc|head|tail|sort|uniq|awk|sed)\b/i,
  ], 13, ['ausfuehren', 'befehl', 'kommando', 'command', 'terminal', 'shell', 'konsole']],

  // Project scan
  ['project-scan', [
    /(?:was ist das|was fuer ein|scann?e?|analysiere?)\s+(?:fuer\s+ein\s+)?(?:projekt|repo|verzeichnis|ordner)/i,
    /(?:show|zeig).*(?:projekt|project).*(info|typ|type|struktur)/i,
    /(?:oeffne|open)\s+(?:das\s+)?(?:projekt|workspace|arbeitsbereich)/i,
  ], 13, ['projekt', 'scannen', 'analysieren', 'verzeichnis', 'workspace', 'repository']],

  // v5.9.1: Retry — catches "yes"/"ja"/"nochmal"/"try again" after failed operations
  ['retry', [
    /^(?:yes|ja|yep|yeah|ok|okay|sure|klar|mach|nochmal|try again|retry|erneut)[\s!.]*$/i,
  ], 25, ['yes', 'ja', 'nochmal', 'retry', 'erneut']],

  ['greeting', [
    /^(hi|hallo|hey|moin|servus|guten (morgen|tag|abend)|hello|good (morning|evening)|bonjour|buenas?)\s*[!.]?$/i,
  ], 5, ['hallo', 'hello', 'hi', 'moin', 'servus']],
];

class IntentRouter {
  /** @param {{ bus?: * }} [config] */
  constructor({ bus } = {}) {
    this.bus = bus || NullBus;
    this.routes = [];
    this.model = null;
    this.llmEnabled = true;
    this.llmCache = new Map();
    this.cacheMaxSize = 100;

    // v4.10.0: LocalClassifier — set via late-binding
    this._localClassifier = null;

    // Online learning: patterns learned from LLM fallback observations
    this._learnedPatterns = new Map(); this._maxLearnedPatterns = 500; // intent -> Set<keyword>
    this._llmFallbackLog = [];         // { message, intent } — for pattern mining
    this._learningThreshold = 5;       // After N LLM fallbacks for same intent, learn

    this._registerDefaults();
  }

  setModel(model) { this.model = model; }

  register(name, patterns, priority = 10, keywords = []) {
    this.routes.push({ name, patterns, priority, keywords });
    this.routes.sort((a, b) => b.priority - a.priority);
  }

  /** Synchronous classify — regex + fuzzy only */
  classify(message) {
    // v6.0.5: Code-generation guard — common coding requests should NEVER be
    // routed to create-skill. "Write a function" ≠ "Create a Genesis skill".
    // Without this, LLM classifiers misroute coding tasks to the skill builder.
    if (this._isCodeGenRequest(message)) {
      return { type: 'general', confidence: 0.95, match: 'codegen-guard' };
    }

    const regex = this._regexClassify(message);
    if (regex.confidence >= 0.9) return regex;
    const fuzzy = this._fuzzyClassify(message);
    if (fuzzy.confidence >= 0.6) return fuzzy;
    return regex.confidence > fuzzy.confidence ? regex : fuzzy;
  }

  /**
   * v6.0.5: Detect common code generation requests that should be treated
   * as general chat, NOT as skill creation or self-modification.
   * @param {string} message
   * @returns {boolean}
   */
  _isCodeGenRequest(message) {
    // Only trigger if the message does NOT mention "skill" explicitly
    if (/\bskill\b/i.test(message)) return false;

    return /\b(?:write|create|generate|build|implement|code|make)\b.*\b(?:function|class|component|module|script|program|api|endpoint|server|handler|middleware|route|hook|test|util)\b/i.test(message)
        || /\b(?:schreib|erstell|bau|implementier|generier|programmier)\b.*\b(?:funktion|klasse|komponente|modul|script|programm|server|handler|test)\b/i.test(message);
  }

  /** Async classify — includes local classifier + LLM fallback */
  async classifyAsync(message) {
    const fast = this.classify(message);
    if (fast.confidence >= 0.6) return fast;

    // v4.10.0: Try LocalClassifier before LLM fallback (saves 2-3s per message)
    if (this._localClassifier) {
      const local = this._localClassifier.classify(message);
      if (local && local.confidence > fast.confidence) {
        return local;
      }
    }

    if (this.model && this.llmEnabled) {
      const llm = await this._llmClassify(message);
      if (llm && llm.confidence > fast.confidence) {
        // v4.10.0: Feed result to LocalClassifier for training
        if (this._localClassifier) {
          this._localClassifier.addSample(message, llm.type);
        }
        return llm;
      }
    }
    return fast;
  }

  listIntents() {
    return this.routes.map(r => ({
      name: r.name, priority: r.priority,
      patternCount: r.patterns.length, keywordCount: r.keywords.length,
    }));
  }

  // ── Phase 1: Regex ────────────────────────────────────────

  _regexClassify(message) {
    // v6.0.5: Code-generation guard — "Write a function/class/component" is CHAT,
    // not create-skill. Without this, the LLM fallback misclassifies code requests
    // as skill creation, which creates empty skill files instead of generating code.
    if (/^(?:write|create|build|implement|make|generate|code)\s+(?:a|an|me|the)\s+(?:\w+\s+)*(?:function|class|component|module|script|program|endpoint|route|handler|api|server|app|algorithm|method)/i.test(message)) {
      return { type: 'general', confidence: 0.95, match: 'code-gen-request' };
    }
    // German equivalent
    if (/^(?:schreib|erstell|bau|implementier|generier|programmier)\s+(?:eine?n?|mir|die|das)\s+(?:\w+\s+)*(?:funktion|klasse|komponente|modul|skript|programm|endpunkt|route|handler|api|server|app|algorithmus|methode)/i.test(message)) {
      return { type: 'general', confidence: 0.95, match: 'code-gen-request-de' };
    }

    // v6.0.4: Visual/diagram guard — "Zeig mir ein Diagramm deiner Architektur"
    // should go to LLM (general) not to self-inspect (which returns text-only report).
    // Without this, users have to ask twice: first gets text report, second gets diagram.
    if (/(?:diagramm|skizze|zeichn|bild|visualisier|graph|chart|draw|diagram|sketch|illustr)/i.test(message)) {
      return { type: 'general', confidence: 0.90, match: 'visual-request' };
    }

    for (const route of this.routes) {
      for (const pattern of route.patterns) {
        const match = message.match(pattern);
        if (match) return { type: route.name, confidence: 1.0, match: match[0] };
      }
    }
    return { type: 'general', confidence: 0.3, match: null };
  }

  // ── Phase 2: Fuzzy Keywords ───────────────────────────────

  _fuzzyClassify(message) {
    const words = this._normalizeWords(message);
    let bestRoute = null, bestScore = 0;

    for (const route of this.routes) {
      if (route.keywords.length === 0) continue;
      let hits = 0;
      for (const kw of route.keywords) {
        if (words.includes(kw)) { hits += 1.0; continue; }
        if (words.some(w => w.includes(kw) || kw.includes(w))) { hits += 0.7; continue; }
        if (kw.length > 4 && words.some(w => this._isSimilar(w, kw))) { hits += 0.5; }
      }
      const score = (hits / route.keywords.length) * (route.priority / 20);
      if (score > bestScore) { bestScore = score; bestRoute = route; }
    }

    if (bestRoute && bestScore >= 0.3) {
      return { type: bestRoute.name, confidence: Math.min(0.85, 0.4 + bestScore), match: `fuzzy:${bestRoute.name}` };
    }
    return { type: 'general', confidence: 0.2, match: null };
  }

  // ── Phase 3: LLM Fallback ────────────────────────────────

  async _llmClassify(message) {
    const cacheKey = message.toLowerCase().trim().slice(0, 200);
    if (this.llmCache.has(cacheKey)) return this.llmCache.get(cacheKey);

    const intentList = this.routes.map(r => r.name).join(', ');
    const prompt = `Classify the following user message into EXACTLY ONE of these categories:
${intentList}, general

IMPORTANT RULES:
- "general" = any question, explanation, or CODE GENERATION request (write a function, create a class, etc.)
- "create-skill" = ONLY when user explicitly asks to create a GENESIS SKILL/PLUGIN, not general code
- "self-modify" = ONLY when user asks Genesis to modify ITS OWN code
- "execute-code" = ONLY when user provides code to RUN, not to WRITE

MESSAGE: "${message.slice(0, 500)}"

Respond ONLY with this format:
INTENT: [category]
CONFIDENCE: [0.0-1.0]`;

    try {
      const response = await this.model.chat(prompt, [], 'analysis');
      const im = response.match(/INTENT:\s*(\S+)/i);
      const cm = response.match(/CONFIDENCE:\s*([\d.]+)/i);
      if (im) {
        const name = im[1].toLowerCase().replace(/[^a-z0-9-]/g, '');
        const valid = this.routes.some(r => r.name === name) || name === 'general';
        if (valid) {
          const result = { type: name, confidence: (cm ? Math.min(1.0, parseFloat(cm[1])) : 0.6) * 0.9, match: `llm:${name}` };
          this.llmCache.set(cacheKey, result);
          if (this.llmCache.size > this.cacheMaxSize) this.llmCache.delete(this.llmCache.keys().next().value);
          this.bus.emit('intent:llm-classified', { message: message.slice(0, 80), intent: name }, { source: 'IntentRouter' });
          // Feed online learning pipeline
          this._learnFromLLMResult(message, name);
          return result;
        }
      }
    } catch (err) { _log.warn('[INTENT] LLM classify failed:', err.message); }
    return null;
  }

  // ── Online Learning ────────────────────────────────────────

  /**
   * Learn from LLM classification results. After N messages for the
   * same intent, extract common keywords and add them to the route's
   * fuzzy keywords — so next time, regex/fuzzy can handle it without LLM.
   */
  _learnFromLLMResult(message, intent) {
    this._llmFallbackLog.push({ message, intent, ts: Date.now() });
    if (this._llmFallbackLog.length > 200) this._llmFallbackLog = this._llmFallbackLog.slice(-100);

    // Group by intent
    const intentMessages = this._llmFallbackLog.filter(f => f.intent === intent);
    if (intentMessages.length < this._learningThreshold) return;
    if (intentMessages.length % this._learningThreshold !== 0) return;

    // Extract common words across messages for this intent
    const wordCounts = new Map();
    for (const { message: msg } of intentMessages) {
      const words = this._normalizeWords(msg);
      const unique = new Set(words);
      for (const w of unique) {
        if (w.length < 3) continue;
        wordCounts.set(w, (wordCounts.get(w) || 0) + 1);
      }
    }

    // Words appearing in >40% of messages are good keyword candidates
    const threshold = intentMessages.length * 0.4;
    const newKeywords = [];
    for (const [word, count] of wordCounts) {
      if (count >= threshold) newKeywords.push(word);
    }

    if (newKeywords.length === 0) return;

    // Add to the route's keywords (if route exists)
    const route = this.routes.find(r => r.name === intent);
    if (route) {
      const existingKw = new Set(route.keywords);
      let added = 0;
      for (const kw of newKeywords) {
        if (!existingKw.has(kw)) {
          route.keywords.push(kw);
          added++;
        }
      }
      if (added > 0) {
        if (!this._learnedPatterns.has(intent)) this._learnedPatterns.set(intent, new Set());
        for (const kw of newKeywords) this._learnedPatterns.get(intent).add(kw);

        _log.info(`[INTENT] Online-Learning: +${added} keywords for "${intent}": ${newKeywords.join(', ')}`);
        this.bus.emit('intent:learned', {
          intent, newKeywords, total: route.keywords.length,
        }, { source: 'IntentRouter' });
      }
    }
  }

  /** Get what the router has learned (for persistence/debugging) */
  getLearnedPatterns() {
    const result = {};
    for (const [intent, keywords] of this._learnedPatterns) {
      result[intent] = [...keywords];
    }
    return result;
  }

  /** Import previously learned patterns (from disk) */
  importLearnedPatterns(data) {
    if (!data || typeof data !== 'object') return;
    for (const [intent, keywords] of Object.entries(data)) {
      const route = this.routes.find(r => r.name === intent);
      if (route && Array.isArray(keywords)) {
        const existingKw = new Set(route.keywords);
        for (const kw of keywords) {
          if (!existingKw.has(kw)) route.keywords.push(kw);
        }
        this._learnedPatterns.set(intent, new Set(keywords));
      }
    }
  }

  // ── Helpers ───────────────────────────────────────────────

  _normalizeWords(text) {
    return text.toLowerCase().replace(/[^a-zäöüß0-9\s-]/g, '').split(/\s+/).filter(w => w.length > 1);
  }

  _isSimilar(a, b) {
    if (Math.abs(a.length - b.length) > 2) return false;
    let diff = 0;
    for (let i = 0; i < Math.max(a.length, b.length); i++) {
      if (a[i] !== b[i]) diff++;
      if (diff > 2) return false;
    }
    return true;
  }

  // ── Default Routes ────────────────────────────────────────

  _registerDefaults() {
    for (const [name, patterns, priority, keywords] of INTENT_DEFINITIONS) {
      this.register(name, patterns, priority, keywords);
    }
  }

  /** DA-1: Evict oldest entries when _learnedPatterns exceeds cap */
  _trimLearnedPatterns() {
    if (this._learnedPatterns.size <= this._maxLearnedPatterns) return;
    const sorted = [...this._learnedPatterns.entries()].sort((a, b) => (a[1].count || 0) - (b[1].count || 0));
    while (this._learnedPatterns.size > this._maxLearnedPatterns && sorted.length > 0) {
      const entry = sorted.shift();
      if (entry) this._learnedPatterns.delete(entry[0]);
    }
  }
}

module.exports = { IntentRouter };
