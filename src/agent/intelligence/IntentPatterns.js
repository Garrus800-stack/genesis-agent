// ============================================================
// GENESIS — IntentPatterns.js (v7.4.3 "Aufräumen II")
//
// Pure data module — extracted from IntentRouter.js as part of
// the v7.4.3 cleanup pass. Holds:
//
//   - INTENT_DEFINITIONS   : the declarative regex/keyword/priority
//                            table (~230 LOC of patterns)
//   - SLASH_ONLY_INTENTS   : the set used by _enforceSlashDiscipline
//   - enforceSlashDiscipline: the post-classification guard
//
// Why a data module rather than a prototype-delegation mixin:
// these are values and one pure function, no `this`, no instance
// state. A mixin would add ceremony without benefit. Same shape
// as Constants.js — import what you need.
//
// Strategic note: the IntentRouter / BeliefStore boundary in v7.6+
// will need to detect user corrections (Genesis said X, user
// disagrees) as evidence input. Having the patterns isolated here
// makes that detection a sibling concern rather than an addition
// to a 700-LOC file.
// ============================================================

'use strict';

const { allCommandNames } = require('./slash-commands');

// v7.3.6 — post-classification guard. The 13 slash-commands registered in
// slash-commands.js must NEVER be returned from classifyAsync() unless the
// user's message contains an actual '/'. The sync regex patterns in
// INTENT_DEFINITIONS already enforce this, but classifyAsync() has two
// bypass paths that don't:
//
//   1. LocalClassifier — learns from LLM-labeled samples. If the LLM ever
//      labeled "zeig mir deine settings" as 'settings' (it would, semantically),
//      LocalClassifier learns that and then returns settings on future
//      matches — without any slash in the message.
//
//   2. LLM fallback — directly returns the LLM's verdict. The LLM classifies
//      by meaning ("user wants settings → settings"), not by the slash rule.
//
// The guard below intercepts any slash-command verdict from either path and
// rewrites it to 'general' if there is no '/' anywhere in the message. That
// gives us a single chokepoint that can't be bypassed by prompt tweaks,
// model changes, or learned false-positives.
const SLASH_ONLY_INTENTS = new Set(allCommandNames());

// v7.7.9 Phase 2: Slash-commands that are *harmless* — they only read
// state (proactive-status) or set a user-visible mute (quiet). When the
// LLM/Local-classifier mis-classifies normal chat as one of these, the
// correct response is NOT a "this is slash-only" hint — that hint shows
// up confusingly on conversational text (e.g. "na, läuft alles?"). For
// these specific commands, on free-text mis-classification, we silently
// fall through to 'general' so the LLM responds normally. The slash
// pattern itself still works — typing /proactive-status still hits the
// command. We only suppress the slash-hint for the false-positive path.
//
// Rule for adding to this set: the command must be PURELY informational
// or user-controlled (no security impact, no irreversible action). If
// in doubt, leave it OUT — the slash-hint is the safer default.
const SAFE_SLASH_FALLTHROUGH = new Set([
  'quiet',
  'proactive-status',
]);

// v7.5.1 (H-fix): Security-relevant intents that — though not registered as
// canonical slash-commands — must REQUIRE an explicit slash trigger to fire.
// Before v7.5.1 their classifier patterns could match conversational free
// text ("lass uns das Database-Skill nutzen" → run-skill, "was ist mit
// trust level?" → trust-control), giving the LLM a path to invoke them
// from a benign exchange. This set forces enforceSlashDiscipline to
// rewrite the result to 'general' unless the message contains a `/`.
//
// To keep them reachable, every entry in this set must also have at least
// one slash-anchored pattern below (e.g. /(?:^|\s)\/run-skill\b/i).
const SECURITY_REQUIRED_SLASH = new Set([
  'run-skill',
  'execute-code',
  'execute-file',
  'trust-control',
  'shell-task',
  'shell-run',
  'memory-list',
  'memory-veto',
  'memory-mark',
  'self-recall',  // v7.5.5
  'install-software',  // v7.5.9 ZIP3 Phase 4a — fuzzy + slash; injection-relevant
  'open-software',     // v7.5.9 ZIP8 — fuzzy + slash; could be tricked into launching unintended binaries
  'cleanup-check',     // v7.8.4 — pre-deletion audit, slash-only by convention
]);

