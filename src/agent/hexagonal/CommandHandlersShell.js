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
      this.bus.emit('shell:outcome', {
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

    // Check for semantic folder reference first.
    //
    // v7.5.6 Live-Befund (entdeckt durch openpath-path-extraction tests):
    // pre-fix war `lower.includes(alias)` ein reiner Substring-Match. Das
    // hat false-positives produziert wie "öffne C:\Users\Garrus\Desktop"
    // → matcht "desktop" als Substring im Windows-Pfad und löst die
    // Alias-Auflösung zu ~/Desktop aus statt den expliziten Windows-Pfad
    // weiter zu extrahieren. Lösung: Alias muss von Whitespace ODER
    // Satz-Grenze umgeben sein — NICHT von Pfad-Separatoren (\, /, .).
    // Reines `\b` reicht nicht, weil `\b` zwischen Backslash und 'd'
    // (Non-Word + Word) auch eine Wortgrenze sieht und damit
    // ".garrus\desktop" matchen würde.
    const lower = message.toLowerCase();
    let targetPath = null;
    for (const [alias, resolved] of Object.entries(folderAliases)) {
      const escAlias = alias.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      // Match the alias only when surrounded by whitespace, sentence boundary,
      // or string boundaries — explicitly NOT preceded/followed by a path
      // separator (\ / .) or word character. Treat both sides symmetrically.
      const aliasRe = new RegExp(`(?:^|\\s)${escAlias}(?:$|\\s|[.,;:!?])`, 'i');
      if (aliasRe.test(lower)) {
        // Check if there's a subfolder/file mentioned after the alias
        const afterAlias = message.slice(lower.search(aliasRe) + alias.length + 1).trim();
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
      // Windows path: grab everything from drive letter to end (may include spaces)
      const winPath = message.match(/([A-Za-z]:\\[^\n"']+)/i);
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
      // FIX v6.1.1: Detect application launch requests (öffne firefox, chrome, etc.)
      const appMatch = message.match(/(?:oeffne|öffne|open|start|starte)\s+(?:den\s+|das\s+|die\s+)?(\w[\w\s.-]*\w)/i);
      if (appMatch) {
        const appName = appMatch[1].trim();
        const platform = process.platform;
        const cmd = platform === 'win32' ? `start "" "${appName}"` : platform === 'darwin' ? `open -a "${appName}"` : `xdg-open "${appName}" 2>/dev/null || ${appName}`;
        try {
          const result = await this.shell.run(cmd, 'read');
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
    const fs = require('fs');
    if (!fs.existsSync(targetPath)) {
      return `Pfad existiert nicht: \`${targetPath}\``;
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
      const result = await this.shell.run(cmd, 'read');
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
