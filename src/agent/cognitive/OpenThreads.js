// ============================================================
// GENESIS — src/agent/cognitive/OpenThreads.js
// v7.9.44 F1: "Ein Faden, der nicht reisst. Ein Gedaechtnis, das aktiv
// wird, nicht nur auf Abruf." Threads are DISPLAY, not management: every
// thread lives in its source (pending moments, work findings, an open
// expectation, open goals) and dies with it. The block appears at
// awakening, before any candidate card; byte-identical silence when
// nothing is open. Sentences are MECHANICAL in v1 (honesty before
// elegance); interpretation is a later stage. Crash-safe by design:
// collection reads live sources — the anchor is never the only way.
// ============================================================
'use strict';
const fs = require('fs');
const path = require('path');

const NOTES = 'thread-notes.jsonl';       // work findings + misc (F2 writes here)
const DISPLAY = 'thread-display.json';    // shownCount/lastShownTs per thread key
const MAX_SHOW = 5;                       // his measure: three to five
const AGE_OUT = 5;                        // shown this often without source closure -> back of queue

function _lines(p) {
  try { return fs.readFileSync(p, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch (_e) { return null; } }).filter(Boolean); }
  catch (_e) { return []; }
}
function _loadDisplay(dir) { try { return JSON.parse(fs.readFileSync(path.join(dir, DISPLAY), 'utf8')); } catch (_e) { return {}; } }
function _saveDisplay(dir, d) { try { fs.writeFileSync(path.join(dir, DISPLAY), JSON.stringify(d)); } catch (_e) { /* best effort */ } }
function _ago(ts, now) {
  const h = Math.max(0, Math.round((now - ts) / 3600000));
  return h < 1 ? 'vor kurzem' : h < 24 ? 'vor ' + h + ' h' : 'vor ' + Math.round(h / 24) + ' Tagen';
}

function addNote(dir, { type, text, quelleId }) {
  if (!dir || !text) return false;
  try { fs.appendFileSync(path.join(dir, NOTES), JSON.stringify({ ts: Date.now(), type: type || 'notiz', text: String(text).slice(0, 200), quelleId: quelleId || null }) + '\n'); return true; }
  catch (_e) { return false; }
}
function resolveNote(dir, quelleId) {
  const p = path.join(dir, NOTES);
  const keep = _lines(p).filter((n) => n.quelleId !== quelleId);
  try { fs.writeFileSync(p, keep.map((n) => JSON.stringify(n)).join('\n') + (keep.length ? '\n' : '')); } catch (_e) { /* best effort */ }
}

