#!/usr/bin/env node
// ============================================================
// GENESIS — scripts/audit-gate-stats-callers.js
//
// Verifies that every recordGate(name, verdict, ...) call site in
// src/agent/ passes a valid verdict — either a string literal from
// VALID_VERDICTS = {'pass', 'block', 'warn'}, or a ternary/variable
// that statically resolves to one of those. Fails (exit 1) when a
// call site passes an Object literal, an unknown string, or a
// non-static value that can't be proven valid.
//
// Background: the v7.6.2 audit found that ChatOrchestratorHelpers.js
// passed `{ verdict: 'mismatch' }` (an Object, with a string value
// that wasn't in VALID_VERDICTS) — silently dropped by GateStats
// since v7.5.1. ~12 months of telemetry lost. No existing CI gate
// caught it because:
//   - audit-events --strict checks event names vs catalog (different concern)
//   - validate-service-wiring checks DI references (different concern)
//   - gate-stats unit tests only test recordGate() in isolation
// This script closes the "intention recorded but verdict invalid" drift
// by static-analyzing every recordGate(...) call.
//
// CHECKS:
//   1. Find every `<expr>.recordGate(<name>, <verdict>, ...)` call in src/agent.
//   2. The verdict argument must be one of:
//        a. String literal: 'pass' / 'block' / 'warn'
//        b. Ternary: <cond> ? '<valid>' : '<valid>'
//        c. Identifier resolved to a const with one of those values
//   3. FAIL on Object literals (arg starts with `{`).
//   4. FAIL on string literals not in VALID_VERDICTS.
//   5. WARN  on dynamic verdicts that can't be statically resolved
//      (the call-site author should make it static or document why).
//
// USAGE:
//   node scripts/audit-gate-stats-callers.js          — table output
//   node scripts/audit-gate-stats-callers.js --json   — machine-readable
//   node scripts/audit-gate-stats-callers.js --strict — exit 1 on FAIL+WARN
//
// EXIT CODES:
//   0 : every recordGate call uses a valid verdict
//   1 : at least one call uses an invalid verdict
// ============================================================

'use strict';

const fs = require('fs');
const path = require('path');

const ROOT     = path.resolve(__dirname, '..');
const SCAN_DIR = path.join(ROOT, 'src/agent');

const VALID_VERDICTS = new Set(['pass', 'block', 'warn']);

const args     = process.argv.slice(2);
const strict   = args.includes('--strict');
const jsonMode = args.includes('--json');

// ── Step 1: walk src/agent and collect recordGate() call sites ──
function* walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      yield* walk(full);
    } else if (entry.name.endsWith('.js') && !full.includes('node_modules')) {
      yield full;
    }
  }
}

