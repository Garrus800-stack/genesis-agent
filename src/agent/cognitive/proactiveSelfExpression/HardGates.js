// ============================================================
// GENESIS — proactiveSelfExpression/HardGates.js (v7.7.9 Phase 2)
//
// Fail-fast checks before scoring is even considered. If any of these
// returns false, the thought does not become a self-message. Each gate
// returns a `reason` string when it blocks, used for the suppression
// log surfaced via `/proactive-status`.
//
// Order matters — cheap checks first, expensive checks later.
//
// "Fail closed" rule: if a gate cannot be evaluated (clock skew,
// missing state, malformed thought), default to suppressing the
// message with reason 'gate-error'. Silence is the safe failure mode.
// ============================================================

'use strict';

/**
 * Run the gate sequence. Returns { ok: true } if every gate passed,
 * or { ok: false, reason: 'gate-name', detail?: string } at the first
 * failure.
 *
 * @param {object} thought
 * @param {object} state — { now, lastSelfMessageMs, lastUserMessageMs,
 *                           dailyCount, mutedUntilMs, allowedKinds,
 *                           perKindFloor: { [kind]: { sigFloor, novFloor }? } }
 * @param {object} settings — { enabled, minIntervalMs, quietHours,
 *                              userActivityCooldownMs, dailyVolumeSoftCap,
 *                              perKindFloors }
 * @returns {{ ok: boolean, reason?: string, detail?: string }}
 */
function runGates(thought, state, settings) {
  try {
    // 1. Globally enabled?
    if (settings.enabled === false) {
      return { ok: false, reason: 'disabled' };
    }

    // 2. Quiet hours?
    if (isInQuietHours(state.now || Date.now(), settings.quietHours)) {
      return { ok: false, reason: 'quiet-hours' };
    }

    // 3. Min interval since last self-message?
    const minInterval = typeof settings.minIntervalMs === 'number'
      ? settings.minIntervalMs : 30 * 60 * 1000;
    if (typeof state.lastSelfMessageMs === 'number') {
      const since = (state.now || Date.now()) - state.lastSelfMessageMs;
      if (since < minInterval) {
        return { ok: false, reason: 'min-interval', detail: `${Math.round(since / 1000)}s since last < ${minInterval / 1000}s` };
      }
    }

    // 4. User-activity cooldown — if Garrus just spoke, give him space.
    const cooldown = typeof settings.userActivityCooldownMs === 'number'
      ? settings.userActivityCooldownMs : 10 * 60 * 1000;
    if (typeof state.lastUserMessageMs === 'number') {
      const sinceUser = (state.now || Date.now()) - state.lastUserMessageMs;
      if (sinceUser < cooldown) {
        return { ok: false, reason: 'user-activity-cooldown', detail: `${Math.round(sinceUser / 1000)}s since user spoke < ${cooldown / 1000}s` };
      }
    }

    // 5. /quiet active?
    if (typeof state.mutedUntilMs === 'number' && state.mutedUntilMs > (state.now || Date.now())) {
      return { ok: false, reason: 'user-muted' };
    }

    // 6. Kind allowed?
    const allowed = Array.isArray(settings.allowedKinds) ? settings.allowedKinds : [];
    if (allowed.length > 0 && !allowed.includes(thought.kind)) {
      return { ok: false, reason: 'kind-not-allowed', detail: thought.kind };
    }

    // 7. Per-kind floor (significance / novelty thresholds).
    const floor = (settings.perKindFloors || {})[thought.kind] || null;
    if (floor) {
      const sig = typeof thought.significance === 'number' ? thought.significance : null;
      const nov = typeof thought.novelty === 'number' ? thought.novelty : null;
      if (typeof floor.sigFloor === 'number' && sig !== null && sig < floor.sigFloor) {
        return { ok: false, reason: 'per-kind-floor-significance', detail: `sig ${sig.toFixed(2)} < ${floor.sigFloor}` };
      }
      if (typeof floor.novFloor === 'number' && nov !== null && nov < floor.novFloor) {
        return { ok: false, reason: 'per-kind-floor-novelty', detail: `nov ${nov.toFixed(2)} < ${floor.novFloor}` };
      }
    }

    // 8. Daily volume soft cap — at the cap, every additional message
    //    needs a notably higher score; over the cap, nothing more today.
    const cap = typeof settings.dailyVolumeSoftCap === 'number' ? settings.dailyVolumeSoftCap : 8;
    if (typeof state.dailyCount === 'number' && state.dailyCount >= cap * 2) {
      return { ok: false, reason: 'daily-volume-hard-stop' };
    }

    return { ok: true };
  } catch (err) {
    // Fail closed.
    return { ok: false, reason: 'gate-error', detail: err?.message || String(err) };
  }
}

/**
 * Check whether the given timestamp falls inside the configured quiet hours.
 * quietHours = { start: 'HH:MM', end: 'HH:MM' } in local time.
 * Wrap-around (22:00 → 07:00) is supported.
 */
function isInQuietHours(timestampMs, quietHours) {
  if (!quietHours || typeof quietHours.start !== 'string' || typeof quietHours.end !== 'string') {
    return false;
  }
  const start = parseHm(quietHours.start);
  const end = parseHm(quietHours.end);
  if (start === null || end === null) return false;

  const d = new Date(timestampMs);
  const localMin = d.getHours() * 60 + d.getMinutes();

  if (start === end) return false;
  if (start < end) {
    // e.g. 09:00 → 17:00 (no wrap)
    return localMin >= start && localMin < end;
  }
  // wrap-around: e.g. 22:00 → 07:00
  return localMin >= start || localMin < end;
}

function parseHm(s) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(s);
  if (!m) return null;
  const h = Number(m[1]);
  const mi = Number(m[2]);
  if (h < 0 || h > 23 || mi < 0 || mi > 59) return null;
  return h * 60 + mi;
}

module.exports = {
  runGates,
  isInQuietHours,
  parseHm,
};
