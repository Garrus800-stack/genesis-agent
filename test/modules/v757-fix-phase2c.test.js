// ============================================================
// GENESIS — test/modules/v757-fix-phase2c.test.js
//
// Tests for v7.5.7-fix Phase 2 round 3 (UI-honesty pass):
//  - IdleMind factory wires idleMinutes/thinkMinutes from settings
//  - AutonomousDaemon factory wires daemon.cycleMinutes
//  - Emotion UI uses real settings paths (decayIntervalMs, lonelinessIntervalMs)
//  - Dead UI fields removed: set-em-max, set-shell-timeout, set-http-timeout,
//    set-git-timeout, set-emotion-decay, set-emotion-watchdog
// ============================================================

'use strict';

const fs = require('fs');
const path = require('path');
const assert = require('assert');

let passed = 0, failed = 0;
const failures = [];

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`    ✅ ${name}`);
  } catch (err) {
    failed++;
    failures.push({ name, error: err.message });
    console.log(`    ❌ ${name}: ${err.message}`);
  }
}

const ROOT = path.join(__dirname, '..', '..');

// ── Factory wiring ─────────────────────────────────────────

test('IdleMind factory: wires idleMinutes from settings', () => {
  const src = fs.readFileSync(path.join(ROOT, 'src/agent/manifest/phase6-autonomy.js'), 'utf8');
  assert.ok(/idleMind\.idleMinutes/.test(src), 'phase6 must reference idleMind.idleMinutes');
  assert.ok(/idleThreshold\s*=/.test(src), 'must assign idleThreshold');
});

test('IdleMind factory: wires thinkMinutes from settings', () => {
  const src = fs.readFileSync(path.join(ROOT, 'src/agent/manifest/phase6-autonomy.js'), 'utf8');
  assert.ok(/idleMind\.thinkMinutes/.test(src), 'phase6 must reference idleMind.thinkMinutes');
  assert.ok(/thinkInterval\s*=/.test(src), 'must assign thinkInterval');
});

test('AutonomousDaemon factory: wires daemon.cycleMinutes', () => {
  const src = fs.readFileSync(path.join(ROOT, 'src/agent/manifest/phase6-autonomy.js'), 'utf8');
  assert.ok(/daemon\.cycleMinutes/.test(src), 'phase6 must reference daemon.cycleMinutes');
  assert.ok(/cycleInterval\s*=/.test(src), 'must assign cycleInterval');
});

// ── UI honesty: dead fields removed ────────────────────────

test('UI HTML: dead emotion fields are gone', () => {
  const html = fs.readFileSync(path.join(ROOT, 'src/ui/index.html'), 'utf8');
  assert.ok(!/id="set-emotion-decay"/.test(html), 'set-emotion-decay must be removed');
  assert.ok(!/id="set-emotion-watchdog"/.test(html), 'set-emotion-watchdog must be removed');
});

test('UI HTML: dead timeout fields are gone', () => {
  const html = fs.readFileSync(path.join(ROOT, 'src/ui/index.html'), 'utf8');
  assert.ok(!/id="set-shell-timeout"/.test(html), 'set-shell-timeout must be removed');
  assert.ok(!/id="set-http-timeout"/.test(html), 'set-http-timeout must be removed');
  assert.ok(!/id="set-git-timeout"/.test(html), 'set-git-timeout must be removed');
});

test('UI HTML: dead em-max field is gone', () => {
  const html = fs.readFileSync(path.join(ROOT, 'src/ui/index.html'), 'utf8');
  assert.ok(!/id="set-em-max"/.test(html), 'set-em-max must be removed');
});

test('UI HTML: new emotion fields are present (real paths)', () => {
  const html = fs.readFileSync(path.join(ROOT, 'src/ui/index.html'), 'utf8');
  assert.ok(/id="set-emotion-decay-interval"/.test(html), 'set-emotion-decay-interval must exist');
  assert.ok(/id="set-loneliness-interval"/.test(html), 'set-loneliness-interval must exist');
});

test('UI bundled.html: same structure as index.html', () => {
  const html = fs.readFileSync(path.join(ROOT, 'src/ui/index.bundled.html'), 'utf8');
  assert.ok(!/id="set-em-max"/.test(html), 'bundled: set-em-max must be removed');
  assert.ok(!/id="set-shell-timeout"/.test(html), 'bundled: set-shell-timeout must be removed');
  assert.ok(/id="set-emotion-decay-interval"/.test(html), 'bundled: new field must exist');
});

test('UI JS: writes to real settings paths only', () => {
  const src = fs.readFileSync(path.join(ROOT, 'src/ui/modules/settings.js'), 'utf8');
  // Must write the real paths
  assert.ok(/'organism\.emotions\.decayIntervalMs'/.test(src),
    'must write to organism.emotions.decayIntervalMs');
  assert.ok(/'organism\.emotions\.lonelinessIntervalMs'/.test(src),
    'must write to organism.emotions.lonelinessIntervalMs');
  // Must NOT write to dead paths
  assert.ok(!/'organism\.emotions\.decayRate'/.test(src),
    'must not write to dead organism.emotions.decayRate');
  assert.ok(!/'organism\.emotions\.watchdog'/.test(src),
    'must not write to dead organism.emotions.watchdog');
  assert.ok(!/'timeouts\.shellMs'/.test(src),
    'must not write to dead timeouts.shellMs');
  // v7.5.7-fix Phase 3 Etappe 2: episodicMemory.maxEpisodes is now wired
  // through phase5-hexagonal factory — assertion that it is "dead" is
  // no longer valid.
});

// ── Done ───────────────────────────────────────────────────

console.log('');
console.log(`  ${passed} passed${failed > 0 ? `, ${failed} failed` : ''}`);
if (failed > 0) {
  console.log('');
  console.log('  Failures:');
  for (const f of failures) console.log(`    - ${f.name}: ${f.error}`);
  process.exit(1);
}
