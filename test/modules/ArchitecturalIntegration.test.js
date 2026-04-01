#!/usr/bin/env node
// ============================================================
// Test: v4.12.4 — Architectural Integration
//
// Tests all 6 points from the architecture analysis:
//   1. Consciousness → PromptBuilder wiring
//   2. ConsciousnessExtension bridge (buildPromptContext)
//   3. ValueStore (learned principles)
//   4. AgentLoopCognition.consultConsciousness()
//   5. UserModel (theory of mind)
//   6. BodySchema (embodiment awareness)
// ============================================================

const { describe, test, assert, assertEqual, run } = require('../harness');
const { NullBus } = require('../../src/agent/core/EventBus');
const { EventBus } = require('../../src/agent/core/EventBus');
const { PromptBuilder } = require('../../src/agent/intelligence/PromptBuilder');
const { ValueStore } = require('../../src/agent/planning/ValueStore');
const { UserModel } = require('../../src/agent/intelligence/UserModel');
const { BodySchema } = require('../../src/agent/organism/BodySchema');
const { AgentLoopCognitionDelegate } = require('../../src/agent/revolution/AgentLoopCognition');

// ── Helpers ──────────────────────────────────────────────────

function createPromptBuilder(overrides = {}) {
  return new PromptBuilder({
    selfModel: { manifest: { identity: 'genesis', version: '4.12.4', capabilities: [], modules: {} } },
    model: { activeModel: 'test-model' },
    skills: { listSkills: () => [] },
    knowledgeGraph: null,
    memory: null,
    ...overrides,
  });
}

function createValueStore(overrides = {}) {
  return new ValueStore({
    bus: NullBus,
    storage: null,
    config: {},
    ...overrides,
  });
}

function createUserModel(overrides = {}) {
  return new UserModel({
    bus: NullBus,
    storage: null,
    config: {},
    ...overrides,
  });
}

function createBodySchema(overrides = {}) {
  return new BodySchema({
    bus: NullBus,
    storage: null,
    config: {},
    ...overrides,
  });
}

// ═════════════════════════════════════════════════════════════
// 1. CONSCIOUSNESS → PROMPTBUILDER WIRING
// ═════════════════════════════════════════════════════════════

describe('PromptBuilder — Consciousness Integration', () => {
  test('has consciousness module slots', () => {
    const pb = createPromptBuilder();
    assert(pb.phenomenalField === null, 'phenomenalField slot should exist');
    assert(pb.attentionalGate === null, 'attentionalGate slot should exist');
    assert(pb.temporalSelf === null, 'temporalSelf slot should exist');
    assert(pb.introspectionEngine === null, 'introspectionEngine slot should exist');
    assert(pb.consciousnessExtension === null, 'consciousnessExtension slot should exist');
  });

  test('has new module slots (values, userModel, bodySchema)', () => {
    const pb = createPromptBuilder();
    assert(pb.valueStore === null, 'valueStore slot should exist');
    assert(pb.userModel === null, 'userModel slot should exist');
    assert(pb.bodySchema === null, 'bodySchema slot should exist');
  });

  test('_consciousnessContext returns empty when no modules wired', () => {
    const pb = createPromptBuilder();
    assertEqual(pb._consciousnessContext(), '');
  });

  test('_consciousnessContext aggregates wired modules', () => {
    const pb = createPromptBuilder();
    pb.phenomenalField = { buildPromptContext: () => 'EXPERIENCE: test gestalt' };
    pb.attentionalGate = { buildPromptContext: () => 'ATTENTION: focused on test' };

    const ctx = pb._consciousnessContext();
    assert(ctx.includes('EXPERIENCE'), 'should include phenomenal field');
    assert(ctx.includes('ATTENTION'), 'should include attentional gate');
  });

  test('_consciousnessContext gracefully handles module errors', () => {
    const pb = createPromptBuilder();
    pb.phenomenalField = { buildPromptContext: () => { throw new Error('boom'); } };

    const ctx = pb._consciousnessContext();
    assertEqual(ctx, ''); // Should not throw
  });

  test('build() includes consciousness section', () => {
    const pb = createPromptBuilder();
    pb.phenomenalField = { buildPromptContext: () => 'EXPERIENCE: deep flow' };

    const prompt = pb.build();
    assert(prompt.includes('EXPERIENCE'), 'full prompt should include consciousness');
  });

  test('section priority has consciousness at level 8', () => {
    const pb = createPromptBuilder();
    const entry = pb._sectionPriority.find(([, name]) => name === 'consciousness');
    assert(entry, 'consciousness should be in section priority');
    assertEqual(entry[0], 8);
  });
});

