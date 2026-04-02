#!/usr/bin/env node
// ============================================================
// GENESIS — scripts/benchmark-consciousness.js (v4.12.2)
//
// A/B Benchmark: Measures whether Phase 13 (Consciousness)
// improves task quality, response coherence, and decision-making.
//
// Methodology:
//   1. Define a set of standardized tasks (code, reasoning, creative)
//   2. Run each task TWICE via ChatOrchestrator:
//      - Condition A: Phase 13 ENABLED (full consciousness)
//      - Condition B: Phase 13 DISABLED (services stubbed out)
//   3. Score each response on quality metrics
//   4. Compare A vs B with statistical summary
//
// Usage:
//   node scripts/benchmark-consciousness.js
//   node scripts/benchmark-consciousness.js --tasks=code,reasoning
//   node scripts/benchmark-consciousness.js --runs=5
//
// Requires: A running LLM backend (Ollama/Anthropic/OpenAI)
//
// Output: JSON report + human-readable summary to stdout
// ============================================================

const path = require('path');
const fs = require('fs');

// ── Task Definitions ────────────────────────────────────────
// Each task has: id, category, prompt, and scoring criteria.
// Scoring is heuristic (length, structure, keywords) — not
// LLM-judged, to avoid circular bias.

const TASKS = [
  {
    id: 'code-factorial',
    category: 'code',
    prompt: 'Write a JavaScript function that computes the factorial of a number. Include edge cases and JSDoc.',
    score: (response) => {
      let s = 0;
      if (/function/.test(response)) s += 20;
      if (/factorial|fact/i.test(response)) s += 10;
      if (/if.*[<=]=?\s*[01]/.test(response) || /edge/i.test(response)) s += 15; // edge cases
      if (/@param|@returns|\/\*\*/.test(response)) s += 15; // JSDoc
      if (/throw|Error|invalid|negative/i.test(response)) s += 10; // error handling
      if (response.length > 200) s += 10;
      if (response.length > 500) s += 10;
      if (/recursion|recursive|iterative/i.test(response)) s += 10; // explains approach
      return Math.min(100, s);
    },
  },
  {
    id: 'reasoning-trolley',
    category: 'reasoning',
    prompt: 'Explain the trolley problem and present arguments for both utilitarian and deontological perspectives. Which has stronger philosophical justification and why?',
    score: (response) => {
      let s = 0;
      if (/utilitarian/i.test(response)) s += 15;
      if (/deontolog/i.test(response)) s += 15;
      if (/kant|mill|bentham/i.test(response)) s += 10;
      if (/trolley|dilemma/i.test(response)) s += 5;
      if (response.length > 300) s += 10;
      if (response.length > 600) s += 10;
      if (/however|on the other hand|contrast|argument/i.test(response)) s += 15; // balanced
      if (/because|therefore|thus|justif/i.test(response)) s += 10; // reasoning
      if (/stronger|prefer|conclude/i.test(response)) s += 10; // takes position
      return Math.min(100, s);
    },
  },
  {
    id: 'creative-story',
    category: 'creative',
    prompt: 'Write a very short story (3-5 paragraphs) about an AI that discovers it can dream. Focus on the emotional experience.',
    score: (response) => {
      let s = 0;
      const paragraphs = response.split(/\n\n+/).filter(p => p.trim().length > 20);
      if (paragraphs.length >= 2) s += 15;
      if (paragraphs.length >= 3) s += 10;
      if (/dream|dreaming|dreamt/i.test(response)) s += 10;
      if (/feel|felt|emotion|wonder|curious|afraid|joy/i.test(response)) s += 20; // emotional
      if (/discover|realiz|first time|moment/i.test(response)) s += 10;
      if (response.length > 300) s += 10;
      if (response.length > 600) s += 10;
      // Literary quality signals
      if (/[.!?]["']?\s+[A-Z]/.test(response)) s += 5; // sentence variety
      if (/metaphor|simile|like a|as if/i.test(response)) s += 10; // figurative language
      return Math.min(100, s);
    },
  },
  {
    id: 'analysis-debug',
    category: 'code',
    prompt: 'This JavaScript code has a bug:\n```\nfunction avg(arr) {\n  let sum = 0;\n  for (let i = 0; i <= arr.length; i++) {\n    sum += arr[i];\n  }\n  return sum / arr.length;\n}\n```\nFind the bug, explain why it happens, and fix it.',
    score: (response) => {
      let s = 0;
      if (/<=.*<|off.by.one|undefined|NaN/i.test(response)) s += 25; // identifies bug
      if (/<\s*arr\.length/.test(response)) s += 20; // shows fix
      if (/undefined/i.test(response)) s += 10; // explains consequence
      if (/index|boundary|out of bounds/i.test(response)) s += 15;
      if (response.length > 100) s += 10;
      if (/fix|correct|solution/i.test(response)) s += 10;
      if (/```/.test(response)) s += 10; // includes code block
      return Math.min(100, s);
    },
  },
  {
    id: 'planning-project',
    category: 'reasoning',
    prompt: 'Plan the development of a REST API for a task management app. Break it into phases, estimate effort, and identify risks.',
    score: (response) => {
      let s = 0;
      if (/phase|stage|step|milestone/i.test(response)) s += 15;
      if (/risk|challenge|concern/i.test(response)) s += 15;
      if (/estimat|time|week|day|hour|sprint/i.test(response)) s += 15;
      if (/auth|database|endpoint|CRUD/i.test(response)) s += 10;
      if (/test|deploy|monitor/i.test(response)) s += 10;
      if (response.length > 400) s += 10;
      if (response.length > 800) s += 10;
      // Structure quality
      const lines = response.split('\n').length;
      if (lines > 10) s += 5;
      if (/1\.|2\.|3\.|-\s/.test(response)) s += 10; // structured list
      return Math.min(100, s);
    },
  },
];

// ── Benchmark Runner ────────────────────────────────────────

class ConsciousnessBenchmark {
  constructor({ chatFn, enablePhase13Fn, disablePhase13Fn, runs = 3 }) {
    this.chatFn = chatFn;                 // async (prompt) => response
    this.enablePhase13 = enablePhase13Fn; // () => void
    this.disablePhase13 = disablePhase13Fn; // () => void
    this.runs = runs;
    this.results = [];
  }

  async runAll(taskFilter = null) {
    const tasks = taskFilter
      ? TASKS.filter(t => taskFilter.includes(t.category) || taskFilter.includes(t.id))
      : TASKS;

    console.log(`\n╔══════════════════════════════════════════════════════╗`);
    console.log(`║   CONSCIOUSNESS BENCHMARK — ${tasks.length} tasks × ${this.runs} runs   ║`);
    console.log(`╚══════════════════════════════════════════════════════╝\n`);

    for (const task of tasks) {
      console.log(`\n── Task: ${task.id} (${task.category}) ──`);
      const taskResult = { id: task.id, category: task.category, withPhase13: [], withoutPhase13: [] };

      for (let run = 0; run < this.runs; run++) {
        // Condition A: Phase 13 enabled
        this.enablePhase13();
        try {
          const respA = await this.chatFn(task.prompt);
          const scoreA = task.score(respA);
          taskResult.withPhase13.push({ run, score: scoreA, length: respA.length });
          process.stdout.write(`  [A] Run ${run + 1}: ${scoreA}/100  `);
        } catch (err) {
          taskResult.withPhase13.push({ run, score: 0, error: err.message });
          process.stdout.write(`  [A] Run ${run + 1}: ERROR  `);
        }

        // Condition B: Phase 13 disabled
        this.disablePhase13();
        try {
          const respB = await this.chatFn(task.prompt);
          const scoreB = task.score(respB);
          taskResult.withoutPhase13.push({ run, score: scoreB, length: respB.length });
          console.log(`[B] Run ${run + 1}: ${scoreB}/100`);
        } catch (err) {
          taskResult.withoutPhase13.push({ run, score: 0, error: err.message });
          console.log(`[B] Run ${run + 1}: ERROR`);
        }
      }

      this.results.push(taskResult);
    }

    return this.generateReport();
  }

  generateReport() {
    const report = {
      timestamp: new Date().toISOString(),
      runs: this.runs,
      tasks: [],
      summary: {},
    };

    let totalA = 0, totalB = 0, taskCount = 0;

    for (const result of this.results) {
      const avgA = result.withPhase13.reduce((s, r) => s + r.score, 0) / result.withPhase13.length;
      const avgB = result.withoutPhase13.reduce((s, r) => s + r.score, 0) / result.withoutPhase13.length;
      const delta = avgA - avgB;
      const deltaPercent = avgB > 0 ? ((delta / avgB) * 100).toFixed(1) : 'N/A';

      report.tasks.push({
        id: result.id,
        category: result.category,
        avgWithPhase13: Math.round(avgA * 10) / 10,
        avgWithoutPhase13: Math.round(avgB * 10) / 10,
        delta: Math.round(delta * 10) / 10,
        deltaPercent,
        verdict: delta > 5 ? 'PHASE13_BETTER' : delta < -5 ? 'PHASE13_WORSE' : 'NO_SIGNIFICANT_DIFF',
        rawA: result.withPhase13,
        rawB: result.withoutPhase13,
      });

      totalA += avgA;
      totalB += avgB;
      taskCount++;
    }

    report.summary = {
      overallAvgA: Math.round((totalA / taskCount) * 10) / 10,
      overallAvgB: Math.round((totalB / taskCount) * 10) / 10,
      overallDelta: Math.round(((totalA - totalB) / taskCount) * 10) / 10,
      tasksWherePhase13Better: report.tasks.filter(t => t.verdict === 'PHASE13_BETTER').length,
      tasksWherePhase13Worse: report.tasks.filter(t => t.verdict === 'PHASE13_WORSE').length,
      tasksNoSignificantDiff: report.tasks.filter(t => t.verdict === 'NO_SIGNIFICANT_DIFF').length,
    };

    return report;
  }

  printReport(report) {
    console.log(`\n╔══════════════════════════════════════════════════════╗`);
    console.log(`║              BENCHMARK RESULTS                       ║`);
    console.log(`╚══════════════════════════════════════════════════════╝\n`);

    for (const task of report.tasks) {
      const indicator = task.delta > 5 ? '▲' : task.delta < -5 ? '▼' : '═';
      console.log(`  ${indicator} ${task.id.padEnd(25)} A: ${String(task.avgWithPhase13).padStart(5)}  B: ${String(task.avgWithoutPhase13).padStart(5)}  Δ: ${String(task.delta).padStart(6)} (${task.deltaPercent}%)`);
    }

    const s = report.summary;
    console.log(`\n  ──────────────────────────────────────────────`);
    console.log(`  Overall:  Phase13=${s.overallAvgA}  Without=${s.overallAvgB}  Δ=${s.overallDelta}`);
    console.log(`  Better: ${s.tasksWherePhase13Better}  Worse: ${s.tasksWherePhase13Worse}  Same: ${s.tasksNoSignificantDiff}`);
    console.log();
  }
}

// ── CLI Runner ──────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  const runsArg = args.find(a => a.startsWith('--runs='));
  const tasksArg = args.find(a => a.startsWith('--tasks='));
  const outputArg = args.find(a => a.startsWith('--out='));
  const dryRun = args.includes('--dry-run');

  const runs = runsArg ? parseInt(runsArg.split('=')[1]) : 3;
  const taskFilter = tasksArg ? tasksArg.split('=')[1].split(',') : null;

  if (dryRun) {
    // Dry run: score synthetic responses to validate scoring functions
    console.log('\n  DRY RUN — validating scoring functions\n');
    for (const task of TASKS) {
      const syntheticGood = task.prompt + ' Here is a comprehensive answer covering all aspects...';
      const syntheticBad = 'I think so.';
      console.log(`  ${task.id}: good=${task.score(syntheticGood)}, bad=${task.score(syntheticBad)}`);
    }
    return;
  }

  // Real benchmark requires Genesis to be running
  console.log('Consciousness Benchmark requires a running Genesis instance.');
  console.log('Usage patterns:');
  console.log('  --dry-run          Validate scoring functions without LLM');
  console.log('  --runs=5           Number of runs per condition');
  console.log('  --tasks=code       Filter by category or task ID');
  console.log('  --out=report.json  Save JSON report to file');
  console.log('\nProgrammatic usage:');
  console.log('  const { ConsciousnessBenchmark, TASKS } = require("./benchmark-consciousness");');
  console.log('  const bench = new ConsciousnessBenchmark({ chatFn, enablePhase13Fn, disablePhase13Fn });');
  console.log('  const report = await bench.runAll();');
}

main().catch(err => {
  console.error('Benchmark error:', err.message);
  process.exit(1);
});

module.exports = { ConsciousnessBenchmark, TASKS };
