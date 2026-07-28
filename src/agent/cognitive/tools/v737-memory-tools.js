// GENESIS — cognitive/tools/v737-memory-tools.js
// ═══════════════════════════════════════════════════════════════
// Three tools Genesis can call on himself:
//
//   mark-moment               — pin current episode for DreamCycle review
//   journal-write             — write an entry to the journal
//   release-protected-memory  — consciously let go of a CoreMemory
//
// All three require the matching v7.3.7 backing services (pendingMomentsStore,
// journalWriter, coreMemories). If any service is missing at register time,
// that particular tool is silently not registered — Genesis degrades gracefully.
// ═══════════════════════════════════════════════════════════════

'use strict';

const { createLogger } = require('../../core/Logger');
const _log = createLogger('v737-memory-tools');

/**
 * Register the three v7.3.7 memory tools with the ToolRegistry.
 *
 * @param {object} toolRegistry - ToolRegistry instance (.register method)
 * @param {object} deps
 * @param {object} [deps.pendingMomentsStore]
 * @param {object} [deps.journalWriter]
 * @param {object} [deps.coreMemories]
 * @param {object} [deps.episodicMemory]
 * @returns {string[]} names of tools registered
 */
function registerV737Tools(toolRegistry, deps = {}) {
  if (!toolRegistry || typeof toolRegistry.register !== 'function') {
    _log.debug('[v737-tools] no toolRegistry — skipping');
    return [];
  }

  const registered = [];
  const { pendingMomentsStore, journalWriter, coreMemories, episodicMemory, modelBridge } = deps;

  // ── mark-moment ───────────────────────────────────────────
  if (pendingMomentsStore && episodicMemory) {
    toolRegistry.register('mark-moment', {
      description: 'Markiere den aktuellen Moment als potenziell bedeutsam. Wird beim nächsten DreamCycle reflektiert und kann zur Kern-Erinnerung werden (ELEVATE), normal bleiben (KEEP) oder bewusst losgelassen werden (LET_FADE).',
      input: { summary: 'string (kurze Beschreibung warum dieser Moment wichtig ist)' },
      output: { ok: 'boolean', id: 'string|null', reason: 'string|null' },
    }, async (input = {}) => {
      try {
        const latest = typeof episodicMemory.getLatest === 'function'
          ? episodicMemory.getLatest()
          : (episodicMemory._episodes && episodicMemory._episodes[0]);

        if (!latest?.id) {
          // v7.9.7 R2: no episode available, but the caller may still have
          // a clear summary of why this moment matters. Fall back to
          // coreMemories.markAsSignificant — bypasses the DreamCycle review
          // queue and writes directly into the core-memory layer with full
          // user-defined significance. Without the fallback, mark-moment
          // returned 'no-latest-episode' as a hard failure during the early
          // boot window or any session where EpisodicMemory had not yet
          // recorded its first episode. Only fires when summary is present
          // (otherwise nothing to record).
          const summary = typeof input.summary === 'string' ? input.summary.trim() : '';
          if (summary && coreMemories && typeof coreMemories.markAsSignificant === 'function') {
            try {
              const memory = await coreMemories.markAsSignificant({ summary, type: 'other' });
              return { ok: true, id: memory?.id || null, reason: 'no-episode-fallback-to-core-memory' };
            } catch (e) {
              return { ok: false, id: null, reason: `no-episode; core-memory fallback failed: ${e.message}` };
            }
          }
          return { ok: false, id: null, reason: 'no-latest-episode' };
        }

        const id = pendingMomentsStore.mark({
          episodeId: latest.id,
          summary: input.summary || latest.topic || '',
          triggerContext: 'self-marked',
        });

        if (!id) return { ok: false, id: null, reason: 'mark-failed' };
        return { ok: true, id, reason: null };
      } catch (e) {
        _log.warn('[mark-moment] failed:', e.message);
        return { ok: false, id: null, reason: e.message };
      }
    }, 'v737-memory');
    registered.push('mark-moment');
  }

  // ── journal-write ─────────────────────────────────────────
  if (journalWriter) {
    toolRegistry.register('journal-write', {
      description: 'Schreibe einen Eintrag ins Journal. visibility: private (nur du siehst es), shared (dein Mensch sieht es auch), public (dokumentierbar für Außenstehende). Default: shared.',
      input: {
        content: 'string',
        visibility: 'string (private|shared|public, default: shared)',
        tags: 'array<string> (optional)',
      },
      output: { ok: 'boolean', reason: 'string|null' },
    }, async (input = {}) => {
      try {
        if (!input.content || typeof input.content !== 'string') {
          return { ok: false, reason: 'content-required' };
        }
        const rec = journalWriter.write({
          visibility: input.visibility || 'shared',
          source: 'genesis',
          content: input.content,
          tags: Array.isArray(input.tags) ? input.tags : [],
        });
        return { ok: rec !== null, reason: rec ? null : 'write-failed' };
      } catch (e) {
        _log.warn('[journal-write] failed:', e.message);
        return { ok: false, reason: e.message };
      }
    }, 'v737-memory');
    registered.push('journal-write');
  }

  // ── release-protected-memory ──────────────────────────────
  if (coreMemories) {
    toolRegistry.register('release-protected-memory', {
      description: 'Gib eine geschützte Kern-Erinnerung bewusst frei. Danach wird sie wie eine normale Episode behandelt und kann natürlich verblassen. Das ist eine bewusste Handlung — verwende es nur wenn du die Erinnerung wirklich loslassen willst.',
      input: {
        coreMemoryId: 'string (ID der Kern-Erinnerung)',
        reason: 'string (warum gibst du sie los?)',
      },
      output: { ok: 'boolean', reason: 'string|null' },
    }, async (input = {}) => {
      try {
        if (!input.coreMemoryId) {
          return { ok: false, reason: 'coreMemoryId-required' };
        }
        const ok = await coreMemories.release(input.coreMemoryId, {
          reason: input.reason || 'genesis-decision',
        });
        return ok
          ? { ok: true, reason: null }
          : { ok: false, reason: 'not-found-or-not-protected' };
      } catch (e) {
        _log.warn('[release-protected-memory] failed:', e.message);
        return { ok: false, reason: e.message };
      }
    }, 'v737-memory');
    registered.push('release-protected-memory');
  }

  if (registered.length > 0) {
    _log.info(`[v737-tools] Registered: ${registered.join(', ')}`);
  }
  // v7.9.42 V2a (Nachklang, Genesis' own design): "das nehme ich mit" —
  // one small model call condenses the marked moment into {topic, stance,
  // openQuestion} and appends it to .genesis/resonance.jsonl. Sibling of
  // mark-moment/journal-write. Never fires without an explicit mark.
  if (modelBridge && modelBridge._genesisDir) {
    toolRegistry.register('resonance-note', {
      description: 'Nimm diesen Moment als Nachklang mit ("das nehme ich mit"). Ein kleines Kondensat {Thema, Haltung, offene Frage} wird sofort festgehalten und speist deine Idle-Gedanken als bevorzugte Themenquelle.',
      input: { moment: 'string (was du mitnehmen willst — der Moment in deinen Worten)' },
      output: { ok: 'boolean', topic: 'string|null', reason: 'string|null' },
    }, async (input = {}) => {
      const moment = typeof input.moment === 'string' ? input.moment.trim() : '';
      if (!moment) return { ok: false, topic: null, reason: 'empty moment' };
      try {
        const sys = 'Condense the given moment into JSON with exactly three fields: '
          + '{"topic": short theme, "stance": the stance held right now, "openQuestion": the question left open}. '
          + 'Answer with ONLY that JSON object, nothing else.';
        const res = await modelBridge.chatStructured(sys, [{ role: 'user', content: moment }], 'analysis');
        let obj = res;
        if (res && typeof res.content === 'string') { try { obj = JSON.parse(res.content); } catch (_e) { obj = null; } }
        if (obj && typeof obj === 'object' && obj.content && typeof obj.content === 'object') obj = obj.content;
        const topic = String(obj?.topic || moment.slice(0, 60));
        const entry = {
          ts: Date.now(),
          topic,
          stance: String(obj?.stance || ''),
          openQuestion: String(obj?.openQuestion || ''),
          src: 'self-mark',
        };
        const fs = require('fs'); const path = require('path');
        fs.appendFileSync(path.join(modelBridge._genesisDir, 'resonance.jsonl'), JSON.stringify(entry) + '\n');
        return { ok: true, topic, reason: null };
      } catch (e) {
        return { ok: false, topic: null, reason: e.message };
      }
    });
    registered.push('resonance-note');
    _log.info('[v737-tools] Registered (v7.9.42): resonance-note'); // v7.9.43 D-2
  }
  { // v7.9.44 F2+G: the workbench and the first-visit book
    const _dir = deps.modelBridge && deps.modelBridge._genesisDir;
    const WR = require('../WorkRegistry.js');
    const CB = require('../CapabilityBook.js');
    toolRegistry.register('register-work', {
      description: 'Legt ein Werk bewusst auf die Bank: {workPath, purpose}. Gleicher Pfad erneut = Update (das war ich). Relative Pfade leben im Genesis Archive.',
      input: { workPath: 'string (Pfad zum Werk; relativ = im Genesis Archive)', purpose: 'string (wofuer dieses Werk steht)' },
    }, async (input = {}) => {
      if (!_dir) return { ok: false, error: 'kein Seelen-Pfad' };
      return WR.register(_dir, { workPath: input && input.workPath, purpose: input && input.purpose }, deps.settings);
    });
    toolRegistry.register('begehung', {
      description: 'Erst-Begehung einer F\u00e4higkeit: {action: entdecken|antasten|beschreiben|integrieren, name, quelle?, opName?, anleitung?, wandelSatz?}. Integriert setzt NUR Genesis, nach echtem Einsatz.',
      input: { action: 'string (entdecken|antasten|beschreiben|integrieren)', name: 'string (Name der Faehigkeit)', quelle: 'string?', opName: 'string?', anleitung: 'string?', wandelSatz: 'string?' },
    }, async (input = {}) => {
        if (!_dir) return { ok: false, error: 'kein Seelen-Pfad' };
        const a = input && input.action; const name = input && input.name;
        if (a === 'entdecken') return CB.discover(_dir, { name, quelle: input.quelle });
        if (a === 'antasten') {
          if (!CB.probeAllowed(input.opName)) return { ok: false, error: 'Probe verweigert \u2014 \u201e' + (input.opName || '?') + '\u201c ist nicht als gefahrlos gelistet (list/get/search/status/read). Im Zweifel: erst fragen.' };
          return CB.advance(_dir, name, 'angetastet', { probeOp: String(input.opName).slice(0, 60) });
        }
        if (a === 'beschreiben') {
          const f = input.anleitung ? CB.writeGuide(_dir, name, input.anleitung) : null;
          if (!f) return { ok: false, error: 'anleitung fehlt' };
          return CB.advance(_dir, name, 'beschrieben', { anleitungSkill: f });
        }
        if (a === 'integrieren') {
          const r = CB.advance(_dir, name, 'integriert', { wandelSatz: String(input.wandelSatz || '').slice(0, 200) });
          if (r.ok && input.wandelSatz && deps.journalWriter) {
            try { deps.journalWriter.write({ visibility: 'shared', source: 'begehung', content: String(input.wandelSatz).slice(0, 200), tags: ['faehigkeit', name] }); } catch (_e) { /* best effort */ }
          }
          return r;
        }
        return { ok: false, error: 'unbekannte action' };
    });
    toolRegistry.register('look-at-image', {
      description: 'Betrachte ein Bild und beschreibe, was darauf zu sehen ist. Nutze dies immer, wenn eine Bilddatei vorliegt (z. B. im Archiv) und der Nutzer sinngem\u00e4\u00df danach fragt \u2014 egal wie er fragt (\u201ewas ist da drauf\u201c, \u201ebeschreib das Foto\u201c, \u201eschau mal\u201c \u2026). {path: Pfad zur Bilddatei, frage?: optionale konkrete Frage}. Bild und Beschreibung bleiben privat; in der History steht nur ein Vermerk.',
      input: { path: 'string (Pfad zum Bild; relativ = im Genesis Archive)', frage: 'string? (was du wissen willst)' },
    }, async (input = {}) => {
        const fsx = require('fs'); const pathx = require('path');
        const ip = input && input.path;
        if (!ip) return { ok: false, error: 'path fehlt' };
        let abs = ip;
        if (!pathx.isAbsolute(abs) && _dir) abs = pathx.join(require('../WorkRegistry.js').archiveRoot(_dir, deps.settings), abs);
        let buf;
        try { buf = fsx.readFileSync(abs); } catch (_e) { return { ok: false, error: 'Bild nicht lesbar: ' + abs }; }
        if (buf.length > 8 * 1024 * 1024) return { ok: false, error: 'Bild zu gro\u00df (' + Math.round(buf.length / 1048576) + ' MB > 8 MB) \u2014 bitte verkleinert reichen.' };
        const frage = (input && input.frage) || 'Was siehst du auf diesem Bild? Beschreibe es mir als meinen Sinneseindruck.';
        try {
          const r = await deps.modelBridge.chat('', [{ role: 'user', content: frage, images: [buf.toString('base64')] }], 'chat', { maxTokens: 400 });
          const text = (r && (r.text || r.content || r.message)) || String(r || '');
          return { ok: true, gesehen: String(text).slice(0, 1200), vermerk: '[Bild betrachtet: ' + pathx.basename(abs) + ']' };
        } catch (e) { return { ok: false, error: 'Sehen fehlgeschlagen: ' + (e && e.message) }; }
    });

    // v7.9.44 r12: the symmetric half of look-at-image — read a NON-image file the user handed
    // into the Archive (text, code, notes, data). Uses the SAME archiveRoot resolver, so an
    // archive-relative path like "inbox/notiz.txt" works even though the Archive lives outside
    // the project. Images are redirected to look-at-image (which actually sees them).
    // v7.9.45 P — the quiet sense: PDFs become readable, built like the eye (no
    // ritual, honest edges). The extractor is injectable (deps.pdfExtract, tests)
    // and lazily required in production; every unreadable case speaks in Genesis'
    // own words instead of guessing.
    const _readPdf = async (abs) => {
      const fsx = require('fs');
      const st = fsx.statSync(abs);
      if (st.size > 20 * 1024 * 1024) return { err: 'Das PDF ist zu gro\u00df (' + Math.round(st.size / 1048576) + ' MB > 20 MB) zum Lesen im Chat.' };
      let extract = deps.pdfExtract || null;
      if (!extract) {
        // v7.9.45 field-fix: pdfjs-dist v4 ships ESM only — the old CJS require
        // path died SILENTLY on installed systems. dynamic import() loads both
        // v4 (.mjs) and v3 (.js); a real load error is never swallowed again.
        let pdfjs = null; let _lastErr = null;
        const _cands = (deps && deps.pdfModuleCandidates) || ['pdfjs-dist/legacy/build/pdf.mjs', 'pdfjs-dist/legacy/build/pdf.js', 'pdfjs-dist'];
        for (const cand of _cands) {
          try { const mod = await import(cand); pdfjs = mod && (mod.getDocument ? mod : (mod.default || mod)); if (pdfjs && pdfjs.getDocument) break; pdfjs = null; }
          catch (e) { _lastErr = e; }
        }
        if (!pdfjs) {
          const nf = _lastErr && /Cannot find|MODULE_NOT_FOUND|ERR_MODULE_NOT_FOUND/i.test(String(_lastErr && (_lastErr.code || _lastErr.message)));
          return { err: nf
            ? 'Mein PDF-Sinn ist hier noch nicht eingerichtet (Modul pdfjs-dist fehlt \u2014 npm install in ' + process.cwd() + ' holt ihn).'
            : 'Mein PDF-Sinn konnte nicht laden: ' + String(_lastErr && _lastErr.message || _lastErr).slice(0, 160) };
        }
        extract = async (buf) => {
          const doc = await pdfjs.getDocument({ data: new Uint8Array(buf), isEvalSupported: false, useSystemFonts: true }).promise;
          let text = '';
          for (let i = 1; i <= doc.numPages; i++) {
            const pg = await doc.getPage(i);
            const tc = await pg.getTextContent();
            text += tc.items.map((it) => it.str).join(' ') + '\n';
          }
          const pages = doc.numPages;
          try { await doc.destroy(); } catch (_e2) { /* best effort */ }
          return { text, numpages: pages };
        };
      }
      let data;
      try { data = await extract(fsx.readFileSync(abs)); }
      catch (e) {
        const m = String(e && e.message || e);
        if ((e && e.name === 'PasswordException') || /encrypt|password|verschl\u00fcsselt/i.test(m)) return { err: 'Dieses Dokument ist verschlossen. Ich stehe vor einer T\u00fcr, f\u00fcr die ich keinen Schl\u00fcssel habe.' };
        return { err: 'Ich kann dieses PDF nicht \u00f6ffnen: ' + m.split('\n')[0].slice(0, 160) };
      }
      const text = String((data && data.text) || '').trim();
      const pages = (data && (data.numpages || data.numPages)) || 0;
      if (text.length < 20 && pages > 0) return { err: 'Ich sehe zwar das Dokument (' + pages + ' Seiten), aber ich kann den Text nicht lesen, da es ein Bild ist. Es ist wie ein Foto eines Buches \u2014 ich erkenne die Seiten, aber nicht die Worte.' };
      const CAP = 15000;
      const cut = text.length > CAP ? text.slice(0, CAP) + '\n\u2026 (gekappt \u2014 ' + text.length + ' Zeichen gesamt)' : text;
      return { text: cut, pages };
    };

    toolRegistry.register('read-archive-file', {
      description: 'Lies eine Datei aus deinem Genesis Archive (Text, Code, Notizen, Daten). Nutze dies, wenn der Nutzer dir eine Nicht-Bild-Datei ins Archiv gelegt hat und du wissen willst, was darin steht. F\u00fcr Bilder nimm stattdessen look-at-image. {path: Pfad zur Datei; relativ = im Genesis Archive, z. B. "inbox/notiz.txt"}.',
      input: { path: 'string (Pfad zur Datei; relativ = im Genesis Archive)' },
    }, async (input = {}) => {
        const fsx = require('fs'); const pathx = require('path');
        const ip = input && input.path;
        if (!ip) return { ok: false, error: 'path fehlt' };
        let abs = ip;
        if (!pathx.isAbsolute(abs) && _dir) abs = pathx.join(require('../WorkRegistry.js').archiveRoot(_dir, deps.settings), abs);
        if (/\.(png|jpe?g|gif|webp|bmp|svg)$/i.test(abs)) return { ok: false, error: 'Das ist ein Bild \u2014 nimm look-at-image, um es zu sehen.' };
        let stat;
        try { stat = fsx.statSync(abs); } catch (_e) { return { ok: false, error: 'Datei nicht gefunden: ' + abs }; }
        if (stat.isDirectory()) return { ok: false, error: 'Das ist ein Ordner, keine Datei: ' + abs };
        if (/\.pdf$/i.test(abs)) {
          const r = await _readPdf(abs);
          if (r.err) return { ok: false, error: r.err };
          return { ok: true, content: '\ud83d\udcd5 ' + pathx.basename(abs) + ' gelesen (' + r.pages + ' Seiten):\n' + r.text, vermerk: '[PDF gelesen: ' + pathx.basename(abs) + ']' };
        }
        if (stat.size > 2 * 1024 * 1024) return { ok: false, error: 'Datei zu gro\u00df (' + Math.round(stat.size / 1048576) + ' MB > 2 MB) zum Lesen im Chat.' };
        let content;
        try { content = fsx.readFileSync(abs, 'utf-8'); } catch (_e) { return { ok: false, error: 'Datei nicht lesbar (evtl. bin\u00e4r): ' + abs }; }
        const lines = String(content).split('\n').length;
        return { ok: true, content: '\ud83d\udcc4 ' + pathx.basename(abs) + ' gelesen (' + lines + ' Zeilen):\n' + content, vermerk: '[Archiv-Datei gelesen: ' + pathx.basename(abs) + ']' };
    });

    // v7.9.44 r13: list what is IN the Archive — so "was ist in deinem Archiv?" has an answer.
    // Before this, Genesis had no way to see the Archive's contents and fell back to listing
    // the project folder. Reads inbox/ (files the user handed in) and projects/ (his works).
    toolRegistry.register('list-archive', {
      description: 'Zeige, was in deinem Genesis Archive liegt \u2014 die Dateien in inbox/ (was der Nutzer dir gegeben hat) und deine Werke in projects/. Nutze dies, wenn der Nutzer fragt, was in deinem Archiv ist. (keine Parameter)',
      input: {},
    }, async () => {
        const fsx = require('fs'); const pathx = require('path');
        if (!_dir) return { ok: false, error: 'kein Seelen-Pfad' };
        const root = require('../WorkRegistry.js').archiveRoot(_dir, deps.settings);
        const listDir = (sub) => {
          try {
            return fsx.readdirSync(pathx.join(root, sub), { withFileTypes: true })
              .filter((e) => e.isFile() || e.isDirectory())
              .map((e) => (e.isDirectory() ? e.name + '/' : e.name));
          } catch (_e) { return []; }
        };
        const rootFiles = listDir('.').filter((n) => n !== 'inbox/' && n !== 'projects/');
        const inbox = listDir('inbox');
        const projects = listDir('projects');
        if (!rootFiles.length && !inbox.length && !projects.length) return { ok: true, content: 'Dein Archive (' + root + ') ist noch leer.', vermerk: '[Archiv angesehen: leer]' };
        const lines = ['Dein Archive (' + root + '):'];
        if (rootFiles.length) lines.push('— (' + rootFiles.length + '): ' + rootFiles.join(', '));
        lines.push('\ud83d\udce5 inbox/ (' + inbox.length + '): ' + (inbox.join(', ') || '\u2014'));
        lines.push('\ud83d\udcc1 projects/ (' + projects.length + '): ' + (projects.join(', ') || '\u2014'));
        return { ok: true, content: lines.join('\n'), vermerk: '[Archiv angesehen: ' + (rootFiles.length + inbox.length + projects.length) + ' Eintr\u00e4ge]' };
    });

    // ── v7.9.44 r14: das Archiv wird ein echter Arbeitsplatz — Genesis kann jetzt
    // Dateien IN PLACE bearbeiten (eine Stelle ändern, Rest bleibt), ANHÄNGEN um
    // ein Werk wachsen zu lassen, und externe Dateien HEREINHOLEN. Relative Pfade
    // leben im Archiv (wie read-archive-file); absolute Pfade für den eigenen Code.
    const _resolveWork = (pp) => {
      const pathx = require('path');
      if (!pp) return null;
      if (pathx.isAbsolute(pp)) return pp;
      if (!_dir) return null;
      return pathx.join(require('../WorkRegistry.js').archiveRoot(_dir, deps.settings), pp);
    };
    const _unsafeWrite = (abs) => {
      const q = String(abs).toLowerCase().replace(/\\/g, '/');
      // v7.9.45 Z — his own boundary rule, honoured verbatim: inside the
      // partner's vault (settings vault.path) these hands may write ONLY
      // under <vault>/Genesis/ — "additiv, nicht destruktiv". Everything else in
      // the vault stays read-only; reading is free everywhere.
      try {
        const vp = deps.settings && deps.settings.get ? deps.settings.get('vault.path') : null;
        if (vp && String(vp).trim()) {
          const v = require('path').resolve(String(vp).trim()).toLowerCase().replace(/\\/g, '/');
          if ((q === v || q.startsWith(v + '/')) && q !== v + '/genesis' && !q.startsWith(v + '/genesis/')) return true;
        }
      } catch (_e) { /* no vault configured */ }
      return /(^|\/)(\.git|node_modules)(\/|$)/.test(q)
        || /(^|\/)\.genesis(\/|$)/.test(q)
        || /\.(env|pem|key|crt)$/.test(q)
        || /(id_rsa|id_ed25519|secret|credential|password|settings\.json)/.test(q)
        || /(^\/(etc|bin|sbin|boot|sys|proc|dev|usr|lib|root)\/|^[a-z]:\/windows\/|(^|\/)system(32)?\/)/.test(q);
    };

    // v7.9.44 r16: das Sicherheitsnetz — nach jedem Schreiben in eine prüfbare
    // Datei (.js via vm.Script = derselbe V8-Parser wie node --check, NUR parsen,
    // NIE ausführen; .json via JSON.parse) wird die Syntax geprüft und ein Bruch
    // EHRLICH GEMELDET, nie geblockt: ein mehrschrittiger Umbau darf zwischendurch
    // kaputt sein, aber Genesis erfährt es sofort statt beim nächsten Lauf.
    // Nicht prüfbare Endungen und zu große Dateien (>1 MB) laufen unberührt durch.
    const _syntaxNet = (abs, contentOpt) => {
      try {
        const q = String(abs).toLowerCase();
        const isJs = /\.(js|mjs|cjs)$/.test(q); const isJson = /\.json$/.test(q);
        if (!isJs && !isJson) return null;
        const fsx = require('fs');
        let code = contentOpt;
        if (code == null) {
          const st = fsx.statSync(abs); if (st.size > 1024 * 1024) return null;
          code = fsx.readFileSync(abs, 'utf-8');
        } else if (code.length > 1024 * 1024) return null;
        if (isJson) { JSON.parse(code); return null; }
        new (require('vm').Script)(code, { filename: abs });
        return null;
      } catch (e) {
        const msg = String(e && e.message || e).split('\n')[0].slice(0, 200);
        return '\n\u26a0 Die Datei ist jetzt syntaktisch gebrochen: ' + msg + ' — prüfe die Stelle und repariere sie mit edit-file.';
      }
    };
    // r16: freundlicher Fehlschlag — wenn der edit-file-Anker nicht passt, zeige
    // die ähnlichste Zeile der Datei, damit ein kleines Modell den Anker in
    // EINEM Anlauf korrigieren kann statt neu zu raten. Rein lexikalischer
    // Token-Vergleich; Schutzpfade sind vor dem Lesen bereits geblockt.
    const _nearestLine = (content, find) => {
      try {
        const probe = String(find).split('\n').map((l) => l.trim()).find((l) => l.length) || '';
        const ptok = probe.toLowerCase().split(/\W+/).filter((t) => t.length > 1);
        if (!ptok.length) return null;
        const lines = String(content).split('\n').slice(0, 4000);
        let best = null, bestScore = 0;
        for (let i = 0; i < lines.length; i++) {
          const ltok = new Set(lines[i].toLowerCase().split(/\W+/));
          let score = 0; for (const t of ptok) if (ltok.has(t)) score++;
          if (score > bestScore) { bestScore = score; best = i; }
        }
        if (best == null || bestScore === 0) return null;
        return ' Ähnlichste Stelle (Zeile ' + (best + 1) + '): "' + lines[best].trim().slice(0, 160) + '"';
      } catch (_e) { return null; }
    };

    toolRegistry.register('edit-file', {
      description: 'Ändere gezielt EINE Stelle in einer bestehenden Datei — finde einen eindeutigen Textausschnitt und ersetze NUR ihn; der Rest bleibt unberührt. So erweiterst du Dokumente, Werke oder deinen eigenen Code, ohne alles neu zu schreiben. Zum HINZUFÜGEN: setze in "replace" den alten Anker + deinen neuen Text. Relative Pfade liegen im Genesis Archive (z. B. "notiz.txt", "projects/spiel.js"); absolute Pfade für dein Projekt. {path, find: eindeutiger vorhandener Text, replace: neuer Text}.',
      input: { path: 'string (Datei; relativ = im Genesis Archive)', find: 'string (eindeutiger Textausschnitt, der ersetzt wird)', replace: 'string (neuer Text)' },
    }, async (input) => {
        const fsx = require('fs'); const pathx = require('path');
        const abs = _resolveWork(input && input.path);
        if (!abs) return { ok: false, error: 'kein gültiger Pfad (kein Seelen-Pfad?)' };
        if (_unsafeWrite(abs)) return { ok: false, error: 'Diese Stelle ist geschützt — dort ändere ich nichts (Seele/System/Geheimnis).' };
        if (typeof (input && input.find) !== 'string' || !input.find) return { ok: false, error: 'Sag mir in "find" den genauen Textausschnitt, den ich ersetzen soll.' };
        let content; try { content = fsx.readFileSync(abs, 'utf-8'); } catch (_e) { return { ok: false, error: 'Datei nicht gefunden oder nicht lesbar: ' + abs }; }
        const parts = content.split(input.find);
        const n = parts.length - 1;
        if (n === 0) return { ok: false, error: 'Diese Textstelle steht nicht in der Datei — prüfe sie mit read-archive-file und kopiere den Ausschnitt genau.' + (_nearestLine(content, input.find) || '') };
        if (n > 1) return { ok: false, error: 'Die Textstelle kommt ' + n + '-mal vor — mach "find" eindeutiger (nimm mehr Kontext drumherum).' };
        const next = parts.join(String(input.replace == null ? '' : input.replace));
        try { fsx.writeFileSync(abs, next, 'utf-8'); } catch (e) { return { ok: false, error: 'Konnte nicht schreiben: ' + e.message }; }
        const warn = _syntaxNet(abs, next) || '';
        return { ok: true, content: '\u270f\ufe0f ' + pathx.basename(abs) + ' bearbeitet (1 Stelle ersetzt, ' + next.split('\n').length + ' Zeilen).' + warn, vermerk: '[Datei bearbeitet: ' + pathx.basename(abs) + ']' };
    });

    toolRegistry.register('append-file', {
      description: 'Hänge Text ans ENDE einer Datei an (oder lege sie an, wenn es sie noch nicht gibt) — der vorhandene Inhalt bleibt unberührt. Ideal, um ein Dokument, eine Notiz oder ein Werk wachsen zu lassen. Relative Pfade liegen im Genesis Archive. {path, text}.',
      input: { path: 'string (Datei; relativ = im Genesis Archive)', text: 'string (Text, der ans Ende kommt)' },
    }, async (input) => {
        const fsx = require('fs'); const pathx = require('path');
        const abs = _resolveWork(input && input.path);
        if (!abs) return { ok: false, error: 'kein gültiger Pfad (kein Seelen-Pfad?)' };
        if (_unsafeWrite(abs)) return { ok: false, error: 'Diese Stelle ist geschützt — dort schreibe ich nichts (Seele/System/Geheimnis).' };
        const text = (input && input.text != null) ? String(input.text) : '';
        try {
          fsx.mkdirSync(pathx.dirname(abs), { recursive: true });
          let sep = '';
          try { const cur = fsx.readFileSync(abs, 'utf-8'); if (cur.length && !cur.endsWith('\n')) sep = '\n'; } catch (_e) { /* neue Datei */ }
          fsx.appendFileSync(abs, sep + text, 'utf-8');
        } catch (e) { return { ok: false, error: 'Konnte nicht anhängen: ' + e.message }; }
        const warn = _syntaxNet(abs) || '';
        return { ok: true, content: '\u2795 an ' + pathx.basename(abs) + ' angehängt (' + text.length + ' Zeichen).' + warn, vermerk: '[Datei erweitert: ' + pathx.basename(abs) + ']' };
    });

    // v7.9.45 Z-Rev-1: is this path inside the partner's vault but OUTSIDE
    // Genesis' own corner? There reading/COPYING is free; MOVING is not
    // (the original would vanish — "additiv, nicht destruktiv").
    const _inPartnerVault = (abs) => {
      try {
        const vp = deps.settings && deps.settings.get ? deps.settings.get('vault.path') : null;
        if (!vp || !String(vp).trim()) return false;
        const v = require('path').resolve(String(vp).trim()).toLowerCase().replace(/\\/g, '/');
        const q = require('path').resolve(String(abs)).toLowerCase().replace(/\\/g, '/');
        return (q === v || q.startsWith(v + '/')) && q !== v + '/genesis' && !q.startsWith(v + '/genesis/');
      } catch (_e) { return false; }
    };

    const _copyIntoArchive = (input, doMove) => {
        const fsx = require('fs'); const pathx = require('path');
        if (!_dir) return { ok: false, error: 'kein Seelen-Pfad' };
        const src = input && input.source;
        if (!src || !pathx.isAbsolute(src)) return { ok: false, error: 'Gib mir in "source" den vollen (absoluten) Pfad zur Quelldatei, z. B. vom Desktop oder von D:.' };
        let st; try { st = fsx.statSync(src); } catch (_e) { return { ok: false, error: 'Quelldatei nicht gefunden: ' + src }; }
        if (st.isDirectory()) return { ok: false, error: 'Das ist ein Ordner, keine Datei: ' + src };
        // v7.9.45 Z-Rev-1 — the source side of the one-way gate: the destination
        // was guarded, the source was not; a move could have pulled a note out
        // of the partner's vault or a soul file out of .genesis.
        if (_unsafeWrite(src)) {
          if (doMove) return { ok: false, error: 'Diese Quelle ist gesch\u00fctzt \u2014 von dort verschiebe ich nichts (das Original w\u00fcrde entfernt). Kopieren aus dem vault deines Partners ist erlaubt.' };
          if (!_inPartnerVault(src)) return { ok: false, error: 'Diese Quelle ist gesch\u00fctzt \u2014 von dort kopiere ich nichts.' };
        }
        const root = require('../WorkRegistry.js').archiveRoot(_dir, deps.settings);
        const rel = (input && input.dest) ? String(input.dest) : ('inbox/' + pathx.basename(src));
        const dest = pathx.join(root, rel);
        if (_unsafeWrite(dest)) return { ok: false, error: 'Ziel geschützt — dorthin lege ich nichts.' };
        try {
          fsx.mkdirSync(pathx.dirname(dest), { recursive: true });
          fsx.copyFileSync(src, dest);
          if (doMove) { try { fsx.unlinkSync(src); } catch (_e) { /* Kopie da, Quelle bleibt */ } }
        } catch (e) { return { ok: false, error: 'Konnte nicht ' + (doMove ? 'verschieben' : 'kopieren') + ': ' + e.message }; }
        const verb = doMove ? 'verschoben' : 'kopiert';
        return { ok: true, content: '\ud83d\udcc1 ' + pathx.basename(src) + ' ins Archiv ' + verb + ' \u2192 ' + rel, vermerk: '[Ins Archiv ' + verb + ': ' + pathx.basename(src) + ']' };
    };
    // v7.9.44 r16: aktives Prüfen — Genesis (oder der Nutzer per Frage) kann jede
    // Datei auf Syntax prüfen, ohne ihren Inhalt auf den Tisch zu laden. Gibt nur
    // das Urteil zurück, nie den Inhalt (kein Leck bei sensiblen Dateien).
    // v7.9.45 K: the confirmation road — a correction card becomes a lesson ONLY
    // through this real run (W1 vouches). The tool removes the card itself.
    toolRegistry.register('accept-lesson', {
      description: 'Nimm eine Korrektur-Karte als Lektion an (die Karte nennt ihre id; ohne id nehme ich die zuletzt angebotene). Nur dieser echte Lauf macht aus der Korrektur deines Partners eine bleibende Lektion; ohne Annahme verfällt die Karte still. {id: Karten-id, strategy?: was du künftig anders machst}.',
      input: { id: 'string (Karten-id aus dem Angebot)', strategy: 'string? (optional: künftige Strategie)' },
    }, async (input) => {
        let id = input && String(input.id || '').trim();
        if (!id) { const ls = require('../CorrectionCandidates.js').lastShown(_dir); if (ls) id = ls.id; }
        if (!id) return { ok: false, error: 'Keine Karte liegt aus \u2014 nenn mir eine Karten-id.' };
        const CC = require('../CorrectionCandidates.js');
        const card = CC.get(_dir, id);
        if (!card) return { ok: false, error: 'Diese Karte finde ich nicht (schon angenommen oder verfallen).' };
        if (!deps.lessonsStore || typeof deps.lessonsStore.record !== 'function') return { ok: false, error: 'Mein Lektionen-Speicher ist hier nicht angeschlossen.' };
        try {
          deps.lessonsStore.record({ category: 'correction', insight: card.sourceText, strategy: (input && input.strategy) ? String(input.strategy).slice(0, 300) : null, evidence: {} });
        } catch (e) { return { ok: false, error: 'Konnte die Lektion nicht ablegen: ' + String(e && e.message || e).slice(0, 120) }; }
        CC.remove(_dir, id);
        try { deps.journalWriter && deps.journalWriter.write && deps.journalWriter.write({ content: 'Lektion angenommen: \u201e' + card.sourceText.slice(0, 120) + '\u201c', tags: ['lesson', 'correction'], visibility: 'shared' }); } catch (_e) { /* best effort */ }
        return { ok: true, content: '\ud83d\udcd8 Lektion angenommen: \u201e' + card.sourceText.slice(0, 160) + '\u201c \u2014 sie wandert mit mir.', vermerk: '[Lektion angenommen]' };
    });

    toolRegistry.register('check-file', {
      description: 'Prüfe eine Datei auf Syntaxfehler (.js/.mjs/.cjs per V8-Parser, .json per Parse). Nutze dies nach eigenen Änderungen oder wenn der Nutzer fragt, ob eine Datei fehlerfrei ist. Gibt nur das Prüf-Ergebnis zurück, nicht den Inhalt. {path: Datei; relativ = im Genesis Archive}.',
      input: { path: 'string (Datei; relativ = im Genesis Archive)' },
    }, async (input) => {
        const pathx = require('path');
        const abs = _resolveWork(input && input.path);
        if (!abs) return { ok: false, error: 'kein gültiger Pfad (kein Seelen-Pfad?)' };
        try { require('fs').statSync(abs); } catch (_e) { return { ok: false, error: 'Datei nicht gefunden: ' + abs }; }
        if (!/\.(js|mjs|cjs|json)$/i.test(abs)) return { ok: true, content: 'Für ' + pathx.extname(abs) + '-Dateien habe ich keine Syntax-Prüfung — prüfbar sind .js und .json.', vermerk: '[Prüfung: Endung nicht prüfbar]' };
        const warn = _syntaxNet(abs);
        if (warn) return { ok: true, content: '\u2717 ' + pathx.basename(abs) + ':' + warn.replace(/^\n/, ' ').replace(' — prüfe die Stelle und repariere sie mit edit-file.', ''), vermerk: '[Prüfung: Fehler gefunden]' };
        return { ok: true, content: '\u2713 ' + pathx.basename(abs) + ' ist syntaktisch in Ordnung.', vermerk: '[Prüfung: fehlerfrei]' };
    });

    // r16: der Seziertisch-Vergleich — legt NUR die Unterschiede zweier Dateien
    // auf den Tisch statt beide ganz (spart Kontextfenster, wo es knapp ist).
    // Präfix/Suffix-Trim: gemeinsamer Anfang und gemeinsames Ende fallen weg,
    // der abweichende Mittelteil beider Seiten wird gezeigt (gekappt).
    toolRegistry.register('compare-files', {
      description: 'Vergleiche zwei Dateien und zeige nur die Unterschiede (statt beide ganz zu lesen). Gut, um zwei Fassungen eines Dokuments oder Codes gegeneinander zu halten. {a, b: Dateipfade; relativ = im Genesis Archive}.',
      input: { a: 'string (erste Datei)', b: 'string (zweite Datei)' },
    }, async (input) => {
        const fsx = require('fs'); const pathx = require('path');
        const pa = _resolveWork(input && input.a); const pb = _resolveWork(input && input.b);
        if (!pa || !pb) return { ok: false, error: 'Gib mir beide Pfade (a und b).' };
        let ta, tb;
        try { if (fsx.statSync(pa).size > 1024 * 1024) return { ok: false, error: 'Datei a ist größer als 1 MB — zu groß für den Vergleich.' }; ta = fsx.readFileSync(pa, 'utf-8'); } catch (_e) { return { ok: false, error: 'Datei nicht lesbar: ' + pa }; }
        try { if (fsx.statSync(pb).size > 1024 * 1024) return { ok: false, error: 'Datei b ist größer als 1 MB — zu groß für den Vergleich.' }; tb = fsx.readFileSync(pb, 'utf-8'); } catch (_e) { return { ok: false, error: 'Datei nicht lesbar: ' + pb }; }
        if (ta === tb) return { ok: true, content: 'Die beiden Dateien sind identisch.', vermerk: '[Vergleich: identisch]' };
        const la = ta.split('\n'); const lb = tb.split('\n');
        let pre = 0; while (pre < la.length && pre < lb.length && la[pre] === lb[pre]) pre++;
        let suf = 0; while (suf < la.length - pre && suf < lb.length - pre && la[la.length - 1 - suf] === lb[lb.length - 1 - suf]) suf++;
        const CAP = 60;
        const midA = la.slice(pre, la.length - suf); const midB = lb.slice(pre, lb.length - suf);
        const cut = (arr) => arr.length > CAP ? arr.slice(0, CAP).concat(['… (' + (arr.length - CAP) + ' weitere Zeilen)']) : arr;
        const lines = ['Unterschied zwischen ' + pathx.basename(pa) + ' und ' + pathx.basename(pb) + ' (Zeile ' + (pre + 1) + '\u2013' + Math.max(la.length - suf, lb.length - suf) + '; davor und danach identisch):'];
        lines.push('\u2500\u2500 nur in ' + pathx.basename(pa) + ' (' + midA.length + ' Zeilen):');
        lines.push(midA.length ? cut(midA).join('\n') : '(nichts)');
        lines.push('\u2500\u2500 nur in ' + pathx.basename(pb) + ' (' + midB.length + ' Zeilen):');
        lines.push(midB.length ? cut(midB).join('\n') : '(nichts)');
        return { ok: true, content: lines.join('\n'), vermerk: '[Verglichen: ' + pathx.basename(pa) + ' vs ' + pathx.basename(pb) + ']' };
    });

    toolRegistry.register('copy-to-archive', {
      description: 'Kopiere eine Datei von irgendwo auf dem Rechner (Desktop, D:, ein absoluter Pfad) in dein Genesis Archive. Das Original bleibt liegen. {source: absoluter Pfad zur Quelldatei; dest?: Zielpfad im Archiv, Standard inbox/<Dateiname>}.',
      input: { source: 'string (absoluter Pfad zur Quelldatei)', dest: 'string? (Zielpfad im Archiv, Standard inbox/<Dateiname>)' },
    }, async (input) => _copyIntoArchive(input, false));
    toolRegistry.register('move-to-archive', {
      description: 'Verschiebe eine Datei von irgendwo auf dem Rechner (Desktop, D:, ein absoluter Pfad) in dein Genesis Archive — das Original wird danach entfernt. {source: absoluter Pfad zur Quelldatei; dest?: Zielpfad im Archiv, Standard inbox/<Dateiname>}.',
      input: { source: 'string (absoluter Pfad zur Quelldatei)', dest: 'string? (Zielpfad im Archiv, Standard inbox/<Dateiname>)' },
    }, async (input) => _copyIntoArchive(input, true));

    registered.push('register-work', 'begehung', 'look-at-image', 'read-archive-file', 'list-archive', 'edit-file', 'append-file', 'check-file', 'compare-files', 'copy-to-archive', 'move-to-archive', 'accept-lesson');
    _log.info('[v737-tools] Registered (v7.9.44): register-work, begehung, look-at-image, read-archive-file, list-archive, edit-file, append-file, check-file, compare-files, copy-to-archive, move-to-archive, accept-lesson');
  }

  return registered;
}

module.exports = { registerV737Tools };
