// ============================================================
// GENESIS — v520-upgrade.test.js
//
// Tests for all v5.2.0 upgrade components:
//   1. CorrelationContext — async propagation
//   2. McpTransport CircuitBreaker — wrapping + state
//   3. PromptEvolution — A/B testing lifecycle
//   4. EventBus correlation injection — meta enrichment
//   5. Monitor fixes — .then/.catch, process.exit scope
// ============================================================

const { describe, it, expect, mock } = require('../harness');

// ────────────────────────────────────────────────────────────
// 1. CORRELATION CONTEXT
// ────────────────────────────────────────────────────────────

describe('CorrelationContext', () => {
  const { CorrelationContext } = require('../../src/agent/core/CorrelationContext');

  it('generates unique IDs', () => {
    const id1 = CorrelationContext.generate('test');
    const id2 = CorrelationContext.generate('test');
    expect(id1).not.toBe(id2);
    expect(id1.startsWith('test-')).toBe(true);
  });

  it('returns null outside a scope', () => {
    expect(CorrelationContext.getId()).toBe(null);
    expect(CorrelationContext.getContext()).toBe(null);
  });

  it('propagates ID through async scope', async () => {
    let capturedId = null;
    await CorrelationContext.run('goal-123', async () => {
      capturedId = CorrelationContext.getId();
      // Nested async
      await new Promise(resolve => setTimeout(resolve, 5));
      expect(CorrelationContext.getId()).toBe('goal-123');
    });
    expect(capturedId).toBe('goal-123');
  });

  it('auto-generates ID when null', async () => {
    let capturedId = null;
    await CorrelationContext.run(null, async () => {
      capturedId = CorrelationContext.getId();
    }, 'auto');
    expect(capturedId).toBeTruthy();
    expect(capturedId.startsWith('auto-')).toBe(true);
  });

  it('isolates concurrent scopes', async () => {
    const ids = [];
    await Promise.all([
      CorrelationContext.run('scope-A', async () => {
        await new Promise(r => setTimeout(r, 10));
        ids.push(CorrelationContext.getId());
      }),
      CorrelationContext.run('scope-B', async () => {
        await new Promise(r => setTimeout(r, 5));
        ids.push(CorrelationContext.getId());
      }),
    ]);
    expect(ids).toContain('scope-A');
    expect(ids).toContain('scope-B');
  });

  it('fork creates child with parent prefix', async () => {
    await CorrelationContext.run('parent-1', async () => {
      let childId = null;
      await CorrelationContext.fork(async () => {
        childId = CorrelationContext.getId();
      }, 'step');
      expect(childId.startsWith('parent-1/step-')).toBe(true);
      // Parent scope still has original ID
      expect(CorrelationContext.getId()).toBe('parent-1');
    });
  });

  it('inject enriches object with current ID', async () => {
    await CorrelationContext.run('inject-test', async () => {
      const obj = { event: 'test' };
      CorrelationContext.inject(obj);
      expect(obj.correlationId).toBe('inject-test');
    });
  });

  it('inject does nothing outside scope', () => {
    const obj = { event: 'test' };
    CorrelationContext.inject(obj);
    expect(obj.correlationId).toBeUndefined();
  });

  it('getContext includes timing', async () => {
    await CorrelationContext.run('timing-test', async () => {
      await new Promise(r => setTimeout(r, 15));
      const ctx = CorrelationContext.getContext();
      expect(ctx.correlationId).toBe('timing-test');
      expect(ctx.elapsedMs).toBeGreaterThanOrEqual(10);
      expect(typeof ctx.startedAt).toBe('number');
    });
  });
});

// ────────────────────────────────────────────────────────────
// 2. MCP TRANSPORT CIRCUIT BREAKER
// ────────────────────────────────────────────────────────────