function enforceSlashDiscipline(result, message) {
  if (!result) return result;
  const isSlashOnly = SLASH_ONLY_INTENTS.has(result.type) || SECURITY_REQUIRED_SLASH.has(result.type);
  if (!isSlashOnly) return result;
  // v7.5.8: A literal `/` anywhere in the message is too permissive — a
  // 6-point reflection list that happened to contain a date "03/05" or a
  // markdown link slipped past, the LLM-classifier returned 'self-modify',
  // and an 18-item code-improvement plan was generated from a personal
  // values discussion. Fix: require the `/` to be in actual slash-command
  // position (start-of-message or after whitespace, followed by a word).
  // The per-intent patterns then decide WHICH slash-command was meant;
  // this guard only decides whether ANY slash-command is allowed at all.
  if (typeof message === 'string' && /(?:^|\s)\/[a-z][\w-]*\b/i.test(message)) return result;
  // v7.5.9 B1: narrow exception for execute-code — a message starting with
  // a fenced code block (```...```) is a documented alternate trigger
  // (user pasted runnable code, explicit content). This is intentionally
  // NOT extended to free-text imperatives like "fuehr aus den code"
  // (those still rewrite to general). Sandbox + Trust still hold the
  // line on actual execution.
  if (result.type === 'execute-code' && typeof message === 'string' && /^```/.test(message)) {
    return result;
  }
  // v7.7.9 Phase 2: SAFE_SLASH_FALLTHROUGH — for harmless commands
  // (quiet, proactive-status) the slash-hint is more confusing than
  // helpful when it fires on a false-positive ("na, läuft alles?" was
  // hitting "proactive-status"). Silently fall through to general so
  // the LLM answers normally; the slash pattern still routes correct
  // calls to the actual handler.
  if (SAFE_SLASH_FALLTHROUGH.has(result.type)) {
    return {
      type: 'general',
      confidence: 0.3,
      match: 'safe-slash-fallthrough',
    };
  }
  // v7.5.9 ZIP7: Mark the result with metadata so ChatOrchestrator can
  // route to the slash-hint handler instead of falling through to the
  // LLM (which used to confabulate refusals like "Ich kann keine
  // Software installieren" — wrong AND frustrating). Type stays
  // 'general' for backward compat with existing slash-discipline tests
  // that assert the LLM-bypass behavior; the metadata is consulted
  // by ChatOrchestrator before the general handler runs.
  return {
    type: 'general',
    confidence: 0.3,
    match: 'slash-discipline-guard',
    _wasSlashOnlyRewrite: true,
    originalIntent: result.type,
    originalMessage: message,
  };
}

// FIX v5.1.0 (N-5): Declarative intent definitions.
// Previously 157 lines of imperative register() calls (CC=124).
// Now a data table iterated by IntentRouter._registerDefaults() — CC≈3,
// same behavior. Each entry: [name, patterns, priority, keywords]
/** @type {Array<[string, RegExp[], number, string[]]>} */
const INTENT_DEFINITIONS = [
  // v7.3.6 #1 — Slash-Discipline.
  // Nine handlers below (self-inspect, self-reflect, self-modify, self-repair,
  // create-skill, clone, analyze-code, peer, daemon) match ONLY on a slash
  // command — either at the start of the message or embedded with whitespace
  // before it (Variant A: /(^|\s)\/name\b/i). Keyword and imperative matches
  // removed: they broke chat flow when conversational messages contained
  // words like "struktur", "module", "quellcode", "reparieren", "autonom",
  // "klonen". Slash registry: src/agent/intelligence/slash-commands.js.
  //
  // Handlers that still accept imperatives (goals, run-skill, execute-code,
  // execute-file, trust-control, ...) are intentionally unchanged — they
  // act on content the user is referring to, not on Genesis' self.

  ['self-inspect', [
    /(?:^|\s)\/(?:self-inspect|self-model)\b/i,
  ], 20, []],

  ['self-reflect', [
    /(?:^|\s)\/self-reflect\b/i,
  ], 22, []],

  ['self-modify', [
    /(?:^|\s)\/self-modify\b/i,
  ], 20, []],

  ['self-repair', [
    /(?:^|\s)\/self-repair\b/i,
  ], 20, []],

  // Circuit breaker reset — must be above self-repair so the longer name wins.
  // (Pattern order still matters for slash-style matches: self-repair-reset
  // must be registered BEFORE self-repair to avoid /self-repair-reset being
  // classified as self-repair.)
  ['self-repair-reset', [
    /(?:^|\s)\/(?:self-repair-reset|unfreeze)\b/i,
  ], 25, []],

  ['create-skill', [
    /(?:^|\s)\/create-skill\b/i,
  ], 15, []],

  ['clone', [
    /(?:^|\s)\/clone\b/i,
  ], 15, []],

  ['analyze-code', [
    /(?:^|\s)\/analyze-code\b/i,
  ], 12, []],

  // v5.9.1: Run/execute/use an installed skill — must be ABOVE execute-code
  // v7.8.0: Free-text patterns excluded when 'skill' is part of a path
  // ('src/skills', '.genesis/skills', etc.) — those are file/dir refs, not
  // skill-invocations. Path-detection via negative lookahead for /, \, or .
  // adjacent to the word.
  ['run-skill', [
    // v7.5.1: slash-trigger (REQUIRED — see SECURITY_REQUIRED_SLASH)
    /(?:^|\s)\/run-skill\b/i,
    // Free-text patterns kept for natural-language matching, but
    // enforceSlashDiscipline rewrites to 'general' unless / is present.
    // v7.8.0: don't match when 'skill' is in a path-like context.
    /(?:run|execute|use|start|starte?|fuehr).*\bskill\b(?![s]?[\/\\.])/i,
    /(?<![\/\\.])\bskill\b(?![s]?[\/\\.]).*(?:run|execute|use|starten?|ausfuehr)/i,
    /(?:nutze?|verwende?).*\bskill\b(?![s]?[\/\\.])/i,
    /(?:run|execute|use)\s+(?:the\s+)?[\w-]+-skill\b/i,
    // v5.9.1: Match "run <name>" where name is a single hyphenated word (no flags/paths)
    /^(?:run|execute|use)\s+(?:the\s+)?[a-z][\w-]+$/i,
  ], 16, ['skill', 'ausfuehren', 'nutzen', 'verwenden', 'starten']],

  ['execute-code', [
    // v7.5.1: slash-trigger (REQUIRED — see SECURITY_REQUIRED_SLASH)
    /(?:^|\s)\/execute-code\b/i,
    /^```/, /fuehre? aus/i, /execute.*code/i,
  ], 12, ['ausfuehren', 'execute', 'run']],

  ['execute-file', [
    // v7.5.1: slash-trigger (REQUIRED — see SECURITY_REQUIRED_SLASH)
    /(?:^|\s)\/execute-file\b/i,
    /fuehr.*datei/i, /execute.*file/i, /starte? .*\.\w{2,4}\b/i,
  ], 12, ['datei', 'starten', 'script']],

  // v7.3.6 #1 — Slash-only (continues the slash-discipline from the group above).
  ['peer', [
    /(?:^|\s)\/peer\b/i,
  ], 14, []],

  // v7.3.6 #1 — Slash-only. Free-text mentions ("ist der daemon noch aktiv?",
  // "wie autonom bist du?") fall through to general where the LLM answers with
  // status context if relevant.
  ['daemon', [
    /(?:^|\s)\/daemon\b/i,
  ], 10, []],

  ['trust-control', [
    // v7.5.1: slash-trigger (REQUIRED — see SECURITY_REQUIRED_SLASH)
    /(?:^|\s)\/trust-control\b/i,
    /(?:^|\s)\/trust\b/i,
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
    // v7.5.9 live-fix: catch natural phrasings the regex above missed.
    // (a) "öffne den github ordner auf dem desktop" — alias-name BEFORE
    //     the noun "ordner". The original pattern needed "ordner" right
    //     after "öffne (den)", so it failed on this common form.
    // (b) "kannst den ordner öffnen ? C:\..." — "öffnen" trailing the
    //     phrase, plus a Windows path anywhere in the message.
    // (c) "auf dem desktop ist ein ordner ... welche dateien sind in ihm"
    //     — implicit listing request. Routed through open-path so the
    //     ShellAgent.openPath handler can do the alias resolution.
    /(?:oeffne|öffne)\s+(?:den\s+|das\s+|die\s+)?\w+[-_.\w]*\s+(?:ordner|folder|verzeichnis|dir|datei|file)\b/i,
    /(?:ordner|folder|verzeichnis|datei|file)\s+(?:oeffnen|öffnen|open)\b/i,
    // Win-path standalone — but not when the message starts with a
    // different slash-command like /install, /open-this, /run, etc.
    // The negative lookahead protects "/install winrar D:\Programme"
    // from being routed to open-path instead of install-software.
    /^(?!\/(?!open\b)\w)[^\n]*?[A-Za-z]:\\[^\s"']{2,}/,
    /welche\s+dateien.*(?:in\s+(?:ihm|dem|diesem))/i,
    /(?:was|welche)\s+(?:ist|sind|liegt|liegen)\s+(?:in|im)\s+(?:dem\s+|diesem\s+)?(?:ordner|folder|verzeichnis)/i,
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

  // v7.5.9 ZIP3 Phase 4a: Software-installation requests.
  // In SECURITY_REQUIRED_SLASH because the action is a write-intent
  // shell command, so a literal `/` anywhere in the message is required
  // before any of these patterns can fire (enforceSlashDiscipline guard).
  // Free-text patterns are kept for natural UX once the user typed `/`.
  // The negative-lookahead after the verb excludes article-words ("die",
  // "das", "den", "the", "alle", "all") so abstract phrases like
  // "/install die Abhängigkeiten" stay general — those are coding
  // requests, not software installs.
  ['install-software', [
    /(?:^|\s)\/install(?:-software)?\b/i,
    /(?:installier(?:e|t|st)?|install)\s+(?:mir\s+)?(?:bitte\s+)?(?!(?:die|das|den|the|alle|all|ein|eine|einen|a|an)\b)[a-z0-9][a-z0-9._-]{1,49}/i,
    /(?:lad(?:e|s|et)?|download)\s+(?:mir\s+)?(?!(?:die|das|den|the|alle|all|ein|eine|einen|a|an)\b)[a-z0-9][a-z0-9._-]{1,49}\s+(?:runter|herunter|down)/i,
    /(?:setze?|setup)\s+(?!(?:die|das|den|the|alle|all|ein|eine|einen|a|an)\b)[a-z0-9][a-z0-9._-]{1,49}\s+auf\b/i,
  ], 13, ['installier', 'install', 'setup', 'download', 'paket', 'package']],

  // v7.5.9 ZIP4 Phase 8: Architecture-diagram (deterministic Mermaid).
  // Slash-only: free-text mentions of "architektur" are conversational
  // ("ich hätte gerne ein Diagramm der Architektur" → general). The
  // /architecture command emits a Mermaid block with the live module
  // map; Phase 11 renders it as SVG.
  ['architecture-diagram', [
    /(?:^|\s)\/architect(?:ure)?(?:-diagram)?\b/i,
    /(?:^|\s)\/diagram\b/i,
    /(?:^|\s)\/arch\b/i,
  ], 11, ['architecture', 'architektur', 'diagram', 'diagramm']],

  // v7.5.9 ZIP8: Open an installed application. Slash-form is the
  // primary path. Free-text "öffne <X>" / "starte <X>" / "führe <X>
  // aus" is supported because launching an already-installed app is
  // low-risk (Trust 1 reaches it). The handler also resolves pronouns
  // like "öffne es" by looking up the most-recently-installed package.
  ['open-software', [
    /(?:^|\s)\/open\b/i,
    /(?:öffne|starte?|f[üu]hre)\s+(?:mir\s+)?(?:bitte\s+)?(?:es|das|ihn|sie|[a-z0-9][a-z0-9._-]{1,49})\b/i,
  ], 12, ['open', 'öffne', 'starte', 'launch', 'run']],

  // Slash-only. Free-text mentions ("was hast du so gedacht?",
  // "dein Tagebuch klingt spannend") fall through to general where
  // the LLM answers conversationally with journal context injected
  // by PromptBuilder if relevant.
  ['journal', [
    /(?:^|\s)\/journal\b/i,
    /(?:^|\s)\/tagebuch\b/i,
  ], 10, []],

  // Slash-only. Conversational questions ("was willst du", "hast du ideen")
  // fall through to general where the LLM answers with plan data injected
  // as context — not a structured dump from CommandHandlers.plans().
  ['plans', [
    /(?:^|\s)\/plans?\b/i,
    /(?:^|\s)\/vorhaben\b/i,
  ], 10, []],

  ['goals', [
    // v7.5.0: SLASH-ONLY. Free-text mentions of "goal" / "ziel"
    // collide with conversational discussions about goals (the
    // bug live-reproduced in v7.4.9: a question CONTAINING the
    // words "goal" and "cancel" triggered cancel-all). The
    // slash-discipline guard (slash-commands.js entry) ensures
    // conversational mentions fall through to 'general' even if
    // these patterns somehow match.
    //
    // Subcommands recognised:
    //   /goal add <text>      — add a new goal
    //   /goal list            — list active goals  (also: bare /goal)
    //   /goal cancel <n>      — cancel goal #n
    //   /goal clear           — cancel all (with 30s confirmation)
    //   /goal confirm <id>    — v7.5.0 negotiation: confirm pending
    //   /goal revise <id>: t  — v7.5.0 negotiation: revise pending
    //   /goal dismiss <id>    — v7.5.0 negotiation: drop pending
    //
    // Aliases: /ziel, /ziele, /goals all map to the same handler.
    /(?:^|\s)\/(?:goal|ziel|ziele|goals)\b/i,
  ], 16, []],

  // Slash-only. Free-text mentions of "konfiguration" / "settings" /
  // "einstellung" in conversation fall through to general; the LLM
  // answers without dumping structured config. The API-key paste
  // pattern is an intentional exception — if a user pastes a key,
  // it is saved directly.
  ['settings', [
    /(?:^|\s)\/settings?\b/i,
    /(?:^|\s)\/einstellung\w*\b/i,
    /(?:^|\s)\/config\b/i,
    /(?:^|\s)\/konfigur\w*\b/i,
    // API-key paste: "Anthropic API-Key: sk-ant-..."
    /\b(?:anthropic|openai)\s+api.?key\s*[:=]\s*\S+/i,
  ], 12, []],

  ['web-lookup', [
    /(?:schau|such|pruef|check).*(?:web|online|internet|npm|doku|docs)/i,
    /(?:look|search|check|fetch).*(?:web|online|npm|docs)/i,
    /(?:ist|does).*(?:erreichbar|reachable|online)/i,
    /npm.*(?:paket|package|suche|search)/i,
    // v7.2.8: Bare domain with verb (e.g. "öffne nodejs.org", "go to github.com")
    /(?:öffne|open|geh\s+auf|go\s+to|zeig\s+mir|show\s+me|schau\s+auf|besuche|visit)\s+\S+\.\w{2,}/i,
    // v7.2.8: Naked domain (just "nodejs.org" without verb — only if entire message)
    /^[a-zA-Z0-9][\w-]*\.(?:com|org|net|io|dev|de|ch|at|eu|co|uk|info|app|ai|fr|nl|se|ru)$/i,
  ], 12, ['web', 'online', 'suchen', 'npm', 'dokumentation']],

  ['undo', [
    /rueckg/i, /(?<!cancel.{0,20})undo/i, /rollback/i, /revert/i, /letzte.*aenderung.*rueck/i,
  ], 15, ['rueckgaengig', 'undo', 'rollback', 'zurueck', 'revert', 'wiederherstellen']],

  // Shell task (multi-step planned execution)
  ['shell-task', [
    // v7.5.1: slash-trigger (REQUIRED — see SECURITY_REQUIRED_SLASH)
    /(?:^|\s)\/shell-task\b/i,
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
    // v7.5.1: slash-trigger (REQUIRED — see SECURITY_REQUIRED_SLASH)
    /(?:^|\s)\/shell-run\b/i,
    /(?:^|\s)\/shell\b/i,
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

  // v7.3.2: Core-Memory commands — support both slash-form and natural language.
  // Priority: list > veto > mark (so "Kernerinnerung" in a list/veto question
  // doesn't accidentally trigger a mark)
  ['memory-list', [
    /^\/memories\b/i,
    /^\/mem\b/i,
  ], 24, []],

  ['memory-veto', [
    /^\/veto\b/i,
  ], 23, []],

  ['memory-mark', [
    /^\/mark\b/i,
  ], 22, []],

  // v7.5.5: Self-Statement-Log recall
  ['self-recall', [
    /^\/recall\b/i,
  ], 22, []],

  // v7.8.4: Pre-deletion audit (slash-only)
  ['cleanup-check', [
    /(?:^|\s)\/cleanup-check\b/i,
  ], 22, []],

  // v7.5.6: Model availability marker reset
  ['model-reset', [
    /(?:^|\s)\/model-reset\b/i,
  ], 25, []],

  // v7.7.9 Phase 2: ProactiveSelfExpression user controls — slash-only
  // (no fuzzy match, no LLM classification fall-through; if Garrus types
  // /quiet 2h, that's exactly what runs).
  ['quiet', [
    /(?:^|\s)\/(?:quiet|silence)\b/i,
  ], 25, []],
  ['proactive-status', [
    /(?:^|\s)\/proactive-status\b/i,
  ], 25, []],

  // v7.8.9 (koennen-v789 contract): /affect-trail [n] — inspect recent
  // AgentLoop boundaries with affect snapshot and gate status.
  ['affect-trail', [
    /(?:^|\s)\/(?:affect-trail|affekt-trail)\b/i,
  ], 25, []],

  ['greeting', [
    /^(hi|hallo|hey|moin|servus|guten (morgen|tag|abend)|hello|good (morning|evening)|bonjour|buenas?)\s*[!.]?$/i,
  ], 5, ['hallo', 'hello', 'hi', 'moin', 'servus']],
];

module.exports = {
  INTENT_DEFINITIONS,
  SLASH_ONLY_INTENTS,
  SECURITY_REQUIRED_SLASH,
  SAFE_SLASH_FALLTHROUGH,
  enforceSlashDiscipline,
};
