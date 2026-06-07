// ============================================================
// GENESIS — v796-hygiene-pass.contract.test.js
//
// Contract tests for the v7.9.6 hygiene-pass. Each block pins a
// finding from the v7.9.5 deep-analysis audit so the same class
// of drift cannot silently re-enter the codebase.
//
//   - A: SkillPromotionEvaluator wiring resolves the real
//        'tools' service (was 'toolRegistry' typo, dangling).
//   - B: main.js CHANNELS contract includes all four skill:*
//        push channels (preload.mjs/js had them, main was
//        missing them — silent IPC contract drift).
//   - C: audit-doc-language.js exists and detects the classes
//        of violation it was built for (personal names + stray
//        German tokens), with the documented filters.
//   - D: audit-service-numbers.js exists and reads live values
//        rather than hardcoded baselines.
//   - E: lockCritical includes the 20 CI gate scripts plus
//        architectural-fitness, on top of the 21 source-file
//        locks. Total = 41.
//   - F: package.json `ci` script invokes both new audits in
//        strict mode (Block B closeout).
// ============================================================

'use strict';

const path = require('path');
const fs = require('fs');
const ROOT = path.resolve(__dirname, '../..');
const { describe, test, assert, assertEqual, run } = require('../harness');

describe('v7.9.6 hygiene-pass', () => {

// ── A: Wiring fix — toolRegistry → tools ──────────────────────

test('A1: phase9-cognitive-koennen.js references service "tools" (not "toolRegistry")', () => {
  const file = path.join(ROOT, 'src/agent/manifest/phase9-cognitive-koennen.js');
  const src = fs.readFileSync(file, 'utf8');
  // The line for the toolRegistry binding must read service: 'tools'.
  // The legacy dangling string 'toolRegistry' must not appear as a
  // service reference — only as the prop name on the consumer side.
  const lateBinding = /\bprop:\s*['"]toolRegistry['"]\s*,\s*service:\s*['"]([^'"]+)['"]/;
  const m = lateBinding.exec(src);
  assert(m, 'toolRegistry lateBinding must exist in koennen manifest');
  assertEqual(m[1], 'tools',
    'toolRegistry binding must point at the registered service "tools" — ' +
    'this is the v7.1.6 fix that regressed in v7.9.4 and was re-fixed in v7.9.6');
});

test('A2: no manifest file references a dangling "toolRegistry" service name', () => {
  const dir = path.join(ROOT, 'src/agent/manifest');
  const offenders = [];
  for (const f of fs.readdirSync(dir)) {
    if (!f.startsWith('phase') || !f.endsWith('.js')) continue;
    const src = fs.readFileSync(path.join(dir, f), 'utf8');
    // Any "service: 'toolRegistry'" anywhere in a manifest is the same
    // typo recurrence. The actual service name is 'tools'.
    if (/service:\s*['"]toolRegistry['"]/.test(src)) offenders.push(f);
  }
  assertEqual(offenders.length, 0,
    'No manifest file may reference a service named "toolRegistry" — ' +
    `the registered name is "tools". Offenders: ${offenders.join(', ')}`);
});

// ── B: IPC channel contract — 4 skill:* push entries ──────────

test('B1: main.js CHANNELS contains all four skill:* push channels', () => {
  const main = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8');
  const channelsBlock = /const CHANNELS\s*=\s*\{([\s\S]*?)\n\};/.exec(main);
  assert(channelsBlock, 'CHANNELS block must exist in main.js');
  const body = channelsBlock[1];
  for (const ch of ['skill:promoted', 'skill:discarded', 'skill:quarantined', 'skill:discard-suggested']) {
    assert(body.includes(`'${ch}'`),
      `CHANNELS must declare '${ch}' (push-only). preload.mjs whitelists it; ` +
      'the contract is what audit-channels uses to detect drift.');
  }
});

test('B2: validate-channels --strict exits 0 (sync between main + preload)', () => {
  const { execSync } = require('child_process');
  try {
    execSync('node scripts/validate-channels.js --strict', {
      cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (e) {
    throw new Error('validate-channels.js --strict must exit 0 — channel drift detected');
  }
});

test('B3: validate-service-wiring --strict exits 0', () => {
  const { execSync } = require('child_process');
  try {
    execSync('node scripts/validate-service-wiring.js --strict', {
      cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (e) {
    throw new Error('validate-service-wiring.js --strict must exit 0 — service wiring has unresolved references');
  }
});

// ── C: audit-doc-language exists and works ────────────────────

test('C1: audit-doc-language.js exists and is registered as a CI gate', () => {
  const scriptPath = path.join(ROOT, 'scripts/audit-doc-language.js');
  assert(fs.existsSync(scriptPath), 'scripts/audit-doc-language.js must exist');
  const pkg = require(path.join(ROOT, 'package.json'));
  assert(pkg.scripts.ci.includes('audit-doc-language.js --strict'),
    'audit-doc-language must be invoked in --strict mode from `npm run ci`');
});

test('C2: audit-doc-language --strict passes on the cleaned v7.9.6 docs', () => {
  const { execSync } = require('child_process');
  try {
    execSync('node scripts/audit-doc-language.js --strict', {
      cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (e) {
    throw new Error('audit-doc-language.js --strict must exit 0 on the cleaned docs');
  }
});

test('C3: audit-doc-language whitelists Genesis architecture proper-nouns', () => {
  const src = fs.readFileSync(path.join(ROOT, 'scripts/audit-doc-language.js'), 'utf8');
  // The whitelist must allow these Genesis-internal terms.
  for (const term of ['Hauptstandort', 'Außenposten', 'Können']) {
    assert(src.includes(`'${term}'`),
      `Whitelist must include "${term}" so legitimate architecture references pass`);
  }
});

// ── D: audit-service-numbers exists and works ─────────────────

test('D1: audit-service-numbers.js exists and is registered as a CI gate', () => {
  const scriptPath = path.join(ROOT, 'scripts/audit-service-numbers.js');
  assert(fs.existsSync(scriptPath), 'scripts/audit-service-numbers.js must exist');
  const pkg = require(path.join(ROOT, 'package.json'));
  assert(pkg.scripts.ci.includes('audit-service-numbers.js --strict'),
    'audit-service-numbers must be invoked in --strict mode from `npm run ci`');
});

test('D2: audit-service-numbers --strict passes on the reconciled v7.9.6 docs', () => {
  const { execSync } = require('child_process');
  try {
    execSync('node scripts/audit-service-numbers.js --strict', {
      cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (e) {
    throw new Error('audit-service-numbers.js --strict must exit 0 — doc counts must match live values');
  }
});

test('D3: audit-service-numbers reads live values, not hardcoded baselines', () => {
  const src = fs.readFileSync(path.join(ROOT, 'scripts/audit-service-numbers.js'), 'utf8');
  // The script must measure manifest-services, runtime-services, and source-modules
  // dynamically (not have them as constants in the source).
  assert(src.includes('countManifestServices'),
    'audit-service-numbers must compute the manifest count live');
  assert(src.includes('countRuntimeServices'),
    'audit-service-numbers must compute the runtime count live');
  assert(src.includes('countSourceModules'),
    'audit-service-numbers must compute the source-module count live');
});

// ── E: lockCritical expanded to cover CI gate scripts ─────────

test('E1: lockCritical includes all 20 CI gate scripts plus architectural-fitness', () => {
  const main = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8');
  const block = /lockCritical\(\[([\s\S]*?)\]\)/.exec(main);
  assert(block, 'lockCritical block must exist in main.js');
  const body = block[1];

  const requiredScripts = [
    'scripts/architectural-fitness.js',
    'scripts/audit-class-wiring.js',
    'scripts/audit-contracts.js',
    'scripts/audit-doc-drift.js',
    'scripts/audit-doc-language.js',
    'scripts/audit-events.js',
    'scripts/audit-future-version-refs.js',
    'scripts/audit-gate-stats-callers.js',
    'scripts/audit-hash-lock-coverage.js',
    'scripts/audit-listener-lifecycle.js',
    'scripts/audit-platform-tests.js',
    'scripts/audit-raw-settimeout.js',
    'scripts/audit-schemas.js',
    'scripts/audit-self-gate-coverage.js',
    'scripts/audit-service-numbers.js',
    'scripts/audit-slash-discipline.js',
    'scripts/validate-channels.js',
    'scripts/validate-events.js',
    'scripts/validate-intent-wiring.js',
    'scripts/validate-service-wiring.js',
  ];

  for (const s of requiredScripts) {
    assert(body.includes(`'${s}'`),
      `lockCritical must hash-lock ${s} — self-modification could otherwise weaken this CI gate silently`);
  }
});

test('E2: total hash-locked count is 41 (21 source files + 20 CI scripts)', () => {
  const main = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8');
  const block = /lockCritical\(\[([\s\S]*?)\]\)/.exec(main);
  const body = block[1];
  const entries = body.split('\n').filter(l => /^\s*['"](src|scripts)\//.test(l));
  assertEqual(entries.length, 41,
    'Expected 41 hash-locked entries (21 src + 20 scripts/) — the v7.9.6 audit-closeout added the 20 CI gate scripts');
});

// ── F: CI script invokes both new audits ──────────────────────

test('F1: `npm run ci` invokes 18 CI gates total (16 prior + 2 new)', () => {
  const pkg = require(path.join(ROOT, 'package.json'));
  const ci = pkg.scripts.ci || '';
  const matches = ci.match(/node scripts\/[a-z-]+\.js/g) || [];
  assertEqual(matches.length, 18,
    'package.json `ci` script must call 18 gate scripts after v7.9.6 (added audit-doc-language + audit-service-numbers)');
});

// ── G: Pursuit-loop fixes from v7.9.5 outpost trace ───────────

test('G1: AgentLoopPursuit final-return includes error field on failure', () => {
  // The GoalDriver reads `result.error` to decide hallucination fast-track.
  // Pre-fix the final-return only carried `summary`, so errMsg was always
  // empty and the regex never matched.
  const src = fs.readFileSync(
    path.join(ROOT, 'src/agent/revolution/AgentLoopPursuit.js'), 'utf8');
  // The return block must include `error: verification.success ? null : _finalSummary`.
  assert(
    /error:\s*verification\.success\s*\?\s*null\s*:\s*_finalSummary/.test(src),
    'Final return must surface _finalSummary as `error` on failure — ' +
    'GoalDriverFailurePolicy reads result.error and needs non-empty text ' +
    'to classify hallucinations and fast-track to obsolete'
  );
});

test('G2: Replan path normalises step types before splicing into execution loop', () => {
  // The reflect-LLM omits the type field often. Pre-fix those steps went
  // straight to AgentLoopSteps.js where the <missing>-fallback rewrote them
  // to ANALYZE — defensive but symptom-masking. The proper fix is to
  // normalise where the planner does. v7.9.6 extracts the normalisation
  // logic into plan-context.js as normalizeStepTypes and calls it from
  // both AgentLoopPlanner._llmPlanGoal and AgentLoopPursuit's replan loop.
  const src = fs.readFileSync(
    path.join(ROOT, 'src/agent/revolution/AgentLoopPursuit.js'), 'utf8');
  // AgentLoopPursuit must import the shared normalizeStepTypes helper.
  assert(/require\(['"]\.\/plan-context['"]\)/.test(src),
    'AgentLoopPursuit must import the shared plan-context helper');
  assert(/normalizeStepTypes/.test(src),
    'AgentLoopPursuit must reference normalizeStepTypes (the shared replan-step normaliser)');
  // The replan splice must be preceded by a call to normalizeStepTypes on
  // adjustment.newSteps — that is what closes the gap the live-trace surfaced.
  const splicePos = src.indexOf("steps.splice(i + 1, steps.length, ...adjustment.newSteps)");
  assert(splicePos > 0, 'replan splice must exist');
  const before = src.slice(Math.max(0, splicePos - 400), splicePos);
  assert(/normalizeStepTypes\(\s*adjustment\.newSteps/.test(before),
    'normalizeStepTypes(adjustment.newSteps, ...) must run immediately before the splice');
});

test('G3: GoalDriver hallucination regex matches "Plausibility check failed"', () => {
  // v7.9.7 (B/G): the regex was extracted from GoalDriverFailurePolicy.js
  // to src/agent/core/failure-patterns.js as STRUCTURAL_FAILURE_RE, and
  // both GoalDriverFailurePolicy and AgentLoopPursuitReflection now consume
  // the same helper. Test the behaviour, not the inline literal.
  const { isStructuralFailure } = require(
    path.join(ROOT, 'src/agent/core/failure-patterns'));
  assert(isStructuralFailure('Plausibility check failed for: file:src/foo/bar.js (path does not exist)'),
    'must match "Plausibility check failed" — the literal Steps.js wording');
  assert(isStructuralFailure('implausible path detected'),
    'must still match the legacy "implausible path" wording');
  assert(isStructuralFailure('unknown step type "FOOBAR"'),
    'must still match unknown-step-type wording');
  // The policy file must consume the shared helper, not redefine the regex.
  const policySrc = fs.readFileSync(
    path.join(ROOT, 'src/agent/agency/GoalDriverFailurePolicy.js'), 'utf8');
  assert(/isStructuralFailure/.test(policySrc),
    'GoalDriverFailurePolicy must call isStructuralFailure from the shared helper');
});

}); // describe

run().catch(err => { console.error(err); process.exit(1); });
