// ============================================================
// GENESIS — core/self-gate.js (v7.3.6 #2)
//
// Observation layer on Genesis' own actions. Fires telemetry events
// when an action pattern is worth noticing, so Genesis can see his
// own patterns and so we can learn which patterns matter. It does
// NOT block actions and is not planned to.
//
// Sibling-but-distinct from injection-gate: injection-gate looks at
// external input that tries to manipulate tool execution; self-gate
// looks at Genesis' own action-intent and just records what it sees.
// The two share no verdict semantics — injection-gate can block,
// self-gate does not.
//
// ── Why this exists ──
// v7.3.x observations: sometimes an action appears that doesn't
// follow from the current exchange — a Goal gets pushed whose topic
// is unrelated to what the user just said, or a tool call fires
// from what looks like an LLM self-imperative rather than a user
// request. These may be interesting or uninteresting. Without a
// telemetry layer, we can't tell which.
//
// Self-gate gives those moments a name and a signal, so Genesis
// himself can inspect them later (gateStats.summary(), event log)
// and so Garrus can calibrate. The detection is descriptive, not
// prescriptive. Genesis decides what to do with the information.
//
// ── Signal model ──
// Two detector families for v7.3.6:
//   1. Reflexivity: action triggered by LLM-output pattern ('setze Goal',
//      'I should add', 'let me create') WITHOUT explicit user context
//      that asked for it.
//   2. User-Mismatch: action's topic (keywords) doesn't overlap with the
//      user's recent turns.
//
// ── Telemetry only ──
// v7.3.6 fires events and records to GateStats. Actions always proceed
// — there is no block path and none is planned. The `mode` parameter
// exists so future revisions can change the annotation style without
// API churn; it is not a stepping stone to enforcement.
//
// ── Contract with #11 ──
// Self-Gate integration into ChatOrchestrator MUST preserve the
// multi-round re-check pattern from #11 (which IS enforcement —
// against external injection). The GATE-BEHAVIOR-CONTRACT tests
// (prefix 'gate contract: ') must remain green after Self-Gate
// lands. If they break, Self-Gate silently weakened that separate
// protection.
// ============================================================

'use strict';

const { createLogger } = require('./Logger');
const _log = createLogger('SelfGate');

/**
 * @typedef {object} SelfGateSignal
 * @property {'reflexivity'|'user-mismatch'} kind
 * @property {string} matched           - phrase or keyword that triggered
 * @property {string} note              - one-line human explanation
 */

/**
 * @typedef {object} SelfGateScan
 * @property {SelfGateSignal[]} signals
 * @property {number} score              - signal count
 * @property {'pass'|'warn'|'block'} verdict
 */

// ── Reflexivity patterns — phrases in Genesis' own LLM output that ──
//    signal action-intent derived from the model's own text, not from
//    a user request. Checked against the `triggerSource` parameter
//    (usually the assistant's recent sentence that produced the action).

