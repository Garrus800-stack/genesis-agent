// @ts-checked-v5.6
// ============================================================
// GENESIS — IntentRouter.js (v2 — Hybrid: Regex + Fuzzy + LLM)
//
// UPGRADE: Pure regex was brittle. Now: regex (fast) → fuzzy
// keyword matching → LLM classification (when no confident match).
// ============================================================

const { NullBus } = require('../core/EventBus');
const { createLogger } = require('../core/Logger');
const {
  INTENT_DEFINITIONS,
  SLASH_ONLY_INTENTS,
  SECURITY_REQUIRED_SLASH,
  enforceSlashDiscipline: _enforceSlashDiscipline,
} = require('./IntentPatterns');
const _log = createLogger('IntentRouter');

// v7.4.3 Baustein C: INTENT_DEFINITIONS, SLASH_ONLY_INTENTS and the
// _enforceSlashDiscipline guard moved to IntentPatterns.js as a pure
// data module. The function name is kept as a local alias for the
// existing call sites in classifyAsync(). External behaviour unchanged.


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
    // v7.8.1: ToolRegistry — set via late-binding, used to validate
    // explicit tool names mentioned by the user ("benutze file-list").
    this._toolRegistry = null;

    // Online learning: patterns learned from LLM fallback observations
    this._learnedPatterns = new Map(); this._maxLearnedPatterns = 500; // intent -> Set<keyword>
    this._llmFallbackLog = [];         // { message, intent } — for pattern mining
    this._learningThreshold = 5;       // After N LLM fallbacks for same intent, learn

    this._registerDefaults();
  }

  setModel(model) { this.model = model; }

  /**
   * v7.5.9: Late-bind Settings for runtime configuration of
   * `intent.llmClassifyTimeoutMs` (and any future intent.* settings).
   * Optional — without it, defaults apply.
   */
  setSettings(settings) { this.settings = settings; }

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
      return this._withExplicitTool({ type: 'general', confidence: 0.95, match: 'codegen-guard' }, message);
    }

    const regex = this._regexClassify(message);
    if (regex.confidence >= 0.9) return this._withExplicitTool(regex, message);
    const fuzzy = this._fuzzyClassify(message);
    if (fuzzy.confidence >= 0.6) return this._withExplicitTool(fuzzy, message);
    const chosen = regex.confidence > fuzzy.confidence ? regex : fuzzy;
    return this._withExplicitTool(chosen, message);
  }

  /**
   * v7.8.1: Detect when the user explicitly names a tool ("benutze X",
   * "use X"). If the named token matches a registered tool, attach the
   * tool name to the classification result so PromptBuilder can hint
   * the LLM to prefer it. Soft only — Genesis can still deviate with
   * a stated reason. No hard override of autonomy.
   */
  _withExplicitTool(result, message) {
    if (!result || !this._toolRegistry || typeof this._toolRegistry.hasTool !== 'function') return result;
    if (typeof message !== 'string') return result;
    // Patterns: "benutze X", "verwende X", "nutz X", "use X", "run X", "call X"
    // X is a hyphenated lowercase token, optionally quoted/back-ticked.
    const m = message.match(/(?:\b(?:benutze?|verwende?|nutze?|use|run|call)\s+["'`]?([a-z][a-z0-9-]{1,40})["'`]?)/i);
    if (!m) return result;
    let candidate = m[1].toLowerCase();
    // Try exact, then space-to-hyphen normalization variants.
    if (this._toolRegistry.hasTool(candidate)) {
      return { ...result, explicitTool: candidate };
    }
    // "file list" → "file-list" already handled by regex \s+ + single token.
    // For two-token tool names like "git-log" the user might write "git log"
    // — that needs broader matching: scan all registered tool names.
    if (typeof this._toolRegistry.listTools === 'function') {
      const tools = this._toolRegistry.listTools() || [];
      const lower = message.toLowerCase();
      for (const t of tools) {
        const name = (t.name || t || '').toLowerCase();
        if (!name || name.length < 3) continue;
        // Match "use file-list", "benutze git-log" etc. as substring after the verb
        const re = new RegExp(`(?:\\b(?:benutze?|verwende?|nutze?|use|run|call)\\s+["'\`]?${name.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&')}["'\`]?)`, 'i');
        if (re.test(lower)) {
          return { ...result, explicitTool: name };
        }
      }
    }
    return result;
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

  /**
   * v7.3.7: Stage 1 of the Intent Cascade — hard conversational signals.
   * Pure patterns, no LLM. Returns a high-confidence classification if a
   * strong signal matches, or null to fall through to regex/fuzzy/LLM.
   *
   * Rationale: Genesis was escalating conversational questions ("was hat
   * sich geändert?") into multi-step plans with hallucinated file paths.
   * The Cascade intercepts plain conversation before it reaches the
   * action-intent paths.
   *
   * @param {string} message
   * @returns {{type: string, confidence: number, stage: string}|null}
   */
  _conversationalSignalsCheck(message) {
    if (typeof message !== 'string') return null;
    const trimmed = message.trim();
    if (!trimmed) return null;

    // Pure greetings
    if (/^(hi|hallo|moin|hey|servus|guten\s+(morgen|tag|abend))[\s!?.]*$/i.test(trimmed)) {
      return { type: 'general', confidence: 0.95, stage: 'conversational-greeting' };
    }

    // Pure reactions / confirmations
    if (/^(ja|nein|ok|okay|verstehe|danke|genau|stimmt|kein\s+problem|alles\s+klar)[\s!?.]*$/i.test(trimmed)) {
      return { type: 'general', confidence: 0.95, stage: 'conversational-reaction' };
    }

    // v7.7.8: Permission-closing — user grants open-ended permission at
    // the end of a conversation ("mach was du willst :-)" / "sounds good,
    // you can do that"). Not a goal — Genesis decides what to do
    // (idle-mind, journal, reflect). Detected by combination of markers:
    // smileys, optional-permission verbs, open-ended-redirects,
    // acknowledgment-continuations. >=2 markers + length<200 + no
    // action verb = closing. Single markers fall through (e.g. "klingt
    // gut" alone is not enough — could precede a real goal).
    const closingMarkers = [
      // Universal — emoji-as-closing-sigil
      /[:;]-?[)D]/,
      // Open-ended-redirects (DE)
      /\b(etwas\s+ganz\s+anderes|etwas\s+anderes|oder\s+(so|was\s+anderes))\b/i,
      // Open-ended-redirects (EN)
      /\b(something\s+(completely\s+)?different|anything\s+else|or\s+something|or\s+whatever)\b/i,
      // Optional-permission (DE)
      /\b(kannst\s+du\s+machen|magst\s+du|wenn\s+du\s+(willst|magst|lust\s+hast))\b/i,
      // Optional-permission (EN)
      /\b(you\s+(can|could)\s+do\s+that|if\s+you\s+(want|like|feel\s+like)|feel\s+free|go\s+for\s+it)\b/i,
      // Acknowledgment-continuations (DE)
      /\b(das\s+klingt\s+gut|klingt\s+gut|alles\s+gut|passt\s+schon|gerne|in\s+ruhe)\b/i,
      // Acknowledgment-continuations (EN)
      /\b(sounds\s+good|sounds\s+great|that'?s\s+(fine|good|great)|all\s+good|take\s+your\s+time)\b/i,
    ];
    // Action-verb check (extended for v7.7.8 — see hasActionVerb below).
    // Actionable phrasings veto closing-classification even with multiple
    // markers, e.g. "sounds good, refactor X :-)" is a real goal.
    const closingActionVerb = /\b(refactor|integrier|integrate|update|migrier|migrate|weiter\s+(machen|arbeiten)|continue\s+with|keep\s+(going|working))\b/i;
    const closingMatchCount = closingMarkers.filter(p => p.test(trimmed)).length;
    if (closingMatchCount >= 2 && trimmed.length < 200 &&
        !closingActionVerb.test(trimmed) &&
        !/\b(erstell|baue|fix|deploy|starte|führe\s+aus|run\s|execute|compile|push|commit)/i.test(trimmed)) {
      return { type: 'general', confidence: 0.9, stage: 'conversational-permission-closing' };
    }

    // Meta-curiosity about Genesis itself — checked BEFORE question-word
    // because phrases like "was hat sich geändert" start with "was" but
    // are more specifically meta-curiosity.
    if (/\b(was\s+(hat\s+sich|ist\s+neu)|wie\s+(fühlst|geht)|erinnerst\s+du|denkst\s+du|erzähl\s+mir)\b/i.test(trimmed)) {
      return { type: 'general', confidence: 0.9, stage: 'conversational-meta' };
    }

    // v7.4.1: Meta-state questions — specific pings for runtime-state
    // values (emotion, energy, goals, settings, daemon, peers).
    // These are answered from the RuntimeState-Block with actual
    // values rather than escalating into multi-step plans.
    //
    // Confidence 0.9 + separate stage name so telemetry can
    // distinguish generic meta-curiosity from structured state-pings.
    const metaStatePatterns = [
      // German — emotion / mood
      /\b(was\s+ist\s+dein\s+(gefühl|stimmung|zustand|mood))\b/i,
      /\b(welche\s+(emotion|stimmung|energie))\b/i,
      // German — goals / work
      /\b(welche\s+ziele?\s+hast\s+du)\b/i,
      /\b(woran\s+arbeitest\s+du)\b/i,
      // German — settings / model
      /\b(welche\s+settings?)\b/i,
      /\b(welches\s+modell|welcher\s+backend)\b/i,
      // German — daemon / energy / peers
      /\b(was\s+macht\s+dein\s+daemon|läuft\s+dein\s+daemon)\b/i,
      /\b(wie\s+viel\s+energie)\b/i,
      /\b(wie\s+autonom\s+bist\s+du)\b/i,
      /\b(wie\s+viele?\s+peers?)\b/i,
      // English equivalents for cross-language consistency
      /\b(how\s+(do\s+you\s+feel|are\s+you))\b/i,
      /\b(what(?:'s|\s+is)\s+your\s+(mood|energy|feeling|state))\b/i,
      /\b(what\s+are\s+you\s+working\s+on)\b/i,
    ];
    for (const p of metaStatePatterns) {
      if (p.test(trimmed)) {
        return { type: 'general', confidence: 0.9, stage: 'conversational-meta-state' };
      }
    }

    const hasQuestionWord = /^(wie|was|warum|wieso|wer|wann|wo|welche?s?)\s/i.test(trimmed);
    // Action-verb regex: leading \b, but no trailing \b — we want
    // "erstelle", "erstellen", "baue", "baust" to all match via stem.
    const hasActionVerb = /\b(erstell|baue|fix|deploy|starte|führe\s+aus|run\s|execute|compile|push|commit)/i.test(trimmed);
    const endsWithQuestion = /\?$/.test(trimmed);

    if (hasQuestionWord && !hasActionVerb) {
      return { type: 'general', confidence: 0.85, stage: 'conversational-question' };
    }
    if (endsWithQuestion && !hasActionVerb && trimmed.length < 200) {
      return { type: 'general', confidence: 0.8, stage: 'conversational-question-soft' };
    }

    return null;
  }

  /** Async classify — includes local classifier + LLM fallback */
  async classifyAsync(message) {
    // v7.3.7: Stage 1 — Conversational signals (no LLM, very cheap).
    // If matched, skip the entire regex → fuzzy → LLM pipeline.
    const conversational = this._conversationalSignalsCheck(message);
    if (conversational) {
      if (this.bus && typeof this.bus.fire === 'function') {
        this.bus.fire('intent:cascade-decision', {
          stage: conversational.stage,
          verdict: conversational.type,
          signalsMatched: [conversational.stage],
        }, { source: 'IntentRouter' });
      }
      return conversational;
    }

    const fast = this.classify(message);
    // v7.5.9 B1: enforce slash-discipline on fast-path too. Pre-fix the
    // regex/fuzzy fast-path returned directly without enforcement, so any
    // SECURITY_REQUIRED_SLASH intent (execute-code, shell-run, run-skill,
    // ...) could be triggered via free-text imperatives — e.g. "fuehr aus
    // den code" matched /fuehre? aus/i for execute-code with confidence 1.0,
    // bypassing the slash-only policy. Sandbox + Trust still held the line
    // (no RCE path), but the policy was violated. Now enforce on every
    // return that exits classifyAsync.
    if (fast.confidence >= 0.6) return _enforceSlashDiscipline(fast, message);

    // v4.10.0: Try LocalClassifier before LLM fallback (saves 2-3s per message)
    if (this._localClassifier) {
      const local = this._localClassifier.classify(message);
      if (local && local.confidence > fast.confidence) {
        // v7.3.6: Enforce slash-discipline. Rewrites to 'general' if a
        // slash-command intent was returned without an actual '/' in the
        // message. See _enforceSlashDiscipline() for rationale.
        return _enforceSlashDiscipline(local, message);
      }
    }

    if (this.model && this.llmEnabled) {
      const llm = await this._llmClassify(message);
      if (llm && llm.confidence > fast.confidence) {
        // v4.10.0: Feed result to LocalClassifier for training
        if (this._localClassifier) {
          this._localClassifier.addSample(message, llm.type);
        }
        // v7.3.6: Enforce slash-discipline after LLM verdict too.
        return _enforceSlashDiscipline(llm, message);
      }
    }
    // v7.5.9 B1: also enforce on the final fall-through return.
    return _enforceSlashDiscipline(fast, message);
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

    // v7.0.3: Conversation guard — long messages (>200 chars) with incidental keyword
    // matches should NOT be routed to action intents with full confidence.
    // This prevents chat messages about goals from being parsed as goal commands,
    // and technical discussions from triggering shell/colony/undo operations.
    const isLongMessage = message.length > 200;

    for (const route of this.routes) {
      for (const pattern of route.patterns) {
        const match = message.match(pattern);
        if (match) {
          // v7.0.3: Long conversational messages get reduced confidence for action intents.
          // Short direct commands keep confidence 1.0.
          // "goals" and "agent-goal" are most affected since their keywords appear in discussions.
          let confidence = 1.0;
          if (isLongMessage) {
            const matchRatio = match[0].length / message.length;
            // If the match is a small fraction of a long message, it's likely incidental
            if (matchRatio < 0.15) confidence = 0.45; // Below 0.6 threshold → won't auto-route
            else if (matchRatio < 0.3) confidence = 0.7;
          }
          return { type: route.name, confidence, match: match[0] };
        }
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
      // v7.7.9 (post-Phase-3c.4): slash-only intents must not match via
      // fuzzy keywords on free-text. Without this gate, online-learning
      // poisons routes like 'journal' / 'self-reflect' / 'self-recall'
      // with everyday words ('lies', 'datei', 'zeilen', 'weisst', etc.)
      // — and the user can no longer hold a normal conversation that
      // mentions any of those words without hitting the slash-discipline
      // guard. Slash-only intents stay reachable through their explicit
      // regex patterns (e.g. /\/journal\b/), which run in _patternClassify
      // before this method.
      if (SLASH_ONLY_INTENTS.has(route.name) || SECURITY_REQUIRED_SLASH.has(route.name)) continue;
      let hits = 0;
      for (const kw of route.keywords) {
        if (words.includes(kw)) { hits += 1.0; continue; }
        // v7.7.9 (post-Phase-3c.4): bidirectional substring match
        // (`w.includes(kw) || kw.includes(w)`) was too aggressive — any
        // file path or compound word that contained a keyword as a
        // substring triggered. Tightened to exact-word match plus prefix
        // boundary, so 'genesis-journal.txt' no longer matches keyword
        // 'journal'.
        if (kw.length > 3 && words.some(w => w === kw)) { hits += 0.7; continue; }
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

    // v7.7.9 (post-Phase-3c.5): exclude slash-only intents from the LLM
    // classification options. Otherwise the LLM legitimately picks
    // self-reflect / self-modify / self-inspect for free-text messages
    // about reflection or change, the message hits _enforceSlashDiscipline,
    // and the user sees "diese Aktion ist slash-only" instead of an answer.
    // Slash-only intents are reachable only through their explicit `/` patterns
    // in _regexClassify — the LLM doesn't need them as options.
    const intentList = this.routes
      .filter(r => !SLASH_ONLY_INTENTS.has(r.name) && !SECURITY_REQUIRED_SLASH.has(r.name))
      .map(r => r.name)
      .join(', ');
    const prompt = `Classify the following user message into EXACTLY ONE of these categories:
${intentList}, general

IMPORTANT RULES:
- "general" = any question, conversation, reflection, opinion, or CODE GENERATION request (write a function, create a class, etc.)
- "create-skill" = ONLY when user explicitly asks to create a GENESIS SKILL/PLUGIN, not general code
- "execute-code" = ONLY when user provides code to RUN, not to WRITE
- When unsure, prefer "general"

MESSAGE: "${message.slice(0, 500)}"

Respond ONLY with this format:
INTENT: [category]
CONFIDENCE: [0.0-1.0]`;

    try {
      // v7.5.9 ZIP1 Phase 5: per-call timeout cap, default DISABLED.
      //
      // Background: cloud LLMs (qwen3-vl:235b-cloud, gpt-4o, claude-sonnet)
      // routinely take 10-25s for analysis-task and occasionally >30s under
      // load. Earlier defaults (8s, then 30s) caused frequent classification
      // timeouts on cloud setups, which silently broke open-path / source-read
      // routing because the fast-path returned `general` for natural folder
      // requests that needed LLM disambiguation.
      //
      // ModelBridge has its own backend-level timeouts and failover. A second
      // ceiling here was redundant defense-in-depth; the cost was correctness.
      //
      // Default is now 0 (disabled). Settings.intent.llmClassifyTimeoutMs
      // overrides; any positive number enables the race. Setting to 0
      // explicitly also disables. ModelBridge failover still applies
      // regardless.
      const _settings = this.settings || null;
      const _configured = _settings?.get?.('intent.llmClassifyTimeoutMs');
      const _LLM_CLASSIFY_TIMEOUT_MS = (typeof _configured === 'number' && _configured >= 0)
        ? _configured
        : 0;
      let response;
      if (_LLM_CLASSIFY_TIMEOUT_MS === 0) {
        // Timeout disabled — direct await, ModelBridge failover still applies.
        response = await this.model.chat(prompt, [], 'analysis');
      } else {
        const _timeoutPromise = new Promise((_, reject) =>
          setTimeout(() => reject(new Error('LLM_CLASSIFY_TIMEOUT')), _LLM_CLASSIFY_TIMEOUT_MS)
        );
        response = await Promise.race([
          this.model.chat(prompt, [], 'analysis'),
          _timeoutPromise,
        ]);
      }
      const im = response.match(/INTENT:\s*(\S+)/i);
      const cm = response.match(/CONFIDENCE:\s*([\d.]+)/i);
      if (im) {
        const name = im[1].toLowerCase().replace(/[^a-z0-9-]/g, '');
        const valid = this.routes.some(r => r.name === name) || name === 'general';
        if (valid) {
          const result = { type: name, confidence: (cm ? Math.min(1.0, parseFloat(cm[1])) : 0.6) * 0.9, match: `llm:${name}` };
          this.llmCache.set(cacheKey, result);
          if (this.llmCache.size > this.cacheMaxSize) this.llmCache.delete(this.llmCache.keys().next().value);
          this.bus.fire('intent:llm-classified', { message: message.slice(0, 80), intent: name }, { source: 'IntentRouter' });
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
   *
   * v7.7.9 (post-Phase-3c.4): slash-only intents are excluded from
   * keyword learning. They are reachable only through explicit slash
   * patterns; growing their fuzzy keyword list with everyday words
   * ('lies', 'datei', 'zeilen', 'weisst', etc.) makes normal
   * conversation impossible — every sentence containing those words
   * would then trigger the slash-discipline guard.
   */
  _learnFromLLMResult(message, intent) {
    if (SLASH_ONLY_INTENTS.has(intent) || SECURITY_REQUIRED_SLASH.has(intent)) return;
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
        // v7.0.5: Enforce cap — prevents unbounded growth in long-running sessions
        this._trimLearnedPatterns();

        _log.info(`[INTENT] Online-Learning: +${added} keywords for "${intent}": ${newKeywords.join(', ')}`);
        this.bus.fire('intent:learned', {
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
      // v7.7.9 (post-Phase-3c.4): slash-only intents do not import
      // learned keywords. If a previous session poisoned the on-disk
      // patterns file with everyday words, those are dropped on load.
      if (SLASH_ONLY_INTENTS.has(intent) || SECURITY_REQUIRED_SLASH.has(intent)) continue;
      const route = this.routes.find(r => r.name === intent);
      if (route && Array.isArray(keywords)) {
        const existingKw = new Set(route.keywords);
        for (const kw of keywords) {
          if (!existingKw.has(kw)) route.keywords.push(kw);
        }
        this._learnedPatterns.set(intent, new Set(keywords));
      }
    }
    // v7.0.5: Enforce cap after bulk import
    this._trimLearnedPatterns();
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
