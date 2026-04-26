// ============================================================
// Test: v7.4.7 — Settings Reinraum
//
// Verifies that the three previously-dead settings (daemon.enabled,
// idleMind.enabled, security.allowSelfModify) actually have runtime
// side effects, plus the four new settings (trust.level,
// agency.autoResumeGoals, mcp.serve.*, timeouts.approvalSec) read
// real values into the right places.
//
// Tests are split into:
//   #1: Settings.set() emits toggle events on toggle-relevant keys
//   #2: AgentCoreWire._startServices respects daemon.enabled / idleMind.enabled
//   #3: SelfModificationPipeline.modify() blocks when allowSelfModify=false
//   #4: Source-presence tests for the new HTML/JS UI fields
//   #5: Default-shape tests for the new settings keys
// ============================================================

'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');

let passed = 0, failed = 0;
const failures = [];
function test(name, fn) {
  try {
    const r = fn();
    if (r && typeof r.then === 'function') {
      return r.then(() => { passed++; console.log(`    ✅ ${name}`); })
              .catch(err => { failed++; failures.push({ name, error: err.message }); console.log(`    ❌ ${name}: ${err.message}`); });
    }
    passed++; console.log(`    ✅ ${name}`);
  } catch (err) { failed++; failures.push({ name, error: err.message }); console.log(`    ❌ ${name}: ${err.message}`); }
}
function assert(c, m) { if (!c) throw new Error(m || 'Assertion failed'); }

