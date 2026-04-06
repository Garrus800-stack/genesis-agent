// Test: v6.1.0 — swallow() fire-and-forget utility
// Replaces 10× `.catch(() => {})` with a single auditable pattern.

const { describe, test, assert, run } = require('../harness');

describe('swallow — fire-and-forget with debug logging', () => {
  // Inline require to test the actual export
  const { swallow } = require('../../src/agent/core/utils');

  test('resolving promise → returns void, no throw', async () => {
    const result = await swallow(Promise.resolve('ok'), 'test-resolve');
    assert(result === undefined, 'swallow should return undefined on success');
  });

  test('rejecting promise → catches silently, returns void', async () => {
    let threw = false;
    try {
      const result = await swallow(Promise.reject(new Error('fail')), 'test-reject');
      assert(result === undefined, 'swallow should return undefined on rejection');
    } catch (_e) {
      threw = true;
    }
    assert(!threw, 'swallow must not propagate the rejection');
  });

  test('rejection with non-Error → handles gracefully', async () => {
    let threw = false;
    try {
      await swallow(Promise.reject('string-error'), 'test-string');
    } catch (_e) {
      threw = true;
    }
    assert(!threw, 'swallow must handle non-Error rejections');
  });

  test('default label → no crash when label omitted', async () => {
    let threw = false;
    try {
      await swallow(Promise.reject(new Error('no-label')));
    } catch (_e) {
      threw = true;
    }
    assert(!threw, 'swallow with default label must work');
  });
});

run();
