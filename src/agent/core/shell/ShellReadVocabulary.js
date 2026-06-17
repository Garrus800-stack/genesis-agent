// ============================================================
// GENESIS — ShellReadVocabulary.js
//
// Single source of truth for the "read vs mutate" shell vocabulary shared by
// the two layers that classify shell commands:
//
//   - plan time:  FormalPlanner._typifyStep, via isReadOnlyShellCommand — a
//                 FAIL-CLOSED allow-list that keeps a SHELL step on a read-only
//                 goal only if the command is provably a read.
//   - runtime:    ShellSafety._classifyCommandIntent — a read / write / launch
//                 classification for the root-dir sandbox path boundary.
//
// The two policies legitimately differ at the edges: the runtime gate counts
// echo / pwd / cd / which / less / more as non-writing reads (for path gating)
// and treats git / npm conservatively as writes; the plan-time guard counts git
// read sub-commands, npm test and PowerShell reads as reads, under a fail-closed
// wrapper. What they SHARE is the BASE set of universally-read verbs below.
// Each layer derives its own set from this base, so the common core has one
// source and cannot drift. ShellSafety extends BASE_READ_VERBS with its
// launch / builtin reads; the plan-time READ_VERBS here is the base plus the
// PowerShell + multiplexer additions.
// ============================================================

'use strict';

// Verbs both layers agree are reads. POSIX + cmd read forms.
const BASE_READ_VERBS = new Set([
  'cat', 'ls', 'find', 'grep', 'head', 'tail', 'wc',
  'stat', 'file', 'type', 'dir', 'findstr', 'tree',
]);

// Plan-time additions on top of the base: PowerShell read cmdlets, plus the
// multiplexers (git / npm / yarn / pnpm) which are gated on their sub-command
// in isReadOnlyShellCommand below. These are NOT in the runtime gate's read
// set — that gate treats git / npm as writes for the sandbox boundary.
const _PLAN_READ_EXTRA = [
  'get-content', 'gc', 'get-childitem', 'gci',
  'select-string', 'sls', 'select-object', 'where-object',
  'measure-object', 'test-path',
  'git', 'npm', 'yarn', 'pnpm',
];

// Plan-time read vocabulary = shared base + plan-time additions.
const READ_VERBS = new Set([...BASE_READ_VERBS, ..._PLAN_READ_EXTRA]);

// git sub-commands that only read.
const GIT_READ_SUBCOMMANDS = new Set([
  'status', 'log', 'diff', 'show', 'branch', 'rev-parse', 'ls-files', 'cat-file',
]);

/**
 * Fail-closed read-only classification of a shell command string. Returns true
 * ONLY if the command is provably a read; false on any doubt (unknown tool,
 * opaque script, unparseable) so the caller can rewrite the step to ANALYZE —
 * a lost read, never a risked write.
 * @param {string} cmd
 * @returns {boolean}
 */
function isReadOnlyShellCommand(cmd) {
  if (!cmd || typeof cmd !== 'string') return false;
  const trimmed = cmd.trim();
  if (!trimmed) return false;

  // Command / process substitution runs an arbitrary inner command the segment
  // split below never sees: $(...), backticks, <(...). >(...) carries '>' and
  // is caught by the redirection check. An inspection step never needs
  // substitution — reject outright.
  if (trimmed.includes('$(') || trimmed.includes('`') || trimmed.includes('<(')) {
    return false;
  }

  // Strip quoted spans so redirection / separator scanning ignores quoted
  // content (grep "a>b" file must not look like a redirect). Unbalanced quotes
  // → not safely parseable → fail closed.
  const stripped = _stripQuotedSpans(trimmed);
  if (stripped === null) return false;

  // Any '>' outside quotes is an output redirection (file write) — reject.
  // (Also rejects 2>&1 etc.: a harmless lost read on a read-only goal.)
  if (stripped.includes('>')) return false;

  // Every segment of a chained / piped command must be a read.
  const segments = stripped.split(/&&|\|\||;|\|/).map(s => s.trim()).filter(Boolean);
  if (segments.length === 0) return false;
  return segments.every(_segmentIsRead);
}

// Remove single- and double-quoted spans; returns null on unbalanced quotes.
function _stripQuotedSpans(s) {
  let out = '';
  let quote = null;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (quote) {
      if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else {
      out += ch;
    }
  }
  return quote ? null : out;
}

// Read-only check for one command segment (no separators inside).
function _segmentIsRead(segment) {
  let tokens = segment.split(/\s+/).filter(Boolean);
  // Drop leading VAR=value environment assignments.
  while (tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[0])) {
    tokens = tokens.slice(1);
  }
  if (tokens.length === 0) return false;

  // Bare version probe is a read regardless of tool: <tool> --version | -v with
  // no further arguments.
  if (tokens.length === 2 && (tokens[1] === '--version' || tokens[1] === '-v')) {
    return true;
  }

  const lead = tokens[0].toLowerCase();
  if (!READ_VERBS.has(lead)) return false;

  // find: a read traversal, but -exec / -execdir / -delete / -ok mutate.
  if (lead === 'find' && /(?:^|\s)-(?:exec|execdir|delete|ok)(?:\s|$)/i.test(segment)) {
    return false;
  }
  // git: sub-command must be a read sub-command.
  if (lead === 'git') {
    return GIT_READ_SUBCOMMANDS.has((tokens[1] || '').toLowerCase());
  }
  // npm / yarn / pnpm: only `test` (the project test runner). `run <script>` is
  // opaque (npm run build writes); install writes.
  if (lead === 'npm' || lead === 'yarn' || lead === 'pnpm') {
    return (tokens[1] || '').toLowerCase() === 'test';
  }
  return true;
}

module.exports = {
  BASE_READ_VERBS,
  READ_VERBS,
  GIT_READ_SUBCOMMANDS,
  isReadOnlyShellCommand,
};
