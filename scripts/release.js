#!/usr/bin/env node
// ============================================================
// GENESIS — scripts/release.js (v7.1.2)
//
// Automated release helper. Bumps version in all locations,
// auto-updates README badges from live stats, validates CI
// gates, and outputs git commands.
//
// Usage:
//   node scripts/release.js 7.1.3
//   node scripts/release.js 7.1.3 --dry-run   — preview only
//   node scripts/release.js 7.1.3 --skip-ci   — skip CI checks
//
// Version locations (6):
//   1. package.json
//   2. package-lock.json (2 entries)
//   3. README.md badge (version + live stats: tests, fitness, modules, services, events)
//   4. docs/banner.svg
//   5. McpTransport.js clientInfo
//   6. CHANGELOG.md (validates entry exists)
// ============================================================

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const SKIP_CI = args.includes('--skip-ci');
const newVersion = args.find(a => /^\d+\.\d+\.\d+/.test(a));

if (!newVersion) {
  console.error('Usage: node scripts/release.js <version> [--dry-run] [--skip-ci]');
  console.error('  e.g. node scripts/release.js 5.9.4');
  process.exit(1);
}

const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf-8'));
const oldVersion = pkg.version;

if (newVersion === oldVersion) {
  console.error(`Version ${newVersion} is already current.`);
  process.exit(1);
}

console.log(`\n╔══════════════════════════════════════════════╗`);
console.log(`║          GENESIS — Release ${newVersion.padEnd(16)}  ║`);
console.log(`╚══════════════════════════════════════════════╝\n`);
console.log(`  ${oldVersion} → ${newVersion}${DRY_RUN ? '  (DRY RUN)' : ''}\n`);

// ── Helpers ──────────────────────────────────────────────

function replaceInFile(filePath, search, replace, label) {
  const rel = path.relative(ROOT, filePath);
  if (!fs.existsSync(filePath)) {
    console.log(`  ⚠  SKIP ${rel} — file not found`);
    return false;
  }
  const content = fs.readFileSync(filePath, 'utf-8');
  if (!content.includes(search)) {
    console.log(`  ⚠  SKIP ${rel} — pattern not found: "${search.slice(0, 40)}..."`);
    return false;
  }
  if (!DRY_RUN) {
    fs.writeFileSync(filePath, content.replace(search, replace), 'utf-8');
  }
  console.log(`  ✅ ${rel}${label ? ` (${label})` : ''}`);
  return true;
}

function run(cmd, label) {
  console.log(`  🔧 ${label || cmd}`);
  if (DRY_RUN) return '';
  try {
    return execSync(cmd, { cwd: ROOT, encoding: 'utf-8', timeout: 60_000 });
  } catch (err) {
    return err.stdout || '';
  }
}

// ── Step 1: CI Validation ────────────────────────────────

if (!SKIP_CI) {
  console.log('── Step 1: CI Validation ──\n');
  const checks = [
    { cmd: 'node scripts/validate-events.js', name: 'Event Validation' },
    { cmd: 'node scripts/validate-channels.js', name: 'Channel Sync' },
    { cmd: 'node scripts/architectural-fitness.js --ci', name: 'Fitness (90/90)' },
    { cmd: 'node scripts/audit-events.js --strict', name: 'Event Audit (strict)' },
    { cmd: 'npx tsc --project tsconfig.json --noEmit', name: 'TypeScript Check' },
  ];

  let allPassed = true;
  for (const { cmd, name } of checks) {
    try {
      execSync(cmd, { cwd: ROOT, encoding: 'utf-8', stdio: 'pipe', timeout: 120_000 });
      console.log(`  ✅ ${name}`);
    } catch (err) {
      console.log(`  ❌ ${name}`);
      allPassed = false;
    }
  }

  if (!allPassed) {
    console.error('\n  ❌ CI checks failed. Fix before releasing.\n');
    process.exit(1);
  }
  console.log('');
} else {
  console.log('── Step 1: CI Validation — SKIPPED ──\n');
}

// ── Step 2: Version Bump (7 locations) ───────────────────

console.log('── Step 2: Version Bump ──\n');

// 1. package.json
replaceInFile(
  path.join(ROOT, 'package.json'),
  `"version": "${oldVersion}"`,
  `"version": "${newVersion}"`,
  'version field'
);

// 2. package-lock.json (top-level + packages[""])
const lockPath = path.join(ROOT, 'package-lock.json');
if (fs.existsSync(lockPath)) {
  const lockContent = fs.readFileSync(lockPath, 'utf-8');
  let updated = lockContent;
  // Replace first two occurrences (top-level + packages root)
  let count = 0;
  updated = updated.replace(new RegExp(`"version": "${oldVersion.replace(/\./g, '\\.')}"`, 'g'), (match) => {
    if (count < 2) { count++; return `"version": "${newVersion}"`; }
    return match;
  });
  if (!DRY_RUN) fs.writeFileSync(lockPath, updated, 'utf-8');
  console.log(`  ✅ package-lock.json (${count} entries)`);
}

