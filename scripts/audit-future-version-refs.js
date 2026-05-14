#!/usr/bin/env node
// ============================================================
// GENESIS — scripts/audit-future-version-refs.js
//
// Detects future-version references in current-release CHANGELOG
// content and project docs. Convention: only document what is in
// the current plan — no "deferred to v7.x+", "future release",
// "kommt später", roadmap notes.
//
// Why this exists: v7.8.1 shipped with "deferred to v7.7.10+ per
// the Plan" in the CHANGELOG and "reserved for a future release"
// in the v7.7.9 body. Both violate the convention and create
// debts that are easy to forget. This audit enforces the rule
// automatically going forward.
//
// SCOPE:
//   - CHANGELOG.md: only the current top section (everything
//     above the SECOND `## [...]` header). Historical entries
//     below are immutable record and left alone.
//   - docs/*.md: full file content scanned.
//   - README.md: full file content scanned.
//
// PATTERNS FLAGGED:
//   - "deferred to v?N.N(.N)+?"
//   - "deferred to (a|the) (future|later|separate|next) release"
//   - "(in|for) (a|the) future release"
//   - "future version"
//   - "kommt später" / "kommt spaeter"
//   - "v?N.N.N+" (e.g. v7.7.10+, 7.9.0+)
//   - "(roadmap|backlog) note" inside changelog current-section
//
// USAGE:
//   node scripts/audit-future-version-refs.js          — list violations
//   node scripts/audit-future-version-refs.js --strict — exit 1 if any
//   node scripts/audit-future-version-refs.js --json   — JSON output
//
// EXIT CODES:
//   0 : no violations, or --strict not set
//   1 : violations found (--strict only)
// ============================================================

'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const STRICT = process.argv.includes('--strict');
const JSON_OUT = process.argv.includes('--json');

// ── Patterns ────────────────────────────────────────────────

const PATTERNS = [
  { re: /\bdeferred\s+to\s+v?\d+\.\d+(\.\d+)?\+?/i, name: 'deferred-to-version' },
  { re: /\bdeferred\s+to\s+(a|the)\s+(future|later|separate|next)\s+release\b/i, name: 'deferred-to-future-release' },
  { re: /\b(in|for)\s+(a|the)\s+future\s+release\b/i, name: 'in-future-release' },
  { re: /\bfuture\s+version\b/i, name: 'future-version' },
  { re: /\bkommt\s+sp(ä|ae)ter\b/i, name: 'kommt-spaeter' },
  // v7.8.2: NOT a bare `vX.Y.Z+`. That pattern is widely used in the
  // legitimate "since version X" sense (e.g. "v7.6.9+ encryption key
  // anchor", "Topological Sort (v4.0.0+)"). Only future-coupled phrasing
  // is flagged: "(coming|planned|reserved|scheduled) (for|in) vX+".
  { re: /\b(coming|planned|scheduled|reserved|targeted|slated)\s+(for|in|to)\s+v?\d+\.\d+(\.\d+)?\+?/i, name: 'coming-in-version' },
  { re: /\breserved\s+for\s+(a|the)\s+(future|later|next)\s+release\b/i, name: 'reserved-for-future' },
];

// ── Helpers ─────────────────────────────────────────────────

function readSafe(p) {
  try { return fs.readFileSync(p, 'utf8'); } catch { return null; }
}

/**
 * Extract the current-release section from CHANGELOG.md.
 * Everything from the start (or first `## [...]`) until the SECOND
 * `## [...]` header. The body of the current release only.
 */
function currentChangelogSection(text) {
  if (!text) return '';
  const lines = text.split('\n');
  const headerIdx = [];
  for (let i = 0; i < lines.length; i++) {
    if (/^##\s+\[/.test(lines[i])) headerIdx.push(i);
    if (headerIdx.length >= 2) break;
  }
  if (headerIdx.length < 2) return text; // fallback: whole file
  return lines.slice(headerIdx[0], headerIdx[1]).join('\n');
}

function listDocs(dir) {
  try {
    return fs.readdirSync(dir)
      .filter(f => f.endsWith('.md'))
      .map(f => path.join(dir, f));
  } catch { return []; }
}

function scanText(text, sourceLabel) {
  const violations = [];
  if (!text) return violations;
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    for (const p of PATTERNS) {
      const m = line.match(p.re);
      if (m) {
        violations.push({
          source: sourceLabel,
          line: i + 1,
          pattern: p.name,
          match: m[0],
          context: line.trim().slice(0, 120),
        });
      }
    }
  }
  return violations;
}

// ── Scan ────────────────────────────────────────────────────

const violations = [];

// CHANGELOG.md current section only
const changelogText = readSafe(path.join(ROOT, 'CHANGELOG.md'));
violations.push(...scanText(currentChangelogSection(changelogText), 'CHANGELOG.md (current section)'));

// README.md full
violations.push(...scanText(readSafe(path.join(ROOT, 'README.md')), 'README.md'));

// docs/*.md full
for (const docPath of listDocs(path.join(ROOT, 'docs'))) {
  const rel = path.relative(ROOT, docPath);
  violations.push(...scanText(readSafe(docPath), rel));
}

// ── Output ──────────────────────────────────────────────────

if (JSON_OUT) {
  console.log(JSON.stringify({ violations, count: violations.length }, null, 2));
} else if (violations.length === 0) {
  console.log('  ✅ No future-version references found in current docs.');
} else {
  console.log(`  ⚠  ${violations.length} future-version reference(s) found:\n`);
  for (const v of violations) {
    console.log(`    ${v.source}:${v.line}  [${v.pattern}]`);
    console.log(`      ${v.context}`);
  }
  console.log('');
  console.log('  Convention: docs and current-release CHANGELOG must describe');
  console.log('  the current plan only — no "deferred to vX+", "future release",');
  console.log('  "kommt später", roadmap notes. Rephrase as factual status or');
  console.log('  drop the line. Historical CHANGELOG entries (below the second');
  console.log('  ## [...] header) are immutable record and not checked.');
}

if (STRICT && violations.length > 0) process.exit(1);
process.exit(0);
