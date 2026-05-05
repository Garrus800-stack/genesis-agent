// @ts-checked-v7.5.9
// ============================================================
// GENESIS — CommandHandlersSlashHint.js
// v7.5.9 ZIP 7
//
// Renders a clear suggestion when the user types a free-text form
// of a slash-only intent. Without this, the slash-discipline guard
// silently downgraded to 'general' which sent the request to the
// LLM, which usually confabulated a refusal ("I cannot install
// software on your system"). That was both wrong (Genesis CAN
// install via slash) and frustrating to the user.
//
// The intent dispatcher now rewrites slash-only free-text matches
// to `slash-hint`, with the originalIntent preserved. This handler
// reads originalIntent and produces:
//   - the exact slash command the user probably meant
//   - a short reason why the slash is required
//
// The mapping below is small and curated — every entry corresponds
// to an intent in SECURITY_REQUIRED_SLASH or SLASH_ONLY_INTENTS.
// New slash-only intents should add an entry here so the user gets
// a useful suggestion instead of a generic "this is slash-only"
// fallback.
//
// Prototype-Delegation from CommandHandlers.js via Object.assign.
// ============================================================

'use strict';

// Per-intent suggestion templates. The key is the originalIntent
// name from IntentPatterns. The value is a function that takes the
// original message and returns the rendered hint string.
const _HINT_TEMPLATES = {
  'install-software': (msg) => {
    const pkg = _extractInstallTarget(msg);
    const slashForm = pkg ? `/install ${pkg}` : '/install <paketname>';
    return [
      `💡 **Software-Installation ist slash-only** für Sicherheit.`,
      ``,
      `Probier: \`${slashForm}\``,
      ``,
      `Genesis kann installieren — die Slash-Form ist nur die Schutzschicht damit Genesis nicht aus zufälligem Text einen Install triggert.`,
    ].join('\n');
  },
  'open-software': (msg) => {
    // v7.5.9 ZIP8: pronoun resolution — if the user says "öffne es"
    // and we have a recently-installed package in module state,
    // suggest /open <pkg> directly; otherwise generic suggestion.
    let pkg = _extractOpenTarget(msg);
    if (!pkg) {
      try {
        const { commandHandlersInstall } = require('./CommandHandlersInstall');
        const last = (typeof commandHandlersInstall._getLastInstalled === 'function')
          ? commandHandlersInstall._getLastInstalled() : null;
        if (last && last.packageName) pkg = last.packageName;
      } catch { /* module not loaded yet — skip pronoun resolution */ }
    }
    const slashForm = pkg ? `/open ${pkg}` : '/open <name>';
    return [
      `💡 **Anwendung-Start ist slash-only** für Sicherheit.`,
      ``,
      `Probier: \`${slashForm}\``,
    ].join('\n');
  },
  'self-modify': (_msg) =>
    `💡 **Self-Modifikation ist slash-only**. Probier: \`/self-modify\` mit Beschreibung was geändert werden soll.`,
  'self-repair': (_msg) =>
    `💡 **Self-Repair ist slash-only**. Probier: \`/self-repair\``,
  'self-inspect': (_msg) =>
    `💡 **Self-Inspect ist slash-only**. Probier: \`/self-inspect\``,
  'execute-code': (_msg) =>
    `💡 **Code-Ausführung ist slash-only**. Probier: \`/run\` mit dem Code-Block, oder schicke einen \`\`\`-Code-Block direkt.`,
  'execute-file': (_msg) =>
    `💡 **File-Ausführung ist slash-only**. Probier: \`/exec <pfad>\``,
  'self-repair-reset': (_msg) =>
    `💡 **Self-Repair-Reset ist slash-only**. Probier: \`/self-repair-reset\``,
  'daemon': (_msg) =>
    `💡 **Daemon-Steuerung ist slash-only**. Probier: \`/daemon start|stop|status\``,
  'peer': (_msg) =>
    `💡 **Peer-Operationen sind slash-only**. Probier: \`/peer connect <addr>\``,
  'clone': (_msg) =>
    `💡 **Clone-Operationen sind slash-only**. Probier: \`/clone\``,
};

