// @ts-checked-v7.8.3
// ============================================================
// GENESIS — hexagonal/OpenPathAppLaunch.js
//
// App-launch helper extracted from CommandHandlersShell.openPath
// in v7.8.3 follow-up. Pre-extraction the regex, constants, and
// branching logic lived inline in the openPath method (~30 LOC of
// constants + ~20 LOC of branching), which pushed the mixin past
// its soft size cap. This file is consumed only by openPath; no
// other caller should depend on it.
//
// The single export is `tryAppLaunch(message, shell)`:
//   - returns `{ launched: true, name }`            on successful launch
//   - returns `{ launched: false, error: msg }`     when shell.run threw
//   - returns null                                  when the message
//                                                   does not look like
//                                                   an app-launch (caller
//                                                   should print the help
//                                                   string instead).
//
// Rejection gates (the caller can rely on these without re-checking):
//   1. No verb match                  → null
//   2. Captured token is a filler     → null
//   3. Captured token is a common noun → null
//   4. Filename in message + verb is  → null
//      open/öffne (not start/starte)
// ============================================================

'use strict';

// Order in the verb alternation matters: `oeffne` before `öffne` so
// ASCII-only environments without proper UTF-8 in the test runner
// still see a match. JS `\b` is ASCII-only so the boundary is
// hand-rolled as (?:^|[^\w]).
const APP_LAUNCH_FILLERS = '(?:bitte|mal|doch|jetzt|schnell|kurz|nochmal|schon|mir|dir|uns|ihn|sie|es|das|den|die|the|please|now|quickly|just|really|also|me|him|her|us|it|that|this)';
const APP_LAUNCH_SEP = '[\\s,;]+';
const APP_LAUNCH_RE = new RegExp(
  '(?:^|[^\\w])(?:oeffne|öffne|open|start|starte)' + APP_LAUNCH_SEP +
  '(?:' + APP_LAUNCH_FILLERS + APP_LAUNCH_SEP + ')*([\\w][\\w.-]*)',
  'i'
);

const APP_LAUNCH_FILLER_SET = new Set([
  'bitte','mal','doch','jetzt','schnell','kurz','nochmal','schon',
  'mir','dir','uns','ihn','sie','es','das','den','die','the',
  'please','now','quickly','just','really','also',
  'me','him','her','us','it','that','this',
]);

// Generic concrete nouns that the user could mistake for an app
// name. When captured, defer to the help string so the user can
// re-state with a specific name. Same vocabulary as the
// VagueReferenceDetector antecedent list (intentional — these are
// the words that signal "I mean a thing of this type" rather than
// "an app called this").
const APP_LAUNCH_COMMON_NOUNS = new Set([
  'datei','file','ordner','folder','verzeichnis','directory','pfad','path',
  'dokument','document','skill','tool','projekt','project','service','module',
  'funktion','function','klasse','class','zeile','line','buch','book',
  'bild','image','foto','photo','video','email','mail','notiz','note',
  'termin','appointment','nachricht','message','seite','page','link','url',
  'adresse','address','anwendung','application','app','programm','program',
  'fenster','window','tab','liste','list','tabelle','table','eintrag','entry',
  'browser','editor','terminal','konsole','console','shell',
]);

const APP_LAUNCH_FILENAME_RE = /\b[\w.-]+\.(?:txt|md|pdf|json|js|ts|tsx|jsx|html|css|scss|jpg|jpeg|png|gif|svg|webp|mp3|mp4|wav|doc|docx|xls|xlsx|ppt|pptx|csv|xml|yml|yaml|zip|tar|gz|log|cfg|conf|ini|sh|py|rb|go|rs|c|cpp|h|hpp|java|class|jar)\b/i;
const APP_LAUNCH_START_VERB_RE = /(?:^|[^\w])(?:start|starte)\s/i;

/**
 * Attempt to launch an application named in a natural-language message.
 * @param {string} message
 * @param {{ run: (cmd: string, opts?: object) => Promise<any> }} shell
 * @returns {Promise<{launched: true, name: string} | {launched: false, error: string} | null>}
 */
async function tryAppLaunch(message, shell) {
  if (typeof message !== 'string' || !message) return null;
  const appMatch = message.match(APP_LAUNCH_RE);
  if (!appMatch) return null;

  const captured = appMatch[1].toLowerCase();
  if (APP_LAUNCH_FILLER_SET.has(captured)) return null;
  if (APP_LAUNCH_COMMON_NOUNS.has(captured)) return null;

  // Filename heuristic — applies only to open/öffne, not start/starte.
  // "starte node.js" is a legitimate app launch (the runtime is named
  // with a dot); "öffne notes.md" is a file-open request that should
  // defer to path-fallback upstream.
  const isStartVerb = APP_LAUNCH_START_VERB_RE.test(message);
  if (!isStartVerb && APP_LAUNCH_FILENAME_RE.test(message)) return null;

  const name = appMatch[1].trim();
  const platform = process.platform;
  const cmd = platform === 'win32'
    ? `start "" "${name}"`
    : platform === 'darwin'
      ? `open -a "${name}"`
      : `xdg-open "${name}" 2>/dev/null || ${name}`;

  try {
    await shell.run(cmd, { tier: 'read' });
    return { launched: true, name };
  } catch (err) {
    return { launched: false, name, error: err.message };
  }
}

module.exports = {
  tryAppLaunch,
  // exported for white-box testing
  APP_LAUNCH_RE,
  APP_LAUNCH_FILLER_SET,
  APP_LAUNCH_COMMON_NOUNS,
  APP_LAUNCH_FILENAME_RE,
};
