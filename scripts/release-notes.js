#!/usr/bin/env node
// ============================================================
// GENESIS — scripts/release-notes.js (v5.9.2)
//
// Extracts the latest version's changelog entry for use
// as GitHub Release notes.
//
// Usage:
//   node scripts/release-notes.js          → stdout
//   node scripts/release-notes.js --copy   → clipboard (pbcopy/xclip)
//   node scripts/release-notes.js --file   → writes RELEASE_NOTES.md
//   node scripts/release-notes.js 5.9.1    → specific version
// ============================================================

'use strict';

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const CHANGELOG = path.join(__dirname, '..', 'CHANGELOG.md');
const args = process.argv.slice(2);
const toClipboard = args.includes('--copy');
const toFile = args.includes('--file');
const targetVersion = args.find(a => /^\d+\.\d+\.\d+/.test(a));

// Parse CHANGELOG
const content = fs.readFileSync(CHANGELOG, 'utf8');
const sections = content.split(/^## /m).slice(1); // Split by ## headers

let section = null;

if (targetVersion) {
  section = sections.find(s => s.startsWith(`[${targetVersion}]`));
} else {
  section = sections[0]; // Latest
}

if (!section) {
  console.error(`[RELEASE] Version ${targetVersion || 'latest'} not found in CHANGELOG.md`);
  process.exit(1);
}

// Extract version and title
const titleMatch = section.match(/^\[([^\]]+)\]\s*—?\s*(.*)/);
const version = titleMatch ? titleMatch[1] : 'unknown';
const title = titleMatch ? titleMatch[2].trim() : '';

// Build release notes
const body = section.replace(/^\[.*\n/, '').trim();

const releaseNotes = `# Genesis Agent v${version}${title ? ' — ' + title : ''}

${body}

---

**Full Changelog**: See [CHANGELOG.md](https://github.com/Garrus800-stack/genesis-agent/blob/main/CHANGELOG.md)

**Installation**:
\`\`\`bash
git clone https://github.com/Garrus800-stack/genesis-agent.git
cd genesis-agent
npm install
npm start        # Electron desktop
node cli.js      # Headless CLI
\`\`\`
`;

// Output
if (toFile) {
  const outPath = path.join(__dirname, '..', 'RELEASE_NOTES.md');
  fs.writeFileSync(outPath, releaseNotes, 'utf8');
  console.log(`[RELEASE] Written to ${outPath}`);
} else if (toClipboard) {
  try {
    if (process.platform === 'darwin') {
      execSync('pbcopy', { input: releaseNotes });
    } else if (process.platform === 'linux') {
      execSync('xclip -selection clipboard', { input: releaseNotes });
    } else {
      execSync('clip', { input: releaseNotes });
    }
    console.log(`[RELEASE] v${version} release notes copied to clipboard`);
  } catch (_e) {
    console.log(releaseNotes);
    console.error('[RELEASE] Clipboard not available — printed to stdout');
  }
} else {
  console.log(releaseNotes);
}