// ═════════════════════════════════════════════════════════════
// 2. CONSCIOUSNESS EXTENSION BRIDGE
// ═════════════════════════════════════════════════════════════

describe('ConsciousnessExtensionAdapter — Bridge', () => {
  test('module exports ConsciousnessExtensionAdapter', () => {
    const { ConsciousnessExtensionAdapter } = require('../../src/agent/consciousness/ConsciousnessExtensionAdapter');
    assert(ConsciousnessExtensionAdapter, 'should export');
    assert(typeof ConsciousnessExtensionAdapter.prototype.buildPromptContext === 'function',
      'should have buildPromptContext');
  });

  test('buildPromptContext returns empty when no engine', () => {
    const { ConsciousnessExtensionAdapter } = require('../../src/agent/consciousness/ConsciousnessExtensionAdapter');
    const adapter = new ConsciousnessExtensionAdapter({
      bus: NullBus, storage: null, eventStore: null, intervals: null, config: {},
    });
    assertEqual(adapter.buildPromptContext(), '');
  });
});

// ═════════════════════════════════════════════════════════════
// 3. VALUESTORE
// ═════════════════════════════════════════════════════════════

describe('ValueStore — Construction', () => {
  test('constructs without errors', () => {
    const vs = createValueStore();
    assert(vs, 'should construct');
  });

  test('starts with empty values', () => {
    const vs = createValueStore();
    assertEqual(vs._values.length, 0);
  });
});

describe('ValueStore — Store & Reinforce', () => {
  test('stores a new value', () => {
    const vs = createValueStore();
    const v = vs.store({ name: 'thoroughness', description: 'Prefer thorough over fast', weight: 0.6 });
    assert(v, 'should return stored value');
    assertEqual(v.name, 'thoroughness');
    assertEqual(vs._values.length, 1);
  });

  test('reinforces existing value with same name+domain', () => {
    const vs = createValueStore();
    vs.store({ name: 'safety', description: 'Safety first', weight: 0.5 });
    vs.store({ name: 'safety', description: 'Safety always', weight: 0.5 });

    assertEqual(vs._values.length, 1);
    assert(vs._values[0].evidence >= 2, 'evidence should increase');
    assert(vs._values[0].weight > 0.5, 'weight should increase on reinforcement');
  });

  test('stores separate values for different domains', () => {
    const vs = createValueStore();
    vs.store({ name: 'speed', domain: 'code' });
    vs.store({ name: 'speed', domain: 'communication' });
    assertEqual(vs._values.length, 2);
  });
});

describe('ValueStore — Conflict Recording', () => {
  test('records conflicts', () => {
    const vs = createValueStore();
    vs.recordConflict([['emotion', 'homeostasis']], 0.6);
    assertEqual(vs._conflictHistory.length, 1);
    assertEqual(vs._stats.conflictsRecorded, 1);
  });

  test('auto-crystallizes after 5+ recurring conflicts', () => {
    const vs = createValueStore();
    for (let i = 0; i < 6; i++) {
      vs.recordConflict([['emotion', 'homeostasis']], 0.6);
    }
    const crystallized = vs._values.find(v => v.name.includes('emotion') && v.name.includes('homeostasis'));
    assert(crystallized, 'should crystallize a value from recurring conflict');
    assertEqual(crystallized.source, 'apprehension');
  });

  test('listens to consciousness:apprehension events', () => {
    const bus = new EventBus();
    const vs = createValueStore({ bus });
    vs.start();

    bus.fire('consciousness:apprehension', {
      pairs: [['needs', 'expectation']],
      spread: 0.55,
    });

    assertEqual(vs._conflictHistory.length, 1);
  });
});

