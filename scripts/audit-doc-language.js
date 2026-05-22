#!/usr/bin/env node
// ============================================================
// GENESIS — scripts/audit-doc-language.js
//
// Catches two classes of discipline violation in the project's
// English documentation:
//
//   1. Personal names (Daniel, Garrus, Camj78, …) that should
//      not appear in CHANGELOG/README/CONTRIBUTING/docs. The
//      maintainer-name convention is "the maintainer" / "in
//      field testing" / passive voice — narrative-only files
//      like ONTOGENESIS.md, AUDIT-BACKLOG.md, and LICENSE are
//      exempt as documented stop-list overrides.
//
//   2. Common-vocabulary German words mixed into English text
//      ("Rückgängig", "gelaufene", "für die"). The Genesis
//      project has English-only docs except for a small set of
//      whitelisted architecture proper-nouns ("Hauptstandort",
//      "Außenposten", "Können", "Win-Rechner"). Heuristic for
//      detection: any token containing ä/ö/ü/ß outside the
//      whitelist is flagged. False positives are rare because
//      English content with umlauts is itself a strong signal.
//
// SCOPE:
//   - CHANGELOG.md: only the current top section. Historical
//     entries below the second `## [...]` header are immutable
//     record and skipped.
//   - README.md: full file content.
//   - CONTRIBUTING.md: full file content.
//   - RELEASE_NOTES.md: full file content.
//   - docs/*.md: every file under docs/, full content, with
//     a few narrative/historical exemptions.
//
// CHANGELOG-v7.md and docs/CHANGELOG-v6.md are explicitly NOT
// scanned. They are historical archives. The convention is
// "historical entries are not rewritten in place" — they
// document what was, not what should be.
//
// CONTEXT-AWARE FILTERS (these matches are NOT flagged):
//   - Names that appear inside a GitHub URL (github.com/Name,
//     Name800-stack, …) — that is a code identifier, not a
//     personal reference in prose.
//   - Names that appear in a LICENSE-style attribution line
//     (line contains "(c)", "©", "MIT]", "Apache]" near the name).
//     LICENSE files and README license blocks must keep the
//     maintainer's name by copyright convention.
//   - German tokens whose hyphen-separated prefix is a
//     whitelisted Genesis proper-noun (Können-Promotion-Pipeline
//     starts with the whitelisted "Können" and is fine).
//
// EXEMPT FILES (narrative / historical / by-design):
//   - docs/ONTOGENESIS.md (philosophical narrative)
//   - docs/SELF-KNOWLEDGE.md (the letter to Genesis itself)
//   - docs/AUDIT-BACKLOG.md (historical references allowed)
//   - docs/CHANGELOG-v6.md (historical archive)
//   - LICENSE / CODE_OF_CONDUCT.md / SECURITY.md
//
// CLI:
//   node scripts/audit-doc-language.js          (informational)
//   node scripts/audit-doc-language.js --strict (exits 1 on violation)
// ============================================================

const fs = require('fs');
const path = require('path');

const STRICT = process.argv.includes('--strict');
const REPO_ROOT = path.resolve(__dirname, '..');

// Personal names that should not appear as prose references in
// English docs. URL identifiers and license attribution lines
// are filtered out by context-aware checks below.
//
// Camj78 is NOT on this list — it is a documented social-
// engineering pattern identifier, not a personal name. It
// appears in GATE-INVENTORY.md and SECURITY.md as a security
// pattern reference and that usage is intended.
const PERSONAL_NAMES = [
  'Daniel',
  'Garrus',
];

// Genesis architecture proper-nouns that ARE allowed in English text.
// Compound tokens (Whitelist-Word-EnglishPart) are also allowed via
// prefix-match in scanForGerman().
const GERMAN_WHITELIST = new Set([
  'Hauptstandort',
  'Hauptstandorts',
  'Außenposten',
  'Können',
  'Win-Rechner',
  'EliteBook',
]);