const _DEFAULT_HINT = (origIntent) =>
  `💡 Diese Aktion (\`${origIntent}\`) ist slash-only für Sicherheit. Bitte präfixiere mit \`/\` und einem expliziten Befehl.`;

// Extract the install target from a German/English free-text install
// request. Mirrors the package-name extraction in CommandHandlersInstall
// but does not require this.shell etc. (so it can run outside the full
// handler context).
function _extractInstallTarget(message) {
  if (typeof message !== 'string') return null;
  const lower = message.toLowerCase();
  const articles = new Set(['die','das','den','the','alle','all','ein','eine','einen','a','an','der','dem','des']);
  const verbPrefixes = [
    /(?:installier(?:e|t|st)?|install)\s+(?:mir\s+)?(?:bitte\s+)?(.+)/i,
    /(?:lad(?:e|s|et)?|download)\s+(?:mir\s+)?(.+?)\s+(?:runter|herunter|down)/i,
    /(?:setze?|setup)\s+(.+?)\s+auf\b/i,
  ];
  for (const re of verbPrefixes) {
    const m = lower.match(re);
    if (m && m[1]) {
      const tokens = m[1].trim().split(/\s+/).filter(Boolean);
      if (!tokens.length) continue;
      const first = tokens[0];
      if (articles.has(first)) continue;
      // Collapse "win rar" → "winrar"
      if (tokens.length >= 2) {
        const second = tokens[1];
        if (!articles.has(second) && /^[a-z0-9+]{2,5}$/i.test(second) && /^[a-z]{2,4}$/i.test(first)) {
          return (first + second).toLowerCase();
        }
      }
      if (/^[a-z0-9][a-z0-9._+-]{1,49}$/i.test(first)) return first;
    }
  }
  return null;
}

function _extractOpenTarget(message) {
  if (typeof message !== 'string') return null;
  // v7.5.9 Linux-fix: skip German/English articles after the verb.
  // Pre-fix: "öffne den Downloads-Ordner" → captured "den" (article!),
  // resulting in hint "Probier: /open den" — useless.
  // Now: skip optional articles, then capture the noun.
  const ARTICLES = '(?:den|das|die|dem|der|the)';
  const m = message.match(
    new RegExp(`(?:öffne|starte?|f[üu]hre|run|launch)\\s+(?:mir\\s+)?(?:bitte\\s+)?(?:${ARTICLES}\\s+)?(\\S+)`, 'i')
  );
  if (!m) return null;
  let tok = m[1].toLowerCase();
  if (/^(es|das|ihn|sie|it)$/.test(tok)) return null;
  // Strip German compound suffix "-ordner", "-verzeichnis", "-folder" so
  // "Downloads-Ordner" → "downloads".
  tok = tok.replace(/[-_](ordner|verzeichnis|folder|dir|directory)$/i, '');
  if (/^[a-z0-9][a-z0-9._+-]{1,49}$/i.test(tok)) return tok;
  return null;
}

const CommandHandlersSlashHint = {

  /**
   * Render a slash-form suggestion for a free-text request that hit
   * the slash-discipline guard. Reads originalIntent from the
   * intent-dispatch context.
   *
   * @param {string} message     The original free-text message
   * @param {object} ctx         { history, intent } from ChatOrchestrator
   * @returns {string}           Hint text
   */
  slashHint(message, ctx) {
    const intent = ctx && ctx.intent ? ctx.intent : {};
    const origIntent = intent.originalIntent || 'unknown';
    const template = _HINT_TEMPLATES[origIntent];
    if (template) return template(message);
    return _DEFAULT_HINT(origIntent);
  },
};

module.exports = { commandHandlersSlashHint: CommandHandlersSlashHint };
module.exports.commandHandlersSlashHint._HINT_TEMPLATES = _HINT_TEMPLATES;
module.exports.commandHandlersSlashHint._extractInstallTarget = _extractInstallTarget;
