'use strict';
/**
 * LastDocStore — remembers the last file/folder the user opened, read or named
 * so anaphoric follow-ups ("fasse es zusammen", "wieviele dateien sind drin")
 * resolve without re-asking (v7.9.28, F4). Singleton, 10-minute TTL.
 *
 * Stores the resolved absolute path plus a kind ('file' | 'folder'). Older than
 * the TTL → treated as absent (a stale reference must not silently act).
 */
const TTL_MS = 10 * 60 * 1000;

let _last = null; // { path, kind, at }
let _lastText = null; // { text, kind, at } — last significant generated text (a summary, etc.)

function setLastDoc(absPath, kind = 'file') {
  if (!absPath || typeof absPath !== 'string') return;
  _last = { path: absPath, kind, at: Date.now() };
}

function getLastDoc() {
  if (!_last) return null;
  if (Date.now() - _last.at > TTL_MS) { _last = null; return null; }
  return { path: _last.path, kind: _last.kind };
}

function clearLastDoc() { _last = null; _lastText = null; }

// v7.9.28 (field-fix #3): remember the last generated text (e.g. a file summary)
// so "speichere die Zusammenfassung in Datei X" / "schreibe die zusammenfassung
// rein" can persist it without the user re-pasting it. Same TTL as the path.
function setLastText(text, kind = 'summary') {
  if (!text || typeof text !== 'string') return;
  _lastText = { text, kind, at: Date.now() };
}

function getLastText() {
  if (!_lastText) return null;
  if (Date.now() - _lastText.at > TTL_MS) { _lastText = null; return null; }
  return { text: _lastText.text, kind: _lastText.kind };
}

// v7.9.28: remember a content-like reply (a drawing, diagram, or answer) so
// "speichere es" can persist it. Operational one-liners ("Ordner geöffnet: …")
// are filtered out by the multi-line / length test; called from the orchestrator.
function rememberOutput(text) {
  try { if (text && (/\n/.test(text) || String(text).length > 200)) setLastText(text, 'output'); } catch { /* ignore */ }
}

module.exports = { setLastDoc, getLastDoc, clearLastDoc, setLastText, getLastText, rememberOutput, _TTL_MS: TTL_MS };
