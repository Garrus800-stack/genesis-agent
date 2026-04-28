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

function enforceSlashDiscipline(result, message) {
  if (!result || !SLASH_ONLY_INTENTS.has(result.type)) return result;
  // A literal / anywhere in the message is sufficient. The per-intent
  // patterns then decide WHICH slash-command was meant; this guard only
  // decides whether ANY slash-command is allowed at all.
  if (typeof message === 'string' && message.includes('/')) return result;
  // Rewrite: slash-only intent without slash → general.
  return { type: 'general', confidence: 0.3, match: 'slash-discipline-guard' };
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

  ['greeting', [
    /^(hi|hallo|hey|moin|servus|guten (morgen|tag|abend)|hello|good (morning|evening)|bonjour|buenas?)\s*[!.]?$/i,
  ], 5, ['hallo', 'hello', 'hi', 'moin', 'servus']],
];

module.exports = {
  INTENT_DEFINITIONS,
  SLASH_ONLY_INTENTS,
  enforceSlashDiscipline,
};