// Files that are exempt from the scan entirely.
const EXEMPT_PATHS = new Set([
  'docs/ONTOGENESIS.md',
  'docs/SELF-KNOWLEDGE.md',
  'docs/AUDIT-BACKLOG.md',
  'docs/CHANGELOG-v6.md',
  'LICENSE',
  'CODE_OF_CONDUCT.md',
  'SECURITY.md',
]);

// Lines that look like license/attribution. Names here are fine.
const ATTRIBUTION_PATTERNS = [
  /\(c\)|©/i,
  /\bMIT\b.*\]/,
  /\bApache\b.*\]/,
  /maintained by|copyright|attribution/i,
];

function isUrlContext(line, name) {
  // Match the name when it is part of a URL or identifier:
  // github.com/Name, Name800-stack, Name@host, etc.
  const inUrl = new RegExp(`(github\\.com[/:][^\\s)]*${name}|${name}\\d|${name}[-_][a-z]+)`, 'i');
  return inUrl.test(line);
}

function isAttributionLine(line) {
  return ATTRIBUTION_PATTERNS.some(re => re.test(line));
}

function isWhitelistedCompound(token) {
  // Exact match
  if (GERMAN_WHITELIST.has(token)) return true;
  // Compound starting with a whitelisted word: "Können-Promotion-Pipeline",
  // "Außenposten-Architektur". The remainder after the first hyphen must
  // be ASCII-only (English continuation).
  for (const allowed of GERMAN_WHITELIST) {
    if (token.startsWith(allowed + '-')) {
      const rest = token.slice(allowed.length + 1);
      if (!/[äöüÄÖÜß]/.test(rest)) return true;
    }
    if (token.endsWith('-' + allowed)) {
      const head = token.slice(0, -(allowed.length + 1));
      if (!/[äöüÄÖÜß]/.test(head)) return true;
    }
  }
  return false;
}

function isInBacktickContext(line, token) {
  // A German example wrapped in backticks (`einschränken`, `füge Ziel hinzu`)
  // is documentation OF a German feature, not English prose drifting into
  // German. Scan all backtick-delimited spans in the line and check whether
  // the token sits inside any of them. We accept both single-backtick
  // (`text`) and triple-backtick fenced inline spans.
  const spans = [];
  const re = /`([^`]+)`/g;
  let m;
  while ((m = re.exec(line)) !== null) {
    spans.push({ start: m.index, end: m.index + m[0].length, text: m[1] });
  }
  for (const span of spans) {
    if (span.text.includes(token)) return true;
  }
  return false;
}

function readCurrentChangelogSection(file) {
  // Returns only the top section (above the second `## [...]` header).
  // Identical scope rule to audit-future-version-refs.js.
  if (!fs.existsSync(file)) return '';
  const text = fs.readFileSync(file, 'utf8');
  const headers = [];
  const re = /^## \[[^\]]+\]/gm;
  let m;
  while ((m = re.exec(text)) !== null) {
    headers.push(m.index);
    if (headers.length >= 2) break;
  }
  if (headers.length < 2) return text;
  return text.slice(0, headers[1]);
}

function listDocFiles() {
  const files = [];

  // Top-level docs
  for (const name of ['README.md', 'CONTRIBUTING.md', 'RELEASE_NOTES.md']) {
    const p = path.join(REPO_ROOT, name);
    if (fs.existsSync(p)) files.push({ rel: name, content: fs.readFileSync(p, 'utf8') });
  }

  // CHANGELOG.md — current section only.
  // CHANGELOG-v7.md is a historical archive and not scanned (by design).
  const clMain = readCurrentChangelogSection(path.join(REPO_ROOT, 'CHANGELOG.md'));
  if (clMain) files.push({ rel: 'CHANGELOG.md (current section)', content: clMain });

  // docs/*.md (non-recursive)
  const docsDir = path.join(REPO_ROOT, 'docs');
  if (fs.existsSync(docsDir)) {
    for (const f of fs.readdirSync(docsDir)) {
      if (!f.endsWith('.md')) continue;
      const rel = `docs/${f}`;
      if (EXEMPT_PATHS.has(rel)) continue;
      files.push({ rel, content: fs.readFileSync(path.join(docsDir, f), 'utf8') });
    }
  }

  return files;
}

