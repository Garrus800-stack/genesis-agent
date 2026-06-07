// @ts-checked
// ============================================================
// GENESIS — activities/plan-refine.js (v7.9.20)
// One bound "second look" at a freshly proposed idle goal: a single LLM
// pass that may sharpen the title BEFORE the draft becomes an irrevocable
// goal. The refinement is adopted ONLY when it is a genuine, valid,
// different improvement — same read-only leading verb as the draft and no
// invented file paths, the same rules the planner itself enforces. Any
// failure leaves the original draft untouched; refinement never blocks
// goal creation.
// ============================================================

'use strict';

const { createLogger } = require('../../core/Logger');
const { extractLeadingVerb } = require('../../core/goal-intent');
const _log = createLogger('IdleMind');

/**
 * Sharpen a draft goal title with one bound LLM pass.
 * @param {object}   args
 * @param {string}   args.title                 - the draft goal title
 * @param {string}   [args.description]          - full proposal text (context only)
 * @param {object}   args.model                  - chat model: { chat(prompt, history, mode) }
 * @param {Set<string>} [args.allowedVerbs]      - read-only verb whitelist (planner's set)
 * @param {(text:string)=>(string|false)} [args.hasHallucinatedPaths] - invented-path guard
 * @returns {Promise<string>} the refined title, or the original when there is
 *          no genuine, valid, different improvement (or on any error)
 */
async function refineGoalDraft({ title, description, model, allowedVerbs, hasHallucinatedPaths } = {}) {
  if (!title || !model || typeof model.chat !== 'function') return title;

  const prompt = `You proposed this activity:
TITLE: ${title}

Sharpen ONLY the title so it names the concrete deliverable more precisely.
Keep the SAME leading verb. Do not broaden the scope. Do not invent file paths.
If the title is already as sharp as it can be, repeat it unchanged.

Respond with exactly one line:
TITLE: [sharpened title]`;

  let out;
  try {
    out = await model.chat(prompt, [], 'analysis');
  } catch (e) {
    _log.debug('[catch] plan-refine chat:', e.message);
    return title;
  }

  const m = (out || '').match(/TITLE:\s*(.+)/i);
  if (!m) return title;
  const refined = m[1].trim();

  // Adopt only a genuine, different improvement of sane length.
  if (!refined || refined === title) return title;
  if (refined.length < 6 || refined.length > 160) return title;

  // Same read-only verb rule as the planner: the refined leading verb must be
  // allowed, and must match the draft's verb so the refinement cannot silently
  // change the goal's intent.
  const draftVerb = extractLeadingVerb(title);
  const refinedVerb = extractLeadingVerb(refined);
  if (!refinedVerb) return title;
  if (allowedVerbs && !allowedVerbs.has(refinedVerb)) return title;
  if (draftVerb && refinedVerb !== draftVerb) return title;

  // No invented file paths in the sharpened title.
  if (typeof hasHallucinatedPaths === 'function' && hasHallucinatedPaths(refined)) return title;

  return refined;
}

module.exports = { refineGoalDraft };
