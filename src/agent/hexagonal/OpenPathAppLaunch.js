// @ts-checked-v7.9.28
// ============================================================
// GENESIS — hexagonal/OpenPathAppLaunch.js
//
// App-launch helper for CommandHandlersShell.openPath.
//
// v7.9.28 (G4/F3): capture the WHOLE phrase after the verb, not just the
// first token — "öffne google chrome" → "google chrome", not "google".
// Trailing fillers ("öffne firefox bitte" → "firefox") are stripped; a
// platform-correct alias maps common browsers/editors to the right launch
// command per OS (names stay language-neutral, command differs per OS).
//
// Single export: tryAppLaunch(message, shell)
//   - { launched: true, name }          on success
//   - { launched: false, name, error }  when shell.run threw
//   - null                              when not an app-launch (caller prints help)
//
// Rejection gates (caller relies on these):
//   1. No verb match                    → null
//   2. Cleaned name is empty/filler     → null
//   3. First token is a common noun     → null
//   4. Filename present + open verb      → null
// ============================================================

'use strict';

const APP_LAUNCH_FILLERS = '(?:bitte|mal|doch|jetzt|schnell|kurz|nochmal|schon|mir|dir|uns|ihn|sie|es|das|den|die|the|please|now|quickly|just|really|also|me|him|her|us|it|that|this)';
const APP_LAUNCH_SEP = '[\\s,;]+';
// Verb-first: verb + leading fillers + the WHOLE rest of the phrase.
const APP_LAUNCH_RE = new RegExp(
  '(?:^|[^\\w])(?:oeffne|öffne|open|start|starte)' + APP_LAUNCH_SEP +
  '(?:' + APP_LAUNCH_FILLERS + APP_LAUNCH_SEP + ')*(.+)$',
  'i'
);

const APP_LAUNCH_FILLER_SET = new Set([
  'bitte','mal','doch','jetzt','schnell','kurz','nochmal','schon',
  'mir','dir','uns','ihn','sie','es','das','den','die','the',
  'please','now','quickly','just','really','also',
  'me','him','her','us','it','that','this',
]);

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

// Platform-correct aliases: same language-neutral name, OS-specific command.
const APP_ALIAS = {
  chrome:  { win32: 'start chrome',  darwin: 'open -a "Google Chrome"',        linux: 'google-chrome' },
  firefox: { win32: 'start firefox', darwin: 'open -a "Firefox"',             linux: 'firefox' },
  edge:    { win32: 'start msedge',  darwin: 'open -a "Microsoft Edge"',      linux: 'microsoft-edge' },
  code:    { win32: 'code',          darwin: 'open -a "Visual Studio Code"',  linux: 'code' },
  vscode:  { win32: 'code',          darwin: 'open -a "Visual Studio Code"',  linux: 'code' },
};

/** Strip trailing fillers + sentence punctuation; return the app name (may be multi-word). */
function _cleanAppName(phrase) {
  let toks = String(phrase || '').trim().split(/[\s,;]+/).filter(Boolean);
  const isFiller = (t) => APP_LAUNCH_FILLER_SET.has(t.toLowerCase().replace(/[.,;:!?]+$/, ''));
  while (toks.length > 1 && isFiller(toks[toks.length - 1])) toks.pop();
  return toks.join(' ').replace(/[.,;:!?]+$/, '').trim();
}

/** Resolve the OS launch command — alias for known apps, sensible default otherwise. */
function _launchCmdFor(name, platform) {
  const lower = name.toLowerCase();
  const words = lower.split(/\s+/);
  for (const key of Object.keys(APP_ALIAS)) {
    if (lower === key || words.includes(key) || lower.includes(key)) {
      const a = APP_ALIAS[key];
      return a[platform] || a.linux;
    }
  }
  if (platform === 'win32') return `start "" "${name}"`;
  if (platform === 'darwin') return `open -a "${name}"`;
  return `xdg-open "${name}" 2>/dev/null || ${name}`;
}

/**
 * Attempt to launch an application named in a natural-language message.
 * @param {string} message
 * @param {{ run: (cmd: string, opts?: object) => Promise<any> }} shell
 * @returns {Promise<{launched: true, name: string} | {launched: false, name: string, error: string} | null>}
 */
async function tryAppLaunch(message, shell) {
  if (typeof message !== 'string' || !message) return null;
  const appMatch = message.match(APP_LAUNCH_RE);
  if (!appMatch) return null;

  const name = _cleanAppName(appMatch[1]);
  if (!name) return null;

  const lowerName = name.toLowerCase();
  // Gate 2: a bare filler is not an app.
  if (APP_LAUNCH_FILLER_SET.has(lowerName)) return null;
  // Gate 3: first token is a generic common noun ("starte den Browser firefox"
  // → "Browser firefox" → reject; user should name the app directly).
  const firstTok = lowerName.split(/\s+/)[0];
  if (APP_LAUNCH_COMMON_NOUNS.has(firstTok)) return null;

  // Gate 4: filename heuristic — applies only to open/öffne, not start/starte.
  // "starte node.js" is a runtime launch; "öffne notes.md" is a file-open.
  const isStartVerb = APP_LAUNCH_START_VERB_RE.test(message);
  if (!isStartVerb && APP_LAUNCH_FILENAME_RE.test(message)) return null;

  const platform = process.platform;
  const cmd = _launchCmdFor(name, platform);

  try {
    // v7.9.28 (field-fix E): bound the launch. "öffne google chrome" hung
    // indefinitely because shell.run had no timeout — if `start <app>` cannot
    // resolve the app via App Paths it can block. openSoftware -> _launch
    // already used a 5s bound; match it here so the chat always returns.
    await shell.run(cmd, { tier: 'read', timeout: 8000, origin: require('../core/SourceTrust').USER_CHAT });
    return { launched: true, name };
  } catch (err) {
    return { launched: false, name, error: err.message };
  }
}

module.exports = {
  tryAppLaunch,
  _cleanAppName,
  _launchCmdFor,
  APP_ALIAS,
  // exported for white-box testing
  APP_LAUNCH_RE,
  APP_LAUNCH_FILLER_SET,
  APP_LAUNCH_COMMON_NOUNS,
  APP_LAUNCH_FILENAME_RE,
};
