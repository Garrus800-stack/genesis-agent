// ============================================================
// GENESIS — test/modules/v757-fix-phase3-etappe2.test.js
//
// Tests for v7.5.7-fix Phase 3 Etappe 2 — UI-Vollständigkeit:
//
// ~30 new UI fields for settings that were active in code but not
// editable via UI (cost-guard, mcp-servers, daemon sub-toggles,
// selfSpawner, eventStore, workerPool, episodicMemory, idleMind
// extras, security, health, font sizes, openaiModels).
//
// All defaults remain unchanged — Genesis behaves exactly as before.
// User just gets more knobs that actually work.
// ============================================================

'use strict';

const { readSettingsFamily } = require('../helpers/settings-source');

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

// ── Settings defaults must include new paths ──────────────

test('Settings defaults: health.{httpEnabled, httpPort}', () => {
  const { Settings } = require(path.join(ROOT, 'src/agent/foundation/Settings'));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gen-p3e2-1-'));
  const s = new Settings(dir);
  assert.strictEqual(s.get('health.httpEnabled'), false);
  assert.strictEqual(s.get('health.httpPort'), 9090);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('Settings defaults: llm.costGuard.* (preserves CostGuard.js DEFAULTS)', () => {
  const { Settings } = require(path.join(ROOT, 'src/agent/foundation/Settings'));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gen-p3e2-2-'));
  const s = new Settings(dir);
  assert.strictEqual(s.get('llm.costGuard.enabled'), true);
  assert.strictEqual(s.get('llm.costGuard.sessionTokenLimit'), 500000);
  assert.strictEqual(s.get('llm.costGuard.dailyTokenLimit'), 2000000);
  assert.strictEqual(s.get('llm.costGuard.warnThreshold'), 0.8);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('Settings: existing daemon sub-toggles unchanged (autoRepair=true, autoOptimize=false)', () => {
  const { Settings } = require(path.join(ROOT, 'src/agent/foundation/Settings'));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gen-p3e2-3-'));
  const s = new Settings(dir);
  assert.strictEqual(s.get('daemon.autoRepair'), true);
  assert.strictEqual(s.get('daemon.autoOptimize'), false);
  fs.rmSync(dir, { recursive: true, force: true });
});

// ── HTML: all new field IDs present in index.html ─────────

const NEW_FIELD_IDS = [
  // Cost-Guard
  'set-cost-guard-enabled', 'set-cost-session-limit',
  'set-cost-daily-limit', 'set-cost-warn-threshold',
  // EventStore rotation
  'set-eventstore-size', 'set-eventstore-rotations',
  // SelfSpawner
  'set-spawner-timeout', 'set-spawner-memory',
  // WorkerPool
  'set-workerpool-max',
  // EpisodicMemory
  'set-episodic-max',
  // IdleMind extras
  'set-idlemind-max-goals', 'set-idlemind-journal-size', 'set-idlemind-journal-rotations',
  // Daemon sub
  'set-daemon-auto-repair', 'set-daemon-auto-optimize',
  // Security
  'set-allow-peers', 'set-allow-file-exec', 'set-commit-on-shutdown',
  // Health
  'set-health-http', 'set-health-port',
  // UI fonts
  'set-editor-font', 'set-chat-font',
  // OpenAI models
  'set-openai-models',
  // MCP server list (replaces read-only info)
  'mcp-servers-list', 'btn-mcp-server-add',
];

test('UI: all new field IDs present in index.html', () => {
  const html = fs.readFileSync(path.join(ROOT, 'src/ui/index.html'), 'utf8');
  for (const id of NEW_FIELD_IDS) {
    assert.ok(html.includes(`id="${id}"`), `missing in index.html: id="${id}"`);
  }
});

// v7.6.0: dual-path consolidated — duplicate "synced" check no longer
// applies; v7.7.0 deleted the legacy renderer.js + its test.

test('UI: old read-only mcp-servers-info removed from index.html', () => {
  const html = fs.readFileSync(path.join(ROOT, 'src/ui/index.html'), 'utf8');
  assert.ok(!html.includes('id="mcp-servers-info"'), 'index.html still has old read-only display');
});

// ── settings.js (UI module): load + save logic for new fields ──

test('settings.js: load logic reads all new settings paths', () => {
  const src = readSettingsFamily();
  const requiredPaths = [
    'llm?.costGuard?.enabled',
    'llm?.costGuard?.sessionTokenLimit',
    'llm?.costGuard?.dailyTokenLimit',
    'llm?.costGuard?.warnThreshold',
    'eventStore?.maxFileSizeMB',
    'eventStore?.maxRotations',
    'selfSpawner?.timeoutMs',
    'selfSpawner?.memoryLimitMB',
    'workerPool?.maxWorkers',
    'episodicMemory?.maxEpisodes',
    'idleMind?.maxActiveGoals',
    'daemon?.autoRepair',
    'daemon?.autoOptimize',
    'security?.allowNetworkPeers',
    'security?.allowFileExecution',
    'agency?.commitSnapshotOnShutdown',
    'health?.httpEnabled',
    'health?.httpPort',
    'ui?.editorFontSize',
    'ui?.chatFontSize',
  ];
  for (const p of requiredPaths) {
    assert.ok(src.includes(p), `settings.js missing load path: ${p}`);
  }
});

test('settings.js: save logic writes all new settings paths', () => {
  const src = readSettingsFamily();
  const requiredKeys = [
    'llm.costGuard.enabled',
    'llm.costGuard.sessionTokenLimit',
    'llm.costGuard.dailyTokenLimit',
    'llm.costGuard.warnThreshold',
    'eventStore.maxFileSizeMB',
    'eventStore.maxRotations',
    'selfSpawner.timeoutMs',
    'selfSpawner.memoryLimitMB',
    'workerPool.maxWorkers',
    'episodicMemory.maxEpisodes',
    'idleMind.maxActiveGoals',
    'daemon.autoRepair',
    'daemon.autoOptimize',
    'security.allowNetworkPeers',
    'security.allowFileExecution',
    'agency.commitSnapshotOnShutdown',
    'health.httpEnabled',
    'health.httpPort',
    'ui.editorFontSize',
    'ui.chatFontSize',
    'models.openaiModels',
    'mcp.servers',
  ];
  for (const k of requiredKeys) {
    assert.ok(src.includes(`'${k}'`), `settings.js missing save key: '${k}'`);
  }
});

test('settings.js: MCP server list state machine (add/remove)', () => {
  const src = readSettingsFamily();
  assert.ok(src.includes('_mcpServersState'), 'must have MCP state');
  assert.ok(src.includes('_renderMcpServers'), 'must have render function');
  assert.ok(src.includes('_wireMcpAddButton'), 'must have wire fn');
  assert.ok(src.includes('btn-mcp-server-add'), 'must reference Add button');
});

// ── Settings file CSS for MCP list ─────────────────────────

test('UI: CSS rules for MCP server list present', () => {
  const css = fs.readFileSync(path.join(ROOT, 'src/ui/styles.css'), 'utf8');
  assert.ok(css.includes('.mcp-server-list'), 'missing .mcp-server-list rule');
  assert.ok(css.includes('.mcp-server-row'), 'missing .mcp-server-row rule');
  assert.ok(css.includes('.mcp-server-remove'), 'missing .mcp-server-remove rule');
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