describe('ValueStore — Prompt Context', () => {
  test('returns empty when no values above threshold', () => {
    const vs = createValueStore();
    assertEqual(vs.buildPromptContext(), '');
  });

  test('includes high-weight values in prompt', () => {
    const vs = createValueStore();
    vs.store({ name: 'precision', description: 'Be exact', weight: 0.8 });
    vs.store({ name: 'speed', description: 'Be fast', weight: 0.7 });

    const ctx = vs.buildPromptContext();
    assert(ctx.includes('VALUES'), 'should have VALUES header');
    assert(ctx.includes('precision'), 'should include precision');
    assert(ctx.includes('speed'), 'should include speed');
  });

  test('getForDomain filters by domain', () => {
    const vs = createValueStore();
    vs.store({ name: 'safety', domain: 'code', weight: 0.8 });
    vs.store({ name: 'politeness', domain: 'communication', weight: 0.7 });

    const codeValues = vs.getForDomain('code');
    assert(codeValues.some(v => v.name === 'safety'), 'should include code-domain value');
  });
});

// ═════════════════════════════════════════════════════════════
// 4. AGENTLOOP COGNITION — CONSCIOUSNESS CONSULTATION
// ═════════════════════════════════════════════════════════════

describe('AgentLoopCognition — consultConsciousness', () => {
  test('returns no concerns when no consciousness modules available', () => {
    const delegate = new AgentLoopCognitionDelegate({});
    const result = delegate.consultConsciousness({ title: 'test', steps: [] });
    assertEqual(result.paused, false);
    assertEqual(result.concerns.length, 0);
  });

  test('pauses when attentionalGate is captured on ethical-conflict', () => {
    const delegate = new AgentLoopCognitionDelegate({
      attentionalGate: {
        getMode: () => 'captured',
        getPrimaryFocus: () => 'ethical-conflict',
        buildPromptContext: () => 'HALT — ethical conflict',
      },
    });

    const result = delegate.consultConsciousness({ title: 'test', steps: [] });
    assertEqual(result.paused, true);
    assert(result.concerns.length > 0, 'should have concerns');
    assert(result.concerns[0].includes('HALT') || result.concerns[0].includes('conflict'),
      'concern should mention halt or conflict');
  });

  test('adds concern when phenomenalField has apprehension qualia', () => {
    const delegate = new AgentLoopCognitionDelegate({
      phenomenalField: {
        getQualia: () => 'apprehension',
        getGestalt: () => 'Emotion and needs disagree',
      },
    });

    const result = delegate.consultConsciousness({ title: 'test', steps: [] });
    assertEqual(result.paused, false); // apprehension alone doesn't pause
    assert(result.concerns.length > 0, 'should have concerns');
  });

  test('enriches with value context when valueStore available', () => {
    const delegate = new AgentLoopCognitionDelegate({
      valueStore: {
        getForDomain: () => [
          { name: 'safety', weight: 0.8, description: 'Safety first' },
        ],
      },
    });

    const result = delegate.consultConsciousness({ title: 'test code', steps: [{ type: 'CODE_GENERATE' }] });
    assert(result.valueContext.includes('safety'), 'should include relevant value');
  });

  test('_inferDomain detects code domain', () => {
    const delegate = new AgentLoopCognitionDelegate({});
    assertEqual(delegate._inferDomain({ title: 'Refactor the module', steps: [] }), 'code');
  });

  test('_inferDomain defaults to all', () => {
    const delegate = new AgentLoopCognitionDelegate({});
    assertEqual(delegate._inferDomain({ title: 'Do something', steps: [] }), 'all');
  });
});

// ═════════════════════════════════════════════════════════════
// 5. USERMODEL
// ═════════════════════════════════════════════════════════════

