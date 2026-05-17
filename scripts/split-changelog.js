#!/usr/bin/env node
// One-shot: split CHANGELOG.md into per-major archives. The current
// CHANGELOG.md keeps the newest entry inline (so Genesis'
// ChatOrchestratorSourceRead still finds "what changed") and gains
// an Index section pointing to the major files.

'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SRC  = path.join(ROOT, 'CHANGELOG.md');
const full = fs.readFileSync(SRC, 'utf-8');

// Find every "## [x.y.z]" header. Order = newest first (top of file).
const headerRe = /^## \[(\d+)\.(\d+)\.(\d+)(?:[^\]]*)\]/gm;
const headers = [];
let m;
while ((m = headerRe.exec(full)) !== null) {
  headers.push({
    index: m.index,
    text: m[0],
    major: parseInt(m[1], 10),
    minor: parseInt(m[2], 10),
    patch: parseInt(m[3], 10),
  });
}
console.log(`Found ${headers.length} version headers.`);

// Slice into sections: each entry is from its header to the next.
const sections = headers.map((h, i) => ({
  ...h,
  body: full.slice(h.index, headers[i + 1]?.index ?? full.length).trim() + '\n\n',
}));

// File preamble (everything before the first header).
const preamble = headers.length ? full.slice(0, headers[0].index).trim() + '\n\n' : '';

// Group by major.
const byMajor = new Map();
for (const s of sections) {
  if (!byMajor.has(s.major)) byMajor.set(s.major, []);
  byMajor.get(s.major).push(s);
}

// Decide grouping:
//   - current major (v7) — stays in CHANGELOG.md (newest entry only) AND
//     gets a full CHANGELOG-v7.md archive of all v7 entries
//   - v6, v5 — their own files
//   - v0–v4 — combined into docs/CHANGELOG-archive.md
function header(text) {
  return `# Genesis Agent — ${text}\n\nFor the current release notes see [CHANGELOG.md](CHANGELOG.md).\n\n---\n\n`;
}

// CHANGELOG-v7.md (all v7 entries)
const v7Entries = byMajor.get(7) || [];
fs.writeFileSync(
  path.join(ROOT, 'CHANGELOG-v7.md'),
  header('Changelog v7.x.x') + v7Entries.map(s => s.body).join('---\n\n'),
  'utf-8'
);
console.log(`Wrote CHANGELOG-v7.md (${v7Entries.length} entries).`);

// CHANGELOG-v6.md
const v6Entries = byMajor.get(6) || [];
fs.writeFileSync(
  path.join(ROOT, 'docs', 'CHANGELOG-v6.md'),
  header('Changelog v6.x.x') + v6Entries.map(s => s.body).join('---\n\n'),
  'utf-8'
);
console.log(`Wrote docs/CHANGELOG-v6.md (${v6Entries.length} entries).`);

// CHANGELOG-v5.md
const v5Entries = byMajor.get(5) || [];
fs.writeFileSync(
  path.join(ROOT, 'docs', 'CHANGELOG-v5.md'),
  header('Changelog v5.x.x') + v5Entries.map(s => s.body).join('---\n\n'),
  'utf-8'
);
console.log(`Wrote docs/CHANGELOG-v5.md (${v5Entries.length} entries).`);

// CHANGELOG-archive.md (v0–v4)
const archiveEntries = [];
for (const major of [4, 3, 2, 1, 0]) {
  archiveEntries.push(...(byMajor.get(major) || []));
}
fs.writeFileSync(
  path.join(ROOT, 'docs', 'CHANGELOG-archive.md'),
  header('Changelog archive (v0.x.x – v4.x.x)') + archiveEntries.map(s => s.body).join('---\n\n'),
  'utf-8'
);
console.log(`Wrote docs/CHANGELOG-archive.md (${archiveEntries.length} entries).`);

// Rebuild CHANGELOG.md = preamble + newest entry inline + index.
const newest = sections[0];
const indexBlock = `

---

## Older releases

For prior version history, see the archive files:

- [**CHANGELOG-v7.md**](CHANGELOG-v7.md) — all v7.x.x releases (${v7Entries.length} entries)
- [**CHANGELOG-v6.md**](CHANGELOG-v6.md) — all v6.x.x releases (${v6Entries.length} entries)
- [**CHANGELOG-v5.md**](CHANGELOG-v5.md) — all v5.x.x releases (${v5Entries.length} entries)
- [**CHANGELOG-archive.md**](CHANGELOG-archive.md) — v0.x.x – v4.x.x (${archiveEntries.length} entries)

This index file (\`CHANGELOG.md\`) keeps only the newest release inline so
the file stays readable. The major-version archives carry the full
history.
`;

fs.writeFileSync(SRC, preamble + newest.body + indexBlock, 'utf-8');
console.log(`Rewrote CHANGELOG.md (newest entry: ${newest.text} + index).`);
