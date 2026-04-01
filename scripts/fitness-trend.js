#!/usr/bin/env node
// ============================================================
// GENESIS — fitness-trend.js (v5.3.0)
//
// Saves architectural fitness scores per commit to detect drift.
// Run after architectural-fitness.js in CI or manually.
//
// Usage:
//   node scripts/fitness-trend.js              — save + show diff
//   node scripts/fitness-trend.js --show       — show trend only
//   node scripts/fitness-trend.js --ci         — exit 1 on regression
//   node scripts/fitness-trend.js --threshold 3 — regression = 3+ point drop
//
// Output: .fitness-history/<YYYY-MM-DD>_<commit-hash>.json
// Each file contains the full fitness report + metadata.
//
// DRIFT DETECTION:
//   Compares current score to the previous entry.
//   A regression of --threshold points (default: 2) flags a warning.
//   In --ci mode, regressions exit 1 to fail the build.
// ============================================================

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const HISTORY_DIR = path.join(ROOT, '.fitness-history');
const CI_MODE = process.argv.includes('--ci');
const SHOW_ONLY = process.argv.includes('--show');

// Parse --threshold N
const thresholdIdx = process.argv.indexOf('--threshold');
const THRESHOLD = thresholdIdx >= 0 ? parseInt(process.argv[thresholdIdx + 1], 10) || 2 : 2;

// ── Utilities ──────────────────────────────────────────────

function getGitInfo() {
  try {
    const hash = execSync('git rev-parse --short HEAD', { cwd: ROOT, encoding: 'utf-8' }).trim();
    const branch = execSync('git rev-parse --abbrev-ref HEAD', { cwd: ROOT, encoding: 'utf-8' }).trim();
    const dirty = execSync('git status --porcelain', { cwd: ROOT, encoding: 'utf-8' }).trim().length > 0;
    const message = execSync('git log -1 --pretty=%s', { cwd: ROOT, encoding: 'utf-8' }).trim();
    return { hash, branch, dirty, message };
  } catch (_e) {
    return { hash: 'unknown', branch: 'unknown', dirty: true, message: '' };
  }
}

function loadPreviousEntries() {
  if (!fs.existsSync(HISTORY_DIR)) return [];
  const files = fs.readdirSync(HISTORY_DIR)
    .filter(f => f.endsWith('.json'))
    .sort(); // Lexicographic sort = chronological (YYYY-MM-DD prefix)
  return files.map(f => {
    try {
      return JSON.parse(fs.readFileSync(path.join(HISTORY_DIR, f), 'utf-8'));
    } catch (_e) { return null; }
  }).filter(Boolean);
}

function runFitnessCheck() {
  try {
    const output = execSync('node scripts/architectural-fitness.js --json', {
      cwd: ROOT,
      encoding: 'utf-8',
      timeout: 60000,
    });
    return JSON.parse(output);
  } catch (err) {
    console.error('Failed to run architectural-fitness.js:', err.message);
    process.exit(1);
  }
}

function formatPercent(score, maxScore) {
  return maxScore > 0 ? Math.round((score / maxScore) * 100) : 0;
}

// ── Trend Display ──────────────────────────────────────────

function showTrend(entries) {
  if (entries.length === 0) {
    console.log('\n  No fitness history yet. Run without --show to save first entry.\n');
    return;
  }

  console.log('\n  ┌──────────────────────────────────────────────────────────┐');
  console.log('  │  Genesis — Architectural Fitness Trend                   │');
  console.log('  ├──────────┬───────┬───────────┬──────────────────────────┤');
  console.log('  │   Date   │ Score │   Delta   │ Commit                   │');
  console.log('  ├──────────┼───────┼───────────┼──────────────────────────┤');

  let prev = null;
  for (const entry of entries.slice(-20)) {
    const date = entry.date || 'unknown';
    const pct = formatPercent(entry.score, entry.maxScore);
    const hash = (entry.git?.hash || '???????').slice(0, 7);
    const msg = (entry.git?.message || '').slice(0, 22);

    let delta = '   —   ';
    if (prev !== null) {
      const diff = pct - prev;
      if (diff > 0) delta = `  +${diff}%  `;
      else if (diff < 0) delta = `  ${diff}%  `;
      else delta = '   =   ';
    }

    const scoreStr = `${pct}%`.padStart(4);
    console.log(`  │ ${date} │ ${scoreStr}  │${delta}│ ${hash} ${msg.padEnd(18)}│`);
    prev = pct;
  }

  console.log('  └──────────┴───────┴───────────┴──────────────────────────┘\n');
}

// ── Main ───────────────────────────────────────────────────

function main() {
  const entries = loadPreviousEntries();

  if (SHOW_ONLY) {
    showTrend(entries);
    return;
  }

  // Run fitness check
  const report = runFitnessCheck();
  const git = getGitInfo();
  const date = new Date().toISOString().split('T')[0];

  const entry = {
    date,
    timestamp: new Date().toISOString(),
    version: report.version,
    score: report.score,
    maxScore: report.maxScore,
    percentage: formatPercent(report.score, report.maxScore),
    git,
    checks: report.checks.map(c => ({
      name: c.name,
      status: c.status,
      score: c.score,
      maxScore: c.maxScore,
      detailCount: c.details?.length || 0,
    })),
  };

  // Save to history
  if (!fs.existsSync(HISTORY_DIR)) fs.mkdirSync(HISTORY_DIR, { recursive: true });
  const filename = `${date}_${git.hash}.json`;
  const filepath = path.join(HISTORY_DIR, filename);

  // Avoid duplicate entries for same commit
  if (!fs.existsSync(filepath)) {
    fs.writeFileSync(filepath, JSON.stringify(entry, null, 2));
    console.log(`  ✓ Saved: ${filename}`);
  } else {
    console.log(`  ○ Already exists: ${filename}`);
  }

  // Show trend
  const allEntries = [...entries, entry];
  showTrend(allEntries);

  // Detect regression
  if (entries.length > 0) {
    const prevEntry = entries[entries.length - 1];
    const prevPct = formatPercent(prevEntry.score, prevEntry.maxScore);
    const currPct = entry.percentage;
    const diff = currPct - prevPct;

    if (diff < -THRESHOLD) {
      const msg = `  ⚠ REGRESSION: ${prevPct}% → ${currPct}% (${diff} points, threshold: -${THRESHOLD})`;
      console.log(msg);

      // Find which checks regressed
      if (prevEntry.checks && entry.checks) {
        for (const curr of entry.checks) {
          const prev = prevEntry.checks.find(p => p.name === curr.name);
          if (prev && curr.score < prev.score) {
            console.log(`    ↓ ${curr.name}: ${prev.score}/${prev.maxScore} → ${curr.score}/${curr.maxScore}`);
          }
        }
      }

      if (CI_MODE) {
        console.log('\n  CI mode: Failing build due to fitness regression.\n');
        process.exit(1);
      }
    } else if (diff > 0) {
      console.log(`  ✓ Improvement: +${diff} points (${prevPct}% → ${currPct}%)`);
    } else {
      console.log(`  ○ Stable: ${currPct}%`);
    }
  }

  // Gitignore hint
  const gitignore = path.join(ROOT, '.gitignore');
  if (fs.existsSync(gitignore)) {
    const content = fs.readFileSync(gitignore, 'utf-8');
    if (!content.includes('.fitness-history')) {
      console.log('\n  💡 Tip: Add .fitness-history/ to .gitignore if you don\'t want to track history in git.');
      console.log('  Or KEEP it tracked to share fitness trends across the team.\n');
    }
  }
}

main();
