// ============================================================
// GENESIS — src/agent/cognitive/CorrectionCandidates.js
// v7.9.45 K: the correction ledger — when the partner corrects Genesis in
// chat, the moment becomes a CANDIDATE, never silently a lesson. Genesis
// confirms by a REAL accept-lesson run (the tool removes the card itself);
// otherwise the card decays by his .43 measures: after 3 days, never more
// than 5 open (oldest goes), and after the 3rd offer left unanswered —
// every decay leaves the short journal note, no reproach.
// ============================================================
'use strict';
const fs = require('fs');
const path = require('path');

const FILE = 'correction-candidates.jsonl';
const MAX_AGE_MS = 3 * 24 * 60 * 60 * 1000;
const MAX_OPEN = 5;
const MAX_SHOWN = 3;
const SHOW_GAP_MS = 30 * 60 * 1000;

function _file(dir) { return path.join(dir, FILE); }
function _loadAll(dir) {
  try {
    return fs.readFileSync(_file(dir), 'utf8').split('\n').filter(Boolean)
      .map((l) => { try { return JSON.parse(l); } catch (_e) { return null; } }).filter(Boolean);
  } catch (_e) { return []; }
}
function _saveAll(dir, list) {
  try { fs.writeFileSync(_file(dir), list.map((c) => JSON.stringify(c)).join('\n') + (list.length ? '\n' : '')); }
  catch (_e) { /* best effort */ }
}
function _note(journalWriter, c) {
  if (!journalWriter || typeof journalWriter.write !== 'function') return;
  try {
    journalWriter.write({ content: 'Korrektur-Vorschlag verfallen: \u201e' + String(c.sourceText).slice(0, 120) + '\u201c', tags: ['correction-candidate', 'decayed'], visibility: 'shared' });
  } catch (_e) { /* best effort */ }
}

function add(dir, { sourceText }) {
  if (!dir || !sourceText) return null;
  const list = _loadAll(dir);
  const c = { id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6), ts: Date.now(), sourceText: String(sourceText).slice(0, 300), src: 'correction', shownCount: 0, lastShownTs: 0, expiresTs: Date.now() + MAX_AGE_MS };
  list.push(c); _saveAll(dir, list); return c;
}

function get(dir, id) { return _loadAll(dir).find((c) => c.id === id) || null; }

function decay(dir, now, journalWriter) {
  now = now || Date.now();
  const list = _loadAll(dir);
  const keep = []; const gone = [];
  for (const c of list) {
    const tooOld = now > (c.expiresTs || 0);
    const shownOut = (c.shownCount || 0) >= MAX_SHOWN && (now - (c.lastShownTs || 0)) > SHOW_GAP_MS;
    if (tooOld || shownOut) gone.push(c); else keep.push(c);
  }
  while (keep.length > MAX_OPEN) gone.push(keep.shift());
  if (gone.length) { _saveAll(dir, keep); gone.forEach((c) => _note(journalWriter, c)); }
  return { open: keep, decayed: gone };
}

/** The one offer: names the card id so a real accept-lesson run can confirm it. */
function pickOffer(dir, now) {
  now = now || Date.now();
  const { open } = decay(dir, now, null);
  const c = open.find((x) => (now - (x.lastShownTs || 0)) > SHOW_GAP_MS && (x.shownCount || 0) < MAX_SHOWN);
  if (!c) return null;
  c.shownCount = (c.shownCount || 0) + 1; c.lastShownTs = now;
  _saveAll(dir, open);
  return { card: c, block: 'Dein Partner hat dich korrigiert: \u201e' + c.sourceText + '\u201c \u2014 als Lektion behalten? Dann rufe accept-lesson mit id "' + c.id + '". Sonst lass die Karte liegen; sie verf\u00e4llt still.' };
}

function lastShown(dir) {
  const list = _loadAll(dir);
  return list.filter((c) => c.lastShownTs).sort((a, b) => b.lastShownTs - a.lastShownTs)[0] || null;
}

function remove(dir, id) {
  const list = _loadAll(dir);
  const keep = list.filter((c) => c.id !== id);
  if (keep.length !== list.length) _saveAll(dir, keep);
  return keep.length !== list.length;
}

module.exports = { add, get, decay, pickOffer, lastShown, remove, FILE, MAX_OPEN, MAX_SHOWN, MAX_AGE_MS };
