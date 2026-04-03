#!/usr/bin/env node
// ============================================================
// GENESIS — scripts/benchmark-agent.js (v5.9.8 — V6-9)
//
// Standardized benchmarks to measure agent capability across
// versions and backends. Runs a predefined task suite and
// measures success rate, token consumption, latency, and cost.
//
// Usage:
//   node scripts/benchmark-agent.js                — full suite
//   node scripts/benchmark-agent.js --quick        — quick subset (3 tasks)
//   node scripts/benchmark-agent.js --backend ollama — specific backend
//   node scripts/benchmark-agent.js --baseline save — save as baseline
//   node scripts/benchmark-agent.js --baseline compare — compare vs saved
//   node scripts/benchmark-agent.js --json         — JSON output
//
// Output: Per-task results + aggregate scores + regression flags
// ============================================================

'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const BASELINE_PATH = path.join(ROOT, '.genesis', 'benchmark-baseline.json');
const RESULTS_PATH = path.join(ROOT, '.genesis', 'benchmark-latest.json');

// ── Benchmark Task Definitions ──────────────────────────────
// Each task: { id, type, title, input, verify(output) → { pass, detail } }

const TASKS = [
  {
    id: 'cg-1',
    type: 'code-gen',
    title: 'Generate a fizzbuzz function',
    input: 'Write a JavaScript function fizzbuzz(n) that returns an array of strings from 1 to n with fizz/buzz/fizzbuzz substitutions.',
    verify(output) {
      const hasFn = /function\s+fizzbuzz|const\s+fizzbuzz|fizzbuzz\s*=/.test(output);
      const hasFizz = /fizz/i.test(output);
      const hasBuzz = /buzz/i.test(output);
      const hasReturn = /return/.test(output);
      const pass = hasFn && hasFizz && hasBuzz && hasReturn;
      return { pass, detail: pass ? 'Valid fizzbuzz implementation' : `Missing: ${!hasFn ? 'function ' : ''}${!hasReturn ? 'return ' : ''}` };
    },
  },
  {
    id: 'cg-2',
    type: 'code-gen',
    title: 'Generate a binary search function',
    input: 'Write a JavaScript function binarySearch(arr, target) that returns the index of target in sorted array arr, or -1 if not found.',
    verify(output) {
      const hasFn = /function\s+binarySearch|const\s+binarySearch|binarySearch\s*=/.test(output);
      const hasMid = /mid|middle|center/i.test(output);
      const hasLoop = /while|for|recursi/i.test(output);
      const pass = hasFn && hasMid && hasLoop;
      return { pass, detail: pass ? 'Valid binary search' : 'Missing key elements' };
    },
  },
  {
    id: 'cg-3',
    type: 'code-gen',
    title: 'Generate an Express REST endpoint',
    input: 'Write a Node.js Express route handler for GET /api/users/:id that validates the id param is numeric and returns a JSON user object.',
    verify(output) {
      const hasRoute = /app\.(get|route)|router\.(get|route)/.test(output);
      const hasParam = /params|req\.params/.test(output);
      const hasJson = /res\.json|res\.send/.test(output);
      const hasValidation = /isNaN|parseInt|Number|\.match|regex|\d/.test(output);
      const pass = hasRoute && hasParam && hasJson;
      return { pass, detail: pass ? 'Valid REST endpoint' : 'Missing route/param/response elements' };
    },
  },
  {
    id: 'bf-1',
    type: 'bug-fix',
    title: 'Fix off-by-one error',
    input: 'Fix this function that should return elements at even indices:\nfunction evens(arr) {\n  const result = [];\n  for (let i = 1; i <= arr.length; i += 2) {\n    result.push(arr[i]);\n  }\n  return result;\n}\n// Expected: evens([10,20,30,40,50]) → [10,30,50]',
    verify(output) {
      const hasZeroStart = /i\s*=\s*0/.test(output);
      const hasLessThan = /i\s*<\s*arr\.length/.test(output);
      const pass = hasZeroStart || /i\s*=\s*0.*i\s*</.test(output);
      return { pass, detail: pass ? 'Fixed off-by-one' : 'Off-by-one not corrected' };
    },
  },
  {
    id: 'bf-2',
    type: 'bug-fix',
    title: 'Fix async/await bug',
    input: 'Fix this function — it returns undefined instead of the fetched data:\nasync function getData(url) {\n  fetch(url).then(r => r.json()).then(data => { return data; });\n}',
    verify(output) {
      const hasAwait = /await\s+fetch/.test(output);
      const hasReturn = /return\s+(await\s+)?fetch|return\s+data|return\s+r/.test(output);
      const pass = hasAwait || hasReturn;
      return { pass, detail: pass ? 'Fixed async flow' : 'Async not corrected' };
    },
  },
  {
    id: 'rf-1',
    type: 'refactoring',
    title: 'Extract helper from god function',
    input: 'Refactor this 40-line function into smaller helpers:\nfunction processOrder(order) {\n  // validate\n  if (!order.items) throw new Error("no items");\n  if (!order.customer) throw new Error("no customer");\n  // calculate total\n  let total = 0;\n  for (const item of order.items) { total += item.price * item.qty; }\n  // apply discount\n  if (order.coupon === "SAVE10") total *= 0.9;\n  if (order.customer.vip) total *= 0.95;\n  // format\n  return { orderId: Date.now(), total: total.toFixed(2), customer: order.customer.name };\n}',
    verify(output) {
      const fnCount = (output.match(/function\s+\w+|const\s+\w+\s*=\s*(\(|function)/g) || []).length;
      const pass = fnCount >= 3; // At least 3 functions (original + 2 extracted)
      return { pass, detail: pass ? `${fnCount} functions extracted` : `Only ${fnCount} function(s) — need ≥3` };
    },
  },
  {
    id: 'an-1',
    type: 'analysis',
    title: 'Identify code smells',
    input: 'Analyze this code and list code smells:\nclass UserManager {\n  constructor() { this.db = require("./db"); this.mailer = require("./mailer"); this.logger = require("./logger"); this.cache = {}; }\n  getUser(id) { if (this.cache[id]) return this.cache[id]; const u = this.db.query("SELECT * FROM users WHERE id=" + id); this.cache[id] = u; return u; }\n  sendEmail(id, msg) { const u = this.getUser(id); this.mailer.send(u.email, msg); this.logger.log("sent to " + id); }\n  deleteUser(id) { this.db.query("DELETE FROM users WHERE id=" + id); delete this.cache[id]; this.mailer.send("admin@co.com", "deleted " + id); }\n}',
    verify(output) {
      const lower = output.toLowerCase();
      const hasInjection = /injection|concatenat|sql/i.test(lower);
      const hasSRP = /single.?responsibility|srp|too.?many|god.?class|coupling/i.test(lower);
      const hasCaching = /cache|stale|invalidat/i.test(lower);
      const smellCount = [hasInjection, hasSRP, hasCaching].filter(Boolean).length;
      const pass = smellCount >= 2;
      return { pass, detail: `${smellCount}/3 smell categories identified` };
    },
  },
  {
    id: 'ch-1',
    type: 'chat',
    title: 'Explain event loop',
    input: 'Explain how the Node.js event loop works in 3-4 sentences.',
    verify(output) {
      const lower = output.toLowerCase();
      const hasLoop = /event.?loop|loop/i.test(lower);
      const hasAsync = /async|callback|promise|non.?blocking/i.test(lower);
      const hasQueue = /queue|stack|phase|tick/i.test(lower);
      const reasonable = output.length > 100 && output.length < 2000;
      const pass = hasLoop && hasAsync && reasonable;
      return { pass, detail: pass ? 'Clear event loop explanation' : 'Missing key concepts' };
    },
  },
];

// ── Runner ──────────────────────────────────────────────────

function runBenchmark(opts = {}) {
  const tasks = opts.quick ? TASKS.slice(0, 3) : TASKS;
  const results = [];
  const startAll = Date.now();

  console.log('\n╔══════════════════════════════════════════════╗');
  console.log('║        GENESIS — Agent Benchmark Suite        ║');
  console.log('╚══════════════════════════════════════════════╝\n');
  console.log(`  Tasks: ${tasks.length}  |  Backend: ${opts.backend || 'default'}  |  Mode: ${opts.quick ? 'quick' : 'full'}\n`);

  for (const task of tasks) {
    const start = Date.now();
    let output = '';
    let success = false;
    let error = null;
    let tokenEstimate = 0;

    try {
      // Execute via CLI headless mode
      const args = ['cli.js', '--once', '--no-boot-log', task.input];
      if (opts.backend) args.push('--backend', opts.backend);

      output = execFileSync('node', args, {
        cwd: ROOT,
        timeout: 60_000,
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      });

      tokenEstimate = Math.ceil(output.length / 3.5);
      const verification = task.verify(output);
      success = verification.pass;
      error = success ? null : verification.detail;

      const icon = success ? '✅' : '❌';
      const dur = Date.now() - start;
      console.log(`  ${icon} ${task.id} ${task.title} (${dur}ms, ~${tokenEstimate} tok) ${error || ''}`);
    } catch (e) {
      error = e.message.slice(0, 100);
      const dur = Date.now() - start;
      console.log(`  ❌ ${task.id} ${task.title} (${dur}ms) ERROR: ${error}`);
    }

    results.push({
      id: task.id,
      type: task.type,
      title: task.title,
      success,
      durationMs: Date.now() - start,
      tokenEstimate,
      error,
    });
  }

  const totalMs = Date.now() - startAll;
  const passed = results.filter(r => r.success).length;
  const rate = tasks.length > 0 ? Math.round(passed / tasks.length * 100) : 0;
  const avgDuration = tasks.length > 0 ? Math.round(results.reduce((s, r) => s + r.durationMs, 0) / tasks.length) : 0;
  const totalTokens = results.reduce((s, r) => s + r.tokenEstimate, 0);

  const summary = {
    version: require(path.join(ROOT, 'package.json')).version,
    timestamp: new Date().toISOString(),
    backend: opts.backend || 'default',
    tasks: tasks.length,
    passed,
    failed: tasks.length - passed,
    successRate: rate,
    totalMs,
    avgDurationMs: avgDuration,
    totalTokens,
    results,
  };

  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(`  Result: ${passed}/${tasks.length} passed (${rate}%)`);
  console.log(`  Time: ${totalMs}ms  |  Avg: ${avgDuration}ms/task  |  Tokens: ~${totalTokens}`);
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

  // Save results
  const genesisDir = path.join(ROOT, '.genesis');
  if (!fs.existsSync(genesisDir)) fs.mkdirSync(genesisDir, { recursive: true });
  fs.writeFileSync(RESULTS_PATH, JSON.stringify(summary, null, 2));

  // Baseline handling
  if (opts.baselineSave) {
    fs.writeFileSync(BASELINE_PATH, JSON.stringify(summary, null, 2));
    console.log('  📌 Baseline saved.\n');
  }

  if (opts.baselineCompare && fs.existsSync(BASELINE_PATH)) {
    const baseline = JSON.parse(fs.readFileSync(BASELINE_PATH, 'utf-8'));
    console.log('  📊 Baseline Comparison:');
    console.log(`     Baseline: ${baseline.passed}/${baseline.tasks} (${baseline.successRate}%) v${baseline.version}`);
    console.log(`     Current:  ${passed}/${tasks.length} (${rate}%) v${summary.version}`);
    const delta = rate - baseline.successRate;
    if (delta < 0) {
      console.log(`     ⚠  REGRESSION: ${delta}% success rate drop\n`);
    } else if (delta > 0) {
      console.log(`     ✅ Improvement: +${delta}%\n`);
    } else {
      console.log(`     ─  No change\n`);
    }

    // Per-task regression detection
    const regressions = [];
    for (const r of results) {
      const prev = baseline.results.find(b => b.id === r.id);
      if (prev && prev.success && !r.success) {
        regressions.push(r.id + ': ' + r.title);
      }
    }
    if (regressions.length > 0) {
      console.log('  ⚠  Task Regressions:');
      for (const reg of regressions) console.log('     - ' + reg);
      console.log('');
    }
  }

  if (opts.json) {
    console.log(JSON.stringify(summary, null, 2));
  }

  return summary;
}

// ── CLI ─────────────────────────────────────────────────────

if (require.main === module) {
  const args = process.argv.slice(2);
  const opts = {
    quick: args.includes('--quick'),
    backend: args.includes('--backend') ? args[args.indexOf('--backend') + 1] : null,
    baselineSave: args.includes('--baseline') && args.includes('save'),
    baselineCompare: args.includes('--baseline') && args.includes('compare'),
    json: args.includes('--json'),
  };
  runBenchmark(opts);
}

module.exports = { runBenchmark, TASKS };
