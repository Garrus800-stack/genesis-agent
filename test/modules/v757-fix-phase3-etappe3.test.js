// ============================================================
// GENESIS — test/modules/v757-fix-phase3-etappe3.test.js
//
// Tests for v7.5.7-fix Phase 3 Etappe 3 — UI behaviour:
//   - Default-Hint per field
//   - ↺ Reset-Button per field
//   - Out-of-range validation with visual feedback
//   - Settings-Change-Log on save (alt → neu)
//   - Settings.js sanity-clamp on load
//   - i18n strings for new fields (en + de)
//   - Boot-log active settings summary
// ============================================================

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

let passed = 0, failed = 0;
const failures = [];

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`    ✅ ${name}`);
  } catch (err) {
    failed++;
    failures.push({ name, error: err.message });
    console.log(`    ❌ ${name}: ${err.message}`);
  }
}

const ROOT = path.join(__dirname, '..', '..');

// ── Settings-Defaults registry ─────────────────────────────

test('settings-defaults: registry exposes FIELD_REGISTRY', () => {
  const mod = require(path.join(ROOT, 'src/ui/modules/settings-defaults'));
  assert.ok(mod.FIELD_REGISTRY, 'FIELD_REGISTRY must be exported');
  assert.ok(typeof mod.getFieldDefault === 'function');
  assert.ok(typeof mod.buildDefaultHint === 'function');
  assert.ok(typeof mod.validateField === 'function');
});

test('settings-defaults: covers all Etappe-2 fields', () => {
  const { FIELD_REGISTRY } = require(path.join(ROOT, 'src/ui/modules/settings-defaults'));
  const required = [
    'set-cost-guard-enabled', 'set-cost-session-limit', 'set-cost-daily-limit',
    'set-cost-warn-threshold', 'set-eventstore-size', 'set-eventstore-rotations',
    'set-spawner-timeout', 'set-spawner-memory', 'set-workerpool-max',
    'set-episodic-max', 'set-idlemind-max-goals', 'set-idlemind-journal-size',
    'set-idlemind-journal-rotations', 'set-daemon-auto-repair',
    'set-daemon-auto-optimize', 'set-allow-peers', 'set-allow-file-exec',
    'set-commit-on-shutdown', 'set-health-http', 'set-health-port',
    'set-editor-font', 'set-chat-font',
  ];
  for (const id of required) {
    assert.ok(FIELD_REGISTRY[id], `registry missing entry for: ${id}`);
    assert.ok(FIELD_REGISTRY[id].settingsPath, `${id} missing settingsPath`);
  }
});

test('settings-defaults: validateField rejects out-of-range numbers', () => {
  const { validateField } = require(path.join(ROOT, 'src/ui/modules/settings-defaults'));
  // maxConcurrent: 1..10
  assert.strictEqual(validateField('set-max-concurrent', '5').ok, true);
  assert.strictEqual(validateField('set-max-concurrent', '0').ok, false);
  assert.strictEqual(validateField('set-max-concurrent', '99').ok, false);
  assert.strictEqual(validateField('set-max-concurrent', '').ok, true); // empty = ok
  assert.strictEqual(validateField('set-max-concurrent', 'foo').ok, false);
});

test('settings-defaults: API keys are NOT reset-safe', () => {
  const { FIELD_REGISTRY } = require(path.join(ROOT, 'src/ui/modules/settings-defaults'));
  assert.strictEqual(FIELD_REGISTRY['set-anthropic-key'].resetSafe, false);
  assert.strictEqual(FIELD_REGISTRY['set-openai-key'].resetSafe, false);
});

// ── Settings.js sanity-clamp ────────────────────────────────