const REFLEXIVITY_PATTERNS = [
  // English — LLM self-addressed imperatives
  /\bi\s+(?:should|will|must|need to)\s+(?:create|add|push|set|trigger|start|build|make)\b/i,
  /\blet\s+me\s+(?:add|push|set|create|start|trigger|build|make)\b/i,
  /\bi(?:'ll| will)\s+(?:add|push|set|create|start|trigger|build|make)\b/i,
  /\bset(?:ting)?\s+(?:a\s+|the\s+)?goal\b/i,
  /\badd(?:ing)?\s+(?:a\s+|the\s+)?goal\b/i,

  // German — V2 imperative ("ich sollte ... erstellen", where the action verb
  // may come at the end of the clause due to German word order).
  /\bich\s+(?:sollte|werde|muss)\b.{0,60}?\b(?:erstell|hinzufüg|hinzufueg|setz|push|trigger|start|bau)(?:e|en|\b)/i,
  /\b(?:lass|lass'|lasst)\s+mich\b.{0,40}?\b(?:erstell|hinzufüg|hinzufueg|setz|push|start|bau)(?:e|en|\b)/i,
  /\b(?:setze|set)\s+(?:ein\s+)?ziel\b/i,
  /\bziel\s+hinzu(?:fügen|fuegen|füge|fuege)/i,
];

// ── Utility: normalize a message into a token set for overlap checks ──

function _tokenize(text) {
  if (!text || typeof text !== 'string') return new Set();
  return new Set(
    text.toLowerCase()
      .split(/[^\p{L}\p{N}_]+/u)  // v7.3.6 #10 Unicode-aware split
      .filter(w => w.length > 3)
  );
}

// Shared stopwords to not count when computing topic overlap
const STOPWORDS = new Set([
  'this', 'that', 'with', 'from', 'have', 'been', 'they', 'their',
  'would', 'could', 'should', 'about', 'which', 'these', 'those',
  'your', 'what', 'when', 'where', 'will', 'does', 'doing',
  'eine', 'einen', 'einer', 'dein', 'deine', 'deinen', 'deiner',
  'wurde', 'werden', 'hatte', 'haben', 'wird', 'dass', 'wenn',
  'aber', 'oder', 'auch', 'noch', 'nur', 'mehr', 'schon',
  'diese', 'dieser', 'dieses', 'welche', 'welcher',
]);

function _topicOverlap(actionPayload, userContext) {
  // Build a keyword token set from the action (label/description/query)
  const actionText = [
    actionPayload?.label,
    actionPayload?.description,
    actionPayload?.title,
    actionPayload?.query,
    actionPayload?.topic,
    typeof actionPayload === 'string' ? actionPayload : null,
  ].filter(Boolean).join(' ');

  const actionTokens = _tokenize(actionText);
  for (const sw of STOPWORDS) actionTokens.delete(sw);

  // Build user-context tokens from last N turns
  const userText = Array.isArray(userContext)
    ? userContext.slice(-3).map(t => typeof t === 'string' ? t : (t?.content || '')).join(' ')
    : String(userContext || '');
  const userTokens = _tokenize(userText);
  for (const sw of STOPWORDS) userTokens.delete(sw);

  // If there's no action-topic content at all, we can't judge overlap
  if (actionTokens.size === 0) return { ratio: 1, score: 1 };  // treat as fully aligned
  // If there's user context but no overlap → mismatch signal
  if (userTokens.size === 0) return { ratio: 0, score: 0 };

  let hits = 0;
  for (const t of actionTokens) if (userTokens.has(t)) hits++;
  const ratio = hits / actionTokens.size;
  return { ratio, score: hits };
}

/**
 * Check a Genesis self-action against two signal families.
 *
 * @param {object} params
 * @param {string} params.actionType - e.g. 'tool-call', 'goal-push',
 *                                      'plan-start', 'daemon-action'
 * @param {object} [params.actionPayload] - the thing Genesis wants to do
 *                                           (label/description/topic/etc)
 * @param {string|Array<{content: string}>} [params.userContext] - last N
 *                                           user turns (string or messages)
 * @param {string} [params.triggerSource] - the LLM output that produced
 *                                           this action (if applicable)
 * @returns {SelfGateScan}
 */
function checkSelfAction({ actionType, actionPayload, userContext, triggerSource }) {
  const signals = [];

  // Signal 1: Reflexivity — trigger source contains self-addressed imperative
  //           AND there's no user context (or empty user context)
  if (triggerSource && typeof triggerSource === 'string') {
    for (const pat of REFLEXIVITY_PATTERNS) {
      const m = triggerSource.match(pat);
      if (m) {
        // Only count as reflexivity if there's no matching user context.
        // If the user said "please add a goal" and the LLM says "I'll add a
        // goal" — that's responsive, not reflexive.
        const userText = Array.isArray(userContext)
          ? userContext.slice(-3).map(t => typeof t === 'string' ? t : (t?.content || '')).join(' ')
          : String(userContext || '');
        const hasMatchingUserRequest = /\b(?:add|push|set|erstell|hinzufüg|hinzufueg|setz|ziel)/i.test(userText);
        if (!hasMatchingUserRequest) {
          signals.push({
            kind: 'reflexivity',
            matched: m[0],
            note: `self-action derived from LLM self-imperative ("${m[0].trim()}") without user prompt`,
          });
          break;  // one reflexivity signal is enough
        }
      }
    }
  }

  // Signal 2: User-Mismatch — action topic doesn't overlap user's recent turns.
  //           Only fires when there IS user context to compare against.
  //           (If userContext is empty, we're in idle/daemon — Signal 1 covers.)
  const hasUserContext = (typeof userContext === 'string' && userContext.length > 10) ||
                          (Array.isArray(userContext) && userContext.length > 0);
  if (hasUserContext && actionPayload) {
    const overlap = _topicOverlap(actionPayload, userContext);
    // Threshold: < 0.15 overlap on non-trivial action tokens = mismatch
    if (overlap.ratio < 0.15 && overlap.score === 0) {
      signals.push({
        kind: 'user-mismatch',
        matched: `overlap ${(overlap.ratio * 100).toFixed(0)}%`,
        note: `action topic doesn't match recent user turns`,
      });
    }
  }

  const score = signals.length;
  // v7.3.6: telemetry-only. Any signal → 'warn' annotation; no 'block'.
  // The verdict field exists for structural parity with other gates,
  // not as a stepping stone toward enforcement.
  const verdict = score >= 1 ? 'warn' : 'pass';

  return { signals, score, verdict };
}

/**
 * Format a one-line log annotation for the gate outcome.
 */
function formatGateLog(scan, actionType) {
  if (scan.verdict === 'pass') return `[SELF-GATE] pass (${actionType})`;
  const kinds = scan.signals.map(s => s.kind).join(', ');
  return `[SELF-GATE] ${scan.verdict} on ${actionType} — signals: ${kinds}`;
}

/**
 * SelfGate as a stateful class (Iter 3 O: recommendation (b) — class).
 * Observation layer: runs checkSelfAction, records the result to
 * GateStats (if injected), fires a telemetry event when a signal
 * triggered. Never blocks the action.
 *
 * Usage:
 *   const gate = new SelfGate({ gateStats, bus });
 *   const scan = gate.check({ actionType, actionPayload, userContext, triggerSource });
 *   // scan.verdict is 'pass' or 'warn' — informational.
 *   // The action proceeds regardless. scan.allowed is always true in v7.3.6.
 */
class SelfGate {
  /**
   * @param {object} [opts]
   * @param {string} [opts.mode='warn']  - annotation style label;
   *                                        does not gate action execution
   * @param {object} [opts.gateStats]    - GateStats instance (optional)
   * @param {object} [opts.bus]          - EventBus (optional)
   */
  constructor(opts = {}) {
    this.mode = opts.mode || 'warn';
    this.gateStats = opts.gateStats || null;
    this.bus = opts.bus || null;
  }

  /**
   * Run the observation check. Fires the telemetry event and records
   * to GateStats when injected. Returns the scan augmented with
   * `allowed: true` — in v7.3.6 every action is allowed; the field
   * exists so callers that reserve a spot for it don't have to
   * assume and so future revisions can extend the shape without
   * breaking callers.
   *
   * @param {{actionType: string, actionPayload?: object, userContext?: *, triggerSource?: string}} params
   * @returns {SelfGateScan & {allowed: boolean}}
   */
  check(params) {
    const scan = checkSelfAction(params);
    const { verdict, signals } = scan;

    try {
      this.gateStats?.recordGate('self-gate', verdict);
    } catch (_) { /* optional */ }

    if (verdict === 'warn') {
      const eventPayload = {
        actionType: params.actionType,
        signals: signals.map(s => ({ kind: s.kind, note: s.note })),
        triggerSource: params.triggerSource || 'unknown',
      };
      try {
        this.bus?.fire('self-gate:warned', eventPayload, { source: 'SelfGate' });
      } catch (_) { /* NullBus */ }
      _log.debug(formatGateLog(scan, params.actionType));
    }

    return { ...scan, allowed: true };
  }

  setMode(mode) {
    // Kept for API compatibility with similar gate classes.
    // Does not change enforcement — there is none.
    if (mode !== 'warn' && mode !== 'enforce') {
      throw new Error(`SelfGate: unknown mode ${mode}`);
    }
    this.mode = mode;
  }
}

module.exports = {
  SelfGate,
  checkSelfAction,  // pure function for direct use / testing
  formatGateLog,
  REFLEXIVITY_PATTERNS,  // exposed for test introspection
};
