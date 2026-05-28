#!/usr/bin/env node
// ============================================================
// GENESIS — test/modules/v7912-idlemind-rest-mode.contract.test.js
//
// v7.9.12: IdleMind rest-mode. When all models are marked unavailable,
// IdleMind stops picking LLM-backed activities (which would only fail and
// accumulate frustration) and idles until a model recovers.
//
// Under test:
//   - _enterRestMode is idempotent: event + InnerSpeech note fire once per
//     transition, not per skipped tick
//   - _exitRestMode is idempotent: only acts on the transition out
//   - the model:unavailable-cleared listener triggers _exitRestMode
//   - the rest-mode InnerSpeech note uses kind 'rest-mode' (PSE-private)
//   - _think() short-circuits (no thoughtCount++, no idle:cycle-start) when
//     all models are unavailable
// ============================================================

'use strict';

const { describe, test, assert, assertEqual, run } = require('../harness');
const path = require('path');
const os = require('os');
const fs = require('fs');

const { IdleMind } = require('../../src/agent/autonomy/IdleMind');
const { createBus } = require('../../src/agent/core/EventBus');

const tmpDir = path.join(os.tmpdir(), `genesis-restmode-${Date.now()}`);
fs.mkdirSync(tmpDir, { recursive: true });

function makeMockStorage() {
  const files = new Map();
  return {
    files,
    writeJSONDebounced(f, p) { files.set(f, JSON.parse(JSON.stringify(p))); },
    writeJSON(f, p) { files.set(f, JSON.parse(JSON.stringify(p))); },
    readJSON(f, fb) { return files.has(f) ? files.get(f) : fb; },
    readText(f, fb) { return files.has(f) ? JSON.stringify(files.get(f)) : fb; },
    appendText() {},
  };
}

// Model stub with a controllable areAllModelsUnavailable result.
function makeModelStub(allUnavailable, modelCount = 2) {
  return {
    activeModel: 'stub-model',
    availableModels: Array.from({ length: modelCount }, (_, i) => ({ name: `m${i}`, backend: 'ollama' })),
    areAllModelsUnavailable: () => allUnavailable,
  };
}

function makeIdle({ bus, model, innerSpeech }) {
  return new IdleMind({
    bus,
    model,
    prompts: null, selfModel: null, memory: null,
    knowledgeGraph: null, eventStore: null,
    storageDir: tmpDir, goalStack: null, intervals: null,
    storage: makeMockStorage(),
  });
}

describe('v7.9.12 — IdleMind rest-mode', () => {

  test('_enterRestMode is idempotent — fires once per transition', () => {
    const bus = createBus();
    const entered = [];
    bus.on('model:rest-mode-entered', (d) => entered.push(d), { source: 'test' });
    const emitted = [];
    const idle = makeIdle({ bus, model: makeModelStub(true) });
    idle.innerSpeech = { emit: (text, kind, meta) => { emitted.push({ text, kind, meta }); return { id: 'x' }; } };

    idle._enterRestMode();
    idle._enterRestMode(); // second call must be a no-op
    idle._enterRestMode();

    assertEqual(entered.length, 1, 'rest-mode-entered fires exactly once');
    assertEqual(entered[0].modelCount, 2, 'modelCount carried in payload');
    assertEqual(emitted.length, 1, 'InnerSpeech note emitted exactly once');
    assertEqual(emitted[0].kind, 'rest-mode', 'InnerSpeech kind is rest-mode (PSE-private)');
    assert(idle._inRestMode, '_inRestMode flag is set');
  });

  test('_exitRestMode is idempotent and only acts after entering', () => {
    const bus = createBus();
    const exited = [];
    bus.on('model:rest-mode-exited', (d) => exited.push(d), { source: 'test' });
    const idle = makeIdle({ bus, model: makeModelStub(true) });
    idle.innerSpeech = { emit: () => ({ id: 'x' }) };

    // exit without prior enter → no-op
    idle._exitRestMode('m0');
    assertEqual(exited.length, 0, 'exit before enter is a no-op');

    idle._enterRestMode();
    idle._exitRestMode('m0');
    idle._exitRestMode('m0'); // second exit → no-op

    assertEqual(exited.length, 1, 'rest-mode-exited fires exactly once');
    assertEqual(exited[0].modelName, 'm0', 'recovered model name carried');
    assert(!idle._inRestMode, '_inRestMode flag cleared');
  });

  test('model:unavailable-cleared listener exits rest-mode', () => {
    const bus = createBus();
    const exited = [];
    bus.on('model:rest-mode-exited', (d) => exited.push(d), { source: 'test' });
    const idle = makeIdle({ bus, model: makeModelStub(true) });
    idle.innerSpeech = { emit: () => ({ id: 'x' }) };

    idle._enterRestMode();
    assert(idle._inRestMode, 'in rest-mode after enter');

    // Simulate a model recovering
    bus.fire('model:unavailable-cleared', { modelName: 'm1', automatic: true }, { source: 'test' });

    assert(!idle._inRestMode, 'listener cleared rest-mode');
    assertEqual(exited.length, 1, 'exit event fired via listener');
    assertEqual(exited[0].modelName, 'm1', 'listener passed recovered model name');
  });

  test('_think short-circuits when all models unavailable', async () => {
    const bus = createBus();
    const cycleStarts = [];
    bus.on('idle:cycle-start', (d) => cycleStarts.push(d), { source: 'test' });
    const idle = makeIdle({ bus, model: makeModelStub(true) });
    idle.innerSpeech = { emit: () => ({ id: 'x' }) };
    // Force past the user-activity gate
    idle.lastUserActivity = Date.now() - 10 * 60 * 1000;

    const before = idle.thoughtCount;
    await idle._think();

    assertEqual(idle.thoughtCount, before, 'thoughtCount NOT incremented in rest-mode');
    assertEqual(cycleStarts.length, 0, 'idle:cycle-start NOT fired in rest-mode');
    assert(idle._inRestMode, '_think entered rest-mode');
  });

  test('_think proceeds normally and clears rest-mode when models available', async () => {
    const bus = createBus();
    const idle = makeIdle({ bus, model: makeModelStub(false) });
    idle.innerSpeech = { emit: () => ({ id: 'x' }) };
    idle.lastUserActivity = Date.now() - 10 * 60 * 1000;

    // Pretend we were resting, then a tick finds models available
    idle._inRestMode = true;
    const before = idle.thoughtCount;
    await idle._think();

    assert(!idle._inRestMode, '_think cleared stale rest-mode');
    assert(idle.thoughtCount > before, 'thoughtCount incremented when models available');
  });

  test('rest-mode kind is PSE-private (HardGates blocks it)', () => {
    // Privacy guarantee: a rest-mode InnerSpeech note must never reach the
    // user through the PSE pipeline, regardless of settings.
    const { runGates, PRIVATE_KINDS } = require('../../src/agent/cognitive/proactiveSelfExpression/HardGates');
    assert(PRIVATE_KINDS.has('rest-mode'), "'rest-mode' must be in PRIVATE_KINDS");
    const result = runGates(
      { kind: 'rest-mode', text: 'resting — no model available', significance: 1, novelty: 1 },
      { now: Date.now(), allowedKinds: ['rest-mode'], perKindFloor: {} }, // even if allowed
      { enabled: true } // even if PSE globally enabled
    );
    assertEqual(result.ok, false, 'rest-mode thought must be blocked');
    assertEqual(result.reason, 'private-kind', 'block reason is private-kind');
  });

});

if (require.main === module) run();
