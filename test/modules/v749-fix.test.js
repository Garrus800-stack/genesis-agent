// ============================================================
// Test: v7.4.9 — Dead-Wiring Cleanup
//
// v7.4.9 removed two dead listeners that had no senders:
//   - permission:granted (GoalDriver) — forward-declared concept
//     in v7.4.5 "Baustein C" that was never built. No emit site
//     existed; goals don't pause on permission-wait granular state.
//   - deploy:request (DeploymentManager) — superseded by direct
//     deploy() calls (e.g. AutoUpdater.js:142). No senders existed.
//
// Plus removed: PERMISSION namespace from EventTypes, DEPLOY.REQUEST
// catalog entry, both schema entries, AutonomyEvents.onDeployRequest
// helper.
//
// Kept: colony:run-request listener (ColonyOrchestrator). Genuine
// opt-in feature awaiting multi-agent activation, documented in
// AUDIT-BACKLOG as intentional pending wire.
//
// These source-presence tests prevent regression — if anyone re-adds
// these listeners without a sender, tests turn red.
// ============================================================

'use strict';

const path = require('path');
const fs = require('fs');

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

const ROOT = path.join(__dirname, '..', '..');

(async () => {
  console.log('  v749-fix tests:');

  // ──────────────────────────────────────────────────────────────
  // Listener removals
  // ──────────────────────────────────────────────────────────────

  await test('A1 GoalDriver no longer subscribes to permission:granted', () => {
    const src = fs.readFileSync(path.join(ROOT, 'src/agent/agency/GoalDriver.js'), 'utf8');
    assert(!src.includes("'permission:granted'"),
      'GoalDriver must not subscribe to permission:granted');
    assert(!src.includes('_onPermissionGranted'),
      '_onPermissionGranted method should be removed');
  });

  await test('A2 DeploymentManager no longer subscribes to deploy:request', () => {
    const src = fs.readFileSync(path.join(ROOT, 'src/agent/autonomy/DeploymentManager.js'), 'utf8');
    // The comment that says listener was removed is allowed (history note);
    // what matters is that no actual _sub call references the event.
    const hasActiveSub = /_sub\(\s*['"]deploy:request['"]/.test(src);
    assert(!hasActiveSub, 'DeploymentManager must not have active _sub on deploy:request');
    assert(!src.includes('_handleDeployRequest'),
      '_handleDeployRequest method should be removed');
  });

  await test('A3 AutonomyEvents no longer exposes onDeployRequest helper', () => {
    const src = fs.readFileSync(path.join(ROOT, 'src/agent/autonomy/AutonomyEvents.js'), 'utf8');
    assert(!src.includes('onDeployRequest'),
      'AutonomyEvents should not expose onDeployRequest helper');
  });

  // ──────────────────────────────────────────────────────────────
  // EventTypes catalog cleanup
  // ──────────────────────────────────────────────────────────────

  await test('B1 EventTypes no longer contains PERMISSION namespace', () => {
    const src = fs.readFileSync(path.join(ROOT, 'src/agent/core/EventTypes.js'), 'utf8');
    assert(!/PERMISSION:\s*Object\.freeze/.test(src),
      'PERMISSION namespace must be removed from EventTypes');
    assert(!src.includes("'permission:granted'"),
      'permission:granted must not appear in EventTypes');
    assert(!src.includes("'permission:denied'"),
      'permission:denied must not appear in EventTypes');
  });

  await test('B2 EventTypes DEPLOY namespace no longer has REQUEST', () => {
    const src = fs.readFileSync(path.join(ROOT, 'src/agent/core/EventTypes.js'), 'utf8');
    // The DEPLOY namespace should still exist (other deploy:* events used)
    assert(/DEPLOY:\s*Object\.freeze/.test(src),
      'DEPLOY namespace must still exist (rollback, swap, etc. are active)');
    // But REQUEST entry must be gone
    assert(!/REQUEST:\s*['"]deploy:request['"]/.test(src),
      'DEPLOY.REQUEST entry must be removed from EventTypes');
  });

  // ──────────────────────────────────────────────────────────────
  // Schema cleanup
  // ──────────────────────────────────────────────────────────────

  await test('C1 EventPayloadSchemas no longer has permission:granted/denied', () => {
    const src = fs.readFileSync(path.join(ROOT, 'src/agent/core/EventPayloadSchemas.js'), 'utf8');
    assert(!src.includes("'permission:granted'"),
      'permission:granted schema must be removed');
    assert(!src.includes("'permission:denied'"),
      'permission:denied schema must be removed');
  });

  await test('C2 EventPayloadSchemas no longer has deploy:request', () => {
    const src = fs.readFileSync(path.join(ROOT, 'src/agent/core/EventPayloadSchemas.js'), 'utf8');
    assert(!src.includes("'deploy:request'"),
      'deploy:request schema must be removed');
    // Sanity: other deploy:* schemas still present
    assert(src.includes("'deploy:started'"), 'deploy:started must still exist');
    assert(src.includes("'deploy:rollback'"), 'deploy:rollback must still exist');
  });

  // ──────────────────────────────────────────────────────────────
  // Functional sanity — modules still load and behave
  // ──────────────────────────────────────────────────────────────

  await test('D1 GoalDriver still loads and constructs', () => {
    const { GoalDriver } = require(path.join(ROOT, 'src/agent/agency/GoalDriver'));
    const { NullBus } = require(path.join(ROOT, 'src/agent/core/EventBus'));
    const driver = new GoalDriver({
      bus: NullBus,
      goalStack: { getActive: () => [], getById: () => null },
      goalPersistence: { resume: async () => [] },
      eventStore: { append: () => {} },
      settings: { get: () => null },
    });
    assert(driver, 'GoalDriver should construct');
    assert(typeof driver.asyncLoad === 'function', 'driver.asyncLoad() must exist');
    assert(typeof driver.stop === 'function', 'driver.stop() must exist');
    assert(typeof driver._onResourceAvailable === 'function',
      'resource handler still present');
    // Critical: removed handler must NOT be there
    assert(typeof driver._onPermissionGranted === 'undefined',
      '_onPermissionGranted must be removed (was: ' + typeof driver._onPermissionGranted + ')');
  });

  await test('D2 DeploymentManager still loads and constructs', () => {
    const { DeploymentManager } = require(path.join(ROOT, 'src/agent/autonomy/DeploymentManager'));
    const { NullBus } = require(path.join(ROOT, 'src/agent/core/EventBus'));
    const dm = new DeploymentManager({ bus: NullBus, rootDir: '/tmp', storage: null });
    assert(dm, 'DeploymentManager should construct');
    assert(typeof dm.deploy === 'function', 'deploy() must still exist');
  });

  await test('D3 ColonyOrchestrator listener intentionally retained', () => {
    // Documents-via-test that colony:run-request listener is intentional
    // (opt-in feature awaiting multi-agent activation, AUDIT-BACKLOG O-14).
    const src = fs.readFileSync(path.join(ROOT, 'src/agent/revolution/ColonyOrchestrator.js'), 'utf8');
    assert(src.includes("'colony:run-request'"),
      'ColonyOrchestrator should still subscribe to colony:run-request (opt-in feature)');
  });

  // ──────────────────────────────────────────────────────────────
  // EventStore projection cleanup (v7.4.9 second pass)
  //
  // Removed: errors, interactions, skill-usage projections (no
  // readers; duplicated by ErrorAggregator / LearningService.getMetrics).
  // SKILL_EXECUTED was never emitted by any code path.
  // Retained + capped: modifications projection (Cap=100, surfaced
  // through getHealth() so the dashboard can render it).
  // ──────────────────────────────────────────────────────────────

  await test('E1 EventStore.installDefaults — only modifications projection registered', () => {
    const src = fs.readFileSync(path.join(ROOT, 'src/agent/foundation/EventStore.js'), 'utf8');
    // Find installDefaults() body
    const m = src.match(/installDefaults\s*\(\s*\)\s*\{([\s\S]*?)\n\s{2}\}/);
    assert(m, 'installDefaults() body must be findable');
    const body = m[1];
    assert(body.includes("registerProjection('modifications'"),
      'modifications projection must remain registered');
    assert(!body.includes("registerProjection('errors'"),
      "errors projection must be removed");
    assert(!body.includes("registerProjection('interactions'"),
      "interactions projection must be removed");
    assert(!body.includes("registerProjection('skill-usage'"),
      "skill-usage projection must be removed");
  });

  await test('E2 modifications projection caps history at 100 entries', () => {
    const { EventStore } = require(path.join(ROOT, 'src/agent/foundation/EventStore'));
    const { NullBus } = require(path.join(ROOT, 'src/agent/core/EventBus'));
    const tmpDir = require('os').tmpdir() + '/genesis-v749-mod-cap-' + Date.now();
    require('fs').mkdirSync(tmpDir, { recursive: true });
    const es = new EventStore(tmpDir, NullBus, null);
    es.installDefaults();
    // Push 200 CODE_MODIFIED events synchronously via the projection apply path
    for (let i = 0; i < 200; i++) {
      es._applyProjections({
        id: 'evt-' + i, type: 'CODE_MODIFIED', isoTime: new Date().toISOString(),
        source: 'test', payload: { file: `f${i}.js`, success: true },
      });
    }
    const mods = es.getProjection('modifications');
    assert(mods.history.length === 100,
      `history must be capped at 100, got ${mods.history.length}`);
    assert(mods.totalModifications === 200,
      `totalModifications must count all 200, got ${mods.totalModifications}`);
    // Verify the kept entries are the LAST 100 (file f100 through f199)
    assert(mods.history[0].file === 'f100.js',
      `oldest kept entry must be f100.js, got ${mods.history[0].file}`);
    assert(mods.history[99].file === 'f199.js',
      `newest kept entry must be f199.js, got ${mods.history[99].file}`);
  });

  await test('E3 AgentCoreHealth.getHealth includes modifications field', () => {
    // Source-presence: getHealth surfaces modifications from eventStore projection.
    const src = fs.readFileSync(path.join(ROOT, 'src/agent/AgentCoreHealth.js'), 'utf8');
    assert(src.includes("modifications:") && src.includes("getProjection('modifications')"),
      'getHealth() must surface modifications via getProjection');
    // Must also have a safe default fallback when projection is missing
    assert(/modifications:[\s\S]{0,200}\|\| \{ history: \[\], totalModifications: 0 \}/.test(src),
      'getHealth() must provide safe default when projection is null');
  });

  await test('E4 Dashboard layout has dash-modifications-body section', () => {
    const src = fs.readFileSync(path.join(ROOT, 'src/ui/dashboard.js'), 'utf8');
    assert(src.includes('dash-modifications-body'),
      'Dashboard must declare dash-modifications-body div');
    assert(src.includes('Self-Modifications'),
      'Section header text "Self-Modifications" must exist');
    assert(src.includes('_renderModifications(health?.modifications)'),
      'refresh() must call _renderModifications');
  });

  await test('E5 _renderModifications handles null and empty input gracefully', () => {
    // Stub a Dashboard-like prototype, apply SystemRenderers, call _renderModifications
    function FakeDashboard() {}
    const apply = require(path.join(ROOT, 'src/ui/renderers/SystemRenderers'));
    apply(FakeDashboard);
    const dash = new FakeDashboard();
    // Stub _el and _esc to capture HTML
    const elements = {};
    dash._el = (id) => (elements[id] = elements[id] || { innerHTML: '' });
    dash._esc = (s) => String(s).replace(/[<>&"]/g, '');
    // Null input
    dash._renderModifications(null);
    assert(elements['dash-modifications-body'].innerHTML.includes('No modifications'),
      'null input must render empty state');
    // Empty history
    elements['dash-modifications-body'].innerHTML = '';
    dash._renderModifications({ history: [], totalModifications: 0 });
    assert(elements['dash-modifications-body'].innerHTML.includes('No modifications'),
      'empty history must render empty state');
    // Defensive copy: original array must not be mutated by renderer
    const original = [
      { file: 'a.js', timestamp: new Date().toISOString(), source: 'test', success: true },
      { file: 'b.js', timestamp: new Date().toISOString(), source: 'test', success: false },
    ];
    const beforeLen = original.length;
    dash._renderModifications({ history: original, totalModifications: 2 });
    assert(original.length === beforeLen,
      `renderer must not mutate input array (was ${beforeLen}, now ${original.length})`);
    assert(elements['dash-modifications-body'].innerHTML.includes('a.js'),
      'rendered HTML must contain file names');
  });

  // ──────────────────────────────────────────────────────────────
  // Summary
  // ──────────────────────────────────────────────────────────────

  console.log(`\n  v749-fix: ${passed} passed, ${failed} failed`);
  if (failed > 0) {
    console.log('  Failures:');
    for (const f of failures) console.log(`    - ${f.name}: ${f.error}`);
    process.exitCode = 1;
  }
})();
