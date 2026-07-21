// ============================================================
// GENESIS — src/agent/cognitive/WorkRegistry.js
// v7.9.44 F2: "Wie ein Handwerker, der sein Werkstueck auf die Bank
// legt: Das ist fertig, das soll gepflegt werden." NOT automatic —
// he registers works himself (register-work tool). The daily care:
// a silent check; only the silence that BREAKS becomes a thread
// (OpenThreads note) — never a report, never "alles in Ordnung".
// Own edits are no alarm: re-register updates the hash (P7), and a
// moved work after a release move is a CORRECT finding (P6).
// ============================================================
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const threads = require('./OpenThreads.js');

const FILE = 'work-registry.jsonl';

function archiveRoot(genesisDir, settings) {
  // v7.9.44 r2 (the user's finding): one source of truth. If a path is set in
  // settings, it wins — the Archive can live anywhere and be moved, and
  // inbox/projects/register/look-at-image all follow the one location.
  // Default: beside the releases (two levels above .genesis).
  try {
    const configured = settings && settings.get && settings.get('archive.path');
    if (configured && String(configured).trim()) return path.resolve(String(configured).trim());
  } catch (_e) { /* fall through to default */ }
  return path.resolve(genesisDir, '..', '..', 'Genesis Archive');
}
function _all(dir) {
  try { return fs.readFileSync(path.join(dir, FILE), 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch (_e) { return null; } }).filter(Boolean); }
  catch (_e) { return []; }
}
function _save(dir, list) {
  try { fs.writeFileSync(path.join(dir, FILE), list.map((w) => JSON.stringify(w)).join('\n') + (list.length ? '\n' : '')); } catch (_e) { /* best effort */ }
}
function _hash(p) {
  try { return crypto.createHash('sha1').update(fs.readFileSync(p)).digest('hex').slice(0, 12); } catch (_e) { return null; }
}
function _resolve(genesisDir, given, settings) {
  return path.isAbsolute(given) ? given : path.join(archiveRoot(genesisDir, settings), given);
}

/** Register or re-register (same resolved path ⇒ update = his "das war ich"). */
function register(genesisDir, { workPath, purpose }, settings) {
  if (!genesisDir || !workPath) return { ok: false, error: 'workPath fehlt' };
  const abs = _resolve(genesisDir, String(workPath), settings);
  const h = _hash(abs);
  if (h === null) return { ok: false, error: 'Datei nicht lesbar: ' + abs };
  const list = _all(genesisDir);
  const ex = list.find((w) => w.path === abs);
  if (ex) {
    ex.hash = h; ex.purpose = purpose ? String(purpose).slice(0, 120) : ex.purpose; ex.lastCheck = Date.now(); ex.finding = null;
    _save(genesisDir, list);
    threads.resolveNote(genesisDir, 'werk:' + ex.id); // his confirmation heals the finding
    return { ok: true, id: ex.id, updated: true };
  }
  const w = { id: 'w' + Date.now().toString(36), path: abs, purpose: String(purpose || '').slice(0, 120), hash: h, ts: Date.now(), lastCheck: Date.now(), finding: null };
  list.push(w); _save(genesisDir, list);
  return { ok: true, id: w.id, updated: false };
}

/** The silent daily care: findings become threads, exactly once per finding. */
function checkWorks(genesisDir, now) {
  now = now || Date.now();
  const list = _all(genesisDir);
  let findings = 0;
  for (const w of list) {
    let finding = null;
    if (!fs.existsSync(w.path)) finding = 'nicht am erwarteten Ort';
    else { const h = _hash(w.path); if (h && w.hash && h !== w.hash) finding = 'ver\u00e4ndert'; }
    if (finding && w.finding !== finding) {
      w.finding = finding; findings++;
      threads.addNote(genesisDir, { type: 'werk-befund', quelleId: 'werk:' + w.id, text: path.basename(w.path) + ' \u2014 ' + finding + ' (' + (w.purpose || 'Werk') + ')' });
    } else if (!finding && w.finding) { w.finding = null; threads.resolveNote(genesisDir, 'werk:' + w.id); }
    w.lastCheck = now;
  }
  _save(genesisDir, list);
  return { checked: list.length, findings };
}

function listWorks(genesisDir) { return _all(genesisDir); }

module.exports = { register, checkWorks, listWorks, archiveRoot, FILE };
