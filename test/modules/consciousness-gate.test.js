// ============================================================
// TEST — ConsciousnessGate (v6.0.8)
// SelfModificationPipeline coherence-gated self-modification
// ============================================================

const { describe, test, run } = require('../harness');
const { SelfModificationPipeline } = require('../../src/agent/hexagonal/SelfModificationPipeline');

// ── Minimal mocks ────────────────────────────────────────────
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

function mockSelfModel() {
  return {
    getModuleSummary: () => [],
    readModule: () => '// mock',
    isProtected: () => false,
  };
}

function mockModel() {
  return { chat: async () => '{"changes": []}' };
}

function mockLang() {
  return { t: (k) => k };
}

// ════════════════════════════════════════════════════════════

describe('ConsciousnessGate — coherence check', () => {
  test('blocks modification when coherence < 0.4', async () => {
    const bus = mockBus();
    const pipeline = new SelfModificationPipeline({
      bus, lang: mockLang(), selfModel: mockSelfModel(), model: mockModel(),
    });
    pipeline._phenomenalField = {
      getCoherence: () => 0.2,
    };

    const result = await pipeline.modify('refactor something');

    if (typeof result !== 'string') throw new Error('Should return a string message when blocked');
    if (!result.includes('deferred') && !result.includes('coherence')) {
      throw new Error('Message should mention coherence or deferral');
    }
  });

  test('allows modification when coherence >= 0.4', async () => {
    const bus = mockBus();
    const pipeline = new SelfModificationPipeline({
      bus, lang: mockLang(), selfModel: mockSelfModel(), model: mockModel(),
    });
    pipeline._phenomenalField = {
      getCoherence: () => 0.7,
    };

    // Should not be blocked by coherence (may fail downstream for other reasons)
    try {
      const result = await pipeline.modify('refactor something');
      // If we get a string result, it shouldn't mention coherence
      if (typeof result === 'string' && result.includes('coherence')) {
        throw new Error('Should not be blocked when coherence is sufficient');
      }
    } catch (err) {
      // Downstream errors (solver, AST) are fine — we only care that coherence didn't block
      if (err.message.includes('coherence')) throw err;
    }
  });

  test('proceeds normally without phenomenalField', async () => {
    const bus = mockBus();
    const pipeline = new SelfModificationPipeline({
      bus, lang: mockLang(), selfModel: mockSelfModel(), model: mockModel(),
    });
    // _phenomenalField is null by default — should not block
    try {
      const result = await pipeline.modify('refactor something');
      if (typeof result === 'string' && result.includes('coherence')) {
        throw new Error('Should not block when phenomenalField is not available');
      }
    } catch (err) {
      if (err.message.includes('coherence')) throw err;
    }
  });

  test('emits selfmod:consciousness-blocked event', async () => {
    const bus = mockBus();
    const pipeline = new SelfModificationPipeline({
      bus, lang: mockLang(), selfModel: mockSelfModel(), model: mockModel(),
    });
    pipeline._phenomenalField = {
      getCoherence: () => 0.15,
    };

    await pipeline.modify('refactor something');

    const events = bus.getEmitted('selfmod:consciousness-blocked');
    if (events.length === 0) throw new Error('Should emit selfmod:consciousness-blocked');
    if (typeof events[0].data.coherence !== 'number') throw new Error('Event should include coherence value');
    if (events[0].data.coherence > 0.4) throw new Error('Coherence in event should be the low value');
  });

  test('handles getCoherence() throwing gracefully', async () => {
    const bus = mockBus();
    const pipeline = new SelfModificationPipeline({
      bus, lang: mockLang(), selfModel: mockSelfModel(), model: mockModel(),
    });
    pipeline._phenomenalField = {
      getCoherence: () => { throw new Error('consciousness unavailable'); },
    };

    // Should not throw or block — consciousness errors should be caught
    try {
      const result = await pipeline.modify('refactor something');
      if (typeof result === 'string' && result.includes('coherence')) {
        throw new Error('Should not block when getCoherence throws');
      }
    } catch (err) {
      if (err.message.includes('coherence')) throw err;
    }
  });
});

run();