// Match `.recordGate(<arg1>, <arg2>` capturing both args greedily-then-trimmed.
// We use a regex with limited nesting; for nested () we fall back to manual paren-balance.
const CALL_RE = /\.recordGate\s*\(/g;

function findRecordGateCalls() {
  const calls = [];
  for (const file of walk(SCAN_DIR)) {
    const origSrc = fs.readFileSync(file, 'utf8');
    const rel = path.relative(ROOT, file);
    // Strip block-comments and line-comments BEFORE scanning. We replace
    // them with whitespace of the same length so line-numbers are preserved
    // — call sites inside JSDoc / inline notes don't count as real callers.
    // v7.6.4 in-version: keep origSrc separately so we can detect inline
    // hint comments above call sites without the strip-pass eating them.
    const src = stripCommentsPreservingLines(origSrc);
    const origLines = origSrc.split('\n');
    let m;
    CALL_RE.lastIndex = 0;
    while ((m = CALL_RE.exec(src)) !== null) {
      const callStart = m.index + m[0].length; // position right after '('
      // Walk forward, balancing parens, to find the matching closing ')'
      let depth = 1;
      let i = callStart;
      let inStr = null; // null | "'" | '"' | '`'
      while (i < src.length && depth > 0) {
        const ch = src[i];
        if (inStr) {
          if (ch === '\\') { i += 2; continue; }
          if (ch === inStr) inStr = null;
        } else {
          if (ch === "'" || ch === '"' || ch === '`') inStr = ch;
          else if (ch === '(') depth++;
          else if (ch === ')') depth--;
        }
        if (depth === 0) break;
        i++;
      }
      const argSrc = src.slice(callStart, i).trim();
      // Split on top-level commas
      const args = splitTopLevelCommas(argSrc);
      // Compute line number
      const lineNum = src.slice(0, m.index).split('\n').length;
      // v7.6.4 in-version: capture the original source line immediately above
      // so classifyVerdict can honour `// recordGate-verdict: ...` hints —
      // origLines (pre-strip) preserves the comment text.
      const precedingLine = lineNum >= 2 ? origLines[lineNum - 2] : '';
      calls.push({
        file: rel,
        line: lineNum,
        nameArg: args[0] || '',
        verdictArg: args[1] || '',
        argSrc,
        precedingLine,
      });
    }
  }
  return calls;
}

// Strip /* ... */ and // ... comments while preserving line breaks so
// reported line numbers stay correct.
function stripCommentsPreservingLines(src) {
  let out = '';
  let i = 0;
  let inStr = null;
  while (i < src.length) {
    const ch = src[i];
    const next = src[i + 1];
    if (inStr) {
      if (ch === '\\') { out += src.slice(i, i + 2); i += 2; continue; }
      if (ch === inStr) inStr = null;
      out += ch; i++; continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      inStr = ch; out += ch; i++; continue;
    }
    if (ch === '/' && next === '/') {
      // line comment — skip until newline
      while (i < src.length && src[i] !== '\n') i++;
      continue; // keep the newline
    }
    if (ch === '/' && next === '*') {
      // block comment — replace with same-length whitespace, keep newlines
      let j = i + 2;
      while (j < src.length - 1 && !(src[j] === '*' && src[j + 1] === '/')) j++;
      const block = src.slice(i, Math.min(j + 2, src.length));
      out += block.replace(/[^\n]/g, ' ');
      i = j + 2;
      continue;
    }
    out += ch; i++;
  }
  return out;
}

function splitTopLevelCommas(s) {
  const out = [];
  let depth = 0;
  let inStr = null;
  let last = 0;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (inStr) {
      if (ch === '\\') { i++; continue; }
      if (ch === inStr) inStr = null;
    } else {
      if (ch === "'" || ch === '"' || ch === '`') inStr = ch;
      else if (ch === '(' || ch === '[' || ch === '{') depth++;
      else if (ch === ')' || ch === ']' || ch === '}') depth--;
      else if (ch === ',' && depth === 0) {
        out.push(s.slice(last, i).trim());
        last = i + 1;
      }
    }
  }
  out.push(s.slice(last).trim());
  return out;
}

