#!/usr/bin/env node
// ============================================================
// GENESIS — scripts/audit-slash-discipline.js
//
// Slash-discipline classifier. Categorizes every intent in
// IntentPatterns.js by its match-style and security-required-slash
// status, surfaces fuzzy-or-mixed intents NOT in SECURITY_REQUIRED_SLASH
// as potential audit findings.
//
// CATEGORIES:
//   pure-slash-only  : every pattern is anchored on a literal /
//                      → safe by construction
//   fuzzy+slash-mix  : mixes /-anchored and free-text patterns
//                      → safe IF in SECURITY_REQUIRED_SLASH (the guard
//                      rewrites to 'general' without `/` in message)
//                      → finding IF not in security set: the free-text
//                      pattern can fire from injected text
//   fuzzy-only       : no /-anchored pattern at all
//                      → safe IF in SECURITY_REQUIRED_SLASH
//                      → finding otherwise: every match is fuzzy
//
// USAGE:
//   node scripts/audit-slash-discipline.js          — table output
//   node scripts/audit-slash-discipline.js --json   — machine-readable
//   node scripts/audit-slash-discipline.js --strict — exit 1 on findings
//
// EXIT CODES:
//   0 : no findings (all fuzzy/mix intents in security set)
//   1 : findings present (printed); only with --strict
// ============================================================

'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const PATTERNS_FILE = path.join(ROOT, 'src', 'agent', 'intelligence', 'IntentPatterns.js');

const args = process.argv.slice(2);
const jsonOutput = args.includes('--json');
const strict = args.includes('--strict');

const c = {
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
};

// ── Parse IntentPatterns.js ──────────────────────────────────

function parsePatterns(source) {
  // Each intent: ['name', [regex_array], priority, [keywords]]
  // We need the regex array contents for each intent.
  const intents = [];
  // Find each intent's start: ['<name>',
  const starts = [];
  const startRe = /\[\s*'([\w-]+)'\s*,\s*\[/g;
  let m;
  while ((m = startRe.exec(source)) !== null) {
    starts.push({ name: m[1], pos: m.index });
  }

  for (let i = 0; i < starts.length; i++) {
    const start = starts[i].pos;
    // Walk forward to find the end of this intent block — looking for
    // `], <number>,` which ends the patterns array followed by priority.
    const tail = source.slice(start);
    const endMatch = /\]\s*,\s*\d+\s*,/.exec(tail);
    if (!endMatch) continue;
    const block = tail.slice(0, endMatch.index + 1);  // include final ]
    // Extract regex literals — each pattern is on a code line (not inside
    // a comment). A line is "code-bearing" if its non-whitespace prefix is
    // not `//`. We then run the regex matcher only on code-bearing lines.
    const patterns = [];
    const codeBearing = block
      .split('\n')
      .filter(line => !line.trimStart().startsWith('//'))
      .join('\n');
    const re = /\/(?:\\.|\[[^\]]*\]|[^\/\\\n])+\/[gimuyx]*/g;
    let pm;
    while ((pm = re.exec(codeBearing)) !== null) {
      patterns.push(pm[0]);
    }
    intents.push({ name: starts[i].name, patterns });
  }

  return intents;
}

function parseSecuritySet(source) {
  const m = /const\s+SECURITY_REQUIRED_SLASH\s*=\s*new Set\(\s*\[([\s\S]*?)\]\s*\)/.exec(source);
  if (!m) return new Set();
  const items = new Set();
  const itemRe = /'([\w-]+)'/g;
  let im;
  while ((im = itemRe.exec(m[1])) !== null) items.add(im[1]);
  return items;
}

function classifyIntent(patterns) {
  if (patterns.length === 0) return 'no-pattern';
  // A pattern is slash-anchored if it contains \/ (escaped literal slash)
  const slashAnchored = patterns.filter(p => p.includes('\\/'));
  const fuzzy = patterns.filter(p => !p.includes('\\/'));
  if (fuzzy.length === 0) return 'pure-slash-only';
  if (slashAnchored.length === 0) return 'fuzzy-only';
  return 'fuzzy+slash-mix';
}

function statusFor(name, kind, inSec) {
  if (kind === 'pure-slash-only') return { mark: '✓', label: 'safe (slash-only)', isFinding: false };
  if (kind === 'no-pattern') return { mark: '·', label: 'no-pattern', isFinding: false };
  if (inSec) return { mark: '✓', label: 'safe (in SECURITY_REQUIRED_SLASH)', isFinding: false };
  if (FUZZY_BY_DESIGN[name]) return { mark: '○', label: `whitelisted: ${FUZZY_BY_DESIGN[name]}`, isFinding: false };
  return { mark: '!', label: 'FINDING — fuzzy without security-required-slash', isFinding: true };
}

