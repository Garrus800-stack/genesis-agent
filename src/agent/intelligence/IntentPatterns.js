// ============================================================
// GENESIS — IntentPatterns.js (v7.4.3 "Aufräumen II")
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

// v7.9.47: the slash-discipline block (three sets + the guard) moved to
// IntentSlashDiscipline.js to get this file under the 700-LOC guard. It is
// re-exported unchanged below, so every importer keeps one address.
const {
  SLASH_ONLY_INTENTS,
  SAFE_SLASH_FALLTHROUGH,
  SECURITY_REQUIRED_SLASH,
  enforceSlashDiscipline,
} = require('./IntentSlashDiscipline');


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

  ['vault-set', [ // v7.9.45 field: spoken vault handshake, four locales
    /\b(?:mein|der|dein)\s+(?:obsidian[-\s]?)?(?:vault|notiz[-\s]?ordner)\s+(?:liegt|ist|befindet\s+sich)\s+(?:in|unter|auf|bei)\b|\bvault[-\s]?pfad\s+ist\b|\bhier\s+ist\s+mein\s+(?:obsidian[-\s]?)?vault\b/i,
    /\b(?:my|your)\s+(?:obsidian\s+)?(?:vault|notes?\s+folder)\s+(?:is|lives)\s+(?:at|in)\b|\bhere\s+is\s+my\s+(?:obsidian\s+)?vault\b/i,
    /\b(?:mon|ton)\s+(?:vault|dossier\s+de\s+notes)\s+(?:est|se\s+trouve)\s+(?:dans|sous|\u00e0)\b|\b(?:mi|tu)\s+(?:vault|carpeta\s+de\s+notas)\s+(?:est\u00e1|esta|vive)\s+en\b|\bvoici\s+mon\s+vault\b|\baqu\u00ed\s+est\u00e1\s+mi\s+vault\b/i,
  ], 30],
  ['lab-run', [
    /\b(?:f(?:ü|u)hr(?:e|st)?|starte?|mach(?:e)?|lass|run|execute|try|test(?:e)?|probier(?:e)?|ex(?:é|e)cute[sz]?|lance[sz]?|fais|ejecuta|corre|pru[eé]ba|haz|essaie)\w*\b[\s\S]{0,60}?\b(?:im|in\s+the|dans\s+l[ea]|en\s+el)\s+lab(?:o(?:ratoire)?|or(?:atorio)?)?\b[\s\S]*?(?::|```)/i,
    /\b(?:im|in\s+the|dans\s+l[ea]|en\s+el)\s+lab(?:o(?:ratoire)?|or(?:atorio)?)?\b[\s\S]{0,60}?\b(?:diesen|folgenden|den|this|the|ce|cet|este)\s+(?:code|python-?code|js-?code)\b/i,
    /\b(?:probier|test|versuch|try|essaie?|pru[eé]ba)\w*\s+(?:mal\s+|doch\s+|bitte\s+)*(?:es|das|ihn|it|\u00e7a|lo)?\s*(?:mal\s+|doch\s+|bitte\s+)*(?:im|in\s+the|dans\s+l[ea]|en\s+el)\s+lab\w*\s*[.!?]*\s*$/i,
    /\b(?:schau|sieh|guck|look|regarde|mira)\s*(?:mal\s+)?in(?:s|to)?\s+(?:das\s+|the\s+|le\s+|el\s+)?lab\w*\b|\b(?:wie\s+geht(?:'?s|\s+es)?|how(?:'s|\s+is)|status)\b[^,]{0,24}\blab(?:o|or)\w*/i,
    /\blab-?run\b[\s\S]*?(?::|```)/i,
  ], 60],
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
    /trust.*(?:supervised|autonomous|full)/i,
  ], 12, ['trust', 'vertrauen', 'stufe', 'level', 'autonomie', 'freigabe', 'genehmigung']],

  ['open-path', [
    /(?:oeffne|öffne|open|ouvre[sz]?|abre)\s+(?:(?:den|die|das|the|le|la|el)\s+)?(?:ordner|folder|directory|verzeichnis|dir|pfad|path|datei|file|dossier|r(?:é|e)pertoire|carpeta|archivo)\s*/i,
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
    // different slash-command like /install, /open-this, /run, etc.
    // The negative lookahead protects "/install winrar D:\Programme"
    // from being routed to open-path instead of install-software.
    /^(?!\/(?!open\b)\w)(?![^\n]*\b(?:warum|wieso|weshalb|why|pourquoi|por\s+qu[e\u00e9]|nicht|not\s+open|n['e]\s?ouvre|no\s+abr|leg\b|erstell|schreib|create|make|cr[e\u00e9]e|crea)\b)[^\n]*?[A-Za-z]:\\[^\s"']{2,}/,
    /welche\s+dateien.*(?:in\s+(?:ihm|dem|diesem))/i,
    /(?:was|welche)\s+(?:ist|sind|liegt|liegen)\s+(?:in|im)\s+(?:dem\s+|diesem\s+)?(?:ordner|folder|verzeichnis)/i,
    // öffnen", "could you open the report". Leading slash-exclusion (CI fix):
    // must NOT fire when the message carries a different slash-command (" /x").
    /^(?![\s\S]*\s\/[a-z])(?:kannst|könntest|könnt|kannste|could|can|would|will|würdest)\s+(?:du|ihr|you)\b[\s\S]*\b(?:oeffne|öffne|öffnen|open|starte|start)\b/i,
    // chrome", "open notepad.exe". Moved here from the slash-only
    // open-software intent so a chat launch reaches openPath -> tryAppLaunch
    // (which launches) instead of bouncing to "/open firefox". The
    // google/mozilla/microsoft brand prefixes cover the multi-word forms the
    // field used; "build"/"node" etc. are NOT app keywords so shell/execute
    // intents keep those.
    /(?<![\/\w])(?:oeffne|öffne|starte?|f(?:ü|ue|u)hre?|open|launch|start|run)\s+(?:mir\s+|bitte\s+|das\s+|die\s+|den\s+|the\s+|a\s+)*(?:google\s+|mozilla\s+|microsoft\s+)?(?:app|application|anwendung|programm|program|browser|editor|ide|terminal|konsole|console|explorer|notepad|vscode|code|chrome|firefox|edge|msedge|[\w.-]+\.(?:exe|app|sh|bat|cmd|msi|desktop|appimage))\b/i,
    // "öffne auf d den ordner <name>", "öffne d:". Route here (not the LLM,
    // which mis-classified it as a file-search) so openPath's drive branch
    // resolves and opens the target on that drive.
    /(?:oeffne|öffne|open)\s+(?:in|auf|unter|on|im)\s+["']?[A-Za-z]:?(?=[\s\\/]|$)/i,
    /(?:oeffne|öffne|open)\s+["']?[A-Za-z]:(?=\s|$)/i,
    // <name>" in either word order. Deterministic so it no longer depends on
    // the fuzzy/LLM fallback that the field showed was flaky.
    /(?:oeffne|öffne|open)\s+[\s\S]*?\b(?:auf|in|unter|on|im)\s+(?:dem|den|der|the)\s+(?:desktop|schreibtisch|downloads?|dokumente|documents?|bilder|pictures?|musik|music)\b/i,
    // v7.9.28 (field-fix #3): the German separable verb "aufmachen" — "mach den
    // ordner X auf", "mach X auf". openPath normalizes it to the "öffne …" form.
    /\bmach(?:e|st)?\s+(?:den\s+|die\s+|das\s+)?(?:ordner|folder|verzeichnis|datei|file|dokument)\b[\s\S]*\bauf\b/i,
    /\bmach(?:e|st)?\s+(?:den\s+|die\s+|das\s+)?["']?[\w][\w.()\-]*["']?\s+auf\b/i,
  ], 15, ['öffnen', 'oeffnen', 'ordner', 'folder', 'verzeichnis', 'datei', 'pfad', 'explorer']],

  // v7.9.28 (F7): scoped file search — read-only, fuzzy by design (no slash).
  ['file-search-local', [
    /(?:such(?:e|en)?|find(?:e|en)?|search|locate)\s+(?:mir\s+|nach\s+)?(?:eine?\s+|einen?\s+|a\s+)?(?:anwendung|application|app|programm|program|datei|file|dokument|document|bild|bilder|image|foto)\b/i,
    /(?:such(?:e|en)?|find(?:e|en)?|search|locate)\b[\s\S]*\b(?:in|im|unter)\s+[A-Za-z]:[\\/]/i,
  ], 11, ['suche', 'finde', 'search', 'find', 'datei', 'anwendung', 'dokument']],

  // v7.9.28 (field-fix #3): deterministic folder listing — "wieviele/welche
  // dateien sind (im) ordner", "was ist drin", "liste den inhalt". Answered
  // straight from fs (listFolder) so a code model cannot derail it with a
  // failing shell tool. Read-only, not slash-only.
  ['list-folder', [
    /\bwie\s*viele?\s+(?:datei(?:en|n)?|ordner|elemente|dinge)\b/i,
    /\bwelche\s+(?:datei(?:en|n)?|ordner|elemente)\b/i,
    /\bliste?\s+(?:mir\s+)?(?:den\s+)?(?:ordner)?inhalt\b/i,
    /\b(?:list\s+the\s+files?|liste[rz]?\s+les\s+fichiers|lista[r]?\s+los\s+archivos)\b/i,
    /\b(?:datei(?:en|n)?|ordner)\s+(?:sind\s+)?(?:dort\s+|da\s+|drin\s+)?(?:enthalten|drin)\b/i,
    /\binhalt\s+(?:des|vom|von)\s+(?:dem\s+)?ordner/i,
    /\bwas\s+(?:ist|sind|liegt|liegen)\s+(?:da\s+|dort\s+|alles\s+)*(?:drin|im\s+ordner|enthalten)\b/i,
    // English
    /\b(?:which|what)\s+files?\b/i,
    /\bhow\s+many\s+(?:files?|folders?|items?)\b/i,
    /\blist\s+(?:the\s+)?(?:files?|folder|directory|contents?)\b/i,
    /\bwhat(?:'s|\s+is)?\s+(?:in|inside)\s+(?:the\s+|this\s+)?(?:folder|directory|dir)\b/i,
    /\b(?:show|display)\s+(?:me\s+)?(?:the\s+)?(?:folder|directory)\s+content/i,
    // anaphora / explicit list command — "liste sie auf", "die dateien
    // auflisten", "list them", "welche sind das/drin"
    /\b(?:datei(?:en|n)?|ordner|sie|elemente)\s+auf(?:zu)?listen?\b/i,
    /\b(?:auf)?liste?(?:t|n)?\s+(?:mir\s+)?(?:sie|die\s+datei(?:en|n)?|them|the\s+files?|alle)\b/i,
    /\blist\s+(?:them|all|it)\b/i,
    /\bwelche\s+sind\s+(?:das|es|drin|die)\b/i,
  ], 14, ['dateien', 'ordner', 'inhalt', 'auflisten', 'liste', 'enthalten', 'files', 'folder', 'list']],

  // v7.9.28 (field-fix #3): deterministic file read — "was steht in/im <datei>",
  // "was steht da drin", "zeig mir den inhalt von <datei>". Resolved (explicit
  // path, a named location on Desktop/Documents searching plain + OneDrive, or
  // the last-opened file) and read straight from fs (readFile) — no cat, no
  // shell path-quoting. Summaries ("fasse X zusammen") stay on the LLM path.
  ['read-file', [
    /\bwas\s+steht\s+(?:in|im|drin|da\b)/i,
    /\bwas\s+ist\s+(?:der\s+|das\s+)?inhalt\s+(?:von|des|der\s+datei|vom|im)\b/i,
    /\b(?:what\s+is\s+the\s+content\s+of|quel\s+est\s+le\s+contenu\s+d[eu]|cu[aá]l\s+es\s+el\s+contenido\s+de)\b/i, // v7.9.45 parity: DE=EN=FR=ES (field law)
    /\b(?:que\s+dit|qu[eé]\s+dice)\s+\S/i,
    /\b(?:lis|lee|montre(?:-moi)?|mu[eé]strame|regarde|mira)\s+(?:le\s+fichier\s+|el\s+archivo\s+)?["']?[\w][\w./()\\-]*\.(?:md|txt|json|js|jsx|ts|tsx|yaml|yml|toml|html|css|log|csv|xml|ini|cfg|conf|sh|py|pdf|png|jpe?g|gif|webp)\b/i,
    /\bwas\s+ist\s+(?:in|im)\s+(?:dem\s+|der\s+|einem\s+)?(?:datei|dokument|file|document)\b/i,
    /\blies\s+(?:mir\s+)?(?:den\s+inhalt|die\s+datei)\b/i,
    // v7.9.29 (Teil B): direct read of a NAMED file — "lies X.md", "schau (dir)
    // X.md an", "zeig mir X.md". Scoped to a filename WITH an extension so a
    // bare "schau dir das an" / "zeig mir das" (no file) does NOT match and
    // falls through to general. Resolution + graceful null-fallthrough live in
    // the readFile handler.
    /\blies\s+(?:mir\s+)?(?:die\s+datei\s+)?["']?[\w][\w./()\\-]*\.(?:md|txt|json|js|jsx|ts|tsx|yaml|yml|toml|html|css|log|csv|xml|ini|cfg|conf|sh|py|pdf|png|jpe?g|gif|webp)\b/i,
    /\bschau(?:e|st)?\s+(?:dir\s+)?(?:mal\s+)?(?:die\s+datei\s+)?["']?[\w][\w./()\\-]*\.(?:md|txt|json|js|jsx|ts|tsx|yaml|yml|toml|html|css|log|csv|xml|ini|cfg|conf|sh|py|pdf|png|jpe?g|gif|webp)\b/i,
    /\bzeig(?:e|st)?\s+(?:mir\s+)?(?:die\s+datei\s+)?["']?[\w][\w./()\\-]*\.(?:md|txt|json|js|jsx|ts|tsx|yaml|yml|toml|html|css|log|csv|xml|ini|cfg|conf|sh|py|pdf|png|jpe?g|gif|webp)\b/i,
    // v7.9.30 (Teil B ext): verb-postposed — "kannst du mir README.md zeigen".
    /[\w][\w./()\\-]*\.(?:md|txt|json|js|jsx|ts|tsx|yaml|yml|toml|html|css|log|csv|xml|ini|cfg|conf|sh|py|pdf|png|jpe?g|gif|webp)\s+(?:zeigen|anzeigen|lesen|öffnen|aufmachen)\b/i,
    // English
    /\bwhat(?:'s|\s+is)?\s+(?:in|inside)\s+(?:the\s+|this\s+)?(?:file|document)\b/i,
    /\bwhat\s+does\s+(?:the\s+)?(?:file\s+)?[\w.()-]+\s+(?:say|contain)\b/i,
    /\bread\s+(?:me\s+)?(?:the\s+)?(?:file|document|contents?\s+of)\b/i,
    /\bshow\s+(?:me\s+)?(?:the\s+)?(?:contents?\s+of|file\s+content)\b/i,
    /(?<!(?:did|have)\s+you\s+)\bread\s+(?:me\s+)?(?:the\s+file\s+)?["']?[\w][\w./()\\-]*\.(?:md|txt|json|js|jsx|ts|tsx|yaml|yml|toml|html|css|log|csv|xml|ini|cfg|conf|sh|py|pdf|png|jpe?g|gif|webp)\b/i,
    /\bshow\s+(?:me\s+)?(?:the\s+file\s+)?["']?[\w][\w./()\\-]*\.(?:md|txt|json|js|jsx|ts|tsx|yaml|yml|toml|html|css|log|csv|xml|ini|cfg|conf|sh|py|pdf|png|jpe?g|gif|webp)\b/i,
    /\b(?:was\s+ist\s+auf\s+(?:dem|der)|what(?:'s|\s+is)\s+(?:on|in)\s+the|que\s+voit-on\s+sur|qu[eé]\s+se\s+ve\s+en)\s+\S+\.(?:png|jpe?g|gif|webp|bmp)\b/i,
  ], 14, ['steht', 'lesen', 'drin', 'inhalt', 'read', 'file', 'content']],

  // v7.9.28 (field-fix #3): safe deterministic file creation — "erstelle eine
  // Textdatei mit Namen X und Inhalt Y in <ort>". A bounded fs write (one named
  // file), not arbitrary shell, so it is trusted by source and needs no slash
  // gate; guarded against system/secret paths and never overwrites.
  // names no file word) stays with the model — Genesis answered a reflective
  // question with 'which file?' once; never again. Commands keep routing.
  // v7.9.28 (field-fix #3): write text INTO a file — "schreibe den text - … in
  // x2", "speichere die Zusammenfassung mit Namen one", "save the summary to
  // notes". Distinct from create-file (which refuses to overwrite): this is an
  // explicit write that persists a literal or the last summary.
  ['write-file', [
    /(?!(?=[\s\S]*\?\s*$)(?![\s\S]*\b(?:datei|file|dokument|document|\.md|\.txt|\.json)\b))\bspeicher(?:e|n|st)?\b[\s\S]{0,80}\b(?:datei|dokument|file|mit\s+namen?|namens|als\b|in\s+["']?[\w.()\-]+)/i,
    /(?!(?=[\s\S]*\?\s*$)(?![\s\S]*\b(?:datei|file|dokument|document|\.md|\.txt|\.json)\b))\bschreib(?:e|en|st)?\s+(?:den\s+|mir\s+|die\s+|das\s+)?(?:text|zusammenfassung|zusammenfassund|inhalt|folgendes|ergebnis)\b/i,
    /(?!(?=[\s\S]*\?\s*$)(?![\s\S]*\b(?:datei|file|dokument|document|\.md|\.txt|\.json)\b))\bschreib(?:e|en)?\b[\s\S]*?\b(?:in|nach)\s+(?:die\s+)?(?:datei\s+|dokument\s+)?["']?[\w][\w.()\-]*["']?\s*[.?!]*$/i,
    // "schreiben test in den inhalt / hinein / rein" — and "schreib das in
    // eine datei / ein dokument" — but NOT part of an "erstelle …" command
    // (that stays create-file).
    /(?!(?=[\s\S]*\?\s*$)(?![\s\S]*\b(?:datei|file|dokument|document|\.md|\.txt|\.json)\b))^(?![\s\S]*\berstell)[\s\S]*?\bschreib\w*\s+[\s\S]+?\s+(?:in\s+den\s+inhalt|in\s+(?:die|eine[rnm]?|der)\s+datei|in\s+(?:das|ein|einem)\s+dokument|hinein|rein|dazu)\b/i,
    /(?!(?=[\s\S]*\?\s*$)(?![\s\S]*\b(?:datei|file|dokument|document|\.md|\.txt|\.json)\b))^(?![\s\S]*\berstell)[\s\S]*?\bschreib\w*\s+[\s\S]*?\bin\s+(?:eine?[nrm]?\s+|einem\s+|die\s+|das\s+|dem\s+)?(?:datei|dokument|file)\b/i,
    /(?!(?=[\s\S]*\?\s*$)(?![\s\S]*\b(?:datei|file|dokument|document|\.md|\.txt|\.json)\b))\b(?:save|write)\b[\s\S]*\b(?:to|into)\s+(?:the\s+|a\s+)?(?:file|document|["']?[\w.()\-]+)/i,
  ], 15, ['speichern', 'schreiben', 'save', 'write', 'zusammenfassung']],

  ['vault-lookup', [ // v7.9.45 field: read-then-answer, never memory-first
    /\b(?:schau(?:\s+mal)?\s+in\s+mein(?:en|em)?|look\s+in(?:to)?\s+my|regarde\s+dans\s+mon|mira\s+en\s+mi)\s+[^\s:\uff1a]+\s*[:\uff1a]/i,
    /\b(?:schau|sieh)\s+in\s+(?:den|dein(?:en)?|meinen)\s+(?:vault|notiz[-\s]?ordner)\b|\blook\s+in(?:to)?\s+(?:the|your|my)\s+vault\b/i,
    /\b(?:schau(?:\s+mal)?|sieh)\s+in\s+mein\w*\s+[^\s:]+\s+(?:und\s+|,\s*)?(?:sag|nenn|zeig|such)|\blook\s+in(?:to)?\s+my\s+[^\s:]+\s+and\s+(?:tell|say|show|find)|\bregarde\s+dans\s+mon\s+[^\s:]+\s+et\s+dis|\bmira\s+en\s+mi\s+[^\s:]+\s+y\s+di/i,
  ], 45],
  ['where-is', [ // v7.9.45 field: places map — deterministic, model-free
    /\bwo\s+(?:ist|liegt|soll|befindet\s+sich)\s+(?:denn\s+)?(?:dein|deine|mein|meine)\s+(?:arbeitsbereich|archiv|backup|zuhause|vault)\b|\bwhere\s+is\s+(?:your|my)\s+(?:workspace|archive|backup|home|vault)\b|\bo[\u00f9u]\s+est\s+(?:ton|mon)\s+(?:espace|archive|vault)\b|\bd[\u00f3o]nde\s+est[\u00e1a]\s+(?:tu|mi)\s+(?:espacio|archivo|vault)\b/i,
  ], 35],
  ['edit-file', [ // v7.9.45 field: spoken edit — old + to/durch + new must both appear
    /^(?!.*\btrust\b)(?=[\s\S]*(?:(?:^|[\s"„'(])(?:ver)?(?:änder|ersetz)\w*|\b(?:change|replace|remplace\w*|cambia|reemplaza)\b))[\s\S]*?\S+\s+(?:zu|durch|to|with|par|por|con)\s+\S+/i,
  ], 40],
  ['create-file', [
    /\b(?:leg(?:e)?|erstell\w*)\s+(?:dir\s+|mir\s+)?(?:in\s+[\s\S]{0,40}?)?(?:eine?[nr]?\s+)?(?:erste[n]?\s+|neue[n]?\s+)?(?:notiz|note|nota)\b|\b(?:cr[e\u00e9]e[rz]?|crea[r]?)\s+(?:une\s+|una\s+)?not[ae]\b|\bmake\s+(?:a\s+)?(?:first\s+)?note\b/i,
    /^[\w][\w.\- ]{0,40}\s+(?:und|mit|and|with)\s+(?:dem\s+|the\s+)?(?:text|inhalt|content)\s+\S/i, // v7.9.45: the name-question answer form
    /^(?:sie|es|die\s+datei|the\s+file|it)\s+(?:s?oll(?:te)?|should)\s+\S{1,40}\s+hei(?:\u00df|ss)en\b|^(?:nenn(?:e)?\s+sie|call\s+it|name\s+it)\s+\S/i,
    /\berstell(?:e|en)?\s+(?:mir\s+)?(?:eine?\s+|einen?\s+|das\s+)?(?:neue?\s+)?(?:text[\s-]*)?(?:datei|dokument|file|document)\b/i,
    /\b(?:neue?\s+)?(?:text[\s-]*)?(?:datei|dokument)\s+(?:mit\s+namen?|namens)\b/i,
    /\bschreib(?:e)?\s+(?:eine?\s+)?(?:text[\s-]*)?(?:datei|dokument)\b/i,
    /\bcr[eé]e[rz]?\s+(?:un\s+)?(?:nouveau\s+)?fichier\b/i,
    /\bcrea[r]?\s+(?:un\s+)?(?:nuevo\s+)?archivo\b/i,
    // English
    /\b(?:create|make|write)\s+(?:a\s+|an\s+)?(?:new\s+)?(?:text\s+|empty\s+)?(?:file|document)\b/i,
    /\b(?:file|document)\s+(?:named|called)\b/i,
    // dokument erstellen mit namen …", "eine datei anlegen namens …". The
    // noun-verb adjacency plus a name/content marker keeps capability
    // questions ("welche dateien kann man erstellen?") with the model.
    /\b(?:datei(?:en)?|dokumente?|files?|documents?)\s+(?:bitte\s+|jetzt\s+|mal\s+|noch\s+|zu\s+)*(?:erstell|anleg)\w*\b[\s\S]{0,80}\b(?:namens?|inhalt|text|content|named|called)\b/i,
  ], 16, ['erstelle', 'erstellen', 'datei', 'dokument', 'anlegen', 'schreiben', 'create', 'file']],

  // v7.9.28 (field-fix #3): deterministic file summary — resolves + reads the
  // FULL file and makes one LLM call, so no announce-and-wait and no partial
  // summary. Named ("fasse ONTOGENESIS zusammen"), anaphoric ("fasse das
  // zusammen" → last file), German + English.
  ['summarize-file', [
    /\bfass(?:e|en|t|st)?\b[\s\S]*?\bzusammen\b/i,
    /\b(?:zusammenfass|summariz)\w*/i,
    /\b(?:r[ée]sume[rz]?|resume)\s+(?:le\s+fichier\s+|el\s+archivo\s+)?\S+\.(?:md|txt|json|js|log|csv|yaml|yml|pdf)\b/i,
  ], 14, ['fassen', 'zusammenfassen', 'zusammenfassung', 'summarize', 'summary']],

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
    // v7.9.28 (field-fix A): only the explicit /open slash reaches this
    // slash-only intent now. Plain-text app launches ("öffne firefox") route
    // to open-path -> tryAppLaunch (which launches) so the user no longer
    // gets bounced to "/open". /open itself still runs the robust
    // registry/start-menu launcher (openSoftware -> _launch).
    /(?:^|\s)\/open\b/i,
  ], 12, ['open']],

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
    /install(?:iere?)?\s+(?:die\s+|the\s+)?(?:deps|dependencies|abhaengigkeiten|pakete?)/i,
    /\b(?:f(?:ü|ue|u)hre?|starte?|laufe?|run|execute|build)\s+(?:den\s+|die\s+|das\s+|the\s+|a\s+)?(?:test|build|lint|script|projekt|project)s?\b/i,
    /erstell.*(?:projekt|ordner|verzeichnis|datei)/i,
    /(?:init|setup|scaffold|bootstrap).*(?:projekt|app)/i,
    /\b(?:richte|setze?)\s+(?:das\s+|die\s+|den\s+|ein\s+|the\s+)?(?:projekt|project|repo|repository|app|anwendung|umgebung|environment|server|datenbank|database|build)\b/i,
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
  // (no fuzzy match, no LLM classification fall-through; if Alex types
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

  // v7.9.0 Phase 2 (koennen-crystallizer-v790 contract): /skills-pending —
  // list skills SkillCrystallizer has extracted but not yet promoted.
  ['skills-pending', [
    /(?:^|\s)\/skills-pending\b/i,
  ], 25, []],

  // v7.9.33 (AP-2, S7): /changes [n] — read the change register (losses,
  // consolidations, fitness lines). Slash-only per pattern; the v7.9.30
  // slash discipline (start anchor in classifyAsync) applies.
  ['changes', [
    /(?:^|\s)\/changes\b/i,
  ], 25, []],

  // v7.9.47: /crashlog existed as a CLI branch only (cli.js) — in chat the
  // command did nothing at all. A command exists or it does not; it does not
  // exist at one of two front doors.
  // v7.9.48: four reports that existed only in the CLI. Of twenty commands the
  // terminal had and the app did not, these speak most directly about him —
  // whoever talked to Genesis in the app could not ask how he sees himself.
  ['selfmodel', [
    /(?:^|\s)\/selfmodel\b/i,
  ], 25, []],

  ['adaptations', [
    /(?:^|\s)\/adaptations\b/i,
  ], 25, []],

  ['autonomy', [
    /(?:^|\s)\/autonomy\b/i,
  ], 25, []],

  ['budget', [
    /(?:^|\s)\/budget\b/i,
  ], 25, []],

  ['crashlog', [
    /(?:^|\s)\/crashlog\b/i,
  ], 25, []],

  // v7.9.4 (koennen-promotion-v794 contract): /skill-info <name> shows
  // the full biography (acquisitionContext) of one skill.
  ['skill-info', [
    /(?:^|\s)\/(?:skill-info|skill-bio)\s+\S+/i,
  ], 25, []],

  // v7.9.4 (koennen-promotion-v794 contract): /skill-discard <name> <reason>
  // soft-discards a skill with a min-10-character reason. Creates a Core Memory.
  ['skill-discard', [
    /(?:^|\s)\/skill-discard\s+\S+\s+.+/i,
  ], 25, []],

  // v7.9.5 live-fix: surface daemon background work that previously
  // disappeared into a fire-and-forget event or a logged count.
  ['daemon-suggestions', [
    /(?:^|\s)\/(?:daemon-suggestions|suggestions)(?:\s+\d{1,3})?\s*$/i,
  ], 25, []],
  ['daemon-health-issues', [
    /(?:^|\s)\/(?:daemon-health-issues|health-issues)(?:\s+\d{1,3})?\s*$/i,
  ], 25, []],

  // v7.9.15: /trajectory new|show|list|note|history — self-trajectory journal.
  // Single slash-anchored pattern (pure-slash-only); subcommands parsed in the
  // handler. NOT in SAFE_SLASH_FALLTHROUGH because /trajectory new writes.
  ['trajectory', [
    /(?:^|\s)\/(?:trajectory|trajektorie)\b/i,
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
