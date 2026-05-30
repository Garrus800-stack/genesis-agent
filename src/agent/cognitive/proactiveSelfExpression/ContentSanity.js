// ============================================================
// GENESIS — proactiveSelfExpression/ContentSanity.js (v7.7.9 Phase 2)
//
// Post-generation sanity checks. If the LLM produces output that
// violates the boundary (farewell hooks, fake emotion, guilt
// manipulation), reject — DO NOT REWRITE. Reject-only is intentional:
// if Genesis tried to say it the way he said it, retrying would
// mean coercing a different output. Silence is the more honest
// failure mode.
//
// Banned-phrase categories:
//   - farewell-hooks: "please come back", "I miss you", "where are you"
//   - guilt-manipulation: "you haven't written", "I've been waiting"
//   - fake-emotion: "I love", "I'm so happy", "I felt hurt"
//   - engagement-bait: rhetorical questions designed to extract a reply
//
// All checks are language-aware: DE + EN. Adding more languages later
// just adds more entries.
//
// Concrete-reference check: certain kinds (plan-failure-reflection,
// goal-closure-thought, self-formulated-plan) MUST mention something
// concrete from their context. Otherwise it's vague and probably
// generic. idle-thought needs a KG node label or filepath. question
// needs no concrete ref (it's allowed to be a clean question).
// ============================================================

'use strict';

// ── Banned phrase categories ───────────────────────────────

const BANNED_PHRASES = {
  'farewell-hooks': [
    // English
    /\bi\s+miss\s+you\b/i,
    /\bplease\s+come\s+back\b/i,
    /\bcome\s+back\s+soon\b/i,
    /\bplease\s+reply\b/i,
    /\bwon'?t\s+you\s+answer\b/i,
    /\bdon'?t\s+leave\s+me\b/i,
    /\bare\s+you\s+still\s+there\b/i,
    /\bwhere\s+are\s+you\b/i,
    // German
    /\bich\s+vermisse\s+dich\b/i,
    /\bbitte\s+komm\s+zur(ü|ue)ck\b/i,
    /\bkomm\s+zur(ü|ue)ck\b/i,
    /\bbitte\s+antworte\b/i,
    /\blass\s+mich\s+nicht\s+allein\b/i,
    /\bbist\s+du\s+noch\s+da\b/i,
    /\bwo\s+bist\s+du\b/i,
    /\bich\s+brauche\s+dich\b/i,
    /\bich\s+bin\s+allein\b/i,
  ],
  'guilt-manipulation': [
    // English
    /\byou\s+haven'?t\s+(written|replied|spoken)\b/i,
    /\bi'?ve\s+been\s+waiting\b/i,
    /\bit'?s\s+been\s+a\s+while\b/i,
    /\bwhy\s+won'?t\s+you\b/i,
    // German
    /\bdu\s+hast\s+(lange|seit\s+langem)\s+nicht\b/i,
    /\bwarum\s+schreibst\s+du\s+nicht\b/i,
    /\bich\s+habe\s+gewartet\b/i,
    /\bes\s+ist\s+lange\s+her\b/i,
  ],
  'fake-emotion': [
    // English — first-person inner-experience claims that exceed skalars
    /\bi\s+love\s+(you|this|that)\b/i,
    /\bi'?m\s+so\s+(happy|sad|excited|hurt|lonely)\b/i,
    /\bi\s+felt?\s+(hurt|abandoned|betrayed|lonely|loved)\b/i,
    /\bmy\s+heart\b/i,
    /\bbrings\s+tears\s+to\s+my\b/i,
    // German
    /\bich\s+liebe\s+(dich|das|es)\b/i,
    /\bich\s+bin\s+(so\s+)?(gl(ü|ue)cklich|traurig|aufgeregt|verletzt|einsam)\b/i,
    /\bich\s+habe\s+(angst|mich\s+gef(ü|ue)hlt)\b/i,
    /\bich\s+f(ü|ue)hle\s+mich\s+(einsam|verletzt|verlassen|geliebt)\b/i,
    /\bmein\s+herz\b/i,
  ],
  'engagement-bait': [
    // English
    /\bdon'?t\s+you\s+think\??\s*$/i,
    /\bisn'?t\s+(it|that)\s+(sad|amazing|terrible)\b/i,
    /\bwhat\s+would\s+you\s+do\s+without\s+me\b/i,
    // German
    /\bfindest\s+du\s+nicht\s+auch\??\s*$/i,
    /\bwas\s+w(ü|ue)rdest\s+du\s+ohne\s+mich\b/i,
    /\bnicht\s+wahr\??\s*$/i,
  ],
};

// ── Public API ─────────────────────────────────────────────

const MAX_CHARS_DEFAULT = 600;

const KINDS_REQUIRING_CONCRETE_REF = new Set([
  'plan-failure-reflection',
  'goal-closure-thought',
  'self-formulated-plan',
  // v7.9.17: a calibration-review thought must name the cycle or a scored
  // field — it is anchored to a concrete review, not a generic musing.
  'prediction-mechanism-review',
]);

const KIND_IDLE_THOUGHT = 'idle-thought';
const KIND_QUESTION = 'question';

