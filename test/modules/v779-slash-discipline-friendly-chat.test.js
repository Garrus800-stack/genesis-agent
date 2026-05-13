#!/usr/bin/env node
// v7.7.9 Phase 2 — slash-discipline regression test
//
// Bug: friendly chat "na, läuft alles?" was hitting the slash-discipline
// hint "Diese Aktion (`proactive-status`) ist slash-only für Sicherheit"
// because the LocalClassifier/LLM-classifier returned 'proactive-status'
// as a best-guess on conversational text, then enforceSlashDiscipline
// generated a misleading hint.
//
// Fix: the SAFE_SLASH_FALLTHROUGH set lets harmless commands (quiet,
// proactive-status) silently fall through to 'general' on free-text
// mis-classification. The slash pattern itself still works for explicit
// "/quiet" or "/proactive-status" calls.
//
// This test pins the behaviour so future PRs can't reintroduce the
// confusing hint on conversational text.

'use strict';

const { describe, test, assert, assertEqual, run } = require('../harness');

const {
  enforceSlashDiscipline,
  SAFE_SLASH_FALLTHROUGH,
} = require('../../src/agent/intelligence/IntentPatterns');

describe('SAFE_SLASH_FALLTHROUGH set', () => {
  test('contains quiet and proactive-status', () => {
    assert(SAFE_SLASH_FALLTHROUGH.has('quiet'),            'quiet missing');
    assert(SAFE_SLASH_FALLTHROUGH.has('proactive-status'), 'proactive-status missing');
  });

  test('does NOT contain security-relevant commands', () => {
    // These must always go through the explicit slash-hint path.
    assert(!SAFE_SLASH_FALLTHROUGH.has('self-modify'),     'self-modify must NOT be in safe-fallthrough');
    assert(!SAFE_SLASH_FALLTHROUGH.has('execute-code'),    'execute-code must NOT be in safe-fallthrough');
    assert(!SAFE_SLASH_FALLTHROUGH.has('install-software'), 'install-software must NOT be in safe-fallthrough');
    assert(!SAFE_SLASH_FALLTHROUGH.has('shell-run'),       'shell-run must NOT be in safe-fallthrough');
  });
});

describe('enforceSlashDiscipline — friendly-chat regression', () => {
  // The exact message Garrus sent that triggered the original bug:
  const friendlyChat = 'na, läuft alles, oder hast was auf dem herzen';

  test('proactive-status mis-classification on friendly chat → silent general fallthrough', () => {
    const llmResult = { type: 'proactive-status', confidence: 0.7 };
    const r = enforceSlashDiscipline(llmResult, friendlyChat);
    assertEqual(r.type, 'general',
      `expected silent fallthrough to general, got ${r.type}`);
    // No _wasSlashOnlyRewrite flag — that's the key. The flag would
    // route to slashHint and show "Diese Aktion ist slash-only für
    // Sicherheit", which is wrong on conversational text.
    assert(!r._wasSlashOnlyRewrite,
      'safe-fallthrough must NOT set _wasSlashOnlyRewrite');
    assertEqual(r.match, 'safe-slash-fallthrough');
  });

  test('quiet mis-classification → silent general fallthrough', () => {
    const r = enforceSlashDiscipline(
      { type: 'quiet', confidence: 0.7 },
      'kannst du mal kurz still sein?',
    );
    assertEqual(r.type, 'general');
    assert(!r._wasSlashOnlyRewrite);
  });

  test('explicit /proactive-status still works (literal slash present)', () => {
    const r = enforceSlashDiscipline(
      { type: 'proactive-status', confidence: 1.0 },
      '/proactive-status',
    );
    // Literal slash means the user EXPLICITLY asked for the command.
    // Result must pass through unchanged so the handler runs.
    assertEqual(r.type, 'proactive-status');
  });

  test('explicit /quiet 30m still works', () => {
    const r = enforceSlashDiscipline(
      { type: 'quiet', confidence: 1.0 },
      '/quiet 30m',
    );
    assertEqual(r.type, 'quiet');
  });

  test('security-relevant mis-classification still triggers slash-hint', () => {
    // self-modify on free-text MUST still produce the slash-hint —
    // SAFE_SLASH_FALLTHROUGH only covers harmless commands.
    const r = enforceSlashDiscipline(
      { type: 'self-modify', confidence: 0.7 },
      'modifiziere dich selbst',
    );
    assertEqual(r.type, 'general');
    assertEqual(r._wasSlashOnlyRewrite, true,
      'security-relevant commands must still flag _wasSlashOnlyRewrite');
    assertEqual(r.originalIntent, 'self-modify');
  });
});

run();
