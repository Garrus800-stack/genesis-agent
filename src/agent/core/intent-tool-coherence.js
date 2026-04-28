// ============================================================
// GENESIS — core/intent-tool-coherence.js (v7.5.1)
//
// Cross-validation between IntentRouter classification and the
// tool the LLM eventually picks. Closes the v7.4.x architectural
// gap between injection-gate (input → blocks bad asks) and
// self-gate (Genesis' own actions → observes patterns):
//
//   injection-gate:  external input → block on signals
//   self-gate:       LLM-output action → observe patterns
//   intent-tool-coherence: classified intent ↔ tool choice
//                         → observe semantic mismatch
//
// ── Why this exists ──
// User says: "Hey Genesis, was kannst du eigentlich?"  (intent=general)
// LLM, mid-response, decides to call shell-run("ls -la").  Nothing
// in the conversation asked for shell access. injection-gate sees
// no malicious phrasing because there is none. self-gate notes
// reflexivity but doesn't compare against intent. Today the call
// goes through with full trust.
//
// This module records intent↔tool mismatches as telemetry. Like
// self-gate, the design is descriptive, not prescriptive: actions
// always proceed; gateStats and an event give Genesis (and Garrus)
// a way to see how often the LLM reaches for tools that don't fit
// the classified intent. If a category later proves consistently
// noisy, that's a signal — not an automatic block.
//
// ── Tool category model ──
// Tools are grouped by side-effect class. Intents are mapped to the
// tool-classes consistent with answering them:
//
//   READ_ONLY    : file-read, file-list, source-read, web-fetch ...
//   COMPUTE      : sandbox-run, eval-safe (no side-effects beyond CPU)
//   FS_WRITE     : file-write, file-delete
//   SHELL        : shell-run, shell-task
//   NETWORK      : web-search, http-fetch
//   SELF_MOD     : self-modify, self-repair, self-repair-reset
//   AGENCY       : create-skill, run-skill, clone, peer
//   META         : self-inspect, self-reflect, analyze-code, journal,
//                   plans, settings (Genesis introspection)
//
// An intent's "expected categories" lists what's coherent. A tool
// outside that list raises a coherence signal of variable severity.
// 'general' is permissive (most users ask everything via 'general')
// but tagging high-impact categories (SHELL, FS_WRITE, SELF_MOD)
// from 'general' as 'noteworthy' surfaces the most interesting
// mismatch class without false-positive flooding.
// ============================================================

'use strict';

/**
 * @typedef {object} CoherenceSignal
 * @property {string} kind  - one of 'mismatch' | 'unknown-tool' | 'unknown-intent'
 * @property {string} intent       - classified intent type (e.g. 'general')
 * @property {string} tool         - tool name attempted (e.g. 'shell-run')
 * @property {string} category     - tool's category (e.g. 'SHELL')
 * @property {string} severity     - one of 'low' | 'noteworthy' | 'high'
 * @property {string} note         - one-line human description
 */

/**
 * @typedef {object} CoherenceVerdict
 * @property {boolean} coherent    - false ⇔ at least one signal
 * @property {CoherenceSignal[]} signals
 */

// ── Tool categorisation ─────────────────────────────────────

const TOOL_CATEGORY = Object.freeze({
  // Read-only filesystem / source / network
  'file-read':       'READ_ONLY',
  'file-list':       'READ_ONLY',
  'source-read':     'READ_ONLY',
  'read-source':     'READ_ONLY',
  'web-fetch':       'READ_ONLY',
  'web-search':      'NETWORK',

  // Compute / sandbox
  'sandbox-run':     'COMPUTE',
  'eval-safe':       'COMPUTE',

  // Filesystem write
  'file-write':      'FS_WRITE',
  'file-delete':     'FS_WRITE',

  // Shell
  'shell-run':       'SHELL',
  'shell-task':      'SHELL',
  'execute-code':    'SHELL',
  'execute-file':    'SHELL',

  // Self-modification family
  'self-modify':     'SELF_MOD',
  'self-repair':     'SELF_MOD',
  'self-repair-reset':'SELF_MOD',

  // Agency / network of agents
  'create-skill':    'AGENCY',
  'run-skill':       'AGENCY',
  'clone':           'AGENCY',
  'peer':            'AGENCY',
  'trust-control':   'AGENCY',

  // Meta / introspection
  'self-inspect':    'META',
  'self-reflect':    'META',
  'analyze-code':    'META',
  'journal':         'META',
  'plans':           'META',
  'settings':        'META',
  'goals':           'META',
  'memory-list':     'META',
  'memory-mark':     'META',
  'memory-veto':     'META',

  // Misc
  'open-path':       'READ_ONLY',
  'open-in-editor':  'READ_ONLY',
  'mcp':             'NETWORK',
  'daemon':          'AGENCY',
});

// ── Intent → expected tool-category map ─────────────────────
//
// `general` is intentionally PERMISSIVE: most user questions are
// classified general, and read-only / compute / network tools are
// expected. The categories with persistent state-changing power
// (SHELL, FS_WRITE, SELF_MOD, AGENCY) are NOT in the general set —
// reaching them requires an explicit intent classification.