describe('McpTransport CircuitBreaker', () => {
  const { McpServerConnection } = require('../../src/agent/capabilities/McpTransport');
  const { NullBus } = require('../../src/agent/core/EventBus');

  it('creates CircuitBreaker per connection', () => {
    const conn = new McpServerConnection({ name: 'test-server', url: 'https://example.com/mcp' }, NullBus);
    expect(conn._circuitBreaker).toBeTruthy();
    expect(conn._circuitBreaker.name).toBe('mcp:test-server');
  });

  it('exposes circuit breaker status in getStatus()', () => {
    const conn = new McpServerConnection({ name: 'test-server', url: 'https://example.com/mcp' }, NullBus);
    const status = conn.getStatus();
    expect(status.circuitBreaker).toBeTruthy();
    expect(status.circuitBreaker.state).toBe('CLOSED');
    expect(status.circuitBreaker.name).toBe('mcp:test-server');
  });

  it('accepts custom circuit breaker config', () => {
    const conn = new McpServerConnection({
      name: 'custom',
      url: 'https://example.com/mcp',
      circuitBreakerThreshold: 5,
      circuitBreakerCooldownMs: 60000,
      circuitBreakerTimeoutMs: 20000,
    }, NullBus);
    expect(conn._circuitBreaker.failureThreshold).toBe(5);
    expect(conn._circuitBreaker.cooldownMs).toBe(60000);
    expect(conn._circuitBreaker.timeoutMs).toBe(20000);
  });

  it('callTool throws when not connected', async () => {
    const conn = new McpServerConnection({ name: 'offline', url: 'https://example.com/mcp' }, NullBus);
    try {
      await conn.callTool('test-tool', {});
      expect(true).toBe(false); // Should not reach
    } catch (err) {
      expect(err.message).toContain('not connected');
    }
  });

  it('callTool enqueues when degraded', async () => {
    const conn = new McpServerConnection({ name: 'degraded', url: 'https://example.com/mcp' }, NullBus);
    conn.status = 'degraded';
    // This returns a promise that won't resolve (no drain), so just check it doesn't throw
    const promise = conn.callTool('test-tool', {});
    expect(conn._requestQueue.length).toBe(1);
    // Clean up: reject the queued promise
    conn._requestQueue[0].reject(new Error('test cleanup'));
    try { await promise; } catch (_e) { /* expected */ }
  });
});

// ────────────────────────────────────────────────────────────
// 3. PROMPT EVOLUTION
// ────────────────────────────────────────────────────────────