test('Settings._sanityClampOnLoad clamps out-of-range values', () => {
  const { Settings } = require(path.join(ROOT, 'src/agent/foundation/Settings'));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gen-p3e3-clamp-'));
  const s = new Settings(dir);
  // Inject malformed values directly, then re-clamp
  s._setRaw('models.maxConcurrent', -5);
  s._setRaw('knowledgeGraph.maxNodes', -100);
  s._setRaw('health.httpPort', 100);
  s._setRaw('llm.costGuard.warnThreshold', 1.5);
  s._sanityClampOnLoad();
  assert.ok(s.get('models.maxConcurrent') >= 1, `maxConcurrent should be clamped, got ${s.get('models.maxConcurrent')}`);
  assert.ok(s.get('knowledgeGraph.maxNodes') >= 0);
  assert.ok(s.get('health.httpPort') >= 1024);
  assert.ok(s.get('llm.costGuard.warnThreshold') <= 0.99);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('Settings._sanityClampOnLoad does not change valid values', () => {
  const { Settings } = require(path.join(ROOT, 'src/agent/foundation/Settings'));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gen-p3e3-clamp2-'));
  const s = new Settings(dir);
  s._setRaw('models.maxConcurrent', 5);
  s._setRaw('knowledgeGraph.maxNodes', 8000);
  s._sanityClampOnLoad();
  assert.strictEqual(s.get('models.maxConcurrent'), 5);
  assert.strictEqual(s.get('knowledgeGraph.maxNodes'), 8000);
  fs.rmSync(dir, { recursive: true, force: true });
});

// ── settings.js (UI module): decorate + validate ───────────

test('settings.js: imports settings-defaults', () => {
  const src = fs.readFileSync(path.join(ROOT, 'src/ui/modules/settings.js'), 'utf8');
  assert.ok(src.includes("require('./settings-defaults')"));
  assert.ok(src.includes('FIELD_REGISTRY'));
});

test('settings.js: _decorateAllFields called on open', () => {
  const src = fs.readFileSync(path.join(ROOT, 'src/ui/modules/settings.js'), 'utf8');
  assert.ok(src.includes('_decorateAllFields()'),
    'must call _decorateAllFields after openSettings');
});

test('settings.js: saveSettings validates before sending IPC', () => {
  const src = fs.readFileSync(path.join(ROOT, 'src/ui/modules/settings.js'), 'utf8');
  const saveStart = src.indexOf('async function saveSettings');
  const saveSlice = src.slice(saveStart, saveStart + 800);
  assert.ok(saveSlice.includes('_validateAllFields'),
    'saveSettings must call _validateAllFields before IPC');
});

// ── main.js: per-change log ────────────────────────────────

test('main.js: batch handler logs each change', () => {
  const src = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8');
  assert.ok(src.includes('[CHANGE]'),
    'batch handler must log each change with [CHANGE] prefix');
});

test('main.js: change log redacts API keys', () => {
  const src = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8');
  assert.ok(src.includes('SENSITIVE') || src.includes('redact'),
    'change log must redact sensitive keys');
});

// ── Boot summary ───────────────────────────────────────────

test('AgentCoreBoot: emits active-settings summary', () => {
  const src = fs.readFileSync(path.join(ROOT, 'src/agent/AgentCoreBoot.js'), 'utf8');
  assert.ok(src.includes('[+] Active:') || src.includes("Active'"),
    'boot must log [+] Active: summary line');
  assert.ok(src.includes('Cost-Guard'), 'summary must include Cost-Guard status');
});

// ── i18n: new keys present in en + de ──────────────────────

test('Language.js: new i18n keys present in en + de', () => {
  const src = fs.readFileSync(path.join(ROOT, 'src/agent/core/Language.js'), 'utf8');
  const keys = [
    'settings.cost_guard.enabled',
    'settings.cost_guard.session_limit',
    'settings.eventstore.size',
    'settings.spawner.timeout',
    'settings.workerpool.max',
    'settings.episodic.max',
    'settings.daemon.auto_repair',
    'settings.security.allow_peers',
    'settings.health.http_enabled',
    'settings.ui.editor_font',
    'settings.mcp.list',
    'ui.add', 'ui.remove', 'ui.reset_to_default',
  ];
  for (const k of keys) {
    // Each key should appear at least 2 times (en + de)
    const count = (src.match(new RegExp(`'${k.replace(/\./g, '\\.')}'`, 'g')) || []).length;
    assert.ok(count >= 2, `key '${k}' should be in both en and de (found ${count})`);
  }
});

// ── HTML: data-i18n attributes added to new labels ─────────

test('HTML: key labels have data-i18n attributes (index.html)', () => {
  const html = fs.readFileSync(path.join(ROOT, 'src/ui/index.html'), 'utf8');
  const required = [
    'settings.cost_guard.enabled', 'settings.section.cost_guard',
    'settings.episodic.max', 'settings.health.http_enabled',
    'settings.daemon.auto_repair', 'settings.section.security',
  ];
  for (const k of required) {
    assert.ok(html.includes(`data-i18n="${k}"`), `index.html missing data-i18n="${k}"`);
  }
});

test('HTML: key labels have data-i18n attributes (index.bundled.html)', () => {
  const html = fs.readFileSync(path.join(ROOT, 'src/ui/index.bundled.html'), 'utf8');
  const required = [
    'settings.cost_guard.enabled', 'settings.section.cost_guard',
    'settings.episodic.max', 'settings.health.http_enabled',
  ];
  for (const k of required) {
    assert.ok(html.includes(`data-i18n="${k}"`), `bundled.html missing data-i18n="${k}"`);
  }
});

// ── CSS: new styles for hint + reset + invalid ─────────────

test('CSS: rules for default-hint, reset-btn, invalid', () => {
  const css = fs.readFileSync(path.join(ROOT, 'src/ui/styles.css'), 'utf8');
  assert.ok(css.includes('.setting-default-hint'));
  assert.ok(css.includes('.setting-reset-btn'));
  assert.ok(css.includes('.setting-input.invalid'));
  assert.ok(css.includes('.setting-error'));
});

// ── Done ───────────────────────────────────────────────────

console.log('');
console.log(`  ${passed} passed${failed > 0 ? `, ${failed} failed` : ''}`);
if (failed > 0) {
  console.log('');
  console.log('  Failures:');
  for (const f of failures) console.log(`    - ${f.name}: ${f.error}`);
  process.exit(1);
}
