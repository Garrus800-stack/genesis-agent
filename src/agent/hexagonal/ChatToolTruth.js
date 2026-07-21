// ============================================================
// GENESIS — src/agent/hexagonal/ChatToolTruth.js
// v7.9.43 W1: the truth guard for tool lines. Field 19.07.: the model
// wrote "\u26ed tool: journal-write() \u2192 ok" INSIDE its answer text —
// perfect trace optics, no execution, nothing written. Real traces are
// pushed separately (Helpers :229) and are NEVER touched here.
// Pure function: no state, no soul, no bus — future splits move only
// the one call line, never this module.
// ============================================================
'use strict';

// Matches a model-written trace line: \u26ed tool: name(anything) \u2192 status
const MODEL_TRACE_LINE = /^\s*\u26ed\s*tool:\s*([A-Za-z0-9._-]+)\s*\([^)\n]*\)\s*(?:\u2192|->)\s*\S.*$/gmu;

/**
 * Remove every model-written \u26ed trace line from an answer text.
 * For each removed name that did NOT really run this turn, append one
 * visible marker line. Names that did run are removed silently — the
 * real :229 trace is the only trace, never a duplicate.
 * @param {string} text - model answer text (post tool rounds)
 * @param {Set<string>|Array<string>|null} executedNames - tools that REALLY ran
 * @returns {string} sanitized text (unchanged reference semantics: plain string)
 */
function sanitizeModelToolLines(text, executedNames) {
  if (!text || text.indexOf('\u26ed') === -1) return text;
  const ran = executedNames instanceof Set ? executedNames : new Set(executedNames || []);
  const flagged = [];
  const out = String(text).replace(MODEL_TRACE_LINE, (_line, name) => {
    if (!ran.has(name) && !flagged.includes(name)) flagged.push(name);
    return '';
  }).replace(/\n{3,}/g, '\n\n').trimEnd();
  if (flagged.length === 0) return out;
  const marks = flagged.map((n) => `[\u26a0 vom Modell geschrieben \u2014 nicht ausgef\u00fchrt: ${n}]`).join('\n');
  return (out ? out + '\n\n' : '') + marks;
}

module.exports = { sanitizeModelToolLines, MODEL_TRACE_LINE };
