// ============================================================
// v7.3.7 #2 — ActiveReferencesPort
//
// Prevents race between DreamCycle (bg consolidation) and
// ChatOrchestrator (active turn). Verified here:
//   - claim/isActive/releaseTurn contract
//   - Idempotent claim (same turn refresh, different turn overwrite)
//   - TTL auto-expiry via injected clock
//   - sweep() removes stale entries
//   - getReport() for diagnostics
//   - Defensive: null/empty args
// ============================================================

const { describe, it, beforeEach } = require('node:test');
const assert = require('assert');

const { ActiveReferencesPort } = require('../../src/agent/ports/ActiveReferencesPort');

// Fake clock — injectable per Principle 0.3
function makeFakeClock(startMs = 1_000_000) {
  let t = startMs;
  return {
    now: () => t,
    advance: (ms) => { t += ms; },
    set: (ms) => { t = ms; },
  };
}

describe('v7.3.7 #2 — ActiveReferencesPort', () => {

  let clock, port;
  beforeEach(() => {
    clock = makeFakeClock();
    port = new ActiveReferencesPort({ clock });
  });

  // ── Basic contract ────────────────────────────────────────

  it('starts empty', () => {
    assert.strictEqual(port.size(), 0);
    assert.strictEqual(port.isActive('ep_1'), false);
  });

  it('claim() adds an active reference', () => {
    port.claim('ep_1', 'turn-A');
    assert.strictEqual(port.isActive('ep_1'), true);
    assert.strictEqual(port.size(), 1);
  });

  it('isActive() returns false for unclaimed episodes', () => {
    port.claim('ep_1', 'turn-A');
    assert.strictEqual(port.isActive('ep_99'), false);
  });

  it('releaseTurn() removes all claims for the given turn', () => {
    port.claim('ep_1', 'turn-A');
    port.claim('ep_2', 'turn-A');
    port.claim('ep_3', 'turn-B');

    const released = port.releaseTurn('turn-A');
    assert.strictEqual(released, 2);
    assert.strictEqual(port.isActive('ep_1'), false);
    assert.strictEqual(port.isActive('ep_2'), false);
    assert.strictEqual(port.isActive('ep_3'), true);  // untouched
  });

  it('releaseTurn() returns 0 for unknown turn', () => {
    port.claim('ep_1', 'turn-A');
    assert.strictEqual(port.releaseTurn('turn-XYZ'), 0);
    assert.strictEqual(port.isActive('ep_1'), true);
  });

  // ── Idempotency ───────────────────────────────────────────

  it('claim() within the same turn is idempotent (same turn, same id)', () => {
    port.claim('ep_1', 'turn-A');
    const t1 = port.size();
    port.claim('ep_1', 'turn-A');
    assert.strictEqual(port.size(), t1, 'duplicate claim must not grow the map');
  });

  it('claim() refreshes claimedAt when re-claimed in same turn', () => {
    port.claim('ep_1', 'turn-A');
    clock.advance(60_000);  // 1min later
    port.claim('ep_1', 'turn-A');  // refresh
    clock.advance(9 * 60_000);     // 9min past initial claim, 1min past refresh
    // TTL is 10min — original would be gone, refreshed still fresh
    assert.strictEqual(port.isActive('ep_1'), true,
      'refreshed claim must reset the TTL window');
  });

  it('claim() from different turn overwrites existing', () => {
    port.claim('ep_1', 'turn-A');
    port.claim('ep_1', 'turn-B');
    // Release turn-A should NOT remove the episode anymore
    port.releaseTurn('turn-A');
    assert.strictEqual(port.isActive('ep_1'), true);
    // Release turn-B releases it
    port.releaseTurn('turn-B');
    assert.strictEqual(port.isActive('ep_1'), false);
  });

  // ── TTL / expiry ──────────────────────────────────────────

  it('isActive() auto-expires entries past TTL', () => {
    port.claim('ep_1', 'turn-A');
    clock.advance(11 * 60_000);  // 11min (past 10min default TTL)
    assert.strictEqual(port.isActive('ep_1'), false,
      'entry must auto-expire beyond TTL');
    assert.strictEqual(port.size(), 0,
      'expired entry must be removed on read');
  });

  it('custom TTL is honored', () => {
    port.claim('ep_1', 'turn-A', 5_000);  // 5s TTL
    clock.advance(4_000);
    assert.strictEqual(port.isActive('ep_1'), true);
    clock.advance(2_000);  // total 6s, past 5s TTL
    assert.strictEqual(port.isActive('ep_1'), false);
  });

  // ── sweep() ───────────────────────────────────────────────

  it('sweep() removes only expired entries', () => {
    port.claim('ep_1', 'turn-A', 5_000);
    port.claim('ep_2', 'turn-B', 5_000);
    port.claim('ep_3', 'turn-C', 60_000);  // longer TTL

    clock.advance(10_000);  // past ep_1 and ep_2 TTL

    const removed = port.sweep();
    assert.strictEqual(removed, 2);
    assert.strictEqual(port.size(), 1);
    assert.strictEqual(port.isActive('ep_3'), true);
  });

  it('sweep() returns 0 when nothing to sweep', () => {
    port.claim('ep_1', 'turn-A');
    assert.strictEqual(port.sweep(), 0);
  });

  // ── Defensive / API robustness ────────────────────────────

  it('claim() ignores null or empty arguments', () => {
    port.claim(null, 'turn-A');
    port.claim('ep_1', null);
    port.claim('', '');
    assert.strictEqual(port.size(), 0);
  });

  it('isActive() returns false for null/empty', () => {
    assert.strictEqual(port.isActive(null), false);
    assert.strictEqual(port.isActive(''), false);
  });

  it('stop() clears all references', () => {
    port.claim('ep_1', 'turn-A');
    port.claim('ep_2', 'turn-B');
    port.stop();
    assert.strictEqual(port.size(), 0);
  });

  // ── Diagnostics ───────────────────────────────────────────

  it('getReport() returns size and unique turn list', () => {
    port.claim('ep_1', 'turn-A');
    port.claim('ep_2', 'turn-A');
    port.claim('ep_3', 'turn-B');
    const rep = port.getReport();
    assert.strictEqual(rep.size, 3);
    assert.strictEqual(rep.turns.length, 2);
    assert.ok(rep.turns.includes('turn-A'));
    assert.ok(rep.turns.includes('turn-B'));
  });

});
