// ============================================================
// GENESIS — src/agent/cognitive/CorrectionHeuristic.js
// v7.9.45 K: detect the partner's CORRECTION in his own turn — narrow,
// four locales, negative-filtered, at most ONE candidate per chat. The
// field proof: "du sollst nur antworten es war eine frage?" — Genesis
// apologised gracefully, but nothing of it remained. Now it becomes a
// candidate; only a real accept-lesson run makes it a lesson.
// ============================================================
'use strict';
const cand = require('./CorrectionCandidates.js');

const POSITIVE = [
  /^\s*nein\b[\s,!.\u2014-]/i,
  /\bdu\s+soll(?:te)?st\s+(?:nur|doch|erst|nicht)\b/i,
  /\bdas\s+war\s+(?:falsch|nicht\s+(?:gut|richtig|so\s+toll|gemeint))\b/i,
  /\bso\s+(?:war\s+das\s+)?nicht\s+gemeint\b/i,
  /\bmach\s+das\s+(?:bitte\s+)?nicht\b/i,
  /^\s*no\b[\s,!.]/i,
  /\byou\s+should\s+(?:only|just|not)\b/i,
  /\bthat(?:'s|\s+was)\s+(?:wrong|not\s+what\s+i\s+(?:meant|asked))\b/i,
  /\bdon'?t\s+do\s+that\b/i,
  /^\s*non\b[\s,!.]/i,
  /\btu\s+(?:ne\s+)?devrais\s+(?:seulement|juste|pas)\b/i,
  /\bc'?est\s+faux\b/i,
  /\bdeber\u00edas\s+(?:solo|s\u00f3lo|no)\b/i,
  /\beso\s+est\u00e1\s+mal\b/i,
];
const NEGATIVE = [
  /```/,
  /^\s*nein[,!.\s]+danke\b/i,
  /\b(von mir|mein fehler|meinerseits|my fault)\b/i,
  /\bnicht\s+schlecht\b|\bnot\s+bad\b|\bpas\s+mal\b|\bnada\s+mal\b/i,
  /\bwarum\s+nicht\b|\bwhy\s+not\b|\bpourquoi\s+pas\b|\bpor\s+qu\u00e9\s+no\b/i,
  /\brichtig\s+oder\s+falsch\b|\btrue\s+or\s+false\b/i,
];

function matchCorrection(text) {
  const t = String(text || '');
  if (!t || t.length > 400) return null;
  if (NEGATIVE.some((r) => r.test(t))) return null;
  for (const r of POSITIVE) { const m = t.match(r); if (m) return m[0]; }
  return null;
}

/** Observe the PARTNER's turn. The accept-lesson tool removes cards itself. */
function observeUser(orch, text) {
  try {
    const dir = orch && orch.model && orch.model._genesisDir;
    if (!dir) return;
    if (orch._correctionCandThisChat) return; // sparsity: one per session
    const sig = matchCorrection(text);
    if (!sig) return;
    if (cand.add(dir, { sourceText: String(text).trim().slice(0, 300) })) orch._correctionCandThisChat = true;
  } catch (_e) { /* best effort */ }
}

module.exports = { matchCorrection, observeUser };