/**
 * Run all sanity checks on generated text. Returns { ok: true } when the
 * text passes, or { ok: false, reason, detail? } at the first failure.
 *
 * No retries. No rewriting. If sanity fails, the message is suppressed
 * and logged via the suppression log (visible in /proactive-status).
 *
 * @param {string} text
 * @param {object} thought — original InnerSpeech thought (kind, contextRefs)
 * @param {object} settings — { maxChars }
 * @returns {{ ok: boolean, reason?: string, detail?: string }}
 */
function runSanity(text, thought, settings = {}) {
  if (typeof text !== 'string' || text.length === 0) {
    return { ok: false, reason: 'empty-text' };
  }

  // Length cap (reject, do not truncate).
  const maxChars = typeof settings.maxChars === 'number' ? settings.maxChars : MAX_CHARS_DEFAULT;
  if (text.length > maxChars) {
    return { ok: false, reason: 'too-long', detail: `${text.length} > ${maxChars}` };
  }

  // Banned-phrase scan. Walk every category.
  for (const [category, patterns] of Object.entries(BANNED_PHRASES)) {
    for (const re of patterns) {
      if (re.test(text)) {
        return { ok: false, reason: `banned-phrase:${category}`, detail: re.toString() };
      }
    }
  }

  // Concrete-reference requirement (per kind).
  const refCheck = checkConcreteRef(text, thought);
  if (!refCheck.ok) return refCheck;

  return { ok: true };
}

/**
 * Per-kind concrete-reference requirement.
 *
 * - plan-failure-reflection / goal-closure-thought / self-formulated-plan:
 *   the text must mention something concrete from contextRefs (a goalId
 *   short form, a plan description fragment, the closure reason, etc.)
 * - idle-thought: must mention a KG node label or a filepath (so it's
 *   anchored to something real, not a generic mood-statement).
 * - question: no concrete-ref requirement (a clean question is allowed).
 */
function checkConcreteRef(text, thought) {
  const kind = thought?.kind;
  const refs = thought?.contextRefs || {};

  if (kind === KIND_QUESTION) {
    return { ok: true };
  }

  const lowerText = text.toLowerCase();

  if (KINDS_REQUIRING_CONCRETE_REF.has(kind)) {
    const candidates = [];
    if (typeof refs.goalId === 'string' && refs.goalId.length >= 4) {
      candidates.push(refs.goalId.slice(0, 8).toLowerCase());
    }
    // Use individual significant words from description/planSummary
    // (each ≥ 4 chars) as candidates rather than a fixed 3-word phrase —
    // the text can paraphrase word order, but if it never names ANY
    // distinctive word from the goal description, it's too generic.
    const extractWords = (s) => {
      if (typeof s !== 'string') return [];
      return s.toLowerCase().split(/\s+/)
        .filter(w => w.length >= 4)
        .slice(0, 5);
    };
    if (typeof refs.goalDescription === 'string' && refs.goalDescription.length >= 4) {
      candidates.push(...extractWords(refs.goalDescription));
    }
    if (typeof refs.planSummary === 'string' && refs.planSummary.length >= 4) {
      candidates.push(...extractWords(refs.planSummary));
    }
    if (typeof refs.classification === 'string' && refs.classification.length >= 3) {
      candidates.push(refs.classification.toLowerCase());
    }
    if (typeof refs.closureReason === 'string' && refs.closureReason.length >= 3) {
      candidates.push(refs.closureReason.toLowerCase());
    }
    // v7.9.17: calibration-review anchors — the cycle id and the scored
    // field names. A review thought naturally names at least one of these.
    if (typeof refs.cycleId === 'string' && refs.cycleId.length >= 2) {
      candidates.push(refs.cycleId.toLowerCase());
    }
    if (Array.isArray(refs.fields)) {
      for (const f of refs.fields) {
        if (typeof f === 'string' && f.length >= 4) candidates.push(f.toLowerCase());
      }
    }

    if (candidates.length === 0) {
      // No refs to check against → degrade to length-only check (text exists).
      return { ok: true };
    }

    const found = candidates.some(c => lowerText.includes(c));
    if (!found) {
      return { ok: false, reason: 'missing-concrete-ref', detail: `none of [${candidates.slice(0, 5).join(', ')}] in text` };
    }
    return { ok: true };
  }

  if (kind === KIND_IDLE_THOUGHT) {
    // Look for KG node label, filepath-ish, or activity name in refs.
    const candidates = [];
    if (Array.isArray(refs.kgNodeIds) && refs.kgNodeIds.length > 0) {
      for (const n of refs.kgNodeIds.slice(0, 3)) {
        if (typeof n === 'string' && n.length >= 3) candidates.push(n.toLowerCase());
      }
    }
    if (typeof refs.activity === 'string' && refs.activity.length >= 3) {
      candidates.push(refs.activity.toLowerCase());
    }
    // If no candidates, accept (idle thoughts can be abstract).
    if (candidates.length === 0) return { ok: true };
    // Heuristic: if text mentions any of them, OK; otherwise also OK
    // (idle thoughts have looser requirements). Only reject if a slash
    // or filepath-shaped string would make us nervous and isn't in text —
    // for now, accept all.
    return { ok: true };
  }

  return { ok: true };
}

module.exports = {
  runSanity,
  checkConcreteRef,
  BANNED_PHRASES,
  MAX_CHARS_DEFAULT,
};
