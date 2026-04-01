// ============================================================
// GENESIS — test/modules/linux-sandbox.test.js (v4.10.0)
//
// Tests for LinuxSandboxHelper. Works on ALL platforms:
// - On Linux: tests actual namespace detection and wrapping
// - On Windows/macOS: tests graceful degradation (isAvailable=false)
// ============================================================

const { describe, test, assert, assertEqual, run } = require('../harness');
const { detect, isAvailable, getCapabilities, wrapCommand, _resetCache } = require('../../src/agent/foundation/LinuxSandboxHelper');

describe('LinuxSandboxHelper — Detection', () => {
  // FIX: Only reset once at start. Each detect() after reset runs up to
  // 6 execFileSync calls (which + 5 namespace probes) with 3s timeouts each.
  // Multiple resets can exceed CI's 30s per-suite timeout.
  _resetCache();

  test('detect() returns structured result', () => {
    const result = detect();
    assert(typeof result.available === 'boolean', 'available should be boolean');
    assert(Array.isArray(result.capabilities), 'capabilities should be array');
    assert(typeof result.reason === 'string', 'reason should be string');
  });

  test('isAvailable() returns boolean', () => {
    const result = isAvailable();
    assert(typeof result === 'boolean');
  });

  test('getCapabilities() matches detect()', () => {
    const d = detect();
    const c = getCapabilities();
    assertEqual(d.available, c.available);
    assertEqual(d.capabilities.length, c.capabilities.length);
  });

  test('detection is cached', () => {
    const r1 = detect();
    const r2 = detect();
    assert(r1 === r2, 'Expected same object reference (cached)');
  });

  test('_resetCache clears cached result', () => {
    const r1 = detect(); // cached from above
    _resetCache();
    const r2 = detect(); // re-probes (1 full probe)
    assert(r1 !== r2 || !isAvailable(), 'Expected different object after reset (or not available)');
  });
});

describe('LinuxSandboxHelper — Platform Behavior', () => {
  if (process.platform !== 'linux') {
    test('non-linux: isAvailable returns false', () => {
      _resetCache();
      assertEqual(isAvailable(), false);
    });

    test('non-linux: reason mentions platform', () => {
      const result = detect();
      assert(result.reason.includes(process.platform), `Expected reason to mention ${process.platform}`);
    });

    test('non-linux: wrapCommand returns original', () => {
      const result = wrapCommand('node', ['script.js']);
      assertEqual(result.binary, 'node');
      assertEqual(result.args.length, 1);
      assertEqual(result.args[0], 'script.js');
      assertEqual(result.isolated, false);
    });
  } else {
    test('linux: detect() probes namespaces', () => {
      _resetCache();
      const result = detect();
      // On Linux, we should get at least a meaningful reason
      assert(result.reason.length > 0, 'Expected non-empty reason');
    });

    test('linux: wrapCommand applies available namespaces', () => {
      if (!isAvailable()) {
        // No namespaces available — wrapCommand should pass through
        const result = wrapCommand('node', ['script.js']);
        assertEqual(result.binary, 'node');
        assertEqual(result.isolated, false);
      } else {
        const result = wrapCommand('node', ['--max-old-space-size=128', 'script.js']);
        assertEqual(result.binary, 'unshare');
        assertEqual(result.isolated, true);
        assert(result.namespaces.length > 0, 'Expected at least one namespace');
        // Should end with: -- node --max-old-space-size=128 script.js
        const dashDashIdx = result.args.indexOf('--');
        assert(dashDashIdx >= 0, 'Expected -- separator');
        assertEqual(result.args[dashDashIdx + 1], 'node');
        assertEqual(result.args[dashDashIdx + 2], '--max-old-space-size=128');
        assertEqual(result.args[dashDashIdx + 3], 'script.js');
      }
    });
  }
});

describe('LinuxSandboxHelper — wrapCommand Options', () => {
  test('network=true skips --net namespace', () => {
    if (!isAvailable()) return; // Skip on non-Linux
    const withNet = wrapCommand('node', ['s.js'], { network: true });
    const withoutNet = wrapCommand('node', ['s.js'], { network: false });
    // withNet should not include 'net' in namespaces
    assert(!withNet.namespaces.includes('net'), 'Expected no net namespace when network=true');
    // withoutNet should include 'net' if available
    if (getCapabilities().capabilities.includes('net')) {
      assert(withoutNet.namespaces.includes('net'), 'Expected net namespace when network=false');
    }
  });

  test('mount=false skips --mount namespace', () => {
    if (!isAvailable()) return;
    const result = wrapCommand('node', ['s.js'], { mount: false });
    assert(!result.namespaces.includes('mount'), 'Expected no mount namespace when mount=false');
  });

  test('preserves all original args', () => {
    const args = ['--max-old-space-size=128', '--expose-gc', 'script.js', '--flag'];
    const result = wrapCommand('node', args);
    if (result.isolated) {
      const dashDashIdx = result.args.indexOf('--');
      const passedArgs = result.args.slice(dashDashIdx + 2); // skip -- and binary
      assertEqual(passedArgs.length, args.length);
      for (let i = 0; i < args.length; i++) {
        assertEqual(passedArgs[i], args[i]);
      }
    } else {
      // Not isolated — args should be unchanged
      assertEqual(result.args.length, args.length);
    }
  });
});

run();
