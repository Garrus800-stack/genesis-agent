'use strict';
// CommandHandlersFileView — v7.9.28 (field-fix #3)
//
// Deterministic local file/folder handlers: list a folder, read a file, create
// a file — straight through fs, with no LLM and no shell. Extracted from
// CommandHandlersShell when this second domain (file view/create, distinct from
// shell execution and path opening) crossed the mixin soft-cap, per the
// split-when-a-second-domain-grows rule. Names on Desktop/Documents/... resolve
// against both the plain and the OneDrive-redirected base so the user need not
// type full paths; summaries ("fasse X zusammen") stay on the LLM path.

const commandHandlersFileView = {

  /**
   * v7.9.28 (field-fix #3): the real, localized user directories. On Linux the
   * desktop is often "~/Schreibtisch" (German) or "~/Bureau" (French), not
   * "~/Desktop" — read the XDG user-dirs config for the true paths, then fall
   * back to the localized folder names. Windows keeps the English internal
   * names plus their OneDrive-redirected copies. Returns existing absolute dirs
   * for one kind, or (kind omitted) a flat list across all kinds.
   */
  _userDirs(kind) {
    const os = require('os');
    const fs = require('fs');
    const path = require('path');
    const home = os.homedir();
    const NAMES = {
      desktop: ['Desktop', 'Schreibtisch', 'Bureau', 'Escritorio', 'Skrivbord'],
      documents: ['Documents', 'Dokumente', 'Documentos', 'Documenti'],
      downloads: ['Downloads', 'Download', 'Téléchargements'],
      pictures: ['Pictures', 'Bilder', 'Images', 'Imágenes', 'Immagini'],
      music: ['Music', 'Musik', 'Musique', 'Música', 'Musica'],
      videos: ['Videos', 'Vidéos', 'Filme'],
    };
    const XDG = { desktop: 'DESKTOP', documents: 'DOCUMENTS', downloads: 'DOWNLOAD', pictures: 'PICTURES', music: 'MUSIC', videos: 'VIDEOS' };
    const kinds = kind ? [kind] : Object.keys(NAMES);
    let xdg = '';
    if (process.platform === 'linux') { try { xdg = fs.readFileSync(path.join(home, '.config', 'user-dirs.dirs'), 'utf8'); } catch { /* none */ } }
    const out = [];
    for (const k of kinds) {
      if (xdg && XDG[k]) { const m = xdg.match(new RegExp('XDG_' + XDG[k] + '_DIR="([^"]*)"')); if (m && m[1]) out.push(m[1].replace(/^\$HOME/, home)); }
      for (const n of (NAMES[k] || [])) { out.push(path.join(home, n)); out.push(path.join(home, 'OneDrive', n)); }
    }
    return [...new Set(out)].filter((d) => { try { return fs.existsSync(d); } catch { return false; } });
  },

  /**
   * v7.9.28 (field-fix #3): normalize a folder/file name for fuzzy comparison —
   * lowercase and drop everything that isn't a letter or digit. So a typed
   * "neuer ordner 2" matches the real folder "Neuer Ordner (2)".
   */
  _normName(s) { return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ''); },

  /**
   * v7.9.28 (field-fix #3): find a folder/file by NAME across the common user
   * locations when no location is given — Desktop/Documents/Downloads/... in
   * their localized and OneDrive-redirected forms, the project root, and (on
   * Windows) the drive roots C:/D:/E:. The field showed "öffne GMxBGxx" (a
   * folder on D:) got launched as an application. Case-, extension- and
   * punctuation-insensitive (fuzzy); prefers folders when foldersOnly is set.
   * Returns the absolute path or null.
   */
  _findNamedTargetAnywhere(name, { foldersOnly = false } = {}) {
    const os = require('os');
    const fs = require('fs');
    const path = require('path');
    const clean = String(name || '').trim().replace(/["']/g, '').replace(/[.,;:!?]+$/, '').trim();
    if (!clean || clean.length < 2) return null;
    const lc = clean.toLowerCase();
    const normQ = this._normName(clean);
    const home = os.homedir();
    const rootDir = (this.fp && this.fp.rootDir) || process.cwd();
    const bases = [rootDir, ...this._userDirs(), home];
    if (process.platform === 'win32') { for (const d of ['C:\\', 'D:\\', 'E:\\']) bases.push(d); }
    const uniqueBases = [...new Set(bases)];
    const isDir = (p) => { try { return fs.statSync(p).isDirectory(); } catch { return false; } };
    // 1. exact join
    for (const base of uniqueBases) {
      const p = path.join(base, clean);
      try { if (fs.existsSync(p) && (!foldersOnly || isDir(p))) return p; } catch { /* skip */ }
    }
    // 2. case/extension-insensitive, then normalized (fuzzy) readdir match
    for (const base of uniqueBases) {
      let entries;
      try { entries = fs.readdirSync(base); } catch { continue; }
      const hit = entries.find((e) => e.toLowerCase() === lc)
        || entries.find((e) => e.replace(/\.[^.]+$/, '').toLowerCase() === lc)
        || (normQ.length >= 3 && entries.find((e) => this._normName(e) === normQ))
        || (normQ.length >= 3 && entries.find((e) => this._normName(e.replace(/\.[^.]+$/, '')) === normQ));
      if (hit) { const p = path.join(base, hit); if (!foldersOnly || isDir(p)) return p; }
    }
    return null;
  },

  /**
   * v7.9.28 (field-fix #3): resolve "auf dem <location> <name>" to an absolute
   * path, searching BOTH the plain and the OneDrive-redirected base dir (Windows
   * redirects Desktop/Documents/... into OneDrive). Matches a file by exact name
   * or by basename (extension-insensitive), so "Textdokument (neu) (6)" finds
   * "Textdokument (neu) (6).txt". Returns the hit path or null. Shared by
   * listFolder and readFile so neither depends on the LLM or shell quoting.
   */
  _resolveLocationName(message) {
    const os = require('os');
    const path = require('path');
    const fs = require('fs');
    const home = os.homedir();
    const locMatch = message.match(/\b(?:auf|in|unter|on|im)\s+(?:dem\s+|den\s+|der\s+|de\s+|the\s+|meinem\s+|my\s+)?(desktop|schreibtisch|downloads?|dokumente|documents?|bilder|pictures?|musik|music)\b/i);
    if (!locMatch) return null;
    const locKey = locMatch[1].toLowerCase();
    const kind = ({
      desktop: 'desktop', schreibtisch: 'desktop',
      download: 'downloads', downloads: 'downloads',
      dokumente: 'documents', document: 'documents', documents: 'documents',
      bilder: 'pictures', picture: 'pictures', pictures: 'pictures',
      musik: 'music', music: 'music',
    })[locKey] || 'desktop';
    // Localized, XDG-aware base dirs (Schreibtisch/Dokumente/… on Linux, plus
    // OneDrive-redirected copies on Windows) — a folder on the German desktop
    // "~/Schreibtisch" resolves as well as "~/Desktop".
    const bases = this._userDirs(kind);
    if (bases.length === 0) bases.push(path.join(home, 'Desktop'));
    let nm = message
      .replace(/\b(?:auf|in|unter|on|im)\s+(?:dem\s+|den\s+|der\s+|de\s+|the\s+|meinem\s+|my\s+)?(?:desktop|schreibtisch|downloads?|dokumente|documents?|bilder|pictures?|musik|music)\b/i, ' ')
      .replace(/^\s*[/]?(?:was\s+steht\s+(?:in|im)|was\s+ist\s+(?:in|im)|lies|read|zeig(?:e)?(?:\s+mir)?(?:\s+den\s+inhalt(?:\s+von|\s+der\s+datei)?)?|show|öffne|oeffne|open|starte?|f?ass(?:e|t)?)\s+/i, '')
      // count/list lead-in — absorb any filler (incl. typos like "sin" for
      // "sind") between the noun and an "in/im" connector, else just the noun
      // plus an optional verb. This makes "welche datein sin in <name>" resolve
      // exactly like "wieviele dateien sind in <name>".
      .replace(/^\s*(?:wie\s*viele?|welche|welches|how\s+many|which|what|list|liste?|zeig(?:e)?)\s+(?:datei(?:en|n)?|ordner|elemente|dinge|files?|folders?|items?)\b(?:[\s\S]*?\b(?:in|im|inside|innerhalb|aus)\s+(?:dem\s+|der\s+|den\s+|the\s+)?|\s+(?:sind\s+|are\s+|sin\s+|is\s+|liegen\s+)?)/i, '')
      .replace(/^\s*liste?\s+(?:mir\s+)?(?:den\s+)?(?:ordner)?inhalt\s+(?:von|des|vom)?\s*/i, '')
      .replace(/^\s*(?:den\s+|das\s+|die\s+|the\s+)?(?:datei|file|dokument|document|ordner|folder|verzeichnis)\s+/i, '')
      .replace(/^\s*(?:den\s+|das\s+|die\s+|the\s+)/i, '')
      .replace(/["']/g, '')
      .replace(/[#.,;:!?]+$/, '')
      .replace(/\s+/g, ' ')
      .trim();
    // strip a trailing "auf dem desktop"-less descriptor that survived
    if (!nm) {
      // "wieviele dateien auf dem desktop" — no name → the location folder itself
      for (const baseDir of bases) { if (fs.existsSync(baseDir)) return baseDir; }
      return null;
    }
    const lc = nm.toLowerCase();
    const normQ = this._normName(nm);
    for (const baseDir of bases) {
      const direct = path.join(baseDir, nm);
      if (fs.existsSync(direct)) return direct;
      try {
        const entries = fs.readdirSync(baseDir);
        const found = entries.find((e) => e.toLowerCase() === lc)
          || entries.find((e) => e.replace(/\.[^.\\/]+$/, '').toLowerCase() === lc)
          || entries.find((e) => e.replace(/\.(lnk|exe|url|app)$/i, '').toLowerCase() === lc)
          || (normQ.length >= 3 && entries.find((e) => this._normName(e) === normQ))
          || (normQ.length >= 3 && entries.find((e) => this._normName(e.replace(/\.[^.]+$/, '')) === normQ));
        if (found) return path.join(baseDir, found);
      } catch { /* base dir missing */ }
    }
    return null;
  },

  /**
   * v7.9.28 (field-fix #3, Bug C): deterministic folder listing. The field
   * showed the LLM chat-path listing was unreliable — a code model called a
   * shell tool that echoed only the command, or a OneDrive readdir with
   * withFileTypes threw. This resolves the folder (explicit path, a named
   * location, or the last-opened folder) and lists it straight from fs — no
   * LLM, no shell. Robust readdir falls back to name+stat when withFileTypes
   * fails (OneDrive cloud placeholders).
   */
  async listFolder(message) {
    const fs = require('fs');
    const path = require('path');
    const { getLastDoc, setLastDoc } = require('./LastDocStore');
    const { _isCriticalSystemPath, _isSecretFile } = require('../core/shell/ShellSafety');
    let folder = null;
    const quoted = message.match(/["']([^"']+)["']/);
    if (quoted) folder = quoted[1].trim();
    if (!folder) { const wp = message.match(/([A-Za-z]:\\[^\s"']*)/); if (wp) folder = wp[1]; }
    if (!folder) folder = this._resolveLocationName(message);
    if (!folder) {
      // Named folder without a location — "welche dateien sind in Neuer Ordner
      // (8) enthalten". Extract the name and search the common locations.
      const nm = message.match(/\bin\s+(?:dem\s+|der\s+|den\s+)?([\w][\w.()\- ]*?)(?:\s+(?:enthalten|drin|sind|liegen)\b|[.?!]*\s*$)/i)
        || message.match(/(?:ordner|folder|verzeichnis)\s+["']?([\w][\w.()\- ]*?)["']?(?:\s+(?:enthalten|drin)\b|[.?!]*\s*$)/i);
      if (nm && nm[1] && typeof this._findNamedTargetAnywhere === 'function') {
        const candName = nm[1].trim().replace(/\s+(?:enthalten|drin|sind)$/i, '').trim();
        if (candName && !/^(?:dem|der|den|das|die|the)$/i.test(candName)) {
          const found = this._findNamedTargetAnywhere(candName, { foldersOnly: true });
          if (found) folder = found;
        }
      }
    }
    if (!folder) { const last = getLastDoc(); if (last && last.kind === 'folder') folder = last.path; }
    if (!folder) return 'Welchen Ordner soll ich auflisten? Öffne ihn zuerst, gib den Pfad an, oder nenn den Ort (z.B. „… auf dem Desktop").';
    const absLower = String(folder).toLowerCase();
    if (_isCriticalSystemPath(absLower, process.platform === 'win32') || _isSecretFile(absLower)) {
      return 'Dieser Ordner ist geschützt und kann nicht aufgelistet werden.';
    }
    // Remember this folder so a follow-up anaphora ("welche dateien sind drin",
    // "liste sie auf") resolves without re-typing the path. The field showed a
    // count query left no last-doc, so the suggested follow-up then failed.
    try { setLastDoc(folder, 'folder'); } catch { /* ignore */ }
    let entries;
    try {
      entries = fs.readdirSync(folder, { withFileTypes: true });
    } catch (e1) {
      // OneDrive placeholders can break withFileTypes — fall back to name+stat.
      try {
        entries = fs.readdirSync(folder).map((n) => {
          let isDir = false;
          try { isDir = fs.statSync(path.join(folder, n)).isDirectory(); } catch { /* keep false */ }
          return { name: n, isFile: () => !isDir, isDirectory: () => isDir };
        });
      } catch (e2) {
        return `Konnte den Ordner \`${folder}\` nicht lesen: ${e2.message}`;
      }
    }
    const files = entries.filter((e) => e.isFile()).map((e) => e.name);
    const dirs = entries.filter((e) => e.isDirectory()).map((e) => e.name);
    // "wieviele/wie viele" asks for a count → answer with the number; "welche"
    // and the rest ask which → answer with the full list. (The field showed a
    // "wieviele" query dumping the whole list, which fit "welche" better.)
    const wantsCount = /\bwie\s*viele?\b|\bhow\s+many\b/i.test(message)
      && !/\bwelche\b|\bliste?\b|\bzeig|\bnenn|\bnamen?\b|\bauflisten\b|\bwhich\b|\blist\b|\bshow\b|\bwhat\s+files?\b|\bnames?\b/i.test(message);
    if (wantsCount) {
      const parts = [`Im Ordner \`${folder}\` sind ${files.length} Datei${files.length === 1 ? '' : 'en'}`];
      if (dirs.length) parts.push(` und ${dirs.length} Unterordner`);
      return parts.join('') + '. Sag „liste sie auf", wenn du die Namen sehen willst.';
    }
    return [
      `Ordner: ${folder}`,
      `Dateien (${files.length}): ${files.slice(0, 200).join(', ') || '(keine)'}`,
      `Unterordner (${dirs.length}): ${dirs.slice(0, 100).join(', ') || '(keine)'}`,
    ].join('\n');
  },

  /**
   * v7.9.28 (field-fix #3): deterministic file read. The field showed the LLM
   * path calling `cat` (Unix, absent on Windows) or mishandling spaced/paren
   * paths. This resolves the file (explicit quoted/Windows path, a named
   * location on Desktop/Documents/... searching plain + OneDrive, or the
   * last-opened file for "was steht da drin") and reads it straight from fs.
   * Large files return a head + a hint to use "fasse <datei> zusammen".
   */
  async readFile(message) {
    const fs = require('fs');
    const path = require('path');
    const { getLastDoc, setLastDoc } = require('./LastDocStore');
    const { _isCriticalSystemPath, _isSecretFile } = require('../core/shell/ShellSafety');
    const { resolveFileToken } = require('./ProjectFileResolver');
    const _rootDir = (this.fp && this.fp.rootDir) || process.cwd();
    let target = null;
    // v7.9.37 pass 5 (X2): a fresh pending file-question turns the NEXT
    // message into an answer — never ask the identical question twice.
    const _pend = this._pendingFileRequest;
    if (_pend && _pend.kind === 'read' && Date.now() - _pend.ts < 5 * 60 * 1000) {
      const ord = String(message).trim().match(/^([1-5])\.?$/);
      if (ord && _pend.candidates && _pend.candidates[+ord[1] - 1]) {
        target = _pend.candidates[+ord[1] - 1].abs;
      } else {
        const rr = resolveFileToken(message, _rootDir);
        if (rr.status === 'one') target = rr.matches[0].abs;
      }
      if (target) this._pendingFileRequest = null;
    }
    const quoted = message.match(/["']([^"']+)["']/);
    if (quoted) target = quoted[1].trim();
    if (!target) { const wp = message.match(/([A-Za-z]:\\[^\s"']*)/); if (wp) target = wp[1]; }
    if (!target) target = this._resolveLocationName(message);
    if (!target) {
      // bare filename in the message: "was ist in dem dokument x1", "was steht
      // in package.json", "inhalt von readme". Resolve it against the project
      // root with common extensions, so a named file works even without a path.
      const nameM = message.match(/(?:datei|dokument|file|document|inhalt\s+von|inhalt\s+des|content\s+of)\s+(?:the\s+)?["']?([\w][\w.()\- ]*?)["']?(?=\s|$|[?.,]|\s+say|\s+contain)/i)
        || message.match(/(?:steht\s+in(?:\s+der)?|ist\s+in\s+(?:dem\s+|der\s+)?(?:datei|dokument|file)|read|does)\s+(?:the\s+(?:file\s+|document\s+)?)?["']?([\w][\w.()\- ]*?)["']?(?=\s|$|[?.,]|\s+say|\s+contain)/i);
      if (nameM) {
        const cand = nameM[1].trim();
        const rootDir = (this.fp && this.fp.rootDir) || process.cwd();
        const exts = ['', '.txt', '.md', '.json', '.js', '.log', '.yaml', '.yml'];
        for (const baseDir of [rootDir, process.cwd()]) {
          for (const e of exts) {
            const p = path.join(baseDir, cand + e);
            try { if (fs.existsSync(p) && fs.statSync(p).isFile()) { target = p; break; } } catch { /* skip */ }
          }
          if (target) break;
        }
      }
    }
    // v7.9.37 pass 5 (X1): the shared resolver — recursive, case-insensitive,
    // against the REAL project tree. One match means ACT (field: the same
    // template question was asked four times while the name sat in the message).
    if (!target) {
      const rr = resolveFileToken(message, _rootDir);
      if (rr.status === 'one') target = rr.matches[0].abs;
      else if (rr.status === 'many') {
        this._pendingFileRequest = { kind: 'read', candidates: rr.matches, ts: Date.now() };
        const lines = rr.matches.map((m, i) => `${i + 1}) ${m.rel}`).join('\n');
        return `Ich habe mehrere Treffer für „${rr.token}" — welche meinst du?\n${lines}\n(Antworte mit der Nummer oder dem Pfad.)`;
      } else if (rr.token) {
        this._pendingFileRequest = { kind: 'read', token: rr.token, ts: Date.now() };
        return `„${rr.token}" habe ich im Projekt nicht gefunden. Nenn mir einen anderen Namen oder den Pfad — oder sag „liste die Dateien in <ordner> auf".`;
      }
    }
    if (!target) {
      const last = getLastDoc();
      if (last && last.kind === 'file') target = last.path;
      else if (last && last.kind === 'folder') {
        return `\`${last.path}\` ist ein Ordner. Sag „liste sie auf" für die Dateien darin.`;
      }
    }
    if (!target) {
      if (this._pendingFileRequest && this._pendingFileRequest.kind === 'read') {
        return 'Ich warte noch auf die Datei: antworte mit der Nummer aus meiner letzten Liste, einem Dateinamen (z.B. „ARCHITECTURE.md") oder einem Pfad.';
      }
      return 'Welche Datei soll ich lesen? Gib mir den Namen oder Pfad an.';
    }
    const absLower = String(target).toLowerCase();
    if (_isCriticalSystemPath(absLower, process.platform === 'win32') || _isSecretFile(absLower)) {
      return 'Diese Datei ist geschützt und kann nicht gelesen werden.';
    }
    let stat;
    try { stat = fs.statSync(target); } catch { return `Die Datei \`${target}\` existiert nicht.`; }
    if (stat.isDirectory()) {
      return `\`${target}\` ist ein Ordner, keine Datei. Sag „liste sie auf" für die Dateien darin.`;
    }
    // v7.9.30: re-check the symlink-resolved target so an in-root link named
    // innocently cannot read a secret/system file through it (audit §4.2).
    try {
      const realLower = fs.realpathSync(target).toLowerCase();
      if (_isCriticalSystemPath(realLower, process.platform === 'win32') || _isSecretFile(realLower)) {
        return 'Diese Datei ist geschützt und kann nicht gelesen werden.';
      }
    } catch { /* realpath failed → the earlier name-based check stands */ }
    let content;
    try { content = fs.readFileSync(target, 'utf8'); } catch (e) { return `Konnte die Datei nicht lesen: ${e.message}`; }
    try { setLastDoc(target, 'file'); } catch { /* ignore */ }
    const base = path.basename(target);
    if (!content.trim()) return `Die Datei \`${base}\` ist leer.`;
    const MAX = 8000;
    if (content.length > MAX) {
      return `📄 ${base} gelesen (${content.split('\n').length} Zeilen, gekürzt auf ${MAX} Zeichen) —\n\n${content.slice(0, MAX)}\n\n[... gekürzt. Sag „fasse ${base} zusammen" für eine Zusammenfassung des ganzen Dokuments.]`;
    }
    return `📄 ${base} gelesen (${content.split('\n').length} Zeilen) —\n\n${content}`;
  },

  /**
   * v7.9.28 (field-fix #3): safe, deterministic file creation — "erstelle eine
   * Textdatei mit Namen X und Inhalt Y in <ort>". This is a specific, bounded
   * write (fs.writeFileSync of one named file), NOT arbitrary shell, so it does
   * not need the shell-task slash gate: a direct chat instruction is trusted by
   * source (observed content is rewritten to general by RuntimeGuard and never
   * reaches here). Guards: never touch a system/secret path, never overwrite an
   * existing file. Target dir: "genesis ordner" → project root; a named location
   * (Desktop/Documents/... plain or OneDrive); an explicit drive path; else root.
   */
  async createFile(message) {
    const fs = require('fs');
    const path = require('path');
    const os = require('os');
    const { _isCriticalSystemPath, _isSecretFile } = require('../core/shell/ShellSafety');
    const rootDir = (this.fp && this.fp.rootDir) || process.cwd();

    // name
    const nameM = message.match(/(?:mit\s+)?(?:namens?|named|called)\s+["']?([^\s"',]+?)["']?(?=\s|$|,)/i)
      || message.match(/(?:text[\s-]*)?(?:datei|dokument|file|document)\s+["']([^"']+)["']/i);
    let name = nameM ? nameM[1].trim() : null;
    if (!name) {
      return 'Wie soll die Datei heißen? Sag z.B. „erstelle eine Textdatei mit Namen notiz und Inhalt Hallo".';
    }
    if (!/\.[A-Za-z0-9]+$/.test(name)) name += '.txt';

    // content: "mit inhalt X", "der text (in dem dokument) ist X",
    // "der inhalt ist X", "inhalt: X", "mit dem text X". The field showed
    // "… der text in dem dokument ist test" produced an empty file because only
    // "inhalt X" was parsed. Cut a trailing "in/auf <ort>" clause so the target
    // directory does not leak into the content.
    const stripLoc = (s) => String(s)
      .replace(/\s+(?:in|im|auf|unter|on)\s+(?:dem\s+|der\s+|das\s+|den\s+|the\s+)?(?:genesis[-\s]?ordner|genesis[-\s]?verzeichnis|genesis\b|projekt(?:ordner|verzeichnis)?|desktop|schreibtisch|downloads?|dokumente|documents?|bilder|pictures?|musik|music|[A-Za-z]:\\?)[\s\S]*$/i, '')
      .trim();
    const contentM =
      // "… und schreibe test 1 in den inhalt / hinein / rein"
      message.match(/\bschreib\w*\s+(?:den\s+text\s+|mir\s+|die\s+|das\s+)?([\s\S]+?)\s+(?:in\s+den\s+inhalt|in\s+die\s+datei|in\s+das\s+dokument|hinein|rein|dazu|hinzu)\b/i)
      || message.match(/(?:der\s+|dem\s+)?(?:text|inhalt)\s+(?:in\s+(?:dem|der|das)\s+(?:dokument|datei|file|document)\s+)?(?:ist|lautet|soll\s+(?:sein|lauten))\s*[:=]?\s*["']?([\s\S]+?)["']?$/i)
      || message.match(/(?:mit\s+)?inhalt\s*[:=]?\s*["']?([\s\S]*?)["']?(?:\s+(?:in|im|auf|unter|on)\s+(?:dem\s+|der\s+|das\s+|den\s+)?(?:genesis|desktop|schreibtisch|downloads?|dokumente|documents?|bilder|pictures?|musik|music|ordner|verzeichnis|[A-Za-z]:)\b[\s\S]*)?$/i)
      || message.match(/\bmit\s+(?:dem\s+)?text\s+["']?([\s\S]+?)["']?$/i)
      // English: "with content X", "the content/text is X", "saying/that says X"
      || message.match(/(?:the\s+)?(?:content|text)\s+(?:is|reads|:|=)\s*["']?([\s\S]+?)["']?$/i)
      || message.match(/(?:with\s+(?:the\s+)?(?:content|text)|saying|that\s+says?|containing)\s*[:=]?\s*["']?([\s\S]*?)["']?(?:\s+(?:in|on)\s+(?:the\s+)?(?:desktop|downloads?|documents?|pictures?|music|genesis|[A-Za-z]:)\b[\s\S]*)?$/i);
    let content = contentM ? stripLoc(contentM[1]) : '';
    // A bare reference to the last output ("es", "das", "die Zusammenfassung",
    // "die Zeichnung") resolves to whatever Genesis last produced. Any OTHER
    // literal text is written verbatim — the remembered output is one source.
    const bareRef = /^(?:die\s+|der\s+|das\s+|letzte[nr]?\s+|diese[nrs]?\s+|obige[nrs]?\s+)?(?:es|das|dies(?:es|e)?|zusammenfassung|summary|zusammenfassund|ergebnis|zeichnung|bild|diagramm|grafik|ausgabe|output|antwort)$/i.test(content);
    const msgRef = /\b(?:zusammenfassung|summary|zusammenfassund|zeichnung|diagramm|grafik)\b|\b(?:das|die|der)\s+(?:ergebnis|bild|diagramm|zeichnung|obige|letzte|antwort|ausgabe)\b|(?:schreib\w*)\s+(?:mir\s+)?(?:es|das|dies(?:es|e)?)\b/i.test(message);
    if (bareRef || (!content && msgRef)) {
      try { const lt = require('./LastDocStore').getLastText(); if (lt && lt.text) content = lt.text; } catch { /* ignore */ }
    }

    // target directory
    let dir = rootDir;
    const driveM = message.match(/\b(?:in|im|unter|auf|on)\s+["']?([A-Za-z]:\\[^\s"']*)/i);
    const locM = message.match(/\b(?:auf|in|unter|on|im)\s+(?:dem|den|der|de|the)\s+(desktop|schreibtisch|downloads?|dokumente|documents?|bilder|pictures?|musik|music)\b/i);
    const genM = /\b(?:in|im)\s+(?:dem\s+|das\s+|den\s+)?(?:genesis[-\s]?ordner|genesis[-\s]?verzeichnis|genesis[-\s]?folder|genesis\b|projekt(?:ordner|verzeichnis)?)/i.test(message);
    if (driveM) {
      dir = driveM[1];
    } else if (locM) {
      const key = locM[1].toLowerCase();
      const folder = ({
        desktop: 'Desktop', schreibtisch: 'Desktop',
        download: 'Downloads', downloads: 'Downloads',
        dokumente: 'Documents', document: 'Documents', documents: 'Documents',
        bilder: 'Pictures', picture: 'Pictures', pictures: 'Pictures',
        musik: 'Music', music: 'Music',
      })[key] || 'Desktop';
      const home = os.homedir();
      const cands = [path.join(home, 'OneDrive', folder), path.join(home, folder)];
      dir = cands.find((d) => { try { return fs.existsSync(d); } catch { return false; } }) || path.join(home, folder);
    } else if (genM) {
      dir = rootDir;
    }

    const target = path.join(dir, name);
    const absLower = target.toLowerCase();
    if (_isCriticalSystemPath(absLower, process.platform === 'win32') || _isSecretFile(absLower)) {
      return 'Dieser Pfad ist geschützt — dort erstelle ich keine Datei.';
    }
    try {
      if (fs.existsSync(target)) {
        // Protect a file that already has content, but allow writing into an
        // empty placeholder (a common two-step: create empty, then fill it).
        let sz = 1; try { sz = fs.statSync(target).size; } catch { /* treat as non-empty */ }
        if (sz > 0) return `Die Datei \`${target}\` existiert bereits und ist nicht leer — ich überschreibe nichts. Sag „schreibe … in ${name}", wenn du sie ersetzen willst, oder wähle einen anderen Namen.`;
      }
    } catch { /* proceed */ }
    try { fs.mkdirSync(dir, { recursive: true }); } catch { /* dir may exist */ }
    try { fs.writeFileSync(target, content, 'utf8'); } catch (e) { return `Konnte die Datei nicht erstellen: ${e.message}`; }
    try { require('./LastDocStore').setLastDoc(target, 'file'); } catch { /* ignore */ }
    return `Datei erstellt: ${target}${content ? ` (${content.length} Zeichen)` : ' (leer)'}`;
  },

  /**
   * v7.9.28 (field-fix #3): write text INTO a (possibly existing) file —
   * "schreibe den text - … in x2", "speichere die Zusammenfassung mit Namen
   * one", "save the summary to notes". The field showed this fell to the LLM,
   * which claimed success but wrote nothing. Content is resolved from an
   * explicit literal ("text - …", "inhalt: …"), or the last generated summary
   * when the user refers to it ("die Zusammenfassung"), or — as a last resort —
   * the last generated text. Unlike createFile this DOES overwrite (an explicit
   * write command), but never a system/secret path. Trusted by source.
   */
  async writeFile(message) {
    try {
      const fs = require('fs');
      const path = require('path');
      const os = require('os');
      const { getLastDoc, setLastDoc, getLastText } = require('./LastDocStore');
      const { _isCriticalSystemPath, _isSecretFile } = require('../core/shell/ShellSafety');
      const rootDir = (this.fp && this.fp.rootDir) || process.cwd();

      // --- target file ---
      let target = null, targetName = null;
      const quoted = message.match(/["']([^"']+\.[A-Za-z0-9]+)["']/);
      if (quoted) target = quoted[1].trim();
      if (!target) { const wp = message.match(/([A-Za-z]:\\[^\s"']*)/); if (wp) target = wp[1]; }
      if (!target) {
        const nm = message.match(/(?:mit\s+namen?|namens|als(?:\s+(?:datei|dokument))?|in\s+(?:die\s+|eine\s+|der\s+)?(?:datei|dokument|file)|to)\s+(?:the\s+|a\s+|die\s+|eine\s+)?(?:file\s+|document\s+|datei\s+|dokument\s+)?["']?([\w][\w.()\-]*?)["']?(?=\s|$|[,.?!])/i);
        if (nm && !/^(?:den|dem|die|das|the|inhalt|textdatei|textdokument)$/i.test(nm[1])) targetName = nm[1].trim();
      }
      if (!target && !targetName) {
        // "... in <token>" at the end ("schreibe den text - … in x2")
        const tail = message.match(/\bin\s+["']?([\w][\w.()\-]{0,60})["']?\s*[.?!]*$/i);
        if (tail && !/^(?:den|dem|die|das|the|inhalt|es|ihn)$/i.test(tail[1])) targetName = tail[1].trim();
      }
      if (targetName) {
        if (!/\.[A-Za-z0-9]+$/.test(targetName)) targetName += '.txt';
        let dir = rootDir;
        const driveM = message.match(/\b(?:in|im|unter|auf|on)\s+["']?([A-Za-z]:\\[^\s"']*)/i);
        const locM = message.match(/\b(?:auf|in|unter|on|im)\s+(?:dem\s+|den\s+|der\s+|the\s+)?(desktop|schreibtisch|downloads?|dokumente|documents?|bilder|pictures?|musik|music)\b/i);
        const genM = /\b(?:in|im)\s+(?:dem\s+|das\s+|den\s+)?(?:genesis[-\s]?ordner|genesis[-\s]?verzeichnis|genesis\b|projekt(?:ordner|verzeichnis)?)/i.test(message);
        if (driveM) dir = driveM[1];
        else if (locM) {
          const folder = ({ desktop: 'Desktop', schreibtisch: 'Desktop', download: 'Downloads', downloads: 'Downloads', dokumente: 'Documents', document: 'Documents', documents: 'Documents', bilder: 'Pictures', picture: 'Pictures', pictures: 'Pictures', musik: 'Music', music: 'Music' })[locM[1].toLowerCase()] || 'Desktop';
          const home = os.homedir();
          dir = [path.join(home, 'OneDrive', folder), path.join(home, folder)].find((d) => { try { return fs.existsSync(d); } catch { return false; } }) || path.join(home, folder);
        } else if (genM) dir = rootDir;
        target = path.join(dir, targetName);
      }
      if (!target) { const last = getLastDoc(); if (last && last.kind === 'file') target = last.path; }
      if (!target) return 'In welche Datei soll ich schreiben? Nenn den Namen, z.B. „schreibe … in Datei notiz".';
      if (!path.isAbsolute(target)) target = path.join(rootDir, target);

      // --- content ---
      let content = null;
      // 1. explicit literal after a marker (strip a trailing "in <target>")
      let cm = message.match(/\bschreib\w*\s+(?:den\s+text\s+|mir\s+|die\s+|das\s+)?([\s\S]+?)\s+(?:in\s+den\s+inhalt|in\s+die\s+datei|in\s+das\s+dokument|hinein|rein|dazu|hinzu)\b/i)
        || message.match(/(?:schreib\w*\s+(?:den\s+|mir\s+)?text\s*[-:–]\s*|folgendes?\s*[-:]\s*)([\s\S]+?)(?:\s+in\s+["']?[\w.()\-]+["']?\s*[.?!]*)?$/i)
        || message.match(/(?:mit\s+)?inhalt\s*[:=]\s*([\s\S]+?)(?:\s+in\s+["']?[\w.()\-]+["']?\s*[.?!]*)?$/i);
      if (cm && cm[1].trim()) content = cm[1].trim();
      // a bare reference ("die Zusammenfassung", "es", "das", "die Zeichnung")
      // resolves to the last output; any other text is written verbatim.
      if (content && /^(?:die\s+|der\s+|das\s+|letzte[nr]?\s+|diese[nrs]?\s+|obige[nrs]?\s+)?(?:es|das|dies(?:es|e)?|zusammenfassung|summary|zusammenfassund|ergebnis|zeichnung|bild|diagramm|grafik|ausgabe|output|antwort)$/i.test(content)) {
        const lt = getLastText(); if (lt && lt.text) content = lt.text;
      }
      // 2. reference to the last output → what Genesis last produced
      if (content == null && (/\b(?:zusammenfassung|summary|zusammenfassund|zeichnung|diagramm|grafik)\b|\b(?:das|die|der)\s+(?:ergebnis|bild|diagramm|zeichnung|obige|letzte|antwort|ausgabe)\b|(?:speicher\w*|schreib\w*)\s+(?:mir\s+)?(?:es|das|dies(?:es|e)?)\b/i.test(message))) {
        const lt = getLastText(); if (lt && lt.text) content = lt.text;
      }
      // 3. "der text ist X"
      if (content == null) { const im = message.match(/(?:der\s+)?(?:text|inhalt)\s+(?:ist|lautet)\s*[:=]?\s*([\s\S]+?)(?:\s+in\s+["']?[\w.()\-]+["']?\s*[.?!]*)?$/i); if (im && im[1].trim()) content = im[1].trim(); }
      // 4. last resort — the last generated text
      if (content == null) { const lt = getLastText(); if (lt && lt.text) content = lt.text; }
      if (content == null) return 'Was soll ich in die Datei schreiben? Nenn den Text.';

      // guard + write (overwrite allowed for an explicit write command)
      const absLower = target.toLowerCase();
      if (_isCriticalSystemPath(absLower, process.platform === 'win32') || _isSecretFile(absLower)) {
        return 'Dieser Pfad ist geschützt — dort schreibe ich nicht.';
      }
      try { fs.mkdirSync(path.dirname(target), { recursive: true }); } catch { /* exists */ }
      try { fs.writeFileSync(target, content, 'utf8'); } catch (e) { return `Konnte nicht schreiben: ${e.message}`; }
      try { setLastDoc(target, 'file'); } catch { /* ignore */ }
      return `Text in ${target} geschrieben (${content.length} Zeichen).`;
    } catch { return null; }
  },

  /**
   * v7.9.28 (field-fix #3): deterministic file summary in ONE shot. The field
   * showed the LLM/tool path announcing "Ich lese die Datei…" and stopping, then
   * summarizing only part and asking whether to continue. This resolves the file
   * (named with/without extension, OneDrive-aware, or the last-opened file for
   * "fasse das zusammen"), reads it in FULL, and makes a single modelBridge.chat
   * call with a strict directive — no tool loop, so no announce-and-wait and no
   * partial summary. Any failure (bridge not bound, LLM error, file missing)
   * returns null so the orchestrator falls back to the existing source-read path.
   * Works German + English (summary language follows the request) on any OS.
   */
  async summarizeFile(message) {
    try {
      const fs = require('fs');
      const path = require('path');
      const { getLastDoc, setLastDoc } = require('./LastDocStore');
      const { _isCriticalSystemPath, _isSecretFile } = require('../core/shell/ShellSafety');
      const rootDir = (this.fp && this.fp.rootDir) || process.cwd();

      // --- resolve the target file ---
      let target = null;
      const quoted = message.match(/["']([^"']+)["']/);
      if (quoted) target = quoted[1].trim();
      if (!target) { const wp = message.match(/([A-Za-z]:\\[^\s"']*)/); if (wp) target = wp[1]; }
      if (!target) target = this._resolveLocationName(message);
      if (!target) {
        // named file: "fasse ONTOGENESIS zusammen", "fasse README.md durch",
        // "summarize package.json". Single token (spaced names use quotes).
        let m = message.match(/(?:fass(?:e|en|t|st)?|zusammenfass\w*)\s+(?:mir\s+)?(?:die\s+|den\s+|das\s+|the\s+)?(?:datei\s+|file\s+|dokument\s+)?([\w][\w.()\-]*?)\s+zusammen/i)
          || message.match(/summariz\w*\s+(?:the\s+)?(?:file\s+|document\s+)?([\w][\w.()\-]{1,60})\s*$/i);
        let cand = m ? m[1].trim().replace(/\s+(?:datei|file|dokument|document)$/i, '').trim() : null;
        const isAnaphora = cand && /^(?:es|das|die|den|dies(?:es|e)?|the|it|this|zusammen|datei|file|dokument|document)$/i.test(cand);
        if (cand && !isAnaphora) {
          try {
            const { _resolveFileWithVariants, _recursiveFind } = require('../foundation/SelfModelSourceRead');
            const c = path.isAbsolute(cand) ? cand : path.join(rootDir, cand);
            target = _resolveFileWithVariants(c, rootDir) || _recursiveFind(rootDir, cand) || null;
          } catch { /* fall through to direct probe */ }
          if (!target) {
            const exts = ['', '.md', '.txt', '.json', '.js', '.log', '.yaml', '.yml'];
            for (const baseDir of [rootDir, process.cwd()]) {
              for (const e of exts) {
                const p = path.join(baseDir, cand + e);
                try { if (fs.existsSync(p) && fs.statSync(p).isFile()) { target = p; break; } } catch { /* skip */ }
              }
              if (target) break;
            }
          }
        }
      }
      // anaphora / "fasse die datei zusammen" → the last opened file
      if (!target) { const last = getLastDoc(); if (last && last.kind === 'file') target = last.path; }
      if (!target) return null; // nothing to resolve → let source-read/general handle it

      if (!path.isAbsolute(target)) target = path.join(rootDir, target);
      const absLower = target.toLowerCase();
      if (_isCriticalSystemPath(absLower, process.platform === 'win32') || _isSecretFile(absLower)) {
        return 'Diese Datei ist geschützt und kann nicht gelesen werden.';
      }
      let stat; try { stat = fs.statSync(target); } catch { return null; }
      if (stat.isDirectory()) return null;
      let content; try { content = fs.readFileSync(target, 'utf8'); } catch { return null; }
      try { setLastDoc(target, 'file'); } catch { /* ignore */ }
      const base = path.basename(target);
      if (!content.trim()) return `Die Datei \`${base}\` ist leer — es gibt nichts zusammenzufassen.`;

      // --- single deterministic LLM call (no tool loop) ---
      if (!this.modelBridge || typeof this.modelBridge.chat !== 'function') return null;
      const CAP = 120000;
      let body = content, truncated = false;
      if (body.length > CAP) { body = body.slice(0, CAP); truncated = true; }
      let isDe = true;
      try { if (this.lang && typeof this.lang.detect === 'function') isDe = this.lang.detect(message) !== 'en'; } catch { /* default de */ }
      const sys = isDe
        ? 'Du bist Genesis. Fasse das folgende Dokument vollständig und präzise in klarem Deutsch zusammen. Der GESAMTE Inhalt liegt unten vor — gib direkt die Zusammenfassung. Kündige nichts an, frage nicht nach, rufe kein Werkzeug auf und frage nicht, ob du weiterlesen sollst.'
        : 'You are Genesis. Summarize the following document completely and precisely in clear English. The ENTIRE content is provided below — give the summary directly. Do not announce, do not ask questions, do not call any tool, and do not ask whether to keep reading.';
      const userMsg = (isDe ? `Datei: ${base}\n\n` : `File: ${base}\n\n`) + body
        + (truncated ? (isDe ? '\n\n[Sehr großes Dokument — dies ist der Anfang; fasse das Vorliegende zusammen.]' : '\n\n[Very large document — this is the beginning; summarize what is provided.]') : '');
      let summary;
      try {
        summary = await this.modelBridge.chat(sys, [{ role: 'user', content: userMsg }], 'chat', { _userChat: true, maxTokens: 1600, noCache: true });
      } catch { return null; }
      if (!summary || !String(summary).trim()) return null;
      const _ln = content.split('\n').length; // v7.9.37 pass 5 (X3)
      const head = isDe
        ? `📄 ${base} gelesen (${_ln} Zeilen) — Zusammenfassung:\n\n`
        : `📄 ${base} read (${_ln} lines) — summary:\n\n`;
      const full = head + String(summary).trim();
      // remember it so "speichere die Zusammenfassung in Datei X" can persist it
      try { require('./LastDocStore').setLastText(String(summary).trim(), 'summary'); } catch { /* ignore */ }
      return full;
    } catch { return null; }
  },

};

module.exports = { commandHandlersFileView };
