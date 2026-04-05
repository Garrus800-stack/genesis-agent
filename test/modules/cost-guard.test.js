// ============================================================
// TEST — CostGuard.js (v6.0.1)
// ============================================================

const { describe, test, run } = require('../harness');
const { CostGuard } = require('../../src/agent/ports/CostGuard');

describe('CostGuard', () => {
  test('allows calls within budget', () => {
    const cg = new CostGuard({ config: { sessionTokenLimit: 100000, dailyTokenLimit: 500000 } });
    const result = cg.checkBudget('chat', 1000);
    if (!result.allowed) throw new Error('Should allow call within budget');
  });

  test('tracks cumulative session tokens', () => {
    const cg = new CostGuard({ config: { sessionTokenLimit: 10000, dailyTokenLimit: 100000 } });
    cg.checkBudget('code', 3000);
    cg.checkBudget('code', 3000);
    const usage = cg.getUsage();
    if (usage.session.tokens !== 6000) throw new Error(`Expected 6000, got ${usage.session.tokens}`);
    if (usage.session.pct !== 60) throw new Error(`Expected 60%, got ${usage.session.pct}`);
  });

  test('blocks autonomous calls at session limit', () => {
    const cg = new CostGuard({ config: { sessionTokenLimit: 5000, dailyTokenLimit: 100000 } });
    cg.checkBudget('code', 5000); // exhaust session
    const result = cg.checkBudget('idle', 100, { priority: 1 });
    if (result.allowed) throw new Error('Should block autonomous call at session limit');
    if (!result.reason) throw new Error('Should include reason');
  });

  test('blocks autonomous calls at daily limit', () => {
    const cg = new CostGuard({ config: { sessionTokenLimit: 100000, dailyTokenLimit: 5000 } });
    cg.checkBudget('code', 5000); // exhaust daily
    const result = cg.checkBudget('idle', 100, { priority: 1 });
    if (result.allowed) throw new Error('Should block at daily limit');
  });

  test('never blocks user chat (priority >= 10)', () => {
    const cg = new CostGuard({ config: { sessionTokenLimit: 100, dailyTokenLimit: 100 } });
    cg.checkBudget('code', 200); // exhaust both budgets
    const result = cg.checkBudget('chat', 100, { priority: 10 });
    if (!result.allowed) throw new Error('User chat should never be blocked');
  });

  test('emits cost-warning at threshold', () => {
    const events = [];
    const bus = { emit: (name, data) => events.push({ name, data }), fire() {} };
    const cg = new CostGuard({ bus, config: { sessionTokenLimit: 10000, dailyTokenLimit: 100000, warnThreshold: 0.5 } });
    cg.checkBudget('code', 6000); // 60% > 50% threshold
    const warning = events.find(e => e.name === 'llm:cost-warning');
    if (!warning) throw new Error('Should emit cost-warning');
    if (warning.data.scope !== 'session') throw new Error('Warning should be session scope');
  });

  test('emits cost-cap-reached when blocked', () => {
    const events = [];
    const bus = { emit: (name, data) => events.push({ name, data }), fire() {} };
    const cg = new CostGuard({ bus, config: { sessionTokenLimit: 1000, dailyTokenLimit: 100000 } });
    cg.checkBudget('code', 1000);
    cg.checkBudget('idle', 100, { priority: 1 }); // triggers block
    const cap = events.find(e => e.name === 'llm:cost-cap-reached');
    if (!cap) throw new Error('Should emit cost-cap-reached');
  });

  test('warns only once per scope', () => {
    const events = [];
    const bus = { emit: (name, data) => events.push({ name, data }), fire() {} };
    const cg = new CostGuard({ bus, config: { sessionTokenLimit: 10000, dailyTokenLimit: 100000, warnThreshold: 0.5 } });
    cg.checkBudget('code', 6000);
    cg.checkBudget('code', 1000);
    const warnings = events.filter(e => e.name === 'llm:cost-warning' && e.data.scope === 'session');
    if (warnings.length !== 1) throw new Error(`Should warn once, got ${warnings.length}`);
  });

  test('resetSession clears session counters', () => {
    const cg = new CostGuard({ config: { sessionTokenLimit: 10000, dailyTokenLimit: 100000 } });
    cg.checkBudget('code', 5000);
    cg.resetSession();
    const usage = cg.getUsage();
    if (usage.session.tokens !== 0) throw new Error('Session should be reset');
    if (usage.daily.tokens !== 5000) throw new Error('Daily should persist across session reset');
  });

  test('getUsage returns correct structure', () => {
    const cg = new CostGuard({ config: { sessionTokenLimit: 100000, dailyTokenLimit: 500000 } });
    cg.checkBudget('chat', 2000);
    const u = cg.getUsage();
    if (typeof u.session.tokens !== 'number') throw new Error('Missing session.tokens');
    if (typeof u.daily.remaining !== 'number') throw new Error('Missing daily.remaining');
    if (typeof u.blocked !== 'number') throw new Error('Missing blocked');
    if (typeof u.enabled !== 'boolean') throw new Error('Missing enabled');
    if (typeof u.sessionUptime !== 'number') throw new Error('Missing sessionUptime');
  });

  test('disabled guard allows all calls', () => {
    const cg = new CostGuard({ config: { sessionTokenLimit: 0, dailyTokenLimit: 0, enabled: false } });
    const result = cg.checkBudget('idle', 999999, { priority: 1 });
    if (!result.allowed) throw new Error('Disabled guard should allow all');
  });

  test('tracks blocked call count', () => {
    const cg = new CostGuard({ config: { sessionTokenLimit: 100, dailyTokenLimit: 100000 } });
    cg.checkBudget('code', 50);  // 50% — allowed
    cg.checkBudget('code', 60);  // 110% — blocked (not user chat)
    cg.checkBudget('idle', 10, { priority: 1 }); // still over — blocked
    const usage = cg.getUsage();
    if (usage.blocked !== 2) throw new Error(`Expected 2 blocked, got ${usage.blocked}`);
  });
});

if (require.main === module) run();
