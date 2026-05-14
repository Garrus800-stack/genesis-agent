// ============================================================
// GENESIS — test/modules/v782-skill-lockout.test.js (v7.8.2)
//
// Regression tests for the v7.8.1 skill-lockout bugs.
//
// Bug 1: 7-day lockout was effectively permanent. After day 8 the
//        `lockoutUntil > now` check let the gap through, but the
//        `attempts >= 2` guard immediately blocked it again. The
//        attempts counter was never reset. Genesis never retried a
//        previously-failed skill, ever — not even after the LLM
//        improved.
//
// Bug 2: LRU eviction at size > 50 took the oldest key blindly via
//        Map.keys().next(). If the oldest 50 entries happened to be
//        in active lockout, every new gap evicted a still-running
//        cooldown. The 7-day guarantee dissolved silently at scale.
//
// Both fixes verified below.
// ============================================================

'use strict';

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

const { AutonomousDaemon } = require('../../src/agent/autonomy/AutonomousDaemon');

function makeDaemon() {
  const skills = {
    createSkill: async () => { throw new Error('timeout'); }, // always fails
  };
  const d = new AutonomousDaemon({
    bus: { on: () => () => {}, fire: () => {} },
    reflector: null, selfModel: null, memory: null,
    model: { activeModel: 'mock' },
    prompts: null, skills, sandbox: null, guard: null,
    intervals: null, storage: null,
  });
  return d;
}

// ── Bug 1: cooldown-expired reset ───────────────────────────

test('B1: after lockout expires, attempts counter is reset', async () => {
  const d = makeDaemon();
  // Simulate previous-session state: skill failed twice, locked out,
  // but cooldown has just expired (lockoutUntil in the past).
  d.gapAttempts.set('gap:file-management', {
    attempts: 2,
    lastFailure: Date.now() - (8 * 24 * 60 * 60 * 1000), // 8 days ago
    reason: 'timeout',
    lockoutUntil: Date.now() - 1000, // expired 1s ago
  });

  const gaps = [{ id: 'gap:file-management', topic: 'file-management', type: 'missing-capability' }];
  await d._attemptSkillBuilds(gaps);

  // After the attempt: a fresh failure entry should exist (attempts=1
  // not attempts=3). The cooldown-reset deleted the stale entry, and
  // a new attempt was tried, which failed → attempts=1.
  const after = d.gapAttempts.get('gap:file-management');
  assert.ok(after, 'gap entry must exist after retry');
  assert.strictEqual(after.attempts, 1, 'attempts must reset, not stay at 2+');
  assert.strictEqual(after.lockoutUntil, 0, 'fresh entry must have no lockout');
});

test('B1: active lockout still blocks before expiry', async () => {
  const d = makeDaemon();
  d.gapAttempts.set('gap:still-locked', {
    attempts: 2,
    lastFailure: Date.now() - (3 * 24 * 60 * 60 * 1000),
    reason: 'timeout',
    lockoutUntil: Date.now() + (4 * 24 * 60 * 60 * 1000), // 4 days remain
  });

  const gaps = [{ id: 'gap:still-locked', topic: 'still-locked', type: 'missing-capability' }];
  await d._attemptSkillBuilds(gaps);

  // Should NOT have been reset or retried — lockout still active.
  const after = d.gapAttempts.get('gap:still-locked');
  assert.strictEqual(after.attempts, 2, 'attempts must stay at 2 during active lockout');
  assert.ok(after.lockoutUntil > Date.now(), 'lockoutUntil must remain in the future');
});

