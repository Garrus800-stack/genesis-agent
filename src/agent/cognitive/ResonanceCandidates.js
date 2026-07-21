// ============================================================
// GENESIS — src/agent/cognitive/ResonanceCandidates.js
// v7.9.43 W3: the candidate ledger for the Nachklang, Genesis' measures
// verbatim: decay after 3 days, never more than 5 open (oldest goes),
// and after the 3rd offer left unanswered. Every decay leaves a short
// journal note when a writer is handed in — "kein Vorwurf". Candidates
// NEVER enter resonance.jsonl themselves; resonance-note stays the only
// anchor ("der einzige Weg, etwas wirklich zu verankern").
// ============================================================
'use strict';
const fs = require('fs');
const path = require('path');

const FILE = 'resonance-candidates.jsonl';
const MAX_AGE_MS = 3 * 24 * 60 * 60 * 1000;
const MAX_OPEN = 5;
const MAX_SHOWN = 3;
const SHOW_GAP_MS = 30 * 60 * 1000; // one offer per awakening, practically

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
    journalWriter.write({ content: 'Vorschlag verfallen: \u201e' + String(c.sourceText).slice(0, 120) + '\u201c', tags: ['resonance-candidate', 'decayed'], visibility: 'shared' });
  } catch (_e) { /* best effort */ }
}

function add(dir, { sourceText, src }) {
  if (!dir || !sourceText) return null;
  const list = _loadAll(dir);
  const c = { id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6), ts: Date.now(), sourceText: String(sourceText).slice(0, 400), src: src === 'dream' ? 'dream' : 'heuristic', shownCount: 0, lastShownTs: 0, expiresTs: Date.now() + MAX_AGE_MS };
  list.push(c); _saveAll(dir, list); return c;
}

/** Apply all three decay rules. Notes are written only when a writer is given. */
function decay(dir, now, journalWriter) {
  now = now || Date.now();
  const list = _loadAll(dir);
  const keep = []; const gone = [];
  for (const c of list) {
    const tooOld = now > (c.expiresTs || 0);
    const shownOut = (c.shownCount || 0) >= MAX_SHOWN && (now - (c.lastShownTs || 0)) > SHOW_GAP_MS;
    if (tooOld || shownOut) gone.push(c); else keep.push(c);
  }
  while (keep.length > MAX_OPEN) gone.push(keep.shift()); // oldest first
  if (gone.length) { _saveAll(dir, keep); gone.forEach((c) => _note(journalWriter, c)); }
  return { open: keep, decayed: gone };
}

/** The one offer for this awakening: oldest open card not shown recently. */
function pickOffer(dir, now) {
  now = now || Date.now();
  const { open } = decay(dir, now, null);
  const c = open.find((x) => (now - (x.lastShownTs || 0)) > SHOW_GAP_MS && (x.shownCount || 0) < MAX_SHOWN);
  if (!c) return null;
  c.shownCount = (c.shownCount || 0) + 1; c.lastShownTs = now;
  _saveAll(dir, open);
  const lead = c.src === 'dream' ? 'Aus dem Traum liegt ein Vorschlag' : 'Aus dem Gespr\u00e4ch liegt ein Vorschlag';
  return { card: c, block: lead + ': \u201e' + c.sourceText + '\u201c \u2014 mitnehmen oder loslassen?' };
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

module.exports = { add, decay, pickOffer, lastShown, remove, FILE, MAX_OPEN, MAX_SHOWN, MAX_AGE_MS };
