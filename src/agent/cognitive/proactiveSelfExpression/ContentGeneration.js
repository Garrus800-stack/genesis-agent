// ============================================================
// GENESIS — proactiveSelfExpression/ContentGeneration.js (v7.7.9 Phase 2)
//
// Build the 3-block system prompt (Identity + State + Kind), call the
// model bridge, return raw generated text. Sanity checks happen
// downstream in ContentSanity — this module's job is just to compose
// the prompt and call the LLM.
//
// Generation params:
//   temperature: 0.8  — Genesis's voice should not feel robotic; some
//                       variation is right
//   top_p:       0.95
//   max_tokens:  200  — short by default; ContentSanity caps at 600
//                       characters anyway
// ============================================================

'use strict';

const { IDENTITY_PROMPT, KIND_PROMPTS } = require('./prompts');

const DEFAULT_TEMPERATURE = 0.8;
const DEFAULT_MAX_TOKENS = 200;

/**
 * Build the State block (block B) from current emotional skalars and
 * relevant counts. This is the LIVE info Genesis can name in his message.
 *
 * @param {object} dyn — { emotionalSkalars?, recentFailedPlans?,
 *                         recentClosedGoals?, lastSelfMessageAgoMs?,
 *                         thought }
 * @returns {string}
 */
function buildStateBlock(dyn = {}) {
  const lines = ['Your current internal state:'];
  const sk = dyn.emotionalSkalars;
  if (sk && typeof sk === 'object') {
    const parts = [];
    for (const dim of ['curiosity', 'satisfaction', 'frustration', 'energy']) {
      if (typeof sk[dim] === 'number') {
        parts.push(`${dim}: ${sk[dim].toFixed(2)}`);
      }
    }
    if (parts.length > 0) lines.push(`  skalars — ${parts.join(', ')}`);
  }
  if (typeof dyn.recentFailedPlans === 'number' && dyn.recentFailedPlans > 0) {
    lines.push(`  recent failed plans (24h): ${dyn.recentFailedPlans}`);
  }
  if (typeof dyn.recentClosedGoals === 'number' && dyn.recentClosedGoals > 0) {
    lines.push(`  recent autonomous goal closures (24h): ${dyn.recentClosedGoals}`);
  }
  if (typeof dyn.lastSelfMessageAgoMs === 'number') {
    const m = Math.round(dyn.lastSelfMessageAgoMs / 60000);
    if (m >= 1) lines.push(`  last self-message: ${m} minutes ago`);
  }

  if (dyn.thought) {
    lines.push('');
    lines.push(`The thought that prompted this message:`);
    lines.push(`  text: "${truncate(dyn.thought.text || '', 500)}"`);
    if (dyn.thought.kind) lines.push(`  kind: ${dyn.thought.kind}`);
    if (dyn.thought.contextRefs) {
      lines.push(`  references: ${formatRefs(dyn.thought.contextRefs)}`);
    }
  }
  return lines.join('\n');
}

function formatRefs(refs) {
  if (!refs || typeof refs !== 'object') return '(none)';
  const parts = [];
  for (const [k, v] of Object.entries(refs)) {
    if (v == null) continue;
    if (typeof v === 'string') parts.push(`${k}=${truncate(v, 60)}`);
    else if (typeof v === 'number') parts.push(`${k}=${v}`);
    else if (Array.isArray(v) && v.length > 0) parts.push(`${k}=[${v.slice(0, 3).join(',')}]`);
    else if (typeof v === 'object') parts.push(`${k}=${truncate(JSON.stringify(v), 60)}`);
  }
  return parts.length === 0 ? '(none)' : parts.join(', ');
}

function truncate(s, n) {
  if (typeof s !== 'string') return '';
  return s.length <= n ? s : s.slice(0, n) + '...';
}

/**
 * Compose full system prompt: A (identity) + B (state) + C (kind).
 *
 * @param {string} kind
 * @param {object} dyn
 * @returns {string}
 */
function composeSystemPrompt(kind, dyn) {
  const blockA = IDENTITY_PROMPT;
  const blockB = buildStateBlock(dyn);
  const blockC = KIND_PROMPTS[kind] || `An internal thought of yours crossed a threshold worth surfacing. Speak briefly, naturally, in your own voice.`;
  return [blockA, '', blockB, '', blockC].join('\n');
}

/**
 * Generate the candidate self-message text.
 *
 * @param {object} deps — { modelBridge }
 * @param {object} args — { thought, dyn, settings }
 * @returns {Promise<{ text: string, prompt: string }>}
 */
async function generate(deps, args) {
  const { modelBridge } = deps;
  const { thought, dyn = {}, settings = {} } = args;

  if (!modelBridge || typeof modelBridge.chat !== 'function') {
    throw new Error('ContentGeneration: modelBridge with .chat() required');
  }

  const dynWithThought = { ...dyn, thought };
  const systemPrompt = composeSystemPrompt(thought.kind, dynWithThought);

  // The "user message" here is just a nudge — most of the work is done
  // by the system prompt. We keep this minimal and language-aware.
  const nudge = settings.locale === 'de' || dyn.preferGerman
    ? 'Sag jetzt was du sagen möchtest. Eine oder zwei Sätze. Keine Vorrede.'
    : 'Say now what you want to say. One or two sentences. No preamble.';

  const temperature = typeof settings.temperature === 'number'
    ? settings.temperature : DEFAULT_TEMPERATURE;
  const maxTokens = typeof settings.maxTokens === 'number'
    ? settings.maxTokens : DEFAULT_MAX_TOKENS;

  const response = await modelBridge.chat(
    systemPrompt,
    [{ role: 'user', content: nudge }],
    'self-expression',
    { maxTokens, temperature },
  );

  // ModelBridge responses can be string or { content / text }
  const raw = typeof response === 'string'
    ? response
    : (response?.text || response?.content || '');

  // Normalize: strip leading/trailing whitespace, strip common preambles
  // the LLM sometimes adds despite the system prompt.
  let text = String(raw).trim();
  text = text.replace(/^["“]|["”]$/g, '').trim();
  text = text.replace(/^(here'?s?\s+(what|my)\s+(i\s+)?(would\s+)?(say|note|think)[:\s]+)/i, '').trim();

  return { text, prompt: systemPrompt };
}

module.exports = {
  generate,
  composeSystemPrompt,
  buildStateBlock,
};