describe('UserModel — Construction', () => {
  test('constructs without errors', () => {
    const um = createUserModel();
    assert(um, 'should construct');
  });

  test('starts with neutral profile', () => {
    const um = createUserModel();
    assertEqual(um._profile.verbosity, 0.5);
    assertEqual(um._profile.technicality, 0.5);
    assertEqual(um._profile.totalMessages, 0);
  });
});

describe('UserModel — Observation', () => {
  test('observe updates message count', () => {
    const um = createUserModel();
    um.observe('Hello, how are you?');
    assertEqual(um._profile.totalMessages, 1);
  });

  test('short messages reduce verbosity', () => {
    const um = createUserModel();
    for (let i = 0; i < 5; i++) um.observe('hi');
    assert(um._profile.verbosity < 0.5, `verbosity ${um._profile.verbosity} should decrease for terse messages`);
  });

  test('long messages increase verbosity', () => {
    const um = createUserModel();
    const long = 'a'.repeat(600);
    for (let i = 0; i < 5; i++) um.observe(long);
    assert(um._profile.verbosity > 0.5, `verbosity ${um._profile.verbosity} should increase for verbose messages`);
  });

  test('technical vocabulary increases technicality', () => {
    const um = createUserModel();
    um.observe('Can you refactor the async function and update the API endpoint config?');
    assert(um._profile.technicality > 0.5, 'technicality should increase');
  });

  test('commanding messages increase directiveness', () => {
    const um = createUserModel();
    um.observe('Fix the bug in the parser');
    um.observe('Deploy the service');
    um.observe('Delete the old logs');
    assert(um._profile.directiveness > 0.5, `directiveness ${um._profile.directiveness} should increase`);
  });

  test('questions decrease directiveness', () => {
    const um = createUserModel();
    um.observe('What do you think about this approach?');
    um.observe('How would you solve this problem?');
    um.observe('Could you explain the difference?');
    assert(um._profile.directiveness < 0.5, 'directiveness should decrease for questions');
  });
});

describe('UserModel — Prompt Context', () => {
  test('returns empty with insufficient data', () => {
    const um = createUserModel();
    um.observe('hi');
    assertEqual(um.buildPromptContext(), '');
  });

  test('returns adaptation hints after enough data', () => {
    const um = createUserModel();
    um._profile.totalMessages = 10;
    um._profile.verbosity = 0.1;
    um._profile.technicality = 0.8;

    const ctx = um.buildPromptContext();
    assert(ctx.includes('USER-ADAPTATION'), 'should have adaptation header');
    assert(ctx.includes('terse') || ctx.includes('brevity'), 'should note terse style');
    assert(ctx.includes('technical') || ctx.includes('proficient'), 'should note technical level');
  });

  test('warns about low patience', () => {
    const um = createUserModel();
    um._profile.totalMessages = 10;
    um._profile.patience = 0.15;

    const ctx = um.buildPromptContext();
    assert(ctx.includes('patience') || ctx.includes('LOW'), 'should warn about low patience');
  });
});

describe('UserModel — Event Wiring', () => {
  test('observes user messages via chat:completed events', () => {
    const bus = new EventBus();
    const um = createUserModel({ bus });

    // v4.12.5-fix: UserModel now observes via chat:completed (carries full message)
    bus.fire('chat:completed', { message: 'Test message from user', success: true });
    assertEqual(um._profile.totalMessages, 1);
  });
});

// ═════════════════════════════════════════════════════════════
// 6. BODYSCHEMA
// ═════════════════════════════════════════════════════════════

describe('BodySchema — Construction', () => {
  test('constructs without errors', () => {
    const bs = createBodySchema();
    assert(bs, 'should construct');
  });

  test('has default capabilities', () => {
    const bs = createBodySchema();
    const caps = bs.getCapabilities();
    assert(typeof caps.canExecuteCode === 'boolean', 'should have canExecuteCode');
    assert(typeof caps.activeModel === 'string', 'should have activeModel');
  });
});