function scanForNames(text, file) {
  const violations = [];
  const lines = text.split('\n');
  for (const name of PERSONAL_NAMES) {
    const re = new RegExp(`(?<![A-Za-z0-9])${name}(?![A-Za-z])`, 'g');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (!re.test(line)) { re.lastIndex = 0; continue; }
      re.lastIndex = 0;
      // Context-aware filters:
      if (isUrlContext(line, name)) continue;        // github.com/Name, Name800-stack
      if (isAttributionLine(line)) continue;          // (c) Name, MIT © Name
      violations.push({
        file: file.rel,
        line: i + 1,
        kind: 'personal-name',
        token: name,
        snippet: line.trim().slice(0, 100),
      });
    }
  }
  return violations;
}

function scanForGerman(text, file) {
  // A token here is a contiguous run of letters (allowing internal hyphen
  // for compounds like "Außenposten-Architektur"). We flag any token that
  // contains umlauts or ß and is not whitelisted (exact or compound prefix).
  // German tokens inside backtick-delimited spans are skipped — those are
  // documented examples of German UI/command strings, not English-prose drift.
  const violations = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const tokens = line.match(/[A-Za-zäöüÄÖÜß][A-Za-zäöüÄÖÜß-]*/g) || [];
    for (const token of tokens) {
      if (!/[äöüÄÖÜß]/.test(token)) continue;
      if (isWhitelistedCompound(token)) continue;
      if (isInBacktickContext(line, token)) continue;
      violations.push({
        file: file.rel,
        line: i + 1,
        kind: 'german-word',
        token,
        snippet: line.trim().slice(0, 100),
      });
    }
  }
  return violations;
}

function main() {
  console.log('━━━ Doc Language Audit ━━━\n');

  const files = listDocFiles();
  const allViolations = [];

  for (const file of files) {
    allViolations.push(...scanForNames(file.content, file));
    allViolations.push(...scanForGerman(file.content, file));
  }

  if (allViolations.length === 0) {
    console.log('  \x1b[32m✅ No personal names or stray German words found in English docs.\x1b[0m');
    console.log(`     Scanned ${files.length} files. Whitelist: ${[...GERMAN_WHITELIST].slice(0, 5).join(', ')}…`);
    process.exit(0);
  }

  // Group by file for readable output
  const byFile = new Map();
  for (const v of allViolations) {
    if (!byFile.has(v.file)) byFile.set(v.file, []);
    byFile.get(v.file).push(v);
  }

  console.log(`  \x1b[33m⚠ Found ${allViolations.length} violation(s) in ${byFile.size} file(s):\x1b[0m\n`);

  for (const [file, vs] of byFile) {
    console.log(`  \x1b[1m${file}\x1b[0m`);
    for (const v of vs) {
      const kindLabel = v.kind === 'personal-name' ? 'name' : 'german';
      console.log(`     \x1b[2mL${v.line}\x1b[0m  [${kindLabel}] "${v.token}"`);
      console.log(`           ${v.snippet}`);
    }
    console.log('');
  }

  console.log('  Convention: English-only in CHANGELOG, README, CONTRIBUTING, RELEASE_NOTES,');
  console.log('  and docs/*.md. Genesis architecture proper-nouns (Hauptstandort, Außenposten,');
  console.log('  Können, Win-Rechner) are whitelisted. Personal names should be replaced with');
  console.log('  "the maintainer", "in field testing", or passive voice.');

  if (STRICT) process.exit(1);
  process.exit(0);
}

main();