// ── Whitelist: Intents that are intentionally fuzzy by design ────
// These intents do NOT belong in SECURITY_REQUIRED_SLASH because their
// match-style serves a legitimate UX purpose AND the action they trigger
// has its own safeguards or is read-only. The audit treats them as safe
// even though they're fuzzy — but lists them separately so a reviewer
// can re-check the rationale.
const FUZZY_BY_DESIGN = {
  greeting:        'Conversational small-talk; matching slash would break chat UX entirely.',
  retry:           'Repeats last user command; cannot escalate beyond what was already allowed.',
  'project-scan':  'Read-only inspection of working directory; no write/exec consequence.',
  'web-lookup':    'Read-only web fetch; result returned to user, not executed.',
  settings:        'Free-text pattern is API-key-paste capture (anthropic/openai api-key: ...) — intentional convenience for credential entry.',
  undo:            'Reverts last action via git revert HEAD; rollback is itself a safety operation.',
  'open-path':     'Conversational UX — user says "öffne den Ordner X" and Genesis opens it. Forcing slash would break natural-language interaction. Path-existence + sandbox checks (v7.5.6 ShellSafety) provide real safety; slash would be theatre.',
  mcp:             'Conversational UX — user says "verbinde mit MCP-Server" naturally. Connection itself triggers explicit Genesis prompts (server-name, transport, scope), so an injected request would still surface for review. Slash-only would force dual-form interaction.',
};

const source = fs.readFileSync(PATTERNS_FILE, 'utf8');
const intents = parsePatterns(source);
const securitySet = parseSecuritySet(source);

const rows = intents.map(intent => {
  const kind = classifyIntent(intent.patterns);
  const inSec = securitySet.has(intent.name);
  const status = statusFor(intent.name, kind, inSec);
  return {
    name: intent.name,
    kind,
    inSec,
    isFinding: status.isFinding,
    statusMark: status.mark,
    statusLabel: status.label,
    patterns: intent.patterns,
  };
});

const findings = rows.filter(r => r.isFinding);

if (jsonOutput) {
  console.log(JSON.stringify({
    intents: rows.map(({ name, kind, inSec, isFinding, patterns }) => ({
      name, kind, inSec, isFinding, patterns,
    })),
    findings: findings.map(f => f.name),
    securitySet: [...securitySet],
    summary: {
      total: rows.length,
      pureSlash: rows.filter(r => r.kind === 'pure-slash-only').length,
      fuzzyMix: rows.filter(r => r.kind === 'fuzzy+slash-mix').length,
      fuzzyOnly: rows.filter(r => r.kind === 'fuzzy-only').length,
      noPattern: rows.filter(r => r.kind === 'no-pattern').length,
      findings: findings.length,
    },
  }, null, 2));
} else {
  console.log('');
  console.log(c.bold('  ╔══════════════════════════════════════════╗'));
  console.log(c.bold('  ║   GENESIS SLASH-DISCIPLINE AUDIT         ║'));
  console.log(c.bold('  ╚══════════════════════════════════════════╝'));
  console.log('');
  console.log(`  ${c.dim('Source')} ${path.relative(ROOT, PATTERNS_FILE)}`);
  console.log(`  ${c.dim('Intents')} ${rows.length}    ${c.dim('Security set')} ${securitySet.size} entries`);
  console.log('');
  console.log(`  ${c.bold('INTENT'.padEnd(22))} ${c.bold('CATEGORY'.padEnd(20))} ${c.bold('IN_SEC')} ${c.bold('STATUS')}`);
  console.log('  ' + '─'.repeat(80));
  for (const r of rows) {
    const mark = r.statusMark === '✓' ? c.green(r.statusMark)
              : r.statusMark === '!' ? c.red(r.statusMark)
              : c.dim(r.statusMark);
    const inSec = r.inSec ? c.green('yes') : c.dim('no ');
    const label = r.isFinding ? c.yellow(r.statusLabel) : c.dim(r.statusLabel);
    console.log(`  ${r.name.padEnd(22)} ${r.kind.padEnd(20)} ${inSec.padEnd(13)} ${mark} ${label}`);
  }
  console.log('');

  // Summary
  const summary = {
    total: rows.length,
    pureSlash: rows.filter(r => r.kind === 'pure-slash-only').length,
    fuzzyMix: rows.filter(r => r.kind === 'fuzzy+slash-mix').length,
    fuzzyOnly: rows.filter(r => r.kind === 'fuzzy-only').length,
    noPattern: rows.filter(r => r.kind === 'no-pattern').length,
  };
  console.log(`  ${c.dim('Pure slash-only')} ${summary.pureSlash}    ${c.dim('Fuzzy+slash mix')} ${summary.fuzzyMix}    ${c.dim('Fuzzy-only')} ${summary.fuzzyOnly}    ${c.dim('No pattern')} ${summary.noPattern}`);
  console.log('');

  if (findings.length === 0) {
    console.log(c.green('  ✅ No findings — all fuzzy/mix intents are in SECURITY_REQUIRED_SLASH.'));
  } else {
    console.log(c.yellow(`  ⚠  ${findings.length} finding${findings.length === 1 ? '' : 's'}:`));
    for (const f of findings) {
      console.log(`     ${c.bold(f.name)} — ${f.kind}`);
      for (const p of f.patterns) {
        console.log(`       ${c.dim(p.slice(0, 80))}`);
      }
    }
    console.log('');
    console.log(c.dim('  Each finding is a fuzzy or mixed intent NOT in SECURITY_REQUIRED_SLASH.'));
    console.log(c.dim('  Decide per intent: is the free-text pattern a real injection risk for'));
    console.log(c.dim('  the action it triggers? If yes, add to SECURITY_REQUIRED_SLASH.'));
  }
  console.log('');
}

if (strict && findings.length > 0) {
  process.exit(1);
}
