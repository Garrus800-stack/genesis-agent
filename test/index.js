#!/usr/bin/env node
// ============================================================
// GENESIS — Test Runner v2 (v7)
// Runs both the legacy monolithic test suite AND new per-module
// test files. Compatible with Node 18+ (uses node:test if available).
//
// FIX v4.10.0 (M-2): Migrated from execSync to async execFile.
// - No longer blocks the main thread during test execution
// - Module tests run in parallel (up to CONCURRENCY limit)
// - Timeout handling is non-blocking
//
// Usage:
//   node test/index.js          — run all tests
//   node test/index.js --legacy — run only legacy suite
//   node test/index.js --new    — run only new test files
// ============================================================

const { execFile } = require('child_process');
const { promisify } = require('util');
const execFileAsync = promisify(execFile);
const path = require('path');
const fs = require('fs');

const args = process.argv.slice(2);
const runLegacy = !args.includes('--new');
const runNew = !args.includes('--legacy');
const CONCURRENCY = 4;

async function main() {
  const startTime = Date.now();

  console.log('');
  console.log('  Genesis · Test Suite');
  console.log('  ────────────────────────────────────────');

  let totalPassed = 0;
  let totalFailed = 0;

  // ── Core Suite (formerly "Legacy") ───────────────────────
  if (runLegacy) {
    console.log('');
    console.log('  ── core ────────────────────────────────');
    try {
      const { stdout } = await execFileAsync('node', ['test/run-tests.js'], {
        cwd: path.join(__dirname, '..'),
        encoding: 'utf-8',
        timeout: 120000,
      });
      console.log(stdout);
      const passMatch = stdout.match(/(\d+) passed/);
      const failMatch = stdout.match(/(\d+) failed/);
      if (passMatch) totalPassed += parseInt(passMatch[1]);
      if (failMatch) totalFailed += parseInt(failMatch[1]);
    } catch (err) {
      const output = err.stdout || err.stderr || err.message;
      // v5.1.0: Show full output so all failures are visible
      console.error('Legacy suite error:', output);
      const passMatch = output.match(/(\d+) passed/);
      const failMatch = output.match(/(\d+) failed/);
      if (passMatch) totalPassed += parseInt(passMatch[1]);
      totalFailed += (failMatch ? parseInt(failMatch[1]) : 1);
    }
  }

  // ── Module Suite (per-module test files) ─────────────────
  if (runNew) {
    console.log('');
    console.log('  ── modules ─────────────────────────────');
    const testDir = path.join(__dirname, 'modules');

    if (fs.existsSync(testDir)) {
      const testFiles = fs.readdirSync(testDir).filter(f => f.endsWith('.test.js'));

      // Run in batches of CONCURRENCY for parallelism without overwhelming the system
      for (let i = 0; i < testFiles.length; i += CONCURRENCY) {
        const batch = testFiles.slice(i, i + CONCURRENCY);
        const results = await Promise.allSettled(
          batch.map(async (file) => {
            const filePath = path.join(testDir, file);
            const moduleName = file.replace('.test.js', '');
            try {
              // These files use node:test (TAP output) and need --test-force-exit to avoid
              // hanging on open handles. Detected via require('node:test') usage.
              // --test-reporter=tap --test-reporter-destination=stdout forces TAP to stdout
              // on all platforms (Windows writes to stderr by default in some Node versions).
              const NODE_TEST_FILES = new Set([
                'architecture-reflection', 'boot-integration', 'cognitive-events',
                'cognitive-health-tracker', 'disclosure-policy', 'dynamic-tool-synthesis',
                'headless-boot', 'mcpserver', 'mcpservertoolbridge', 'organism-events',
                'project-intelligence', 'storage-write-queue',
                // v7.3.7: all v737-*.test.js files use node:test
                'v737-active-refs-port', 'v737-boot-complete-event',
                'v737-context-collector', 'v737-dream-phases', 'v737-episodic-memory',
                'v737-intent-and-hint', 'v737-journal-writer', 'v737-pending-moments',
                'v737-significance-and-coremem', 'v737-tools', 'v737-wakeup-routine',
                // v7.3.8: LLM-Failure-Honesty + Synchronous Source-Read
                'v738-llm-failure', 'v738-source-read-sync',
                // v7.3.9: Structure invariants
                'v739-structure',
                // v7.4.0: Im Jetzt — Runtime-State-Port
                'v740-runtime-state-port',
                // v7.4.0: Identity-Leak Regression (Qwen-Coder fix)
                'v740-identity-leak',
                // v7.4.0: Service Snapshot Whitelists (Session 2)
                'v740-service-snapshots',
                // v7.4.0: CI Sensitive-Data Gate (mandatory)
                'v740-sensitive-scan',
                // v7.4.0: PromptBuilder Runtime-State Integration
                'v740-promptbuilder-runtime',
              ]);
              const isNodeTest = NODE_TEST_FILES.has(moduleName);
              const nodeArgs = isNodeTest
                ? ['--test-reporter=tap', '--test-reporter-destination=stdout', '--test-force-exit', filePath]
                : [filePath];
              const { stdout, stderr: nodeStderr } = await execFileAsync('node', nodeArgs, {
                cwd: path.join(__dirname, '..'),
                encoding: 'utf-8',
                // v7.3.2: Raised from 30s to 90s — capability-honesty.test.js
                // performs full project scan + DI-manifest walk, runs ~40-80s
                // depending on filesystem speed. 30s caused flaky failures on
                // slower Linux containers while Windows passed consistently.
                timeout: 90000,
              });
              // On some platforms node:test may write TAP to stderr; merge both
              const combinedOut = stdout + (nodeStderr || '');
              return { moduleName, stdout: combinedOut, error: null };
            } catch (err) {
              const out = err.stdout || err.stderr || '';
              const hasContent = out.includes('TAP version') || out.includes(' passed') || out.includes(' failed') || out.includes('# pass');
              return { moduleName, stdout: out, error: hasContent ? null : (err.stderr || err.message) };
            }
          })
        );

        for (const result of results) {
          const { moduleName, stdout, error } = result.status === 'fulfilled' ? result.value : { moduleName: '?', stdout: '', error: result.reason?.message || 'Unknown error' };
          const passMatch = stdout.match(/(\d+) passed/);
          // node:test TAP summary uses "# pass N" format instead of "N passed"
          const tapSummaryPass = !passMatch ? stdout.match(/^# pass (\d+)/m) : null;
          // v7.3.2: Match "N failed" in all harness summary formats. We have
          // two output shapes in the codebase:
          //   old:  "13 passed, 1 failed"                    (comma separator)
          //   new:  "24 passed · 0 failed · 75 assertions"   (middle-dot, with more fields)
          // Plus the original "Results: N passed, N failed" prefix form.
          // The regex anchors to a leading indent + "N passed" + [,·] + "N failed"
          // to avoid matching log lines like "Health check 1/1 failed" elsewhere.
          // Multiline flag + ^\s* anchor ensures we only hit summary lines.
          const summaryFailMatch = stdout.match(/^\s*(?:Results:\s*)?\d+ passed\s*[,·]\s*(\d+)\s*failed/m);
          const tapSummaryFail = stdout.match(/^# fail (\d+)/m);
          // Fallback: standalone "N failed" at end-of-line (legacy format)
          const standaloneFailMatch = !summaryFailMatch && !tapSummaryFail
            ? stdout.match(/^\s*(\d+) failed\s*$/m) : null;
          const failMatch = summaryFailMatch || standaloneFailMatch || (error ? [null, '0'] : null);
          const tapPass = !passMatch && !tapSummaryPass && stdout.includes('TAP version') ? stdout.match(/^ok \d+/mg) : null;
          const tapFail = !passMatch && !tapSummaryFail && stdout.includes('TAP version') ? stdout.match(/^not ok \d+/mg) : null;
          const p = passMatch ? parseInt(passMatch[1]) : (tapSummaryPass ? parseInt(tapSummaryPass[1]) : (tapPass ? tapPass.length : 0));
          const f = failMatch ? parseInt(failMatch[1]) : (tapSummaryFail ? parseInt(tapSummaryFail[1]) : (tapFail ? tapFail.length : 0));
          totalPassed += p;

          if (error && p === 0) {
            totalFailed++;
            console.log(`  ${moduleName}... ❌ Error: ${error.slice(0, 200)}`);
          } else if (f > 0) {
            totalFailed += f;
            console.log(`  ${moduleName}... ❌ ${p} passed, ${f} failed`);
            // Show failure details so we can diagnose platform-specific issues
            const failLines = stdout.split('\n').filter(l => l.includes('❌') || l.includes('not ok') || l.includes('AssertionError') || l.includes('FAIL:'));
            for (const fl of failLines.slice(0, 5)) {
              console.log(`    ${fl.trim()}`);
            }
          } else {
            console.log(`  ${moduleName}... ✅ ${p} passed`);
          }
        }
      }
    } else {
      console.log('  (no module tests yet — create test/modules/*.test.js)');
    }
  }

  // ── Summary ──────────────────────────────────────────────
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  const status = totalFailed > 0 ? '❌' : '✓';
  console.log('');
  console.log('  ────────────────────────────────────────');
  console.log(`  ${status} ${totalPassed} passed · ${totalFailed} failed · ${elapsed}s`);
  console.log('');

  process.exit(totalFailed > 0 ? 1 : 0);
}

main().catch(err => {
  console.error('Test runner failed:', err);
  process.exit(1);
});