describe('BodySchema — Capability Sampling', () => {
  test('samples model name from wired model', () => {
    const bs = createBodySchema();
    bs.model = { activeModel: 'claude-3-opus' };
    bs._lastUpdate = 0; // force update
    const caps = bs.getCapabilities();
    assertEqual(caps.activeModel, 'claude-3-opus');
  });

  test('detects homeostasis constraints', () => {
    const bs = createBodySchema();
    bs.homeostasis = {
      getReport: () => ({ state: 'critical', criticalCount: 2 }),
    };
    bs._lastUpdate = 0;

    const constraints = bs.getConstraints();
    assert(constraints.length > 0, 'should have constraints in critical state');
    assert(constraints.some(c => c.includes('RECOVERY')), 'should mention recovery mode');
  });

  test('detects circuit breaker state', () => {
    const bs = createBodySchema();
    bs.circuitBreaker = { getState: () => 'open' };
    bs._lastUpdate = 0;

    const caps = bs.getCapabilities();
    assertEqual(caps.circuitOpen, true);
  });

  test('can() method checks capabilities', () => {
    const bs = createBodySchema();
    bs._capabilities.canExecuteCode = true;
    bs._capabilities.canModifySelf = false;

    assert(bs.can('canExecuteCode'), 'should be able to execute code');
    assert(!bs.can('canModifySelf'), 'should not be able to modify self');
  });
});

describe('BodySchema — Prompt Context', () => {
  test('returns empty when no constraints', () => {
    const bs = createBodySchema();
    bs._constraints = [];
    bs._capabilities.circuitOpen = false;
    bs._capabilities.canExecuteCode = true;
    bs._capabilities.canModifySelf = true;

    assertEqual(bs.buildPromptContext(), '');
  });

  test('includes constraints when present', () => {
    const bs = createBodySchema();
    bs.homeostasis = { getReport: () => ({ state: 'critical', criticalCount: 2 }) };
    bs.circuitBreaker = { getState: () => 'open' };
    bs._lastUpdate = 0; // Force re-sample

    const ctx = bs.buildPromptContext();
    assert(ctx.includes('CONSTRAINTS'), 'should have constraints header');
    assert(ctx.includes('RECOVERY'), 'should mention recovery');
    assert(ctx.includes('unstable'), 'should mention unstable backend');
  });

  test('mentions restricted capabilities', () => {
    const bs = createBodySchema();
    bs._capabilities.canModifySelf = false;

    const ctx = bs.buildPromptContext();
    assert(ctx.includes('Self-modification') || ctx.includes('restricted'),
      'should mention self-modification restriction');
  });
});

describe('BodySchema — Event Invalidation', () => {
  test('invalidates on health events', () => {
    const bus = new EventBus();
    const bs = createBodySchema({ bus });
    bs._lastUpdate = Date.now(); // pretend recently updated

    bus.fire('health:degradation', {});
    assertEqual(bs._lastUpdate, 0); // should be invalidated
  });
});

// ═════════════════════════════════════════════════════════════
// INTEGRATION: ALL SECTIONS IN PROMPT
// ═════════════════════════════════════════════════════════════

describe('PromptBuilder — Full Integration', () => {
  test('build includes all new sections when wired', () => {
    const pb = createPromptBuilder();

    pb.phenomenalField = { buildPromptContext: () => 'EXPERIENCE: flow state' };
    pb.attentionalGate = { buildPromptContext: () => 'ATTENTION: focused' };
    pb.valueStore = { buildPromptContext: () => 'VALUES: thoroughness (80%)' };
    pb.userModel = { buildPromptContext: () => 'USER-ADAPTATION: terse style' };
    pb.bodySchema = { buildPromptContext: () => '' }; // No constraints = no output

    const prompt = pb.build();
    assert(prompt.includes('EXPERIENCE'), 'should include consciousness');
    assert(prompt.includes('VALUES'), 'should include values');
    assert(prompt.includes('USER-ADAPTATION'), 'should include user model');
    // bodySchema returns empty, so should not appear
    assert(!prompt.includes('CONSTRAINTS'), 'empty body schema should not appear');
  });
});

run();
