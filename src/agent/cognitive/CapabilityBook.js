// ============================================================
// GENESIS — src/agent/cognitive/CapabilityBook.js
// v7.9.44 G: the first-visit constitution, his life cycle verbatim:
// entdeckt -> angetastet -> beschrieben -> integriert. "Integriert"
// is set ONLY BY HIM, after a real use (P9). Probing stays behind a
// conservative safe-name whitelist (P10). His own short guide lives
// as a pending SKILL (koennen/skills-pending — the house promotion
// path); the change sentence goes to the journal through the real
// writer. The book is the fourth capability layer: the ACQUIRED.
// ============================================================
'use strict';
const fs = require('fs');
const path = require('path');

const FILE = 'capabilities.jsonl';
const STATES = ['entdeckt', 'angetastet', 'beschrieben', 'integriert'];
const PROBE_SAFE = /^(list|get|search|status|read|show|describe)/i;

function _all(dir) {
  try { return fs.readFileSync(path.join(dir, FILE), 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch (_e) { return null; } }).filter(Boolean); }
  catch (_e) { return []; }
}
function _save(dir, list) {
  try { fs.writeFileSync(path.join(dir, FILE), list.map((c) => JSON.stringify(c)).join('\n') + (list.length ? '\n' : '')); } catch (_e) { /* best effort */ }
}
function _find(dir, name) { return _all(dir).find((c) => c.name === name) || null; }

function discover(dir, { name, quelle }) {
  if (!dir || !name) return { ok: false, error: 'name fehlt' };
  const list = _all(dir);
  if (list.some((c) => c.name === name)) return { ok: true, existed: true };
  list.push({ name: String(name).slice(0, 60), quelle: String(quelle || 'lokal').slice(0, 30), zustand: 'entdeckt', ts: Date.now(), history: [{ zustand: 'entdeckt', ts: Date.now() }] });
  _save(dir, list); return { ok: true, existed: false };
}

function probeAllowed(opName) { return PROBE_SAFE.test(String(opName || '')); }

function advance(dir, name, zustand, extra) {
  const list = _all(dir); const c = list.find((x) => x.name === name);
  if (!c) return { ok: false, error: 'unbekannte F\u00e4higkeit: ' + name };
  const from = STATES.indexOf(c.zustand); const to = STATES.indexOf(zustand);
  if (to === -1) return { ok: false, error: 'unbekannter Zustand' };
  if (to !== from + 1) return { ok: false, error: 'Reihenfolge: ' + c.zustand + ' \u2192 ' + STATES[from + 1] };
  c.zustand = zustand; c.history.push({ zustand, ts: Date.now() });
  if (extra) Object.assign(c, extra);
  _save(dir, list); return { ok: true, zustand };
}

/** His own short guide -> pending skill on the house promotion path. */
function writeGuide(dir, name, guideText) {
  try {
    const pend = path.join(dir, 'koennen', 'skills-pending');
    fs.mkdirSync(pend, { recursive: true });
    const f = path.join(pend, 'faehigkeit-' + String(name).replace(/[^\w-]/g, '_') + '.md');
    fs.writeFileSync(f, '# ' + name + ' \u2014 meine Kurzanleitung\n\n' + String(guideText).slice(0, 2000) + '\n');
    return f;
  } catch (_e) { return null; }
}

module.exports = { discover, advance, probeAllowed, writeGuide, _find, FILE, STATES, PROBE_SAFE };
