// ============================================================
// TEST — DirectedCuriosity (v6.0.8)
// IdleMind weakness-aware exploration scorer + targeted explore
// ============================================================

const { describe, test, run } = require('../harness');
const path = require('path');
const os = require('os');
const fs = require('fs');

// Inline require to avoid circular deps
const { IdleMind } = require('../../src/agent/autonomy/IdleMind');

// ── Minimal mocks ────────────────────────────────────────────
const tmpDir = path.join(os.tmpdir(), `genesis-dc-test-${Date.now()}`);
fs.mkdirSync(tmpDir, { recursive: true });
function mockBus() {
  const events = [];
  return {
    on: () => () => {},
    emit: (ev, data, meta) => events.push({ ev, data, meta }),
    fire: (ev, data, meta) => events.push({ ev, data, meta }),
    events,
    getEmitted: (name) => events.filter(e => e.ev === name),
  };
}

function mockModel() {
  return { chat: async () => 'mock insight', activeModel: 'test' };
}

function mockSelfModel(modules = []) {
  return {
    getModuleSummary: () => modules,
    readModule: (file) => `// mock code for ${file}`,
  };
}

function mockGenome(traits = {}) {
  return {
    trait: (name) => traits[name] ?? 0.5,
    getAll: () => traits,
  };
}

function mockCognitiveSelfModel(profile = {}) {
  return {
    getCapabilityProfile: () => profile,
  };
}

// ════════════════════════════════════════════════════════════

describe('DirectedCuriosity — weakness scorer', () => {
  test('_currentWeakness is set when weak areas exist', () => {
    const bus = mockBus();
    const im = new IdleMind({
      bus, model: mockModel(), prompts: {}, selfModel: mockSelfModel(), storageDir: tmpDir,
      memory: null, knowledgeGraph: null, eventStore: null,
    });
    im._genome = mockGenome({ curiosity: 0.7 });
    im._cognitiveSelfModel = mockCognitiveSelfModel({
      'debug':   { successRate: 0.3, sampleSize: 10, isWeak: true, isStrong: false },
      'analysis': { successRate: 0.8, sampleSize: 10, isWeak: false, isStrong: true },
    });

    // _pickActivity triggers scorers including the directed curiosity one
    const activity = im._pickActivity([]);
    // _currentWeakness should be set to the weakest area
    if (!im._currentWeakness) throw new Error('Should set _currentWeakness when weak areas exist');
    if (im._currentWeakness[0] !== 'debug') throw new Error(`Expected weakest='debug', got '${im._currentWeakness[0]}'`);
  });

  test('_currentWeakness is null without cognitiveSelfModel', () => {
    const bus = mockBus();
    const im = new IdleMind({
      bus, model: mockModel(), prompts: {}, selfModel: mockSelfModel(), storageDir: tmpDir,
      memory: null, knowledgeGraph: null, eventStore: null,
    });
    im._genome = mockGenome();
    im._cognitiveSelfModel = null;

    im._pickActivity([]);
    if (im._currentWeakness !== null) throw new Error('Should be null without cognitiveSelfModel');
  });

  test('_currentWeakness is null when no weak areas', () => {
    const bus = mockBus();
    const im = new IdleMind({
      bus, model: mockModel(), prompts: {}, selfModel: mockSelfModel(), storageDir: tmpDir,
      memory: null, knowledgeGraph: null, eventStore: null,
    });
    im._genome = mockGenome();
    im._cognitiveSelfModel = mockCognitiveSelfModel({
      'debug':    { successRate: 0.9, sampleSize: 10, isWeak: false, isStrong: true },
      'analysis': { successRate: 0.8, sampleSize: 10, isWeak: false, isStrong: true },
    });

    im._pickActivity([]);
    if (im._currentWeakness !== null) throw new Error('Should be null when no weak areas');
  });
});

describe('DirectedCuriosity — targeted explore', () => {
  test('targets FailureAnalyzer when debug is weak', async () => {
    const bus = mockBus();
    const modules = [
      { file: 'FailureAnalyzer.js', classes: ['FailureAnalyzer'], functions: 10, protected: false },
      { file: 'CodeAnalyzer.js', classes: ['CodeAnalyzer'], functions: 8, protected: false },
      { file: 'ShellAgent.js', classes: ['ShellAgent'], functions: 12, protected: false },
    ];
    const im = new IdleMind({
      bus, model: mockModel(), prompts: {}, selfModel: mockSelfModel(modules), storageDir: tmpDir,
      memory: null, knowledgeGraph: null, eventStore: null,
    });
    im._currentWeakness = ['debug', { successRate: 0.3, isWeak: true }];

    const result = await im._explore();
    if (!result) throw new Error('Should return an insight');
    // Verify curiosity-targeted event was emitted
    const events = bus.getEmitted('idle:curiosity-targeted');
    if (events.length === 0) throw new Error('Should emit idle:curiosity-targeted');
    if (events[0].data.weakness !== 'debug') throw new Error('Event should include weakness type');
  });

  test('falls back to random when no matching modules', async () => {
    const bus = mockBus();
    const modules = [
      { file: 'UnrelatedModule.js', classes: ['Unrelated'], functions: 5, protected: false },
    ];
    const im = new IdleMind({
      bus, model: mockModel(), prompts: {}, selfModel: mockSelfModel(modules), storageDir: tmpDir,
      memory: null, knowledgeGraph: null, eventStore: null,
    });
    im._currentWeakness = ['debug', { successRate: 0.3, isWeak: true }];

    const result = await im._explore();
    if (!result) throw new Error('Should fall back to random module and still produce insight');
  });
});

run();
