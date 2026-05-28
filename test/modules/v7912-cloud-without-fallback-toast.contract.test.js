#!/usr/bin/env node
// ============================================================
// GENESIS — test/modules/v7912-cloud-without-fallback-toast.contract.test.js
//
// v7.9.12: the model:cloud-without-fallback event (emitted since v7.5.7 but
// previously bus/log-only) is now surfaced in the UI as a warning toast plus
// a transient status. This guards the wiring contract so the event actually
// reaches the renderer:
//   - i18n key warnings.cloud_without_fallback present in all locales
//     and carries the {{model}} placeholder
//   - main.js CHANNELS declares the push-only channel
//   - preload allow-lists the channel for receive
//   - AgentCoreWire bridges the event (source-presence)
// ============================================================

'use strict';

const { describe, test, assert, run } = require('../harness');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '../..');
const { STRINGS } = require('../../src/agent/core/Language');

describe('v7.9.12 — cloud-without-fallback toast wiring', () => {

  test('i18n key present in all locales with {{model}} placeholder', () => {
    const KEY = 'warnings.cloud_without_fallback';
    const locales = Object.keys(STRINGS);
    assert(locales.length >= 2, 'expected multiple locales');
    for (const loc of locales) {
      const val = STRINGS[loc][KEY];
      assert(typeof val === 'string' && val.length > 0,
        `locale '${loc}' missing ${KEY}`);
      assert(val.includes('{{model}}'),
        `locale '${loc}' ${KEY} must interpolate {{model}}`);
    }
  });

  test('main.js declares model:cloud-without-fallback push channel', () => {
    const src = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8');
    assert(/'model:cloud-without-fallback'\s*:\s*null/.test(src),
      'CHANNELS must declare model:cloud-without-fallback as push-only (null)');
  });

  test('preload allow-lists the channel for receive (both preloads)', () => {
    for (const f of ['preload.mjs', 'preload.js']) {
      const src = fs.readFileSync(path.join(ROOT, f), 'utf8');
      assert(src.includes("'model:cloud-without-fallback'"),
        `${f} ALLOWED_RECEIVE must include model:cloud-without-fallback`);
    }
  });

  test('AgentCoreWire bridges the event and renderer subscribes', () => {
    const wire = fs.readFileSync(path.join(ROOT, 'src/agent/AgentCoreWire.js'), 'utf8');
    assert(wire.includes("event: 'model:cloud-without-fallback'"),
      'AgentCoreWire STATUS_BRIDGE must handle model:cloud-without-fallback');
    assert(/push\(\s*'model:cloud-without-fallback'/.test(wire),
      'AgentCoreWire must push the event to the renderer');
    const renderer = fs.readFileSync(path.join(ROOT, 'src/ui/renderer-main.js'), 'utf8');
    assert(renderer.includes("window.genesis.on('model:cloud-without-fallback'"),
      'renderer-main must subscribe to model:cloud-without-fallback');
    assert(renderer.includes('warnings.cloud_without_fallback'),
      'renderer-main must use the warnings.cloud_without_fallback i18n key');
  });

});

if (require.main === module) run();
