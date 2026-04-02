// ============================================================
// GENESIS — foundation/LinuxSandboxHelper.js (v4.10.0)
//
// Linux-specific process isolation for Sandbox.execute().
// Uses `unshare` to create separate namespaces:
//   - PID namespace:     child can't signal host processes
//   - Network namespace: child has no network (loopback only)
//   - Mount namespace:   child can't see host mounts
//   - IPC namespace:     child can't access host shared memory
//
// DESIGN:
//   On Linux, Sandbox.execute() wraps the `node` command with
//   `unshare --pid --net --mount --ipc --fork` for untrusted code.
//   This provides OS-level isolation that complements the JS-level
//   restrictions (allowlisted require, restricted fs, minimal env).
//
//   On Windows/macOS, this module returns no-op wrappers and
//   Sandbox falls back to the existing child_process isolation.
//
// REQUIRES: unshare(1) — part of util-linux, pre-installed on
// most Linux distributions. May require root or user namespaces
// (enabled by default on Ubuntu 22+, Fedora 35+, Arch).
//
// GRACEFUL DEGRADATION: If unshare is not available or fails
// (e.g. inside Docker without --privileged), Sandbox falls back
// to bare `node` execution with a warning. No crash, no hang.
//
// Usage:
//   const { wrapCommand, isAvailable, getCapabilities } = require('./LinuxSandboxHelper');
//
//   if (isAvailable()) {
//     const { binary, args } = wrapCommand('node', ['--max-old-space-size=128', 'script.js']);
//     // binary = 'unshare', args = ['--pid', '--net', ...., 'node', '--max-old...', 'script.js']
//   }
// ============================================================

const { execFileSync } = require('child_process');
const { TIMEOUTS } = require('../core/Constants');
const { createLogger } = require('../core/Logger');
const _log = createLogger('LinuxSandbox');

// ── Detection ──────────────────────────────────────────────

let _detected = null; // { available, capabilities, reason }

/**
 * Detect unshare availability and capabilities.
 * Cached after first call.
 * @returns {{ available: boolean, capabilities: string[], reason: string }}
 */
function detect() {
  if (_detected) return _detected;

  // Non-Linux: always unavailable
  if (process.platform !== 'linux') {
    _detected = { available: false, capabilities: [], reason: `Platform is ${process.platform}, not linux` };
    return _detected;
  }

  // CI environments: skip namespace probing — unshare probes can hang
  // or hit kernel restrictions on GitHub Actions / Docker runners.
  if (process.env.CI || process.env.GITHUB_ACTIONS) {
    _detected = { available: false, capabilities: [], reason: 'CI environment detected — namespace probing skipped' };
    _log.info('[SANDBOX] CI detected — skipping namespace probes, using basic process isolation');
    return _detected;
  }

  // Check if unshare binary exists
  try {
    execFileSync('which', ['unshare'], { encoding: 'utf-8', timeout: TIMEOUTS.QUICK_CHECK, stdio: 'pipe' });
  } catch (_e) {
    _detected = { available: false, capabilities: [], reason: 'unshare binary not found (install util-linux)' };
    _log.info('[SANDBOX] unshare not found — using basic process isolation');
    return _detected;
  }

  // Probe which namespaces are available (user namespaces may be restricted)
  const namespaces = [
    { flag: '--user', name: 'user' },
    { flag: '--pid', name: 'pid' },
    { flag: '--net', name: 'net' },
    { flag: '--mount', name: 'mount' },
    { flag: '--ipc', name: 'ipc' },
  ];

  const capabilities = [];
  for (const ns of namespaces) {
    try {
      // Test: can we create this namespace? (run `true` inside it)
      execFileSync('unshare', [ns.flag, '--fork', 'true'], {
        encoding: 'utf-8',
        timeout: TIMEOUTS.QUICK_CHECK,
        stdio: 'pipe',
      });
      capabilities.push(ns.name);
    } catch (_e) {
      // This namespace is not available (kernel restriction, Docker, etc.)
      _log.debug(`[SANDBOX] Namespace ${ns.name} not available: ${_e.message?.split('\n')[0]}`);
    }
  }

  if (capabilities.length === 0) {
    _detected = { available: false, capabilities: [], reason: 'unshare exists but no namespaces available (kernel restriction or unprivileged)' };
    _log.info('[SANDBOX] unshare available but no namespaces usable — using basic process isolation');
    return _detected;
  }

  _detected = { available: true, capabilities, reason: `${capabilities.length} namespaces available: ${capabilities.join(', ')}` };
  _log.info(`[SANDBOX] Linux namespace isolation: ${capabilities.join(', ')}`);
  return _detected;
}

/**
 * Check if namespace isolation is available.
 * @returns {boolean}
 */
function isAvailable() {
  return detect().available;
}

/**
 * Get detailed capabilities.
 * @returns {{ available: boolean, capabilities: string[], reason: string }}
 */
function getCapabilities() {
  return detect();
}

// ── Command Wrapping ────────────────────────────────────────

/**
 * Wrap a command with unshare namespace isolation.
 * Returns the original command unchanged if not on Linux or
 * if unshare is not available.
 *
 * @param {string} binary - The command to wrap (e.g. 'node')
 * @param {string[]} args - Arguments to the command
 * @param {object} [options]
 * @param {boolean} [options.network=false] - Allow network access (skips --net)
 * @param {boolean} [options.mount=true] - Isolate mount namespace
 * @returns {{ binary: string, args: string[], isolated: boolean, namespaces: string[] }}
 */
function wrapCommand(binary, args, options = {}) {
  const { network = false, mount = true } = options;

  if (!isAvailable()) {
    return { binary, args, isolated: false, namespaces: [] };
  }

  const caps = detect().capabilities;
  const unshareFlags = [];
  const usedNamespaces = [];

  // --fork is required for PID namespace (otherwise child gets PID 1 weirdness)
  let needsFork = false;

  if (caps.includes('pid')) {
    unshareFlags.push('--pid');
    usedNamespaces.push('pid');
    needsFork = true;
  }

  if (!network && caps.includes('net')) {
    unshareFlags.push('--net');
    usedNamespaces.push('net');
  }

  if (mount && caps.includes('mount')) {
    unshareFlags.push('--mount');
    usedNamespaces.push('mount');
  }

  if (caps.includes('ipc')) {
    unshareFlags.push('--ipc');
    usedNamespaces.push('ipc');
  }

  if (unshareFlags.length === 0) {
    // No useful namespaces available — fall back
    return { binary, args, isolated: false, namespaces: [] };
  }

  if (needsFork) {
    unshareFlags.push('--fork');
  }

  // Build: unshare [flags] -- binary [args]
  const wrappedArgs = [...unshareFlags, '--', binary, ...args];

  return {
    binary: 'unshare',
    args: wrappedArgs,
    isolated: true,
    namespaces: usedNamespaces,
  };
}

/**
 * Reset detection cache (for testing).
 */
function _resetCache() {
  _detected = null;
}

module.exports = { detect, isAvailable, getCapabilities, wrapCommand, _resetCache };