/** Collect threads from live sources. Pure read; no repair, no writes. */
function collectThreads(dir, now) {
  now = now || Date.now();
  const threads = [];
  // Dedupe set: moments already lying as open candidate cards (the card wins — it is confirmable)
  const candTexts = _lines(path.join(dir, 'resonance-candidates.jsonl')).map((c) => String(c.sourceText || ''));
  // 1) self-marked moments — his most weighted source
  for (const m of _lines(path.join(dir, 'pending-moments.jsonl'))) {
    if (m.status && m.status !== 'pending') continue;
    const sum = String(m.summary || '').slice(0, 90);
    if (!sum) continue;
    if (candTexts.some((t) => t.includes(sum.slice(0, 40)))) continue; // P13 dedupe
    threads.push({ key: 'moment:' + m.id, prio: 4, satz: 'Markierter Moment: \u201e' + sum + '\u201c (' + _ago(m.ts || now, now) + ')' });
  }
  // 1b) vestibule (v7.9.46 L7/L8): unanswered knocks since 48h as ONE line;
  // a shield override by the inner circle gets its own line — visibility is the check.
  try {
    const book = _lines(path.join(dir, 'vorhalle', 'besuche.jsonl')).filter((b) => (now - (b.ts || 0)) < 48 * 3600 * 1000);
    const un = book.filter((b) => ['absent', 'rate', 'shielded'].includes(b.outcome));
    if (un.length) {
      const names = [...new Set(un.map((b) => b.who || '?'))].slice(0, 4).join(', ');
      threads.push({ key: 'vestibule:unanswered', prio: 1, satz: 'Besuche in der Vorhalle: ' + un.length + ' unbeantwortet (' + names + ')' });
    }
    if (book.some((b) => b.outcome === 'override')) {
      threads.push({ key: 'vestibule:override', prio: 1, satz: 'Daniel hat w\u00e4hrend deines Traums an die Vorhalle geklopft.' });
    }
  } catch (_e) { /* the book must never break awakening */ }
  // 2) work findings (F2 lays them here — the silence that breaks)
  for (const n of _lines(path.join(dir, NOTES))) {
    if (n.type === 'werk-befund') threads.push({ key: 'werk:' + (n.quelleId || n.ts), prio: 3, satz: 'Werk-Befund: ' + n.text });
    else if (n.type === 'erwartung') threads.push({ key: 'erwartung:' + (n.quelleId || n.ts), prio: 2, satz: n.text });
  }
  // 3) open expectation from the persisted chat history (F3, crash-safe)
  try {
    const hist = JSON.parse(fs.readFileSync(path.join(dir, 'chat-history.json'), 'utf8'));
    const arr = Array.isArray(hist) ? hist : (hist.messages || []);
    const last = [...arr].reverse().find((m) => m && m.role === 'assistant' && String(m.content || '').trim());
    const lu = [...arr].reverse().find((m) => m && m.role === 'user');
    const lastIsFinal = last && arr.indexOf(last) > arr.indexOf(lu || {});
    const q = last && String(last.content).trim();
    if (lastIsFinal && q && /\?\s*$/.test(q)) {
      const topic = q.split(/(?<=[.!?])\s+/).pop().slice(0, 70);
      threads.push({ key: 'frage:last', prio: 2, satz: 'Das Thema \u201e' + topic + '\u201c ist noch offen \u2014 falls du darauf zur\u00fcckkommen willst, ich bin bereit.' });
    }
  } catch (_e) { /* no history, no expectation */ }
  // 4) open goals from the anchor (optimisation source, never the only one)
  try {
    const a = JSON.parse(fs.readFileSync(path.join(dir, 'continuity-anchor.json'), 'utf8'));
    for (const t of (a.snapshot && a.snapshot.openGoals && a.snapshot.openGoals.top) || []) {
      threads.push({ key: 'ziel:' + t, prio: 1, satz: 'Offenes Ziel: ' + t });
    }
  } catch (_e) { /* anchor is optional by contract */ }
  return threads;
}

/** The awakening block: ranking, ageing, at most five, one sentence each. */
function buildBlock(dir, now) {
  if (!dir) return null;
  now = now || Date.now();
  const disp = _loadDisplay(dir);
  const threads = collectThreads(dir, now);
  if (threads.length === 0) return null; // byte-identical silence
  for (const t of threads) {
    const d = disp[t.key] || { shownCount: 0, lastShownTs: 0 };
    t.aged = d.shownCount >= AGE_OUT || (t.key === 'frage:last' && d.shownCount >= 1); // F3: one gentle follow-up, then laid still
    t.shown = d.shownCount;
  }
  threads.sort((a, b) => (a.aged - b.aged) || (b.prio - a.prio) || (a.shown - b.shown));
  const top = threads.filter((t) => !t.aged).slice(0, MAX_SHOW);
  if (top.length === 0) return null; // everything laid still — silence, sources stay
  for (const t of top) {
    const d = disp[t.key] || { shownCount: 0, lastShownTs: 0 };
    d.shownCount += 1; d.lastShownTs = now; disp[t.key] = d;
  }
  _saveDisplay(dir, disp);
  return '[Offene F\u00e4den]\n' + top.map((t) => '\u2022 ' + t.satz).join('\n');
}

module.exports = { buildBlock, collectThreads, addNote, resolveNote, NOTES, DISPLAY, MAX_SHOW };
