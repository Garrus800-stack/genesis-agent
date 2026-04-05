// ============================================================
// TEST — CorrelationContext.js (v6.0.1)
// ============================================================

const { describe, test, run } = require('../harness');
const { CorrelationContext } = require('../../src/agent/core/CorrelationContext');

describe('CorrelationContext', () => {
  test('getId returns null outside scope', () => {
    const id = CorrelationContext.getId();
    if (id !== null) throw new Error(`Expected null outside scope, got ${id}`);
  });

  test('run sets and propagates ID', async () => {
    await CorrelationContext.run('test-123', async () => {
      const id = CorrelationContext.getId();
      if (id !== 'test-123') throw new Error(`Expected test-123, got ${id}`);
    });
  });

  test('run auto-generates ID when null', async () => {
    await CorrelationContext.run(null, async () => {
      const id = CorrelationContext.getId();
      if (!id) throw new Error('Should auto-generate ID');
      if (id.length < 8) throw new Error('Auto ID too short');
    });
  });

  test('run uses custom prefix for auto IDs', async () => {
    await CorrelationContext.run(null, async () => {
      const id = CorrelationContext.getId();
      if (!id.startsWith('goal-')) throw new Error(`Should start with goal-, got ${id}`);
    }, 'goal');
  });

  test('ID propagates through async chains', async () => {
    await CorrelationContext.run('chain-test', async () => {
      const inner = await new Promise(resolve => {
        setTimeout(() => resolve(CorrelationContext.getId()), 10);
      });
      if (inner !== 'chain-test') throw new Error(`Should propagate, got ${inner}`);
    });
  });

  test('nested scopes are independent', async () => {
    await CorrelationContext.run('outer', async () => {
      if (CorrelationContext.getId() !== 'outer') throw new Error('Outer wrong');
      await CorrelationContext.run('inner', async () => {
        if (CorrelationContext.getId() !== 'inner') throw new Error('Inner wrong');
      });
      if (CorrelationContext.getId() !== 'outer') throw new Error('Outer should restore');
    });
  });

  test('getContext returns timing info', async () => {
    await CorrelationContext.run('ctx-test', async () => {
      await new Promise(r => setTimeout(r, 15));
      const ctx = CorrelationContext.getContext();
      if (!ctx) throw new Error('Should return context');
      if (ctx.correlationId !== 'ctx-test') throw new Error('Wrong ID');
      if (typeof ctx.startedAt !== 'number') throw new Error('Missing startedAt');
      if (ctx.elapsedMs < 10) throw new Error(`Elapsed should be >= 10, got ${ctx.elapsedMs}`);
    });
  });

  test('getContext returns null outside scope', () => {
    const ctx = CorrelationContext.getContext();
    if (ctx !== null) throw new Error('Should be null outside scope');
  });

  test('fork creates child with parent prefix', async () => {
    await CorrelationContext.run('parent-id', async () => {
      await CorrelationContext.fork(async () => {
        const id = CorrelationContext.getId();
        if (!id.startsWith('parent-id/')) throw new Error(`Child should start with parent-id/, got ${id}`);
      }, 'child');
    });
  });

  test('fork outside scope creates standalone ID', async () => {
    await CorrelationContext.fork(async () => {
      const id = CorrelationContext.getId();
      if (!id) throw new Error('Should generate standalone ID');
    }, 'standalone');
  });

  test('inject adds correlationId to object', async () => {
    await CorrelationContext.run('inject-test', async () => {
      const meta = { source: 'test' };
      CorrelationContext.inject(meta);
      if (meta.correlationId !== 'inject-test') throw new Error('Should inject ID');
      if (meta.source !== 'test') throw new Error('Should preserve existing fields');
    });
  });

  test('inject does nothing outside scope', () => {
    const obj = { a: 1 };
    CorrelationContext.inject(obj);
    if (obj.correlationId) throw new Error('Should not inject outside scope');
  });

  test('generate creates unique IDs', () => {
    const id1 = CorrelationContext.generate();
    const id2 = CorrelationContext.generate();
    if (id1 === id2) throw new Error('IDs should be unique');
    if (!id1.startsWith('cor-')) throw new Error('Default prefix should be cor-');
  });

  test('generate respects custom prefix', () => {
    const id = CorrelationContext.generate('goal');
    if (!id.startsWith('goal-')) throw new Error(`Should start with goal-, got ${id}`);
  });
});

if (require.main === module) run();