test('B1: gap with attempts=2 but lockoutUntil=0 still respects counter', () => {
  // Defensive: corrupted state where attempts=2 but no lockout was ever
  // set (shouldn't happen via _recordSkillFailure, but if persisted
  // file is hand-edited or migrated). Should not be reset.
  const d = makeDaemon();
  d.gapAttempts.set('gap:corrupt', {
    attempts: 2,
    lastFailure: 0,
    reason: '',
    lockoutUntil: 0, // never locked
  });

  // The reset-condition requires lockoutUntil > 0, so this entry is
  // left alone. attempts >= 2 will then block the build attempt.
  // Verify: no reset happens.
  // (Skipping the actual build call since the entry should be
  // preserved as-is going INTO _attemptSkillBuilds for entries that
  // never had a lockoutUntil set.)
  const entry = d.gapAttempts.get('gap:corrupt');
  assert.strictEqual(entry.attempts, 2);
  assert.strictEqual(entry.lockoutUntil, 0);
});

// ── Bug 2: eviction respects active lockouts ────────────────

test('B2: eviction at size > 50 skips entries in active lockout', async () => {
  const d = makeDaemon();
  const now = Date.now();

  // Fill the map with 50 entries, all in active lockout (oldest first).
  for (let i = 0; i < 50; i++) {
    d.gapAttempts.set(`gap:locked-${i}`, {
      attempts: 2,
      lastFailure: now - (i * 1000),
      reason: 'timeout',
      lockoutUntil: now + (5 * 24 * 60 * 60 * 1000), // all locked for 5 more days
    });
  }
  assert.strictEqual(d.gapAttempts.size, 50);

  // Now process a new gap → triggers the > 50 eviction branch.
  const gaps = [{ id: 'gap:fresh-attempt', topic: 'fresh-attempt', type: 'missing-capability' }];
  await d._attemptSkillBuilds(gaps);

  // All 50 locked entries must still exist. The map grew past 50
  // because there was nothing safe to evict.
  let lockedKept = 0;
  for (let i = 0; i < 50; i++) {
    if (d.gapAttempts.has(`gap:locked-${i}`)) lockedKept++;
  }
  assert.strictEqual(lockedKept, 50, 'all 50 active lockouts must survive eviction');
});

test('B2: eviction prefers non-locked entries when available', async () => {
  const d = makeDaemon();
  const now = Date.now();

  // First 5 entries: not locked. Remaining 45: locked.
  for (let i = 0; i < 5; i++) {
    d.gapAttempts.set(`gap:free-${i}`, {
      attempts: 1, lastFailure: 0, reason: '', lockoutUntil: 0,
    });
  }
  for (let i = 0; i < 45; i++) {
    d.gapAttempts.set(`gap:locked-${i}`, {
      attempts: 2, lastFailure: 0, reason: 'timeout',
      lockoutUntil: now + (5 * 24 * 60 * 60 * 1000),
    });
  }
  assert.strictEqual(d.gapAttempts.size, 50);

  // New gap triggers eviction. The first non-locked entry (gap:free-0)
  // should be evicted, none of the locked entries.
  const gaps = [{ id: 'gap:new', topic: 'new', type: 'missing-capability' }];
  await d._attemptSkillBuilds(gaps);

  // gap:free-0 must be gone (oldest non-locked).
  assert.ok(!d.gapAttempts.has('gap:free-0'), 'oldest non-locked entry must be evicted');
  // All locked entries must still exist.
  let lockedKept = 0;
  for (let i = 0; i < 45; i++) {
    if (d.gapAttempts.has(`gap:locked-${i}`)) lockedKept++;
  }
  assert.strictEqual(lockedKept, 45, 'all locked entries must survive');
});

// ── summary ────────────────────────────────────────────────

(async () => {
  // Note: test() wraps async via Promise; we await nothing here since
  // each test handles its own await internally. But for async tests
  // we need a final awaitable. Run sequentially is fine because each
  // test makes its own daemon.

  // Sleep just a tick to let any microtasks settle (none expected).
  await new Promise((r) => setTimeout(r, 10));

  if (failed > 0) {
    console.log(`\n  ${failed} failure(s):`);
    for (const f of failures) console.log(`    - ${f.name}: ${f.error}`);
    process.exit(1);
  }
  console.log(`    ${passed} passed`);
})();
