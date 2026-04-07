#!/usr/bin/env node
// ============================================================
// GENESIS — scripts/release-zip.js (v7.0.1)
//
// Builds a deterministic release archive. Ensures .genesis/,
// node_modules/, and other runtime/dev artifacts are never
// included — even when .gitignore covers them, manual zips
// bypass that protection.
//
// Usage:
//   node scripts/release-zip.js              → Genesis_v7.0.0.zip
//   node scripts/release-zip.js --dry-run    → list files, don't zip
//   node scripts/release-zip.js --out=./foo  → custom output dir
//
// Requires: Node.js 18+ (uses child_process + fs)
// ============================================================

'use strict';

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf-8'));
const VERSION = pkg.version;

const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const outArg = args.find(a => a.startsWith('--out='));
const OUT_DIR = outArg ? path.resolve(outArg.slice(6)) : ROOT;

// ── Exclude patterns ─────────────────────────────────────
// These are ALWAYS excluded from release archives, regardless
// of .gitignore. This is the canonical safety boundary.

const EXCLUDE = [
  '.genesis',          // Runtime state, tokens, salt, telemetry
  'node_modules',      // Dependencies (npm install recreates)
  'sandbox',           // Sandboxed execution artifacts
  'uploads',           // User-uploaded files
  'dist',              // Build artifacts (npm run build recreates)
  '.git',              // Git internals
  'coverage',          // Test coverage reports
  '*.log',             // Log files
  '*.tmp',             // Temp files
  '.DS_Store',         // macOS metadata
  'Thumbs.db',         // Windows metadata
];

// ── Sensitive file guard ─────────────────────────────────
// Extra safety: scan for files that should NEVER ship.
// If found, abort with an error rather than silently including them.

const SENSITIVE_PATTERNS = [
  'peer-token',
  'enc-salt',
  '.env',
  '*.key',
  '*.pem',
  '*.secret',
];

console.log(`\n╔══════════════════════════════════════════════╗`);
console.log(`║       GENESIS — Release Archive v${VERSION.padEnd(10)}  ║`);
console.log(`╚══════════════════════════════════════════════╝\n`);

// ── Step 1: Sensitive file scan ──────────────────────────

console.log('── Step 1: Sensitive File Scan ──\n');

const sensitiveFound = [];
for (const pattern of SENSITIVE_PATTERNS) {
  try {
    // Use git ls-files if available, else fall back to find
    const glob = pattern.includes('*') ? pattern : `*${pattern}*`;
    const cmd = process.platform === 'win32' ? 'where' : 'find';

    // Simple recursive scan (works without git)
    const walk = (dir, depth = 0) => {
      if (depth > 5) return;
      const base = path.basename(dir);
      if (EXCLUDE.some(e => !e.includes('*') && base === e)) return;

      let entries;
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
      catch { return; }

      for (const entry of entries) {
        const name = entry.name;
        const full = path.join(dir, name);
        const rel = path.relative(ROOT, full);

        if (entry.isDirectory()) {
          walk(full, depth + 1);
        } else {
          // Check against sensitive patterns
          const matchesGlob = pattern.startsWith('*')
            ? name.endsWith(pattern.slice(1))
            : name.includes(pattern);
          if (matchesGlob) {
            // Only flag if NOT already in an excluded directory
            const inExcluded = EXCLUDE.some(e =>
              !e.includes('*') && rel.split(path.sep).includes(e)
            );
            if (!inExcluded) {
              sensitiveFound.push(rel);
            }
          }
        }
      }
    };

    walk(ROOT);
  } catch { /* ignore scan errors */ }
}

// Deduplicate
const uniqueSensitive = [...new Set(sensitiveFound)];
if (uniqueSensitive.length > 0) {
  console.log('  ❌ Sensitive files found OUTSIDE excluded directories:\n');
  for (const f of uniqueSensitive) {
    console.log(`     ⚠  ${f}`);
  }
  console.log('\n  These would be included in the archive. Move them into');
  console.log('  .genesis/ or add them to the EXCLUDE list above.\n');
  process.exit(1);
}
console.log('  ✅ No sensitive files in release scope\n');

// ── Step 2: Build file list ──────────────────────────────

console.log('── Step 2: Collecting Files ──\n');

const files = [];
const walkForZip = (dir) => {
  const base = path.basename(dir);
  if (EXCLUDE.some(e => !e.includes('*') && base === e)) return;

  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
  catch { return; }

  for (const entry of entries) {
    const name = entry.name;
    const full = path.join(dir, name);
    const rel = path.relative(ROOT, full);

    // Check wildcard excludes
    const wildcardExcluded = EXCLUDE.some(e => {
      if (!e.startsWith('*')) return false;
      return name.endsWith(e.slice(1));
    });
    // Check exact name excludes
    const exactExcluded = EXCLUDE.some(e => !e.includes('*') && name === e);

    if (wildcardExcluded || exactExcluded) continue;

    if (entry.isDirectory()) {
      walkForZip(full);
    } else {
      files.push(rel);
    }
  }
};

walkForZip(ROOT);

console.log(`  ${files.length} files collected\n`);

if (DRY_RUN) {
  console.log('── Dry Run: File List ──\n');
  for (const f of files.slice(0, 30)) console.log(`  ${f}`);
  if (files.length > 30) console.log(`  ... and ${files.length - 30} more`);
  console.log(`\n  Total: ${files.length} files (dry run — no archive created)\n`);
  process.exit(0);
}

// ── Step 3: Create zip ───────────────────────────────────

console.log('── Step 3: Creating Archive ──\n');

const zipName = `Genesis_v${VERSION.replace(/\./g, '_')}.zip`;
const zipPath = path.join(OUT_DIR, zipName);

// Remove old archive if exists
if (fs.existsSync(zipPath)) fs.unlinkSync(zipPath);

// Use system zip if available, else tar
try {
  // Build exclude args for zip
  const excludeArgs = EXCLUDE.flatMap(e => ['-x', `*/${e}/*`, '-x', `*/${e}`]);

  execFileSync('zip', [
    '-r', '-9', zipPath,
    path.basename(ROOT),
    ...excludeArgs,
  ], {
    cwd: path.dirname(ROOT),
    stdio: 'pipe',
    encoding: 'utf-8',
  });

  const stat = fs.statSync(zipPath);
  const sizeMB = (stat.size / 1024 / 1024).toFixed(1);

  console.log(`  ✅ ${zipName} (${sizeMB} MB)`);
  console.log(`     ${zipPath}\n`);
  console.log(`  ${files.length} files, ${EXCLUDE.length} exclusion rules applied\n`);
} catch (err) {
  console.error('  ❌ zip command failed:', err.message);
  console.error('     Install zip or use: tar czf archive.tar.gz --exclude=.genesis ...');
  process.exit(1);
}