(async () => {
  console.log('  v747-fix tests:');

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'genesis-v747-'));

  // ── #1: Settings emits toggle events ────────────────────────
  await test('#1 Settings.set() emits settings:daemon-toggled on daemon.enabled change', () => {
    const { Settings } = require('../../src/agent/foundation/Settings');
    const settings = new Settings(tmpDir, null);
    let captured = null;
    const fakeBus = {
      emit: (eventKey, payload) => { if (eventKey === 'settings:daemon-toggled') captured = payload; },
    };
    settings.setBus(fakeBus);
    settings.set('daemon.enabled', false);
    assert(captured, 'expected toggle event');
    assert(captured.from === true && captured.to === false,
      `expected from=true to=false, got: ${JSON.stringify(captured)}`);
  });

  await test('#1 Settings.set() emits settings:idlemind-toggled on idleMind.enabled change', () => {
    const { Settings } = require('../../src/agent/foundation/Settings');
    const settings = new Settings(tmpDir, null);
    let captured = null;
    const fakeBus = { emit: (k, p) => { if (k === 'settings:idlemind-toggled') captured = p; } };
    settings.setBus(fakeBus);
    settings.set('idleMind.enabled', false);
    assert(captured && captured.to === false, `event payload: ${JSON.stringify(captured)}`);
  });

  await test('#1 Settings.set() emits settings:selfmod-toggled on allowSelfModify change', () => {
    const { Settings } = require('../../src/agent/foundation/Settings');
    const settings = new Settings(tmpDir, null);
    let captured = null;
    const fakeBus = { emit: (k, p) => { if (k === 'settings:selfmod-toggled') captured = p; } };
    settings.setBus(fakeBus);
    settings.set('security.allowSelfModify', false);
    assert(captured && captured.to === false, `event payload: ${JSON.stringify(captured)}`);
  });

  await test('#1 Settings.set() emits settings:trust-level-changed on trust.level', () => {
    const { Settings } = require('../../src/agent/foundation/Settings');
    const settings = new Settings(tmpDir, null);
    let captured = null;
    const fakeBus = { emit: (k, p) => { if (k === 'settings:trust-level-changed') captured = p; } };
    settings.setBus(fakeBus);
    settings.set('trust.level', 2);
    assert(captured && captured.to === 2, `event payload: ${JSON.stringify(captured)}`);
  });

  await test('#1 Settings.set() does NOT emit toggle event when value unchanged', () => {
    const { Settings } = require('../../src/agent/foundation/Settings');
    const settings = new Settings(tmpDir, null);
    settings.set('daemon.enabled', true);  // already default
    let emitCount = 0;
    const fakeBus = { emit: () => { emitCount++; } };
    settings.setBus(fakeBus);
    settings.set('daemon.enabled', true);  // no-op
    assert(emitCount === 0, `expected no events for unchanged value, got ${emitCount}`);
  });

  await test('#1 Settings.set() does NOT emit for non-toggle keys', () => {
    const { Settings } = require('../../src/agent/foundation/Settings');
    const settings = new Settings(tmpDir, null);
    let emitCount = 0;
    const fakeBus = { emit: () => { emitCount++; } };
    settings.setBus(fakeBus);
    settings.set('models.preferred', 'qwen3-coder');
    assert(emitCount === 0, `expected no events for non-toggle key, got ${emitCount}`);
  });

  // ── #2: AgentCoreWire conditional start (source check) ──────
  await test('#2 AgentCoreWire source: conditionally starts daemon based on daemon.enabled', () => {
    const src = fs.readFileSync(
      path.join(__dirname, '..', '..', 'src', 'agent', 'AgentCoreWire.js'),
      'utf-8'
    );
    assert(/daemonEnabled\s*=\s*settings\?\.get\?\.\('daemon\.enabled'\)\s*!==\s*false/.test(src),
      'expected daemonEnabled check');
    assert(/if \(daemonEnabled\)\s*\{\s*start\('daemon'\);/.test(src),
      'expected conditional daemon start');
  });

  await test('#2 AgentCoreWire source: conditionally starts idleMind based on idleMind.enabled', () => {
    const src = fs.readFileSync(
      path.join(__dirname, '..', '..', 'src', 'agent', 'AgentCoreWire.js'),
      'utf-8'
    );
    assert(/idleMindEnabled\s*=\s*settings\?\.get\?\.\('idleMind\.enabled'\)\s*!==\s*false/.test(src),
      'expected idleMindEnabled check');
  });

  await test('#2 AgentCoreWire source: wires runtime toggle listeners', () => {
    const src = fs.readFileSync(
      path.join(__dirname, '..', '..', 'src', 'agent', 'AgentCoreWire.js'),
      'utf-8'
    );
    assert(/settings:daemon-toggled/.test(src), 'expected daemon-toggled listener');
    assert(/settings:idlemind-toggled/.test(src), 'expected idlemind-toggled listener');
    assert(/settings:selfmod-toggled/.test(src), 'expected selfmod-toggled listener');
    assert(/settings:trust-level-changed/.test(src), 'expected trust-level listener');
  });

  // ── #3: SelfMod gate ────────────────────────────────────────
  await test('#3 SelfModificationPipeline.modify() blocks when allowSelfModify=false', async () => {
    const { SelfModificationPipeline } = require('../../src/agent/hexagonal/SelfModificationPipeline');
    const pipeline = new SelfModificationPipeline({
      bus: { emit: () => {} },
      lang: { t: (k) => k },
      selfModel: null, model: null, prompts: null, sandbox: null,
      reflector: null, skills: null, cloner: null, reasoning: null,
      hotReloader: null, guard: null, tools: null, eventStore: null,
      rootDir: '/tmp', astDiff: null,
    });
    pipeline._settings = { get: (k) => k === 'security.allowSelfModify' ? false : undefined };
    const result = await pipeline.modify('change something');
    assert(typeof result === 'string', `expected string result, got: ${typeof result}`);
    assert(/blockiert|blocked/i.test(result), `expected blocked message, got: ${result.slice(0, 100)}`);
  });

  await test('#3 SelfModificationPipeline.modify() does NOT block when allowSelfModify=true', async () => {
    const { SelfModificationPipeline } = require('../../src/agent/hexagonal/SelfModificationPipeline');
    const pipeline = new SelfModificationPipeline({
      bus: { emit: () => {} },
      lang: { t: (k) => k },
      selfModel: null, model: null, prompts: null, sandbox: null,
      reflector: null, skills: null, cloner: null, reasoning: null,
      hotReloader: null, guard: null, tools: null, eventStore: null,
      rootDir: '/tmp', astDiff: null,
    });
    pipeline._settings = { get: (k) => k === 'security.allowSelfModify' ? true : undefined };
    // We don't expect this to succeed (no real services). The point is
    // it should NOT short-circuit with the settings-blocked message.
    let result;
    try { result = await pipeline.modify('change something'); }
    catch (_e) { /* downstream null-deref is fine — gate didn't fire */ return; }
    if (typeof result === 'string') {
      assert(!/Selbst-Modifikation blockiert.*Einstellungen/i.test(result),
        `should not be settings-blocked, got: ${result.slice(0, 100)}`);
    }
  });

  await test('#3 SelfModificationPipeline.modify() does NOT block when settings absent', async () => {
    const { SelfModificationPipeline } = require('../../src/agent/hexagonal/SelfModificationPipeline');
    const pipeline = new SelfModificationPipeline({
      bus: { emit: () => {} },
      lang: { t: (k) => k },
      selfModel: null, model: null, prompts: null, sandbox: null,
      reflector: null, skills: null, cloner: null, reasoning: null,
      hotReloader: null, guard: null, tools: null, eventStore: null,
      rootDir: '/tmp', astDiff: null,
    });
    // No _settings — should fall through (allow), not block
    let result;
    try { result = await pipeline.modify('change something'); }
    catch (_e) { return; /* downstream failure is fine */ }
    if (typeof result === 'string') {
      assert(!/Selbst-Modifikation blockiert.*Einstellungen/i.test(result),
        `should not be settings-blocked, got: ${result.slice(0, 100)}`);
    }
  });

  // ── #4: UI source-presence ──────────────────────────────────
  await test('#4 index.bundled.html has all 4 new settings fields', () => {
    const html = fs.readFileSync(
      path.join(__dirname, '..', '..', 'src', 'ui', 'index.bundled.html'),
      'utf-8'
    );
    assert(html.includes('id="set-trust-level"'), 'missing set-trust-level');
    assert(html.includes('id="set-auto-resume"'), 'missing set-auto-resume');
    assert(html.includes('id="set-mcp-serve"'), 'missing set-mcp-serve');
    assert(html.includes('id="set-mcp-port"'), 'missing set-mcp-port');
    assert(html.includes('id="set-approval-timeout"'), 'missing set-approval-timeout');
  });

  await test('#4 settings.js loads the 4 new settings keys', () => {
    const src = fs.readFileSync(
      path.join(__dirname, '..', '..', 'src', 'ui', 'modules', 'settings.js'),
      'utf-8'
    );
    assert(/s\?\.trust\?\.level/.test(src), 'missing trust.level load');
    assert(/s\?\.agency\?\.autoResumeGoals/.test(src), 'missing agency.autoResumeGoals load');
    assert(/s\?\.mcp\?\.serve\?\.enabled/.test(src), 'missing mcp.serve.enabled load');
    assert(/s\?\.timeouts\?\.approvalSec/.test(src), 'missing timeouts.approvalSec load');
  });

  await test('#4 settings.js saves the 4 new settings keys', () => {
    const src = fs.readFileSync(
      path.join(__dirname, '..', '..', 'src', 'ui', 'modules', 'settings.js'),
      'utf-8'
    );
    assert(/'trust\.level'/.test(src), 'missing trust.level save');
    assert(/'agency\.autoResumeGoals'/.test(src), 'missing agency.autoResumeGoals save');
    assert(/'mcp\.serve\.enabled'/.test(src), 'missing mcp.serve.enabled save');
    assert(/'mcp\.serve\.port'/.test(src), 'missing mcp.serve.port save');
    assert(/'timeouts\.approvalSec'/.test(src), 'missing timeouts.approvalSec save');
  });

  // ── #5: Default shape ───────────────────────────────────────
  await test('#5 Settings defaults include trust.level=1', () => {
    const { Settings } = require('../../src/agent/foundation/Settings');
    const settings = new Settings(tmpDir, null);
    const v = settings.get('trust.level');
    assert(v === 1, `expected 1 (ASSISTED), got ${v}`);
  });

  await test('#5 Settings defaults include agency.autoResumeGoals="ask"', () => {
    const { Settings } = require('../../src/agent/foundation/Settings');
    const settings = new Settings(tmpDir, null);
    const v = settings.get('agency.autoResumeGoals');
    assert(v === 'ask', `expected "ask", got ${v}`);
  });

  await test('#5 Settings defaults include mcp.serve.{enabled,port}', () => {
    const { Settings } = require('../../src/agent/foundation/Settings');
    const settings = new Settings(tmpDir, null);
    assert(settings.get('mcp.serve.enabled') === false, 'enabled default mismatch');
    assert(settings.get('mcp.serve.port') === 3580, 'port default mismatch');
  });

  await test('#5 Settings defaults include timeouts.approvalSec=60', () => {
    const { Settings } = require('../../src/agent/foundation/Settings');
    const settings = new Settings(tmpDir, null);
    assert(settings.get('timeouts.approvalSec') === 60, 'approvalSec default mismatch');
  });

  // ── #6: Manifest wiring ─────────────────────────────────────
  await test('#6 phase5-hexagonal lateBinds settings to selfModPipeline', () => {
    const src = fs.readFileSync(
      path.join(__dirname, '..', '..', 'src', 'agent', 'manifest', 'phase5-hexagonal.js'),
      'utf-8'
    );
    // The settings lateBinding must appear inside the selfModPipeline block
    const idx = src.indexOf("'selfModPipeline'");
    assert(idx > 0, 'selfModPipeline block not found');
    const blockEnd = src.indexOf('}],', idx);
    const block = src.slice(idx, blockEnd);
    assert(/_settings.*service:\s*'settings'/.test(block),
      `expected _settings lateBinding inside selfModPipeline block, got:\n${block.slice(0, 800)}`);
  });

  // ── Summary ──
  console.log(`\n  ${passed} passed, ${failed} failed`);
  if (failures.length > 0) {
    console.log('\n  Failures:');
    failures.forEach(f => console.log(`    - ${f.name}: ${f.error}`));
    process.exit(1);
  }
})();
