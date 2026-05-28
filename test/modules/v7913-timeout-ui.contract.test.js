#!/usr/bin/env node
// ============================================================
// GENESIS — test/modules/v7913-timeout-ui.contract.test.js
//
// v7.9.13 (Item B): the two model-timeout settings made UI-visible.
//
// set-local-timeout and set-cloud-timeout existed in the FIELD_REGISTRY
// with validation since v7.9.12, but had no <input> in index.html, so a
// user could not see or set them without editing settings.json. This
// release adds both fields to the Limits tab under a "Model timeouts"
// section, with i18n in all four languages.
//
// This contract guards:
//   1. Both inputs exist in index.html.
//   2. Their min/max/placeholder match the FIELD_REGISTRY exactly, so
//      what the UI displays and what it validates cannot diverge.
//   3. The five new i18n keys exist in all four locales (en/de/fr/es).
//
// The streamTimeouts (Item A) are deliberately NOT given UI fields —
// they are JSON-only expert settings. This test asserts only the two
// model-response timeouts are surfaced.
// ============================================================

'use strict';

const { describe, test, assert, assertEqual, run } = require('../harness');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const HTML = fs.readFileSync(path.join(ROOT, 'src/ui/index.html'), 'utf8');
const { STRINGS } = require(path.join(ROOT, 'src/agent/core/Language'));
const { FIELD_REGISTRY } = require(path.join(ROOT, 'src/ui/modules/settings-defaults'));

const I18N_KEYS = [
  'settings.section.model_timeouts',
  'settings.localtimeout.label',
  'settings.localtimeout.hint',
  'settings.cloudtimeout.label',
  'settings.cloudtimeout.hint',
];

describe('v7.9.13 (Item B) — model-timeout UI fields', () => {

  test('both timeout inputs are present in index.html', () => {
    assert(/id="set-local-timeout"/.test(HTML), 'set-local-timeout input must exist');
    assert(/id="set-cloud-timeout"/.test(HTML), 'set-cloud-timeout input must exist');
  });

  test('HTML min/max/placeholder match FIELD_REGISTRY (display == validation)', () => {
    for (const id of ['set-local-timeout', 'set-cloud-timeout']) {
      const reg = FIELD_REGISTRY[id];
      assert(reg, `${id} must be in FIELD_REGISTRY`);
      const re = new RegExp(`id="${id}"[^>]*min="(\\d+)"[^>]*max="(\\d+)"[^>]*placeholder="(\\d+)"`);
      const m = HTML.match(re);
      assert(m, `${id} input must declare min/max/placeholder`);
      assertEqual(Number(m[1]), reg.min, `${id} min must match registry`);
      assertEqual(Number(m[2]), reg.max, `${id} max must match registry`);
      assertEqual(Number(m[3]), reg.default, `${id} placeholder must match registry default`);
    }
  });

  test('the "Model timeouts" section divider is present', () => {
    assert(/data-i18n="settings\.section\.model_timeouts"/.test(HTML),
      'a section label for model timeouts must exist');
  });

  test('all five new i18n keys exist in every locale', () => {
    for (const lang of ['en', 'de', 'fr', 'es']) {
      for (const key of I18N_KEYS) {
        assert(key in STRINGS[lang], `${lang} is missing ${key}`);
        assert(STRINGS[lang][key].length > 0, `${lang}.${key} must be non-empty`);
      }
    }
  });

  test('streamTimeouts are NOT given UI fields (kept JSON-only)', () => {
    assert(!/id="set-stream-/.test(HTML),
      'streamTimeouts must remain JSON-only expert settings, no UI inputs');
  });

});

if (require.main === module) run();
