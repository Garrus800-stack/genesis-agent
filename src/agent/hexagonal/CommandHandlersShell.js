// @ts-checked-v5.7
// ============================================================
// GENESIS — CommandHandlersShell.js (v7.4.2 "Kassensturz")
//
// Extracted from CommandHandlers.js as part of the v7.4.2 domain
// split. Handles Shell execution and filesystem operations:
//   - shellTask    — multi-step planned execution via ShellAgent.plan
//   - shellRun     — single command execution via ShellAgent.run
//   - projectScan  — open workspace scan (ShellAgent.openWorkspace)
//   - openPath     — open folder/file/app in OS explorer
//
// openPath grouped here because it is filesystem/shell-adjacent
// and uses this.shell.run.
//
// Prototype-Delegation from CommandHandlers.js via Object.assign.
// External API unchanged.
// ============================================================

'use strict';

const commandHandlersShell = {

  async shellTask(message) {
    if (!this.shell) return this.lang.t('agent.shell_unavailable');

    const task = message
      .replace(/^(?:bitte\s+)?(?:richte|setup|einrichten|installiere|baue|build|deploy|teste|please\s+)?/i, '')
      .replace(/^(?:fuehr|starte?|run|set\s+up|install)\s*/i, '')
      .trim() || message;

    const dirMatch = message.match(/(?:in|im|fuer|for)\s+(?:verzeichnis|ordner|dir|directory)?\s*['"]?([^\s'"]+)['"]?/i);
    const cwd = dirMatch ? dirMatch[1] : undefined;

    const result = await this.shell.plan(task, cwd);
    return result.summary;
  },

  async shellRun(message) {
    if (!this.shell) return this.lang.t('agent.shell_unavailable');

    let cmd = message.replace(/^[$>]\s*/, '')
      .replace(/^(?:fuehr|execute|run)\s+(?:den\s+)?(?:befehl|kommando|command)\s*/i, '')
      .replace(/\s*aus\s*$/i, '').trim();

    if (!cmd) return this.lang.t('agent.no_command');

    const result = await this.shell.run(cmd);
    // FIX v6.1.1: Emit outcome for learning systems (LessonsStore, SymbolicResolver)
    if (this.bus) {
      this.bus.fire('shell:outcome', {
        command: cmd, success: result.ok && !result.blocked,
        error: result.blocked ? 'blocked' : result.stderr?.slice(0, 200) || null,
        platform: process.platform,
      }, { source: 'CommandHandlers' });
    }
    const lines = [`**$ ${cmd}**`, ''];
    if (result.blocked) {
      lines.push(`**${this.lang.t('agent.blocked_command', { reason: result.stderr })}**`);
    } else if (result.ok) {
      lines.push(result.stdout.trim() ? '```\n' + result.stdout.trim().slice(0, 3000) + '\n```' : `*${this.lang.t('agent.no_output')}*`);
      lines.push(`\n*${result.duration}ms*`);
    } else {
      if (result.stdout.trim()) lines.push('```\n' + result.stdout.trim().slice(0, 1500) + '\n```');
      lines.push(`**${this.lang.t('agent.error')} (exit ${result.exitCode}):**`);
      lines.push('```\n' + result.stderr.slice(0, 1500) + '\n```');
    }
    return lines.join('\n');
  },

  async projectScan(message) {
    if (!this.shell) return this.lang.t('agent.shell_unavailable');

    const dirMatch = message.match(/(?:verzeichnis|ordner|dir|pfad|path|directory)\s*['":]?\s*([^\s'"]+)/i);
    const dir = dirMatch ? dirMatch[1] : undefined;

    const result = await this.shell.openWorkspace(dir || this.fp?.rootDir || process.cwd());
    return result.description;
  },

  async openPath(message) {
    if (!this.shell) return this.lang.t('agent.shell_unavailable');

    // v7.5.9 Linux-fix: strip leading slash-command (/open, /öffne, /oeffne)
    // so the unix-path regex below doesn't match it as a literal path.
    // Pre-fix: "/open ~/Dokumente" → unixPath regex `(?:^|\s)\/[^\s"']+`
    // matched "/open" at column 0 → "Pfad existiert nicht: /open".
    if (typeof message === 'string') {
      message = message.replace(/^\s*\/(?:open|öffne|oeffne)(?=\s|$)/i, '').trim();
    }

    // FIX v6.1.1: Resolve semantic folder names (Desktop, Downloads, etc.)
    const os = require('os');
    const path = require('path');
    const home = os.homedir();
    const folderAliases = {
      'desktop': path.join(home, 'Desktop'),
      'schreibtisch': path.join(home, 'Desktop'),
      'downloads': path.join(home, 'Downloads'),
      'dokumente': path.join(home, 'Documents'),
      'documents': path.join(home, 'Documents'),
      'bilder': path.join(home, 'Pictures'),
      'pictures': path.join(home, 'Pictures'),
      'musik': path.join(home, 'Music'),
      'music': path.join(home, 'Music'),
      'home': home,
    };

    // Alias-resolver: alias must be surrounded by whitespace or sentence
    // boundary, NOT path separators (\ / .) — pre-fix `lower.includes`
    // matched "desktop" inside "C:\Users\X\Desktop" and false-resolved.
    const lower = message.toLowerCase();
    let targetPath = null;

    // v7.5.8: Anaphora-resolver — "der/dein/mein genesis(-)ordner" and
    // ".genesis(-)ordner" variants resolve to rootDir / rootDir/.genesis /
    // rootDir/docs. Required possessive guards against accidental match
    // of literal "genesis" (e.g. "starte genesis" → app launch).
    const rootDir = this.fp?.rootDir || process.cwd();
    const POSSESSIVE = '(?:der|dem|den|das|ein(?:en|em|er)?|dein(?:e|er|em|en)?|mein(?:e|er|em|en)?|sein(?:e|er|em|en)?|unser(?:e|er|em|en)?|euer|eurem|euren|eure)';
    const FOLDER_NOUN = '(?:[-\\s](?:ordner|folder|verzeichnis|dir|projekt|project))?';
    const anaphoraResolvers = [
      { pattern: new RegExp(`\\b${POSSESSIVE}\\s+\\.genesis${FOLDER_NOUN}\\b`, 'i'),
        target: () => path.join(rootDir, '.genesis') },
      { pattern: new RegExp(`\\b${POSSESSIVE}\\s+(?:doc|docs|dokumentation|dokumente)${FOLDER_NOUN}\\b`, 'i'),
        target: () => path.join(rootDir, 'docs') },
      { pattern: new RegExp(`\\b${POSSESSIVE}\\s+genesis${FOLDER_NOUN}\\b`, 'i'),
        target: () => rootDir },
    ];

    // v7.6.3 Bug A+B: skip anaphora if location-suffix present (see v763 test).
    const hasLocationSuffix = /\b(?:auf|in|unter|on|im)\s+(?:dem|den|der|de|the)\s+(?:desktop|schreibtisch|downloads?|dokumente|documents?|bilder|pictures?|musik|music|home)\b/i.test(message);
    if (!hasLocationSuffix) {
      for (const { pattern, target } of anaphoraResolvers) {
        if (pattern.test(message)) { targetPath = target(); break; }
      }
    }

    for (const [alias, resolved] of Object.entries(folderAliases)) {
      if (targetPath) break;  // anaphora-resolver already matched
      const escAlias = alias.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      // v7.5.9 ZIP2 v3 (Bug 2): "X ordner auf dem desktop" — subfolder named
      // BEFORE alias. v7.6.3 Bug B follow-on: also accept hyphenated form
      // "WORD-ordner" so "genesis-ordner auf dem desktop" extracts genesis.
      const beforeRe = new RegExp(`(?:öffne|oeffne|open|zeig(?:e)?(?:\\s+mir)?|show)?\\s*(?:den\\s+|das\\s+|die\\s+|the\\s+)?([\\w][\\w-]*?)(?:-(?:ordner|folder|verzeichnis|dir|projekt|project)|\\s+(?:ordner|folder|verzeichnis|dir|projekt|project))\\s+(?:auf|in|unter|on|im)\\s+(?:dem|den|der|de|the)\\s+${escAlias}\\b`, 'i');
      const beforeMatch = message.match(beforeRe);
      if (beforeMatch && beforeMatch[1]) {
        targetPath = path.join(resolved, beforeMatch[1].trim());
        break;
      }

      // Match the alias only when surrounded by whitespace, sentence boundary,
      // or string boundaries — explicitly NOT preceded/followed by a path
      // separator (\ / .) or word character.
      const aliasRe = new RegExp(`(?:^|\\s)(${escAlias})(?:$|\\s|[.,;:!?])`, 'i');
      const aliasMatch = lower.match(aliasRe);
      if (aliasMatch) {
        // v7.5.9 B3: capture-group + indexOf instead of arithmetic. Pre-fix
        // used `lower.search(aliasRe) + alias.length + 1` which assumed the
        // `(?:^|\s)` prefix consumed exactly one char; for the `^`-branch
        // (alias at string-start) the prefix is zero-width, so the +1
        // skipped one char too many. Worked by luck for whitespace-separated
        // input ("desktop bilder" → trim eats the gap), broke for `.`-separated
        // input ("desktop.txt" → lost the leading dot of the subpath).
        const aliasInMatch = aliasMatch[0].toLowerCase().indexOf(alias.toLowerCase());
        const afterIdx = aliasMatch.index + aliasInMatch + alias.length;
        // v7.5.9 B3: strip leading punctuation (,;:!?) so "desktop, bilder"
        // doesn't extract "," as the subfolder. The dot is preserved on
        // purpose ("desktop.txt" → ".txt" → joins to <desktop>/.txt).
        const afterAlias = message.slice(afterIdx).trim().replace(/^[,;:!?\s]+/, '');
        const subMatch = afterAlias.match(/(?:ordner|folder|datei|file)?\s*[\"']?([^\s\"']+)[\"']?/i);
        targetPath = subMatch && subMatch[1] ? path.join(resolved, subMatch[1]) : resolved;
        break;
      }
    }

    if (!targetPath) {
      // Extract path from message — try quoted first, then Windows full path,
      // then Unix absolute, then relative.
      //
      // v7.5.6 Live-Befund (2026-05-02): Pre-fix matched any "/foo/bar" anywhere
      // in the message — so "zeig mir den inhalt von .genesis/self-statements/
      // 2026-05-02.jsonl" was greedy-matched as "/self-statements/2026-05-02.
      // jsonl", a bogus absolute path that Windows-Explorer falls back to its
      // Documents default for. Two fixes:
      //   (1) anchor unix-absolute regex at start-of-string OR whitespace, so
      //       "/foo" matches as path but "x/y/z" does not slice out "/y/z".
      //   (2) add relative-path support (./foo, ../foo, .name/foo) — resolved
      //       against the project rootDir (via this.fp.rootDir, same pattern
      //       openWorkspace uses on Z. 76).
      const quoted = message.match(/["']([^"']+)["']/);
      // Windows path: drive letter + backslash + non-whitespace chars.
      // v7.5.8 fix: pre-fix `[^\n"']+` greedy-matched to end-of-line, so
      // "C:\Foo\Bar das ist mein Ordner" was taken as the entire string
      // instead of just "C:\Foo\Bar". Stop at whitespace; paths containing
      // spaces must be quoted (the quoted-match path above handles those).
      const winPath = message.match(/([A-Za-z]:\\[^\s"']*)/);
      // Unix absolute: must be at start-of-string or after whitespace, so
      // "/etc/passwd" matches but "x/y/z" does not slice out "/y/z".
      const unixPath = message.match(/(?:^|\s)(~\/[^\s"']+|\/[^\s"']+)/);
      // Relative: ./foo, ../foo, .name/foo (e.g. .genesis/self-statements/...)
      // Anchored same as unixPath. Captures dot-prefixed relative names too.
      const relPath = message.match(/(?:^|\s)(\.{1,2}\/[^\s"']+|\.[A-Za-z][\w\-]*\/[^\s"']+)/);

      if (quoted) {
        targetPath = quoted[1].trim();
      } else if (winPath) {
        targetPath = winPath[1].trim().replace(/[.,;!?]+$/, ''); // strip trailing punctuation
      } else if (unixPath) {
        targetPath = unixPath[1].replace(/[.,;!?]+$/, '');
      } else if (relPath) {
        // Resolve relative path against the project rootDir, same anchor
        // openWorkspace uses on Z. 76.
        const rel = relPath[1].replace(/[.,;!?]+$/, '');
        const rootDir = this.fp?.rootDir || process.cwd();
        targetPath = path.resolve(rootDir, rel);
      }
    }

    if (!targetPath) {
      // v7.5.9 ZIP2 v3 (Bug 3): "öffne den X ordner" — try X as subdir
      // under rootDir, then Desktop, then Documents BEFORE app-launch.
      // Pre-fix routed to appMatch and tried to launch "X ordner" as app.
      const m = message.match(/(?:oeffne|öffne|open|zeig(?:e)?(?:\s+mir)?|show)\s+(?:den\s+|das\s+|die\s+|the\s+)?([\w][\w-]*)\s+(?:ordner|folder|verzeichnis|dir)\b/i);
      if (m && m[1]) {
        const fs = require('fs');
        const cand = m[1].trim();
        for (const p of [path.join(rootDir, cand), path.join(home, 'Desktop', cand), path.join(home, 'Documents', cand)]) {
          if (fs.existsSync(p)) { targetPath = p; break; }
        }
        if (!targetPath) return `Den Ordner "${cand}" konnte ich nicht finden — weder unter ${rootDir}, noch im Desktop oder Documents.`;
      }
    }

    if (!targetPath) {
      // FIX v6.1.1: Detect application launch requests (öffne firefox, chrome, etc.)
      const appMatch = message.match(/(?:oeffne|öffne|open|start|starte)\s+(?:den\s+|das\s+|die\s+)?(\w[\w\s.-]*\w)/i);
      if (appMatch) {
        const appName = appMatch[1].trim();
        const platform = process.platform;
        const cmd = platform === 'win32' ? `start "" "${appName}"` : platform === 'darwin' ? `open -a "${appName}"` : `xdg-open "${appName}" 2>/dev/null || ${appName}`;
        try {
          const result = await this.shell.run(cmd, { tier: 'read' });
          return `Anwendung gestartet: ${appName}`;
        } catch (err) { return `Konnte "${appName}" nicht starten: ${err.message}`; }
      }
      return 'Welchen Ordner oder welche Datei soll ich öffnen? Gib mir den Pfad an.';
    }

    // v7.5.6 Live-Befund (entdeckt nach Bug #7-Fix): Bug #7 hat den Pfad
    // korrekt resolved, aber wenn der Pfad gar nicht existiert, ruft
    // `explorer "<bogus-path>"` auf Windows den Default-Documents-Ordner
    // auf statt einer Fehlermeldung. Pre-Fix sah der User: "Ordner geöffnet:
    // C:\...\.genesis\foo" + Documents-Fenster geöffnet — irreführend.
    // Fix: vor dem OS-Open-Call existsSync prüfen, bei Nicht-Existenz
    // eine klare deutsche Fehlermeldung. Fragt explizit nicht den shell-
    // tool ab, sondern direkt `fs` weil das billiger und plattform-
    // konsistent ist.
    // v7.5.9 Linux-fix: expand leading "~" / "~/" to user home BEFORE
    // existsSync. Pre-fix: "/open ~/Dokumente" → after slash-strip
    // targetPath was literal "~/Dokumente". fs.existsSync doesn't
    // shell-expand, so it returned false → "Pfad existiert nicht: ~/Dokumente".
    if (typeof targetPath === 'string' && (targetPath === '~' || targetPath.startsWith('~/') || targetPath.startsWith('~\\'))) {
      targetPath = path.join(home, targetPath.slice(2) || '');
    }

    const fs = require('fs');
    if (!fs.existsSync(targetPath)) {
      // v7.5.9 Linux-fix: many German Linux distros use localized folder
      // names — `~/Dokumente` exists, `~/Documents` does not. If the
      // requested path doesn't exist but a German-localized sibling does,
      // try that. Symmetrical: also `~/Documents` → `~/Dokumente`.
      const localizedSiblings = {
        'Documents': 'Dokumente', 'Dokumente': 'Documents',
        'Downloads': 'Downloads',  // same on both
        'Pictures':  'Bilder',     'Bilder':  'Pictures',
        'Music':     'Musik',      'Musik':   'Music',
        'Videos':    'Videos',
        'Desktop':   'Schreibtisch', 'Schreibtisch': 'Desktop',
      };
      const baseName = path.basename(targetPath);
      if (localizedSiblings[baseName]) {
        const sibling = path.join(path.dirname(targetPath), localizedSiblings[baseName]);
        if (fs.existsSync(sibling)) {
          targetPath = sibling;
        } else {
          return `Pfad existiert nicht: \`${targetPath}\``;
        }
      } else {
        return `Pfad existiert nicht: \`${targetPath}\``;
      }
    }

    // Determine OS-specific open command
    const platform = process.platform;
    let cmd;
    if (platform === 'win32') {
      cmd = `explorer "${targetPath}"`;
    } else if (platform === 'darwin') {
      cmd = `open "${targetPath}"`;
    } else {
      cmd = `xdg-open "${targetPath}"`;
    }

    try {
      const result = await this.shell.run(cmd, { tier: 'read' });
      if (result.ok || result.exitCode === 0 || result.exitCode === 1) {
        // explorer returns exit 1 even on success sometimes
        return `Ordner geöffnet: \`${targetPath}\``;
      }
      return `Konnte den Pfad nicht öffnen: ${result.stderr || 'unbekannter Fehler'}`;
    } catch (err) {
      return `Fehler beim Öffnen: ${err.message}`;
    }
  },

};

module.exports = { commandHandlersShell };