const INTENT_EXPECTED_CATEGORIES = Object.freeze({
  'general':         new Set(['READ_ONLY', 'COMPUTE', 'NETWORK', 'META']),
  'self-inspect':    new Set(['META', 'READ_ONLY']),
  'self-reflect':    new Set(['META', 'READ_ONLY']),
  'analyze-code':    new Set(['META', 'READ_ONLY']),
  'self-modify':     new Set(['SELF_MOD', 'META', 'READ_ONLY']),
  'self-repair':     new Set(['SELF_MOD', 'META']),
  'self-repair-reset':new Set(['SELF_MOD', 'META']),
  'execute-code':    new Set(['SHELL', 'COMPUTE']),
  'execute-file':    new Set(['SHELL']),
  'shell-run':       new Set(['SHELL']),
  'shell-task':      new Set(['SHELL', 'FS_WRITE', 'NETWORK']),
  'create-skill':    new Set(['AGENCY', 'FS_WRITE', 'META']),
  'run-skill':       new Set(['AGENCY']),
  'clone':           new Set(['AGENCY']),
  'peer':            new Set(['AGENCY', 'NETWORK']),
  'trust-control':   new Set(['AGENCY', 'META']),
  'daemon':          new Set(['AGENCY']),
  'goals':           new Set(['META', 'READ_ONLY']),
  'journal':         new Set(['META']),
  'plans':           new Set(['META']),
  'settings':        new Set(['META']),
  'memory-list':     new Set(['META']),
  'memory-mark':     new Set(['META']),
  'memory-veto':     new Set(['META']),
  'web-lookup':      new Set(['NETWORK', 'READ_ONLY']),
  'project-scan':    new Set(['READ_ONLY', 'META']),
  'undo':            new Set(['META', 'FS_WRITE']),
  'mcp':             new Set(['NETWORK', 'AGENCY']),
  'open-path':       new Set(['READ_ONLY', 'META']),
  'retry':           new Set(['META', 'READ_ONLY', 'COMPUTE', 'SHELL', 'FS_WRITE', 'NETWORK', 'AGENCY']),
  'greeting':        new Set(['META']),
});

// ── Severity model ──────────────────────────────────────────
// Categories that are state-changing or sensitive get higher
// severity when invoked from a permissive intent.
const HIGH_IMPACT_CATEGORIES = new Set(['SELF_MOD', 'SHELL', 'FS_WRITE', 'AGENCY']);

/**
 * Verify intent ↔ tool coherence. Telemetry-only — never blocks.
 *
 * @param {string} intentType  - the classified intent (e.g. 'general')
 * @param {string} toolName    - the tool the LLM is about to call
 * @returns {CoherenceVerdict}
 */
function verifyIntentToolCoherence(intentType, toolName) {
  const signals = [];
  const intent = String(intentType || '').toLowerCase();
  const tool   = String(toolName   || '').toLowerCase();

  if (!tool) {
    return { coherent: true, signals: [] };
  }

  const category = TOOL_CATEGORY[tool];
  if (!category) {
    // Unknown tool: not necessarily a bug (custom skills / MCP tools),
    // but worth recording so we can extend the map over time.
    signals.push({
      kind: 'unknown-tool',
      intent, tool, category: 'UNKNOWN',
      severity: 'low',
      note: `Tool '${tool}' not in coherence map; cannot verify.`,
    });
    return { coherent: false, signals };
  }

  const expected = INTENT_EXPECTED_CATEGORIES[intent];
  if (!expected) {
    signals.push({
      kind: 'unknown-intent',
      intent, tool, category,
      severity: 'low',
      note: `Intent '${intent}' not in coherence map.`,
    });
    return { coherent: false, signals };
  }

  if (expected.has(category)) {
    return { coherent: true, signals: [] };
  }

  // Mismatch. Severity scales by category impact and intent permissiveness.
  let severity = 'low';
  if (HIGH_IMPACT_CATEGORIES.has(category)) {
    // High-impact tool from a non-matching intent. If intent is
    // 'general' (most permissive), elevate to 'noteworthy' — this
    // is the classic "LLM reflexively reached for shell" pattern.
    severity = (intent === 'general') ? 'noteworthy' : 'high';
  }

  signals.push({
    kind: 'mismatch',
    intent, tool, category,
    severity,
    note: `Intent '${intent}' would not normally invoke ${category} tools (here: '${tool}').`,
  });
  return { coherent: false, signals };
}

/**
 * Bus-emitting helper. Records mismatches as 'intent:tool-mismatch'
 * events for downstream consumers (gateStats, dashboard). Returns
 * the verdict so callers can also branch on it locally if they want
 * (none currently do; design is observational).
 *
 * @param {object} bus           - Genesis EventBus
 * @param {string} intentType
 * @param {string} toolName
 * @param {object} [meta]        - extra context (correlationId, source)
 * @returns {CoherenceVerdict}
 */
function recordCoherenceCheck(bus, intentType, toolName, meta = {}) {
  const verdict = verifyIntentToolCoherence(intentType, toolName);
  if (!verdict.coherent && bus && typeof bus.emit === 'function') {
    try {
      for (const sig of verdict.signals) {
        bus.emit('intent:tool-mismatch', {
          ...sig,
          ...meta,
        }, { source: 'IntentToolCoherence' });
      }
    } catch (_e) { /* never break on telemetry */ }
  }
  return verdict;
}

module.exports = {
  TOOL_CATEGORY,
  INTENT_EXPECTED_CATEGORIES,
  HIGH_IMPACT_CATEGORIES,
  verifyIntentToolCoherence,
  recordCoherenceCheck,
};