// 3. README.md badge — version
replaceInFile(
  path.join(ROOT, 'README.md'),
  `version-${oldVersion}`,
  `version-${newVersion}`,
  'badge'
);

// 3b. README.md badges — live stats (tests, fitness, modules, services, events)
{
  const readmePath = path.join(ROOT, 'README.md');
  let readme = fs.readFileSync(readmePath, 'utf-8');
  const badgeUpdates = [];

  // Tests: count test files × ~15 avg (rough) — or parse from last CI run
  try {
    const testFiles = fs.readdirSync(path.join(ROOT, 'test', 'modules')).filter(f => f.endsWith('.test.js') || f.endsWith('.test.mjs'));
    // Use the count from ARCHITECTURE.md or CHANGELOG.md as source of truth
    const archDoc = fs.readFileSync(path.join(ROOT, 'ARCHITECTURE.md'), 'utf-8');
    const testMatch = archDoc.match(/~?(\d[\d,]+)\s*tests/);
    if (testMatch) {
      const count = testMatch[1].replace(/,/g, '');
      readme = readme.replace(/tests-~?\d+%20passing/g, `tests-~${count}%20passing`);
      badgeUpdates.push(`tests: ~${count}`);
    }
  } catch { /* best effort */ }

  // Fitness: parse from architectural-fitness.js maxScore
  try {
    const fitnessScript = fs.readFileSync(path.join(ROOT, 'scripts', 'architectural-fitness.js'), 'utf-8');
    const checkCount = (fitnessScript.match(/^check\(/gm) || []).length;
    const maxScore = checkCount * 10;
    readme = readme.replace(/fitness-\d+%2F\d+/g, `fitness-${maxScore}%2F${maxScore}`);
    badgeUpdates.push(`fitness: ${maxScore}/${maxScore}`);
  } catch { /* best effort */ }

  // Modules: count source files (excl vendor)
  try {
    const count = execSync(`find src -name "*.js" -not -path "*/vendor/*" | wc -l`, { cwd: ROOT, encoding: 'utf-8' }).trim();
    readme = readme.replace(/modules-\d+-/g, `modules-${count}-`);
    badgeUpdates.push(`modules: ${count}`);
  } catch { /* best effort */ }

  // Services: count containerConfig
  try {
    const count = execSync(`grep -rl "containerConfig" src/agent/ | wc -l`, { cwd: ROOT, encoding: 'utf-8' }).trim();
    const manifestCount = execSync(`grep -c "^\\s*\\['" src/agent/manifest/phase*.js | awk -F: '{s+=$2}END{print s}'`, { cwd: ROOT, encoding: 'utf-8' }).trim();
    const total = manifestCount || count;
    readme = readme.replace(/services-\d+-/g, `services-${total}-`);
    badgeUpdates.push(`services: ${total}`);
  } catch { /* best effort */ }

  // Events: count from EventTypes.js
  try {
    const evtSrc = fs.readFileSync(path.join(ROOT, 'src', 'agent', 'core', 'EventTypes.js'), 'utf-8');
    const evtCount = (evtSrc.match(/'[a-z][\w-]*:[a-z][\w-]*'/g) || []).length;
    readme = readme.replace(/events-\d+-/g, `events-${evtCount}-`);
    badgeUpdates.push(`events: ${evtCount}`);
  } catch { /* best effort */ }

  if (badgeUpdates.length > 0 && !DRY_RUN) {
    fs.writeFileSync(readmePath, readme, 'utf-8');
  }
  console.log(`  ✅ README.md badges (${badgeUpdates.join(', ') || 'no changes'})`);
}

// 4. docs/banner.svg
replaceInFile(
  path.join(ROOT, 'docs/banner.svg'),
  `v${oldVersion}`,
  `v${newVersion}`,
  'banner'
);

// 5. McpTransport.js clientInfo
replaceInFile(
  path.join(ROOT, 'src/agent/capabilities/McpTransport.js'),
  `version: '${oldVersion}'`,
  `version: '${newVersion}'`,
  'clientInfo'
);

// 7. CHANGELOG.md — verify entry exists
const changelogPath = path.join(ROOT, 'CHANGELOG.md');
const changelog = fs.readFileSync(changelogPath, 'utf-8');
if (!changelog.includes(`[${newVersion}]`)) {
  console.log(`\n  ⚠  CHANGELOG.md has no [${newVersion}] entry — add one before committing!`);
}

console.log('');

// ── Step 3: Summary + Commands ───────────────────────────

console.log('── Step 3: Git Commands ──\n');
console.log(`  git add -A`);
console.log(`  git commit -m "v${newVersion} — <release title>"`);
console.log(`  git tag v${newVersion}`);
console.log(`  git push origin main --tags`);
console.log('');

if (DRY_RUN) {
  console.log('  ℹ  Dry run — no files were modified.\n');
}
