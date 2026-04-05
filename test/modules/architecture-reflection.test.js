// ============================================================
// TEST — ArchitectureReflection.js (SA-P3)
// ============================================================

const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');
const { ArchitectureReflection } = require('../../src/agent/cognitive/ArchitectureReflection');
const { EventBus } = require('../../src/agent/core/EventBus');
const path = require('path');

// ── Mock Container ──────────────────────────────────────────
function mockContainer() {
  const registrations = new Map([
    ['eventBus', { phase: 0, deps: [], lateBindings: [], tags: ['core'], singleton: true }],
    ['storage', { phase: 1, deps: ['eventBus'], lateBindings: [], tags: ['foundation'], singleton: true }],
    ['settings', { phase: 1, deps: ['storage'], lateBindings: [], tags: ['foundation'], singleton: true }],
    ['model', { phase: 1, deps: ['settings'], lateBindings: [
      { prop: 'metaLearning', service: 'metaLearning', optional: true },
    ], tags: ['foundation'], singleton: true }],
    ['intentRouter', { phase: 2, deps: ['settings'], lateBindings: [], tags: ['intelligence'], singleton: true }],
    ['agentLoop', { phase: 8, deps: ['model', 'intentRouter'], lateBindings: [
      { prop: 'cognitiveWorkspace', service: 'cognitiveWorkspace', optional: true },
    ], tags: ['revolution'], singleton: true }],
    ['metaLearning', { phase: 4, deps: ['storage'], lateBindings: [], tags: ['planning'], singleton: true }],
    ['cognitiveWorkspace', { phase: 9, deps: [], lateBindings: [], tags: ['cognitive'], singleton: true }],
    ['idleMind', { phase: 6, deps: ['storage'], lateBindings: [], tags: ['autonomy'], singleton: true }],
  ]);
  return { registrations };
}

// ── Mock SelfModel ──────────────────────────────────────────
function mockSelfModel() {
  return {
    rootDir: path.join(__dirname, '..', '..'),
    manifest: {
      identity: 'genesis',
      version: '5.7.0',
      modules: {},
      files: {},
      capabilities: [],
    },
  };
}

describe('ArchitectureReflection', () => {
  let ar;
  let bus;

  before(() => {
    bus = new EventBus();
    ar = new ArchitectureReflection({
      bus,
      selfModel: mockSelfModel(),
      config: { staleThresholdMs: 999999 },
    });
    ar.setContainer(mockContainer());
    ar.start();
  });

  describe('getServiceInfo', () => {
    it('returns info for known service', () => {
      const info = ar.getServiceInfo('storage');
      assert.ok(info);
      assert.equal(info.phase, 1);
      assert.deepEqual(info.deps, ['eventBus']);
      assert.ok(info.dependents.includes('settings'));
    });

    it('returns null for unknown service', () => {
      assert.equal(ar.getServiceInfo('nonexistent'), null);
    });

    it('includes lateBindings', () => {
      const info = ar.getServiceInfo('model');
      assert.ok(info.lateBindings.length > 0);
      assert.equal(info.lateBindings[0].service, 'metaLearning');
    });
  });

  describe('getPhaseMap', () => {
    it('groups services by phase', () => {
      const map = ar.getPhaseMap();
      assert.ok(map[0]?.includes('eventBus'));
      assert.ok(map[1]?.includes('storage'));
      assert.ok(map[8]?.includes('agentLoop'));
    });
  });

  describe('getLayerMap', () => {
    it('groups services by layer', () => {
      const map = ar.getLayerMap();
      assert.ok(Object.keys(map).length > 0);
    });
  });

  describe('getDependencyChain', () => {
    it('finds chain between connected services', () => {
      const chain = ar.getDependencyChain('settings', 'eventBus');
      assert.ok(chain);
      assert.equal(chain[0], 'settings');
      assert.ok(chain.includes('eventBus'));
    });

    it('returns null for disconnected services', () => {
      const chain = ar.getDependencyChain('eventBus', 'agentLoop');
      // eventBus has no deps, so it can't reach agentLoop via deps
      assert.equal(chain, null);
    });

    it('returns null for unknown services', () => {
      assert.equal(ar.getDependencyChain('x', 'y'), null);
    });
  });

  describe('getCouplings', () => {
    it('detects cross-phase late-bindings', () => {
      const couplings = ar.getCouplings();
      assert.ok(couplings.length > 0);
      // agentLoop (8) → cognitiveWorkspace (9)
      const al = couplings.find(c => c.from === 'agentLoop' && c.to === 'cognitiveWorkspace');
      assert.ok(al, 'AgentLoop→CognitiveWorkspace coupling expected');
    });
  });

  describe('getSnapshot', () => {
    it('returns full snapshot', () => {
      const snap = ar.getSnapshot();
      assert.ok(snap.services > 0);
      assert.ok(snap.layers > 0);
      assert.ok(snap.buildCount > 0);
    });
  });

  describe('getEventFlow', () => {
    it('returns null for unknown event', () => {
      assert.equal(ar.getEventFlow('nonexistent:event'), null);
    });

    it('finds events from source scan', () => {
      // The source scan should find at least some events
      const snap = ar.getSnapshot();
      assert.ok(snap.events > 0, 'Should find events from source scan');
    });
  });

  describe('query', () => {
    it('handles "depends on" query', () => {
      const result = ar.query('what depends on storage');
      assert.ok(result.dependents || result.type === 'not-found');
    });

    it('handles "phase map" query', () => {
      const result = ar.query('show phase map');
      assert.equal(result.type, 'phaseMap');
    });

    it('handles "coupling" query', () => {
      const result = ar.query('show couplings');
      assert.equal(result.type, 'couplings');
      assert.ok(Array.isArray(result.couplings));
    });

    it('handles unknown query as summary', () => {
      const result = ar.query('hello world');
      assert.equal(result.type, 'summary');
    });
  });

  describe('buildPromptContext', () => {
    it('returns non-empty context', () => {
      const ctx = ar.buildPromptContext();
      assert.ok(ctx.includes('ARCHITECTURE'));
      assert.ok(ctx.includes('services'));
    });
  });

  describe('containerConfig', () => {
    it('has correct static config', () => {
      assert.equal(ArchitectureReflection.containerConfig.name, 'architectureReflection');
      assert.equal(ArchitectureReflection.containerConfig.phase, 9);
    });
  });
});