// ── Step 2: classify each verdict argument ──────────────────
// v7.6.4 in-version (audit-gate-stats-callers closeout): classifyVerdict
// gained an optional `precedingLine` parameter so it can honour an inline
// hint comment of the form `// recordGate-verdict: <a> | <b> | <c>` on
// the source line immediately above the call. The hint is opt-in, must
// list values that are all in VALID_VERDICTS, and is the documented way
// to prove validity for bare identifiers whose origin is statically clear
// to the author but not to a regex-based scanner (e.g. destructured fields
// from a typed return, or values mapped through a verdict-translation
// table). Without a hint a bare identifier still warns, as before.
function classifyVerdict(verdictArg, precedingLine = '') {
  const v = verdictArg.trim();

  // Object literal — bug class from H1 ('{ verdict: "mismatch" }')
  if (v.startsWith('{')) {
    return { kind: 'fail', reason: 'Object literal — recordGate expects a string verdict' };
  }

  // Plain string literal
  const strLit = v.match(/^['"`]([^'"`]+)['"`]$/);
  if (strLit) {
    if (VALID_VERDICTS.has(strLit[1])) return { kind: 'pass', value: strLit[1] };
    return { kind: 'fail', reason: `string literal '${strLit[1]}' not in VALID_VERDICTS` };
  }

  // Ternary — both branches must be valid string literals
  // Simplistic match: <cond> ? '<a>' : '<b>'
  const ternary = v.match(/^.+\?\s*(['"`])(\w+)\1\s*:\s*(['"`])(\w+)\3\s*$/);
  if (ternary) {
    const a = ternary[2];
    const b = ternary[4];
    if (VALID_VERDICTS.has(a) && VALID_VERDICTS.has(b)) {
      return { kind: 'pass', value: `${a}|${b}` };
    }
    return { kind: 'fail', reason: `ternary branches '${a}'/'${b}' not all in VALID_VERDICTS` };
  }

  // v7.6.4 in-version: inline hint comment on the line immediately above
  // the call. Form: `// recordGate-verdict: a | b | c` (whitespace-loose).
  // All listed values must be in VALID_VERDICTS for the call to count as
  // pass. This is the documented escape-hatch for bare identifiers whose
  // origin is statically clear to the author but not to this scanner.
  const hint = precedingLine.match(/\/\/\s*recordGate-verdict\s*:\s*([^/]+?)\s*(?:\(|$)/);
  if (hint) {
    const declared = hint[1].split(/\s*[|,]\s*/).map(s => s.trim()).filter(Boolean);
    if (declared.length > 0 && declared.every(d => VALID_VERDICTS.has(d))) {
      return { kind: 'pass', value: `hint:${declared.join('|')}` };
    }
    // hint present but malformed — fail loudly so the author fixes it
    return {
      kind: 'fail',
      reason: `hint comment lists values not all in VALID_VERDICTS: ${declared.join(', ')}`,
    };
  }

  // Bare identifier — could be a const that resolves to a valid verdict.
  // Static-resolution is hard without an AST + scope; we mark these as warn
  // so the author either makes the call static or documents the source via
  // the `// recordGate-verdict: ...` hint above.
  return { kind: 'warn', reason: 'dynamic verdict — cannot statically prove validity' };
}

// ── Step 3: report ──────────────────────────────────────────
function main() {
  const calls = findRecordGateCalls();
  const fails = [];
  const warns = [];
  const passes = [];

  for (const c of calls) {
    const { kind, reason, value } = classifyVerdict(c.verdictArg, c.precedingLine);
    if (kind === 'fail') fails.push({ ...c, reason });
    else if (kind === 'warn') warns.push({ ...c, reason });
    else passes.push({ ...c, value });
  }

  if (jsonMode) {
    console.log(JSON.stringify({ passes, warns, fails }, null, 2));
  } else {
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('  Gate-Stats Caller Audit (v7.6.2 audit-closeout)');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log(`Found ${calls.length} recordGate() call site(s) in src/agent.`);
    console.log(`  ✅ ${passes.length} valid`);
    console.log(`  ⚠️  ${warns.length} dynamic (warn)`);
    console.log(`  ❌ ${fails.length} invalid (fail)`);
    if (fails.length) {
      console.log('\nInvalid call sites:');
      for (const f of fails) {
        console.log(`  ❌ ${f.file}:${f.line}  →  ${f.reason}`);
        console.log(`      args: ${f.argSrc.slice(0, 120)}`);
      }
    }
    if (warns.length && (strict || warns.length > 0)) {
      console.log('\nDynamic call sites (cannot statically verify):');
      for (const w of warns) {
        console.log(`  ⚠️  ${w.file}:${w.line}  →  ${w.reason}`);
        console.log(`      args: ${w.argSrc.slice(0, 120)}`);
      }
    }
    if (fails.length === 0 && (warns.length === 0 || !strict)) {
      console.log('\n✅ All recordGate() calls use valid verdicts.');
    }
  }

  if (fails.length > 0) process.exit(1);
  if (strict && warns.length > 0) process.exit(1);
  process.exit(0);
}

main();
