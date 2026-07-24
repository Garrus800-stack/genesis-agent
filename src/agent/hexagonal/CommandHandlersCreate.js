// ============================================================
// GENESIS — src/agent/hexagonal/CommandHandlersCreate.js
// v7.9.45 field: file creation as its own hand. Carries the vault-corner
// fork ("in deinem Genesis-Bereich im Vault" → <vault>/Genesis/), and the
// pending answer road so the name-question never loses the first
// sentence's target again. Mixins share `this` with the FileView hand
// (_archiveRoot, LastDocStore, settings).
// ============================================================
'use strict';

const { _stripContentMeta, _archiveDir } = require('./CommandHandlersFileView');

const commandHandlersCreate = {
  _vaultRoot() {
    try { const v = this.settings && this.settings.get ? this.settings.get('vault.path') : null; if (v && String(v).trim()) return String(v).trim(); } catch (_e) { /* none */ }
    return null;
  },

  _defExt(dir) {
    try { const v = this._vaultRoot && this._vaultRoot(); if (v && dir && String(dir).startsWith(String(v))) return '.md'; } catch { /* fall */ }
    return '.txt';
  },

  _findByName(name, roots) {
    const fs = require('fs'); const path = require('path');
    const bare = String(name).replace(/\.[A-Za-z0-9]+$/, ''); const lower = bare.toLowerCase();
    const exts = ['.md', '.txt', '', '.json', '.log'];
    const walk = (dir, depth) => {
      let es = []; try { es = fs.readdirSync(dir, { withFileTypes: true }); } catch { return null; }
      for (const e of es) { if (e.isFile()) { const b = e.name.replace(/\.[A-Za-z0-9]+$/, '').toLowerCase(); if (b === lower && exts.includes(path.extname(e.name).toLowerCase() || '')) return path.join(dir, e.name); } }
      if (depth <= 0) return null;
      for (const e of es) { if (e.isDirectory() && !/^(?:node_modules|\.git|\.obsidian)$/i.test(e.name)) { const r = walk(path.join(dir, e.name), depth - 1); if (r) return r; } }
      return null;
    };
    for (const r of roots) { if (!r) continue; const hit = walk(r, 3); if (hit) return hit; }
    return null;
  },

  // v7.9.45 field: “change X to Y in my note” — the spoken edit hand. A chat
  // request IS the explicit ask, so the partner's vault may be edited here
  // (the autonomous edit-file tool stays blocked there by design).
  // v7.9.45 field: “Schau in meinen <vault>: <frage>” — deterministic lookup.
  // Finds the note, READS it, answers from its real lines with the source
  // named — the model can never again answer from stale memory instead.
  async vaultLookup(message) {
    const fs = require('fs'); const path = require('path');
    const root = this._vaultRoot(); if (!root) return null;
    const m = String(message).match(/(?:schau(?:\s+mal)?\s+in\s+mein(?:en|em)?|look\s+in(?:to)?\s+my|regarde\s+dans\s+mon|mira\s+en\s+mi)\s+[^\s:\uff1a]+\s*[:\uff1a,-]?\s*([\s\S]+)$/i);
    const frage = (m ? m[1] : String(message)).trim();
    const stop = new Set(['was','ist','sind','meine','mein','wie','der','die','das','und','oder','what','is','are','my','the','que','quelle','est','mon','ma','cual','cu\u00e1l','es','mi','ich','habe','hat','sage','sag','sags','nenn','nenne','zeig','zeige','eine','einen','einem','tell','say','show','dis','di','dime']);
    const words = (frage.toLowerCase().match(/[\w\u00c0-\u024f]{4,}/g) || []).filter(w => !stop.has(w));
    if (!words.length) return null;
    let best = null;
    const walk = (dir, depth) => {
      let es = []; try { es = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const e of es) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) { if (depth > 0 && !/^(?:\.obsidian|\.git|node_modules)$/i.test(e.name)) walk(full, depth - 1); continue; }
        if (!/\.(?:md|txt)$/i.test(e.name)) continue;
        const bare = e.name.replace(/\.[A-Za-z0-9]+$/, '').toLowerCase();
        let score = 0; for (const w of words) { if (bare.includes(w) || w.includes(bare)) score += 2; }
        let text = ''; try { text = fs.readFileSync(full, 'utf8'); } catch { continue; }
        const lines = text.split(/\r?\n/); const hits = [];
        for (const ln of lines) { const low = ln.toLowerCase(); if (words.some(w => low.includes(w) || (w.length > 5 && low.includes(w.slice(-5))))) { hits.push(ln.trim()); score += 1; } }
        if (score > 0 && (!best || score > best.score)) best = { full, score, hits: hits.slice(0, 3), first: (lines.find(l => l.trim()) || '').trim() };
      }
    };
    walk(root, 3);
    if (!best) return 'Dazu habe ich in deinem Vault nichts gefunden (gesucht: ' + words.join(', ') + ').';
    try { require('./LastDocStore').setLastDoc(best.full, 'file'); } catch { /* ignore */ }
    const body = best.hits.length ? best.hits.join('\n') : best.first;
    return 'Aus deiner Notiz ' + path.basename(best.full) + ':\n' + body + '\n(' + best.full + ')';
  },

  // v7.9.45 field: the places map — one deterministic answer, every model.
  whereIs() {
    const arch = (this._archiveRoot && this._archiveRoot()) || null;
    const vault = this._vaultRoot();
    const home = this._genesisDir || this.genesisDir || null;
    const L = [];
    L.push('Mein Arbeitsbereich ist das Genesis Archive' + (arch ? ': ' + arch : ' (noch kein Pfad gesetzt)') + ' — dort lege ich meine Arbeitsdateien ab.');
    L.push('Mein Zuhause (und Backup) ist mein Programmordner' + (home ? ': ' + home : '') + '.');
    L.push(vault ? 'Dein Vault: ' + vault + ' — ich lese überall darin, schreibe nur in meinen Genesis\\-Ordner dort und ändere deine Notizen nur auf deine Bitte.' : 'Ein Vault ist noch nicht verbunden — sag mir den Ort, z.B. „mein Vault liegt in …“.');
    return L.join('\n');
  },

  async changeInFile(message) {
    const fs = require('fs'); const path = require('path');
    const { getLastDoc, setLastDoc } = require('./LastDocStore');
    const { _isCriticalSystemPath, _isSecretFile } = require('../core/shell/ShellSafety');
    let msg = String(message);
    let target = null;
    const q = msg.match(/["']([^"']+\.[A-Za-z0-9]+)["']/); if (q) { target = q[1]; msg = msg.replace(q[0], ' '); }
    if (!target) { const wp = msg.match(/([A-Za-z]:\\[^\s"']+)/); if (wp) { target = wp[1]; msg = msg.replace(wp[0], ' '); } }
    msg = msg.replace(/\b(?:in|dans|en)[\s"']*$/i, ' ');
    let nameTok = null;
    const nm = msg.match(/\b(?:in|dans|en)\s+(?:meiner?m?\s+|der\s+|dem\s+|my\s+|the\s+|ma\s+|mon\s+|mi\s+|la\s+|el\s+)?(?:notiz|datei|note|file|fichier|nota|archivo)\s+["']?([\w][\w.\-]{0,60})["']?/i);
    if (nm) { nameTok = nm[1]; msg = msg.replace(nm[0], ' '); }
    const pr = msg.match(/(?:["']([^"']{1,120})["']|([\w\u00c0-\u024f-]+))\s+(?:zu|durch|to|with|par|por|con)\s+(?:["']([^"']{1,120})["']|([\w\u00c0-\u024f-]+))\s*[.?!]*\s*$/i);
    if (!pr) return 'Sag mir alt und neu, z.B. „ändere blau zu grün in meiner Notiz farbe“.';
    const oldS = (pr[1] || pr[2] || '').trim(); const newS = (pr[3] || pr[4] || '').trim();
    if (!target && nameTok) target = this._findByName(nameTok, [this._vaultRoot(), this._archiveRoot && this._archiveRoot(), (this.fp && this.fp.rootDir)]);
    if (!target) { const last = getLastDoc(); if (last && last.kind === 'file') target = last.path; }
    if (!target) return 'Ich habe gerade keine Datei im Blick — nenn mir den Namen (z.B. „in meiner Notiz farbe“).';
    if (!path.isAbsolute(target)) { const r = this._findByName(target, [this._vaultRoot(), this._archiveRoot && this._archiveRoot(), (this.fp && this.fp.rootDir)]); if (r) target = r; }
    const low = String(target).toLowerCase();
    if (_isCriticalSystemPath(low, process.platform === 'win32') || _isSecretFile(low)) return 'Dieser Pfad ist geschützt — dort ändere ich nichts.';
    let text; try { text = fs.readFileSync(target, 'utf8'); } catch { return 'Die Datei ' + target + ' kann ich nicht lesen.'; }
    if (!text.includes(oldS)) return '„' + oldS + '“ steht nicht in ' + target + ' — nichts geändert.';
    const n = text.split(oldS).length - 1;
    try { fs.writeFileSync(target, text.split(oldS).join(newS), 'utf8'); } catch (e) { return 'Konnte nicht schreiben: ' + e.message; }
    try { setLastDoc(target, 'file'); } catch { /* ignore */ }
    return '✏️ ' + n + '× „' + oldS + '“ → „' + newS + '“ in ' + target + ' geändert.';
  },

  _vaultGenesisDir(message) {
    const path = require('path');
    try { const v = this.settings && this.settings.get ? this.settings.get('vault.path') : null; if (v && String(v).trim() && /\b(?:vault|notiz[-\s]?ordner|notes?\s+folder|dossier\s+de\s+notes|carpeta\s+de\s+notas|dein(?:em|en)?\s+genesis[-\s]?(?:bereich|rand|ordner|ecke)|your\s+genesis\s+(?:corner|area|folder))\b/i.test(message)) return path.join(String(v).trim(), 'Genesis'); } catch (_e) { /* none */ }
    return null;
  },

  async createFile(message) {
    const fs = require('fs');
    const path = require('path');
    const os = require('os');
    if (this._pendingFileRequest && /^\s*(?:erstell|leg|lege|schreib|mach|create|make|cr[eé]e|crea)\w*\b/i.test(message)) this._pendingFileRequest = null; // v7.9.45 rev B10: a full create sentence is a new order, never a name
    const _pc = this._pendingFileRequest; // v7.9.45 field: name-question answers land here with the remembered target
    if (_pc && _pc.kind === 'create' && Date.now() - _pc.ts < 5 * 60 * 1000) {
      // v7.9.45 revision (B9): an ANSWER is a name — a COMMAND keeps its road.
      if (/^\s*(?:lies|lese|zeig|liste?|\u00f6ffne|oeffne|schau|sieh|\u00e4nder|ersetz|f\u00fchr|fuehr|starte|fasse?|was|wie|wo|warum|wer|read|show|open|list|look|change|replace|run|summarize|what|how|where|why|who|lis|montre|ouvre|regarde|lee|muestra|abre|mira|qu[e\u00e9]|o[u\u00f9]|d[o\u00f3]nde)\b/i.test(message)) return null;
      const _nat = String(message).trim()
        .replace(/^(?:sie|es|die\s+datei|the\s+file|it)\s+(?:s?oll(?:te)?|should|shall|muss)\s+/i, '')
        .replace(/^(?:nenn(?:e)?\s+(?:sie|es)\s+|call\s+it\s+|name\s+it\s+|appelle-l[ae]\s+|ll[a\u00e1]mal[oa]\s+)/i, '')
        .replace(/\s+(?:hei(?:\u00df|ss)en|genannt\s+werden|be\s+(?:called|named))\s*[.!?]*$/i, '');
      const am = _nat.replace(/^(?:name|nama|namens?)\s+/i, '').match(/^["']?([\w][\w.\- ]{0,60}?)["']?(?:(?:\s+(?:und|mit|and|with))?\s+(?:dem\s+|the\s+)?(?:text|inhalt|content)\s+([\s\S]+))?$/i);
      if (!am) {
        if (/\b(?:erstell|leg\b|schreib|create|make|cr[e\u00e9]e|crea)\w*/i.test(message)) { this._pendingFileRequest = null; }
        else { return null; } // a question or aside — the pending stays, the router answers
      }
      if (am) {
        this._pendingFileRequest = null;
        let n2 = am[1].trim();
        let c2 = (am[2] || '').trim();
        if (!c2 && _pc.ref) { const rp = this._findByName(_pc.ref, [this._vaultRoot(), this._archiveRoot && this._archiveRoot(), (this.fp && this.fp.rootDir)]); const bare = rp ? path.basename(rp).replace(/\.[A-Za-z0-9]+$/, '') : _pc.ref; c2 = 'Verweis: [[' + bare + ']]'; }
        const d2 = _pc.dir || (this._archiveRoot && this._archiveRoot()) || (this.fp && this.fp.rootDir) || process.cwd();
        if (!/\.[A-Za-z0-9]+$/.test(n2)) n2 += (this._defExt ? this._defExt(d2) : '.txt'); // vault notes are born .md so Obsidian links them
        const t2 = path.join(d2, n2);
        try { fs.mkdirSync(d2, { recursive: true }); fs.writeFileSync(t2, c2, 'utf8'); } catch (e) { return 'Konnte die Datei nicht erstellen: ' + e.message; }
        try { require('./LastDocStore').setLastDoc(t2, 'file'); } catch { /* ignore */ }
        return 'Datei erstellt: ' + t2 + (c2 ? ' (' + c2.length + ' Zeichen)' : ' (leer)');
      }
    }
    // v7.9.45 field: a REPORT about files (“du hast … eine datei namens hans erstellt”)
    // is not an order — past-tense without a leading create verb passes through untouched.
    if (/\b(?:hast|habe|hattest|hatte|wurde|worden|already|you\s+have)\b/i.test(message) && !/^\s*(?:erstell|leg|schreib|mach|create|make|write|cr[e\u00e9]e|crea)/i.test(message)) return null;
    const { _isCriticalSystemPath, _isSecretFile } = require('../core/shell/ShellSafety');
    const rootDir = (this.fp && this.fp.rootDir) || process.cwd();

    // name
    // v7.9.44 r15 (field): a name may carry spaces ("Genesis 01") — capture up
    // to "und/mit inhalt|text", a location clause, punctuation, or the end.
    const nameM = message.match(/(?:mit\s+)?(?:namens?|name|named|called)\s+["']?([^\s"',][^"',]*?)["']?(?=\s+(?:und|and)\b|\s+(?:mit|with)\s+(?:dem\s+|the\s+)?(?:inhalt|text|content)\b|\s+(?:der|dem|den|the)\s+(?:inhalt|text|content)\b|\s+(?:inhalt|text|content)\b|\s+(?:in|im|auf|unter|on)\s+|\s*[,.!?;]|\s*$)/i)
      || message.match(/(?:text[\s-]*)?(?:datei|dokument|file|document)\s+["']([^"']+)["']/i);
    let name = nameM ? nameM[1].trim() : null;
    if (!name) {
      const dir0 = this._vaultGenesisDir ? this._vaultGenesisDir(message) : null;
      const refM = message.match(/verweis\w*[\s\S]{0,30}?auf\s+(?:meine\s+|die\s+|my\s+|the\s+)?["']?([\w-]{2,40}?)["']?(?:[-\s]?(?:notiz|note))?\b/i) || message.match(/link(?:s|ing)?\s+to\s+my\s+([\w-]{2,40})/i);
      this._pendingFileRequest = { kind: 'create', dir: dir0, ref: refM ? refM[1] : null, ts: Date.now() };
      return 'Wie soll die Datei heißen?' + (dir0 ? ' Sie landet in ' + dir0 + '.' : '') + ' Sag z.B. „erstelle eine Textdatei mit Namen notiz und Inhalt Hallo".';
    }

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
      || message.match(/(?:with\s+(?:the\s+)?(?:content|text)|saying|that\s+says?|containing)\s*[:=]?\s*["']?([\s\S]*?)["']?(?:\s+(?:in|on)\s+(?:the\s+)?(?:desktop|downloads?|documents?|pictures?|music|genesis|[A-Za-z]:)\b[\s\S]*)?$/i)
      || message.match(/\b(?:inhalt|text|content)\s+["']?([\s\S]+?)["']?\s*$/i);
    let content = contentM ? _stripContentMeta(stripLoc(contentM[1])) : '';
    // A bare reference to the last output ("es", "das", "die Zusammenfassung",
    // "die Zeichnung") resolves to whatever Genesis last produced. Any OTHER
    // literal text is written verbatim — the remembered output is one source.
    const bareRef = /^(?:die\s+|der\s+|das\s+|letzte[nr]?\s+|diese[nrs]?\s+|obige[nrs]?\s+)?(?:es|das|dies(?:es|e)?|zusammenfassung|summary|zusammenfassund|ergebnis|zeichnung|bild|diagramm|grafik|ausgabe|output|antwort)$/i.test(content);
    const msgRef = /\b(?:zusammenfassung|summary|zusammenfassund|zeichnung|diagramm|grafik)\b|\b(?:das|die|der)\s+(?:ergebnis|bild|diagramm|zeichnung|obige|letzte|antwort|ausgabe)\b|(?:schreib\w*)\s+(?:mir\s+)?(?:es|das|dies(?:es|e)?)\b/i.test(message);
    if (bareRef || (!content && msgRef)) {
      try { const lt = require('./LastDocStore').getLastText(); if (lt && lt.text) content = lt.text; } catch { /* ignore */ }
    }

    // target directory — default is the Archive when one exists, else the project.
    const _arch = _archiveDir(rootDir);
    let dir = (_arch && require('fs').existsSync(_arch)) ? _arch : rootDir;
    const driveM = message.match(/\b(?:in|im|unter|auf|on)\s+["']?([A-Za-z]:\\[^\s"']*)/i);
    const locM = message.match(/\b(?:auf|in|unter|on|im)\s+(?:dem|den|der|de|the)\s+(desktop|schreibtisch|downloads?|dokumente|documents?|bilder|pictures?|musik|music)\b/i);
    const genM = /\b(?:in|im)\s+(?:dem\s+|das\s+|den\s+)?(?:genesis[-\s]?ordner|genesis[-\s]?verzeichnis|genesis[-\s]?folder|genesis\b|projekt(?:ordner|verzeichnis)?)/i.test(message);
    const _vg = this._vaultGenesisDir ? this._vaultGenesisDir(message) : null; // v7.9.45 field: the partner's vault corner wins over genM
    if (_vg) {
      dir = _vg;
    } else if (driveM) {
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

    if (!/\.[A-Za-z0-9]+$/.test(name)) name += (this._defExt ? this._defExt(dir) : '.txt'); // vault notes are born .md so Obsidian links them
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
};

module.exports = { commandHandlersCreate };