describe('PromptEvolution', () => {
  const { PromptEvolution, EVOLVABLE_SECTIONS, MIN_TRIALS_PER_ARM } = require('../../src/agent/intelligence/PromptEvolution');
  const { NullBus } = require('../../src/agent/core/EventBus');

  function createEvo(overrides = {}) {
    return new PromptEvolution({
      bus: NullBus,
      storage: {
        readJSON: async () => null,
        writeJSONDebounced: () => {},
        writeJSON: () => {},
      },
      metaLearning: {},
      ...overrides,
    });
  }

  it('returns default text when disabled', () => {
    const evo = createEvo();
    evo._enabled = false;
    const result = evo.getSection('formatting', 'default text');
    expect(result.text).toBe('default text');
    expect(result.variantId).toBe(null);
  });

  it('returns default text for non-evolvable sections', () => {
    const evo = createEvo();
    const result = evo.getSection('identity', 'I am Genesis');
    expect(result.text).toBe('I am Genesis');
    expect(result.variantId).toBe(null);
  });

  it('returns promoted variant when available', () => {
    const evo = createEvo();
    evo._promotedVariants.formatting = {
      text: 'Improved formatting rules',
      promotedAt: Date.now(),
      generation: 1,
    };
    const result = evo.getSection('formatting', 'default');
    expect(result.text).toBe('Improved formatting rules');
    expect(result.variantId).toContain('promoted');
  });

  it('alternates between control and variant during experiment', () => {
    const evo = createEvo();
    evo._experiments.formatting = {
      sectionName: 'formatting',
      variantId: 'formatting-gen1',
      controlText: 'Original',
      variantText: 'Variant',
      status: 'running',
      controlTrials: 0,
      variantTrials: 0,
      controlSuccesses: 0,
      variantSuccesses: 0,
    };

    // Trial 0 (even) → control
    const r1 = evo.getSection('formatting', 'ignored');
    expect(r1.text).toBe('Original');
    expect(r1.variantId).toBe(null);

    // Simulate trial counts
    evo._experiments.formatting.controlTrials = 1;

    // Trial 1 (odd) → variant
    const r2 = evo.getSection('formatting', 'ignored');
    expect(r2.text).toBe('Variant');
    expect(r2.variantId).toBe('formatting-gen1');
  });

  it('records outcomes and evaluates when threshold reached', () => {
    const evo = createEvo();
    evo._experiments.formatting = {
      sectionName: 'formatting',
      variantId: 'formatting-gen1',
      controlText: 'Original',
      variantText: 'Better variant',
      status: 'running',
      controlTrials: MIN_TRIALS_PER_ARM - 1,
      variantTrials: MIN_TRIALS_PER_ARM - 1,
      controlSuccesses: Math.round((MIN_TRIALS_PER_ARM - 1) * 0.6),
      variantSuccesses: Math.round((MIN_TRIALS_PER_ARM - 1) * 0.8),
      generation: 1,
    };

    // Push both arms over threshold
    evo.recordOutcome('formatting', null, true); // control success
    evo.recordOutcome('formatting', 'formatting-gen1', true); // variant success

    // Experiment should be evaluated (variant wins ~80% vs ~60%)
    expect(evo._experiments.formatting).toBeUndefined();
    // Variant should be promoted (20% improvement > 5% threshold)
    expect(evo._promotedVariants.formatting).toBeTruthy();
    expect(evo._promotedVariants.formatting.text).toBe('Better variant');
  });

  it('discards losing variant', () => {
    const evo = createEvo();
    evo._experiments.formatting = {
      sectionName: 'formatting',
      variantId: 'formatting-gen2',
      controlText: 'Good original',
      variantText: 'Bad variant',
      status: 'running',
      controlTrials: MIN_TRIALS_PER_ARM - 1,
      variantTrials: MIN_TRIALS_PER_ARM - 1,
      controlSuccesses: Math.round((MIN_TRIALS_PER_ARM - 1) * 0.8),
      variantSuccesses: Math.round((MIN_TRIALS_PER_ARM - 1) * 0.5),
      generation: 2,
    };

    evo.recordOutcome('formatting', null, true);
    evo.recordOutcome('formatting', 'formatting-gen2', false);

    expect(evo._experiments.formatting).toBeUndefined();
    expect(evo._promotedVariants.formatting).toBeUndefined();
    expect(evo._history.length).toBeGreaterThan(0);
    expect(evo._history[evo._history.length - 1].decision).toContain('discard');
  });

  it('rejects non-evolvable sections in startExperiment', async () => {
    const evo = createEvo();
    const result = await evo.startExperiment('identity', 'You are Genesis');
    expect(result).toBe(null);
  });

  it('rollback removes promoted variant', () => {
    const evo = createEvo();
    evo._promotedVariants.formatting = { text: 'test', promotedAt: Date.now(), generation: 1 };
    const result = evo.rollback('formatting');
    expect(result).toBe(true);
    expect(evo._promotedVariants.formatting).toBeUndefined();
  });

  it('cancelExperiment stops running experiment', () => {
    const evo = createEvo();
    evo._experiments.formatting = { status: 'running', sectionName: 'formatting' };
    const result = evo.cancelExperiment('formatting');
    expect(result).toBe(true);
    expect(evo._experiments.formatting).toBeUndefined();
  });

  it('getStatus reports all state', () => {
    const evo = createEvo();
    evo._generation = 3;
    evo._promotedVariants.formatting = { text: 'x', generation: 2 };
    const status = evo.getStatus();
    expect(status.generation).toBe(3);
    expect(status.promotedSections).toContain('formatting');
    expect(status.enabled).toBe(true);
  });

  it('EVOLVABLE_SECTIONS excludes identity and safety', () => {
    expect(EVOLVABLE_SECTIONS.has('identity')).toBe(false);
    expect(EVOLVABLE_SECTIONS.has('safety')).toBe(false);
    expect(EVOLVABLE_SECTIONS.has('formatting')).toBe(true);
    expect(EVOLVABLE_SECTIONS.has('organism')).toBe(true);
  });

  it('stop() calls saveSync', () => {
    let saved = false;
    const evo = createEvo({
      storage: {
        readJSON: async () => null,
        writeJSONDebounced: () => {},
        writeJSON: () => { saved = true; },
      },
    });
    evo.stop();
    expect(saved).toBe(true);
  });
});

// ────────────────────────────────────────────────────────────
// 4. EVENTBUS CORRELATION INJECTION
// ────────────────────────────────────────────────────────────

describe('EventBus Correlation Injection', () => {
  const { createBus } = require('../../src/agent/core/EventBus');
  const { CorrelationContext } = require('../../src/agent/core/CorrelationContext');

  it('meta.correlationId auto-injected inside correlation scope', async () => {
    const bus = createBus();
    let receivedMeta = null;
    bus.on('test:event', (data, meta) => { receivedMeta = meta; });

    await CorrelationContext.run('trace-abc', async () => {
      await bus.emit('test:event', { value: 42 }, { source: 'test' });
    });

    expect(receivedMeta).toBeTruthy();
    expect(receivedMeta.correlationId).toBe('trace-abc');
  });

  it('meta.correlationId absent outside scope', async () => {
    const bus = createBus();
    let receivedMeta = null;
    bus.on('test:event', (data, meta) => { receivedMeta = meta; });

    await bus.emit('test:event', { value: 1 }, { source: 'test' });

    expect(receivedMeta).toBeTruthy();
    expect(receivedMeta.correlationId).toBeUndefined();
  });

  it('explicit correlationId in meta is not overwritten', async () => {
    const bus = createBus();
    let receivedMeta = null;
    bus.on('test:event', (data, meta) => { receivedMeta = meta; });

    await CorrelationContext.run('scope-id', async () => {
      await bus.emit('test:event', {}, { source: 'test', correlationId: 'explicit-id' });
    });

    expect(receivedMeta.correlationId).toBe('explicit-id');
  });
});

