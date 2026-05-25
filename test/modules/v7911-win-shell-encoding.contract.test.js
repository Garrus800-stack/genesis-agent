#!/usr/bin/env node
// ============================================================
// GENESIS — test/modules/v7911-win-shell-encoding.contract.test.js
//
// v7.9.11: WinConsoleEncoding module handles cmd.exe codepage output.
// Tests run on any platform — non-Win paths return short-circuit
// values, Win paths exercise the Buffer-decoding logic.
// ============================================================

'use strict';

const { describe, test, assert, assertEqual, run } = require('../harness');
const path = require('path');

const MOD_PATH = path.resolve(__dirname, '../../src/agent/core/shell/WinConsoleEncoding');

// Each test gets a fresh module so the internal _cachedCodepage doesn't
// leak between cases.
function freshModule() {
  delete require.cache[require.resolve(MOD_PATH)];
  return require(MOD_PATH);
}

describe('v7.9.11 — WinConsoleEncoding', () => {

  test('decodeWinConsole pass-through for string input', () => {
    const { decodeWinConsole } = freshModule();
    assertEqual(decodeWinConsole('hello world'), 'hello world');
  });

  test('decodeWinConsole returns empty for null/undefined/empty', () => {
    const { decodeWinConsole } = freshModule();
    assertEqual(decodeWinConsole(null), '');
    assertEqual(decodeWinConsole(undefined), '');
    assertEqual(decodeWinConsole(''), '');
  });

  test('decodeWinConsole handles Buffer with ASCII (works in every codepage)', () => {
    const { decodeWinConsole } = freshModule();
    const ascii = Buffer.from([0x68, 0x69]); // "hi"
    assertEqual(decodeWinConsole(ascii, 'cp850'), 'hi');
    assertEqual(decodeWinConsole(ascii, 'cp1252'), 'hi');
    assertEqual(decodeWinConsole(ascii, 'utf-8'), 'hi');
  });

  test('decodeWinConsole handles Uint8Array input', () => {
    const { decodeWinConsole } = freshModule();
    const arr = new Uint8Array([0x66, 0x6f, 0x6f]); // "foo"
    assertEqual(decodeWinConsole(arr, 'utf-8'), 'foo');
  });

  test('decodeWinConsole utf-8 roundtrip with multi-byte chars', () => {
    const { decodeWinConsole } = freshModule();
    const buf = Buffer.from('Hello, world! \u00e4\u00f6\u00fc', 'utf-8');
    assertEqual(decodeWinConsole(buf, 'utf-8'), 'Hello, world! \u00e4\u00f6\u00fc');
  });

  test('getCachedCodepage returns utf-8 on non-Windows', () => {
    const { getCachedCodepage } = freshModule();
    if (process.platform !== 'win32') {
      assertEqual(getCachedCodepage(), 'utf-8');
    } else {
      // Windows without prior detection: locale-default fallback (cp* form)
      const cp = getCachedCodepage();
      assert(/^cp\d+$/.test(cp) || cp === 'utf-8',
        `expected cp<number> or utf-8 on Windows, got ${cp}`);
    }
  });

  test('detectConsoleCodepage on non-Windows resolves to utf-8', async () => {
    const { detectConsoleCodepage } = freshModule();
    if (process.platform !== 'win32') {
      const cp = await detectConsoleCodepage();
      assertEqual(cp, 'utf-8');
    }
  });

  test('detectConsoleCodepage caches result across calls', async () => {
    const { detectConsoleCodepage } = freshModule();
    const cp1 = await detectConsoleCodepage();
    const cp2 = await detectConsoleCodepage();
    assertEqual(cp1, cp2, 'identical codepage returned across calls');
  });

});

if (require.main === module) run();
