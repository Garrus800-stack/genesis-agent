// @ts-checked-v7.6.0
// ============================================================
// GENESIS — CommandHandlersOpenDarwin.js
// v7.6.0 Track A #3 — macOS resolver, extracted from
// CommandHandlersOpen.js.
//
// Pure async function — no `this`, no mixin.
//
// Stages (in order):
//   1. /Applications/<name>.app (the standard GUI-app location)
//   2. CLI tools in /usr/local/bin, /opt/homebrew/bin, /usr/bin
//
// PATH probe (command -v / which) is handled by the dispatcher.
// ============================================================

'use strict';

/**
 * @param {string} name           App name
 * @param {object} ctx
 * @param {Function} ctx.fileExists  async (path) → boolean
 * @returns {Promise<{path: string, via: string} | null>}
 */
async function resolveDarwin(name, ctx) {
  const { fileExists } = ctx;

  // /Applications first — that's where GUI installers go.
  const appBundle = `/Applications/${name}.app`;
  if (await fileExists(appBundle)) {
    return { path: appBundle, via: 'common-dir' };
  }

  // Then CLI tool dirs (Homebrew on Apple Silicon vs Intel, then system).
  const cliDirs = ['/usr/local/bin', '/opt/homebrew/bin', '/usr/bin'];
  for (const dir of cliDirs) {
    const candidate = `${dir}/${name}`;
    if (await fileExists(candidate)) {
      return { path: candidate, via: 'common-dir' };
    }
  }

  return null;
}

module.exports = { resolveDarwin };
