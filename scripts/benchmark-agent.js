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
//   node scripts/benchmark-agent.js --ab           — A/B organism validation
//   node scripts/benchmark-agent.js --ab --quick   — A/B quick mode (3 tasks × 2 runs)
//   node scripts/benchmark-agent.js --ab-mode baseline — single run with organism disabled
//   node scripts/benchmark-agent.js --ab-matrix    — A/B across all configured backends (v6.0.0)
//
// A/B mode: Runs each task twice — once with all prompt sections (full),
// once with organism/consciousness/selfAwareness disabled (baseline).
// Compares success rate, duration, and token usage.
//
// Environment variables (for manual testing):
//   GENESIS_AB_MODE=baseline|no-organism|no-consciousness
//   GENESIS_DISABLED_SECTIONS=organism,consciousness
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

  // ── v6.0.0: Extended task suite ──────────────────────────

  {
    id: 'cg-4',
    type: 'code-gen',
    title: 'Generate async rate limiter',
    input: 'Write a JavaScript class RateLimiter with constructor(maxCalls, windowMs) and an async method acquire() that returns a Promise that resolves when a slot is available. Use a sliding window approach.',
    verify(output) {
      const hasClass = /class\s+RateLimiter/.test(output);
      const hasAcquire = /acquire|async/.test(output);
      const hasWindow = /window|slide|interval|setTimeout|Date\.now/.test(output);
      const hasPromise = /Promise|resolve|await/.test(output);
      const pass = hasClass && hasAcquire && hasWindow && hasPromise;
      return { pass, detail: pass ? 'Valid rate limiter' : 'Missing key elements' };
    },
  },
  {
    id: 'bf-3',
    type: 'bug-fix',
    title: 'Fix async error handling bug',
    input: 'Find and fix the bug in this code:\nasync function processItems(items) {\n  const results = [];\n  for (const item of items) {\n    try {\n      const result = await fetch(`/api/${item.id}`);\n      results.push(result.json());\n    } catch (e) {\n      results.push({ error: e.message });\n    }\n  }\n  return results;\n}\n// Bug: sometimes returns [Promise, Promise, ...] instead of actual data',
    verify(output) {
      const hasAwait = /await\s+result\.json|await\s+res\.json|await.*\.json\(\)/.test(output);
      const mentionsMissing = /missing\s+await|await.*json|\.json\(\)\s+is|promise/i.test(output);
      const pass = hasAwait || mentionsMissing;
      return { pass, detail: pass ? 'Identified missing await on .json()' : 'Did not identify the bug' };
    },
  },
  {
    id: 'rf-2',
    type: 'refactoring',
    title: 'Extract strategy pattern',
    input: 'Refactor this function to use the Strategy pattern:\nfunction calculatePrice(product, discountType) {\n  let price = product.basePrice;\n  if (discountType === "seasonal") { price *= 0.8; }\n  else if (discountType === "clearance") { price *= 0.5; }\n  else if (discountType === "employee") { price *= 0.7; }\n  else if (discountType === "vip") { price *= 0.85; }\n  else if (discountType === "bulk" && product.quantity > 100) { price *= 0.6; }\n  return Math.round(price * 100) / 100;\n}',
    verify(output) {
      const hasMap = /strategies|discounts|Map|Object|{/.test(output);
      const noChain = !/if.*else\s+if.*else\s+if.*else\s+if/.test(output);
      const hasLookup = /\[discountType\]|\[type\]|\.get\(|strategies/.test(output);
      const pass = hasMap && noChain && hasLookup;
      return { pass, detail: pass ? 'Strategy pattern applied' : 'Still uses if/else chain or missing lookup' };
    },
  },
  {
    id: 'an-2',
    type: 'analysis',
    title: 'API design review',
    input: 'Review this REST API design and suggest improvements:\nPOST /api/getUsers          — returns all users\nPOST /api/deleteUser/:id    — deletes a user\nGET  /api/user_update/:id   — updates user (body in query params)\nGET  /api/createUser         — creates a user\nPOST /api/searchUsers       — search with body { name, email }\n\nList at least 3 specific problems with HTTP method usage, naming, or conventions.',
    verify(output) {
      const lower = output.toLowerCase();
      const hasMethodIssue = /get.*delete|get.*create|post.*get|wrong.*method|http.*method|verb/i.test(lower);
      const hasNaming = /naming|convention|inconsistent|snake.?case|camel|plural|singular|restful/i.test(lower);
      const hasQueryBody = /query.*param|body.*get|get.*body|idempoten/i.test(lower);
      const issueCount = [hasMethodIssue, hasNaming, hasQueryBody].filter(Boolean).length;
      const pass = issueCount >= 2;
      return { pass, detail: `${issueCount}/3 issue categories identified` };
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
  console.log(`  Tasks: ${tasks.length}  |  Backend: ${opts.backend || 'default'}  |  Mode: ${opts.quick ? 'quick' : 'full'}${opts.abMode ? '  |  A/B: ' + opts.abMode : ''}\n`);

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

      const env = { ...process.env };
      if (opts.abMode) env.GENESIS_AB_MODE = opts.abMode;

      output = execFileSync('node', args, {
        cwd: ROOT,
        timeout: 60_000,
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
        env,
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

// ── A/B Comparison ──────────────────────────────────────────

function runABComparison(opts = {}) {
  console.log('\n╔══════════════════════════════════════════════╗');
  console.log('║     GENESIS — A/B Organism Validation         ║');
  console.log('╚══════════════════════════════════════════════╝\n');
  console.log('  Mode A (full):     All prompt sections active');
  console.log('  Mode B (baseline): Organism, consciousness, selfAwareness, taskPerformance disabled\n');

  // Run Mode A: full
  console.log('────────── Mode A: FULL ──────────────────────\n');
  const fullResult = runBenchmark({ ...opts, abMode: '' });

  // Run Mode B: baseline
  console.log('\n────────── Mode B: BASELINE ─────────────────\n');
  const baseResult = runBenchmark({ ...opts, abMode: 'baseline' });

  // Compare
  console.log('\n╔══════════════════════════════════════════════╗');
  console.log('║              A/B COMPARISON                   ║');
  console.log('╚══════════════════════════════════════════════╝\n');

  const pad = (s, n) => String(s).padStart(n);

  console.log(`  ${'Metric'.padEnd(25)} ${pad('Full (A)', 12)} ${pad('Baseline (B)', 12)} ${pad('Delta', 10)}`);
  console.log('  ' + '─'.repeat(59));

  const metrics = [
    ['Success rate',    `${fullResult.successRate}%`,    `${baseResult.successRate}%`,    fullResult.successRate - baseResult.successRate, '%'],
    ['Passed',          `${fullResult.passed}/${fullResult.tasks}`, `${baseResult.passed}/${baseResult.tasks}`, fullResult.passed - baseResult.passed, ''],
    ['Avg duration',    `${fullResult.avgDurationMs}ms`, `${baseResult.avgDurationMs}ms`, fullResult.avgDurationMs - baseResult.avgDurationMs, 'ms'],
    ['Total tokens',    `~${fullResult.totalTokens}`,    `~${baseResult.totalTokens}`,    fullResult.totalTokens - baseResult.totalTokens, ''],
  ];

  for (const [label, a, b, delta, unit] of metrics) {
    const sign = delta > 0 ? '+' : '';
    const icon = label === 'Success rate' ? (delta > 0 ? ' ✅' : delta < 0 ? ' ❌' : ' ─') : '';
    console.log(`  ${label.padEnd(25)} ${pad(a, 12)} ${pad(b, 12)} ${pad(sign + delta + unit, 10)}${icon}`);
  }

  // Per-task comparison
  console.log('\n  Per-task delta:');
  for (let i = 0; i < fullResult.results.length; i++) {
    const fr = fullResult.results[i];
    const br = baseResult.results[i];
    if (!br) continue;
    const fIcon = fr.success ? '✅' : '❌';
    const bIcon = br.success ? '✅' : '❌';
    const changed = fr.success !== br.success;
    const marker = changed ? (fr.success ? ' ← organism helped' : ' ← organism hurt') : '';
    console.log(`    ${fr.id} ${fr.title.slice(0, 35).padEnd(35)} A:${fIcon} B:${bIcon}${marker}`);
  }

  // Verdict
  console.log('\n  ' + '─'.repeat(59));
  const delta = fullResult.successRate - baseResult.successRate;
  if (delta > 0) {
    console.log(`  Verdict: Organism layer IMPROVES success rate by ${delta} percentage points.`);
  } else if (delta < 0) {
    console.log(`  Verdict: Organism layer REDUCES success rate by ${Math.abs(delta)} percentage points.`);
  } else {
    console.log('  Verdict: No measurable difference. Organism layer is neutral on this task set.');
  }
  console.log('');

  // Save A/B results
  const abResult = {
    version: fullResult.version,
    timestamp: new Date().toISOString(),
    backend: opts.backend || 'default',
    full: fullResult,
    baseline: baseResult,
    delta: {
      successRate: delta,
      avgDurationMs: fullResult.avgDurationMs - baseResult.avgDurationMs,
      totalTokens: fullResult.totalTokens - baseResult.totalTokens,
    },
  };
  const abPath = path.join(ROOT, '.genesis', 'benchmark-ab.json');
  const genesisDir = path.join(ROOT, '.genesis');
  if (!fs.existsSync(genesisDir)) fs.mkdirSync(genesisDir, { recursive: true });
  fs.writeFileSync(abPath, JSON.stringify(abResult, null, 2));
  console.log(`  Results saved: ${path.relative(ROOT, abPath)}\n`);

  return abResult;
}

// ── A/B Matrix: Multi-Backend Validation (v6.0.0) ─────────

function runABMatrix(opts = {}) {
  console.log('\n╔══════════════════════════════════════════════════╗');
  console.log('║     A/B ORGANISM MATRIX — Multi-Backend         ║');
  console.log('╚══════════════════════════════════════════════════╝\n');

  // Discover configured backends
  let backends = [];
  try {
    const settingsPath = path.join(ROOT, '.genesis', 'settings.json');
    if (fs.existsSync(settingsPath)) {
      const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
      const models = settings.models || settings.backends || [];
      backends = models.map((m, i) => ({
        index: i,
        name: m.label || m.model || m.name || `backend-${i}`,
      }));
    }
  } catch (_) { /* best effort */ }

  if (backends.length === 0) {
    // Fallback: run with default backend only
    backends = [{ index: null, name: 'default' }];
  }

  console.log(`  Backends: ${backends.map(b => b.name).join(', ')}\n`);

  const matrix = [];

  for (const backend of backends) {
    console.log(`\n▶ Backend: ${backend.name}\n`);

    const backendOpts = { ...opts, backend: backend.index };

    // Mode A: full
    const fullResult = runBenchmark({ ...backendOpts, abMode: '' });
    // Mode B: baseline
    const baseResult = runBenchmark({ ...backendOpts, abMode: 'baseline' });

    const delta = fullResult.successRate - baseResult.successRate;
    matrix.push({
      backend: backend.name,
      full: fullResult.successRate,
      baseline: baseResult.successRate,
      delta,
      fullPassed: fullResult.passed,
      basePassed: baseResult.passed,
      totalTasks: fullResult.tasks,
    });
  }

  // Summary table
  console.log('\n╔══════════════════════════════════════════════════╗');
  console.log('║              MATRIX SUMMARY                     ║');
  console.log('╚══════════════════════════════════════════════════╝\n');

  const pad = (s, n) => String(s).padStart(n);
  console.log(`  ${'Backend'.padEnd(20)} ${pad('Full', 8)} ${pad('Baseline', 8)} ${pad('Delta', 8)} ${'Verdict'}`);
  console.log('  ' + '─'.repeat(56));

  let totalDelta = 0;
  for (const row of matrix) {
    const sign = row.delta > 0 ? '+' : '';
    const verdict = row.delta > 0 ? '✅ organism helps' : row.delta < 0 ? '❌ organism hurts' : '─ neutral';
    console.log(`  ${row.backend.padEnd(20)} ${pad(row.full + '%', 8)} ${pad(row.baseline + '%', 8)} ${pad(sign + row.delta + '%', 8)} ${verdict}`);
    totalDelta += row.delta;
  }

  const avgDelta = Math.round(totalDelta / matrix.length);
  console.log('  ' + '─'.repeat(56));
  console.log(`  ${'AVERAGE'.padEnd(20)} ${' '.repeat(16)} ${pad((avgDelta > 0 ? '+' : '') + avgDelta + '%', 8)} ${avgDelta > 0 ? '✅' : avgDelta < 0 ? '❌' : '─'}`);
  console.log();

  // Save results
  const matrixResult = {
    timestamp: new Date().toISOString(),
    backends: matrix,
    averageDelta: avgDelta,
    taskCount: matrix[0]?.totalTasks || 0,
  };
  const matrixPath = path.join(ROOT, '.genesis', 'benchmark-ab-matrix.json');
  const genesisDir = path.join(ROOT, '.genesis');
  if (!fs.existsSync(genesisDir)) fs.mkdirSync(genesisDir, { recursive: true });
  fs.writeFileSync(matrixPath, JSON.stringify(matrixResult, null, 2));
  console.log(`  Results saved: ${path.relative(ROOT, matrixPath)}\n`);

  return matrixResult;
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
    ab: args.includes('--ab'),
    abMode: args.includes('--ab-mode') ? args[args.indexOf('--ab-mode') + 1] : null,
    abMatrix: args.includes('--ab-matrix'),
  };

  if (opts.abMatrix) {
    runABMatrix(opts);
  } else if (opts.ab) {
    runABComparison(opts);
  } else {
    runBenchmark(opts);
  }
}

module.exports = { runBenchmark, runABComparison, runABMatrix, TASKS };
