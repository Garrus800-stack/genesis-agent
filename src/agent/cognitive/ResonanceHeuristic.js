// ============================================================
// GENESIS — src/agent/cognitive/ResonanceHeuristic.js
// v7.9.43 W3: signals in Genesis' OWN words (assistant turns only).
// Positive: "Das behalte ich im Hinterkopf" / "Dar\u00fcber will ich
// nachdenken" / "Das ist eine gute Frage" (left open) / "faszinierend|
// beunruhigend|merkw\u00fcrdig" / an own unanswered "wei\u00df ich nicht".
// Negative (never a signal): clarification questions, technical asks,
// politeness, conversation glue. Sparsity is a hard rule: at most ONE
// heuristic candidate per chat session. Confirmation = a REAL
// resonance-note run removes the last shown card; an explicit
// "loslassen" in the answer after an offer rejects it.
// ============================================================
'use strict';
const cand = require('./ResonanceCandidates.js');

const POSITIVE = [
  /das behalte ich im hinterkopf/i,
  /dar\u00fcber will ich nachdenken/i,
  /das ist eine gute frage/i,
  /\b(faszinierend|beunruhigend|merkw\u00fcrdig)\b/i,
  /wei\u00df ich nicht\b/i,
];
const NEGATIVE = [
  /meinst du .+ oder/i,
  /soll ich (das|es) als/i,
  /^\s*(danke|gern geschehen)/i,
];
const REJECT = /\b(loslassen|lehne .{0,12}ab|nicht mitnehmen)\b/i;

function matchSignal(text) {
  const t = String(text || '');
  if (!t || NEGATIVE.some((r) => r.test(t))) return null;
  for (const r of POSITIVE) { const m = t.match(r); if (m) return m[0]; }
  return null;
}

/** Observe a finished assistant turn on the orchestrator. Line-folded call site. */
function observeAssistant(orch, text) {
  try {
    const dir = orch && orch.model && orch.model._genesisDir;
    if (!dir) return;
    // confirmation: the tool REALLY ran this turn (W1 truth set)
    if (orch._execNames && orch._execNames.has && orch._execNames.has('resonance-note')) {
      const ls = cand.lastShown(dir); if (ls) cand.remove(dir, ls.id);
      return;
    }
    if (REJECT.test(String(text || ''))) {
      const ls = cand.lastShown(dir); if (ls) { cand.remove(dir, ls.id); return; }
    }
    if (orch._resonanceCandThisChat) return; // sparsity: one per session
    const sig = matchSignal(text);
    if (!sig) return;
    const sentence = (String(text).split(/(?<=[.!?])\s+/).find((s) => s.toLowerCase().includes(sig.toLowerCase())) || sig).trim();
    if (cand.add(dir, { sourceText: sentence.slice(0, 300), src: 'heuristic' })) orch._resonanceCandThisChat = true;
  } catch (_e) { /* best effort */ }
}

module.exports = { matchSignal, observeAssistant, REJECT };