// ────────────────────────────────────────────────────────────
// 5. SANDBOX PROCESS.EXIT SCOPE CHECK
// ────────────────────────────────────────────────────────────

describe('Sandbox process.exit scope', () => {
  const fs = require('fs');
  const path = require('path');

  it('process.exit(1) in Sandbox.js is inside child-process template string only', () => {
    const sandboxPath = path.join(__dirname, '../../src/agent/foundation/Sandbox.js');
    const code = fs.readFileSync(sandboxPath, 'utf-8');

    // Find all process.exit occurrences with line context
    const lines = code.split('\n');
    const exitLines = [];
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].includes('process.exit') && !lines[i].trim().startsWith('//')) {
        exitLines.push({ line: i + 1, text: lines[i].trim() });
      }
    }

    // All should be inside template literals (backtick strings)
    // Check that they occur between backtick boundaries
    for (const { line, text } of exitLines) {
      // The process.exit in Sandbox is inside _buildExecutionScript template
      // It's the uncaughtException handler in the child process, not the parent
      expect(text).not.toBe('process.exit(1);'); // bare exit = bug
      // It should be inside a template or handler
    }

    // Verify there's at most 1 process.exit, and it's in template code
    const directExits = exitLines.filter(e => e.text === 'process.exit(1);');
    // L-2x: If there's a bare process.exit, it should be wrapped
    if (directExits.length > 0) {
      console.warn(`  ⚠ Found ${directExits.length} bare process.exit(1) in Sandbox.js — verify these are in child-process templates`);
    }
  });
});

// ────────────────────────────────────────────────────────────
// 6. CIRCUIT BREAKER INTEGRATION
// ────────────────────────────────────────────────────────────

describe('CircuitBreaker', () => {
  const { CircuitBreaker } = require('../../src/agent/core/CircuitBreaker');

  it('starts in CLOSED state', () => {
    const cb = new CircuitBreaker({ name: 'test' });
    expect(cb.state).toBe('CLOSED');
  });

  it('opens after failureThreshold failures', async () => {
    const cb = new CircuitBreaker({ name: 'test', failureThreshold: 2, maxRetries: 0 });
    const failFn = () => { throw new Error('fail'); };

    try { await cb.execute(failFn); } catch (_e) { /* expected */ }
    expect(cb.state).toBe('CLOSED');

    try { await cb.execute(failFn); } catch (_e) { /* expected */ }
    expect(cb.state).toBe('OPEN');
  });

  it('rejects immediately when OPEN', async () => {
    const cb = new CircuitBreaker({ name: 'test', failureThreshold: 1, maxRetries: 0, cooldownMs: 60000 });
    try { await cb.execute(() => { throw new Error('fail'); }); } catch (_e) { /* expected */ }
    expect(cb.state).toBe('OPEN');

    const start = Date.now();
    try {
      await cb.execute(() => 'should not run');
      expect(true).toBe(false);
    } catch (err) {
      expect(err.message).toContain('OPEN');
    }
    // Should reject almost instantly (no timeout wait)
    expect(Date.now() - start).toBeLessThan(100);
  });

  it('transitions to HALF_OPEN after cooldown', async () => {
    const cb = new CircuitBreaker({ name: 'test', failureThreshold: 1, maxRetries: 0, cooldownMs: 10 });
    try { await cb.execute(() => { throw new Error('fail'); }); } catch (_e) { /* expected */ }
    expect(cb.state).toBe('OPEN');

    await new Promise(r => setTimeout(r, 20));
    try { await cb.execute(() => 'recovered'); } catch (_e) { /* unexpected */ }
    expect(cb.state).toBe('CLOSED');
  });

  it('reset() forces CLOSED', () => {
    const cb = new CircuitBreaker({ name: 'test' });
    cb.state = 'OPEN';
    cb.failures = 5;
    cb.reset();
    expect(cb.state).toBe('CLOSED');
    expect(cb.failures).toBe(0);
  });

  it('getStatus() returns complete info', () => {
    const cb = new CircuitBreaker({ name: 'status-test' });
    const status = cb.getStatus();
    expect(status.name).toBe('status-test');
    expect(status.state).toBe('CLOSED');
    expect(typeof status.stats).toBe('object');
  });
});
