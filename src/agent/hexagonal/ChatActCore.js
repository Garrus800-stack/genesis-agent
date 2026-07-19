// @ts-checked-v5.7
// ============================================================
// GENESIS — hexagonal/ChatActCore.js (v7.9.41 r3)
// The act core: "said = done". When the user demands an action or the
// model announces one, the SYSTEM plans the tool step deterministically —
// model-agnostic, no begging, no nudge round-trips. Field 19.07.: five
// turns of "Ich lese das Changelog" with zero tool calls; "schaue dir den
// CHANGELOG an" answered with "Welche Datei soll ich lesen?".
// Scope: READ-ONLY acts (file-read, file-list). Anything mutating stays
// with the model + approval chain. One act source per turn, capped.
// ============================================================

'use strict';

const KNOWN_DOCS = {
  changelog: 'CHANGELOG.md',
  readme: 'README.md',
  architecture: 'docs/ARCHITECTURE.md',
  license: 'LICENSE',
};

const VERB = /\b(?:lies|les(?:e|en)|schau(?:e|en)?(?:\s+dir)?|[öo]ffn(?:e|en)|fass(?:e|en)|zeig(?:e|en)?|pr[üu]f(?:e|en)|inspizier(?:e|en)?|untersuch(?:e|en)?|erfass(?:e|en)?|read|open|summari[sz]e|inspect|show|check|list(?:e|en)?)\b/i;
const ASKS = /\bwas\s+steht\s+(?:in|im|drin)\b/i;
const LISTY = /\b(?:struktur|verzeichnis(?:se)?|ordner|dateien\s+auflisten|habitat[- ]struktur|directory|folder|structure)\b/i;

/**
 * Deterministically plan a read-only tool step from a sentence — the
 * user's demand or the model's own announcement.
 * @param {string} text
 * @returns {{ name: string, input: object, note: string }|null}
 */
function planActFromText(text) {
  const t = String(text || '');
  if (!t || t.length > 2000) return null;
  const wantsAct = VERB.test(t) || ASKS.test(t);
  if (!wantsAct) return null;
  // 1) explicit path-looking token (docs/x.md, src/a/b.js, FILE.ext)
  const pathMatch = t.match(/\b((?:[A-Za-z0-9_.-]+\/)+[A-Za-z0-9_.-]+\.[A-Za-z0-9]{1,5}|[A-Za-z0-9_-]{2,}\.(?:md|js|json|txt|log|yml|yaml))\b/);
  if (pathMatch) {
    return { name: 'file-read', input: { path: pathMatch[1] }, note: 'act: file-read(' + pathMatch[1] + ')' };
  }
  // 2) known project documents by name
  const low = t.toLowerCase();
  for (const key of Object.keys(KNOWN_DOCS)) {
    if (low.includes(key)) {
      return { name: 'file-read', input: { path: KNOWN_DOCS[key] }, note: 'act: file-read(' + KNOWN_DOCS[key] + ')' };
    }
  }
  // 3) structure / directory intent
  if (LISTY.test(t)) {
    return { name: 'file-list', input: { path: '.' }, note: 'act: file-list(.)' };
  }
  return null;
}

module.exports = { planActFromText, KNOWN_DOCS };
