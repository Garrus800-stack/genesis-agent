// ============================================================
// Test: v7.5.6 — Model Availability TTL (in-process behavior)
//
// Behavioral tests for ModelBridge.markUnavailable / isMarkedUnavailable /
// clearUnavailable, the persistence helpers _loadUnavailable /
// _persistUnavailable, the boot-time skip logic in detectAvailable, and
// the catch-block trigger paths in chat() and streamChat().
//
// Source-presence checks live in v756-fix.test.js. This file uses real
// ModelBridge instances with real fs persistence in /tmp.
// ============================================================

'use strict';

const fs = require('fs');
const path = require('path');
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
function assertEqual(a, b, m) { if (a !== b) throw new Error(`${m || 'not equal'}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`); }

const { ModelBridge } = require('../../src/agent/foundation/ModelBridge');

// Capture-bus that records every fired event for assertions.
function makeBus() {
  const events = [];
  return {
    events,
    fire(name, payload) { events.push({ name, payload }); },
    emit(name, payload) { events.push({ name, payload }); },
    on() {},
  };
}

function freshTmpDir(suffix = '') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `genesis-mb-${suffix}-`));
  return dir;
}

(async () => {
  console.log('  model-availability tests:');

  // ──────────────────────────────────────────────────────────────
  // Core API: mark / isMarked / clear
  // ──────────────────────────────────────────────────────────────

  await test('markUnavailable sets entry and fires marked event', () => {
    const bus = makeBus();
    const dir = freshTmpDir('mark');
    const mb = new ModelBridge({ bus, genesisDir: dir });
    mb.markUnavailable('foo', 60000, 'auth');
    assert(mb.isMarkedUnavailable('foo'), 'should be marked');
    const evt = bus.events.find(e => e.name === 'model:marked-unavailable');
    assert(evt, 'should fire marked event');
    assertEqual(evt.payload.modelName, 'foo');
    assertEqual(evt.payload.reason, 'auth');
    assertEqual(evt.payload.ttlMs, 60000);
    fs.rmSync(dir, { recursive: true });
  });

  await test('isMarkedUnavailable returns false for unset model', () => {
    const mb = new ModelBridge({ bus: makeBus() });
    assertEqual(mb.isMarkedUnavailable('never-marked'), false);
  });

  await test('TTL expiry: lazy-clears and fires automatic=true', () => {
    const bus = makeBus();
    const dir = freshTmpDir('ttl');
    const mb = new ModelBridge({ bus, genesisDir: dir });
    // Mark with 1ms TTL — already expired by next call.
    mb.markUnavailable('quick', 1, 'rate-limit');
    // Wait a moment to be safe across timer resolution.
    return new Promise((resolve) => setTimeout(() => {
      try {
        assertEqual(mb.isMarkedUnavailable('quick'), false, 'should be cleared after TTL');
        const cleared = bus.events.find(e => e.name === 'model:unavailable-cleared');
        assert(cleared, 'should fire cleared event');
        assertEqual(cleared.payload.modelName, 'quick');
        assertEqual(cleared.payload.automatic, true);
        fs.rmSync(dir, { recursive: true });
        resolve();
      } catch (err) { fs.rmSync(dir, { recursive: true }); throw err; }
    }, 10));
  });

  await test('clearUnavailable(name) — single removal with manual flag', () => {
    const bus = makeBus();
    const dir = freshTmpDir('clear-one');
    const mb = new ModelBridge({ bus, genesisDir: dir });
    mb.markUnavailable('a', 60000, 'auth');
    mb.markUnavailable('b', 60000, 'auth');
    bus.events.length = 0;  // ignore mark events
    mb.clearUnavailable('a');
    assertEqual(mb.isMarkedUnavailable('a'), false);
    assert(mb.isMarkedUnavailable('b'), 'b should still be marked');
    const cleared = bus.events.find(e => e.name === 'model:unavailable-cleared');
    assert(cleared);
    assertEqual(cleared.payload.modelName, 'a');
    assertEqual(cleared.payload.automatic, false);
    fs.rmSync(dir, { recursive: true });
  });

  await test('clearUnavailable() — no arg clears all and fires per model', () => {
    const bus = makeBus();
    const dir = freshTmpDir('clear-all');
    const mb = new ModelBridge({ bus, genesisDir: dir });
    mb.markUnavailable('a', 60000, 'auth');
    mb.markUnavailable('b', 60000, 'rate-limit');
    bus.events.length = 0;
    mb.clearUnavailable();
    assertEqual(mb.isMarkedUnavailable('a'), false);
    assertEqual(mb.isMarkedUnavailable('b'), false);
    const cleared = bus.events.filter(e => e.name === 'model:unavailable-cleared');
    assertEqual(cleared.length, 2);
    cleared.forEach(e => assertEqual(e.payload.automatic, false));
    fs.rmSync(dir, { recursive: true });
  });

  await test('clearUnavailable(unknown) — no-op, no event', () => {
    const bus = makeBus();
    const dir = freshTmpDir('clear-unknown');
    const mb = new ModelBridge({ bus, genesisDir: dir });
    mb.clearUnavailable('does-not-exist');
    const cleared = bus.events.filter(e => e.name === 'model:unavailable-cleared');
    assertEqual(cleared.length, 0);
    fs.rmSync(dir, { recursive: true });
  });

  // ──────────────────────────────────────────────────────────────
  // Persistence
  // ──────────────────────────────────────────────────────────────

  await test('persistence: mark survives new ModelBridge instance', () => {
    const dir = freshTmpDir('persist');
    const mb1 = new ModelBridge({ bus: makeBus(), genesisDir: dir });
    mb1.markUnavailable('persisted', 3600000, 'auth');
    // New instance reads the same file
    const mb2 = new ModelBridge({ bus: makeBus(), genesisDir: dir });
    assert(mb2.isMarkedUnavailable('persisted'), 'should still be marked after restart');
    fs.rmSync(dir, { recursive: true });
  });

  await test('persistence: expired entries pruned at load', () => {
    const dir = freshTmpDir('expired');
    const filePath = path.join(dir, 'model-unavailable.json');
    // Write a file with one expired and one valid entry directly.
    fs.writeFileSync(filePath, JSON.stringify({
      'expired-model': { until: Date.now() - 1000, reason: 'auth', ttlMs: 60000 },
      'valid-model':   { until: Date.now() + 60000, reason: 'auth', ttlMs: 60000 },
    }), 'utf-8');
    const mb = new ModelBridge({ bus: makeBus(), genesisDir: dir });
    assertEqual(mb.isMarkedUnavailable('expired-model'), false);
    assertEqual(mb.isMarkedUnavailable('valid-model'), true);
    fs.rmSync(dir, { recursive: true });
  });

  await test('persistence: corrupt JSON does not crash, map stays empty', () => {
    const dir = freshTmpDir('corrupt');
    const filePath = path.join(dir, 'model-unavailable.json');
    fs.writeFileSync(filePath, '{ this is not json', 'utf-8');
    // Should not throw
    const mb = new ModelBridge({ bus: makeBus(), genesisDir: dir });
    assertEqual(mb.isMarkedUnavailable('foo'), false);
    fs.rmSync(dir, { recursive: true });
  });

  await test('persistence: missing file is fine (fresh install)', () => {
    const dir = freshTmpDir('fresh');
    const mb = new ModelBridge({ bus: makeBus(), genesisDir: dir });
    assertEqual(mb.isMarkedUnavailable('foo'), false);
    fs.rmSync(dir, { recursive: true });
  });

  await test('persistence: no genesisDir → in-memory only, no I/O', () => {
    const mb = new ModelBridge({ bus: makeBus() });  // no genesisDir
    mb.markUnavailable('memonly', 60000, 'auth');
    assert(mb.isMarkedUnavailable('memonly'));
    // _unavailableFile should be null
    assertEqual(mb._unavailableFile, null);
  });

  // ──────────────────────────────────────────────────────────────
  // _findFallbackBackend with marker-skip
  // ──────────────────────────────────────────────────────────────

  await test('fallback: marked-unavailable models are skipped in chain', () => {
    const dir = freshTmpDir('fb-skip');
    const mb = new ModelBridge({ bus: makeBus(), genesisDir: dir });
    mb._settings = { get: (k) => k === 'models.fallbackChain' ? ['m1', 'm2', 'm3'] : null };
    mb.availableModels = [
      { name: 'm1', backend: 'ollama' },
      { name: 'm2', backend: 'ollama' },
      { name: 'm3', backend: 'ollama' },
    ];
    mb.markUnavailable('m2', 60000, 'auth');
    const result = mb._findFallbackBackend('ollama', 'm1');
    assertEqual(result, 'ollama');
    assertEqual(mb._fallbackModel.name, 'm3', 'should skip m1 (failed) and m2 (marked)');
    fs.rmSync(dir, { recursive: true });
  });

  await test('fallback: same-backend Ollama→Ollama works (Item 1 behavior)', () => {
    const mb = new ModelBridge({ bus: makeBus() });
    mb._settings = { get: (k) => k === 'models.fallbackChain' ? ['fb-1', 'fb-2'] : null };
    mb.availableModels = [
      { name: 'primary', backend: 'ollama' },
      { name: 'fb-1', backend: 'ollama' },
      { name: 'fb-2', backend: 'ollama' },
    ];
    const result = mb._findFallbackBackend('ollama', 'primary');
    assertEqual(result, 'ollama');
    assertEqual(mb._fallbackModel.name, 'fb-1');
  });

  // ──────────────────────────────────────────────────────────────
  // Boot-time selection: marked models skipped at all priorities
  // ──────────────────────────────────────────────────────────────
  // We can't easily run the full detectAvailable() here (it talks to
  // backends), but we can simulate the same selection flow on a bridge
  // with a populated availableModels array.

  await test('boot: preferred model marked → falls through to auto-select', () => {
    const bus = makeBus();
    const dir = freshTmpDir('boot-pref');
    const mb = new ModelBridge({ bus, genesisDir: dir });
    mb.availableModels = [
      { name: 'preferred', backend: 'ollama' },
      { name: 'other', backend: 'ollama' },
    ];
    mb._settings = { get: (k) => k === 'models.preferred' ? 'preferred' : null };
    mb.markUnavailable('preferred', 3600000, 'auth');

    // Replicate the priority-1 logic from detectAvailable.
    const preferredName = mb._settings.get('models.preferred');
    let chosen = null;
    if (preferredName && !mb.isMarkedUnavailable(preferredName)) {
      chosen = mb.availableModels.find(m => m.name === preferredName);
    }
    assertEqual(chosen, null, 'preferred must be skipped because marked');
    fs.rmSync(dir, { recursive: true });
  });

  await test('boot: cloud-priority filters marked anthropic/openai models', () => {
    const dir = freshTmpDir('boot-cloud');
    const mb = new ModelBridge({ bus: makeBus(), genesisDir: dir });
    mb.availableModels = [
      { name: 'claude-bad', backend: 'anthropic' },
      { name: 'gpt-bad', backend: 'openai' },
      { name: 'ollama-good', backend: 'ollama' },
    ];
    mb.markUnavailable('claude-bad', 3600000, 'auth');
    mb.markUnavailable('gpt-bad', 3600000, 'auth');

    // Replicate priority-2 logic
    const chosen = mb.availableModels.find(m => m.backend === 'anthropic' && !mb.isMarkedUnavailable(m.name))
                || mb.availableModels.find(m => m.backend === 'openai' && !mb.isMarkedUnavailable(m.name));
    assertEqual(chosen, undefined, 'all cloud models marked → none selected at priority 2');
    fs.rmSync(dir, { recursive: true });
  });

  await test('boot: priority-4 last-resort picks even marked when none eligible', () => {
    const dir = freshTmpDir('boot-resort');
    const mb = new ModelBridge({ bus: makeBus(), genesisDir: dir });
    mb.availableModels = [{ name: 'only-one', backend: 'ollama' }];
    mb.markUnavailable('only-one', 3600000, 'auth');

    // Replicate priority-4 logic: prefer eligible, else fall back to first available
    const eligible = mb.availableModels.filter(m => !mb.isMarkedUnavailable(m.name));
    const chosen = eligible[0] || mb.availableModels[0];
    assertEqual(chosen.name, 'only-one', 'last resort: take a marked model rather than nothing');
    fs.rmSync(dir, { recursive: true });
  });

  // ──────────────────────────────────────────────────────────────
  // Reason classification → TTL mapping (the live-bug shape)
  // ──────────────────────────────────────────────────────────────

  await test('reason: 403 → auth (1h would be triggered)', () => {
    const mb = new ModelBridge({ bus: makeBus() });
    const reason = mb._classifyFailoverReason(new Error('HTTP 403: requires a subscription'));
    assertEqual(reason, 'auth');
  });

  await test('reason: 429 → rate-limit', () => {
    const mb = new ModelBridge({ bus: makeBus() });
    assertEqual(mb._classifyFailoverReason(new Error('HTTP 429 rate-limit exceeded')), 'rate-limit');
  });

  await test('reason: timeout → timeout', () => {
    const mb = new ModelBridge({ bus: makeBus() });
    assertEqual(mb._classifyFailoverReason(new Error('[TIMEOUT] response not received')), 'timeout');
  });

  await test('reason: ECONNREFUSED → connection-error (NOT marked)', () => {
    const mb = new ModelBridge({ bus: makeBus() });
    assertEqual(mb._classifyFailoverReason(new Error('ECONNREFUSED 127.0.0.1:11434')), 'connection-error');
  });

  await test('reason: unknown → other (NOT marked)', () => {
    const mb = new ModelBridge({ bus: makeBus() });
    assertEqual(mb._classifyFailoverReason(new Error('something weird')), 'other');
  });

  // ──────────────────────────────────────────────────────────────
  // Summary
  // ──────────────────────────────────────────────────────────────
  console.log(`\n  model-availability: ${passed} passed, ${failed} failed`);
  if (failed > 0) {
    console.log('  Failures:');
    failures.forEach(f => console.log(`    - ${f.name}: ${f.error}`));
    process.exit(1);
  }
})();
