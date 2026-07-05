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
const SourceTrust = require('../core/SourceTrust'); // v7.9.30 (S3): origin

// v7.8.3 follow-up: app-launch logic + regex/sets extracted to
// hexagonal/OpenPathAppLaunch.js so this mixin stays compact.
// The helper exports `tryAppLaunch(message, shell)` which returns
// null, a {launched:true,name} result, or a {launched:false,error}.
const { tryAppLaunch } = require('./OpenPathAppLaunch');

const commandHandlersShell = {

  async shellTask(message) {
    if (!this.shell) return this.lang.t('agent.shell_unavailable');

    const task = message
      .replace(/^(?:bitte\s+)?(?:richte|setup|einrichten|installiere|baue|build|deploy|teste|please\s+)?/i, '')
      .replace(/^(?:fuehr|starte?|run|set\s+up|install)\s*/i, '')
      .trim() || message;

    const dirMatch = message.match(/(?:in|im|fuer|for)\s+(?:verzeichnis|ordner|dir|directory)?\s*['"]?([^\s'"]+)['"]?/i);
    const cwd = dirMatch ? dirMatch[1] : undefined;

    const result = await this.shell.plan(task, cwd, { origin: SourceTrust.USER_CHAT });
    return result.summary;
  },

  async shellRun(message) {
    if (!this.shell) return this.lang.t('agent.shell_unavailable');

    // v7.9.28 (F2/G5): normalize capability framing + verb-last so the same
    // resolution path works. "kannst du firefox öffnen" → "öffne firefox".
    // Location forms ("X auf dem desktop öffnen") are left untouched.
    message = String(message).replace(/^\s*(?:kannst|könntest|könnt|kannste|could|can|would|will|würdest)\s+(?:du|ihr|you)\s+(?:bitte\s+|mal\s+|doch\s+)?/i, '');
    {
      const _vl = message.match(/^(.+?)\s+(oeffnen|öffnen|öffne|open|starten|starte|start)\s*[?.!]*\s*$/i);
      if (_vl && _vl[1] && !/(?:auf|in|unter|on|im)\s+(?:dem|den|der|de|the)\s/i.test(message)) {
        const _imp = ({ 'öffnen': 'öffne', 'oeffnen': 'öffne', 'öffne': 'öffne', 'starten': 'starte', 'starte': 'starte', 'open': 'open', 'start': 'start' })[_vl[2].toLowerCase()] || _vl[2];
        message = `${_imp} ${_vl[1]}`.trim();
      }
    }

    let cmd = message.replace(/^[$>]\s*/, '')
      .replace(/^(?:fuehr|execute|run)\s+(?:den\s+)?(?:befehl|kommando|command)\s*/i, '')
      .replace(/\s*aus\s*$/i, '').trim();

    if (!cmd) return this.lang.t('agent.no_command');

    const result = await this.shell.run(cmd, { origin: SourceTrust.USER_CHAT });
    // FIX v6.1.1: Emit outcome for learning systems (LessonsStore, SymbolicResolver)
    if (this.bus) {
      this.bus.fire('shell:outcome', {
        command: cmd, success: result.ok && !result.blocked,
        error: result.blocked ? 'blocked' : result.stderr?.slice(0, 200) || null,
        platform: process.platform,
        backend: 'shell',
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
    // v7.9.28 (field-fix #3): normalize the German separable verb "aufmachen"
    // ("mach den ordner X auf", "mach X auf") to the plain "öffne …" form the
    // extraction below understands. Non-greedy up to the LAST trailing "auf".
    if (typeof message === 'string') {
      const am = message.match(/(?:^|\s)mach(?:e|st)?\s+([\s\S]+?)\s+auf\b\s*[.?!]*$/i);
      if (am && am[1] && am[1].trim()) message = 'öffne ' + am[1].trim();
    }

    // FIX v6.1.1: Resolve semantic folder names (Desktop, Downloads, etc.)
    const os = require('os');
    const path = require('path');
    const home = os.homedir();
    const { setLastDoc } = require('./LastDocStore');
    // Alias base dirs stay the plain home subfolders (deterministic). OneDrive
    // redirection (Windows moves Desktop/Documents/... into OneDrive) is handled
    // existence-checked in the location+name branch below, which searches BOTH
    // the plain and the OneDrive dir for the actual target.
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

    // v7.9.28 (F1+F3): "öffne <name> auf dem <location>" — resolve <name>, which
    // may contain spaces ("Neuer Ordner (8)") or be a shortcut ("Control Center"
    // → Control Center.lnk), INSIDE the real (OneDrive-aware) location folder.
    // Runs before the alias loop so the name wins over the bare location alias.
    if (!targetPath && hasLocationSuffix) {
      const _locMatch = message.match(/\b(?:auf|in|unter|on|im)\s+(?:dem|den|der|de|the)\s+(desktop|schreibtisch|downloads?|dokumente|documents?|bilder|pictures?|musik|music)\b/i);
      if (_locMatch) {
        const _locKey = _locMatch[1].toLowerCase();
        const _locFolder = ({
          desktop: 'Desktop', schreibtisch: 'Desktop',
          download: 'Downloads', downloads: 'Downloads',
          dokumente: 'Documents', document: 'Documents', documents: 'Documents',
          bilder: 'Pictures', picture: 'Pictures', pictures: 'Pictures',
          musik: 'Music', music: 'Music',
        })[_locKey] || 'Desktop';
        // v7.9.28 (F1): search BOTH the plain and the OneDrive-redirected base
        // dir — Windows often redirects Desktop/Documents/... into OneDrive. We
        // pick whichever actually CONTAINS the target, so the result depends on
        // where the file is, not on which base dir happens to exist.
        const _bases = [path.join(home, _locFolder)];
        if (process.platform === 'win32') _bases.push(path.join(home, 'OneDrive', _locFolder));
        let _nm = message
          .replace(/^\s*[/]?(?:oeffne|öffne|open|zeig(?:e)?(?:\s+mir)?|show|starte?)\s+/i, '')
          // v7.9.28 (field-fix B): remove the location phrase IN PLACE (not to
          // end-of-line) so a name AFTER the location survives — the field
          // showed "öffne auf dem desktop Batocera" lost "Batocera" (the old
          // .*$ ate it) and fell to the plain-Desktop path that does not exist
          // on a OneDrive-redirected machine. Now both word orders work.
          .replace(/\b(?:auf|in|unter|on|im)\s+(?:dem|den|der|de|the)\s+(?:desktop|schreibtisch|downloads?|dokumente|documents?|bilder|pictures?|musik|music)\b/i, ' ')
          // strip a leading article and/or leading folder-noun the location
          // removal may expose ("den ordner Batocera" -> "Batocera").
          .replace(/^\s*(?:den\s+|das\s+|die\s+|the\s+)?(?:ordner|folder|verzeichnis|dir|projekt|project)\s+/i, '')
          .replace(/^\s*(?:den\s+|das\s+|die\s+|the\s+)/i, '')
          .replace(/[#.,;:!?]+$/, '')
          .replace(/\s+/g, ' ')
          .trim();
        // A trailing folder-noun ("urlaub folder", "genesis-ordner") is a
        // descriptor the existing alias-loop beforeRe already strips — yield to
        // it. This branch only takes spaced/shortcut names beforeRe misses.
        if (_nm && /[-\s](?:ordner|folder|verzeichnis|dir|projekt|project)\s*$/i.test(_nm)) {
          _nm = '';
        }
        if (_nm) {
          const _fs = require('fs');
          let _hit = null;
          for (const _baseDir of _bases) {
            const _direct = path.join(_baseDir, _nm);
            if (_fs.existsSync(_direct)) { _hit = _direct; break; }
            try {
              const _entries = _fs.readdirSync(_baseDir);
              const _lc = _nm.toLowerCase();
              const _found = _entries.find((e) => e.toLowerCase() === _lc)
                || _entries.find((e) => e.replace(/\.(lnk|exe|url|app)$/i, '').toLowerCase() === _lc);
              if (_found) { _hit = path.join(_baseDir, _found); break; }
            } catch { /* base dir missing */ }
          }
          if (_hit) {
            targetPath = _hit;
          } else {
            return `Im ${_locFolder}-Ordner habe ich \`${_nm}\` nicht gefunden (gesucht in: ${_bases.join(', ')}).`;
          }
        }
      }
    }

    // v7.9.28 (field-fix D): bare drive + name — "öffne in d: <name>",
    // "öffne auf d den ordner <name>", "öffne d:". A single drive letter
    // (with or without a colon) after in/auf/on/im, plus an optional name.
    // Resolve the name as a top-level entry on that drive and open it, so the
    // user need not type the full path. The field showed these fell to the
    // LLM router and were mis-classified as a file-search (listing rootDir).
    // Windows-only (drive letters); a no-op elsewhere.
    if (!targetPath && process.platform === 'win32') {
      const _drv = message.match(/(?:^|\s)(?:oeffne|öffne|open)?\s*(?:in|auf|unter|on|im)\s+["']?([A-Za-z]):?(?=[\s\\/]|$)/i);
      if (_drv) {
        const _driveRoot = `${_drv[1].toUpperCase()}:\\`;
        let _dnm = message.slice(_drv.index + _drv[0].length)
          .replace(/^[\s"'\\/]+/, '')
          .replace(/^(?:den\s+|das\s+|die\s+|the\s+)?(?:ordner|folder|verzeichnis|dir|datei|file)\s+/i, '')
          .replace(/^(?:den\s+|das\s+|die\s+|the\s+)/i, '')
          .replace(/\s+(?:öffnen|oeffnen|open|anzeigen|zeigen)\s*$/i, '')
          .replace(/["']/g, '')
          .replace(/[#.,;:!?]+$/, '')
          .trim();
        // v7.9.28 (field-fix #3): "<name> auf D:" — the name sits BEFORE the
        // drive clause (word order the round-2 fix missed, so it opened D:\
        // root). Extract the text between the open-verb and "auf/in/on <drive>".
        if (!_dnm) {
          _dnm = message.slice(0, _drv.index)
            .replace(/^\s*[/]?(?:oeffne|öffne|open|starte?|zeig(?:e)?(?:\s+mir)?|show)\s+/i, '')
            .replace(/^(?:den\s+|das\s+|die\s+|the\s+)?(?:ordner|folder|verzeichnis|dir|datei|file)\s+/i, '')
            .replace(/^(?:den\s+|das\s+|die\s+|the\s+)/i, '')
            .replace(/["']/g, '')
            .replace(/[#.,;:!?]+\s*$/, '')
            .trim();
        }
        if (!_dnm) {
          targetPath = _driveRoot;               // "öffne d:" -> open the drive root
        } else {
          const _dfs = require('fs');
          const _direct = path.join(_driveRoot, _dnm);
          if (_dfs.existsSync(_direct)) {
            targetPath = _direct;
          } else {
            try {
              const _lc = _dnm.toLowerCase();
              const _f = _dfs.readdirSync(_driveRoot).find((e) => e.toLowerCase() === _lc);
              if (_f) targetPath = path.join(_driveRoot, _f);
            } catch { /* drive not accessible */ }
          }
          if (!targetPath) return `Auf ${_driveRoot} habe ich \`${_dnm}\` nicht gefunden.`;
        }
      }
    }

    // v7.9.28 (field-fix D): bare "öffne d:" (drive letter + colon, no in/auf
    // and no backslash) -> open the drive root. Full paths like "D:\\Foo" are
    // left to the winPath extractor below.
    if (!targetPath && process.platform === 'win32') {
      const _bareDrv = message.match(/(?:^|\s)(?:oeffne|öffne|open)\s+["']?([A-Za-z]):(?=\s|$)/i);
      if (_bareDrv && !/[A-Za-z]:\\/.test(message)) {
        targetPath = `${_bareDrv[1].toUpperCase()}:\\`;
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

    let _notFoundFolder = null;
    if (!targetPath) {
      // Resolve the folder NAME from an "öffne …" command across the common
      // (localized) locations. Try candidates in order: "öffne [den] ordner X"
      // (ordner before name), verb-last "ordner X öffnen", and the FULL bare
      // name after the verb — which also covers "öffne Neuer Ordner (2)", where
      // the name itself contains the word "ordner". Fuzzy match tolerates case,
      // spaces and parentheses ("neuer ordner 2" == "Neuer Ordner (2)").
      const fs = require('fs');
      const _tryCand = (raw) => {
        if (targetPath || !raw) return;
        const c = raw.trim();
        if (!c || /^(?:den|die|das|the|dem|ordner|folder|verzeichnis|dir)$/i.test(c)) return;
        for (const p of [path.join(rootDir, c), path.join(home, 'Desktop', c), path.join(home, 'Documents', c)]) {
          try { if (fs.existsSync(p)) { targetPath = p; return; } } catch { /* skip */ }
        }
        if (typeof this._findNamedTargetAnywhere === 'function') {
          const found = this._findNamedTargetAnywhere(c, { foldersOnly: false });
          if (found) { targetPath = found; return; }
        }
        if (!_notFoundFolder) _notFoundFolder = c;
      };
      let m = message.match(/(?:oeffne|öffne|open|zeig(?:e)?(?:\s+mir)?|show)\s+(?:den\s+|die\s+|das\s+|the\s+)?(?:ordner|folder|verzeichnis|dir)\s+["']?([\w][\w.()\- ]*?)["']?(?=\s+(?:auf|in|unter|on|im)\b|\s+(?:öffnen|oeffnen)\b|[.?!]*\s*$)/i);
      if (m) _tryCand(m[1]);
      if (!targetPath) { m = message.match(/(?:den\s+|die\s+|das\s+)?(?:ordner|folder|verzeichnis)\s+["']?([\w][\w.()\- ]*?)["']?\s+(?:öffnen|oeffnen|open|anzeigen)\b/i); if (m) _tryCand(m[1]); }
      if (!targetPath) { m = message.match(/(?:^|[^\w])(?:oeffne|öffne|open)\s+(?:den\s+|die\s+|das\s+|the\s+)?["']?([\w][\w.()\- ]*?)["']?(?=\s+(?:auf|in|unter|on|im)\b|[.?!]*\s*$)/i); if (m) _tryCand(m[1]); }
    }

    // Explicit folder request that resolved nowhere → say so (don't `start` it
    // as an app). A bare name with no "ordner" keyword may be an app, so it
    // falls through to app-launch below instead.
    if (!targetPath && _notFoundFolder && /\b(?:ordner|folder|verzeichnis)\b/i.test(message)) {
      return `Den Ordner „${_notFoundFolder}" habe ich nirgends gefunden — nenn den Pfad oder das Laufwerk (z.B. „öffne ${_notFoundFolder} auf D:").`;
    }

    if (!targetPath) {
      // v7.8.3 follow-up: app-launch routed through OpenPathAppLaunch
      // helper. Returns null when the message isn't an app launch, an
      // object on either successful or failed launch attempt.
      const launch = await tryAppLaunch(message, this.shell);
      if (launch && launch.launched) return `Anwendung gestartet: ${launch.name}`;
      if (launch && !launch.launched) return `Konnte "${launch.name}" nicht starten: ${launch.error}`;
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
      const result = await this.shell.run(cmd, { tier: 'read', origin: require('../core/SourceTrust').USER_CHAT });
      if (result.ok || result.exitCode === 0 || result.exitCode === 1) {
        // explorer returns exit 1 even on success sometimes
        // v7.9.28 (F4): remember what we opened so "fasse es zusammen" /
        // "wieviele dateien sind drin" can resolve it without re-asking.
        try { setLastDoc(targetPath, require('fs').statSync(targetPath).isDirectory() ? 'folder' : 'file'); } catch { setLastDoc(targetPath, 'folder'); }
        return `Ordner geöffnet: \`${targetPath}\``;
      }
      return `Konnte den Pfad nicht öffnen: ${result.stderr || 'unbekannter Fehler'}`;
    } catch (err) {
      return `Fehler beim Öffnen: ${err.message}`;
    }
  },

  /**
   * v7.9.28 (F7): scoped file search — "suche eine Anwendung in C:\\Tools",
   * "finde ein dokument namens report". cwd comes from a path named in the
   * message (else rootDir); ext from a type-noun; name from the search verb.
   * Backed by the existing FileSearchSkill. A single in-root hit is remembered
   * as last-doc so a follow-up ("öffne es") can act on it.
   */
  async scopedSearch(message) {
    const path = require('path');
    const { FileSearchSkill } = require('../../skills/file-search');
    const { extractPathAfterKeyword, WIN_DRIVE_PATH_RE, cleanPath } = require('./PathExtractVocab');
    const { setLastDoc } = require('./LastDocStore');
    const rootDir = this.fp?.rootDir || process.cwd();

    let cwd = extractPathAfterKeyword(message);
    if (!cwd) { const m = String(message).match(WIN_DRIVE_PATH_RE); if (m) cwd = cleanPath(m[1]); }
    if (!cwd) cwd = rootDir;

    const exts = [];
    if (/\b(?:anwendung|application|app|programm|program|exe)\b/i.test(message)) exts.push('.exe', '.lnk', '.app');
    else if (/\b(?:bild|bilder|image|images|foto|photo|grafik)\b/i.test(message)) exts.push('.png', '.jpg', '.jpeg', '.gif');
    else if (/\b(?:dokument|document|doku|pdf)\b/i.test(message)) exts.push('.pdf', '.docx', '.txt', '.md');
    else exts.push(null);

    let name = null;
    // Prefer an explicit "namens/named/called X" target.
    const named = String(message).match(/(?:namens|named|called|genannt|mit\s+dem\s+namen)\s+["']?([\w][\w.-]*)/i);
    if (named && named[1]) {
      name = named[1];
    } else {
      const nm = String(message).match(/(?:such(?:e|en)?|find(?:e|en)?|search|locate)\s+(?:mir\s+|nach\s+|for\s+|the\s+)?(?:eine?\s+|einen?\s+|a\s+)?([\w][\w.-]*)/i);
      if (nm && nm[1] && !/^(?:anwendung|application|app|programm|program|bild|bilder|image|images|foto|photo|grafik|dokument|document|doku|datei|file|in|im|unter|auf|nach|for|the|mir)$/i.test(nm[1])) {
        name = nm[1];
      }
    }

    const skill = new FileSearchSkill();
    const all = [];
    for (const ext of exts) {
      const input = { cwd, maxResults: 25, maxDepth: 8 };
      if (ext) input.ext = ext;
      if (name) input.pattern = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      try {
        const r = await skill.execute(input);
        if (r && Array.isArray(r.results)) for (const x of r.results) all.push(x);
      } catch { /* skip this ext */ }
    }
    if (all.length === 0) {
      return `Keine passenden Dateien gefunden${name ? ` für "${name}"` : ''} in \`${cwd}\`.`;
    }
    if (all.length === 1) {
      const hit = path.isAbsolute(all[0].file) ? all[0].file : path.join(cwd, all[0].file);
      try { if (hit.startsWith(rootDir)) setLastDoc(hit, 'file'); } catch { /* ignore */ }
    }
    const lines = all.slice(0, 20).map((x) => `- ${x.file} (${x.size})`);
    return `Gefunden (${all.length})${name ? ` für "${name}"` : ''} in \`${cwd}\`:\n${lines.join('\n')}`;
  },

};

module.exports = { commandHandlersShell };
