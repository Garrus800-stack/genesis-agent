#!/usr/bin/env node
// Test: watchdog-alert edge guard — P6 (v7.9.25)
// emotion:watchdog-alert now fires once on entering the >=2-stuck state and again
// only after the state clears and re-enters — not on every CHECK_INTERVAL tick.
// The per-dimension reset path is unchanged and still fires watchdog-reset.
const { describe, test, assert, assertEqual, run } = require('../harness');
const { EmotionalState } = require('../../src/agent/organism/EmotionalState');

const tick = (ctx) => EmotionalState.prototype._watchdogTick.call(ctx);
const alerts = (ctx) => ctx._fired.filter(f => f.event === 'emotion:watchdog-alert').length;
const resets = (ctx) => ctx._fired.filter(f => f.event === 'emotion:watchdog-reset').length;

function makeCtx() {
  const fired = [];
  const dims = {};
  const extremeSince = {};
  let extremeSet = new Set();
  for (const name of ['frustration', 'energy', 'loneliness', 'curiosity']) {
    dims[name] = { value: 0.9, baseline: 0.5, min: 0, max: 1 };
    extremeSince[name] = null;
  }
  return {
    dimensions: dims,
    _extremeSince: extremeSince,
    _watchdogAlertActive: false,
    bus: { fire: (event, payload) => { fired.push({ event, payload }); } },
    _isExtreme: (name) => extremeSet.has(name),
    _fired: fired,
    setExtreme(names) { extremeSet = new Set(names); },
  };
}

describe('EmotionalState P6 — watchdog-alert edge guard', () => {

  test('alert fires once on entering >=2-stuck, not on every repeat tick', () => {
    const ctx = makeCtx();
    ctx.setExtreme(['frustration', 'energy']);
    tick(ctx); tick(ctx); tick(ctx); // three consecutive ticks, same stuck dims
    assertEqual(alerts(ctx), 1, 'exactly one alert across three stuck ticks');
  });

  test('alert re-fires after the episode clears and re-enters', () => {
    const ctx = makeCtx();
    ctx.setExtreme(['frustration', 'energy']);
    tick(ctx);                       // enter → fire #1
    ctx.setExtreme([]);              // clear
    tick(ctx);                       // below threshold → resets the guard
    ctx.setExtreme(['frustration', 'loneliness']);
    tick(ctx);                       // re-enter → fire #2
    assertEqual(alerts(ctx), 2, 'one alert per distinct stuck episode');
  });

  test('no alert below two stuck dimensions', () => {
    const ctx = makeCtx();
    ctx.setExtreme(['frustration']);
    tick(ctx); tick(ctx);
    assertEqual(alerts(ctx), 0, 'a single stuck dimension never alerts');
  });

  test('dropping to one stuck dimension re-arms the guard', () => {
    const ctx = makeCtx();
    ctx.setExtreme(['frustration', 'energy']);
    tick(ctx);                       // fire #1
    ctx.setExtreme(['frustration']); // drop to 1 → re-arm
    tick(ctx);
    ctx.setExtreme(['frustration', 'energy']);
    tick(ctx);                       // fire #2
    assertEqual(alerts(ctx), 2, 'guard re-arms when stuck count drops below 2');
  });

  test('the per-dimension reset path is intact (still fires watchdog-reset)', () => {
    const ctx = makeCtx();
    ctx.setExtreme(['frustration']);
    // seed a long-stuck timestamp so the time-based reset triggers this tick
    ctx._extremeSince.frustration = Date.now() - 9_999_999;
    tick(ctx);
    assertEqual(resets(ctx), 1, 'a long-stuck dimension still resets');
    assert(ctx.dimensions.frustration.value < 0.9, 'value pushed toward baseline');
  });
});

run();
